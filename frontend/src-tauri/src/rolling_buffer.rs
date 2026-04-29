//! 5-minute in-memory rolling PCM audio buffer.
//! When auto-record is ON, this buffer continuously captures audio from
//! both mic and system loopback streams. On RECORDING entry, the buffer's
//! contents are flushed to the existing recording pipeline so we capture
//! the start of a meeting even if detection lagged.

use std::collections::VecDeque;
use std::sync::Mutex;
use tracing::debug;

/// Sample rate matches existing cpal capture (48 kHz).
const SAMPLE_RATE: usize = 48_000;
/// Stereo
const CHANNELS: usize = 2;
/// 5 minutes
const BUFFER_SECONDS: usize = 300;
/// Max samples in buffer
const MAX_SAMPLES: usize = SAMPLE_RATE * CHANNELS * BUFFER_SECONDS;

pub struct RollingBuffer {
    mic: Mutex<VecDeque<i16>>,
    system: Mutex<VecDeque<i16>>,
}

impl RollingBuffer {
    pub fn new() -> Self {
        Self {
            mic: Mutex::new(VecDeque::with_capacity(MAX_SAMPLES)),
            system: Mutex::new(VecDeque::with_capacity(MAX_SAMPLES)),
        }
    }

    pub fn push_mic(&self, samples: &[i16]) {
        let mut buf = self.mic.lock().unwrap();
        for &s in samples { buf.push_back(s); }
        while buf.len() > MAX_SAMPLES { buf.pop_front(); }
    }

    pub fn push_system(&self, samples: &[i16]) {
        let mut buf = self.system.lock().unwrap();
        for &s in samples { buf.push_back(s); }
        while buf.len() > MAX_SAMPLES { buf.pop_front(); }
    }

    /// Drain buffer contents (mic, system) and return them as Vec<i16>.
    /// Buffer is cleared after drain.
    pub fn drain(&self) -> (Vec<i16>, Vec<i16>) {
        let mut mic = self.mic.lock().unwrap();
        let mut system = self.system.lock().unwrap();
        let mic_out: Vec<i16> = mic.drain(..).collect();
        let system_out: Vec<i16> = system.drain(..).collect();
        debug!("RollingBuffer drained: {} mic samples, {} system samples", mic_out.len(), system_out.len());
        (mic_out, system_out)
    }

    pub fn clear(&self) {
        self.mic.lock().unwrap().clear();
        self.system.lock().unwrap().clear();
    }
}
