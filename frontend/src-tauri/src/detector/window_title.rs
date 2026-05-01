//! Window title scanner.
//!
//! Enumerates top-level windows every 2 seconds and matches their titles
//! against meeting-specific patterns (Teams meeting, Zoom Meeting, browser
//! tabs for Google Meet, etc). Emits `DetectionEvent` with the same shape
//! as `process.rs` so the orchestrator can mux all detector layers into one
//! channel.
//!
//! ## Privacy
//!
//! Window titles can contain sensitive content (email subjects, document
//! filenames, customer info). We log only the **matched pattern label**
//! (e.g. "Microsoft Teams Meeting") at INFO level. Full window titles go to
//! TRACE only — gated behind `RUST_LOG=trace`.
//!
//! Phase 2c round 1.1 adds **diagnostic INFO logging** specifically for
//! `ms-teams.exe`-owned windows: each unique title is logged once with the
//! owning process name. This is so that real Teams titles (which Phase 2b
//! mostly missed — see the 17-minute detection latency bug) end up in
//! production logs and inform future predicate iteration. The privacy
//! trade-off: Teams meeting/chat window titles can include the meeting
//! subject and participant names. We accept that here because (a) the
//! logs are local-only and (b) we need the corpus to fix the latency
//! bug. Once the per-process WASAPI detector (round 1.3) is the main
//! signal, this diagnostic logging can be reduced to TRACE.
//!
//! ## What's NOT covered (yet)
//!
//! Background browser tabs aren't visible via `EnumWindows` because Chrome,
//! Edge, etc. only expose the foreground tab title in their window title.
//! Discovering background tabs requires Chrome DevTools Protocol or the UI
//! Automation accessibility tree — Phase 2c future round.

use std::collections::{HashMap, HashSet};
use std::time::Duration;
use tokio::sync::mpsc;
use tracing::{info, trace};

use super::{DetectionEvent, DetectionSource};

#[cfg(windows)]
use sysinfo::{ProcessRefreshKind, RefreshKind, System};
#[cfg(windows)]
use windows::Win32::Foundation::{BOOL, HWND, LPARAM, TRUE};
#[cfg(windows)]
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetWindowLongW, GetWindowTextLengthW, GetWindowTextW,
    GetWindowThreadProcessId, IsWindowVisible, GWL_EXSTYLE, WS_EX_TOOLWINDOW,
};

const POLL_INTERVAL: Duration = Duration::from_secs(2);

/// Process names (lowercased, with .exe) that we treat as Teams.
/// Lowercased once at the call site since sysinfo names vary in case.
fn is_teams_process(lower: &str) -> bool {
    matches!(
        lower,
        "ms-teams.exe" | "teams.exe" | "microsoft.teams.exe"
    )
}

