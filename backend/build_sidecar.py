"""Build the backend sidecar EXE and stage it for Tauri.

Usage:
    cd backend
    python build_sidecar.py

What it does:
    1. Runs PyInstaller against neato-rewind-backend.spec.
    2. Determines the host's Rust target-triple (Tauri's required
       sidecar naming convention is `<name>-<triple>.exe`).
    3. Copies dist/neato-rewind-backend.exe to
       frontend/src-tauri/bin/neato-rewind-backend-<triple>.exe.
    4. Reports total size and where the file landed.

Pre-reqs:
    pip install pyinstaller

The Tauri build (`pnpm tauri build`) will pick up that staged binary
via the `bundle.externalBin` config in tauri.conf.json. Without this
script's output, the Tauri MSI build fails with a "sidecar not found"
error.

Run this every time you change backend code before rebuilding the
MSI. The Tauri build does NOT auto-rebuild the Python side.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path


BACKEND_ROOT = Path(__file__).resolve().parent
SPEC_FILE = BACKEND_ROOT / "neato-rewind-backend.spec"
DIST = BACKEND_ROOT / "dist"
BUILD = BACKEND_ROOT / "build"

FRONTEND_BIN = (
    BACKEND_ROOT.parent / "frontend" / "src-tauri" / "bin"
)


def detect_target_triple() -> str:
    """Return the Rust target-triple of the current host.

    Tauri's sidecar lookup uses `rustc -Vv` to get this; we mirror it
    so the staged binary name matches what Tauri expects to find.
    """
    try:
        result = subprocess.run(
            ["rustc", "-Vv"],
            capture_output=True,
            text=True,
            check=True,
        )
        for line in result.stdout.splitlines():
            if line.startswith("host:"):
                return line.split(":", 1)[1].strip()
    except FileNotFoundError:
        pass
    except subprocess.CalledProcessError:
        pass
    # Sensible default for the only platform we ship today.
    print(
        "[warn] couldn't determine target via rustc, defaulting to "
        "x86_64-pc-windows-msvc",
        file=sys.stderr,
    )
    return "x86_64-pc-windows-msvc"


def run_pyinstaller() -> Path:
    """Invoke PyInstaller; return the path to the produced exe."""
    print(f"[build] running pyinstaller against {SPEC_FILE.name}")
    cmd = [
        sys.executable,
        "-m",
        "PyInstaller",
        str(SPEC_FILE),
        "--clean",
        "--noconfirm",
    ]
    subprocess.run(cmd, check=True, cwd=str(BACKEND_ROOT))
    exe = DIST / "neato-rewind-backend.exe"
    if not exe.exists():
        raise SystemExit(f"[fail] expected {exe} but it wasn't produced")
    return exe


def stage_for_tauri(src_exe: Path, triple: str) -> Path:
    """Copy + rename to frontend/src-tauri/bin/."""
    FRONTEND_BIN.mkdir(parents=True, exist_ok=True)
    dst = FRONTEND_BIN / f"neato-rewind-backend-{triple}.exe"
    shutil.copy2(src_exe, dst)
    return dst


def main() -> None:
    print(f"[build] backend root: {BACKEND_ROOT}")
    print(f"[build] frontend bin:  {FRONTEND_BIN}")

    triple = detect_target_triple()
    print(f"[build] target triple: {triple}")

    exe = run_pyinstaller()
    size_mb = exe.stat().st_size / (1024 * 1024)
    print(f"[build] produced {exe.name} ({size_mb:.1f} MB)")

    dst = stage_for_tauri(exe, triple)
    print(f"[build] staged at {dst}")
    print()
    print("Next: `pnpm tauri build` from the frontend directory.")


if __name__ == "__main__":
    try:
        main()
    except subprocess.CalledProcessError as exc:
        print(f"[fail] subprocess returned {exc.returncode}", file=sys.stderr)
        sys.exit(exc.returncode)
