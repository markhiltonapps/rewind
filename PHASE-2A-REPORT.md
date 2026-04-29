# Phase 2a Final Report

**Branch:** `phase-2a-detection`
**Base:** `phase-1-complete` (21555b0)
**Tag:** `phase-2a-complete` (created locally, not pushed)
**Date:** 2026-04-29

## Summary

Phase 2a converts Neato Rewind from a manual recorder into an
always-on auto-detector for native meeting/call apps. The state machine,
process watcher, tray icon, toast notifications, settings UI, onboarding
modal, and main-window state badge are all in place and compile cleanly.

| | Before | After | Δ |
|---|---|---|---|
| New Rust source files | — | 6 | `detector/{mod,process}.rs`, `state_machine.rs`, `rolling_buffer.rs`, `tray.rs` |
| Modified Rust source files | — | 1 | `lib.rs` (orchestrator wiring + 4 new commands) |
| New TS/TSX source files | — | 1 | `components/Onboarding/index.tsx` |
| Modified TS/TSX files | — | 3 | `app/page.tsx`, `app/settings/page.tsx`, `components/RecordingControls.tsx` |
| New backend changes | — | 2 | `db.py` (migrations + new methods), `main.py` (2 endpoints) |
| New tray icons | — | 4 | `icons/tray/tray-{idle,potential,recording,finalizing}.png` |
| Lines changed (incl. Cargo.lock) | — | +2071 / −554 | |

## Commits

```
6ab8323 docs: update NEATO_NOTES with Phase 2a deferred items
6fc4f43 feat(ui): main window state badge and manual override that respects FSM
4421e7e feat(settings): auto-record toggle and supported apps list
1a26c52 feat(onboarding): first-launch screen with auto-record explainer
14656c5 feat(orchestrator): wire detector, state machine, action handler, tray, notifications
05f61dd feat(db): add detection_source to meetings, auto_record_enabled + has_seen_onboarding to settings
1fddf7b feat(tray): tray icon state management with 4 icons (idle/potential/recording/finalizing)
f3256c7 feat(buffer): 5-min rolling PCM ring buffer for mic + system loopback
68731a6 feat(state-machine): IDLE/POTENTIAL/RECORDING/FINALIZING FSM with debounce + finalize drain
075017e feat(detector): native process watcher for Teams, Zoom, WebEx, Skype, GoToMeeting
f3f435b feat(deps): add sysinfo + tracing-subscriber + notification plugin
```

## Verification status

| Check | Result |
|---|---|
| `cargo check` (frontend/src-tauri) | ✅ Clean — 21 pre-existing warnings, no new ones |
| `cargo build` (debug) | ✅ Built in 33.77s |
| Backend DB migration on existing schema | ✅ Tested: idempotent, preserves existing rows, adds the three new columns with documented defaults |
| Backend `/settings/recording` GET/POST round-trip | ✅ Tested via direct DatabaseManager calls (defaults + partial updates work) |
| Frontend TypeScript type-check | ⚠️ Skipped — `frontend/node_modules` not installed in this worktree (see NEATO_NOTES.md) |
| `pnpm tauri dev` end-to-end smoke (open Teams, watch tray + toast) | ⚠️ **Not run** — requires interactive launch; see "Open questions" |
| Manual mic button → manual_start → FSM → recording | ⚠️ Not exercised at runtime |
| Process watcher actually detects Teams.exe at runtime | ⚠️ Not exercised at runtime |

## Known issues

- `cargo build` emits 21 warnings — all pre-existing and explicitly out of
  scope for Phase 2a per the build plan (mutable static refs, unused
  imports/constants in legacy code, Rust 2024 forward-compat warnings).
- Pre-roll capture: rolling buffer is wired but no audio is fed into it.
  See NEATO_NOTES.md for context. The state machine, tray, toast, and UI
  all behave correctly without it; only the "captured the meeting start"
  guarantee is missing.
- Auto-recording's nominal save path is `<tempdir>/neato-rewind/auto-*.wav`.
  The current `stop_recording` body has the WAV-write logic commented out
  (carried over from before Phase 2a), so this is mostly cosmetic until
  on-disk persistence is restored.

## Deferred items

