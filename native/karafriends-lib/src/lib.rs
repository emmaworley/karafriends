#![allow(non_snake_case)]

mod pitch_detector;

use std::cmp::Ordering;
use std::collections::HashMap;
use std::iter::{FromIterator, Iterator};
use std::sync::{Arc, LazyLock, Mutex};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use neon::prelude::Finalize;
use ringbuf::traits::{Consumer, Observer, Producer, Split};
use rubato::Resampler;

type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;

#[cfg(feature = "asio")]
static CPAL_ASIO_HOST: LazyLock<std::result::Result<cpal::Host, cpal::HostUnavailable>> =
    LazyLock::new(|| cpal::host_from_id(cpal::HostId::Asio));

static INPUT_DEVICES: LazyLock<Mutex<HashMap<String, cpal::Device>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

enum DeviceType {
    #[cfg(feature = "asio")]
    Asio,
    Usb,
}

const ECHO_DELAY_SECS: f32 = 0.06;
const ECHO_AMPLITUDE: f32 = 0.25;

struct Stream(cpal::Stream);

unsafe impl Send for Stream {}
unsafe impl Sync for Stream {}

pub struct InputDevice {
    input_stream: Arc<Mutex<Stream>>,
    output_stream: Arc<Mutex<Stream>>,
    pitch_rx: ringbuf::HeapCons<f32>,
    pitch_sample_count: usize,
    pitch_detector: pitch_detector::PitchDetector,
}

unsafe impl Send for InputDevice {}

impl Finalize for InputDevice {}

impl InputDevice {
    pub fn collect_devices<Collector: FromIterator<(String, cpal::StreamConfig)>>(
    ) -> Result<Collector> {
        _input_devices()?
            .map(|(input_device, device_type)| {
                let mut supported_input_configs: Vec<_> =
                    input_device.supported_input_configs().unwrap().collect();
                supported_input_configs.sort_by(|a, b| compare_configs(a, b, None));
                let best_supported_input_config = supported_input_configs
                    .last()
                    .ok_or("No supported input configs")?;
                let input_config = supported_config_to_config(best_supported_input_config);
                Ok((_device_name(&input_device, &device_type), input_config))
            })
            .collect::<Result<Collector>>()
    }

