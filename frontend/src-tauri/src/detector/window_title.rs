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
use tracing::{debug, info, trace};

use super::{DetectionEvent, DetectionSource};

#[cfg(windows)]
use sysinfo::{ProcessRefreshKind, RefreshKind, System};
#[cfg(windows)]
use windows::Win32::Foundation::{BOOL, HWND, LPARAM, TRUE};
#[cfg(windows)]
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId,
    IsWindowVisible,
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
        ("Microsoft Teams Meeting", |t| {
            t.contains("| microsoft teams") && t.contains("meeting")
        }),
        ("Microsoft Teams Call", |t| {
            t.contains("| microsoft teams")
                && (t.contains("call") || t.contains(" calling"))
        }),
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

/// Phase 2c round 1.1 — extended Teams matcher. The standard Phase 2b
/// predicates require the literal substring "meeting" or "call" in the
/// window title, but Mark's captured Teams chat title proved real-world
/// titles are nothing like that:
///
///     "Chat | Ali Zahir | Ninja Notes | Mark.Hilton@... | Microsoft Teams"
///
/// New Teams (2.0) opens meetings in a SEPARATE top-level window owned
/// by the same `ms-teams.exe` process, with a different (often shorter)
/// title — usually the meeting subject like "Status Sync". So we need
/// process-aware heuristics:
///
///   1) Existing strict match (covered by `matchers()` already).
///   2) Multi-window heuristic: if `ms-teams.exe` has more than one
///      visible top-level window, a meeting window is almost certainly
///      one of them. Match any window of an ms-teams.exe process in
///      that state (the chat window is benign — it'll just match too,
///      but the same SignalDetected fires either way).
///   3) Subject-only heuristic: a short (< 50 char) ms-teams.exe
///      window title with NO `|` separator strongly resembles a
///      meeting subject (the chat title has 4+ `|` separators).
///
/// Returns true if the (title, owning ms-teams.exe process, total
/// visible windows for that process) tuple looks like a meeting.
/// IMPORTANT: caller must have already verified the process is
/// ms-teams.exe before calling this. The state machine still requires
/// a second corroborating signal (audio activity or process match)
/// for Medium-confidence promotion.
fn teams_extended_match(
    lower_title: &str,
    raw_title: &str,
    teams_window_count: usize,
) -> bool {
    let trimmed = raw_title.trim();
    let pipe_count = trimmed.chars().filter(|c| *c == '|').count();

    // Multi-window heuristic: ms-teams.exe with > 1 top-level window
    // strongly correlates with an active meeting in new Teams.
    if teams_window_count > 1 && lower_title.contains("microsoft teams") {
        return true;
    }

    // Subject-only heuristic: short title with no pipe separators on
    // an ms-teams.exe window. Meeting subjects look like "Status Sync"
    // / "1:1 with Mike" — chat titles have 4+ pipes.
    if pipe_count == 0 && trimmed.len() >= 3 && trimmed.len() < 50 {
        return true;
    }

    false
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

        // Group windows by owning process (lowercased name) so we can
        // count Teams windows for the multi-window heuristic.
        let mut windows_by_proc: HashMap<&str, Vec<&WindowInfo>> = HashMap::new();
        for w in &windows {
            if let Some(name) = pid_to_name.get(&w.pid) {
                windows_by_proc
                    .entry(name.as_str())
                    .or_default()
                    .push(w);
            }
        }

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

        // Evaluate matchers per window.
        let mut current_detected: HashSet<String> = HashSet::new();
        for w in &windows {
            let lower_title = w.title.to_lowercase();
            let pname = pid_to_name
                .get(&w.pid)
                .map(String::as_str)
                .unwrap_or("");

            // Universal matchers (no process context needed).
            let mut matched = false;
            for (label, predicate) in matchers() {
                if predicate(&lower_title) {
                    current_detected.insert(label.to_string());
                    matched = true;
                    break;
                }
            }
            if matched {
                continue;
            }

            // Phase 2c round 1.1: extended Teams matcher. Only runs on
            // ms-teams.exe-owned windows so the subject-only heuristic
            // can't false-positive on, say, a Notepad window titled
            // "Status Sync".
            if is_teams_process(pname) {
                let count = windows_by_proc
                    .get(pname)
                    .map(Vec::len)
                    .unwrap_or(0);
                if teams_extended_match(&lower_title, &w.title, count) {
                    debug!(
                        "Teams extended match: pid={}, window_count={}, title={:?}",
                        w.pid, count, w.title
                    );
                    current_detected.insert("Microsoft Teams Meeting".to_string());
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