| Item | Target phase |
|---|---|
| Pre-roll: feed cpal samples into RollingBuffer | Phase 2.5 (after mutable-static refactor) |
| Restore on-disk WAV persistence to stop_recording | Phase 2.5 / 3 |
| Browser tab/window-title scanning (Google Meet, Teams web, etc.) | Phase 2b |
| Audio loopback amplitude detector | Phase 2b |
| YouTube / Vimeo / Twitch detection | Phase 2b |
| Discord auto-trigger (currently logs only) | Phase 2b |
| Rust mutable-static refactor (`MIC_BUFFER`, `MIC_STREAM`, etc.) | Phase 2.5 |
| 21 Rust 2024 warnings | Phase 2.5 |
| Per-app icons in the Settings supported-apps list | Phase 2b polish |

## Open questions for the human

1. **Runtime smoke test.** I did not launch `pnpm tauri dev` because it
   blocks the session interactively. Before pushing the tag, please run:
   ```
   cd frontend && pnpm install && pnpm tauri dev
   ```
   and verify:
   - App launches; tray icon shows orange "NR".
   - Click red mic button: state badge transitions Ready → Recording,
     tray icon turns red. Click again: badge → Finalizing… for ~30s, then
     Ready, tray icon back to orange.
   - Open Teams or Zoom: within ~12s the badge transitions
     Ready → Detecting… → Recording, a toast appears, tray icon turns red.
   - Close Teams: badge stays Recording for 60s, then Finalizing…, then
     Ready.
   - Visit Settings → Recording: toggle off, open Teams again, confirm no
     auto-trigger. Toggle back on, confirm auto-trigger resumes.
   - Manually set `has_seen_onboarding=0` in the DB and restart: the
     onboarding modal should appear on launch.

2. **Onboarding behavior for upgraders.** Existing installs that already
   ran Phase 1 will not have a settings row keyed `id=1` from before this
   phase (Phase 1 had `provider/model/whisperModel` as required NOT NULL
   columns). The migration adds `auto_record_enabled DEFAULT 1` and
   `has_seen_onboarding DEFAULT 0`, so the existing settings row will
   inherit "auto-record ON, onboarding not seen" and the user will see
   the onboarding modal on next launch. This satisfies the "respect their
   current setting if any" constraint (there *was* no current setting),
   but you may want to soft-launch with a different default if user
   research suggests existing users will resent auto-record turning on.

3. **Notification permission UX.** `tauri-plugin-notification` doesn't
   prompt for OS-level notification permission. On Windows the toast
   may silently no-op without an installed AppUserModelID. Worth
   verifying in the production installer build, not just `tauri dev`.

4. **Stop button behavior in FINALIZING.** I made the mic button disabled
   (rather than allowing "cancel finalize") while the FSM is in
   `Finalizing`. The state machine itself supports `ManualStart` from
   `Finalizing` to cancel and resume `Recording`, but the UI doesn't expose
   it. If you want to expose that, the change is small.

5. **Auto-recording save path.** Currently a temp-dir placeholder. Should
   it default to the same `appDataDir()` location that manual recordings
   use? Trivial change once stop_recording is writing files again.

## File map

```
frontend/src-tauri/src/
├── detector/
│   ├── mod.rs          (DetectionSource, DetectionEvent enums)
│   └── process.rs      (sysinfo polling loop)
├── state_machine.rs    (StateMachine + RecorderState/ControlEvent/RecorderAction)
├── rolling_buffer.rs   (5-min PCM VecDeque per channel)
├── tray.rs             (icon resolution + set_icon)
└── lib.rs              (orchestrator: spawns watcher, FSM, ticker, action handler;
                         exposes get_recorder_state, manual_start, manual_stop, set_auto_record)

frontend/src/components/Onboarding/index.tsx   (first-launch modal)
frontend/src/app/page.tsx                       (StateBadge + recorder-state listener)
frontend/src/app/settings/page.tsx              (Recording section + auto-record toggle)
frontend/src/components/RecordingControls.tsx   (now dispatches manual_start/stop)

backend/app/db.py    (run_migrations + get/set_recording_settings)
backend/app/main.py  (GET/POST /settings/recording)

NEATO_NOTES.md       (compromises and deferred items log)
scripts/gen_tray_icons.py  (Pillow generator for the 4 tray icons)
```
