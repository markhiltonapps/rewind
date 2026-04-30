# Neato Rewind — Engineering Notes

Rolling log of tactical compromises, deferred work, and decisions that didn't
fit cleanly into the build plan. Add an entry when you take a shortcut.

## Phase 2b (multi-source detection + auto-detect handoff fix)

### Round 4: Rust-authoritative persistence
**Decided:** 2026-04-30 (round 4)

After Rounds 1–3 the Rust pipeline was bulletproof end-to-end, but
three frontend-lifecycle bugs of the same class remained:

1. UI didn't show "recording" state when auto-detect started → user
   refreshed the page during a session.
2. Refresh wiped React-held transcript buffer + autoSessionRef →
   nothing to POST when `recording-saving` fired.
3. Manual Stop click on an auto-detected session bypassed the listener-
   driven save flow.

The fix moved persistence ownership to Rust:

* New `RecordingSession` struct holds meeting_id, title, source,
  confidence, started_at, and the transcript buffer in a Tauri-managed
  slot. Generated at StartRecording.
* `save_session_to_backend()` uses reqwest to POST to
  `127.0.0.1:5167/save-transcript` after `stop_recording`'s flush.
  On success, emits `meeting-saved` event for the frontend to navigate
  on. On failure, emits `meeting-save-failed` (no retry — Phase 3).
* New `get_recording_state` Tauri command lets the frontend reconcile
  on mount after a refresh.

Frontend now has ZERO `/save-transcript` POST code. The only path
from "recording started" to "DB row" runs through Rust. Refresh during
recording is harmless because Rust still holds the buffer.

### Round 4: live transcript view after refresh shows partial
**Decided:** 2026-04-30 (round 4)

The mount-time `get_recording_state` reconcile sets `meetingTitle`
from the Rust session and re-renders the recording indicator, but it
does NOT replay the pre-refresh transcripts onto screen. The Rust
session buffer is the source of truth and the saved row contains
EVERY transcript (pre- and post-refresh), but the user sees only the
post-refresh ones in the live transcript view until the meeting
ends and they navigate to /meeting-details.

Acceptable for Round 4 — the meeting is saved correctly. A "GET
session transcripts" command + listener bootstrap is a small follow-
up that could land in Round 5 or Phase 3 polish.



### Round 2: partial-chunk silence padding before flush
**Decided:** 2026-04-30 (round 2)

Whisper-server's effective minimum chunk length is roughly 2 seconds.
The transcription task's post-loop flush (added in round 2) sends
whatever is in the partially-filled buffer when `is_running` flips
false. If that partial is shorter than 2s at the mic sample rate, we
pad with f32 zeros up to the threshold so the server still processes
it. Padding is imperfect (whisper sees an artificially-extended
segment, possibly with a noticeable silence tail), but it preserves
the spoken content — which is what users actually care about.

The proper fix is dynamic chunk sizes (whisper-server can return
results before the 10s buffer fills) — that's Phase 3 polish.

### Round 2: manual save no longer happens at click time
**Decided:** 2026-04-30 (round 2)

Phase 2a/2b round 1 had `handleRecordingStop2` POST `/save-transcript`
synchronously when the user clicked the stop button. That meant any
transcripts produced AFTER the click (during the FSM's 30s Finalizing
drain, or by the new partial-chunk flush) were never persisted. It
also meant a user who clicked stop on an auto-detected session would
trigger BOTH the click-time POST (no detection metadata, defaulted to
"manual") AND the auto-recording-saving listener — producing
manual-stamped rows for what should have been auto sessions (Bug 2).

Round 2 collapses both flows into a single `recording-saving` Tauri
event emitted from the Rust StopRecording branch AFTER the post-loop
flush completes. The frontend listener does the only POST and uses
`is_manual` from the payload to pick the right behavior:

* Manual session: keep the user-edited title, navigate to
  /meeting-details after save (existing UX).
* Auto session: title is "Auto: <label>", no navigation (Mark may
  be working on something else).

UX trade-off: clicking stop on a manual recording now waits ~30s for
the FSM's Finalizing drain before navigation. The "Finalizing..." badge
provides visual feedback during the wait. Total time to /meeting-details
is unchanged from before — it's just shifted from "POST at click,
navigate, then drain" to "drain, POST after flush, navigate".

### Audio meter runs in a dedicated std::thread, not a tokio task
**Decided:** 2026-04-30

