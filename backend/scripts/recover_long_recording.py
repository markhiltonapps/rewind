"""Recover a LONG recording by transcribing it directly against Gemini.

Why this exists
---------------
`recover_recording.py` POSTs the whole WAV to the local backend's
/transcribe-audio, which in cloud mode forwards to the Cloud Run proxy.
For a long meeting that round-trip exceeds the proxy's request timeout
and comes back as:

    HTTP 502: {"detail":"Proxy returned HTTP 504: upstream request timeout"}

Retrying doesn't help -- the recording is simply longer than one
request can survive. This script sidesteps the proxy: it splits the
audio locally, transcribes each piece in its own Gemini call, shifts
each piece's timestamps back into whole-recording time, and saves the
stitched transcript through the normal /save-transcript endpoint so
the meeting appears in the sidebar like any other.

Splitting is silence-aware. A fixed 20-minute cut lands mid-word about
as often as not; instead each boundary slides up to +/-45s to the
quietest point nearby, so cuts fall in natural pauses.

Usage
-----
    python scripts/recover_long_recording.py <path-to-wav> [--title "..."]
                                             [--chunk-min 18] [--dry-run]

Requires a Gemini key. Resolution order matches the app: GEMINI_API_KEY
env var, then settings.geminiApiKey in the app database, then the
bundled key. Pass --db to point at a specific database.
"""

from __future__ import annotations

import argparse
import asyncio
import io
import os
import re
import sqlite3
import sys
import time
import wave
from pathlib import Path

import requests

BACKEND_URL = os.environ.get("REWIND_BACKEND", "http://127.0.0.1:5167")

# Same prompt the app uses (main.py /transcribe-audio) so recovered
# transcripts render identically -- speaker turns, [MM:SS] prefixes.
PROMPT = (
    "Transcribe this meeting audio accurately and verbatim. "
    "If multiple speakers are present, label them as Speaker 1, "
    "Speaker 2, etc. Start each speaker turn on a new line in "
    "this exact format: '[MM:SS] Speaker N: <text>'. The "
    "timestamp is the time at which that speaker turn begins, "
    "measured from the start of the recording (00:00). For "
    "recordings longer than an hour use [HH:MM:SS] instead. "
    "Do NOT summarize or paraphrase. If the audio contains "
    "music, silence, or non-speech, indicate that briefly in "
    "brackets like [music] or [silence] (no timestamp prefix "
    "needed for those). Output ONLY the transcript text -- no "
    "preamble, no commentary."
)


def default_db_path() -> Path:
    appdata = os.environ.get("APPDATA")
    if appdata:
        return Path(appdata) / "com.neatoventures.rewind" / "meeting_minutes.db"
    return Path("meeting_minutes.db")


def resolve_key(db_path: Path) -> str | None:
    """Env -> app DB -> bundled, mirroring main.py's _get_gemini_api_key."""
    env_key = os.environ.get("GEMINI_API_KEY")
    if env_key:
        return env_key
    try:
        con = sqlite3.connect(str(db_path))
        row = con.execute(
            "SELECT geminiApiKey FROM settings WHERE id='1'"
        ).fetchone()
        con.close()
        if row and row[0]:
            return row[0]
    except Exception:
        pass
    try:
        sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "app"))
        from keys import BUNDLED_GEMINI_KEY  # type: ignore
        if BUNDLED_GEMINI_KEY:
            return BUNDLED_GEMINI_KEY
    except Exception:
        pass
    return None