    pub fn new(name: &str, channel_selection: usize) -> Result<Self> {
        let mut input_devices = INPUT_DEVICES.lock().unwrap();
        let input_device = match input_devices.get(name) {
            Some(device) => device,
            None => {
                input_devices.insert(
                    name.to_string(),
                    _input_devices()?
                        .find(|(input_device, device_type)| {
                            _device_name(input_device, device_type) == name
                        })
                        .ok_or(format!("Could not find device: {}", name))?
                        .0,
                );
                &input_devices[name]
            }
        };
        let mut supported_input_configs: Vec<_> = input_device.supported_input_configs()?.collect();
        supported_input_configs.sort_by(|a, b| compare_configs(a, b, None));
        let best_supported_input_config = supported_input_configs
            .last()
            .ok_or("No supported input configs")?;
        let input_config = supported_config_to_config(best_supported_input_config);
        let _input_channels = input_config.channels as usize;
        let input_sample_rate = input_config.sample_rate.0;

        println!(
            "Created input device {} with config {:#?}, sample format {:#?}",
            input_device.name()?,
            input_config,
            best_supported_input_config.sample_format(),
        );

        let output_host = cpal::default_host();
        let output_device = output_host
            .default_output_device()
            .ok_or("No default output device")?;
        let mut supported_output_configs: Vec<_> =
            output_device.supported_output_configs()?.collect();
        supported_output_configs
            .sort_by(|a, b| compare_configs(a, b, Some(input_config.sample_rate)));
        let best_supported_output_config = supported_output_configs
            .last()
            .ok_or("No supported output configs")?;
        let mut output_config = supported_config_to_config(best_supported_output_config);
        if input_config.sample_rate >= best_supported_output_config.min_sample_rate()
            && input_config.sample_rate <= best_supported_output_config.max_sample_rate()
        {
            output_config.sample_rate = input_config.sample_rate;
        }
        let output_channels = output_config.channels as usize;
        let output_sample_rate = output_config.sample_rate.0;

        println!(
            "Created output device {} with config {:#?}, sample format {:#?}",
            output_device.name().unwrap(),
            output_config,
            best_supported_output_config.sample_format(),
        );

        let pitch_sample_count = input_sample_rate.div_ceil(40) as usize;
        let (pitch_tx, pitch_rx) = ringbuf::HeapRb::new(pitch_sample_count).split();

        // TODO: rationalize how to pick this size
        // it really needs to be large enough for the input bufer provided by the OS, which can be quite large on windows (upper bound??)
        let (output_tx, output_rx) = ringbuf::HeapRb::new(
            (2048.0 * output_channels as f32 * output_sample_rate as f32 / input_sample_rate as f32)
                as usize,
        )
        .split();

        let pitch_detector =
            pitch_detector::PitchDetector::new(input_sample_rate as f32, pitch_sample_count);

        let error_callback = |e| panic!("{}", e);

        let input_stream = match best_supported_input_config.sample_format() {
            cpal::SampleFormat::U8 => {
                let mut input_callback = Self::input_data_callback::<u8>(
                    &input_config,
                    &output_config,
                    channel_selection,
                    pitch_tx,
                    output_tx,
                )?;
                input_device.build_input_stream(
                    &input_config,
                    move |samples: _, _| input_callback(samples),
                    error_callback,
                    None,
                )
            }
            cpal::SampleFormat::U16 => {
                let mut input_callback = Self::input_data_callback::<u16>(
                    &input_config,
                    &output_config,
                    channel_selection,
                    pitch_tx,
                    output_tx,
                )?;
                input_device.build_input_stream(
                    &input_config,
                    move |samples: _, _| input_callback(samples),
                    error_callback,
                    None,
                )
            }
            cpal::SampleFormat::U32 => {
                let mut input_callback = Self::input_data_callback::<u32>(
                    &input_config,
                    &output_config,
                    channel_selection,
                    pitch_tx,
                    output_tx,
                )?;
                input_device.build_input_stream(
                    &input_config,
                    move |samples: _, _| input_callback(samples),
                    error_callback,
                    None,
                )
            }
            cpal::SampleFormat::U64 => {
                let mut input_callback = Self::input_data_callback::<u64>(
                    &input_config,
                    &output_config,
                    channel_selection,
                    pitch_tx,
                    output_tx,
                )?;
                input_device.build_input_stream(
                    &input_config,
                    move |samples: _, _| input_callback(samples),
                    error_callback,
                    None,
                )
            }
            cpal::SampleFormat::I8 => {
                let mut input_callback = Self::input_data_callback::<i8>(
                    &input_config,
                    &output_config,
                    channel_selection,
                    pitch_tx,
                    output_tx,
                )?;
                input_device.build_input_stream(
                    &input_config,
                    move |samples: _, _| input_callback(samples),
                    error_callback,
                    None,
                )
            }
            cpal::SampleFormat::I16 => {
                let mut input_callback = Self::input_data_callback::<i16>(
                    &input_config,
                    &output_config,
                    channel_selection,
                    pitch_tx,
                    output_tx,
                )?;
                input_device.build_input_stream(
                    &input_config,
                    move |samples: _, _| input_callback(samples),
                    error_callback,
                    None,
                )
            }
            cpal::SampleFormat::I32 => {
                let mut input_callback = Self::input_data_callback::<i32>(
                    &input_config,
                    &output_config,
                    channel_selection,
                    pitch_tx,
                    output_tx,
                )?;
                input_device.build_input_stream(
                    &input_config,
                    move |samples: _, _| input_callback(samples),
                    error_callback,
                    None,
                )
            }
            cpal::SampleFormat::I64 => {
                let mut input_callback = Self::input_data_callback::<i64>(
                    &input_config,
                    &output_config,
                    channel_selection,
                    pitch_tx,
                    output_tx,
                )?;
                input_device.build_input_stream(
                    &input_config,
                    move |samples: _, _| input_callback(samples),
                    error_callback,
                    None,
                )
            }
            cpal::SampleFormat::F32 => {
                let mut input_callback = Self::input_data_callback::<f32>(
                    &input_config,
                    &output_config,
                    channel_selection,
                    pitch_tx,
                    output_tx,
                )?;
                input_device.build_input_stream(
                    &input_config,
                    move |samples: _, _| input_callback(samples),
                    error_callback,
                    None,
                )
            }
            cpal::SampleFormat::F64 => {
                let mut input_callback = Self::input_data_callback::<f64>(
                    &input_config,
                    &output_config,
                    channel_selection,
                    pitch_tx,
                    output_tx,
                )?;
                input_device.build_input_stream(
                    &input_config,
                    move |samples: _, _| input_callback(samples),
                    error_callback,
                    None,
                )
            }
            _ => Err(cpal::BuildStreamError::StreamConfigNotSupported),
        }?;

        let output_stream = match best_supported_output_config.sample_format() {
            cpal::SampleFormat::U8 => {
                let mut output_callback = Self::output_data_callback::<u8>(output_rx)?;
                output_device.build_output_stream(
                    &output_config,
                    move |samples: _, _| output_callback(samples),
                    error_callback,
                    None,
                )
            }
            cpal::SampleFormat::U16 => {
                let mut output_callback = Self::output_data_callback::<u16>(output_rx)?;
                output_device.build_output_stream(
                    &output_config,
                    move |samples: _, _| output_callback(samples),
                    error_callback,
                    None,
                )
            }
            cpal::SampleFormat::U32 => {
                let mut output_callback = Self::output_data_callback::<u32>(output_rx)?;
                output_device.build_output_stream(
                    &output_config,
                    move |samples: _, _| output_callback(samples),
                    error_callback,
                    None,
                )
            }
            cpal::SampleFormat::U64 => {
                let mut output_callback = Self::output_data_callback::<u64>(output_rx)?;
                output_device.build_output_stream(
                    &output_config,
                    move |samples: _, _| output_callback(samples),
                    error_callback,
                    None,
                )
            }
            cpal::SampleFormat::I8 => {
                let mut output_callback = Self::output_data_callback::<i8>(output_rx)?;
                output_device.build_output_stream(
                    &output_config,
                    move |samples: _, _| output_callback(samples),
                    error_callback,
                    None,
                )
            }
            cpal::SampleFormat::I16 => {
                let mut output_callback = Self::output_data_callback::<i16>(output_rx)?;
                output_device.build_output_stream(
                    &output_config,
                    move |samples: _, _| output_callback(samples),
                    error_callback,
                    None,
                )
            }
            cpal::SampleFormat::I32 => {
                let mut output_callback = Self::output_data_callback::<i32>(output_rx)?;
                output_device.build_output_stream(
                    &output_config,
                    move |samples: _, _| output_callback(samples),
                    error_callback,
                    None,
                )
            }
            cpal::SampleFormat::I64 => {
                let mut output_callback = Self::output_data_callback::<i64>(output_rx)?;
                output_device.build_output_stream(
                    &output_config,
                    move |samples: _, _| output_callback(samples),
                    error_callback,
                    None,
                )
            }
            cpal::SampleFormat::F32 => {
                let mut output_callback = Self::output_data_callback::<f32>(output_rx)?;
                output_device.build_output_stream(
                    &output_config,
                    move |samples: _, _| output_callback(samples),
                    error_callback,
                    None,
                )
            }
            cpal::SampleFormat::F64 => {
                let mut output_callback = Self::output_data_callback::<f64>(output_rx)?;
                output_device.build_output_stream(
                    &output_config,
                    move |samples: _, _| output_callback(samples),
                    error_callback,
                    None,
                )
            }
            _ => Err(cpal::BuildStreamError::StreamConfigNotSupported),
        }?;

        input_stream.play()?;
        output_stream.play()?;

        Ok(InputDevice {
            input_stream: Arc::new(Mutex::new(Stream(input_stream))),
            output_stream: Arc::new(Mutex::new(Stream(output_stream))),
            pitch_rx,
            pitch_sample_count,
            pitch_detector,
        })
    }

