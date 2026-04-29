# Neato Rewind — Phase 2a: Native Detection + State Machine + Rolling Buffer

## Context for Claude Code

You are working on **Neato Rewind**, a Windows desktop AI meeting recorder forked from Meetily and rebranded in Phase 1. The full project plan is in `neato-rewind-build-plan.md` at the repo root. Read it.

**Current state:**
- Phase 1 (rebrand) is complete and verified. Tag: `phase-1-verified` on `neato-main`.
- Production builds work end-to-end. Recording → transcription → save pipeline is functional.
- The app is currently a **manual-record** product: user clicks the red mic button to start, clicks again to stop.

**Your mission for Phase 2a:**
Convert Neato Rewind from a manual recorder into an **always-on auto-detector** for native meeting apps. When the user joins a Teams/Zoom/WebEx/Skype/GoToMeeting call, the app must automatically start recording with a non-blocking toast notification. Manual recording must continue to work alongside auto-detection.

**What's IN Phase 2a:**
1. Native process watcher (`sysinfo` crate) detecting meeting app .exe names
2. State machine: `IDLE → POTENTIAL → RECORDING → FINALIZING → IDLE`
3. 5-minute in-memory rolling audio buffer (captures meeting start even if detection lagged)
4. Tray icon state changes (4 states with distinct icons)
5. Toast notification on `RECORDING` entry via Tauri notification API
6. First-launch onboarding screen explaining auto-record default
7. Settings UI: auto-record ON/OFF toggle, list of detected apps
8. Main window: state badge, manual override that respects state machine
9. Database: `auto_record_enabled` setting, `detection_source` column on meetings

**What's NOT in Phase 2a (defer to Phase 2b):**
- Browser tab/window title scanning (Google Meet, Teams web, Zoom web, etc.)
- Audio loopback amplitude detector
- Per-site allowlist
- YouTube/Vimeo/Twitch detection

**What's NOT in Phase 2a (defer to Phase 2.5):**
- Rust mutable-static refactor (`static mut MIC_BUFFER`, `MIC_STREAM`, etc. — leave them as-is, they work)
- The 21 Rust 2024 compatibility warnings — do NOT try to fix them

---

## Hard constraints

1. **Do not touch the existing audio capture code** in `frontend/src-tauri/src/audio/core.rs` or the `cpal` integration. You will *call* it from new modules. You will not modify it.
2. **Do not touch the existing whisper-server HTTP transcription pipeline.** Phase 2a integrates upstream of it.
3. **Do not refactor the mutable statics.** `MIC_BUFFER`, `SYSTEM_BUFFER`, `MIC_STREAM`, `SYSTEM_STREAM`, `IS_RUNNING` stay exactly as they are. Phase 2.5 will address them.
4. **Auto-record must be ON by default** for new installs. Existing installs (DB already exists with `has_seen_onboarding = true`) should NOT have auto-record toggled by this update — respect their current setting if any.
5. **Manual recording must continue to work** with the existing red mic button. The state machine handles both manual and auto starts/stops.
6. **Discord is excluded from auto-detection** in Phase 2a. (Discord runs in the background even when not in a call. Adding intelligent Discord detection is a Phase 2b task.) Watch for the .exe but do not auto-trigger on it; log only.
7. **The 5-min rolling buffer is RAM-only.** Never write rolling buffer audio to disk unless we transition to `RECORDING`.
8. **Privacy default:** When auto-record is OFF, the rolling buffer must NOT run. No audio capture at all unless user manually clicks record OR auto-record is ON.
9. **Commit after every task completes.** Use clear conventional-style messages: `feat(detector):`, `feat(state-machine):`, `feat(ui):`, `fix(...)`, `docs(...)`.
10. **Add new tech debt to NEATO_NOTES.md.** If you make a tactical compromise, document it before moving on.

---

## Setup

You are operating in a **Baton workspace** with a fresh worktree branched from `neato-main`. The branch is named `phase-2a-detection`.

Verify your starting point:

```bash
git rev-parse HEAD              # should match phase-1-verified tag SHA
git status                      # should be clean
git log --oneline -5            # confirm phase-1-verified is recent
```

If anything looks off, STOP and ask the user before proceeding.

---

