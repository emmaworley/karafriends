use crate::Result;
use ringbuf::traits::{Consumer, Producer};

pub struct ReverbModule {
    amplitude: f32,
    rb: ringbuf::HeapRb<f32>,
}

impl ReverbModule {
    pub fn new(sample_rate: u32, delay_secs: f32, amplitude: f32) -> Result<Self> {
        let latency_sample_count = (sample_rate as f32 * delay_secs) as usize;
        let mut rb = ringbuf::HeapRb::new(latency_sample_count * 2);
        for _ in 0..latency_sample_count {
            rb.try_push(0.0_f32)
                .map_err(|_| "Failed to pre-populate the reverb buffer")?;
        }
        Ok(ReverbModule { amplitude, rb })
    }

    pub fn process(&mut self, samples: &[f32]) -> Vec<f32> {
        let mut delayed_samples = vec![0.0; samples.len()];
        self.rb.pop_slice(delayed_samples.as_mut_slice());

        let samples_with_delayed: Vec<_> = samples
            .iter()
            .zip(delayed_samples.iter().map(|s| s * self.amplitude))
            .map(|(a, b)| a + b)
            .collect();

        self.rb.push_slice(samples_with_delayed.as_slice());

        samples_with_delayed
            .iter()
            .map(|s| s * -self.amplitude)
            .zip(delayed_samples.iter())
            .map(|(a, b)| a + b)
            .collect()
    }
}
