//! Audio session activity detector — placeholder stub.
//! Full implementation lands in Task 3 of Phase 2b.

use tokio::sync::mpsc;

use super::DetectionEvent;

#[cfg(any(windows, not(windows)))]
pub async fn run_audio_session_watcher(_tx: mpsc::Sender<DetectionEvent>) {
    tracing::warn!("Audio session watcher: stub (Phase 2b Task 3 in progress)");
}
