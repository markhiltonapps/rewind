# Phase 2b Final Report

**Branch:** `phase-2b-detection`
**Base:** `phase-2a-complete` (91713b7)
**Tag:** `phase-2b-complete` (re-tagged at HEAD after Round 2 fixes)
**Date:** 2026-04-30 (Round 1) — 2026-04-30 Round 2

## Round 2 update (after runtime verification)

Mark's runtime verification of Round 1 confirmed the architectural fix
for the auto-detect handoff (Google Meet test produced
`meeting-1777575921333` with `detection_source='Google Meet'`,
`detection_confidence='medium'`, and 4 real transcript rows). It also
surfaced two smaller-scoped bugs:

* **Audio loss on Finalizing (every recording, manual + auto):** the
  last 10–20s of audio (whatever was in the partially-filled 10s
  whisper chunk when `is_running` flipped false) was discarded.
* **detection_source/confidence stamped 'manual' on consecutive
  auto-sessions:** session 1 saved correctly; session 2 (triggered by
  audio + Teams ~24s later) saved as 'manual'/'manual' even though the
  FSM logged `StartRecording { source: Process("ms-teams.exe"),
  confidence: Medium }`.

Both fixed in Round 2 commits `9bcbd00` and `c802ef7`. Section "Round 2
fixes" below has the details.

## Round 4 update (Rust-authoritative persistence)

After Round 3 the Rust pipeline was confirmed solid end-to-end on a
live Google Meet test. The frontend lifecycle was the remaining
weakness — three bugs of the same class:

1. UI didn't reflect recording state when auto-detect started, so
   Mark refreshed the page during a live session.
2. The refresh wiped the React-held transcript buffer +
   `autoSessionRef`. When `recording-saving` fired 3 minutes later, the
   listener had nothing to POST and the meeting was lost.
3. Manual Stop button on an auto-detected session bypassed the
   listener-driven save flow.

Rather than patch each bug, Round 4 makes Rust authoritative for
**persistence itself**:

  * **`RecordingSession` struct** in `lib.rs` holds the meeting_id
    (generated at StartRecording with `chrono::Utc::now().timestamp_millis()`),
    title, detection_source, detection_confidence, is_manual,
    started_at, and the live transcript buffer. Wrapped in a
    Tauri-managed `SessionState` slot.
  * **`record_and_emit_transcript()`** is the single point of
    transcript delivery. Every emit site (timeout, in-loop chunk send,
    post-loop flush, post-loop accumulator drain) routes through it.
    It pushes into the session buffer AND emits the
    `transcript-update` event.
  * **`save_session_to_backend()`** uses `reqwest` to POST
    `/save-transcript` directly to `127.0.0.1:5167` after
    stop_recording's flush completes. On 2xx it emits a new
    `meeting-saved` event with the meeting_id; on failure it emits
    `meeting-save-failed`. No retry — explicit per the prompt.
  * **`get_recording_state` Tauri command** returns FSM state plus
    session metadata for UI mount-time reconciliation.

Frontend changes:
  * Removed: `/save-transcript` fetch, `recording-saving` listener,
    `autoSessionRef`, `transcriptsRef`, `meetingTitleRef`, click-time
    POST in `handleRecordingStop2`.
  * Added: `meeting-saved` listener (navigates on manual,
    bookkeeping-only on auto), `meeting-save-failed` listener, mount-
    time `get_recording_state` invoke that re-renders the recording
    indicator after a refresh.

After this round the frontend has zero `/save-transcript` POST code.
The only path from "recording started" to "DB row" runs through Rust.

### Commits

```
4047a82 fix(frontend): replace recording-saving POST with meeting-saved listener + mount reconcile
6d91adc fix(persistence): move /save-transcript POST from frontend to Rust
```

### Verification status

| Test | Result |
|---|---|
| `cargo check` (frontend/src-tauri) | ✅ Clean — same 21 pre-existing warnings, no new ones |
| Test 1: pure auto-detect happy path | ⚠️ **Architectural fix landed; needs Mark's runtime smoke test** |
| Test 2: refresh during recording is harmless | ⚠️ **Needs Mark's runtime smoke test** |
| Test 3: manual Stop on auto-detected session | ⚠️ **Needs Mark's runtime smoke test** |
| Test 4: regression — manual via Start button | ⚠️ **Needs Mark's runtime smoke test** |
| Test 5: UI reflects recording state immediately on auto-detect | ⚠️ **Needs Mark's runtime smoke test** |