## Task list (execute in order)

### Task 1: Add Rust dependencies

**File:** `frontend/src-tauri/Cargo.toml`

Add to `[dependencies]`:
```toml
sysinfo = "0.32"
tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["env-filter"] }
```

Then run `cargo check` from `frontend/src-tauri/` to verify resolution. If `sysinfo` 0.32 has API breakage with our existing code, fall back to `0.31` and document why.

**Commit:** `feat(deps): add sysinfo + tracing for process detection`

---

### Task 2: Build the process watcher module

**New file:** `frontend/src-tauri/src/detector/mod.rs`

```rust
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
```

**New file:** `frontend/src-tauri/src/detector/process.rs`

```rust
//! Native process watcher.
//! Polls every 2 seconds for known meeting/call .exe names.

use sysinfo::{System, ProcessRefreshKind, RefreshKind};
use std::collections::HashSet;
use std::time::Duration;
use tokio::sync::mpsc;
use tracing::{info, debug};

use super::{DetectionEvent, DetectionSource};

/// Native meeting/call apps to detect (Windows .exe names).
/// IMPORTANT: case-insensitive comparison required.
const NATIVE_MEETING_PROCESSES: &[&str] = &[
    "Teams.exe",       // Microsoft Teams (legacy)
    "ms-teams.exe",    // Microsoft Teams (new)
    "Zoom.exe",        // Zoom desktop
    "CptHost.exe",     // Zoom helper
    "WebexMta.exe",    // Cisco WebEx
    "webex.exe",       // Cisco WebEx alt
    "Skype.exe",       // Skype
    "g2mlauncher.exe", // GoToMeeting launcher
    "g2mcomm.exe",     // GoToMeeting comm
];

/// Excluded — runs in background even outside calls. Phase 2b will detect
/// Discord call activity via audio loopback or window title.
const EXCLUDED_PROCESSES: &[&str] = &[
    "Discord.exe",
];

const POLL_INTERVAL: Duration = Duration::from_secs(2);

pub async fn run_process_watcher(tx: mpsc::Sender<DetectionEvent>) {
    info!("Process watcher started, polling every {:?}", POLL_INTERVAL);

    let mut sys = System::new_with_specifics(
        RefreshKind::nothing().with_processes(ProcessRefreshKind::nothing())
    );
    let mut last_detected: HashSet<String> = HashSet::new();

    loop {
        sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);

        let mut current_detected: HashSet<String> = HashSet::new();

        for (_pid, process) in sys.processes() {
            let name = process.name().to_string_lossy().to_string();
            if NATIVE_MEETING_PROCESSES.iter().any(|p| p.eq_ignore_ascii_case(&name)) {
                current_detected.insert(name.clone());
            } else if EXCLUDED_PROCESSES.iter().any(|p| p.eq_ignore_ascii_case(&name)) {
                debug!("Excluded process detected (no auto-trigger): {}", name);
            }
        }

        // Detect newly-appeared processes
        for name in current_detected.difference(&last_detected) {
            info!("Signal detected: {}", name);
            let _ = tx.send(DetectionEvent::SignalDetected(
                DetectionSource::Process(name.clone())
            )).await;
        }

        // Detect newly-disappeared processes
        for name in last_detected.difference(&current_detected) {
            info!("Signal lost: {}", name);
            let _ = tx.send(DetectionEvent::SignalLost(
                DetectionSource::Process(name.clone())
            )).await;
        }

        last_detected = current_detected;
        tokio::time::sleep(POLL_INTERVAL).await;
    }
}
```

**Verify:** `cargo check` from `frontend/src-tauri/`. Should compile with no errors.

**Commit:** `feat(detector): native process watcher for Teams, Zoom, WebEx, Skype, GoToMeeting`

---

### Task 3: Build the state machine

**New file:** `frontend/src-tauri/src/state_machine.rs`

The state machine owns the transition logic. It receives detection events and manual-control events, and emits `RecorderAction` events that downstream code (audio capture, UI, tray) reacts to.

```rust
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
```

**Verify:** `cargo check`. Fix any errors.

**Commit:** `feat(state-machine): IDLE/POTENTIAL/RECORDING/FINALIZING FSM with debounce + finalize drain`

---

