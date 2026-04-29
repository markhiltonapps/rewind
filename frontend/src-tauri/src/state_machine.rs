//! Recording state machine.
//! Owns transitions between IDLE / POTENTIAL / RECORDING / FINALIZING.

use std::time::{Duration, Instant};
use serde::{Deserialize, Serialize};
use tokio::sync::{mpsc, Mutex};
use tracing::{info, warn};
use std::sync::Arc;

use crate::detector::{DetectionEvent, DetectionSource};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum RecorderState {
    Idle,
    Potential,    // signal detected, waiting for debounce
    Recording,
    Finalizing,   // draining audio, will save and return to Idle
}

#[derive(Debug, Clone)]
pub enum ControlEvent {
    Detection(DetectionEvent),
    ManualStart,
    ManualStop,
    AutoRecordToggled(bool),  // user toggled auto-record on/off
}

#[derive(Debug, Clone)]
pub enum RecorderAction {
    StartRecording { source: DetectionSource },
    StopRecording,
    EnterFinalizing,
    StateChanged(RecorderState),
}

const POTENTIAL_DEBOUNCE: Duration = Duration::from_secs(10);
const FINALIZING_DRAIN: Duration = Duration::from_secs(30);
const SILENCE_AFTER_LOST: Duration = Duration::from_secs(60);

pub struct StateMachine {
    state: RecorderState,
    auto_record_enabled: bool,
    current_source: Option<DetectionSource>,
    state_entered_at: Instant,
    last_signal_lost_at: Option<Instant>,
    action_tx: mpsc::Sender<RecorderAction>,
}

impl StateMachine {
    pub fn new(action_tx: mpsc::Sender<RecorderAction>, auto_record_enabled: bool) -> Self {
        Self {
            state: RecorderState::Idle,
            auto_record_enabled,
            current_source: None,
            state_entered_at: Instant::now(),
            last_signal_lost_at: None,
            action_tx,
        }
    }

    pub async fn handle(&mut self, event: ControlEvent) {
        info!("StateMachine: in {:?}, received {:?}", self.state, event);

        match (&self.state, &event) {
            // ===== IDLE =====
            (RecorderState::Idle, ControlEvent::Detection(DetectionEvent::SignalDetected(src))) => {
                if self.auto_record_enabled {
                    self.transition_to(RecorderState::Potential, Some(src.clone())).await;
                }
            }
            (RecorderState::Idle, ControlEvent::ManualStart) => {
                self.transition_to(RecorderState::Recording, Some(DetectionSource::Manual)).await;
                self.emit(RecorderAction::StartRecording { source: DetectionSource::Manual }).await;
            }

            // ===== POTENTIAL =====
            (RecorderState::Potential, ControlEvent::Detection(DetectionEvent::SignalLost(_))) => {
                // Signal disappeared during debounce. Cancel.
                self.transition_to(RecorderState::Idle, None).await;
            }
            (RecorderState::Potential, ControlEvent::ManualStart) => {
                // User pressed record while in POTENTIAL. Skip debounce.
                let src = self.current_source.clone().unwrap_or(DetectionSource::Manual);
                self.transition_to(RecorderState::Recording, Some(src.clone())).await;
                self.emit(RecorderAction::StartRecording { source: src }).await;
            }
            (RecorderState::Potential, ControlEvent::ManualStop) => {
                self.transition_to(RecorderState::Idle, None).await;
            }

            // ===== RECORDING =====
            (RecorderState::Recording, ControlEvent::Detection(DetectionEvent::SignalLost(src))) => {
                // Signal lost. Mark time. Don't immediately stop — wait for SILENCE_AFTER_LOST.
                if self.current_source.as_ref() == Some(src) {
                    self.last_signal_lost_at = Some(Instant::now());
                    info!("Signal lost in RECORDING, starting {:?} grace period", SILENCE_AFTER_LOST);
                }
            }
            (RecorderState::Recording, ControlEvent::Detection(DetectionEvent::SignalDetected(_))) => {
                // Signal returned during grace period. Cancel finalize timer.
                self.last_signal_lost_at = None;
            }
            (RecorderState::Recording, ControlEvent::ManualStop) => {
                self.transition_to(RecorderState::Finalizing, self.current_source.clone()).await;
                self.emit(RecorderAction::EnterFinalizing).await;
            }

            // ===== FINALIZING =====
            (RecorderState::Finalizing, ControlEvent::ManualStart) => {
                // User wants to keep recording. Cancel finalize.
                self.transition_to(RecorderState::Recording, self.current_source.clone()).await;
            }

            // ===== AUTO-RECORD TOGGLE =====
            (_, ControlEvent::AutoRecordToggled(enabled)) => {
                self.auto_record_enabled = *enabled;
                info!("Auto-record toggled: {}", enabled);
                if !enabled && self.state == RecorderState::Potential {
                    self.transition_to(RecorderState::Idle, None).await;
                }
            }

            _ => {
                // No-op for unhandled (state, event) combinations
            }
        }
    }

    /// Tick called every second by the orchestrator. Handles time-based transitions.
    pub async fn tick(&mut self) {
        let elapsed = self.state_entered_at.elapsed();

        match self.state {
            RecorderState::Potential => {
                if elapsed >= POTENTIAL_DEBOUNCE {
                    let src = self.current_source.clone()
                        .unwrap_or(DetectionSource::Manual);
                    info!("POTENTIAL debounce elapsed, promoting to RECORDING");
                    self.transition_to(RecorderState::Recording, Some(src.clone())).await;
                    self.emit(RecorderAction::StartRecording { source: src }).await;
                }
            }
            RecorderState::Recording => {
                if let Some(lost_at) = self.last_signal_lost_at {
                    if lost_at.elapsed() >= SILENCE_AFTER_LOST {
                        info!("Signal lost grace period elapsed, entering FINALIZING");
                        self.transition_to(RecorderState::Finalizing, self.current_source.clone()).await;
                        self.emit(RecorderAction::EnterFinalizing).await;
                    }
                }
            }
            RecorderState::Finalizing => {
                if elapsed >= FINALIZING_DRAIN {
                    info!("FINALIZING drain elapsed, returning to IDLE");
                    self.emit(RecorderAction::StopRecording).await;
                    self.transition_to(RecorderState::Idle, None).await;
                }
            }
            _ => {}
        }
    }

    async fn transition_to(&mut self, new_state: RecorderState, source: Option<DetectionSource>) {
        if self.state != new_state {
            info!("State: {:?} -> {:?}", self.state, new_state);
            self.state = new_state;
            self.state_entered_at = Instant::now();
            if matches!(new_state, RecorderState::Idle) {
                self.last_signal_lost_at = None;
                self.current_source = None;
            } else if source.is_some() {
                self.current_source = source;
            }
            self.emit(RecorderAction::StateChanged(new_state)).await;
        }
    }

    async fn emit(&self, action: RecorderAction) {
        if let Err(e) = self.action_tx.send(action).await {
            warn!("Failed to emit RecorderAction: {}", e);
        }
    }

    pub fn current_state(&self) -> RecorderState {
        self.state
    }
}

pub type SharedStateMachine = Arc<Mutex<StateMachine>>;
