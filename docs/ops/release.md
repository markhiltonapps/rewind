# Releasing Neato Rewind

How a build reaches users. Complements `cloud-mode-build.md`, which
covers the build itself and stops at the artifact — this doc covers
everything after that.

## TL;DR

```powershell
# 1. Bump the version in all three manifests (see "Version bump" below)
# 2. Then:
pwsh scripts/release.ps1 -Version 0.1.1 -Notes "What changed"
```

Add `-DryRun` first if you want to see what it would do without
uploading or publishing anything.

## How users actually get the app

```
neato-rewind-web.vercel.app
      │  user enters email
      ▼
  POST /api/signup ──► Supabase: invite cap (200) / waitlist
      │  status: 'ok'
      ▼
  returns DOWNLOAD_WINDOWS_URL  (Vercel production env var)
      │
      ▼
  https://storage.googleapis.com/neato-rewind-downloads/
        NeatoRewind-Setup-latest-x64.exe
```

The download is **email-gated** — there is no public static download
link, and no `/download` page. The URL is a server-side secret returned
only on a successful signup (`web/src/lib/signup.ts`, surfaced by
`web/src/components/SignupForm.tsx`).

Hosting is **Google Cloud Storage**, not Supabase: Supabase Storage's
free tier caps files at 50 MB and the installer is ~60 MB. The bucket
`gs://neato-rewind-downloads` is public (`allUsers` → `objectViewer`).

## The stable-URL contract

`DOWNLOAD_WINDOWS_URL` points at a **fixed** object name:

    NeatoRewind-Setup-latest-x64.exe

`release.ps1` overwrites that object on every release, with:

* `Cache-Control: no-cache, max-age=0` — so a new build is served
  immediately rather than sitting behind a CDN or browser cache.
* `Content-Disposition: attachment; filename="NeatoRewind-Setup-<ver>-x64.exe"`
  — so the user still saves a version-stamped file and can tell builds
  apart, even though the URL never changes.

A second, immutable copy is uploaded under the versioned name for
archival, cached forever.

**Do not go back to fresh-name-per-build.** Builds 7–12 each got a new
object name plus a hand-edited Vercel env var. One missed edit meant the
site kept serving a stale installer — which is exactly what happened:
the live URL served a **Jul 23** build well after newer ones existed.
The stable name removes the manual step, and with it that failure mode.

Because the name is fixed, **you should not need to touch Vercel again**.
If you ever do:

```powershell
cd web
vercel env rm DOWNLOAD_WINDOWS_URL production
vercel env add DOWNLOAD_WINDOWS_URL production
```

Beware: values added through the dashboard have picked up a UTF-8 BOM
and a trailing CRLF before now. `env()` in `web/src/lib/supabaseAdmin.ts`
calls `.trim()` specifically to survive that, but it's better not to
introduce it — paste the bare URL with no trailing newline.

## Version bump

Three files must agree, or `release.ps1` refuses to run:

| File | Line |
|---|---|
| `frontend/src-tauri/tauri.conf.json` | `"version"` |
| `frontend/package.json` | `"version"` |
| `frontend/src-tauri/Cargo.toml` | `version` under `[package]` |

Versions sat at `0.1.0` across all twelve early builds. That was
survivable only because there is no auto-updater; if one is ever added
it compares against `tauri.conf.json`, so an unbumped version means the
update is never offered.

### Tag naming

Use `v<semver>` — `v0.1.1`. Note the repo carries inherited **Meetily
upstream** tags including `v0.2.0` and `v0.3.0`, which sort *above* our
real releases. Don't let semver tooling pick "the highest tag"; it will
pick an upstream one. The Neato lineage starts at `v0.1.0` (2026-07-30).

## What release.ps1 does

1. **Version check** — all three manifests agree with `-Version`.
2. **Cloud-mode preconditions** — `.env.production` sets
   `NEXT_PUBLIC_AI_MODE=cloud`, and `BUNDLED_GEMINI_KEY` in
   `backend/app/keys.py` is empty.
3. **Build** — `python build_sidecar.py`, then `npm run tauri build`.
   The sidecar step is not optional: **the Tauri build does not rebuild
   the Python backend.** It only copies whatever exe is staged in
   `frontend/src-tauri/bin/`. Skipping it ships stale backend code —
   this happened, and a whole feature (`/identify-speakers`) shipped
   dead because the bundled sidecar was a month old.
4. **Security gate** — greps every artifact for `AIza`. A bundled Gemini
   key would otherwise ship to every user. Runs *after* the build so it
   inspects what actually ships.
5. **Upload** — versioned (immutable) + stable (no-cache) objects.
6. **Verify** — HEADs the live URL and compares `Content-Length` against
   the local file, so a silently failed upload can't pass as success.
7. **GitHub release** — creates `v<version>` with both installers, or
   uploads with `--clobber` if the tag already has a release.

## Manual fallback

If the script is unavailable:

```powershell
# build
cd backend;  python build_sidecar.py
cd ../frontend; npm run tauri build

# security gate — must print nothing
Get-ChildItem src-tauri/target/release/bundle -Recurse -File |
  Select-String "AIza" -List

# upload (stable object is what the website serves)
gcloud storage cp "src-tauri/target/release/bundle/nsis/Neato Rewind_0.1.1_x64-setup.exe" `
  gs://neato-rewind-downloads/NeatoRewind-Setup-latest-x64.exe `
  --cache-control="no-cache, max-age=0" `
  --content-disposition='attachment; filename="NeatoRewind-Setup-0.1.1-x64.exe"'

# verify
curl -sI https://storage.googleapis.com/neato-rewind-downloads/NeatoRewind-Setup-latest-x64.exe
```

## Not yet done

* **Code signing.** Binaries are unsigned, so Windows SmartScreen warns
  on first run. `SignupForm.tsx` ships an explainer card for this. An
  Authenticode certificate would remove it.
* **Auto-update.** No `tauri-plugin-updater`, no signing keypair, no
  update manifest. Users update by re-downloading. The NSIS PREINSTALL
  hook (`frontend/src-tauri/installer-hooks.nsh`) kills the running app
  and sidecar so install-over-running works without a manual quit.
* **macOS.** `MacNotifyButton` collects interest into a waitlist table;
  no mac build exists.
