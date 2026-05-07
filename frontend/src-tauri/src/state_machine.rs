//! Recording state machine.
//! Owns transitions between IDLE / POTENTIAL / RECORDING / FINALIZING.
//!
//! ## Phase 2b: multi-source aggregation
//!
//! Phase 2a treated each `SignalDetected` event independently — if Teams was
//! running, the FSM auto-promoted to Recording even though Teams runs as a
//! 24/7 chat client. Phase 2b tracks the **set** of currently-active
//! detection sources and computes a confidence level from that set:
//!
//! | Active set                            | Confidence | Behavior            |
//! |---------------------------------------|------------|---------------------|
//! | `{}`                                  | None       | Stay Idle           |
//! | `{Process}` only                      | Low        | Stay Idle           |
//! | `{WindowTitle}` only                  | Low        | Stay Idle           |
//! | `{AudioActivity}` only                | Low        | Stay Idle           |
//! | `{WindowTitle, AudioActivity}`        | High       | Promote in 5s       |
//! | `{WindowTitle, Process}`              | Medium     | Promote in 12s      |
//! | `{AudioActivity, Process}`            | Medium     | Promote in 12s      |
//! | `{Process, WindowTitle, AudioActivity}` | High     | Promote in 5s       |
//!
//! Manual recording bypasses the confidence check entirely (manual is its own
//! source and goes straight to Recording).

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, Mutex};
use tracing::{info, warn};

use crate::detector::{DetectionEvent, DetectionSource};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum RecorderState {
    Idle,
    Potential, // signal detected, waiting for debounce
    Recording,
    Finalizing, // draining audio, will save and return to Idle
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum DetectionConfidence {
    None,
    /// Single source — probably not a meeting (chat app running, audio
    /// playing alone, window open without audio corroboration).
    Low,
    /// Two signals from different layers — probably a meeting.
    Medium,
    /// Window title says "Meeting" AND speaker output is active — almost
    /// certainly a real meeting.
    High,
}

impl DetectionConfidence {
    /// String form persisted in the `meetings.detection_confidence` column.
    pub fn as_str(self) -> &'static str {
        match self {
            DetectionConfidence::None => "none",
            DetectionConfidence::Low => "low",
            DetectionConfidence::Medium => "medium",
            DetectionConfidence::High => "high",
        }
    }
}

#[derive(Debug, Clone)]
pub enum ControlEvent {
    Detection(DetectionEvent),
    ManualStart,
    ManualStop,
    AutoRecordToggled(bool),
}

#[derive(Debug, Clone)]
pub enum RecorderAction {
    StartRecording {
        source: DetectionSource,
        confidence: DetectionConfidence,
    },
    StopRecording,
    EnterFinalizing,
    StateChanged(RecorderState),
}

// Phase 2c round 1.3: tightened from 5s → 3s. With the new
// MicAndSpeakerActive signal (a known meeting process owns BOTH a mic
// capture session AND a speaker render session), High confidence is
// far stronger than the old (window+audio) High path. 3s debounce
// gives a total Teams-detection latency of ~5s end-to-end, vs the 17
// minutes Mark waited tonight.
const POTENTIAL_DEBOUNCE_HIGH: Duration = Duration::from_secs(3);
const POTENTIAL_DEBOUNCE_MEDIUM: Duration = Duration::from_secs(12);
// Phase 6 Task 2: tightened from 15s → 3s. The original 30s and the
// Phase 2b round 6 reduction to 15s were both sized for legacy
// Whisper streaming — the drain had to cover Whisper's in-flight
// chunk processing. With Phase 4 Task 1C the entire transcription
// runs at end-of-recording via Gemini, so the drain is now just a
// short buffer for the cpal audio callback to flush its last
// samples into the recording buffer. 3s is plenty.
const FINALIZING_DRAIN: Duration = Duration::from_secs(3);
// Phase 6 Task 2: tightened from 20s → 10s. The 20s window was set
// to forgive brief tab-switches mid-meeting, but in practice the
// MicAndSpeakerActive signal stays asserted as long as the meeting
// window keeps its mic+speaker capture sessions open — a 10-second
// tab-switch doesn't release those sessions. So 10s gives plenty
// of false-stop protection while halving the user-visible lag
// between "meeting ended" and "recording stopped".
const SILENCE_AFTER_LOST: Duration = Duration::from_secs(10);

pub struct StateMachine {
    state: RecorderState,
    auto_record_enabled: bool,
    /// All sources currently producing a "detected" signal. Used to compute
    /// the multi-source confidence. Manual is never inserted here — it
    /// short-circuits straight to Recording.
    active_sources: HashSet<DetectionSource>,
    /// The source that triggered the current Potential/Recording session,
    /// retained for the action handler so it knows what label to show in
    /// the toast and persist on the meeting row.
    current_source: Option<DetectionSource>,
    /// Confidence captured when transitioning into Recording — used for the
    /// debounce duration in Potential and persisted on the meeting row.
    current_confidence: DetectionConfidence,
    state_entered_at: Instant,
    last_signal_lost_at: Option<Instant>,
    action_tx: mpsc::Sender<RecorderAction>,
}

