"""Split long audio into pieces small enough to transcribe reliably.

Why this exists
---------------
Transcription used to send an entire meeting to Gemini in one call,
inside one HTTP request. That worked only because a recorder bug was
capping every recording at ten minutes. Once that bug was fixed
(c459756), a real 95-minute meeting reached this path and the request
outlived Cloud Run's 300s budget:

    Proxy returned HTTP 504: upstream request timeout

Raising the Cloud Run timeout to its 3600s maximum buys headroom, but
MAX_RECORDING_DURATION is three hours, so a single-shot call can still
run out of room. Splitting removes the dependency on any one call being
short enough.

Two things improve as a side effect:

* **Speed.** Chunks transcribe concurrently, so wall-clock time tracks
  the slowest chunk rather than the sum of all of them.
* **Timestamp accuracy.** Gemini's timestamps drift badly over long
  audio -- on an 18-minute segment it emitted times past 1:17:00, well
  beyond the segment's own length. Shorter segments keep timestamps
  anchored to something close to reality.

ffmpeg does the splitting. It is installed in the container image (see
Dockerfile); `ffmpeg_available()` lets callers degrade to a single-shot
call rather than fail outright if it is ever missing.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import shutil
import tempfile
from pathlib import Path

logger = logging.getLogger(__name__)

# Audio longer than this gets split. Ten minutes keeps each Gemini call
# quick and its timestamps trustworthy, without producing so many chunks
# that per-call overhead dominates.
CHUNK_SECONDS = int(os.environ.get("TRANSCRIBE_CHUNK_SECONDS", "600"))

# Below this, one call is fine -- splitting would only add overhead.
# Slightly above CHUNK_SECONDS so a meeting barely over the chunk size
# doesn't get carved into one big piece plus a sliver.
MIN_SPLIT_SECONDS = int(os.environ.get("TRANSCRIBE_MIN_SPLIT_SECONDS", "720"))

# Concurrent Gemini calls. Enough to keep a long meeting fast; low
# enough to stay clear of per-project rate limits.
MAX_CONCURRENCY = int(os.environ.get("TRANSCRIBE_CONCURRENCY", "4"))


def ffmpeg_available() -> bool:
    return shutil.which("ffmpeg") is not None


def _suffix_for(mime: str) -> str:
    """Container extension ffmpeg should infer from, based on MIME."""
    m = (mime or "").lower()
    if "ogg" in m or "opus" in m:
        return ".ogg"
    if "mp3" in m or "mpeg" in m:
        return ".mp3"
    if "m4a" in m or "mp4" in m or "aac" in m:
        return ".m4a"
    if "flac" in m:
        return ".flac"
    if "webm" in m:
        return ".webm"
    return ".wav"


async def _run(*args: str, timeout: float = 900.0) -> tuple[int, bytes, bytes]:
    proc = await asyncio.create_subprocess_exec(
        *args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        proc.kill()
        raise
    return proc.returncode, out, err


async def probe_duration(path: Path) -> float:
    """Duration in seconds via ffprobe, or 0.0 if it can't be determined."""
    if shutil.which("ffprobe") is None:
        return 0.0
    try:
        code, out, _ = await _run(
            "ffprobe", "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
            str(path), timeout=120.0,
        )
        if code == 0:
            return float(out.decode().strip())
    except Exception as e:
        logger.warning("ffprobe failed: %s", e)
    return 0.0


async def split_audio(
    audio_bytes: bytes, mime: str, chunk_seconds: int = CHUNK_SECONDS
) -> tuple[list[tuple[bytes, float]], str]:
    """Split into `chunk_seconds` pieces.

    Returns ``([(chunk_bytes, offset_seconds), ...], chunk_mime)``. A
    single-element list means the audio was short enough to leave alone,
    or that splitting wasn't possible.

    Chunks are re-encoded to 16 kHz mono Opus rather than stream-copied:
    `-c copy` can only cut on packet boundaries, which drifts from the
    requested times, and re-encoding keeps every chunk small to upload.
    """
    suffix = _suffix_for(mime)
    tmpdir = Path(tempfile.mkdtemp(prefix="rw_tx_"))
    try:
        src = tmpdir / f"input{suffix}"
        src.write_bytes(audio_bytes)

        duration = await probe_duration(src)
        if duration and duration < MIN_SPLIT_SECONDS:
            logger.info("audio %.0fs is under split threshold; single call", duration)
            return [(audio_bytes, 0.0)], mime
        if not duration:
            logger.warning("could not probe duration; sending as one call")
            return [(audio_bytes, 0.0)], mime

        pattern = str(tmpdir / "part_%04d.ogg")
        code, _, err = await _run(
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-i", str(src),
            "-f", "segment",
            "-segment_time", str(chunk_seconds),
            "-segment_format", "ogg",
            "-reset_timestamps", "1",
            "-ac", "1", "-ar", "16000", "-c:a", "libopus", "-b:a", "16k",
            pattern,
            timeout=900.0,
        )
        if code != 0:
            logger.error("ffmpeg segment failed (%s): %s", code, err.decode()[:400])
            return [(audio_bytes, 0.0)], mime

        parts = sorted(tmpdir.glob("part_*.ogg"))
        if not parts:
            logger.error("ffmpeg produced no segments; falling back")
            return [(audio_bytes, 0.0)], mime

        chunks = [(p.read_bytes(), i * float(chunk_seconds)) for i, p in enumerate(parts)]
        logger.info(
            "split %.0fs audio into %d chunks of %ds",
            duration, len(chunks), chunk_seconds,
        )
        return chunks, "audio/ogg"
    except Exception as e:
        logger.error("split_audio failed (%s); falling back to single call", e)
        return [(audio_bytes, 0.0)], mime
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


_TS_RE = re.compile(r"^[ \t]*\[(\d{1,2}):(\d{2})(?::(\d{2}))?\][ \t]*", re.MULTILINE)


def shift_timestamps(text: str, offset_seconds: float) -> str:
    """Rewrite every [MM:SS] / [HH:MM:SS] prefix by +offset_seconds.

    Each chunk is transcribed as if it starts at 00:00, so without this
    the stitched transcript restarts its clock at every boundary.
    """
    if offset_seconds <= 0 or not text:
        return text

    off = int(offset_seconds)

    def repl(m: re.Match) -> str:
        a, b, c = m.group(1), m.group(2), m.group(3)
        secs = (int(a) * 3600 + int(b) * 60 + int(c)) if c else (int(a) * 60 + int(b))
        secs += off
        h, rem = divmod(secs, 3600)
        mnt, s = divmod(rem, 60)
        stamp = f"[{h:02d}:{mnt:02d}:{s:02d}]" if h else f"[{mnt:02d}:{s:02d}]"
        return stamp + " "

    return _TS_RE.sub(repl, text)


def stitch(parts: list[str]) -> str:
    """Join chunk transcripts, dropping empties and normalising blank lines."""
    joined = "\n".join(p.strip() for p in parts if p and p.strip())
    return re.sub(r"\n{3,}", "\n\n", joined).strip()
