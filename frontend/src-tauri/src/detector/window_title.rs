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
        ("Google Meet", |t| is_google_meet_in_meeting(t)),
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

/// Phase 2c round 1.5 — Teams meeting title predicate (positive-indicator
/// allowlist).
///
/// Round 1.4's design: require `| microsoft teams` suffix AND reject a
/// closed list of nav-tab prefixes (Chat |, Calendar |, Activity |, ...).
/// Anything else with the suffix was assumed to be a meeting.
///
/// That assumption broke on 2026-05-04. Mark hit a false-positive on:
///     "Ninja Notes | Mark.Hilton@ninjaconcepts.ai | Microsoft Teams"
/// — a Teams workspace home view. Suffix matched, no nav-tab prefix,
/// so the predicate accepted it and started recording with no meeting.
///
/// Teams shows many non-meeting windows with the `| microsoft teams`
/// suffix shape: workspace home, channel views, file opens, search
/// results, settings panes, even ad pop-ups. Enumerating every
/// non-meeting prefix isn't tractable.
///
/// Round 1.5 inverts the approach: require POSITIVE evidence of a
/// meeting in the title. The reliable signals are explicit phrases
/// like "Microsoft Teams Meeting" or "Microsoft Teams Call" that
/// only appear in actual meeting / call windows. Workspace, chat,
/// channel, and file views never contain those phrases.
///
/// Returns the matching indicator (so the call site can log which
/// signal fired) or None. The boolean wrapper is `is_teams_meeting_title`.
///
/// Receives the LOWERCASED title (the matchers vec passes lowercased
/// strings).
fn teams_meeting_indicator(lower: &str) -> Option<&'static str> {
    // Cheap precheck: bail on anything that doesn't mention Teams at
    // all. Saves the indicator scan on every non-Teams window.
    if !lower.contains("microsoft teams") {
        return None;
    }

    // Strong positive indicators. Each is a substring that only appears
    // in real meeting/call windows in our observed sample.
    const MEETING_INDICATORS: &[&str] = &[
        "microsoft teams meeting", // explicit meeting window title prefix
        "microsoft teams call",    // active call window
        "meeting in progress",     // some Teams variants
        "teams meeting in progress",
        "meet now",                // Teams "Meet now" instant meeting
    ];
    for indicator in MEETING_INDICATORS {
        if lower.contains(indicator) {
            return Some(indicator);
        }
    }

    // Last-resort heuristic: title's FIRST segment is exactly "meeting"
    // or "meeting with <name>". This catches the bare "Meeting |
    // Microsoft Teams" form some Teams variants emit. Restricted to
    // the first segment so a chat-thread named "Meeting Notes" can't
    // sneak through.
    if let Some(first_segment) = lower.split('|').next() {
        let trimmed = first_segment.trim();
        if trimmed == "meeting" {
            return Some("meeting (first segment)");
        }
        if trimmed.starts_with("meeting with ") {
            return Some("meeting with ... (first segment)");
        }
    }

    None
}

fn is_teams_meeting_title(lower: &str) -> bool {
    teams_meeting_indicator(lower).is_some()
}