    pub fn get_pitch(&mut self) -> Result<(f32, f32)> {
        let mut samples = vec![0.0; self.pitch_sample_count];
        self.pitch_rx.pop_slice(&mut samples);
        Ok(self.pitch_detector.detect(samples))
    }

    pub fn stop(&self) -> Result<()> {
        self.input_stream.lock().unwrap().0.pause()?;
        self.output_stream.lock().unwrap().0.pause()?;
        Ok(())
    }

    fn input_data_callback<Sample: cpal::Sample + Copy>(
        input_config: &cpal::StreamConfig,
        output_config: &cpal::StreamConfig,
        channel_selection: usize,
        mut pitch_tx: ringbuf::HeapProd<f32>,
        mut output_tx: ringbuf::HeapProd<f32>,
    ) -> Result<impl FnMut(&[Sample]) + Send + 'static>
    where
        f32: cpal::FromSample<Sample>,
    {
        let input_channels = input_config.channels as usize;
        let output_channels = output_config.channels as usize;
        let input_sample_rate = input_config.sample_rate.0;
        let output_sample_rate = output_config.sample_rate.0;

        let latency_sample_count = (input_sample_rate as f32 * ECHO_DELAY_SECS) as usize;
        let (mut echo_tx, mut echo_rx) =
            ringbuf::HeapRb::new(latency_sample_count * 2 * output_channels).split();

        for _ in 0..latency_sample_count * output_channels {
            echo_tx
                .try_push(0.0_f32)
                .map_err(|_| "Failed to push to echo buffer")?;
        }

        let resampler_chunk_size = match input_config.buffer_size {
            cpal::BufferSize::Fixed(count) => count as usize,
            cpal::BufferSize::Default => (input_sample_rate / output_sample_rate) as usize,
        };
        let mut resampler = rubato::SincFixedIn::<f32>::new(
            output_sample_rate as f64 / input_sample_rate as f64,
            1.0,
            rubato::SincInterpolationParameters {
                sinc_len: 256,
                f_cutoff: 0.95,
                interpolation: rubato::SincInterpolationType::Linear,
                oversampling_factor: 256,
                window: rubato::WindowFunction::BlackmanHarris2,
            },
            resampler_chunk_size,
            1,
        )?;
        // TODO: file a PR against rubato so that it doesn't error for unfilled buffers
        let mut resampler_output = resampler.output_buffer_allocate(true);

        Ok(move |samples: &[Sample]| {
            let mono_samples: Vec<_> = samples
                .chunks(input_channels)
                .map(|channel_samples| {
                    <f32 as cpal::Sample>::from_sample(channel_samples[channel_selection])
                })
                .collect();

            pitch_tx.push_slice(&mono_samples);

            let mut echo_samples = vec![0.0; mono_samples.len()];
            echo_rx.pop_slice(echo_samples.as_mut_slice());

            let mut output_samples: Vec<_> = mono_samples
                .iter()
                .zip(echo_samples.iter().map(|sample| sample * ECHO_AMPLITUDE))
                .map(|(incoming, echo)| incoming + echo)
                .collect();

            echo_tx.push_slice(output_samples.as_slice());

            if input_sample_rate != output_sample_rate {
                output_samples
                    .chunks(resampler_chunk_size)
                    .for_each(|chunk| {
                        match resampler.process_into_buffer(&[&chunk], &mut resampler_output, None)
                        {
                            Err(e) => eprintln!("resampling error: {}", e),
                            Ok((_input_samples_consumed, output_samples_produced)) => {
                                let samples_written = output_tx.push_iter(
                                    &mut resampler_output[0]
                                        .iter_mut()
                                        .take(output_samples_produced)
                                        .flat_map(|sample| {
                                            std::iter::repeat_n(*sample, output_channels)
                                        }),
                                );
                                if samples_written < output_samples_produced {
                                    eprintln!("output fell behind (with sample rate conversion)!");
                                }
                            }
                        }
                    });
            } else {
                let samples_written = output_tx.push_iter(
                    &mut output_samples
                        .iter_mut()
                        .flat_map(|sample| std::iter::repeat_n(*sample, output_channels)),
                );
                if samples_written < resampler_output[0].len() {
                    eprintln!("output fell behind (without sample rate conversion)!");
                }
            }
        })
    }

