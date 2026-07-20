# Building the cloud-mode Windows installer

The distributed installer must (a) route all AI through the Cloud Run proxy
and (b) contain **no** Gemini key.

Three settings make a build "cloud mode":

| Setting | Where it lives | How it's set for the shipped app |
|---|---|---|
| `NEXT_PUBLIC_AI_MODE=cloud` | compiled into the Next.js bundle | env var present during `pnpm build` (frontend) |
| `REWIND_AI_MODE=cloud` + `REWIND_PROXY_URL` | Python backend runtime env | **set by the Rust sidecar spawn** in `frontend/src-tauri/src/lib.rs` (release-only) — durable on every user's machine |
| empty `BUNDLED_GEMINI_KEY` | `backend/app/keys.py` (gitignored) | blanked before building the sidecar |

> **Why the Rust env injection?** PyInstaller does **not** bake build-shell env
> vars into the frozen exe, and the sidecar inherits none on a fresh install.
> Setting `.env("REWIND_AI_MODE","cloud")` / `.env("REWIND_PROXY_URL",…)` on the
> `sidecar` command is the durable mechanism. Setting them only in the build
> shell would silently produce a *local-mode* app.

## Build steps

1. **Blank the bundled key** — in `backend/app/keys.py` set:
   ```python
   BUNDLED_GEMINI_KEY = ""
   ```
   (`keys.py` is gitignored, so this never enters git.)

2. **Rebuild the backend sidecar** (picks up the blanked key). From `backend/`:
   ```powershell
   python build_sidecar.py
   ```
   Produces `frontend/src-tauri/bin/neato-rewind-backend-<triple>.exe`.

3. **Build the installer** with the frontend cloud flag. From `frontend/`:
   ```powershell
   $env:NEXT_PUBLIC_AI_MODE = "cloud"
   pnpm tauri build
   ```
   Artifact: `frontend/src-tauri/target/release/bundle/nsis/Neato Rewind_0.1.0_x64-setup.exe`.

4. **Verify no key shipped.** Gemini keys start with `AIza`:
   ```bash
   grep -rc "AIza" "frontend/src-tauri/target/release/" | grep -v ":0$" || echo "NO KEY FOUND (good)"
   ```
   Expect `NO KEY FOUND (good)`. Any hit → the sidecar wasn't rebuilt with the
   blanked key; fix and rebuild.

## Key rotation (do soon)

`backend/app/keys.py` currently holds a real Gemini key locally (gitignored —
never committed). Rotate it in Google AI Studio and keep the new key ONLY in the
Cloud Run proxy secret (`GEMINI_API_KEY`), never in the repo or an installer.
