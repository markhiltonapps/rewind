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

use super::{DetectionEvent, DetectionSource, MeetingProcessFlag};

const POLL_INTERVAL: Duration = Duration::from_millis(1000);

/// Phase 2c round 1.2 — context-aware threshold profiles.
///
/// "Conservative" profile is used when NO known meeting process is
/// running (the process watcher's `MeetingProcessFlag` reports false).
/// We need this profile to be tight enough that random background
/// audio (Slack notification chime, browser tab music, system sound)
/// doesn't trip a false-positive recording. 15s of sustained -34 dBFS
/// is a high bar — only deliberate continuous audio (a meeting, a
/// long video) crosses it.
///
/// "Meeting profile" is used when a known meeting process IS running.
/// At that point a false positive is far less costly: we already have
/// one corroborating signal (the process), so the audio confirms an
/// in-progress meeting. The original 15s window was the proximate
/// cause of tonight's 17-minute Teams detection latency. 5s and a
/// slightly lower threshold cut that to ~5-10s.
const CONSERVATIVE_THRESHOLD: f32 = 0.02; // ~ -34 dBFS
const CONSERVATIVE_ACTIVE_S: usize = 15;
const MEETING_THRESHOLD: f32 = 0.015; // ~ -36 dBFS
const MEETING_ACTIVE_S: usize = 5;
/// Silence detection stays conservative regardless. We do NOT want
/// a quiet pause mid-meeting to drop the recording.
const INACTIVE_WINDOW_SAMPLES: usize = 30;

#[cfg(windows)]
pub async fn run_audio_session_watcher(
    tx: mpsc::Sender<DetectionEvent>,
    meeting_flag: MeetingProcessFlag,
) {
    info!(
        "Audio session watcher started. Profiles:\n  \
         conservative (no meeting process): threshold={}, active={}s\n  \
         meeting (meeting process running): threshold={}, active={}s\n  \
         inactive_window={}s (both profiles)",
        CONSERVATIVE_THRESHOLD,
        CONSERVATIVE_ACTIVE_S,
        MEETING_THRESHOLD,
        MEETING_ACTIVE_S,
        INACTIVE_WINDOW_SAMPLES
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
    // Track the active profile to log on transitions.
    let mut last_profile_meeting = false;

    while let Some(amplitude) = sample_rx.recv().await {
        // Pick the active profile from the meeting-process flag. The
        // flag is set by the process watcher every 2s, so the audio
        // detector's 1s ticks are at most 1s stale.
        let in_meeting = meeting_flag.get();
        let (threshold, active_s) = if in_meeting {
            (MEETING_THRESHOLD, MEETING_ACTIVE_S)
        } else {
            (CONSERVATIVE_THRESHOLD, CONSERVATIVE_ACTIVE_S)
        };
        if in_meeting != last_profile_meeting {
            info!(
                "Audio threshold profile changed: now {} (threshold={}, active_s={})",
                if in_meeting { "MEETING" } else { "CONSERVATIVE" },
                threshold,
                active_s
            );
            last_profile_meeting = in_meeting;
        }

        debug!(
            "audio peak: {:.4} (profile={}, threshold={})",
            amplitude,
            if in_meeting { "meeting" } else { "conservative" },
            threshold
        );

        if amplitude > threshold {
            active_count = active_count.saturating_add(1);
            inactive_count = 0;
            if !currently_active && active_count >= active_s {
                info!(
                    "Audio activity detected (sustained > {} for {}s, profile={})",
                    threshold,
                    active_s,
                    if in_meeting { "meeting" } else { "conservative" },
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
pub async fn run_audio_session_watcher(
    _tx: mpsc::Sender<DetectionEvent>,
    _meeting_flag: MeetingProcessFlag,
) {
    tracing::warn!("Audio session watcher: non-Windows platform, no-op");
}
