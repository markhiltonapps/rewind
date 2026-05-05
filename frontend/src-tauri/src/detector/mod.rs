//! Detection module: monitors the system for meeting/call apps.
//! Phase 2a: native process detection.
//! Phase 2b: + window-title scanning + audio-session amplitude.
//! Phase 2c: + per-process WASAPI mic+speaker detection (round 1.3).

pub mod process;
pub mod window_title;
pub mod audio_session;
pub mod audio_per_process;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde::{Deserialize, Serialize};

/// Phase 2c round 1.2: shared flag set by the process watcher and read
/// by the audio session detector. When a known meeting process is
/// running, the audio detector tightens its sustained-amplitude
/// thresholds so it can fire faster (a Teams meeting that takes 17
/// minutes to cross the conservative threshold is not acceptable).
/// When no meeting process is running, the conservative thresholds
/// stay in place to suppress false positives from random media
/// playback.
#[derive(Clone, Default)]
pub struct MeetingProcessFlag {
    inner: Arc<AtomicBool>,
}

impl MeetingProcessFlag {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn set(&self, v: bool) {
        self.inner.store(v, Ordering::Relaxed);
    }

    pub fn get(&self) -> bool {
        self.inner.load(Ordering::Relaxed)
    }
}

/// What kind of source triggered detection.
///
/// Hash + Eq are required because the state machine stores the currently-
/// active sources in a `HashSet<DetectionSource>` so multi-source aggregation
/// can compute confidence (Task 4).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub enum DetectionSource {
    /// e.g. "ms-teams.exe", "Zoom.exe"
    Process(String),
    /// e.g. "Microsoft Teams Meeting", "Google Meet"
    WindowTitle(String),
    /// Sustained speaker output above amplitude threshold
    AudioActivity,
    /// Phase 2c round 1.3: a known meeting process owns BOTH a
    /// microphone-capture audio session AND a speaker-render audio
    /// session in WASAPI's session enumeration. The strongest "user
    /// is in a call right now" signal short of asking the user
    /// directly. Carries the lowercased process name (e.g.
    /// "ms-teams.exe", "zoom.exe").
    MicAndSpeakerActive(String),
    /// User clicked the record button
    Manual,
}

/// An event emitted by a detector when its state for a given source changes.
#[derive(Debug, Clone)]
pub enum DetectionEvent {
    SignalDetected(DetectionSource),
    SignalLost(DetectionSource),
}

// ===== Phase 4 Task 1B: per-app enable filter ============================

use std::collections::HashSet;
use std::sync::RwLock;

/// Phase 4 Task 1B: thread-safe set of enabled detection-source keys
/// (e.g. {"teams", "meet", "zoom", "webex"}). Detectors check this
/// before emitting a SignalDetected event so toggling Teams off in
/// Settings genuinely stops Teams detection — Meet/Zoom/etc. continue
/// to fire independently.
///
/// Cloned cheaply (Arc internally). The state machine ALSO has its own
/// global auto-record-enabled flag (set_auto_record), which is the
/// master switch — when off, no detection events are processed at all.
/// This filter is the per-app refinement.
#[derive(Clone)]
pub struct EnabledSources {
    inner: Arc<RwLock<HashSet<String>>>,
}

impl Default for EnabledSources {
    fn default() -> Self {
        // Default matches Settings page defaults so a missing
        // /settings response (e.g. backend lag at boot) keeps the
        // shipped sources active rather than silently disabling them.
        let initial = ["teams", "meet", "zoom", "webex"]
            .iter()
            .map(|s| s.to_string())
            .collect::<HashSet<_>>();
        Self {
            inner: Arc::new(RwLock::new(initial)),
        }
    }
}

impl EnabledSources {
    pub fn replace<I: IntoIterator<Item = String>>(&self, keys: I) {
        let mut guard = self.inner.write().expect("EnabledSources poisoned");
        guard.clear();
        for k in keys {
            guard.insert(k.trim().to_lowercase());
        }
    }

    pub fn contains(&self, key: &str) -> bool {
        let guard = self.inner.read().expect("EnabledSources poisoned");
        guard.contains(key)
    }
}

/// Map a process name (lowercased, with or without `.exe`) to a
/// canonical Settings source key. Returns None for processes we don't
/// gate (the unknown-source case currently means "always allow").
pub fn process_to_source_key(name: &str) -> Option<&'static str> {
    let n = name.to_lowercase();
    if n.contains("teams") {
        Some("teams")
    } else if n.contains("zoom") {
        Some("zoom")
    } else if n.contains("webex") {
        Some("webex")
    } else if n.contains("discord") {
        Some("discord")
    } else {
        None
    }
}

/// Map a window-title matcher label (e.g. "Microsoft Teams Meeting",
/// "Google Meet", "Zoom Meeting") to a canonical Settings source key.
pub fn label_to_source_key(label: &str) -> Option<&'static str> {
    let l = label.to_lowercase();
    if l.contains("teams") {
        Some("teams")
    } else if l.contains("google meet") {
        Some("meet")
    } else if l.contains("zoom") {
        Some("zoom")
    } else if l.contains("webex") {
        Some("webex")
    } else if l.contains("gotomeeting") {
        // Out of scope for Settings v1 — let it through unconditionally
        // (None) so we don't accidentally disable it.
        None
    } else {
        None
    }
}

/// Decide whether a DetectionSource should be allowed to emit given the
/// current EnabledSources set. Returns true for unknown source keys
/// (don't accidentally suppress detectors we forgot to map) and for
/// the Manual source (always allowed).
pub fn source_allowed(src: &DetectionSource, enabled: &EnabledSources) -> bool {
    let key = match src {
        DetectionSource::Manual => return true,
        DetectionSource::AudioActivity => return true,
        DetectionSource::Process(name) => process_to_source_key(name),
        DetectionSource::MicAndSpeakerActive(name) => process_to_source_key(name),
        DetectionSource::WindowTitle(label) => label_to_source_key(label),
    };
    match key {
        Some(k) => enabled.contains(k),
        None => true,
    }
}
