"""Thin async wrappers around the Gemini SDK for the rewind-proxy service.

Three functions — transcribe, summarize, embed — each build a fresh
genai.Client inside the call so tests can patch app.gemini.genai.Client
without module-level side effects.

The client is constructed as:
    genai.Client(api_key=os.environ["GEMINI_API_KEY"])

No key is ever logged.
"""

from __future__ import annotations

import asyncio
import io
import json
import logging
import os

from google import genai
from google.genai import types as genai_types

from app import audio_chunk

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Constants (match backend/app/embeddings.py + transcript_processor.py)
# ---------------------------------------------------------------------------

_TRANSCRIBE_MODEL = "gemini-2.5-flash"
_SUMMARIZE_MODEL_DEFAULT = "gemini-2.5-flash"
_EMBED_MODEL = "gemini-embedding-001"
_EMBED_DIM = 768

_TRANSCRIBE_PROMPT = (
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
    "needed for those). Output ONLY the transcript text — no "
    "preamble, no commentary."
)

# Ported verbatim from backend/app/transcript_processor.py
_SUMMARY_PROMPT_TEMPLATE = """You are summarizing a chunk of a meeting transcript into the required JSON structure.

Sections (each is independent — only fill what is actually supported by the transcript):
- MeetingName: a concise 4-7 word noun-phrase title that captures what the meeting was actually about. Use Title Case. Examples of the right shape:
    "Prototype Review, Manufacturing & WMS Integration"
    "Sprint Planning with Ali"
    "Q3 Strategy Review"
    "Customer Onboarding - Acme Corp"
  Avoid generic titles like "Meeting", "Discussion", "Sync", "Call". Do not start with "Meeting on..." or "Call about...". If the transcript is too short, silent, or off-topic to determine a real subject, return exactly "Untitled meeting".
- SectionSummary: 2-5 bullets capturing what was discussed in this chunk. Each bullet is one concrete idea, not a paraphrase of small talk.
- CriticalDeadlines: dates / hard deadlines explicitly stated. Format like "Ship by Fri 2026-05-15 — <what>".
- KeyItemsDecisions: decisions actually made (not options considered). Lead with the verb: "Decided to ...", "Agreed that ...".
- ImmediateActionItems: tasks with an owner and (where stated) a due date. Format: "<Owner>: <action> [by <date>]". Skip the brackets if no date.
- NextSteps: follow-ups discussed but not yet owned, or scheduled future activity (e.g. "Schedule follow-up with vendor X next week").
- OtherImportantPoints: substantive context that doesn't fit above (risks, blockers, dependencies, important numbers).
- ClosingRemarks: only if the chunk genuinely contains a wrap-up. Do not invent one.

Rules:
- Be concise. Each bullet should stand alone and be specific.
- Do NOT pad. If a section has no support in this chunk, return blocks: []. Empty is correct, not a failure.
- Do NOT repeat the same point across sections.
- Skip greetings, filler, and off-topic chatter.
- Output ONLY the JSON — no preamble, no commentary.

For each `Section`, the JSON shape is:
  {{ "title": "<section title>", "blocks": [ {{ "id": "<unique-id>", "type": "bullet", "content": "<bullet text>", "color": "default" }}, ... ] }}

Use blocks: [] for empty sections.

Transcript Chunk:
---
{chunk}
---
"""


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


async def transcribe_one(audio_bytes: bytes, mime: str) -> str:
    """Transcribe a single piece of audio in one Gemini call.

    Ported from backend/app/main.py :: transcribe_audio (lines 1815-1859).
    Simplifications: no cost logging — that belongs to the route layer.

    Uploaded files are deleted afterwards; the Files API has a 48-hour TTL
    and a per-project quota, and a long meeting now uploads many pieces.
    """
    client = genai.Client(api_key=os.environ["GEMINI_API_KEY"])

    uploaded = await client.aio.files.upload(
        file=io.BytesIO(audio_bytes),
        config={"mime_type": mime},
    )
    try:
        response = await client.aio.models.generate_content(
            model=_TRANSCRIBE_MODEL,
            contents=[_TRANSCRIBE_PROMPT, uploaded],
            config=genai_types.GenerateContentConfig(
                temperature=0.0,
            ),
        )
        return (response.text or "").strip()
    finally:
        try:
            await client.aio.files.delete(name=uploaded.name)
        except Exception:  # noqa: BLE001 - cleanup is best-effort
            pass