/// Phase 3 Task 4: returns true only when the title indicates an ACTIVE
/// Google Meet meeting — not the meet.google.com homepage / lobby.
///
/// The original Phase 2b round 3 predicate matched any browser tab title
/// containing "google meet" or "meet.google.com", which fired a false
/// positive every time Mark visited the Meet homepage to start or
/// schedule a meeting. Three rows like that ended up in the DB.
///
/// Rejection layer:
///   * Tab title is exactly the homepage form, e.g.
///     "Google Meet - Google Chrome", "Meet – Google Meet — ..." → reject
///
/// Acceptance layer (any of):
///   * Title contains a Google Meet meeting code (xxx-xxxx-xxx pattern,
///     three lowercase letters, dash, four lowercase letters, dash, three
///     lowercase letters — Google's documented format).
///   * Title starts with "meet - " (Chrome's compact meeting form, e.g.
///     "Meet - unk-bbpv-tsj - Google Chrome") AND a browser name appears.
///     The homepage rejection above filters out "Meet - Google Meet"
///     before we ever reach this check.
///   * Title contains " - google meet" (older "<meeting-name> - Google
///     Meet — Google Chrome" form) AND a browser name appears. The
///     homepage rejection filters the "Google Meet - <browser>" plain
///     form before we get here.
///
/// Receives the LOWERCASED title (the matchers vec passes lowercased
/// strings).
fn is_google_meet_in_meeting(lower: &str) -> bool {
    let trimmed = lower.trim();

    // Reject homepage / lobby tab title formats first. starts_with so a
    // pinned-tab "•" prefix or other browser decoration doesn't trip us.
    const HOMEPAGE_PREFIXES: &[&str] = &[
        "google meet - google chrome",
        "google meet - microsoft edge",
        "google meet — mozilla firefox",
        "google meet - mozilla firefox",
        "google meet - brave",
        "meet – google meet",
        "meet - google meet",
    ];
    for pat in HOMEPAGE_PREFIXES {
        if trimmed == *pat || trimmed.starts_with(pat) {
            return false;
        }
    }

    let has_browser = trimmed.contains("chrome")
        || trimmed.contains("edge")
        || trimmed.contains("firefox")
        || trimmed.contains("brave");

    // Strongest acceptance: a meeting code anywhere in the title.
    if has_google_meet_code_pattern(trimmed) {
        return true;
    }

    // Chrome's compact "Meet - <subject> - <browser>" form (already
    // post-homepage-filter, so <subject> is non-trivial).
    if trimmed.starts_with("meet - ") && has_browser {
        return true;
    }

    // Older "<meeting-name> - Google Meet — <browser>" form.
    if trimmed.contains(" - google meet") && has_browser {
        return true;
    }

    false
}