impl StateMachine {
    pub fn new(action_tx: mpsc::Sender<RecorderAction>, auto_record_enabled: bool) -> Self {
        Self {
            state: RecorderState::Idle,
            auto_record_enabled,
            active_sources: HashSet::new(),
            current_source: None,
            current_confidence: DetectionConfidence::None,
            state_entered_at: Instant::now(),
            last_signal_lost_at: None,
            action_tx,
        }
    }

    /// Compute the confidence level from the currently-active source set.
    fn detection_confidence(&self) -> DetectionConfidence {
        let count = self.active_sources.len();
        let has_window_title = self
            .active_sources
            .iter()
            .any(|s| matches!(s, DetectionSource::WindowTitle(_)));
        let has_audio = self.active_sources.contains(&DetectionSource::AudioActivity);
        let has_process = self
            .active_sources
            .iter()
            .any(|s| matches!(s, DetectionSource::Process(_)));
        // Phase 2c round 1.3: a known meeting process holding both a
        // capture (mic) and render (speaker) audio session in WASAPI is
        // a near-certain "in a call" signal on its own. Promotes any
        // active-source set that contains it to High.
        let has_mic_and_speaker = self
            .active_sources
            .iter()
            .any(|s| matches!(s, DetectionSource::MicAndSpeakerActive(_)));

        if has_mic_and_speaker {
            return DetectionConfidence::High;
        }

        match (count, has_window_title, has_audio, has_process) {
            (0, _, _, _) => DetectionConfidence::None,
            // Single source — not enough evidence on its own.
            (1, _, _, _) => DetectionConfidence::Low,
            // Window title + audio is the strongest pair: a meeting client
            // titled "Meeting" with sustained speaker output.
            (_, true, true, _) => DetectionConfidence::High,
            // Window title + process: meeting client visible but speakers
            // may be muted (or remote participant not yet talking).
            (_, true, _, true) => DetectionConfidence::Medium,
            // Audio + process: chat app is open and audio is playing —
            // probably a meeting, could also be media playback while a
            // chat client is incidentally running.
            (_, _, true, true) => DetectionConfidence::Medium,
            _ => DetectionConfidence::Low,
        }
    }

    /// Pick the most informative source from the active set for labeling.
    fn pick_label_source(&self) -> Option<DetectionSource> {
        // Phase 2c round 1.3: a MicAndSpeakerActive source is the most
        // specific evidence — pick it first so the persisted
        // detection_source on the meeting row reads e.g.
        // "ms-teams.exe (mic+speaker)" rather than just "ms-teams.exe".
        if let Some(s) = self
            .active_sources
            .iter()
            .find(|s| matches!(s, DetectionSource::MicAndSpeakerActive(_)))
        {
            return Some(s.clone());
        }
        // Then prefer WindowTitle (most descriptive), then Process,
        // then AudioActivity.
        if let Some(s) = self
            .active_sources
            .iter()
            .find(|s| matches!(s, DetectionSource::WindowTitle(_)))
        {
            return Some(s.clone());
        }
        if let Some(s) = self
            .active_sources
            .iter()
            .find(|s| matches!(s, DetectionSource::Process(_)))
        {
            return Some(s.clone());
        }
        if self.active_sources.contains(&DetectionSource::AudioActivity) {
            return Some(DetectionSource::AudioActivity);
        }
        None
    }

    fn debounce_for(confidence: DetectionConfidence) -> Option<Duration> {
        match confidence {
            DetectionConfidence::High => Some(POTENTIAL_DEBOUNCE_HIGH),
            DetectionConfidence::Medium => Some(POTENTIAL_DEBOUNCE_MEDIUM),
            DetectionConfidence::Low | DetectionConfidence::None => None,
        }
    }