async def transcribe(audio_bytes: bytes, mime: str) -> str:
    """Transcribe audio of any length, splitting it when necessary.

    Short recordings take exactly the old path: one upload, one call.
    Long ones are split (see app/audio_chunk.py) and their pieces are
    transcribed concurrently, then stitched back together with each
    piece's timestamps shifted into whole-recording time.

    This exists because a single call for a 95-minute meeting outlived
    Cloud Run's request timeout and returned 504. Splitting also keeps
    Gemini's timestamps honest -- they drift substantially over long
    audio -- and cuts wall-clock time, since chunks run in parallel.

    Any failure in the splitting layer falls back to a single call, so
    the worst case is the previous behaviour rather than an error.
    """
    chunks, chunk_mime = await audio_chunk.split_audio(audio_bytes, mime)

    if len(chunks) == 1:
        return await transcribe_one(chunks[0][0], chunk_mime)

    sem = asyncio.Semaphore(audio_chunk.MAX_CONCURRENCY)

    async def one(index: int, data: bytes, offset: float) -> tuple[int, str]:
        async with sem:
            logger.info(
                "transcribing chunk %d/%d (offset %.0fs, %.1f MB)",
                index + 1, len(chunks), offset, len(data) / 1048576,
            )
            text = await transcribe_one(data, chunk_mime)
            return index, audio_chunk.shift_timestamps(text, offset)

    results = await asyncio.gather(
        *(one(i, d, o) for i, (d, o) in enumerate(chunks)),
        return_exceptions=True,
    )

    # A chunk that fails shouldn't cost the user the whole meeting: keep
    # what succeeded and note the gap in place, so the transcript stays
    # usable and the loss is visible rather than silent.
    ordered: list[str] = [""] * len(chunks)
    failures = 0
    for res in results:
        if isinstance(res, BaseException):
            failures += 1
            logger.error("chunk transcription failed: %s", res)
            continue
        idx, text = res
        ordered[idx] = text
    if failures:
        for i, text in enumerate(ordered):
            if not text:
                mins = int(chunks[i][1] // 60)
                ordered[i] = f"[transcription unavailable for segment starting {mins} min]"
        if failures == len(chunks):
            raise RuntimeError("all audio chunks failed to transcribe")

    return audio_chunk.stitch(ordered)


async def summarize(text: str, model: str = _SUMMARIZE_MODEL_DEFAULT) -> dict:
    """Generate a structured meeting summary from transcript *text*.

    Ported from backend/app/transcript_processor.py :: TranscriptProcessor.
    process_transcript (the Gemini branch, ~lines 259-279).
    Simplifications: single-chunk only (the route layer handles chunking if
    needed); no retry; no cost logging.

    Args:
        text:  Transcript text to summarize.
        model: Gemini model name (default: gemini-2.5-flash).

    Returns:
        Parsed summary dict matching the SummaryResponse schema.
    """
    client = genai.Client(api_key=os.environ["GEMINI_API_KEY"])

    prompt = _SUMMARY_PROMPT_TEMPLATE.format(chunk=text)

    response = await client.aio.models.generate_content(
        model=model,
        contents=prompt,
        config=genai_types.GenerateContentConfig(
            temperature=0.3,
            response_mime_type="application/json",
        ),
    )
    return json.loads(response.text)


async def embed(texts: list[str]) -> list[list[float]]:
    """Embed a list of strings using gemini-embedding-001.

    Ported from backend/app/embeddings.py :: _embed_batch (lines 203-320).
    Simplifications: single batch, no retry, no throttle, no cost logging —
    the route layer owns those concerns.

    Args:
        texts: List of strings to embed.

    Returns:
        List of float vectors, one per input string.
    """
    if not texts:
        return []

    client = genai.Client(api_key=os.environ["GEMINI_API_KEY"])

    cfg = genai_types.EmbedContentConfig(
        output_dimensionality=_EMBED_DIM,
        task_type="RETRIEVAL_DOCUMENT",
    )
    resp = await client.aio.models.embed_content(
        model=_EMBED_MODEL,
        contents=texts,
        config=cfg,
    )
    return [list(e.values) for e in resp.embeddings]