    fn output_data_callback<Sample: cpal::Sample + cpal::FromSample<f32> + Send>(
        mut output_rx: ringbuf::HeapCons<f32>,
    ) -> Result<impl FnMut(&mut [Sample]) + Send + 'static> {
        Ok(move |samples: &mut [Sample]| {
            if output_rx.occupied_len() < samples.len() {
                eprintln!("input fell behind");
            }
            samples
                .iter_mut()
                .zip(output_rx.pop_iter())
                .for_each(|(sample, float_sample)| *sample = Sample::from_sample(float_sample));
        })
    }
}

fn compare_configs(
    a: &cpal::SupportedStreamConfigRange,
    b: &cpal::SupportedStreamConfigRange,
    desired_sample_rate: Option<cpal::SampleRate>,
) -> Ordering {
    // Our priorities in order are buffer size (lower is better), sample rate
    // (higher is better), and channel count (higher is better).
    // If we have a desired sample rate, just being in range is good enough.
    if a.buffer_size() == &cpal::SupportedBufferSize::Unknown
        && b.buffer_size() != &cpal::SupportedBufferSize::Unknown
    {
        return Ordering::Less;
    }
    if a.buffer_size() != &cpal::SupportedBufferSize::Unknown
        && b.buffer_size() == &cpal::SupportedBufferSize::Unknown
    {
        return Ordering::Greater;
    }
    if let cpal::SupportedBufferSize::Range { min, max: _ } = a.buffer_size() {
        let a_min = min;
        if let cpal::SupportedBufferSize::Range { min, max: _ } = b.buffer_size() {
            let b_min = min;
            let buffer_size_cmp = a_min.cmp(b_min);
            if buffer_size_cmp != Ordering::Equal {
                return buffer_size_cmp.reverse();
            }
        }
    }
    if let Some(sample_rate) = desired_sample_rate {
        let a_in_range = sample_rate >= a.min_sample_rate() && sample_rate <= a.max_sample_rate();
        let b_in_range = sample_rate >= b.min_sample_rate() && sample_rate <= b.max_sample_rate();
        if !a_in_range && b_in_range {
            return Ordering::Less;
        }
        if a_in_range && !b_in_range {
            return Ordering::Greater;
        }
    }

    let sample_rate_cmp = a.max_sample_rate().cmp(&b.max_sample_rate());
    if sample_rate_cmp != Ordering::Equal {
        return sample_rate_cmp;
    }

    let channels_cmp = a.channels().cmp(&b.channels());
    if channels_cmp != Ordering::Equal {
        return channels_cmp;
    }

    a.cmp_default_heuristics(b)
}

