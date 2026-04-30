# Phase 2b Final Report

**Branch:** `phase-2b-detection`
**Base:** `phase-2a-complete` (91713b7)
**Tag:** `phase-2b-complete` (created locally, not pushed)
**Date:** 2026-04-30

## Summary

Phase 2b converts Neato Rewind's auto-detection from "process exists" to
"user is actually in a meeting" by stacking three detection layers and
requiring at least two to agree before promoting to RECORDING. It also
fixes the Phase 2a carryover bug where auto-detected sessions never
produced a meeting row in the database.

| | Phase 2a | Phase 2b | Δ |
|---|---|---|---|
| Detector modules | 1 (process) | 3 (process + window-title + audio) | +2 |
| State machine | single-source | HashSet aggregation w/ confidence | refactored |
| New Rust source files | — | 2 | `detector/{window_title,audio_session}.rs` |
| Modified Rust source files | — | 4 | `lib.rs`, `state_machine.rs`, `detector/mod.rs`, `Cargo.toml` |
| Modified TS files | — | 2 | `app/page.tsx`, `app/settings/page.tsx` |
| Backend changes | — | 2 | `db.py` (detection_confidence column), `main.py` (extended /save-transcript) |
| Lines changed (incl. Cargo.lock) | — | +1051 / −90 | |

## Commits

```
4f55b71 docs: update NEATO_NOTES with Phase 2b findings and resolved items
44f446f feat(settings-ui): add detection explanation to Recording section
cb0e89b fix(ui): make state badge robust against long titles
3bbde37 feat(orchestrator): spawn window-title and audio-session watchers
c2628d1 fix(handoff): unify auto-detect and manual recording start paths
4067859 feat(db): add detection_confidence column to meetings
caa6279 feat(state-machine): multi-source aggregation with detection confidence levels
5a6e0a6 feat(detector-audio): audio session amplitude watcher via IAudioMeterInformation
190ee09 feat(detector-window): window title watcher for Teams/Zoom/Webex/Meet meetings
c7e00f9 feat(deps): add windows crate for window enumeration and audio session APIs
```

## What got built

1. **Window title watcher** (`detector/window_title.rs`).
   `EnumWindows` every 2s, predicate-matches titles against patterns for
   Teams desktop meeting/call, Zoom Meeting, Zoom Webinar, WebEx,
   GoToMeeting, plus browser tabs (Google Meet, teams.microsoft.com,
   zoom.us/wc/, zoom.us/j/). Privacy: full window titles only log at
   TRACE; INFO sees pattern labels only.

2. **Audio session watcher** (`detector/audio_session.rs`).
   `IAudioMeterInformation::GetPeakValue` on the default render endpoint
   every 1s. Emits `SignalDetected(AudioActivity)` after 15s of sustained
   amplitude > 0.02 (~ -34 dBFS), `SignalLost` after 30s of silence below
   threshold. Runs on a dedicated `std::thread` to keep COM apartment-bound
   (see NEATO_NOTES).

3. **Multi-source state machine** (`state_machine.rs`).
   Tracks active sources in a `HashSet<DetectionSource>`. Confidence:
   None (no sources) / Low (one source) / Medium (two from
   process+window or process+audio) / High (window+audio, with or
   without process). Idle promotes only on Medium or High. Potential
   debounce is 5s for High, 12s for Medium. Confidence drops to Low/None
   in Recording arm the existing 60s grace timer.

4. **Auto-detect persistence handoff** (`lib.rs` + `app/page.tsx`).
   Action handler emits `auto-recording-started` and
   `auto-recording-saving` Tauri events for non-Manual sessions. Frontend
   listens, sets meeting title, accumulates transcripts via the existing
   `transcript-update` listener, and POSTs `/save-transcript` with
   detection_source + detection_confidence at the Finalizing transition.
   Manual sessions skip both events on the Rust side — no double-save.

5. **`detection_confidence` column** (`backend/app/db.py`).
   Idempotent migration adds the column with default `'manual'`. Existing
   rows backfill to `'manual'`. `save_meeting()` accepts both
   detection fields, `/save-transcript` request schema extended.

6. **State badge layout hardening** (`app/page.tsx`).
   `flex-shrink-0` + `whitespace-nowrap` on the badge, `min-w-0 flex-1` on
   the EditableTitle wrapper so a long auto-recorded title can't push the
   badge offscreen. `data-testid` added for future automated checks.

7. **Settings UI explanation** (`app/settings/page.tsx`).
   Info panel explaining the three-signal detection model. Google Meet
   added to the supported-apps list (now covered by window-title).

## Verification status

| Check | Result |
|---|---|
| `cargo check` (frontend/src-tauri) | ✅ Clean — same 21 pre-existing warnings as Phase 2a, no new ones |
| Backend DB migration on Phase 2a-era schema | ✅ Tested via synthetic Phase 2a-shipped DB; column added, existing rows backfill to 'manual', new auto inserts persist real values, manual inserts default to 'manual' |
| Window enumeration runs without panic | ⚠️ Only static analysis — runtime not exercised in agent context |
| Audio meter thread initializes COM correctly | ⚠️ Only static analysis — runtime not exercised in agent context |
| Frontend TypeScript type-check | ⚠️ Skipped — `frontend/node_modules` not installed (carryover from Phase 2a runs) |
| Process-only stays Idle (Teams chat with no call) | ⚠️ Logic walkthrough only — needs runtime confirmation |
| Process + window + audio promotes to Recording | ⚠️ Logic walkthrough only — needs runtime confirmation |
| Manual record button still works | ⚠️ Logic walkthrough only — code path unchanged |
| Auto-record OFF: no detection fires | ✅ Wiring preserves Phase 2a `auto_record_enabled` gate in FSM |
| Real transcript persists to DB from auto-detect path | ⚠️ **Architectural fix landed; requires real-meeting smoke test before tag push** |