/// Phase 3 Task 4: scans a string for a Google Meet meeting code in
/// the format `xxx-xxxx-xxx` (three lowercase letters, dash, four
/// lowercase letters, dash, three lowercase letters). Manual byte
/// scan to avoid pulling in the regex crate just for this one check.
fn has_google_meet_code_pattern(s: &str) -> bool {
    let bytes = s.as_bytes();
    if bytes.len() < 12 {
        return false;
    }
    // Window length is 12: 3 + 1 + 4 + 1 + 3 = 12 bytes.
    for i in 0..=bytes.len() - 12 {
        let w = &bytes[i..i + 12];
        if w[3] != b'-' || w[8] != b'-' {
            continue;
        }
        if !w[..3].iter().all(|b| b.is_ascii_lowercase()) {
            continue;
        }
        if !w[4..8].iter().all(|b| b.is_ascii_lowercase()) {
            continue;
        }
        if !w[9..12].iter().all(|b| b.is_ascii_lowercase()) {
            continue;
        }
        // Boundary check: ensure the chars immediately before and after
        // aren't part of a longer alphanumeric run (e.g. don't match
        // "abc-defg-hijk" or "xabc-defg-hij"). The pattern should be a
        // standalone token.
        if i > 0 {
            let before = bytes[i - 1];
            if before.is_ascii_lowercase() || before.is_ascii_digit() {
                continue;
            }
        }
        if i + 12 < bytes.len() {
            let after = bytes[i + 12];
            if after.is_ascii_lowercase() || after.is_ascii_digit() {
                continue;
            }
        }
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
    // Phase 3 Task 4: same dedup pattern for Google Meet titles that
    // were observed but rejected by the in-meeting predicate (i.e.
    // homepage / lobby tabs). Lets us see what's being filtered.
    let mut logged_meet_rejections: HashSet<String> = HashSet::new();
    // Phase 2c round 1.5: log the title + the matched positive
    // indicator the FIRST time the Teams predicate accepts a given
    // title. Companion to logged_teams_titles (which logs every
    // observed Teams window) — together they show "we saw X, we
    // accepted Y" so future false-positives are easy to attribute.
    let mut logged_teams_acceptances: HashSet<String> = HashSet::new();

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

        // Evaluate matchers per window. Round 1.5 replaced the Teams
        // suffix+blocklist predicate with a positive-indicator
        // allowlist; see `teams_meeting_indicator` for rationale.
        let mut current_detected: HashSet<String> = HashSet::new();
        for w in &windows {
            let lower_title = w.title.to_lowercase();
            let mut matched = false;
            for (label, predicate) in matchers() {
                if predicate(&lower_title) {
                    current_detected.insert(label.to_string());
                    matched = true;
                    break;
                }
            }
            // Phase 2c round 1.5: when the Teams predicate accepts a
            // window, log the title + which positive indicator fired.
            // First-time per unique title, mirroring the diagnostic
            // pattern. Re-running the predicate here is a cheap second
            // string scan only on Teams windows.
            if matched && !logged_teams_acceptances.contains(&w.title) {
                if let Some(indicator) = teams_meeting_indicator(&lower_title) {
                    info!(
                        "Teams meeting title accepted: {:?} (indicator: {:?})",
                        w.title, indicator
                    );
                    logged_teams_acceptances.insert(w.title.clone());
                }
            }
            // Phase 3 Task 4: a title that LOOKS like Google Meet (has
            // "google meet" or "meet.google.com" substring) but failed
            // the in-meeting predicate is almost certainly the
            // homepage/lobby. Log once per unique title so future
            // debugging shows what's getting filtered.
            if !matched
                && (lower_title.contains("google meet")
                    || lower_title.contains("meet.google.com"))
                && !logged_meet_rejections.contains(&w.title)
            {
                info!(
                    "Google Meet title observed (rejected as homepage/non-meeting): {:?}",
                    w.title
                );
                logged_meet_rejections.insert(w.title.clone());
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

#[cfg(test)]
mod tests {
    use super::{is_teams_meeting_title, teams_meeting_indicator};

    fn lower(s: &str) -> String {
        s.to_lowercase()
    }

    #[test]
    fn rejects_workspace_home_view() {
        // Phase 2c round 1.5 regression: this is the exact title that
        // triggered Mark's 2026-05-04 false-positive recording.
        let title = lower("Ninja Notes | Mark.Hilton@ninjaconcepts.ai | Microsoft Teams");
        assert!(!is_teams_meeting_title(&title));
    }

    #[test]
    fn rejects_chat_thread() {
        let title = lower("Chat | Ali Zahir | Ninja Notes | Mark.Hilton@... | Microsoft Teams");
        assert!(!is_teams_meeting_title(&title));
    }

    #[test]
    fn rejects_nav_tabs() {
        for t in [
            "Calendar | Microsoft Teams",
            "Activity | Microsoft Teams",
            "Calls | Microsoft Teams",
            "Files | Microsoft Teams",
            "Apps | Microsoft Teams",
            "Teams | Microsoft Teams",
        ] {
            assert!(!is_teams_meeting_title(&lower(t)), "should reject: {t}");
        }
    }

    #[test]
    fn rejects_channel_view() {
        let title = lower("General | Engineering | Microsoft Teams");
        assert!(!is_teams_meeting_title(&title));
    }

    #[test]
    fn rejects_file_open_inside_teams() {
        let title = lower("roadmap.md | Engineering | Microsoft Teams");
        assert!(!is_teams_meeting_title(&title));
    }

    #[test]
    fn rejects_chat_with_meeting_in_subject() {
        // Round 1.1 regression case: a chat thread literally named
        // "Executive Weekly Meeting" must not match.
        let title = lower("Chat | Executive Weekly Meeting | ... | Microsoft Teams");
        assert!(!is_teams_meeting_title(&title));
    }

    #[test]
    fn accepts_explicit_meeting_window() {
        let title = lower("Microsoft Teams Meeting | Status Sync | Microsoft Teams");
        assert_eq!(
            teams_meeting_indicator(&title),
            Some("microsoft teams meeting")
        );
    }

    #[test]
    fn accepts_explicit_call_window() {
        let title = lower("Microsoft Teams Call | John Doe | Microsoft Teams");
        assert_eq!(
            teams_meeting_indicator(&title),
            Some("microsoft teams call")
        );
    }

    #[test]
    fn accepts_bare_meeting_first_segment() {
        let title = lower("Meeting | Microsoft Teams");
        assert_eq!(
            teams_meeting_indicator(&title),
            Some("meeting (first segment)")
        );
    }

    #[test]
    fn accepts_meeting_with_first_segment() {
        let title = lower("Meeting with Ali Zahir | Microsoft Teams");
        assert_eq!(
            teams_meeting_indicator(&title),
            Some("meeting with ... (first segment)")
        );
    }

    #[test]
    fn rejects_non_teams_titles() {
        assert!(!is_teams_meeting_title(&lower("Slack | DM with Mark")));
        assert!(!is_teams_meeting_title(&lower("VS Code")));
        assert!(!is_teams_meeting_title(&lower("")));
    }
}
