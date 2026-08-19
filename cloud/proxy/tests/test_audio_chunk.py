"""Tests for app.audio_chunk and gemini.transcribe's chunked path.

No network and no ffmpeg required: splitting is stubbed so these run
anywhere. The point is the stitching contract -- ordering, timestamp
offsets, and what happens when a chunk fails.
"""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

import app.audio_chunk as ac
import app.gemini as gemini_mod


# ---------------------------------------------------------------------------
# shift_timestamps
# ---------------------------------------------------------------------------

def test_shift_noop_at_zero_offset():
    text = "[00:05] Speaker 1: hello"
    assert ac.shift_timestamps(text, 0) == text


def test_shift_mmss_within_the_hour():
    assert ac.shift_timestamps("[01:30] Speaker 1: hi", 60) == "[02:30] Speaker 1: hi"


def test_shift_promotes_to_hhmmss_past_an_hour():
    # 10:00 + 55min = 65min -> must become [01:05:00], not [65:00]
    assert ac.shift_timestamps("[10:00] Speaker 2: x", 55 * 60) == "[01:05:00] Speaker 2: x"


def test_shift_parses_existing_hhmmss():
    assert ac.shift_timestamps("[01:00:00] Speaker 1: x", 600) == "[01:10:00] Speaker 1: x"


def test_shift_applies_to_every_line():
    src = "[00:01] Speaker 1: a\n[00:31] Speaker 2: b"
    assert ac.shift_timestamps(src, 30) == "[00:31] Speaker 1: a\n[01:01] Speaker 2: b"


def test_shift_leaves_untimestamped_lines_alone():
    # Bracketed non-speech markers carry no timestamp and must survive.
    src = "[music]\n[00:10] Speaker 1: hi"
    assert ac.shift_timestamps(src, 10) == "[music]\n[00:20] Speaker 1: hi"


# ---------------------------------------------------------------------------
# stitch
# ---------------------------------------------------------------------------

def test_stitch_drops_empty_parts():
    assert ac.stitch(["a", "", "   ", "b"]) == "a\nb"


def test_stitch_collapses_excess_blank_lines():
    assert ac.stitch(["a\n\n\n\nb"]) == "a\n\nb"


def test_suffix_for_mime():
    assert ac._suffix_for("audio/ogg") == ".ogg"
    assert ac._suffix_for("audio/wav") == ".wav"
    assert ac._suffix_for("audio/mpeg") == ".mp3"
    assert ac._suffix_for("") == ".wav"


# ---------------------------------------------------------------------------
# gemini.transcribe — chunked path
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_single_chunk_takes_the_simple_path():
    """Short audio must behave exactly as before: one upload, one call."""
    client = MagicMock()
    client.aio.files.upload = AsyncMock(return_value=MagicMock())
    client.aio.files.delete = AsyncMock()
    resp = MagicMock()
    resp.text = "[00:01] Speaker 1: hello"
    client.aio.models.generate_content = AsyncMock(return_value=resp)

    with patch.object(gemini_mod.genai, "Client", return_value=client), \
         patch.dict("os.environ", {"GEMINI_API_KEY": "k"}), \
         patch.object(ac, "split_audio", AsyncMock(return_value=([(b"x", 0.0)], "audio/wav"))):
        out = await gemini_mod.transcribe(b"x", "audio/wav")

    assert out == "[00:01] Speaker 1: hello"
    assert client.aio.models.generate_content.await_count == 1


@pytest.mark.asyncio
async def test_multi_chunk_stitches_in_order_with_offsets():
    """Chunks run concurrently but must reassemble in time order."""
    client = MagicMock()
    client.aio.files.upload = AsyncMock(return_value=MagicMock())
    client.aio.files.delete = AsyncMock()

    # Every chunk reports its own clock starting at 00:00.
    resp = MagicMock()
    resp.text = "[00:05] Speaker 1: part"
    client.aio.models.generate_content = AsyncMock(return_value=resp)

    three = ([(b"a", 0.0), (b"b", 600.0), (b"c", 1200.0)], "audio/ogg")
    with patch.object(gemini_mod.genai, "Client", return_value=client), \
         patch.dict("os.environ", {"GEMINI_API_KEY": "k"}), \
         patch.object(ac, "split_audio", AsyncMock(return_value=three)):
        out = await gemini_mod.transcribe(b"xxx", "audio/ogg")

    assert out.split("\n") == [
        "[00:05] Speaker 1: part",
        "[10:05] Speaker 1: part",
        "[20:05] Speaker 1: part",
    ]
    assert client.aio.models.generate_content.await_count == 3


@pytest.mark.asyncio
async def test_one_failed_chunk_keeps_the_rest():
    """A single bad chunk must not cost the user the whole meeting."""
    client = MagicMock()
    client.aio.files.upload = AsyncMock(return_value=MagicMock())
    client.aio.files.delete = AsyncMock()

    calls = {"n": 0}

    async def flaky(*_a, **_k):
        calls["n"] += 1
        if calls["n"] == 2:
            raise RuntimeError("boom")
        r = MagicMock()
        r.text = "[00:01] Speaker 1: ok"
        return r

    client.aio.models.generate_content = AsyncMock(side_effect=flaky)

    two = ([(b"a", 0.0), (b"b", 600.0)], "audio/ogg")
    with patch.object(gemini_mod.genai, "Client", return_value=client), \
         patch.dict("os.environ", {"GEMINI_API_KEY": "k"}), \
         patch.object(ac, "split_audio", AsyncMock(return_value=two)):
        out = await gemini_mod.transcribe(b"xx", "audio/ogg")

    assert "Speaker 1: ok" in out
    assert "transcription unavailable" in out


@pytest.mark.asyncio
async def test_all_chunks_failing_raises():
    """Total failure must surface, not return a transcript of placeholders."""
    client = MagicMock()
    client.aio.files.upload = AsyncMock(return_value=MagicMock())
    client.aio.files.delete = AsyncMock()
    client.aio.models.generate_content = AsyncMock(side_effect=RuntimeError("boom"))

    two = ([(b"a", 0.0), (b"b", 600.0)], "audio/ogg")
    with patch.object(gemini_mod.genai, "Client", return_value=client), \
         patch.dict("os.environ", {"GEMINI_API_KEY": "k"}), \
         patch.object(ac, "split_audio", AsyncMock(return_value=two)):
        with pytest.raises(RuntimeError):
            await gemini_mod.transcribe(b"xx", "audio/ogg")


@pytest.mark.asyncio
async def test_uploaded_files_are_deleted():
    """Files API has a quota; every upload must be cleaned up."""
    client = MagicMock()
    client.aio.files.upload = AsyncMock(return_value=MagicMock())
    client.aio.files.delete = AsyncMock()
    resp = MagicMock()
    resp.text = "x"
    client.aio.models.generate_content = AsyncMock(return_value=resp)

    two = ([(b"a", 0.0), (b"b", 600.0)], "audio/ogg")
    with patch.object(gemini_mod.genai, "Client", return_value=client), \
         patch.dict("os.environ", {"GEMINI_API_KEY": "k"}), \
         patch.object(ac, "split_audio", AsyncMock(return_value=two)):
        await gemini_mod.transcribe(b"xx", "audio/ogg")

    assert client.aio.files.delete.await_count == 2
