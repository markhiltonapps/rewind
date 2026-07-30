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
//! | `{AudioActivity, Process}`            | Low        | Stay Idle (Phase 7 Task 6) |
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

use crate::detector::{DetectionEvent, DetectionSource, EnabledSources};

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
// Phase 7 Task 4: lowered MEDIUM debounce 12s → 6s. The 12s was set
// before per-process WASAPI detection landed; with
// MicAndSpeakerActive now firing for real-call signals, the
// remaining Medium-confidence false-positive surface (a meeting
// process being open + background music) is small. Halving the
// debounce shaves ~6s off every detection that doesn't trigger the
// High-confidence path.
const POTENTIAL_DEBOUNCE_MEDIUM: Duration = Duration::from_secs(6);
// Phase 6 Task 2: tightened from 15s → 3s. The original 30s and the
// Phase 2b round 6 reduction to 15s were both sized for legacy
// Whisper streaming — the drain had to cover Whisper's in-flight
// chunk processing. With Phase 4 Task 1C the entire transcription
// runs at end-of-recording via Gemini, so the drain is now just a
// short buffer for the cpal audio callback to flush its last
// samples into the recording buffer. 3s is plenty.
const FINALIZING_DRAIN: Duration = Duration::from_secs(3);
// Grace after CALL-LIVE evidence disappears (see has_live_call_evidence)
// before we finalize. The timer arms only once the meeting is truly gone —
// no mic+speaker session, no audio, AND no meeting window title. Because the
// window title stays present for the whole call, this timer does NOT run
// mid-meeting, so its length does not affect chopping — it only runs AFTER
// the user leaves. 15s is long enough to bridge a brief window-title blip
// (e.g. the tab title flicking when screen-share starts) yet short enough
// that two back-to-back meetings don't merge into one recording unless the
// next one starts within ~15s of leaving the previous. SILENT_AUDIO_AUTO_STOP
// and MAX_RECORDING_DURATION remain hard backstops below.
const SILENCE_AFTER_LOST: Duration = Duration::from_secs(15);
// Phase 8 Task 10: hard cap on recording length. Without this, an
// edge case can leave a recording running for hours:
//   - Real meeting ends but Teams/Zoom/etc. keeps its mic+speaker
//     WASAPI sessions held → MicAndSpeakerActive never drops →
//     confidence stays High → SILENCE_AFTER_LOST never trips
//   - System suspend/resume while in a meeting state
// 3 hours covers any realistic single meeting (longest deliberate
// recording in beta was a 90-min workshop). Hitting this cap forces
// Finalize, which routes the WAV through the normal save flow. The
// transcript may still be long, but it's bounded — Gemini's audio
// context window is ~9 hours so 3 covers margin too.
const MAX_RECORDING_DURATION: Duration = Duration::from_secs(60 * 60 * 3);
// Phase 8 Task 10: extended-silence auto-stop. AudioActivity is the
// detector that tracks peak amplitude on the default render endpoint
// — when nobody is talking AND no system audio is playing for 10
// straight minutes, the meeting is over even if the meeting client
// is still in memory. This is independent of (and complementary to)
// SILENCE_AFTER_LOST, which fires off the multi-source confidence
// dropping. SILENCE_AFTER_LOST handles "Teams crashed"; this handles
// "Teams is still up but the call ended an hour ago".
const SILENT_AUDIO_AUTO_STOP: Duration = Duration::from_secs(60 * 10);

pub struct StateMachine {
    state: RecorderState,
    auto_record_enabled: bool,
    /// Phase 7 Task 5: clone of the per-app gating set. Read in
    /// detection_confidence to veto promotion when BrowserAudio is
    /// the only "meeting" signal and the user has unchecked
    /// "Browser audio" in Settings (i.e. "browser" not in this set).
    enabled_sources: EnabledSources,
    /// Phase 7 Task 5: timestamp of the most recent BrowserAudio
    /// detect (NOT lost). Used to extend the veto window after a
    /// browser stops rendering, because AudioActivity takes ~10s to
    /// drop after audio actually stops. Without this, stopping a
    /// YouTube video creates a brief window of
    /// (Process(zoom) + AudioActivity) Medium confidence that
    /// triggers a recording.
    last_browser_audio_at: Option<Instant>,
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
    /// Phase 8 Task 10: last time AudioActivity was asserted (or the
    /// time we entered Recording, whichever is later). Used by tick()
    /// to enforce SILENT_AUDIO_AUTO_STOP — if AudioActivity stays
    /// absent for the full window, we force Finalize even when the
    /// detection-confidence path can't (Teams holding its WASAPI
    /// sessions perpetually open).
    last_audio_activity_at: Option<Instant>,
    action_tx: mpsc::Sender<RecorderAction>,
}

