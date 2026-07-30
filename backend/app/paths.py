"""User-data path resolution.

Returns the directory where mutable runtime state (SQLite DB, optional
.env override, future cache files) should live.

## Behavior

- **Dev / source-run**: returns the current working directory. This
  preserves today's workflow where `cd backend && python -m uvicorn
  app.main:app` creates `meeting_minutes.db` in `backend/`.
- **Frozen sidecar (PyInstaller-bundled inside the Tauri MSI)**:
  returns `%APPDATA%/com.neatoventures.rewind/` on Windows. The MSI
  installs to `Program Files`, which is read-only for normal users —
  writing the DB there would fail at startup.

The selector is `getattr(sys, "frozen", False)`, which PyInstaller
sets to True on its bundled exe and is unset everywhere else. There
is no flag for the calling code to override; the goal is "DB ends up
in the right place no matter how the backend is launched."

## Why the same identifier as Tauri

`com.neatoventures.rewind` matches `identifier` in
`frontend/src-tauri/tauri.conf.json`. Sharing it puts the backend's
state in the same AppData subdir as Tauri's existing recovery WAVs
(see frontend/src-tauri/src/lib.rs recovery handling). One folder per
app is the standard Windows expectation; users who later want to
"reset everything" can delete one directory.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

APP_IDENTIFIER = "com.neatoventures.rewind"


def is_frozen() -> bool:
    """True when running inside a PyInstaller-built executable."""
    return bool(getattr(sys, "frozen", False))


def user_data_dir() -> Path:
    """Return the per-user mutable-state directory.

    When frozen: `%APPDATA%/com.neatoventures.rewind/` (Windows) or
    `~/.local/share/com.neatoventures.rewind/` (Linux fallback,
    in case we ever ship non-Windows builds).

    When not frozen (dev): the current working directory. This is the
    historical behavior; everything that creates `meeting_minutes.db`
    keeps creating it where it always did.
    """
    if not is_frozen():
        return Path.cwd()

    if sys.platform == "win32":
        base = os.environ.get("APPDATA")
        if base:
            return Path(base) / APP_IDENTIFIER
        # Fallback if APPDATA isn't set (unusual but possible in
        # constrained environments). Use the user profile root.
        return Path.home() / "AppData" / "Roaming" / APP_IDENTIFIER

    # Non-Windows fallback (not exercised today but doesn't hurt).
    xdg = os.environ.get("XDG_DATA_HOME")
    if xdg:
        return Path(xdg) / APP_IDENTIFIER
    return Path.home() / ".local" / "share" / APP_IDENTIFIER


def ensure_user_data_dir() -> Path:
    """Same as `user_data_dir` but mkdir -p the directory first.
    Call once at backend startup to guarantee everything that follows
    can write."""
    d = user_data_dir()
    d.mkdir(parents=True, exist_ok=True)
    return d


def db_path() -> str:
    """Default SQLite path. Always inside `user_data_dir()`."""
    return str(ensure_user_data_dir() / "meeting_minutes.db")


def dotenv_path() -> Path:
    """Optional .env override for frozen installs. Lets the user (or
    Mark) drop a `.env` next to the AppData DB to override the bundled
    Gemini key without rebuilding. In dev mode points at the usual
    `backend/.env`."""
    return ensure_user_data_dir() / ".env"