fn supported_config_to_config(
    config_range: &cpal::SupportedStreamConfigRange,
) -> cpal::StreamConfig {
    cpal::StreamConfig {
        channels: config_range.channels(),
        sample_rate: config_range.max_sample_rate(),
        buffer_size: match config_range.buffer_size() {
            // WASAPI lies about buffer size ranges and doesn't repect fixed size requests
            #[cfg(not(windows))]
            cpal::SupportedBufferSize::Range { min, max: _ } => cpal::BufferSize::Fixed(*min),
            _ => cpal::BufferSize::Default,
        },
    }
}

fn _input_devices() -> Result<impl Iterator<Item = (cpal::Device, DeviceType)>> {
    let default_devices = cpal::default_host()
        .input_devices()?
        .map(|device| (device, DeviceType::Usb));
    #[cfg(feature = "asio")]
    {
        Ok(default_devices.chain(
            CPAL_ASIO_HOST
                .as_ref()
                .map_err(|_| "ASIO cpal host unavailable!")?
                .input_devices()?
                .map(|device| (device, DeviceType::Asio)),
        ))
    }
    #[cfg(not(feature = "asio"))]
    Ok(default_devices)
}

fn _device_name(device: &cpal::Device, device_type: &DeviceType) -> String {
    format!(
        "{} ({})",
        device.name().unwrap(),
        match device_type {
            #[cfg(feature = "asio")]
            DeviceType::Asio => "ASIO",
            DeviceType::Usb => "USB",
        }
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use pitch_detector::{freq2midi, PitchDetector};
    use wavegen::{sine, wf};

    #[test]
    fn test_input_callback_outputs() -> Result<()> {
        let input_sample_rate = 44100;

        let (pitch_tx, mut pitch_rx) =
            ringbuf::HeapRb::new((input_sample_rate as usize).div_ceil(40)).split();
        let (output_tx, mut output_rx) = ringbuf::HeapRb::new(2048).split();

        let mut input_callback = InputDevice::input_data_callback::<f32>(
            &cpal::StreamConfig {
                channels: 1,
                sample_rate: cpal::SampleRate(input_sample_rate),
                buffer_size: cpal::BufferSize::Fixed(256),
            },
            &cpal::StreamConfig {
                channels: 1,
                sample_rate: cpal::SampleRate(input_sample_rate),
                buffer_size: cpal::BufferSize::Fixed(256),
            },
            0,
            pitch_tx,
            output_tx,
        )?;

        let latency_sample_count = (input_sample_rate as f32 * ECHO_DELAY_SECS) as usize;

        let input_samples = wf!(f32, input_sample_rate as f32, sine!(185.0))
            .iter()
            .take(latency_sample_count)
            .collect::<Vec<_>>();
        input_callback(&input_samples);

        let output_samples = output_rx.pop_iter().collect::<Vec<_>>();
        let pitch_samples: Vec<f32> = pitch_rx.pop_iter().collect::<Vec<_>>();
        assert_eq!(input_samples[..output_samples.len()], output_samples);
        assert_eq!(input_samples[..pitch_samples.len()], pitch_samples);

        let silence = vec![0.0; latency_sample_count];
        input_callback(&silence);

        // We should now have some echo in the output, but pitch should get a clean signal
        let output_samples = output_rx.pop_iter().collect::<Vec<_>>();
        let pitch_samples: Vec<f32> = pitch_rx.pop_iter().collect::<Vec<_>>();
        assert_eq!(
            input_samples[..output_samples.len()]
                .iter()
                .map(|f| f * ECHO_AMPLITUDE)
                .collect::<Vec<_>>(),
            output_samples
        );
        assert_eq!(silence[..pitch_samples.len()], pitch_samples);

        Ok(())
    }

    #[test]
    fn test_input_callback_upsampling() -> Result<()> {
        let input_sample_rate = 44100;
        let output_sample_rate = 96000;

        let (pitch_tx, mut pitch_rx) =
            ringbuf::HeapRb::new((input_sample_rate as usize).div_ceil(40)).split();
        let (output_tx, mut output_rx) = ringbuf::HeapRb::new(
            (2048.0 * output_sample_rate as f32 / input_sample_rate as f32) as usize,
        )
        .split();

        let mut input_callback = InputDevice::input_data_callback::<f32>(
            &cpal::StreamConfig {
                channels: 1,
                sample_rate: cpal::SampleRate(input_sample_rate),
                buffer_size: cpal::BufferSize::Fixed(256),
            },
            &cpal::StreamConfig {
                channels: 1,
                sample_rate: cpal::SampleRate(output_sample_rate),
                buffer_size: cpal::BufferSize::Fixed(256),
            },
            0,
            pitch_tx,
            output_tx,
        )?;

        let input_samples = wf!(f32, input_sample_rate as f32, sine!(185.0))
            .iter()
            .take(2048)
            .collect::<Vec<_>>();
        input_callback(&input_samples);

        // Resampling doesn't preserve phase very well, so use the pitch detector to validate output
        let pitch_sample_count = output_sample_rate.div_ceil(40) as usize;
        let pd = PitchDetector::new(output_sample_rate as f32, pitch_sample_count);

        let mut output_samples = vec![0.0; pitch_sample_count];
        output_rx.pop_slice(&mut output_samples);
        let pitch_samples: Vec<f32> = pitch_rx.pop_iter().collect::<Vec<_>>();
        let (midi_number, confidence) = pd.detect(output_samples[..pitch_sample_count].to_vec());
        assert!((midi_number - freq2midi(185.0)).abs() < 0.001);
        assert!(confidence > 0.999);
        // Pitch signal does not get resampled
        assert_eq!(input_samples[..pitch_samples.len()], pitch_samples);

        Ok(())
    }

    #[test]
    fn test_input_callback_downsampling() -> Result<()> {
        let input_sample_rate = 96000;
        let output_sample_rate = 44100;

        let (pitch_tx, mut pitch_rx) =
            ringbuf::HeapRb::new((input_sample_rate as usize).div_ceil(40)).split();
        let (output_tx, mut output_rx) = ringbuf::HeapRb::new(
            (2048.0 * output_sample_rate as f32 / input_sample_rate as f32) as usize,
        )
        .split();

        let mut input_callback = InputDevice::input_data_callback::<f32>(
            &cpal::StreamConfig {
                channels: 1,
                sample_rate: cpal::SampleRate(input_sample_rate),
                buffer_size: cpal::BufferSize::Fixed(256),
            },
            &cpal::StreamConfig {
                channels: 1,
                sample_rate: cpal::SampleRate(output_sample_rate),
                buffer_size: cpal::BufferSize::Fixed(256),
            },
            0,
            pitch_tx,
            output_tx,
        )?;

        let input_samples = wf!(f32, input_sample_rate as f32, sine!(185.0))
            .iter()
            .take(2048)
            .collect::<Vec<_>>();
        input_callback(&input_samples);

        // Resampling doesn't preserve phase very well, so use the pitch detector to validate output
        let pitch_sample_count = output_sample_rate.div_ceil(40) as usize;
        let pd = PitchDetector::new(output_sample_rate as f32, pitch_sample_count);

        let mut output_samples = vec![0.0; pitch_sample_count];
        output_rx.pop_slice(&mut output_samples);
        let pitch_samples: Vec<f32> = pitch_rx.pop_iter().collect::<Vec<_>>();
        let (midi_number, confidence) = pd.detect(output_samples[..pitch_sample_count].to_vec());
        assert!((midi_number - freq2midi(185.0)).abs() < 0.001);
        assert!(confidence > 0.999);
        // Pitch signal does not get resampled
        assert_eq!(input_samples[..pitch_samples.len()], pitch_samples);

        Ok(())
    }
}
