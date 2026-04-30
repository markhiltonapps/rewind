//! Detection module: monitors the system for meeting/call apps.
//! Phase 2a: native process detection.
//! Phase 2b: + window-title scanning + audio-session amplitude.

pub mod process;
pub mod window_title;
pub mod audio_session;

use serde::{Deserialize, Serialize};

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
    /// User clicked the record button
    Manual,
}

/// An event emitted by a detector when its state for a given source changes.
#[derive(Debug, Clone)]
pub enum DetectionEvent {
    SignalDetected(DetectionSource),
    SignalLost(DetectionSource),
}
