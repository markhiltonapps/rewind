//! Native process watcher.
//! Polls every 2 seconds for known meeting/call .exe names.

use sysinfo::{System, ProcessRefreshKind, RefreshKind};
use std::collections::HashSet;
use std::time::Duration;
use tokio::sync::mpsc;
use tracing::{info, debug};

use super::{DetectionEvent, DetectionSource};

/// Native meeting/call apps to detect.
/// IMPORTANT: sysinfo's process.name() on Windows returns the basename WITHOUT
/// the .exe suffix (e.g. "ms-teams", "Zoom"). Comparison is case-insensitive.
const NATIVE_MEETING_PROCESSES: &[&str] = &[
    "Teams",       // Microsoft Teams (legacy)
    "ms-teams",    // Microsoft Teams (new)
    "Zoom",        // Zoom desktop
    "CptHost",     // Zoom helper
    "WebexMta",    // Cisco WebEx
    "webex",       // Cisco WebEx alt
    "Skype",       // Skype
    "g2mlauncher", // GoToMeeting launcher
    "g2mcomm",     // GoToMeeting comm
];

/// Excluded — runs in background even outside calls. Phase 2b will detect
/// Discord call activity via audio loopback or window title.
const EXCLUDED_PROCESSES: &[&str] = &[
    "Discord",
];

const POLL_INTERVAL: Duration = Duration::from_secs(2);

pub async fn run_process_watcher(tx: mpsc::Sender<DetectionEvent>) {
    info!("Process watcher started, polling every {:?}", POLL_INTERVAL);

    // sysinfo 0.32 still exposes ::new() (the no-op constructor). It was renamed
    // to ::nothing() in 0.33+. Plan referenced 0.33+ naming; we resolved 0.32.1.
    let mut sys = System::new_with_specifics(
        RefreshKind::new().with_processes(ProcessRefreshKind::new())
    );
    let mut last_detected: HashSet<String> = HashSet::new();

    loop {
        sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);

        let mut current_detected: HashSet<String> = HashSet::new();

        for (_pid, process) in sys.processes() {
            let name = process.name().to_string_lossy().to_string();
            if NATIVE_MEETING_PROCESSES.iter().any(|p| p.eq_ignore_ascii_case(&name)) {
                current_detected.insert(name.clone());
            } else if EXCLUDED_PROCESSES.iter().any(|p| p.eq_ignore_ascii_case(&name)) {
                debug!("Excluded process detected (no auto-trigger): {}", name);
            }
        }

        // Detect newly-appeared processes
        for name in current_detected.difference(&last_detected) {
            info!("Signal detected: {}", name);
            let _ = tx.send(DetectionEvent::SignalDetected(
                DetectionSource::Process(name.clone())
            )).await;
        }

        // Detect newly-disappeared processes
        for name in last_detected.difference(&current_detected) {
            info!("Signal lost: {}", name);
            let _ = tx.send(DetectionEvent::SignalLost(
                DetectionSource::Process(name.clone())
            )).await;
        }

        last_detected = current_detected;
        tokio::time::sleep(POLL_INTERVAL).await;
    }
}