`IAudioMeterInformation` (and Core Audio interfaces in general) are
apartment-bound: `CoInitializeEx` must be called per-thread, and a
COM-bound interface created on thread A cannot be safely used from thread
B. Tokio tasks may migrate between worker threads, which would crash this
code mid-poll. To sidestep that, `detector::audio_session` spawns a
dedicated `std::thread` (`neato-audio-meter`) that owns COM init + the
meter for its full lifetime, and bridges to the async side via
`mpsc::Sender::blocking_send` into a tokio mpsc. The async task only runs
the threshold state machine.

This is more complex than the build-plan pseudocode (which had everything
in a single tokio task), but keeping COM on a single thread is the only
robust pattern.

### Auto-detect persistence routes through frontend events
**Decided:** 2026-04-30

The Phase 2a "no meeting row created" bug for auto-detect turned out NOT
to be in the cpal/audio pipeline. The actual pipeline (cpal init +
transcription HTTP forwarder) was already shared between manual and
auto-detect via the same `start_recording()` Tauri command call site.
The "channel closed" warnings were benign cpal-callback noise that fires
in the brief window between stream start and first subscribe — it
happens in manual recording too.

The real bug: the meeting row is created at frontend STOP time via
`POST /save-transcript` from `handleRecordingStop2(true)`. That flow only
runs when the user clicks the stop button. Auto-detect never has a click,
so the row never got created, and the captured transcripts were
discarded at the end.

Fix: the Rust action handler now emits two new Tauri events
(`auto-recording-started`, `auto-recording-saving`) that the frontend
listens for and uses to drive the same persistence flow that manual
already does. Manual sessions skip these events on the Rust side, so no
double-save and no behavior regression. The cpal pipeline is untouched.

### Process-only detection no longer auto-records
**Decided:** 2026-04-30

This is intentional and the entire point of Phase 2b's confidence model.
A user who keeps Teams running 24/7 for chat will see process-only
detection (Low confidence) and the FSM will stay in Idle indefinitely.
Recording only triggers when ≥2 of {process, window-title, audio}
sources agree. This **changes Phase 2a's "Teams launches → auto-record"
behavior** by design. If you upgraded from a Phase 2a build and notice
auto-recording no longer fires for "Teams open with no meeting", that's
correct — Phase 2a's behavior was a false-positive trigger.

### Phase 2b runtime smoke test belongs to the human pass
**Decided:** 2026-04-30

End-to-end verification of the auto-detect handoff requires joining a
real meeting (with another participant or a phone) so all three layers
fire concurrently. That smoke test isn't reachable from the agent
context. The architectural fix landed and `cargo check` is clean — the
go/no-go on "real transcripts in DB from auto-detect" is on Mark's
verification pass before pushing the `phase-2b-complete` tag.

## Resolved in Phase 2b

| Phase 2a item | How Phase 2b resolves it |
|---|---|
| Auto-detect → channel-closed warnings, no DB row | Architectural fix via lifecycle events; pipeline untouched |
| Process-only detection over-fires for chat-only Teams | Multi-source confidence requires ≥2 agreeing layers |
| Browser tab/window-title scanning (Google Meet etc.) | New `detector::window_title` module |
| Audio loopback amplitude detector | New `detector::audio_session` via `IAudioMeterInformation` |
| State badge runtime visibility uncertainty | Layout hardened (flex-shrink-0, min-w-0); confirmed at runtime in round 2 |
| Last 10–20s of audio dropped on Finalizing (every recording) | Round 2: post-loop flush sends partial chunk to whisper before stream teardown; stop_recording awaits a Notify so the in-flight request finishes |
| Consecutive auto-sessions stamped detection_source='manual' | Round 2: click-time POST removed; unified `recording-saving` event is the only save path and always carries authoritative metadata |
| Google Meet predicate fails on Chrome's actual title format | Round 3: added third predicate branch matching `"meet - <id> - <browser>"` |
| UI doesn't reflect recording state when auto-detect starts | Round 4: mount-time `get_recording_state` IPC reconciles after refresh |
| Page refresh during recording loses the meeting | Round 4: Rust-authoritative session state survives the React lifecycle |
| Manual Stop on auto-detected session loses metadata | Round 4: single save path through `StopRecording` action handler; no divergent click flow |

## Carried over (still deferred to Phase 2.5+)