The 5 acceptance tests all require live Meet/Chrome interaction and
DB queries which aren't reachable from the agent context. The
architectural change is in place and `cargo check` is clean. Mark to
run the tests against the dev build.

### Trade-offs / known issues

- The session is held in memory only. If the process crashes mid-
  recording, the transcript buffer is lost. Same exposure as before
  Round 4 (the React state was also memory-only); not a regression.
- No retry on POST failure. If the backend is down at finalize time,
  the recording is gone. Was the case in Round 1–3 too. Phase 3 is
  the right venue for retry policy.
- The frontend's mount-time `get_recording_state` reconcile sets
  `meetingTitle` to the Rust-canonical title, but doesn't try to
  recover the live transcript array — only the recording indicator
  shows. The transcript-update listener will populate transcripts
  going forward; the pre-refresh transcripts remain in the Rust
  session buffer and land in the saved row when the FSM reaches
  Idle. So the user sees fewer transcripts on screen than the saved
  row contains, but no data is lost.

## Round 3 update (after Round 2 verification)

Round 2's runtime test surfaced that the window-title detector's Google
Meet predicate doesn't match Chrome's actual title format. The
Round 1/2 predicate required either `meet.google.com` or the literal
substring "Google Meet" in the title — but Chrome's real-world Meet
title is just:

    "Meet - unk-bbpv-tsj - Google Chrome"

(no URL, just "Meet" not "Google Meet"). Result: no
`SignalDetected(WindowTitle("Google Meet"))` event, FSM stays Idle for
Meet calls.

Fixed in commit `4d07de8` by adding a third predicate branch that
matches `"meet - "` at the start of the trimmed/lowercased title plus a
known browser name. Trade-off documented inline: a Google Doc titled
"Meet - Foo" opened in Chrome would also match. Accepted as the cost
of detecting real Meet calls.