    pub async fn handle(&mut self, event: ControlEvent) {
        info!("StateMachine: in {:?}, received {:?}", self.state, event);

        // Mutate active_sources first so the confidence read after any
        // detection event reflects the new world state.
        if let ControlEvent::Detection(ref det) = event {
            match det {
                DetectionEvent::SignalDetected(src) => {
                    self.active_sources.insert(src.clone());
                }
                DetectionEvent::SignalLost(src) => {
                    self.active_sources.remove(src);
                }
            }
        }

        match (&self.state, &event) {
            // ===== IDLE =====
            (RecorderState::Idle, ControlEvent::Detection(_)) => {
                if self.auto_record_enabled {
                    let confidence = self.detection_confidence();
                    if matches!(
                        confidence,
                        DetectionConfidence::Medium | DetectionConfidence::High
                    ) {
                        let src = self.pick_label_source();
                        self.current_confidence = confidence;
                        self.transition_to(RecorderState::Potential, src).await;
                    }
                }
            }
            (RecorderState::Idle, ControlEvent::ManualStart) => {
                self.current_confidence = DetectionConfidence::None; // manual
                self.transition_to(
                    RecorderState::Recording,
                    Some(DetectionSource::Manual),
                )
                .await;
                self.emit(RecorderAction::StartRecording {
                    source: DetectionSource::Manual,
                    confidence: DetectionConfidence::None,
                })
                .await;
            }

            // ===== POTENTIAL =====
            (RecorderState::Potential, ControlEvent::Detection(_)) => {
                let confidence = self.detection_confidence();
                if matches!(
                    confidence,
                    DetectionConfidence::None | DetectionConfidence::Low
                ) {
                    // Lost enough corroborating signals during debounce. Cancel.
                    info!(
                        "Confidence dropped to {:?} during POTENTIAL, returning to Idle",
                        confidence
                    );
                    self.current_confidence = DetectionConfidence::None;
                    self.transition_to(RecorderState::Idle, None).await;
                } else {
                    // Confidence may have upgraded (e.g. medium -> high). Keep
                    // the higher value so the tick-driven debounce uses the
                    // shorter interval.
                    if confidence as u8 > self.current_confidence as u8 {
                        self.current_confidence = confidence;
                    }
                    // Refresh label source in case window-title arrived after process.
                    if let Some(src) = self.pick_label_source() {
                        self.current_source = Some(src);
                    }
                }
            }
            (RecorderState::Potential, ControlEvent::ManualStart) => {
                let src = self
                    .current_source
                    .clone()
                    .unwrap_or(DetectionSource::Manual);
                let confidence = self.current_confidence;
                self.transition_to(RecorderState::Recording, Some(src.clone()))
                    .await;
                self.emit(RecorderAction::StartRecording {
                    source: src,
                    confidence,
                })
                .await;
            }
            (RecorderState::Potential, ControlEvent::ManualStop) => {
                self.transition_to(RecorderState::Idle, None).await;
            }

            // ===== RECORDING =====
            (RecorderState::Recording, ControlEvent::Detection(_)) => {
                let confidence = self.detection_confidence();
                if matches!(
                    confidence,
                    DetectionConfidence::None | DetectionConfidence::Low
                ) {
                    if self.last_signal_lost_at.is_none() {
                        self.last_signal_lost_at = Some(Instant::now());
                        info!(
                            "Confidence dropped to {:?} in RECORDING, starting {:?} grace period",
                            confidence, SILENCE_AFTER_LOST
                        );
                    }
                } else {
                    // Confidence still good. Cancel any pending finalize timer.
                    if self.last_signal_lost_at.is_some() {
                        info!("Confidence recovered in RECORDING, canceling grace timer");
                    }
                    self.last_signal_lost_at = None;
                }
            }
            (RecorderState::Recording, ControlEvent::ManualStop) => {
                self.transition_to(RecorderState::Finalizing, self.current_source.clone())
                    .await;
                self.emit(RecorderAction::EnterFinalizing).await;
            }

            // ===== FINALIZING =====
            (RecorderState::Finalizing, ControlEvent::ManualStart) => {
                // User wants to keep recording. Cancel finalize.
                self.transition_to(RecorderState::Recording, self.current_source.clone())
                    .await;
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

    /// Tick called every second by the orchestrator. Handles time-based
    /// transitions (Potential debounce, grace period, finalize drain).
    pub async fn tick(&mut self) {
        let elapsed = self.state_entered_at.elapsed();

        match self.state {
            RecorderState::Potential => {
                let debounce = match Self::debounce_for(self.current_confidence) {
                    Some(d) => d,
                    None => return,
                };
                if elapsed >= debounce {
                    let src = self
                        .current_source
                        .clone()
                        .unwrap_or(DetectionSource::Manual);
                    let confidence = self.current_confidence;
                    info!(
                        "POTENTIAL debounce ({:?}, confidence={:?}) elapsed, promoting to RECORDING",
                        debounce, confidence
                    );
                    self.transition_to(RecorderState::Recording, Some(src.clone()))
                        .await;
                    self.emit(RecorderAction::StartRecording {
                        source: src,
                        confidence,
                    })
                    .await;
                }
            }
            RecorderState::Recording => {
                if let Some(lost_at) = self.last_signal_lost_at {
                    if lost_at.elapsed() >= SILENCE_AFTER_LOST {
                        info!("Signal lost grace period elapsed, entering FINALIZING");
                        self.transition_to(
                            RecorderState::Finalizing,
                            self.current_source.clone(),
                        )
                        .await;
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

    async fn transition_to(
        &mut self,
        new_state: RecorderState,
        source: Option<DetectionSource>,
    ) {
        if self.state != new_state {
            info!("State: {:?} -> {:?}", self.state, new_state);
            self.state = new_state;
            self.state_entered_at = Instant::now();
            if matches!(new_state, RecorderState::Idle) {
                self.last_signal_lost_at = None;
                self.current_source = None;
                self.current_confidence = DetectionConfidence::None;
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