### Task 4: Build the rolling buffer

**New file:** `frontend/src-tauri/src/rolling_buffer.rs`

```rust
//! 5-minute in-memory rolling PCM audio buffer.
//! When auto-record is ON, this buffer continuously captures audio from
//! both mic and system loopback streams. On RECORDING entry, the buffer's
//! contents are flushed to the existing recording pipeline so we capture
//! the start of a meeting even if detection lagged.

use std::collections::VecDeque;
use std::sync::Mutex;
use tracing::debug;

/// Sample rate matches existing cpal capture (48 kHz).
const SAMPLE_RATE: usize = 48_000;
/// Stereo
const CHANNELS: usize = 2;
/// 5 minutes
const BUFFER_SECONDS: usize = 300;
/// Max samples in buffer
const MAX_SAMPLES: usize = SAMPLE_RATE * CHANNELS * BUFFER_SECONDS;

pub struct RollingBuffer {
    mic: Mutex<VecDeque<i16>>,
    system: Mutex<VecDeque<i16>>,
}

impl RollingBuffer {
    pub fn new() -> Self {
        Self {
            mic: Mutex::new(VecDeque::with_capacity(MAX_SAMPLES)),
            system: Mutex::new(VecDeque::with_capacity(MAX_SAMPLES)),
        }
    }

    pub fn push_mic(&self, samples: &[i16]) {
        let mut buf = self.mic.lock().unwrap();
        for &s in samples { buf.push_back(s); }
        while buf.len() > MAX_SAMPLES { buf.pop_front(); }
    }

    pub fn push_system(&self, samples: &[i16]) {
        let mut buf = self.system.lock().unwrap();
        for &s in samples { buf.push_back(s); }
        while buf.len() > MAX_SAMPLES { buf.pop_front(); }
    }

    /// Drain buffer contents (mic, system) and return them as Vec<i16>.
    /// Buffer is cleared after drain.
    pub fn drain(&self) -> (Vec<i16>, Vec<i16>) {
        let mut mic = self.mic.lock().unwrap();
        let mut system = self.system.lock().unwrap();
        let mic_out: Vec<i16> = mic.drain(..).collect();
        let system_out: Vec<i16> = system.drain(..).collect();
        debug!("RollingBuffer drained: {} mic samples, {} system samples", mic_out.len(), system_out.len());
        (mic_out, system_out)
    }

    pub fn clear(&self) {
        self.mic.lock().unwrap().clear();
        self.system.lock().unwrap().clear();
    }
}
```

**Note:** This module owns the buffer storage. *How* it gets fed (whether by tapping into the existing cpal callbacks or by running a parallel capture stream) is the integration question for Task 7. Don't solve that yet — get the buffer module compiling first.

**Verify:** `cargo check`.

**Commit:** `feat(buffer): 5-min rolling PCM ring buffer for mic + system loopback`

---

### Task 5: Tray icon state management

**New tray icons needed.** Place 4 PNG files at `frontend/src-tauri/icons/tray/`:

- `tray-idle.png` — orange "NR" on transparent (matches main app icon)
- `tray-potential.png` — blue "NR" with subtle pulse outline
- `tray-recording.png` — red "NR" with small white dot
- `tray-finalizing.png` — gray "NR"

**Generate these as 32×32 PNGs.** Use Python+Pillow:

```python
from PIL import Image, ImageDraw, ImageFont
import os

os.makedirs("frontend/src-tauri/icons/tray", exist_ok=True)

states = {
    "idle":       ("#FF6B35", None),       # orange
    "potential":  ("#3B82F6", "ring"),     # blue with ring
    "recording":  ("#DC2626", "dot"),      # red with dot
    "finalizing": ("#6B7280", None),       # gray
}

for name, (color, marker) in states.items():
    img = Image.new("RGBA", (32, 32), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    # Rounded rectangle background
    draw.rounded_rectangle((2, 2, 30, 30), radius=6, fill=color)
    # "NR" text
    try:
        font = ImageFont.truetype("arial.ttf", 14)
    except OSError:
        font = ImageFont.load_default()
    draw.text((6, 7), "NR", fill="white", font=font)
    # Markers
    if marker == "dot":
        draw.ellipse((22, 4, 28, 10), fill="white")
    elif marker == "ring":
        draw.ellipse((1, 1, 31, 31), outline="white", width=1)
    img.save(f"frontend/src-tauri/icons/tray/tray-{name}.png")
print("Tray icons generated")
```