def find_quiet_cut(frames: bytes, sampwidth: int, channels: int,
                   target_frame: int, search_frames: int,
                   total_frames: int) -> int:
    """Slide `target_frame` to the quietest nearby point.

    Scans +/-search_frames around the target in 100ms steps and returns
    the frame index whose short window has the lowest mean absolute
    amplitude. Falls back to the target if anything looks off.
    """
    if sampwidth != 2:
        return target_frame  # only 16-bit PCM is handled; caller checks
    try:
        import numpy as np
    except ImportError:
        return target_frame

    lo = max(0, target_frame - search_frames)
    hi = min(total_frames, target_frame + search_frames)
    if hi <= lo:
        return target_frame

    bpf = sampwidth * channels          # bytes per frame
    seg = np.frombuffer(frames[lo * bpf: hi * bpf], dtype=np.int16)
    if channels > 1:
        seg = seg.reshape(-1, channels).mean(axis=1)
    if seg.size == 0:
        return target_frame

    win = 1600                          # 100ms at 16kHz
    n_win = seg.size // win
    if n_win < 2:
        return target_frame
    energy = np.abs(seg[: n_win * win].reshape(n_win, win)).mean(axis=1)
    return lo + int(energy.argmin()) * win


def split_wav(path: Path, chunk_seconds: int, out_dir: Path) -> list[tuple[Path, float]]:
    """Split into chunks at quiet points. Returns [(chunk_path, offset_s)]."""
    w = wave.open(str(path), "rb")
    fr, ch, sw = w.getframerate(), w.getnchannels(), w.getsampwidth()
    total = w.getnframes()
    frames = w.readframes(total)
    w.close()

    chunk_frames = chunk_seconds * fr
    search = min(45 * fr, chunk_frames // 3)   # slide up to 45s
    bpf = sw * ch

    bounds = [0]
    while bounds[-1] + chunk_frames < total:
        target = bounds[-1] + chunk_frames
        cut = find_quiet_cut(frames, sw, ch, target, search, total)
        if cut <= bounds[-1] + fr:            # no useful move; hard cut
            cut = target
        bounds.append(cut)
    bounds.append(total)

    out_dir.mkdir(parents=True, exist_ok=True)
    chunks = []
    for i in range(len(bounds) - 1):
        start, end = bounds[i], bounds[i + 1]
        cp = out_dir / f"chunk_{i:02d}.wav"
        cw = wave.open(str(cp), "wb")
        cw.setnchannels(ch)
        cw.setsampwidth(sw)
        cw.setframerate(fr)
        cw.writeframes(frames[start * bpf: end * bpf])
        cw.close()
        chunks.append((cp, start / float(fr)))
    return chunks


_TS_RE = re.compile(r"^\s*\[(\d{1,2}):(\d{2})(?::(\d{2}))?\]\s*", re.MULTILINE)


def shift_timestamps(text: str, offset_seconds: float) -> str:
    """Rewrite every [MM:SS] / [HH:MM:SS] prefix by +offset.

    Each chunk is transcribed as if it began at 00:00, so without this
    every chunk's timestamps would restart and the stitched transcript
    would look like it loops.
    """
    if offset_seconds <= 0:
        return text

    def repl(m: re.Match) -> str:
        a, b, c = m.group(1), m.group(2), m.group(3)
        secs = (int(a) * 3600 + int(b) * 60 + int(c)) if c else (int(a) * 60 + int(b))
        secs += int(offset_seconds)
        h, rem = divmod(secs, 3600)
        mnt, s = divmod(rem, 60)
        stamp = f"[{h:02d}:{mnt:02d}:{s:02d}]" if h else f"[{mnt:02d}:{s:02d}]"
        return stamp + " "

    return _TS_RE.sub(repl, text)


async def transcribe_chunk(client, path: Path, index: int, total: int) -> str:
    from google.genai import types as genai_types

    data = path.read_bytes()
    print(f"  [{index + 1}/{total}] uploading {path.name} "
          f"({len(data) / 1048576:.1f} MB) ...", flush=True)
    uploaded = await client.aio.files.upload(
        file=io.BytesIO(data), config={"mime_type": "audio/wav"}
    )
    try:
        print(f"  [{index + 1}/{total}] transcribing ...", flush=True)
        started = time.time()
        resp = await client.aio.models.generate_content(
            model="gemini-2.5-flash",
            contents=[PROMPT, uploaded],
            config=genai_types.GenerateContentConfig(temperature=0.0),
        )
        text = (resp.text or "").strip()
        print(f"  [{index + 1}/{total}] done: {len(text)} chars "
              f"in {time.time() - started:.0f}s", flush=True)
        return text
    finally:
        try:
            await client.aio.files.delete(name=uploaded.name)
        except Exception:
            pass


async def run(args) -> int:
    wav = Path(args.wav)
    if not wav.is_file():
        print(f"File not found: {wav}", file=sys.stderr)
        return 1

    w = wave.open(str(wav), "rb")
    dur = w.getnframes() / float(w.getframerate())
    sw, ch, fr = w.getsampwidth(), w.getnchannels(), w.getframerate()
    w.close()
    print(f"Input: {wav.name}")
    print(f"  {wav.stat().st_size / 1048576:.1f} MB, {fr} Hz, {ch} ch, "
          f"{sw * 8}-bit, {dur / 60:.1f} min")

    db_path = Path(args.db) if args.db else default_db_path()
    key = resolve_key(db_path)
    if not key:
        print("No Gemini API key found (env, DB, or bundled).", file=sys.stderr)
        return 1
    print(f"  key: {key[:6]}...{key[-4:]}")

    scratch = Path(args.workdir) if args.workdir else wav.parent / f".recover_{wav.stem}"
    print(f"\nSplitting into ~{args.chunk_min} min chunks at quiet points ...")
    chunks = split_wav(wav, args.chunk_min * 60, scratch)
    for p, off in chunks:
        cw = wave.open(str(p), "rb")
        cdur = cw.getnframes() / float(cw.getframerate())
        cw.close()
        print(f"  {p.name}: starts {off / 60:6.1f} min, length {cdur / 60:5.1f} min")

    if args.dry_run:
        print("\n--dry-run: stopping before any API call.")
        return 0

    from google import genai
    client = genai.Client(api_key=key)

    print("\nTranscribing ...")
    parts = []
    for i, (cp, off) in enumerate(chunks):
        try:
            text = await transcribe_chunk(client, cp, i, len(chunks))
        except Exception as e:
            print(f"  [{i + 1}/{len(chunks)}] FAILED: {e}", file=sys.stderr)
            print("  Aborting; source WAV is untouched.", file=sys.stderr)
            return 1
        if text:
            parts.append(shift_timestamps(text, off))

    transcript = "\n".join(parts).strip()
    if not transcript:
        print("All chunks returned empty text. Source WAV preserved.", file=sys.stderr)
        return 1
    print(f"\nStitched transcript: {len(transcript)} chars")

    out_txt = wav.with_suffix(".transcript.txt")
    out_txt.write_text(transcript, encoding="utf-8")
    print(f"Saved a copy to {out_txt}")

    # Save into the app so it shows up in the sidebar.
    meeting_id = f"meeting-{int(time.time() * 1000)}"
    title = args.title or f"Recovered: {wav.stem}"
    payload = {
        "meeting_id": meeting_id,
        "meeting_title": title,
        "transcripts": [{
            "id": f"{int(time.time() * 1000)}-0",
            "text": transcript,
            "timestamp": "00:00",
        }],
        "detection_source": "manual",
        "detection_confidence": "manual",
    }
    print(f"Saving as meeting {meeting_id} ...")
    try:
        r = requests.post(f"{BACKEND_URL}/save-transcript", json=payload, timeout=120)
    except requests.RequestException as e:
        print(f"Save failed ({e}). Transcript is still at {out_txt}.", file=sys.stderr)
        return 1
    if not r.ok:
        print(f"/save-transcript HTTP {r.status_code}: {r.text[:300]}", file=sys.stderr)
        print(f"Transcript is still at {out_txt}.", file=sys.stderr)
        return 1

    print(f"\nSaved. Title: {title}")
    print("Chunk files kept at", scratch)
    print("Delete them and the source WAV once you've confirmed the transcript.")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("wav")
    ap.add_argument("--title", default=None)
    ap.add_argument("--chunk-min", type=int, default=18)
    ap.add_argument("--db", default=None)
    ap.add_argument("--workdir", default=None)
    ap.add_argument("--dry-run", action="store_true")
    return asyncio.run(run(ap.parse_args()))


if __name__ == "__main__":
    sys.exit(main())
