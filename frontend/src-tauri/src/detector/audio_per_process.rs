//! Per-process WASAPI mic+speaker session detector. Phase 2c round 1.3.
//!
//! ## Why
//!
//! Phase 2b's audio detector watches the default render endpoint's peak
//! amplitude. That signal answers "is something making sound right now"
//! — but not "is THIS app actually in a call". Quiet conference moments
//! and background music both confuse it. Tonight (2026-05-01) Mark
//! waited 17 minutes for it to fire during an active Teams meeting.
//!
//! WASAPI exposes the answer directly: each audio endpoint maintains an
//! enumeration of audio sessions, and each session has an owning PID
//! plus a state (Active / Inactive / Expired). When a PID has BOTH a
//! capture session active (mic) AND a render session active (speakers),
//! it's actively in a call. For known meeting processes
//! (`ms-teams.exe`, `Zoom.exe`, etc.), that's the strongest possible
//! "in a meeting" signal — it fires within a second or two of audio
//! kicking in, regardless of meeting subject quirks or window-title
//! formats.
//!
//! ## Threading
//!
//! Same pattern as `audio_session`: COM is apartment-bound, so we spawn
//! a dedicated `std::thread` (`neato-audio-perproc`) that owns
//! `CoInitializeEx` + the IMMDeviceEnumerator for its full lifetime.
//! All WASAPI calls happen on that thread; `DetectionEvent`s are
//! forwarded to the orchestrator's tokio mpsc via
//! `mpsc::Sender::blocking_send`.
//!
//! ## What gets logged
//!
//! - At INFO: each new MicAndSpeakerActive(process) detected and lost.
//! - At INFO: COM init failures and per-call WASAPI errors that would
//!   otherwise be silent (round 1.3's prompt explicitly warns against
//!   silent 17-minute mysteries).
//! - At DEBUG: each tick's intersection sets, for diagnostics.
//!
//! ## Privacy / safety
//!
//! Reads only OS-level audio session metadata (PID + state). Never
//! captures, decodes, or persists audio.

use std::collections::HashSet;
use std::time::Duration;
use tokio::sync::mpsc;
use tracing::{debug, info, warn};

use super::{DetectionEvent, DetectionSource};

const POLL_INTERVAL: Duration = Duration::from_millis(1500);

/// Lowercased process names (with .exe) we treat as native meeting
/// clients. Matched against `sysinfo`'s `process.name()` (case-folded).
/// Browser-mediated meetings (Google Meet, Teams web, Zoom web) are
/// intentionally NOT here — Round 1.3's scope is native apps only.
/// Browser detection via WASAPI requires more nuance because any
/// browser session also gets mic+speaker for video calls in random
/// tabs (YouTube tab calls, WebRTC games, etc).
const KNOWN_MEETING_PROCESSES: &[&str] = &[
    "ms-teams.exe",
    "teams.exe",
    "microsoft.teams.exe",
    "zoom.exe",
    "zoomus.exe", // older Zoom builds
    "cpthost.exe", // Zoom helper
    "webex.exe",
    "webexmta.exe",
    "skype.exe",
    "g2mlauncher.exe",
    "g2mcomm.exe",
];

/// Phase 6 Task 5: lowercased browser process names. A browser with an
/// active render session (speakers) is the source of audio when these
/// PIDs show up in the render-endpoint session enumeration. Used to
/// label browser-played YouTube/Loom/Vimeo sessions as "Browser"
/// instead of inheriting whatever meeting client happens to be running
/// in the tray.
const KNOWN_BROWSER_PROCESSES: &[&str] = &[
    "chrome.exe",
    "msedge.exe",
    "firefox.exe",
    "brave.exe",
    "arc.exe",
    "opera.exe",
    "vivaldi.exe",
];

#[cfg(windows)]
pub async fn run_audio_per_process_watcher(tx: mpsc::Sender<DetectionEvent>) {
    info!(
        "Per-process audio watcher started, poll={}ms, watch_list={:?}",
        POLL_INTERVAL.as_millis(),
        KNOWN_MEETING_PROCESSES
    );

    std::thread::Builder::new()
        .name("neato-audio-perproc".into())
        .spawn(move || com_thread_main(tx))
        .expect("failed to spawn per-process audio thread");

    // Keep the spawning tokio task alive — actual work is on the
    // std::thread. If that thread dies (COM init failure), we still
    // want this task to NOT log "EXITED" via the orchestrator's
    // wrapper, because the per-process thread logs its own diagnosis.
    loop {
        tokio::time::sleep(Duration::from_secs(60 * 60)).await;
    }
}

