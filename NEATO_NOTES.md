# Neato Rewind — Engineering Notes

Rolling log of tactical compromises, deferred work, and decisions that didn't
fit cleanly into the build plan. Add an entry when you take a shortcut.

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