impl StateMachine {
    pub fn new(
        action_tx: mpsc::Sender<RecorderAction>,
        auto_record_enabled: bool,
        enabled_sources: EnabledSources,
    ) -> Self {
        Self {
            state: RecorderState::Idle,
            auto_record_enabled,
            enabled_sources,
            active_sources: HashSet::new(),
            current_source: None,
            current_confidence: DetectionConfidence::None,
            state_entered_at: Instant::now(),
            last_signal_lost_at: None,
            last_browser_audio_at: None,
            // Phase 8 Task 10: starts None — first set when AudioActivity
            // is detected, or to state_entered_at when we enter Recording.
            last_audio_activity_at: None,
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
        // Phase 6 Task 5: BrowserAudio is a LABEL-only signal — do
        // NOT count it toward has_audio. Reason: chrome.exe's WASAPI
        // render session stays in the Active state for ~30-60s after
        // audio actually stops (Windows audio engine inactivity
        // timer). If BrowserAudio were treated as audio for
        // confidence, the recording would keep itself alive on the
        // stale WASAPI session well past when the user stopped the
        // YouTube video. Letting AudioActivity (default-endpoint
        // peak amplitude) be the sole "audio" signal means the
        // confidence drops cleanly within seconds of the actual
        // audio going silent.
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
        // A known meeting process rendering the call audio (the muted-listener
        // path). Already leaky-bucket-smoothed in the per-process watcher, and
        // specific to the meeting process itself (not browser media playing
        // while a client idles in the tray), so it's a strong start signal on
        // its own — this is what lets a listen-only meeting auto-record.
        let has_meeting_speaker = self
            .active_sources
            .iter()
            .any(|s| matches!(s, DetectionSource::MeetingSpeakerActive(_)));

        if has_mic_and_speaker || has_meeting_speaker {
            return DetectionConfidence::High;
        }

        // Phase 7 Task 5: optional "don't record browser audio"
        // suppression. When the user has unchecked "Browser audio" in
        // Settings ("browser" not in enabled_sources), AND a browser
        // is the source of audio (BrowserAudio asserted), AND there's
        // no strong meeting signal (MicAndSpeakerActive handled above;
        // a meeting-titled window e.g. Google Meet / Teams Web is
        // checked below), veto the promotion. Without this rule the
        // (Process(zoom-idle-in-tray) + AudioActivity) path would
        // still trigger recording on YouTube playback.
        let has_browser_audio = self
            .active_sources
            .iter()
            .any(|s| matches!(s, DetectionSource::BrowserAudio(_)));
        let has_meeting_titled_window = self.active_sources.iter().any(|s| {
            if let DetectionSource::WindowTitle(label) = s {
                crate::detector::label_to_source_key(label).is_some()
            } else {
                false
            }
        });
        // Phase 7 Task 5 fix: the veto must also fire when BrowserAudio
        // RECENTLY dropped. AudioActivity persists ~10s after the
        // amplitude actually falls (INACTIVE_WINDOW_SAMPLES), so
        // pause/stop of a YouTube tab creates a ~10s gap where:
        //   - BrowserAudio gone (the source we want to veto on)
        //   - AudioActivity still asserted (tail amplitude)
        //   - Process(zoom) still asserted (Zoom in tray)
        // Without this, that gap promotes (Process + AudioActivity)
        // = Medium and triggers a recording. 30s window safely covers
        // the silence threshold + a real-meeting fast-start race.
        const BROWSER_AUDIO_RECENT_WINDOW: Duration = Duration::from_secs(30);
        let browser_audio_recent = self
            .last_browser_audio_at
            .map(|t| t.elapsed() < BROWSER_AUDIO_RECENT_WINDOW)
            .unwrap_or(false);
        if (has_browser_audio || browser_audio_recent)
            && !self.enabled_sources.contains("browser")
            && !has_meeting_titled_window
        {
            return DetectionConfidence::None;
        }

        // Phase 7 Task 4: BrowserAudio + a meeting-titled window =
        // High-confidence start. Common case: Google Meet or Teams
        // Web running in Chrome. Shaves 10-15s off the start latency
        // versus waiting for AudioActivity's conservative threshold.
        if has_browser_audio && has_meeting_titled_window {
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
            // Phase 7 Task 6: (AudioActivity + Process) was Medium in
            // Phase 2b. That path triggered too many false positives
            // (YouTube playing while Zoom sits in the tray, Spotify
            // running while Teams is open, etc). MicAndSpeakerActive
            // (Phase 2c Round 1.3) now reliably catches real Zoom/Teams
            // calls via per-process WASAPI capture+render sessions, so
            // this weak fallback is no longer needed. Falls through to
            // Low → stays Idle.
            _ => DetectionConfidence::Low,
        }
    }

    /// Whether the active set contains evidence a call is LIVE right now.
    /// Three signals count:
    ///   * a process holding both mic and speaker (Teams/Zoom desktop in a
    ///     call, or a browser call while audio is flowing),
    ///   * a meeting WINDOW TITLE — the reliable bracket for browser meetings.
    ///     The Google Meet title detector fires only for an *active* meeting
    ///     (it rejects the homepage/lobby), so the title appears on join and
    ///     drops on leave; it survives silent stretches and switching to other
    ///     apps, which the WASAPI signals don't, and
    ///   * sustained speaker audio.
    /// Deliberately excludes signals that linger after a call ends — a meeting
    /// process idling in the tray, or a browser's render session persisting
    /// ~30-60s after audio stops. Known gap: the window title reflects the
    /// browser's FOREGROUND tab, so switching to a different browser TAB
    /// mid-meeting can drop it; SILENCE_AFTER_LOST's grace bridges brief
    /// switches, and background-tab detection (a browser extension) is the
    /// future fix for longer ones.
    fn has_live_call_evidence(&self) -> bool {
        let has_mic_and_speaker = self
            .active_sources
            .iter()
            .any(|s| matches!(s, DetectionSource::MicAndSpeakerActive(_)));
        // The meeting process is still rendering call audio — keeps a
        // listen-only recording alive through the meeting.
        let has_meeting_speaker = self
            .active_sources
            .iter()
            .any(|s| matches!(s, DetectionSource::MeetingSpeakerActive(_)));
        let has_audio = self.active_sources.contains(&DetectionSource::AudioActivity);
        let has_meeting_window = self
            .active_sources
            .iter()
            .any(|s| matches!(s, DetectionSource::WindowTitle(_)));
        has_mic_and_speaker || has_meeting_speaker || has_audio || has_meeting_window
    }

    /// Pick the most informative source from the active set for labeling.
    fn pick_label_source(&self) -> Option<DetectionSource> {
        // Phase 2c round 1.3: a MicAndSpeakerActive source is the most
        // specific evidence — pick it first so the persisted
        // detection_source on the meeting row reads e.g.
        // "ms-teams.exe (mic+speaker)" rather than just "ms-teams.exe".
        // Prefer a NATIVE mic+speaker source (e.g. "ms-teams.exe") — the most
        // specific evidence. A browser mic+speaker source (a Meet/Teams-web
        // call) is intentionally skipped here so the session is still labeled
        // by its window title ("Google Meet") below, not "chrome.exe".
        if let Some(s) = self.active_sources.iter().find(|s| {
            matches!(s, DetectionSource::MicAndSpeakerActive(name)
                if !crate::detector::is_browser_process(name))
        }) {
            return Some(s.clone());
        }
        // A native meeting process rendering the call audio (muted-listener
        // path) — specific enough to label the session directly.
        if let Some(s) = self
            .active_sources
            .iter()
            .find(|s| matches!(s, DetectionSource::MeetingSpeakerActive(_)))
        {
            return Some(s.clone());
        }
        // Then prefer WindowTitle (most descriptive — its labels are
        // pattern-matched against meeting-specific titles like "Zoom
        // Meeting" / "Microsoft Teams Meeting", so a hit here means a
        // real meeting client is on screen).
        if let Some(s) = self
            .active_sources
            .iter()
            .find(|s| matches!(s, DetectionSource::WindowTitle(_)))
        {
            return Some(s.clone());
        }
        // Phase 6 Task 5: BrowserAudio beats Process. The bug it
        // fixes: Zoom.exe sitting idle in the tray + YouTube playing
        // → Process(zoom) is in the active set, but the actual sound
        // source is the browser. Picking BrowserAudio here makes the
        // session label "Browser" instead of "Zoom". A real Zoom
        // meeting also raises MicAndSpeakerActive, which is checked
        // first above, so this doesn't mislabel real meetings.
        if let Some(s) = self
            .active_sources
            .iter()
            .find(|s| matches!(s, DetectionSource::BrowserAudio(_)))
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
                    // Phase 7 Task 5: stamp the timestamp on every
                    // BrowserAudio detect so the veto can keep
                    // suppressing for a window after the source
                    // drops (AudioActivity lingers ~10s).
                    if matches!(src, DetectionSource::BrowserAudio(_)) {
                        self.last_browser_audio_at = Some(Instant::now());
                    }
                    // Phase 8 Task 10: stamp on AudioActivity detects so
                    // tick() can enforce SILENT_AUDIO_AUTO_STOP based on
                    // the last time we actually heard anything. We don't
                    // gate on current state here — the field is only
                    // read inside the Recording branch of tick().
                    if matches!(src, DetectionSource::AudioActivity) {
                        self.last_audio_activity_at = Some(Instant::now());
                    }
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
                // Hysteresis, keyed on CALL-LIVE evidence (a mic+speaker
                // session held — native or browser — or sustained audio)
                // rather than overall confidence. Starting a recording needs
                // multi-source Medium/High confidence, but once recording we
                // keep going only while the call is demonstrably live. A
                // lingering window title or a meeting process idling in the tray
                // no longer keeps the recording alive — that was the bug that
                // left Meet recordings running after the user left the call with
                // the tab still open. A brief mic+speaker flap during a live
                // call (a device change) is bridged both because audio is still
                // present and by the grace timer.
                if !self.has_live_call_evidence() {
                    if self.last_signal_lost_at.is_none() {
                        self.last_signal_lost_at = Some(Instant::now());
                        info!(
                            "Call-live evidence gone in RECORDING, starting {:?} grace period",
                            SILENCE_AFTER_LOST
                        );
                    }
                } else {
                    if self.last_signal_lost_at.is_some() {
                        info!("Call-live evidence returned in RECORDING, canceling grace timer");
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
                // Phase 8 Task 10: hard cap on recording duration. The
                // multi-source confidence path can stay falsely High
                // indefinitely (Teams holds mic+speaker sessions open
                // after the call), so the existing SILENCE_AFTER_LOST
                // grace will never fire in that case. This guard runs
                // unconditionally off state_entered_at and guarantees a
                // terminal Finalize, capping the WAV at a length Gemini
                // can transcribe in one upload.
                if elapsed >= MAX_RECORDING_DURATION {
                    info!(
                        "Recording reached MAX_RECORDING_DURATION ({:?}), forcing FINALIZING",
                        MAX_RECORDING_DURATION
                    );
                    self.transition_to(
                        RecorderState::Finalizing,
                        self.current_source.clone(),
                    )
                    .await;
                    self.emit(RecorderAction::EnterFinalizing).await;
                    return;
                }

                // The audio session watcher is EDGE-triggered: it emits
                // SignalDetected(AudioActivity) once on the silence->sound
                // transition and then stays quiet for as long as audio
                // keeps flowing. So the arrival of *events* cannot measure
                // "how long since we last heard anything" — in a meeting
                // with continuous conversation there are no further events
                // at all. Refreshing the stamp on every tick while the
                // signal is asserted is what makes last_audio_activity_at
                // mean "last time audio was HEARD" rather than "last time
                // audio STARTED". Without this the auto-stop below fired
                // 10 minutes into any continuously-audible meeting and
                // chopped it into a series of recordings.
                if self.active_sources.contains(&DetectionSource::AudioActivity) {
                    self.last_audio_activity_at = Some(Instant::now());
                }

                // Phase 8 Task 10: extended-silence auto-stop. This is
                // softer than SILENCE_AFTER_LOST (which keys off the
                // multi-source confidence dropping). Here we trip when
                // AudioActivity specifically has been quiet for
                // SILENT_AUDIO_AUTO_STOP — covers the case where the
                // meeting client keeps its WASAPI sessions open but
                // there's no actual audio content. last_audio_activity_at
                // is seeded to "now" on Recording entry so the window
                // is honest from the start.
                if let Some(last_audio) = self.last_audio_activity_at {
                    if last_audio.elapsed() >= SILENT_AUDIO_AUTO_STOP {
                        info!(
                            "AudioActivity silent for {:?}, entering FINALIZING",
                            SILENT_AUDIO_AUTO_STOP
                        );
                        self.transition_to(
                            RecorderState::Finalizing,
                            self.current_source.clone(),
                        )
                        .await;
                        self.emit(RecorderAction::EnterFinalizing).await;
                        return;
                    }
                }

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
                // Phase 8 Task 10: clear the audio-activity stamp when
                // we leave the session entirely.
                self.last_audio_activity_at = None;
            } else if matches!(new_state, RecorderState::Recording) {
                // Phase 8 Task 10: seed the audio-activity stamp on
                // every Recording entry. Without this, if AudioActivity
                // never fires after entry (silent meeting, mic muted by
                // both parties), the auto-stop would never trip — the
                // field stays None. Seeding to "now" gives the user the
                // full SILENT_AUDIO_AUTO_STOP window before any timer
                // fires.
                self.last_audio_activity_at = Some(Instant::now());
                if source.is_some() {
                    self.current_source = source;
                }
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

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a StateMachine already in RECORDING, plus the action receiver
    /// (kept alive by the caller so `emit` doesn't fail on a closed channel).
    async fn recording_machine() -> (StateMachine, mpsc::Receiver<RecorderAction>) {
        let (tx, rx) = mpsc::channel(64);
        let mut sm = StateMachine::new(tx, true, EnabledSources::default());
        sm.handle(ControlEvent::ManualStart).await;
        assert_eq!(sm.current_state(), RecorderState::Recording);
        (sm, rx)
    }

    /// Move `last_audio_activity_at` into the past so the
    /// SILENT_AUDIO_AUTO_STOP window is expired without sleeping for 10
    /// real minutes.
    fn backdate_audio_stamp(sm: &mut StateMachine, secs: u64) {
        sm.last_audio_activity_at = Some(
            Instant::now()
                .checked_sub(Duration::from_secs(secs))
                .expect("system uptime too short to backdate the test instant"),
        );
    }

    /// Regression test for the chopped-recording bug.
    ///
    /// The audio session watcher is EDGE-triggered: it emits
    /// `SignalDetected(AudioActivity)` once on the silence->sound
    /// transition and stays quiet while audio continues. A meeting with
    /// continuous conversation therefore produces no further events, so a
    /// timer keyed on the last *event* freezes and trips
    /// SILENT_AUDIO_AUTO_STOP while audio is actually flowing — cutting a
    /// 1-hour meeting into ~4 recordings.
    ///
    /// While AudioActivity is in the active set, the call is audibly live
    /// and the recording must survive any number of ticks.
    #[tokio::test]
    async fn continuous_audio_does_not_trip_silent_auto_stop() {
        let (mut sm, _rx) = recording_machine().await;

        // Audio starts — the one and only rising edge for the rest of the call.
        sm.handle(ControlEvent::Detection(DetectionEvent::SignalDetected(
            DetectionSource::AudioActivity,
        )))
        .await;

        // 10+ minutes of uninterrupted talking: no further detection events,
        // so nothing refreshes the stamp.
        backdate_audio_stamp(&mut sm, SILENT_AUDIO_AUTO_STOP.as_secs() + 100);
        sm.tick().await;

        assert_eq!(
            sm.current_state(),
            RecorderState::Recording,
            "recording was cut while AudioActivity was still asserted"
        );
    }

    /// The complement: the auto-stop must still fire when audio really has
    /// gone away (meeting client holds its WASAPI sessions open after the
    /// call ends). Guards against "fixing" the bug by disabling the feature.
    #[tokio::test]
    async fn sustained_silence_still_trips_silent_auto_stop() {
        let (mut sm, _rx) = recording_machine().await;

        sm.handle(ControlEvent::Detection(DetectionEvent::SignalDetected(
            DetectionSource::AudioActivity,
        )))
        .await;
        // Audio stops for real — the watcher drops the signal.
        sm.handle(ControlEvent::Detection(DetectionEvent::SignalLost(
            DetectionSource::AudioActivity,
        )))
        .await;

        backdate_audio_stamp(&mut sm, SILENT_AUDIO_AUTO_STOP.as_secs() + 100);
        sm.tick().await;

        assert_eq!(
            sm.current_state(),
            RecorderState::Finalizing,
            "silent recording should have auto-stopped"
        );
    }

    /// After audio genuinely stops, the countdown must run from the moment
    /// audio was last HEARD — not from the rising edge that started it.
    #[tokio::test]
    async fn countdown_restarts_from_when_audio_was_last_heard() {
        let (mut sm, _rx) = recording_machine().await;

        sm.handle(ControlEvent::Detection(DetectionEvent::SignalDetected(
            DetectionSource::AudioActivity,
        )))
        .await;

        // A long stretch of continuous audio, then a tick while it's live.
        backdate_audio_stamp(&mut sm, SILENT_AUDIO_AUTO_STOP.as_secs() + 100);
        sm.tick().await;
        assert_eq!(sm.current_state(), RecorderState::Recording);

        // Audio drops. The stamp should now reflect the live tick above, so
        // the machine gets a full fresh window rather than stopping at once.
        sm.handle(ControlEvent::Detection(DetectionEvent::SignalLost(
            DetectionSource::AudioActivity,
        )))
        .await;
        sm.tick().await;

        assert_eq!(
            sm.current_state(),
            RecorderState::Recording,
            "countdown did not reset to the last moment audio was heard"
        );
    }
}