#[cfg(windows)]
fn com_thread_main(tx: mpsc::Sender<DetectionEvent>) {
    use sysinfo::{ProcessRefreshKind, RefreshKind, System};
    use windows::core::Interface;
    use windows::Win32::Media::Audio::{
        eCapture, eRender, AudioSessionStateActive, AudioSessionStateExpired,
        IAudioSessionControl, IAudioSessionControl2, IAudioSessionEnumerator,
        IAudioSessionManager2, IMMDevice, IMMDeviceEnumerator, MMDeviceEnumerator,
        DEVICE_STATE_ACTIVE,
    };
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL,
        COINIT_MULTITHREADED,
    };

    unsafe {
        let hr = CoInitializeEx(None, COINIT_MULTITHREADED);
        if hr.is_err() {
            warn!(
                "audio_per_process: CoInitializeEx failed: {:?}. \
                 The detector is NOT running.",
                hr
            );
            return;
        }

        let enumerator: IMMDeviceEnumerator =
            match CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) {
                Ok(e) => e,
                Err(e) => {
                    warn!(
                        "audio_per_process: CoCreateInstance(IMMDeviceEnumerator) \
                         failed: {:?}. The detector is NOT running.",
                        e
                    );
                    CoUninitialize();
                    return;
                }
            };

        let mut sys = System::new_with_specifics(
            RefreshKind::new().with_processes(ProcessRefreshKind::new()),
        );
        let mut last_active: HashSet<String> = HashSet::new();
        // Phase 6 Task 5: track browser-render-active set separately so
        // we can emit BrowserAudio detection/lost diffs alongside the
        // existing MicAndSpeakerActive ones.
        let mut last_browsers: HashSet<String> = HashSet::new();

        info!(
            "audio_per_process: COM initialized, IMMDeviceEnumerator created, \
             entering poll loop"
        );

        loop {
            let _ = sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
            let pid_to_name: std::collections::HashMap<u32, String> = sys
                .processes()
                .iter()
                .map(|(pid, p)| {
                    (
                        pid.as_u32(),
                        p.name().to_string_lossy().to_lowercase(),
                    )
                })
                .collect();

            // A process rendering audio right now (Active render session). Used
            // to label a browser as currently playing sound (BrowserAudio).
            let rendering_active = enumerate_session_pids(&enumerator, eRender, false);
            // A process capturing the mic right now (Active capture session).
            let capturing_active = enumerate_session_pids(&enumerator, eCapture, false);

            // PIDs with BOTH mic and speaker Active at this instant. This is a
            // point-in-time "audio flowing" signal: for native apps it's a fine
            // fast-START trigger, but for browsers it flaps during silence (it
            // needs simultaneous mic+speaker). Counting Inactive sessions
            // instead was worse — Teams and Chrome hold idle mic/speaker
            // sessions open 24/7, so the signal never dropped and recordings
            // never stopped. The reliable "still in the call" signal that keeps
            // a recording alive through quiet stretches is the meeting WINDOW
            // TITLE — see StateMachine::has_live_call_evidence.
            let intersect: HashSet<u32> = capturing_active
                .intersection(&rendering_active)
                .copied()
                .collect();

            // Filter to known meeting processes AND browsers. A browser that
            // is in the capture+render intersect holds BOTH the mic and the
            // speakers — i.e. an actual WebRTC call (Google Meet, Teams web,
            // Zoom web). Passive playback (YouTube, music) is render-only, so
            // it never lands in this intersect and won't trigger here. This
            // makes a browser call a first-class "in a call" signal that drops
            // the instant the user leaves the call — the reliable stop signal
            // the sticky window title never provided.
            let mut current_active: HashSet<String> = HashSet::new();
            for pid in &intersect {
                if let Some(name) = pid_to_name.get(pid) {
                    if KNOWN_MEETING_PROCESSES.contains(&name.as_str())
                        || KNOWN_BROWSER_PROCESSES.contains(&name.as_str())
                    {
                        current_active.insert(name.clone());
                    }
                }
            }

            // Phase 6 Task 5: collect browsers actively rendering audio.
            // Render-only is sufficient (most browser playback isn't
            // mic+speaker — that's only WebRTC calls). The state
            // machine treats this as a label-quality signal, not a
            // promotion trigger, so spurious browser audio (Spotify
            // web, ad in a tab) won't auto-record on its own.
            let mut current_browsers: HashSet<String> = HashSet::new();
            for pid in &rendering_active {
                if let Some(name) = pid_to_name.get(pid) {
                    if KNOWN_BROWSER_PROCESSES.contains(&name.as_str()) {
                        current_browsers.insert(name.clone());
                    }
                }
            }

            info!(
                "audio_per_process tick: render_active={} cap_active={} \
                 intersect={} in_call={:?} browsers_playing={:?}",
                rendering_active.len(),
                capturing_active.len(),
                intersect.len(),
                current_active,
                current_browsers
            );

            // Diff & emit. SignalDetected for newly-active processes,
            // SignalLost for newly-dropped ones. The state machine's
            // grace period (Phase 2b round 6: 20s) handles the
            // "session paused for a moment" case so we don't need a
            // hold here — emit immediately on diff.
            for name in current_active.difference(&last_active) {
                info!("MicAndSpeakerActive detected: {}", name);
                if tx
                    .blocking_send(DetectionEvent::SignalDetected(
                        DetectionSource::MicAndSpeakerActive(name.clone()),
                    ))
                    .is_err()
                {
                    warn!("audio_per_process: detection_tx receiver dropped");
                    break;
                }
            }
            for name in last_active.difference(&current_active) {
                info!("MicAndSpeakerActive lost: {}", name);
                if tx
                    .blocking_send(DetectionEvent::SignalLost(
                        DetectionSource::MicAndSpeakerActive(name.clone()),
                    ))
                    .is_err()
                {
                    warn!("audio_per_process: detection_tx receiver dropped");
                    break;
                }
            }

            // Phase 6 Task 5: emit BrowserAudio diffs.
            for name in current_browsers.difference(&last_browsers) {
                info!("BrowserAudio detected: {}", name);
                if tx
                    .blocking_send(DetectionEvent::SignalDetected(
                        DetectionSource::BrowserAudio(name.clone()),
                    ))
                    .is_err()
                {
                    warn!("audio_per_process: detection_tx receiver dropped");
                    break;
                }
            }
            for name in last_browsers.difference(&current_browsers) {
                info!("BrowserAudio lost: {}", name);
                if tx
                    .blocking_send(DetectionEvent::SignalLost(
                        DetectionSource::BrowserAudio(name.clone()),
                    ))
                    .is_err()
                {
                    warn!("audio_per_process: detection_tx receiver dropped");
                    break;
                }
            }

            last_active = current_active;
            last_browsers = current_browsers;
            std::thread::sleep(POLL_INTERVAL);
        }

        // unreachable in practice; if the loop ever broke we'd want to
        // tear COM down, but holding the comment for clarity.
        // CoUninitialize();
    }

    /// Walk every active endpoint of the given direction, collect the
    /// PIDs of every Active session. Failures at any level are
    /// logged-and-skipped, never panicked.
    unsafe fn enumerate_session_pids(
        enumerator: &IMMDeviceEnumerator,
        flow: windows::Win32::Media::Audio::EDataFlow,
        include_inactive: bool,
    ) -> HashSet<u32> {
        let mut pids: HashSet<u32> = HashSet::new();
        let devices = match enumerator.EnumAudioEndpoints(flow, DEVICE_STATE_ACTIVE) {
            Ok(d) => d,
            Err(e) => {
                debug!("EnumAudioEndpoints({:?}) failed: {:?}", flow, e);
                return pids;
            }
        };
        let count = devices.GetCount().unwrap_or(0);
        for i in 0..count {
            let device: IMMDevice = match devices.Item(i) {
                Ok(d) => d,
                Err(_) => continue,
            };
            let mgr: IAudioSessionManager2 = match device.Activate(CLSCTX_ALL, None) {
                Ok(m) => m,
                Err(_) => continue,
            };
            let sessions: IAudioSessionEnumerator = match mgr.GetSessionEnumerator() {
                Ok(s) => s,
                Err(_) => continue,
            };
            let session_count = sessions.GetCount().unwrap_or(0);
            for j in 0..session_count {
                let ctrl: IAudioSessionControl = match sessions.GetSession(j) {
                    Ok(c) => c,
                    Err(_) => continue,
                };
                let state = match ctrl.GetState() {
                    Ok(s) => s,
                    Err(_) => continue,
                };
                // Always skip Expired (the session's stream is gone — the app
                // released the device, e.g. the user left the call). Skip
                // Inactive too unless the caller wants "session merely open"
                // semantics (Active OR Inactive), which is how we detect a
                // call that is live but momentarily silent.
                if state == AudioSessionStateExpired {
                    continue;
                }
                if !include_inactive && state != AudioSessionStateActive {
                    continue;
                }
                let ctrl2: IAudioSessionControl2 = match ctrl.cast() {
                    Ok(c) => c,
                    Err(_) => continue,
                };
                let pid = ctrl2.GetProcessId().unwrap_or(0);
                if pid != 0 {
                    pids.insert(pid);
                }
            }
        }
        pids
    }
}

#[cfg(not(windows))]
pub async fn run_audio_per_process_watcher(_tx: mpsc::Sender<DetectionEvent>) {
    tracing::warn!("Per-process audio watcher: non-Windows platform, no-op");
}