Run this from the repo root.

**New file:** `frontend/src-tauri/src/tray.rs`

```rust
//! Tray icon state management. Updates icon based on RecorderState.

use tauri::AppHandle;
use tauri::tray::TrayIconBuilder;
use tauri::image::Image;
use tracing::warn;

use crate::state_machine::RecorderState;

pub fn icon_path_for(state: RecorderState) -> &'static str {
    match state {
        RecorderState::Idle       => "icons/tray/tray-idle.png",
        RecorderState::Potential  => "icons/tray/tray-potential.png",
        RecorderState::Recording  => "icons/tray/tray-recording.png",
        RecorderState::Finalizing => "icons/tray/tray-finalizing.png",
    }
}

pub fn update_tray_for_state(app: &AppHandle, state: RecorderState) {
    let path = icon_path_for(state);
    let resolved = app.path().resolve(path, tauri::path::BaseDirectory::Resource);
    match resolved {
        Ok(p) => match Image::from_path(&p) {
            Ok(img) => {
                if let Some(tray) = app.tray_by_id("main") {
                    if let Err(e) = tray.set_icon(Some(img)) {
                        warn!("Failed to set tray icon: {}", e);
                    }
                }
            }
            Err(e) => warn!("Failed to load tray icon image {}: {}", path, e),
        },
        Err(e) => warn!("Failed to resolve tray icon path {}: {}", path, e),
    }
}
```

**Update `frontend/src-tauri/tauri.conf.json`:**

Find the `bundle.resources` array. Add `"icons/tray/*.png"` so the icons get bundled.

In the same file, ensure the tray plugin is enabled. If `app.trayIcon` already exists, set its initial `iconPath` to `icons/tray/tray-idle.png` and give it `id: "main"`. If tray config doesn't exist, add:

```json
"app": {
  "trayIcon": {
    "id": "main",
    "iconPath": "icons/tray/tray-idle.png",
    "tooltip": "Neato Rewind"
  }
}
```

**Verify:** `cargo check` and `pnpm tauri dev` — confirm app launches and shows the orange tray icon. Don't worry about state transitions yet; that comes in Task 7.

**Commit:** `feat(tray): tray icon state management with 4 icons (idle/potential/recording/finalizing)`

---

### Task 6: Database schema additions

The settings and meetings tables need new columns. The schema is managed by the Python backend.

**File:** `backend/app/db.py` (or wherever the SQLite schema is defined — check by grepping for `CREATE TABLE meetings`)

Add migration logic at app startup (idempotent — must not error if columns already exist):

```python
# After existing CREATE TABLE statements
def run_migrations(conn):
    cursor = conn.cursor()
    
    # Migration: add detection_source to meetings
    cursor.execute("PRAGMA table_info(meetings)")
    cols = [row[1] for row in cursor.fetchall()]
    if "detection_source" not in cols:
        cursor.execute("ALTER TABLE meetings ADD COLUMN detection_source TEXT DEFAULT 'manual'")
    
    # Migration: add auto_record_enabled and has_seen_onboarding to settings
    cursor.execute("PRAGMA table_info(settings)")
    cols = [row[1] for row in cursor.fetchall()]
    if "auto_record_enabled" not in cols:
        cursor.execute("ALTER TABLE settings ADD COLUMN auto_record_enabled BOOLEAN DEFAULT 1")
    if "has_seen_onboarding" not in cols:
        cursor.execute("ALTER TABLE settings ADD COLUMN has_seen_onboarding BOOLEAN DEFAULT 0")
    
    conn.commit()
```

Call `run_migrations(conn)` immediately after the existing table creation block on startup.

**Add new endpoints to the FastAPI app** (likely `backend/app/main.py` or `routes.py`):

```python
@app.get("/settings/recording")
def get_recording_settings():
    # Return: { auto_record_enabled: bool, has_seen_onboarding: bool }
    ...

@app.post("/settings/recording")
def set_recording_settings(payload: dict):
    # Accept: { auto_record_enabled?: bool, has_seen_onboarding?: bool }
    # Update settings table
    ...
```

