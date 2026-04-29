//! Detection module: monitors the system for meeting/call apps.
//! Phase 2a: native process detection only.
//! Phase 2b will add: window title scanning, audio loopback amplitude.

pub mod process;

use serde::{Deserialize, Serialize};

/// What kind of source triggered detection
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum DetectionSource {
    Process(String),       // e.g. "Zoom.exe"
    // BrowserTab(String), // Phase 2b
    // AudioActivity,      // Phase 2b
    Manual,                // user clicked record button
}

/// An event emitted by a detector when state changes
#[derive(Debug, Clone)]
pub enum DetectionEvent {
    SignalDetected(DetectionSource),
    SignalLost(DetectionSource),
}
