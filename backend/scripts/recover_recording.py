"""Phase 5 Task 1: recover a meeting from a recovery WAV.

The Rust frontend writes the captured audio to
%APPDATA%\\NeatoRewind\\recovery\\recording-{timestamp}.wav before
attempting any backend POST. If the backend is unreachable or returns
an error, the WAV stays on disk and the frontend surfaces a sticky
toast pointing the user at this script.

Usage:

    python recover_recording.py <path-to-recovery-wav>

Example:

    python recover_recording.py "C:\\Users\\markh\\AppData\\Roaming\\NeatoRewind\\recovery\\recording-20260506T201500.wav"

Behavior:
  - POSTs the WAV to /transcribe-audio (uses the same Gemini path as
    a normal recording, with the new auto-retry on 503)
  - POSTs the resulting transcript to /save-transcript so the meeting
    appears in the sidebar
  - On full success, deletes the recovery WAV
  - On failure, leaves the WAV in place and prints a clear message —
    the user can re-run after fixing whatever broke

Backend URL is read from $REWIND_BACKEND (default
http://127.0.0.1:5167). Adjust by setting the env var.
"""

from __future__ import annotations

import os
import sys
import time
from pathlib import Path

import requests

BACKEND_URL = os.environ.get("REWIND_BACKEND", "http://127.0.0.1:5167")


def _ts_id() -> str:
    """Match the existing meeting-id convention (Date.now()-style ms)."""
    return f"meeting-{int(time.time() * 1000)}"


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__)
        return 1

    wav_path = Path(sys.argv[1])
    if not wav_path.exists():
        print(f"File not found: {wav_path}", file=sys.stderr)
        return 1
    if wav_path.stat().st_size == 0:
        print(f"Recovery file is empty: {wav_path}", file=sys.stderr)
        return 1

    meeting_id = _ts_id()
    title = f"Recovered: {wav_path.stem}"

    # Step 1: transcribe via the existing /transcribe-audio endpoint.
    # 20-minute timeout — Gemini Files-API + transcription on a long
    # meeting (60+ min) can take several minutes, and retries on 503
    # add up to another ~16s. The Rust client uses 600s; matching
    # 1200s here gives the script plenty of headroom for long
    # recoveries that the live recording path wouldn't normally need.
    print(f"Transcribing {wav_path.name} via {BACKEND_URL}/transcribe-audio …")
    with wav_path.open("rb") as f:
        files = {"file": (wav_path.name, f, "audio/wav")}
        try:
            tx_resp = requests.post(
                f"{BACKEND_URL}/transcribe-audio",
                files=files,
                timeout=1200,
            )
        except requests.RequestException as e:
            print(f"Transcription request failed: {e}", file=sys.stderr)
            print(
                "Backend may not be running. Start it with "
                "`backend\\start_with_output.ps1` and re-run this script.",
                file=sys.stderr,
            )
            return 1

    if not tx_resp.ok:
        print(
            f"/transcribe-audio returned HTTP {tx_resp.status_code}: "
            f"{tx_resp.text[:300]}",
            file=sys.stderr,
        )
        return 1
    transcript = (tx_resp.json().get("transcript") or "").strip()
    if not transcript:
        print(
            "Transcription returned an empty string. The recording may "
            "be silent or non-speech. The recovery file is preserved.",
            file=sys.stderr,
        )
        return 1
    print(f"Got transcript ({len(transcript)} chars)")

    # Step 2: save as a meeting via the existing /save-transcript
    # endpoint. Payload shape matches SaveTranscriptRequest /
    # Transcript in main.py — id, text, timestamp on each segment.
    print(f"Saving as meeting {meeting_id} …")
    save_payload = {
        "meeting_id": meeting_id,
        "meeting_title": title,
        "transcripts": [
            {
                "id": f"{int(time.time() * 1000)}-0",
                "text": transcript,
                "timestamp": "00:00",
            }
        ],
        "detection_source": "manual",
        "detection_confidence": "manual",
    }
    try:
        save_resp = requests.post(
            f"{BACKEND_URL}/save-transcript",
            json=save_payload,
            timeout=30,
        )
    except requests.RequestException as e:
        print(f"/save-transcript request failed: {e}", file=sys.stderr)
        return 1
    if not save_resp.ok:
        print(
            f"/save-transcript returned HTTP {save_resp.status_code}: "
            f"{save_resp.text[:300]}",
            file=sys.stderr,
        )
        return 1

    # Backend may have re-keyed the meeting id; surface whatever it returned.
    server_id = save_resp.json().get("meeting_id", meeting_id)
    print(f"Saved as: {title}  (id: {server_id})")
    print("Open Rewind to view it. Click Generate Note to summarise.")

    # Step 3: only on full end-to-end success, remove the recovery file.
    try:
        wav_path.unlink()
        print(f"Removed recovery file: {wav_path}")
    except OSError as e:
        print(
            f"Note: could not delete recovery file ({e}). You can "
            "delete it manually now that the meeting has been saved.",
            file=sys.stderr,
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