Use the existing settings ID convention (likely a single row with id=1, or upsert pattern).

**Verify:**
1. Delete the existing `backend/meeting_minutes.db` file (back it up first if needed) and restart the backend. It should create a fresh DB with the new columns.
2. OR keep the existing DB and confirm the migration runs without error and adds the new columns.
3. Test the endpoints with `curl` or the browser:
   - `GET http://localhost:5167/settings/recording` returns defaults
   - `POST http://localhost:5167/settings/recording` with `{"auto_record_enabled": false}` works

**Commit:** `feat(db): add detection_source to meetings, auto_record_enabled + has_seen_onboarding to settings`

---

### Task 7: Wire it all together — orchestrator in lib.rs

This is the integration task. You will:
- Import the new modules
- Spawn the process watcher in a tokio task on app startup
- Spawn the state machine orchestrator in a tokio task
- Connect the rolling buffer to the existing audio capture pipeline
- Expose Tauri commands for the frontend to read state and trigger manual events

**File:** `frontend/src-tauri/src/lib.rs`

At the top, add module declarations:
```rust
mod detector;
mod state_machine;
mod rolling_buffer;
mod tray;
```

In the `run()` function (or wherever `tauri::Builder::default()` is configured), add:

1. Initialize a `RollingBuffer` and wrap in `Arc`
2. Create channels: `(detection_tx, detection_rx)`, `(action_tx, action_rx)`, `(control_tx, control_rx)`
3. Spawn process watcher: `tokio::spawn(detector::process::run_process_watcher(detection_tx))`
4. Spawn state machine orchestrator (see below)
5. Spawn action handler (see below)
6. Spawn ticker: every 1 second, send `tick()` to state machine
7. Manage these as `Arc<...>` in Tauri's `.manage()` so commands can access them

**State machine orchestrator** (loop in tokio task):
```rust
loop {
    tokio::select! {
        Some(detection_evt) = detection_rx.recv() => {
            sm.lock().await.handle(ControlEvent::Detection(detection_evt)).await;
        }
        Some(control_evt) = control_rx.recv() => {
            sm.lock().await.handle(control_evt).await;
        }
    }
}
```

**Action handler** (separate tokio task):
```rust
while let Some(action) = action_rx.recv().await {
    match action {
        RecorderAction::StartRecording { source } => {
            // 1. Drain rolling buffer
            let (mic_pre, sys_pre) = buffer.drain();
            // 2. Save the source to a global so the meeting record can reference it
            // 3. Call existing start_recording() command logic
            // 4. Inject pre-roll PCM into the recording stream BEFORE live audio starts
            //    (you may need to add a "preroll" parameter to the existing recording function,
            //    or write the preroll directly to the same WAV/whisper pipeline)
        }
        RecorderAction::StopRecording => {
            // Call existing stop_recording() logic
            // Tag the meeting record with detection_source via DB update
        }
        RecorderAction::EnterFinalizing => {
            // Same as stop, but signal UI we're in drain phase
            app.emit("recorder-state", RecorderState::Finalizing).ok();
        }
        RecorderAction::StateChanged(state) => {
            // Update tray icon
            tray::update_tray_for_state(&app, state);
            // Emit to frontend so UI badge updates
            app.emit("recorder-state", state).ok();
            // On RECORDING entry, fire toast
            if state == RecorderState::Recording {
                use tauri_plugin_notification::NotificationExt;
                app.notification()
                    .builder()
                    .title("Recording started")
                    .body(format!("Capturing {}", source_label))
                    .show()
                    .ok();
            }
        }
    }
}
```

**Connecting rolling buffer to audio capture:**

The cleanest approach: when auto-record is ON, the existing cpal streams must run continuously even when not in `RECORDING` state. The audio data they produce flows into TWO destinations:
1. **Always:** the rolling buffer (5-min discard window)
2. **Only during RECORDING:** the existing on-disk WAV file + whisper-server pipeline

You may need to introduce a small router function. **Do not modify the existing audio capture initialization.** Instead, after streams start, attach a `tee` callback that writes to the rolling buffer regardless of state. Then the existing on-disk pipeline only writes when `IS_RUNNING` is true.

