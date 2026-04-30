//! Native process watcher.
//! Polls every 2 seconds for known meeting/call .exe names.

use sysinfo::{System, ProcessRefreshKind, RefreshKind};
use std::collections::HashSet;
use std::time::Duration;
use tokio::sync::mpsc;
use tracing::{info, warn};

use super::{DetectionEvent, DetectionSource};

/// Native meeting/call apps to detect.
/// IMPORTANT: sysinfo 0.32's process.name() on Windows DOES include the .exe
/// suffix (verified at runtime: it returns "ms-teams.exe", "chrome.exe", etc).
/// PowerShell's Get-Process strips the extension — that's a Get-Process
/// behavior, not a sysinfo one. Comparison is case-insensitive.
const NATIVE_MEETING_PROCESSES: &[&str] = &[
    "Teams.exe",       // Microsoft Teams (legacy)
    "ms-teams.exe",    // Microsoft Teams (new)
    "Zoom.exe",        // Zoom desktop
    "CptHost.exe",     // Zoom helper
    "WebexMta.exe",    // Cisco WebEx
    "webex.exe",       // Cisco WebEx alt
    "Skype.exe",       // Skype
    "g2mlauncher.exe", // GoToMeeting launcher
    "g2mcomm.exe",     // GoToMeeting comm
];

/// Excluded — runs in background even outside calls. Phase 2b will detect
/// Discord call activity via audio loopback or window title.
const EXCLUDED_PROCESSES: &[&str] = &[
    "Discord.exe",
];

const POLL_INTERVAL: Duration = Duration::from_secs(2);

pub async fn run_process_watcher(tx: mpsc::Sender<DetectionEvent>) {
    info!("Process watcher started, polling every {:?}", POLL_INTERVAL);
    info!(
        "Watch list (case-insensitive, no .exe suffix): {:?}",
        NATIVE_MEETING_PROCESSES
    );

    // sysinfo 0.32 still exposes ::new() (the no-op constructor); it was renamed
    // to ::nothing() in 0.33+. Plan referenced 0.33+ naming; we pinned 0.32.1.
    let mut sys = System::new_with_specifics(
        RefreshKind::new().with_processes(ProcessRefreshKind::new()),
    );
    let mut last_detected: HashSet<String> = HashSet::new();
    let mut iter: u64 = 0;

    loop {
        iter = iter.wrapping_add(1);
        info!("watcher tick {}: refreshing processes", iter);

        // sysinfo's refresh_processes returns the count of processes updated.
        // The 2nd arg (true) means "remove_dead_processes" so dropped pids
        // are pruned from the internal table.
        let refreshed = sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);

        let mut current_detected: HashSet<String> = HashSet::new();
        let mut total: usize = 0;

        for (_pid, process) in sys.processes() {
            total += 1;
            let name = process.name().to_string_lossy().to_string();
            if NATIVE_MEETING_PROCESSES.iter().any(|p| p.eq_ignore_ascii_case(&name)) {
                current_detected.insert(name.clone());
            } else if EXCLUDED_PROCESSES.iter().any(|p| p.eq_ignore_ascii_case(&name)) {
                info!("Excluded process detected (no auto-trigger): {}", name);
            }
        }

        info!(
            "watcher tick {}: refreshed={} total_seen={} matched={}",
            iter,
            refreshed,
            total,
            current_detected.len()
        );

        // Detect newly-appeared processes
        for name in current_detected.difference(&last_detected) {
            info!("Signal detected: {}", name);
            if let Err(e) = tx
                .send(DetectionEvent::SignalDetected(
                    DetectionSource::Process(name.clone()),
                ))
                .await
            {
                warn!("detection_tx send failed (receiver dropped?): {}", e);
            }
        }

        // Detect newly-disappeared processes
        for name in last_detected.difference(&current_detected) {
            info!("Signal lost: {}", name);
            if let Err(e) = tx
                .send(DetectionEvent::SignalLost(
                    DetectionSource::Process(name.clone()),
                ))
                .await
            {
                warn!("detection_tx send failed (receiver dropped?): {}", e);
            }
        }

        last_detected = current_detected;
        tokio::time::sleep(POLL_INTERVAL).await;
    }
}
