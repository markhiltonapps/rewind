\# Neato Rewind — Inherited Meetily Bugs and Observations



\## Known issues from Phase 1 verification



\### Bug: Transcript listener cleanup crashes on stop (P2 — cosmetic, dev-mode only)

\- \*\*Location:\*\* `frontend/src/app/page.tsx` line 206

\- \*\*Symptom:\*\* `TypeError: Cannot read properties of undefined (reading 'unregisterListener')` shown as Next.js error overlay when user clicks stop

\- \*\*Status:\*\* Pre-existing in Meetily, not introduced by Phase 1

\- \*\*Impact:\*\* Recording and transcription work correctly. Error is in cleanup hook only. Probably hidden in production builds.

\- \*\*Fix:\*\* Add a try/catch around the `unlistenFn()` call, or check `typeof unlistenFn === 'function'` instead of just truthy. Address in Phase 2 alongside other concurrency cleanup.



\### Concern: Mutable static globals in audio capture (from Phase 1 final report)

\- \*\*Location:\*\* `frontend/src-tauri/src/lib.rs` and `audio/`

\- \*\*Symptom:\*\* 21 Rust warnings about shared references to mutable statics under Rust 2024 edition

\- \*\*Status:\*\* Will become tangled with Phase 2 rolling buffer work

\- \*\*Plan:\*\* Address as part of Phase 2 audio refactor



\### Hygiene items deferred from Phase 1

\- `metadata.ts` and `metadata.tsx` are duplicates — one is dead code, dedupe in cleanup pass

\- `electron/main.js` reference in `package.json` is stale (left over from pre-Tauri days)

\- `meeting\_minutes.db` line in `.gitignore` doesn't match actual filename `meetings.db`

\- Cargo dependencies (`cpal`, `ffmpeg-sidecar`) pinned to git branches not commits — risk of silent breakage on `cargo update`

\- `backend/whisper-custom/server/httplib.h` vendored cpp-httplib copy with no upgrade path