If this is impossible without touching `audio/core.rs`, document it in NEATO_NOTES.md and leave the rolling buffer disconnected for Phase 2a — the state machine still works, you just lose the pre-roll capability. State that explicitly in your final report.

**Tauri commands to expose:**

```rust
#[tauri::command]
async fn get_recorder_state(state: tauri::State<'_, SharedStateMachine>) -> Result<RecorderState, String> {
    Ok(state.lock().await.current_state())
}

#[tauri::command]
async fn manual_start(control_tx: tauri::State<'_, mpsc::Sender<ControlEvent>>) -> Result<(), String> {
    control_tx.send(ControlEvent::ManualStart).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn manual_stop(control_tx: tauri::State<'_, mpsc::Sender<ControlEvent>>) -> Result<(), String> {
    control_tx.send(ControlEvent::ManualStop).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn set_auto_record(enabled: bool, control_tx: tauri::State<'_, mpsc::Sender<ControlEvent>>) -> Result<(), String> {
    control_tx.send(ControlEvent::AutoRecordToggled(enabled)).await.map_err(|e| e.to_string())
}
```

Register them in `.invoke_handler(tauri::generate_handler![...])`.

**Verify:** `cargo build`. Run `pnpm tauri dev`. Open Teams or Zoom. Watch the backend logs for "Signal detected: Teams.exe" within 2-4 seconds. Watch tray icon transition orange → blue → red over 10 seconds. Confirm a toast appears.

**Commit:** `feat(orchestrator): wire detector, state machine, action handler, rolling buffer`

---

### Task 8: Onboarding screen

**New file:** `frontend/src/components/Onboarding/index.tsx`

A modal that shows on first launch (when `has_seen_onboarding === false` from settings/recording endpoint).

Content:
- Header: "Welcome to Neato Rewind"
- Body paragraph: "Neato Rewind automatically captures and transcribes your meetings and calls. When you join a Zoom, Teams, WebEx, Skype, or GoToMeeting call, recording starts automatically."
- "What's captured" section with bullets: "Your microphone audio. System audio (other participants). Nothing is uploaded — recordings stay on your device by default."
- Big toggle: "Auto-record meetings" (default ON, with helper text explaining what it does)
- Two buttons: "Get started" (primary, saves settings + dismisses) / "I'll configure later" (just dismisses without changing defaults)

On submit, POST to `/settings/recording` with `{has_seen_onboarding: true, auto_record_enabled: <toggle value>}`.

**Wire into `frontend/src/app/page.tsx`:**
- On component mount, GET `/settings/recording`
- If `has_seen_onboarding === false`, render `<Onboarding />` modal
- Onboarding's `onComplete` callback hides the modal

**Style:** Match existing app aesthetic (Tailwind, the existing color scheme). Use the orange `#FF6B35` for the primary action button.

**Verify:**
- Manually set `has_seen_onboarding = 0` in settings table (via SQLite browser or `python -c "import sqlite3..."`)
- Restart app
- Onboarding shows
- Toggle to OFF, click "Get started"
- Confirm in DB: `auto_record_enabled = 0`, `has_seen_onboarding = 1`
- Restart app
- Onboarding does NOT show

**Commit:** `feat(onboarding): first-launch screen with auto-record explainer`

---

### Task 9: Settings UI updates

**File:** `frontend/src/app/settings/page.tsx`

Add a new section at the top: "Recording".

Components:
- Section header: "Recording"
- Big toggle switch (matching style of any existing toggles): "Auto-record meetings and videos"
  - Below: small text "Automatically detect and record when you join Teams, Zoom, WebEx, Skype, or GoToMeeting calls"
- Below the toggle: a static section "Detected apps in this version:" followed by a styled list of the 5 supported apps with their icons (or just text bullets if no icons available)
- Below that: small italic text "Browser-based meetings (Google Meet, Teams web, Zoom web) and YouTube/video detection coming in Phase 2b"

When toggle changes:
1. Optimistically update UI
2. POST to `/settings/recording` with `{auto_record_enabled: <new value>}`
3. Also call the `set_auto_record` Tauri command so the running state machine picks up the change immediately
4. On error, revert UI