/// (label_for_logging, predicate) — universal title predicates that
/// don't need process context. Predicate receives the lowercased title.
type TitleMatcher = (&'static str, fn(&str) -> bool);

fn matchers() -> Vec<TitleMatcher> {
    vec![
        // Phase 2c round 1.4: Teams matching is now a single
        // process-agnostic predicate based on title shape, not a
        // substring search for "meeting" or "call". The old approach
        // produced false positives whenever a chat thread happened
        // to be named with the word "meeting" or "call" — e.g. the
        // user's "Executive Weekly Meeting" chat opened a window
        // titled "Chat | Executive Weekly Meeting | ... | Microsoft
        // Teams" which the old predicate matched.
        ("Microsoft Teams Meeting", |t| is_teams_meeting_title(t)),
        ("Zoom Meeting", |t| t.contains("zoom meeting")),
        ("Zoom Webinar", |t| t.contains("zoom webinar")),
        ("Webex Meeting", |t| {
            t.contains("webex meeting") || t.contains("cisco webex meetings")
        }),
        ("Google Meet", |t| {
            // URL-bearing titles (rare but conclusive — depends on browser
            // version exposing the hostname).
            if t.contains("meet.google.com") {
                return true;
            }
            // Older "<meeting-name> - Google Meet — <browser>" format.
            if t.contains("google meet")
                && (t.contains("chrome")
                    || t.contains("edge")
                    || t.contains("firefox")
                    || t.contains("brave"))
            {
                return true;
            }
            // Real-world Chrome compact form (Phase 2b round 3):
            // "Meet - <room-id> - Google Chrome".
            let trimmed = t.trim();
            if trimmed.starts_with("meet - ")
                && (t.contains("chrome")
                    || t.contains("edge")
                    || t.contains("firefox")
                    || t.contains("brave"))
            {
                return true;
            }
            false
        }),
        ("Teams Web Meeting", |t| {
            t.contains("teams.microsoft.com")
                && (t.contains("meeting") || t.contains("call"))
        }),
        ("Zoom Web Meeting", |t| {
            t.contains("zoom.us/wc/") || t.contains("zoom.us/j/")
        }),
        ("GoToMeeting", |t| t.contains("gotomeeting")),
    ]
}

/// Phase 2c round 1.4 — the single Teams-meeting title predicate.
///
/// Real-world Teams window titles take two shapes that are easy to
/// distinguish by their first segment:
///
///   * Chat / Activity / Calendar / Calls / etc. (NOT a meeting):
///       "Chat | Executive Weekly Meeting | ... | Microsoft Teams"
///       "Calendar | ... | Microsoft Teams"
///       "Activity | ... | Microsoft Teams"
///   * Meeting (in-call window):
///       "Status Sync | Microsoft Teams"
///       "Meeting in General | Microsoft Teams"
///       "<meeting-subject> | Microsoft Teams"
///
/// The chat case bit us in round 1.1: "Executive Weekly Meeting" as a
/// chat thread name made the old `contains("meeting")` predicate
/// match. The new approach: require the title to end with the
/// canonical "| microsoft teams" suffix AND NOT start with any known
/// nav-tab prefix. Nav tabs are a closed list — Teams doesn't add
/// new ones often — so this is robust without reading the meeting
/// subject's content.
///
/// Receives the LOWERCASED title (the matchers vec passes lowercased
/// strings).
fn is_teams_meeting_title(lower: &str) -> bool {
    if !lower.ends_with("| microsoft teams") {
        return false;
    }
    const NON_MEETING_PREFIXES: &[&str] = &[
        "chat |",
        "activity |",
        "calendar |",
        "calls |",
        "files |",
        "apps |",
        "more |",
        "teams |", // the "Teams" tab (channels list)
        "tasks |",
        "shifts |",
        "wiki |",
    ];
    for prefix in NON_MEETING_PREFIXES {
        if lower.starts_with(prefix) {
            return false;
        }
    }
    true
}

#[cfg(windows)]
#[derive(Debug, Clone)]
struct WindowInfo {
    title: String,
    pid: u32,
}

#[cfg(windows)]
pub async fn run_window_watcher(tx: mpsc::Sender<DetectionEvent>) {
    info!(
        "Window title watcher started, polling every {:?}",
        POLL_INTERVAL
    );

    // sysinfo for pid → process name resolution (Phase 2c round 1.1).
    // Same construction pattern as detector::process.
    let mut sys = System::new_with_specifics(
        RefreshKind::new().with_processes(ProcessRefreshKind::new()),
    );

    let mut last_detected: HashSet<String> = HashSet::new();
    // Diagnostic: don't spam the log with the same Teams title every
    // tick. Each unique observed (process, title) is logged once per
    // app run.
    let mut logged_teams_titles: HashSet<String> = HashSet::new();

    loop {
        // Refresh process list to resolve PIDs to names.
        let _ = sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
        let pid_to_name: HashMap<u32, String> = sys
            .processes()
            .iter()
            .map(|(pid, p)| {
                (
                    pid.as_u32(),
                    p.name().to_string_lossy().to_lowercase(),
                )
            })
            .collect();

        // Enumerate visible top-level windows + their owning PID.
        let windows = enumerate_visible_windows();

        // Diagnostic logging for ms-teams.exe windows. Each unique
        // (title) is INFO-logged once. Future iterations can mine these
        // logs for patterns we miss.
        for w in &windows {
            let pname = pid_to_name
                .get(&w.pid)
                .map(String::as_str)
                .unwrap_or("?");
            if is_teams_process(pname) && !logged_teams_titles.contains(&w.title) {
                info!(
                    "Teams window observed (diagnostic): process={}, pid={}, title={:?}",
                    pname, w.pid, w.title
                );
                logged_teams_titles.insert(w.title.clone());
            }
            trace!("window: pid={} title={:?}", w.pid, w.title);
        }

        // Evaluate matchers per window. The round 1.1 process-aware
        // Teams heuristics (multi-window, subject-only) were removed
        // in round 1.4 — `matchers()` now contains a single Teams
        // predicate that excludes nav-tab prefixes, which is more
        // precise and doesn't need process context.
        let mut current_detected: HashSet<String> = HashSet::new();
        for w in &windows {
            let lower_title = w.title.to_lowercase();
            for (label, predicate) in matchers() {
                if predicate(&lower_title) {
                    current_detected.insert(label.to_string());
                    break;
                }
            }
        }

        for label in current_detected.difference(&last_detected) {
            info!("Window title detected: {}", label);
            let _ = tx
                .send(DetectionEvent::SignalDetected(
                    DetectionSource::WindowTitle(label.clone()),
                ))
                .await;
        }

        for label in last_detected.difference(&current_detected) {
            info!("Window title lost: {}", label);
            let _ = tx
                .send(DetectionEvent::SignalLost(DetectionSource::WindowTitle(
                    label.clone(),
                )))
                .await;
        }

        last_detected = current_detected;
        tokio::time::sleep(POLL_INTERVAL).await;
    }
}

#[cfg(windows)]
thread_local! {
    static ENUM_WINDOWS_BUF: std::cell::RefCell<Vec<WindowInfo>> =
        std::cell::RefCell::new(Vec::new());
}

#[cfg(windows)]
fn enumerate_visible_windows() -> Vec<WindowInfo> {
    ENUM_WINDOWS_BUF.with(|t| t.borrow_mut().clear());
    unsafe {
        let _ = EnumWindows(Some(enum_callback), LPARAM(0));
    }
    ENUM_WINDOWS_BUF.with(|t| t.borrow().clone())
}

#[cfg(windows)]
unsafe extern "system" fn enum_callback(hwnd: HWND, _lparam: LPARAM) -> BOOL {
    if !IsWindowVisible(hwnd).as_bool() {
        return TRUE;
    }
    // Phase 2c round 1.4: skip tool windows. Apps like Teams sometimes
    // create small utility / popup windows that shouldn't be enumerated
    // as candidate meeting windows. WS_EX_TOOLWINDOW is the canonical
    // marker for these. Defense-in-depth — applies to all detection,
    // not just Teams.
    let ex_style = GetWindowLongW(hwnd, GWL_EXSTYLE) as u32;
    if (ex_style & WS_EX_TOOLWINDOW.0) != 0 {
        return TRUE;
    }
    let len = GetWindowTextLengthW(hwnd);
    if len <= 0 {
        return TRUE;
    }
    let mut buf = vec![0u16; (len + 1) as usize];
    let copied = GetWindowTextW(hwnd, &mut buf);
    if copied <= 0 {
        return TRUE;
    }
    let title = String::from_utf16_lossy(&buf[..copied as usize]);
    if title.trim().is_empty() {
        return TRUE;
    }
    let mut pid: u32 = 0;
    GetWindowThreadProcessId(hwnd, Some(&mut pid as *mut u32));
    ENUM_WINDOWS_BUF.with(|t| {
        t.borrow_mut().push(WindowInfo { title, pid });
    });
    TRUE
}

#[cfg(not(windows))]
pub async fn run_window_watcher(_tx: mpsc::Sender<DetectionEvent>) {
    tracing::warn!("Window title watcher: non-Windows platform, no-op");
}
