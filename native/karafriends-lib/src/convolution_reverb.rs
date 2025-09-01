use std::{
    convert::TryInto,
    sync::{Arc, LazyLock, Mutex},
};

use realfft::num_complex::Complex;
use ringbuf::traits::{Consumer, Producer, RingBuffer};
use rubato::Resampler;

use crate::Result;

pub static IR: LazyLock<Mutex<Vec<f32>>> = LazyLock::new(|| {
    Mutex::new(
        include_bytes!("WestLiveRoom_44100.f32le")
            .chunks(4)
            .map(|chunk| Ok(f32::from_le_bytes(chunk.try_into()?)))
            .collect::<Result<Vec<_>>>()
            .unwrap(),
    )
});

pub struct ConvolutionReverb {
    ir: Vec<Complex<f32>>,
    fft: Arc<dyn realfft::RealToComplex<f32>>,
    ifft: Arc<dyn realfft::ComplexToReal<f32>>,
    input: Vec<f32>,
    output: Vec<Complex<f32>>,
    scratch: Vec<Complex<f32>>,
    rb: ringbuf::HeapRb<f32>,
}

impl ConvolutionReverb {
    pub fn new(
        ir_data: &[f32],
        ir_sample_rate: u32,
        input_sample_rate: u32,
        input_chunk_size: usize,
    ) -> Result<Self> {
        let mut ir = if ir_sample_rate != input_sample_rate {
            let mut resampler = rubato::SincFixedIn::<f32>::new(
                input_sample_rate as f64 / ir_sample_rate as f64,
                1.0,
                rubato::SincInterpolationParameters {
                    sinc_len: 256,
                    f_cutoff: 0.95,
                    interpolation: rubato::SincInterpolationType::Linear,
                    oversampling_factor: 256,
                    window: rubato::WindowFunction::BlackmanHarris2,
                },
                ir_data.len(),
                1,
            )?;
            let mut resampler_output = resampler.output_buffer_allocate(true);
            resampler.process_into_buffer(&[&ir_data], &mut resampler_output, None)?;
            resampler_output
                .into_iter()
                .next()
                .ok_or("ConvolutionReverb IR resampler output didn't contain any channels")?
        } else {
            Vec::from(ir_data)
        };

        let fft_len = input_chunk_size + ir.len() - 1;

        let fft = realfft::RealFftPlanner::<f32>::new().plan_fft_forward(fft_len);
        let ifft = realfft::RealFftPlanner::<f32>::new().plan_fft_inverse(fft_len);
        let input = fft.make_input_vec();
        let mut output = fft.make_output_vec();
        let mut scratch = fft.make_scratch_vec();

        debug_assert_eq!(input.len(), fft_len);

        // we want to store the IR in the frequency domain, so we pad and FFT
        ir.extend(vec![0.0; fft_len - ir.len()]);
        fft.process_with_scratch(&mut ir, &mut output, &mut scratch)?;
        let ir = output.clone();

        debug_assert_eq!(output.len(), ir.len());

        let mut rb = ringbuf::HeapRb::new(fft_len);
        rb.push_iter(std::iter::repeat_n(0.0, fft_len));

        Ok(ConvolutionReverb {
            ir,
            input,
            output,
            fft,
            ifft,
            scratch,
            rb,
        })
    }

    pub fn process(&mut self, samples: &[f32]) -> Result<Vec<f32>> {
        self.rb.push_slice_overwrite(samples);
        self.rb.peek_slice(&mut self.input);

        self.fft
            .process_with_scratch(&mut self.input, &mut self.output, &mut self.scratch)?;

        let norm: f32 = 1.0 / self.input.len() as f32;
        self.output
            .iter_mut()
            .zip(self.ir.iter())
            .for_each(|(output, ir)| *output *= *ir * norm);

        self.ifft
            .process_with_scratch(&mut self.output, &mut self.input, &mut self.scratch)?;

        Ok(self.input[self.input.len() - samples.len()..]
            .into_iter()
            .cloned()
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_unit_impulse_reproduces_ir() -> Result<()> {
        let ir = &*IR.lock().unwrap();
        let mut unit = vec![0.0; ir.len()];
        unit[0] = 1.0;

        // use big chunks to avoid overhead, fine as long as chunk size << ir size
        let chunk_size = 22050;

        let mut cr = ConvolutionReverb::new(ir, 44100, 44100, chunk_size)?;

        ir.chunks(chunk_size)
            .zip(unit.chunks(chunk_size))
            .for_each(|(ir_chunk, unit_chunk)| {
                let out = cr.process(unit_chunk).unwrap();
                out.iter()
                    .zip(ir_chunk.iter())
                    .for_each(|(out, ir)| assert!((out - ir).abs() < 0.000001));
            });

        Ok(())
    }
}
