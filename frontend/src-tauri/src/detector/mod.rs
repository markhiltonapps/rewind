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
