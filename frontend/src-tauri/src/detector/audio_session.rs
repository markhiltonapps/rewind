//! Audio session activity detector.
//!
//! Reads the **default render endpoint's peak meter** every 1 second via the
//! Windows Core Audio `IAudioMeterInformation` interface. When sustained
//! amplitude above a threshold is observed for `ACTIVE_WINDOW_SAMPLES`
//! consecutive samples (15s), emits `SignalDetected(AudioActivity)`. When
//! sustained silence below threshold is observed for `INACTIVE_WINDOW_SAMPLES`
//! consecutive samples (30s), emits `SignalLost(AudioActivity)`.
//!
//! ## Threading
//!
//! Core Audio COM objects are apartment-bound: `CoInitializeEx` must be
//! called per-thread, and a COM-bound interface created on thread A cannot
//! be used from thread B. Tokio tasks may migrate between worker threads,
//! which would crash this code. To sidestep that, we spawn a dedicated
//! `std::thread` that owns the COM init + meter for its entire lifetime
//! and posts amplitude readings to the tokio side via a `std::sync::mpsc`.
//! The async task only does the threshold logic.
//!
//! This is also why `init_meter` runs INSIDE `meter_thread_main` — not at
//! the top of `run_audio_session_watcher` — and why the meter is never
//! returned across the thread boundary.
//!
//! ## Privacy / safety
//!
//! `IAudioMeterInformation::GetPeakValue` reads the *meter*. It does not
//! capture or persist any audio. No buffer is allocated, no file is written.

use std::time::Duration;
use tokio::sync::mpsc;
use tracing::{debug, info, warn};

use super::{DetectionEvent, DetectionSource};

const POLL_INTERVAL: Duration = Duration::from_millis(1000);
const AMPLITUDE_THRESHOLD: f32 = 0.02; // ~ -34 dBFS
const ACTIVE_WINDOW_SAMPLES: usize = 15; // 15s of sustained sound
const INACTIVE_WINDOW_SAMPLES: usize = 30; // 30s of sustained silence

#[cfg(windows)]
pub async fn run_audio_session_watcher(tx: mpsc::Sender<DetectionEvent>) {
    info!(
        "Audio session watcher started: threshold={}, active_window={}s, inactive_window={}s",
        AMPLITUDE_THRESHOLD, ACTIVE_WINDOW_SAMPLES, INACTIVE_WINDOW_SAMPLES
    );

    // Bridge: dedicated COM thread → tokio task
    let (sample_tx, mut sample_rx) = mpsc::channel::<f32>(64);

    std::thread::Builder::new()
        .name("neato-audio-meter".into())
        .spawn(move || meter_thread_main(sample_tx))
        .expect("failed to spawn audio meter thread");

    let mut active_count: usize = 0;
    let mut inactive_count: usize = 0;
    let mut currently_active = false;

    while let Some(amplitude) = sample_rx.recv().await {
        debug!("audio peak: {:.4}", amplitude);

        if amplitude > AMPLITUDE_THRESHOLD {
            active_count = active_count.saturating_add(1);
            inactive_count = 0;
            if !currently_active && active_count >= ACTIVE_WINDOW_SAMPLES {
                info!(
                    "Audio activity detected (sustained > {} for {}s)",
                    AMPLITUDE_THRESHOLD, ACTIVE_WINDOW_SAMPLES
                );
                currently_active = true;
                let _ = tx
                    .send(DetectionEvent::SignalDetected(
                        DetectionSource::AudioActivity,
                    ))
                    .await;
            }
        } else {
            inactive_count = inactive_count.saturating_add(1);
            active_count = 0;
            if currently_active && inactive_count >= INACTIVE_WINDOW_SAMPLES {
                info!(
                    "Audio activity lost (sustained silence for {}s)",
                    INACTIVE_WINDOW_SAMPLES
                );
                currently_active = false;
                let _ = tx
                    .send(DetectionEvent::SignalLost(DetectionSource::AudioActivity))
                    .await;
            }
        }
    }

    warn!("Audio session watcher: meter thread closed sample channel");
}

#[cfg(windows)]
fn meter_thread_main(sample_tx: mpsc::Sender<f32>) {
    use windows::Win32::Media::Audio::{
        eConsole, eRender, IMMDeviceEnumerator, MMDeviceEnumerator,
    };
    use windows::Win32::Media::Audio::Endpoints::IAudioMeterInformation;
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL,
        COINIT_MULTITHREADED,
    };

    unsafe {
        // CoInitializeEx returns S_FALSE if a different concurrency model is
        // already in effect on this thread; that's acceptable on a fresh
        // thread we just spawned. HRESULT is wrapped in windows::core::HRESULT
        // and `.ok()` converts non-success to Err.
        let hr = CoInitializeEx(None, COINIT_MULTITHREADED);
        if hr.is_err() {
            warn!("CoInitializeEx failed: {:?}", hr);
            return;
        }

        let enumerator: IMMDeviceEnumerator =
            match CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) {
                Ok(e) => e,
                Err(e) => {
                    warn!("Failed to create IMMDeviceEnumerator: {:?}", e);
                    CoUninitialize();
                    return;
                }
            };

        let device = match enumerator.GetDefaultAudioEndpoint(eRender, eConsole) {
            Ok(d) => d,
            Err(e) => {
                warn!("Failed to get default audio endpoint: {:?}", e);
                CoUninitialize();
                return;
            }
        };

        let meter: IAudioMeterInformation = match device.Activate(CLSCTX_ALL, None) {
            Ok(m) => m,
            Err(e) => {
                warn!("Failed to activate IAudioMeterInformation: {:?}", e);
                CoUninitialize();
                return;
            }
        };
        loop {
            let amplitude = meter.GetPeakValue().unwrap_or(0.0);
            // Best-effort send. If the receiver is gone, exit cleanly.
            if sample_tx.blocking_send(amplitude).is_err() {
                break;
            }
            std::thread::sleep(POLL_INTERVAL);
        }

        CoUninitialize();
    }
}

#[cfg(not(windows))]
pub async fn run_audio_session_watcher(_tx: mpsc::Sender<DetectionEvent>) {
    tracing::warn!("Audio session watcher: non-Windows platform, no-op");
}