**Verify:**
- Open Settings
- Toggle auto-record OFF
- Open Teams
- Confirm no detection happens (no tray icon change, no toast)
- Toggle auto-record ON
- Open Teams
- Confirm detection works again

**Commit:** `feat(settings): auto-record toggle and supported apps list`

---

### Task 10: Main window state badge + manual override

**File:** `frontend/src/app/page.tsx`

Subscribe to the `recorder-state` Tauri event:

```ts
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';

const [recorderState, setRecorderState] = useState<RecorderState>('Idle');

useEffect(() => {
  // Get initial state
  invoke<RecorderState>('get_recorder_state').then(setRecorderState);
  
  // Subscribe to updates
  const unsubPromise = listen<RecorderState>('recorder-state', (event) => {
    setRecorderState(event.payload);
  });
  
  return () => { unsubPromise.then(f => f()); };
}, []);
```

Add a state badge component near the existing record button:

```tsx
function StateBadge({ state }: { state: RecorderState }) {
  const config = {
    Idle:       { color: 'bg-gray-200 text-gray-700',   label: 'Ready' },
    Potential:  { color: 'bg-blue-100 text-blue-700',    label: 'Detecting...', pulse: true },
    Recording:  { color: 'bg-red-100 text-red-700',      label: 'Recording' },
    Finalizing: { color: 'bg-gray-100 text-gray-600',    label: 'Finalizing...' },
  }[state];
  return (
    <div className={`px-3 py-1 rounded-full text-xs font-medium ${config.color} ${config.pulse ? 'animate-pulse' : ''}`}>
      {config.label}
    </div>
  );
}
```

Modify the existing red mic button click handler:
- If state is `Idle`: call `manual_start` Tauri command
- If state is `Recording` or `Potential`: call `manual_stop` Tauri command
- If state is `Finalizing`: disable the button (or call `manual_start` again to cancel finalizing — your choice, document it)

**Verify:**
- Click red mic button when idle: state badge transitions Idle → Recording
- Click again: state badge transitions Recording → Finalizing → Idle (over ~30s)
- Open Teams: state badge transitions Idle → Detecting... → Recording (over ~10s)
- Close Teams: state badge stays Recording for 60s, then Finalizing, then Idle

**Commit:** `feat(ui): main window state badge and manual override that respects state machine`

---

### Task 11: Update NEATO_NOTES.md

Document any deferred items or compromises you made.

Required entries (add as needed):
- If rolling buffer couldn't be wired without modifying `audio/core.rs`: document it
- If sysinfo API forced a fallback to v0.31: document it
- Any other tactical compromises

**Commit:** `docs: update NEATO_NOTES with Phase 2a deferred items`

---

### Task 12: Final tag and report

```bash
git tag phase-2a-complete
```

(Don't push the tag yet — the human will verify before pushing.)

---

## Final report format

When all tasks are done, generate a final report following the same template as Phase 1's:

1. **Summary:** What got built, line count diff, file count diff
2. **Commit list:** All commit SHAs and messages from this phase
3. **Verification status:** Which manual tests you ran and their results
4. **Known issues:** Compile warnings, runtime warnings, anything weird
5. **Deferred items:** What got pushed to Phase 2b, 2.5, or beyond
6. **Open questions for the human:** Anything ambiguous you decided unilaterally

Write the report to `PHASE-2A-REPORT.md` in the repo root and commit it as the final commit.

```bash
git log --oneline phase-1-verified..HEAD
```

---

## Constraints reminder (read before starting each task)

- DON'T touch `audio/core.rs` or the existing cpal capture init
- DON'T touch the whisper-server HTTP transcription pipeline
- DON'T refactor mutable statics
- DON'T fix the 21 Rust 2024 warnings
- DON'T add browser tab detection (Phase 2b)
- DON'T add audio loopback amplitude detection (Phase 2b)
- DON'T add Discord auto-trigger (just log)
- DO commit after every task
- DO update NEATO_NOTES.md when you make compromises
- DO test each task before moving to the next

If you hit something genuinely blocking, STOP and write a brief diagnostic to a file called `PHASE-2A-BLOCKED.md` in the repo root, commit it, and end the session. The human will pick up from there.

Begin with Task 1.