Teams and Zoom predicates were re-verified against the user's listed
variations ("Meeting now | Microsoft Teams", "Call with X | Microsoft
Teams", "&lt;organizer&gt;'s meeting | Microsoft Teams", etc.) and all
already match via the existing substring rules. No changes needed for
Teams or Zoom.

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

Round 3:
```
4d07de8 fix(detector-window): match real-world Chrome/Edge title formats for Google Meet
```

Round 2:
```
c802ef7 fix(handoff): clear detection metadata on session boundary so consecutive auto-sessions persist correct source
9bcbd00 fix(audio): flush partial chunk to whisper before stream teardown
```

Round 1:
```
b5006f2 docs: phase 2b final report
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

## Round 2 fixes

### Bug 1: partial-chunk flush (commit `9bcbd00`)

The transcription task's per-loop chunking only sent samples to
whisper-server when the buffer hit `chunk_samples` (≈10s of audio at
the mic sample rate) OR after `CHUNK_DURATION_MS` elapsed with at
least `min_samples`. When `is_running` flipped false, whatever was in
the partially-filled buffer (0–9.99s) was discarded.

The fix has three parts:

1. **Post-loop flush in the transcription task.** After the loop
   exits, if `current_chunk` is non-empty, send it to whisper-server.
   If shorter than 2s at the mic sample rate, pad with f32 zeros to
   reach the threshold (whisper has a ~2s effective minimum). Resample
   to 16kHz if needed and send via the same `send_audio_chunk`
   function the per-loop chunking uses. New segments flow through the
   accumulator and emit `transcript-update` events to the frontend.

2. **`FlushSignal` synchronization** (new Tauri-managed state). Each
   `start_recording` installs a fresh `Arc<tokio::sync::Notify>` in the
   slot and gives a clone to the spawned task. The task calls
   `notify_one()` after the flush is delivered (or its network call
   errors). `stop_recording` reads the slot and awaits `notified()`
   with a 10-second timeout fallback before tearing down streams, so
   the in-flight whisper request is guaranteed to complete (or fail
   loudly) before the cpal teardown.

3. **Action handler restructured.** The Round 1 `auto-recording-saving`
   event fired from `EnterFinalizing` (start of drain). Round 2
   replaces it with a unified `recording-saving` event fired from
   `StopRecording` (after flush + stop_recording). Both manual and
   auto sessions go through this single path; the payload's
   `is_manual` field tells the frontend listener which save flow
   variant to run (manual navigates to /meeting-details, auto doesn't).
   `handleRecordingStop2` no longer POSTs at click time — it does only
   UI bookkeeping.

UX trade-off documented in NEATO_NOTES: clicking stop now waits ~30s
for the FSM's Finalizing drain before navigating to /meeting-details.
The "Finalizing..." badge provides feedback during the wait.

### Bug 2: session-boundary metadata reset (commit `c802ef7`)

Round 1's repro: session 1 (Google Meet) saved correctly. Session 2,
triggered ~24s later by audio + Teams, saved as
`detection_source='manual'`. Almost certainly because the user clicked
stop on session 2 and `handleRecordingStop2` POSTed without detection
metadata, defaulting to 'manual' on the backend — and the
`auto-recording-saving` listener also ran but the user only spotted
the wrong row.

The Round 2 unified-event refactor structurally eliminates this:
there is no longer a code path that POSTs without detection metadata,
because the click handler doesn't POST at all. The single
`recording-saving` event always carries authoritative
source/confidence from Rust's `current_source`/`current_confidence`,
which are set at `StartRecording` and cleared at the end of
`StopRecording`.

Defense-in-depth additions in commit `c802ef7`:

* Rust action handler: skip the `recording-saving` emit if
  `current_source` is None (would happen only if a duplicate
  StopRecording were ever queued — guard logs a warning and skips).
* Frontend page.tsx: reset `autoSessionRef.current = null` on every
  `recorder-state → Idle` transition.

## Round 3 fix

### Bug 3: Google Meet predicate misses real Chrome/Edge title format (commit `4d07de8`)

Round 2's runtime verification surfaced that the window-title
detector's Google Meet predicate never fires for Chrome-based Meet
calls. Real-world Chrome window title (captured live):

    "Meet - unk-bbpv-tsj - Google Chrome"

The Round 1/2 predicate required either `meet.google.com` (Chrome
strips it) or the literal substring "Google Meet" (Chrome shows just
"Meet"). Both checks failed → no SignalDetected event → FSM never
promoted from Idle for Meet calls.

The fix adds a third predicate branch that matches when the title
starts with `"meet - "` (after trim+lowercase) AND contains a known
browser name. Same branch covers the Edge variant
`"Meet - <id> - Microsoft Edge"`. URL-bearing and "Google Meet"
variants from earlier rounds remain matched.

Trade-off: a Google Doc titled "Meet - Foo" opened in Chrome would
also match this branch. False positive rate is accepted in exchange
for catching the real common case. Trade-off documented inline in
`detector/window_title.rs` and in NEATO_NOTES.

Teams and Zoom predicates were re-verified against the user's listed
real-world title variations:

| App | Variation | Status |
|---|---|---|
| Teams | `Meeting in <name> \| Microsoft Teams` | Already matched |
| Teams | `Call with <name> \| Microsoft Teams` | Already matched |
| Teams | `<organizer>'s meeting \| Microsoft Teams` | Already matched (substring) |
| Teams | `Meeting now \| Microsoft Teams` | Already matched (substring) |
| Zoom | `Zoom Meeting` | Already matched |
| Zoom | `Zoom Webinar` | Already matched |
| Zoom | `<id> - Zoom` (desktop app) | Not matched — left alone per scope |

Privacy guarantee preserved: full window titles still log only at
TRACE; INFO emits the matched pattern label only ("Google Meet").

## Round 1: what got built (preserved from original report)


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

### Round 2 verification (after Round 2 fixes)

| Check | Result |
|---|---|
| `cargo check` (frontend/src-tauri) | ✅ Clean — same 21 pre-existing warnings, no new ones |
| Two-session test (Google Meet + Teams/YouTube) — both rows have non-'manual' source/confidence | ⚠️ **Architectural fix landed; runtime two-session test belongs to Mark's verification pass** |
| 30s manual recording with distinctive last sentence — sentence appears in saved transcript | ⚠️ **Architectural fix landed; runtime smoke test belongs to Mark's verification pass** |
| Process-only stays Idle / multi-source promotes / manual still works / auto-off silent | ✅ Logic preserved from Round 1 — Round 2 changes only affect save timing and the partial-chunk flush |

### Round 1 verification (preserved from original report)

| Check | Result |
|---|---|
| `cargo check` (frontend/src-tauri) | ✅ Clean — same 21 pre-existing warnings as Phase 2a, no new ones |
| Backend DB migration on Phase 2a-era schema | ✅ Tested via synthetic Phase 2a-shipped DB; column added, existing rows backfill to 'manual', new auto inserts persist real values, manual inserts default to 'manual' |
| Window enumeration runs without panic | ✅ Confirmed at runtime (Round 1 verification) |
| Audio meter thread initializes COM correctly | ✅ Confirmed at runtime (Round 1 verification) |
| Frontend TypeScript type-check | ⚠️ Skipped — `frontend/node_modules` not installed in agent worktree |
| Process-only stays Idle (Teams chat with no call) | ✅ Confirmed at runtime (Round 1 verification) |
| Process + window + audio promotes to Recording | ✅ Confirmed at runtime via Google Meet test (`meeting-1777575921333`) |
| Manual record button still works | ✅ Confirmed at runtime (Round 1 verification) |
| Auto-record OFF: no detection fires | ✅ Wiring preserves Phase 2a `auto_record_enabled` gate in FSM |
| Real transcript persists to DB from auto-detect path | ✅ Confirmed at runtime — `detection_source='Google Meet'`, `detection_confidence='medium'`, 4 transcript rows |

### Round 2 verification script (for Mark)

After both Round 2 fixes land:

1. **30s manual recording with distinctive last sentence:**
   - Click record, speak for 30s ending with "this is the last sentence
     and it should be saved", click stop.
   - Wait for the badge to go Recording → Finalizing → Idle (~30s).
   - After Idle, navigation to /meeting-details should fire
     automatically.
   - Query the most recent meeting's transcripts. Confirm "this is the
     last sentence" appears in a transcript row.

2. **Two consecutive auto-detected sessions:**
   - Trigger session 1 via Google Meet (open meeting tab, speak for 20s,
     close meeting). Wait for Recording → Finalizing → Idle.
   - Trigger session 2 via Teams + YouTube (have Teams running, start a
     YouTube video so audio + process both fire). Speak something
     distinctive while session 2 records, then close.
   - Wait for session 2 Recording → Finalizing → Idle.
   - Query: `SELECT id, title, detection_source, detection_confidence
     FROM meetings ORDER BY created_at DESC LIMIT 5`
   - Both rows must have non-'manual' detection_source and
     detection_confidence matching what the FSM logged at
     StartRecording time. Neither should be stamped 'manual'/'manual'.

## Known issues

- 21 pre-existing Rust warnings carry over from Phase 1/2a (`unused
  imports`, mutable-static refs, Rust 2024 forward-compat). All explicitly
  out of scope per the Phase 2b constraints.
- The cpal "Failed to send audio data: channel closed" warnings observed
  in Phase 2a's auto-detect repro are pre-existing benign noise from cpal
  callbacks firing in the brief window between stream start and first
  subscribe — not the bug, and they fire in manual recording too.
- **Round 2 manual-stop UX:** clicking stop on a manual recording now
  waits ~30s for the FSM's Finalizing drain before navigating to
  /meeting-details (compared to Round 1's near-instant navigation). This
  is the intentional cost of moving the save POST out of the click
  handler so it can capture the late transcripts produced by the
  partial-chunk flush. The "Finalizing..." badge animates during the
  wait. The proper fix (incremental "append transcripts to existing
  meeting" via a partial-save endpoint) is Phase 3 polish.
- **Round 2 silence padding:** when the last partial chunk is shorter
  than 2s at the mic sample rate, we pad with f32 zeros so whisper
  still processes it. The result is that whisper sees an
  artificially-extended segment and may emit a brief silence tail
  marker. Acceptable for now; dynamic chunk sizes (Phase 3) are the
  proper fix.
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