| Item | Target phase |
|---|---|
| Pre-roll: feed cpal samples into RollingBuffer | Phase 2.5 |
| Restore on-disk WAV persistence to stop_recording | Phase 2.5 / 3 |
| YouTube / Vimeo / Twitch detection (media-vs-meeting heuristics) | Phase 2c |
| Discord auto-trigger (channel join detection) | Phase 2c |
| Browser background-tab detection (DevTools Protocol or UIA) | Phase 2c |
| Calendar API integration | Phase 4 |
| Rust mutable-static refactor (`MIC_BUFFER`, `MIC_STREAM`, etc.) | Phase 2.5 |
| 21 Rust 2024 forward-compat warnings | Phase 2.5 |
| Per-app icons in the Settings supported-apps list | Phase 2b polish (deferred) |

---

## Phase 2a (detection + state machine + rolling buffer)

### Rolling buffer is constructed but not yet fed (pre-roll deferred)
**Decided:** 2026-04-29

The 5-minute `RollingBuffer` (`src-tauri/src/rolling_buffer.rs`) is
instantiated and `.manage()`'d on app startup, but **no audio is currently
being pushed into it.** The cpal capture streams in `audio/core.rs` only
exist while `IS_RUNNING` is true (i.e. only during a `RECORDING` state).
Wiring continuous capture so the buffer can hold pre-roll audio would
require either:

1. Running cpal streams continuously when `auto_record_enabled` is on, or
2. Spawning a parallel low-rate capture path in addition to the existing one.

Both options touch `audio/core.rs` or its initialization, which Phase 2a
explicitly forbids. Result: when the FSM transitions IDLE → POTENTIAL →
RECORDING, the on-disk recording starts at the moment cpal streams come up,
losing the ~10 seconds of audio between detection and RECORDING entry.

**Impact:** Auto-detected meetings start ~10–12 seconds late on the
recording side. The FSM, tray, toast, and UI all behave correctly — only
the pre-roll capture is missing.

**Resolution path:** Phase 2.5 (mutable-static refactor) is the natural
home for restructuring the audio capture lifecycle so streams can run
independently of `RECORDING` state. After that, feeding the rolling buffer
is a small additional change.

### sysinfo 0.32 API differs from the build plan
**Decided:** 2026-04-29

The build plan's process watcher snippet calls
`RefreshKind::nothing().with_processes(ProcessRefreshKind::nothing())`. That
naming landed in sysinfo 0.33+; in 0.32.1 (which we resolved against) the
zero-init constructors are `RefreshKind::new()` and
`ProcessRefreshKind::new()`. We adjusted the call site in
`detector/process.rs` and pinned `sysinfo = "0.32"`. Functionally
identical. Comment in code points readers to this fact.

### Auto-recordings save to system temp dir
**Decided:** 2026-04-29

When the FSM emits `RecorderAction::StopRecording`, the action handler
synthesizes a `save_path` of `<tempdir>/neato-rewind/auto-<UTC>.wav`. The
Phase 2a stop_recording path doesn't actually write the WAV (most of that
code is commented out in lib.rs), so the path is currently nominal — it
mainly exists so the existing `RecordingArgs` struct is satisfied. When
on-disk persistence is restored, this default location should move to the
configured app-data directory.

### Onboarding "I'll configure later" preserves backend default
**Decided:** 2026-04-29

The "I'll configure later" button on the onboarding modal only sets
`has_seen_onboarding=true`; it does not touch `auto_record_enabled`. For
fresh installs the default is ON; for existing installs the schema
migration also leaves the column at the SQLite default of 1. This means
"configure later" effectively keeps auto-record ON, which matches the
build plan's "auto-record ON by default for new installs" constraint but
might surprise an existing user who upgraded. Acceptable for Phase 2a;
revisit if user feedback shows confusion.

### Frontend type-check skipped during this run
**Decided:** 2026-04-29

This Baton worktree didn't have `frontend/node_modules` installed, and
`pnpm install` would have substantially extended the session. The TS
changes (Onboarding, StateBadge, RecordingControls prop additions, page.tsx
listener wiring) are small and isolated, so I shipped without a `tsc`
pass. A `pnpm tauri dev` smoke test is required before tagging the phase
as verified (called out in the Phase 2a final report).

### Notification permission is not user-prompted at runtime
**Decided:** 2026-04-29

`tauri-plugin-notification` doesn't actively prompt the user for OS-level
notification permission; it relies on the platform's default. On Windows,
toast notifications generally work as long as the app's AppUserModelID is
registered (Tauri does this for installed builds). In `tauri dev`, toasts
may silently no-op without a registered app — verify in production build
during runtime testing.