The "real transcript in DB" verification is the core success metric and is
not reachable from the agent context. It needs Mark to:

1. `pnpm install && pnpm tauri dev` from `frontend/`.
2. Confirm all three watchers log startup messages within seconds.
3. Open Teams (or Zoom, or Google Meet) for chat only — confirm state
   stays Idle and no auto-record toast fires.
4. Join a real meeting (1:1 with a phone or another machine works).
   Within ~5–12s the badge should go Idle → Detecting… → Recording, the
   tray icon should turn red, and a toast should fire.
5. Speak for 30s ("Phase 2b verification, real audio test, one two
   three four five").
6. End the meeting. Within ~90s (60s grace + 30s drain) the badge should
   go Recording → Finalizing → Idle.
7. `python -c "import sqlite3; c=sqlite3.connect('backend/meeting_minutes.db').cursor(); c.execute('SELECT id,title,detection_source,detection_confidence FROM meetings ORDER BY created_at DESC LIMIT 1'); print(c.fetchone())"` should return a non-`'manual'` row.
8. `c.execute('SELECT transcript FROM transcripts WHERE meeting_id=?', (...))` should return rows with the spoken text.

## Known issues

- 21 pre-existing Rust warnings carry over from Phase 1/2a (`unused
  imports`, mutable-static refs, Rust 2024 forward-compat). All explicitly
  out of scope per the Phase 2b constraints.
- The cpal "Failed to send audio data: channel closed" warnings observed
  in Phase 2a's auto-detect repro are pre-existing benign noise from cpal
  callbacks firing in the brief window between stream start and first
  subscribe — not the bug, and they fire in manual recording too.
- Pre-roll capture still missing (carryover; requires Phase 2.5
  audio-pipeline refactor).
- On-disk WAV persistence still commented out in `stop_recording`
  (carryover; will be addressed alongside the rolling-buffer wiring in
  Phase 2.5/3).

## Deferred items

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
| Per-app icons in the Settings supported-apps list | Phase 2b polish |

## Open questions for the human

1. **Real-meeting smoke test.** This is the gating verification before
   pushing `phase-2b-complete`. The architectural fix is in place and
   `cargo check` is clean, but only a real meeting will confirm:
   (a) the auto-detect path produces a row in `meetings` with non-manual
   detection_source/confidence, and (b) the row's transcripts contain the
   actually-spoken text. See "Verification status" above for the script.

2. **Process-only behavior is now intentionally Idle.** A user who keeps
   Teams running 24/7 for chat but never joins meetings will see the
   process layer fire (Low confidence) and the FSM will stay in Idle.
   This is the correct and desired behavior — Phase 2a's
   "Teams launches → auto-record" was a false-positive trigger. If you
   want to validate this empirically, leave Teams open in chat-only mode
   for 5+ minutes and confirm no toast fires and the badge stays "Ready".

3. **Audio threshold tuning.** I picked 0.02 amplitude (~ -34 dBFS) and
   15s active / 30s inactive windows based on first-principles reasoning
   (notification chimes are brief, normal speech is well above -34 dBFS).
   Real-world tuning may be needed if (a) very quiet meetings get missed
   or (b) ambient computer noise (cooling fans on the audio output? media
   notifications?) trips false positives. Both are easy `const` tweaks in
   `detector/audio_session.rs`.

4. **Window title patterns.** The current set covers the major desktop
   apps and the most common browser tab patterns I'm confident about. If
   you find a meeting client whose window title matches none of the
   predicates, file the title (with sensitive parts redacted) and we can
   add it. Patterns are case-insensitive substring matches, so they're
   easy to extend.

5. **Browser background tabs are still invisible.** If you're in a Google
   Meet call but you've switched to another tab, the Meet tab title is no
   longer in any window's title — Chrome/Edge only expose the foreground
   tab. This is a Phase 2c problem (DevTools Protocol attach or UIA). For
   now: keep the Meet tab in the foreground or use the desktop app, or
   rely on the audio layer alone (Low confidence — won't auto-record).

## File map (Phase 2b additions)

```
frontend/src-tauri/src/
├── detector/
│   ├── mod.rs            (DetectionSource: + WindowTitle, + AudioActivity, + Hash derive)
│   ├── process.rs        (unchanged)
│   ├── window_title.rs   (NEW: EnumWindows + predicate matchers)
│   └── audio_session.rs  (NEW: IAudioMeterInformation + dedicated COM thread)
├── state_machine.rs      (multi-source HashSet + DetectionConfidence enum)
├── lib.rs                (orchestrator: 3 watchers; action handler emits lifecycle events)
└── Cargo.toml            (windows = 0.58 with Win32_Media_Audio + _Endpoints features)

frontend/src/app/page.tsx           (auto-recording-{started,saving} listeners + save flow)
frontend/src/app/settings/page.tsx  (detection-explanation info panel)

backend/app/db.py    (idempotent detection_confidence migration; save_meeting accepts source+confidence)
backend/app/main.py  (SaveTranscriptRequest extended with optional detection_{source,confidence})

NEATO_NOTES.md       (Phase 2b section + Resolved-in-Phase-2b table)
PHASE-2B-REPORT.md   (this file)
```
