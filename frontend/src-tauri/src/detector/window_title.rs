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
//! ## What's NOT covered (yet)
//!
//! Background browser tabs aren't visible via `EnumWindows` because Chrome,
//! Edge, etc. only expose the foreground tab title in their window title.
//! Discovering background tabs requires Chrome DevTools Protocol or the UI
//! Automation accessibility tree — Phase 2c.

use std::collections::HashSet;
use std::time::Duration;
use tokio::sync::mpsc;
use tracing::{info, trace};

use super::{DetectionEvent, DetectionSource};

#[cfg(windows)]
use windows::Win32::Foundation::{BOOL, HWND, LPARAM, TRUE};
#[cfg(windows)]
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetWindowTextLengthW, GetWindowTextW, IsWindowVisible,
};

const POLL_INTERVAL: Duration = Duration::from_secs(2);

/// (label_for_logging, predicate)
type TitleMatcher = (&'static str, fn(&str) -> bool);

/// Patterns are evaluated against the lowercased title. The predicate
/// receives the lowercased string so substring checks are case-insensitive
/// without re-lowercasing on every call.
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
            // Real-world Chrome compact form (verified at runtime in
            // Phase 2b round 3): "Meet - <room-id> - Google Chrome".
            // Chrome strips both `meet.google.com` and the literal string
            // "Google Meet" from the window title, leaving only "Meet" as
            // the page label.
            //
            // "meet" alone is ambiguous (could be a chat message, document
            // filename, or email subject) so we constrain to titles that:
            //   1) start with "meet - " (trimmed, lowercased), AND
            //   2) contain a known browser name somewhere in the title.
            // False positives are theoretically possible — e.g. a Google
            // Doc named "Meet - Project Roadmap" opened in Chrome — but
            // they're rare in practice and the alternative (no detection)
            // is the bug we're fixing. Trade-off documented in NEATO_NOTES.
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

#[cfg(windows)]
pub async fn run_window_watcher(tx: mpsc::Sender<DetectionEvent>) {
    info!(
        "Window title watcher started, polling every {:?}",
        POLL_INTERVAL
    );

    let mut last_detected: HashSet<String> = HashSet::new();

    loop {
        let titles = enumerate_visible_window_titles();
        let mut current_detected: HashSet<String> = HashSet::new();

        for title in &titles {
            trace!("window: {}", title);
            let lower = title.to_lowercase();
            for (label, predicate) in matchers() {
                if predicate(&lower) {
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
    static ENUM_TITLES: std::cell::RefCell<Vec<String>> = std::cell::RefCell::new(Vec::new());
}

#[cfg(windows)]
fn enumerate_visible_window_titles() -> Vec<String> {
    ENUM_TITLES.with(|t| t.borrow_mut().clear());
    unsafe {
        let _ = EnumWindows(Some(enum_callback), LPARAM(0));
    }
    ENUM_TITLES.with(|t| t.borrow().clone())
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
    ENUM_TITLES.with(|t| t.borrow_mut().push(title));
    TRUE
}

#[cfg(not(windows))]
pub async fn run_window_watcher(_tx: mpsc::Sender<DetectionEvent>) {
    tracing::warn!("Window title watcher: non-Windows platform, no-op");
}
