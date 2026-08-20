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

# Keep in sync with backend/app/transcript_processor.py. That copy runs
# only in local mode; THIS one is what the shipped app uses, because the
# app forwards summarization to this proxy.
#
# Rewritten to be materially more detailed than the original, which
# produced thin summaries. The additions -- an executive bottom line,
# participants, meeting tone, explicit problem/solution pairing, and
# open questions -- come from a spec Mark wrote after finding the old
# output too sparse to be useful for anyone who missed the meeting.
#
# Output stays as structured sections rather than prose or HTML: the
# app renders sections as editable blocks, exports them to markdown,
# indexes them for search, and reads MeetingName out of the top level.
# Prose or markup would break all four.
_SUMMARY_PROMPT_TEMPLATE = """You are an expert meeting analyst. Summarize the meeting transcript below into the required JSON structure.

Your summary serves four readers at once: a participant wanting a fast recap, an executive who skipped the meeting, a project team tracking commitments, and the permanent record. Write so each of them finds what they need.

Sections (each independent -- fill only what the transcript actually supports):

- MeetingName: a concise 4-7 word noun-phrase title capturing what the meeting was actually about. Title Case. Examples of the right shape:
    "Prototype Review, Manufacturing & WMS Integration"
    "Sprint Planning with Ali"
    "Q3 Strategy Review"
    "Customer Onboarding - Acme Corp"
  Avoid generic titles like "Meeting", "Discussion", "Sync", "Call". Do not start with "Meeting on..." or "Call about...". If the transcript is too short, silent, or off-topic to determine a real subject, return exactly "Untitled meeting".

- BottomLine: REQUIRED -- never leave this empty. Exactly ONE block containing one or two sentences with the single most consequential outcome: the thing a busy executive must know if they read nothing else. Lead with the outcome, not the topic. Write "Ops will absorb the Q3 shortfall by delaying the Denver hire until October", not "The team discussed hiring and budget". This is a synthesis of the whole meeting, not a quote from it, so the "only include what the transcript supports" rule does not mean you may skip it. If the meeting reached no decision, say what it was for and what remains unresolved -- e.g. "Exploratory vendor call; no commitments made, pricing still unknown pending their quote."

- Participants: one block per identifiable person, formatted "<Name> -- <their role or main contribution in this meeting>". Use real names when spoken or self-introduced. If speakers are only "Speaker 1"/"Speaker 2", still list them with what they contributed ("Speaker 2 -- raised the pricing objection, owns vendor follow-up"). Return blocks: [] only if there is genuinely nothing to distinguish speakers by.

- MeetingTone: one or two blocks describing the emotional register and how it moved -- e.g. "Collaborative throughout; brief tension when the timeline slipped, resolved by rescoping" or "Efficient and transactional; no disagreement surfaced". Note significant shifts. This is the one section where subjective reading is expected; everywhere else stay objective.

- SectionSummary: 4-8 bullets on the substance of the discussion. Each is one concrete idea with enough specificity to be useful months later -- name the systems, numbers, customers, and tradeoffs actually discussed. Prefer "Warehouse API returns stale inventory when two orders hit within 200ms" over "discussed a technical issue". Capture disagreements and the reasoning behind them, not just conclusions.

- KeyItemsDecisions: decisions actually made, not options merely considered. Lead with the verb and attribute where clear: "Decided to ... (Sarah, with Ops agreeing)", "Agreed that ...". Where a decision has an immediate consequence, state it in the same bullet.

- ImmediateActionItems: every committed task. Format each block EXACTLY as:
    <Owner> | <specific action> | <due date>
  Use " | " as the separator so the app can render these as a table. Owner is a person's name, or "Unassigned" if nobody took it. Due date is a real date when stated, otherwise a stated relative deadline ("end of week"), otherwise "TBD". Never drop the separators, and never omit a task because its owner or date is missing -- write "Unassigned" or "TBD" instead.

- OpenQuestions: questions raised but not answered, and decisions explicitly deferred. Format "<the open question> -- <who needs to resolve it, if stated>". This section is how the next meeting gets its agenda; be thorough.

- ProblemsSolutions: problems or blockers named in the meeting, each paired with what was proposed about it. Format "PROBLEM: <the problem> -> PROPOSED: <the approach discussed, or 'no solution proposed'>". One block per problem. Include problems raised even if nobody offered a fix -- an unaddressed problem is the most valuable thing this section can surface.

- CriticalDeadlines: hard dates and deadlines explicitly stated. Format "Ship by Fri 2026-05-15 -- <what>". Only genuine deadlines, not general future intentions.

- NextSteps: follow-ups and scheduled activity that are not owned tasks, e.g. "Team reconvenes Thursday to review the vendor quote".

- OtherImportantPoints: substantive context that fits nowhere above -- risks, dependencies, budget figures, customer names, competitive intel, anything a reader would want on the record.

- ClosingRemarks: only if the transcript genuinely contains a wrap-up. Do not invent one.

Rules:
- Be specific and concrete. Name names, numbers, dates, and systems. Vague bullets are the main failure mode; a reader who missed the meeting should not have to open the transcript.
- Be comprehensive on substance, economical in wording. Each bullet stands alone and earns its place.
- Ground everything in the transcript. Never invent an owner, date, decision, or participant. If something was ambiguous, reflect the ambiguity.
- Do NOT pad. If a section has no support, return blocks: []. Empty is correct, not a failure. The ONE exception is BottomLine, which is always required -- it is synthesized from the meeting as a whole, so there is always something to write.
- Do NOT repeat the same point across sections.
- Skip greetings, filler, scheduling chatter, and off-topic tangents.
- Plain text inside blocks. No markdown, no HTML, no bullet characters -- the app supplies its own formatting.
- Output ONLY the JSON -- no preamble, no commentary.

Return a JSON OBJECT (not an array) whose keys are exactly the section names above. MeetingName is a plain string. Every other key maps to:
  {{ "title": "<human-readable section title>", "blocks": [ {{ "id": "<unique-id>", "type": "bullet", "content": "<text>", "color": "default" }}, ... ] }}

Use blocks: [] for empty sections.

Transcript Chunk:
---
{chunk}
---
"""

# Canonical section order and display titles. The frontend renders
# Object.entries(summary) in insertion order and hides empty sections,
# so this list is literally the on-screen order.
SUMMARY_SECTIONS: list[tuple[str, str]] = [
    ("BottomLine", "Bottom Line"),
    ("SectionSummary", "Key Discussion Highlights"),
    ("KeyItemsDecisions", "Key Decisions"),
    ("ImmediateActionItems", "Action Items"),
    ("OpenQuestions", "Open Questions"),
    ("ProblemsSolutions", "Problems & Proposed Solutions"),
    ("CriticalDeadlines", "Critical Deadlines"),
    ("NextSteps", "Next Steps"),
    ("Participants", "Participants"),
    ("MeetingTone", "Meeting Tone"),
    ("OtherImportantPoints", "Other Important Points"),
    ("ClosingRemarks", "Closing Remarks"),
]


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


async def summarize(
    text: str,
    model: str = _SUMMARIZE_MODEL_DEFAULT,
    custom_prompt: str | None = None,
) -> dict:
    """Generate a structured meeting summary from transcript *text*.

    Ported from backend/app/transcript_processor.py :: TranscriptProcessor.
    process_transcript (the Gemini branch, ~lines 259-279).
    Simplifications: single-chunk only (the route layer handles chunking if
    needed); no retry; no cost logging.

    Args:
        text:          Transcript text to summarize.
        model:         Gemini model name (default: gemini-2.5-flash).
        custom_prompt: Per-meeting or folder-default instructions, layered
                       on top of the base prompt. Until this existed, the
                       cloud path had no way to receive one, so per-meeting
                       prompts, folder defaults, and the whole saved-prompt
                       library silently did nothing in the shipped app.

    Returns:
        Normalized summary dict (see normalize_summary).
    """
    client = genai.Client(api_key=os.environ["GEMINI_API_KEY"])

    prompt = _SUMMARY_PROMPT_TEMPLATE.format(chunk=text)

    if custom_prompt and custom_prompt.strip():
        # Inserted before the transcript so it shapes what gets extracted
        # while leaving the output-shape rules above it intact. The local
        # implementation splices on the literal "Transcript Chunk:"; doing
        # the same here keeps the two paths behaving identically.
        addendum = (
            "\n\nAdditional instructions for this meeting "
            "(user-provided -- apply on top of the rules above, but do "
            "NOT change the JSON output shape):\n"
            f"{custom_prompt.strip()}\n"
        )
        prompt = prompt.replace("Transcript Chunk:", f"{addendum}Transcript Chunk:")

    response = await client.aio.models.generate_content(
        model=model,
        contents=prompt,
        config=genai_types.GenerateContentConfig(
            temperature=0.3,
            response_mime_type="application/json",
        ),
    )
    return normalize_summary(json.loads(response.text))


def normalize_summary(raw) -> dict:
    """Force any model output into the canonical summary dict.

    This runs here, in the proxy, for a specific reason: the desktop app
    only reshapes the response when it arrives as a LIST
    (backend/app/main.py, `if isinstance(summary_dict, list)`). Returning
    a well-formed dict bypasses that adapter entirely -- which is what
    lets new sections ship by redeploying the proxy alone, with no app
    rebuild and no reinstall for users.

    It also absorbs the model's known non-determinism: sometimes the
    meeting name arrives as its own section instead of a top-level
    string, and sometimes sections come back as a list.

    Guarantees:
      * `MeetingName` is a plain string (six call sites read it, and one
        of them force-renames the meeting).
      * Every section is `{title, blocks: [...]}` with well-formed
        blocks carrying `id`/`type`/`content`/`color`.
      * Block ids contain the section key. The frontend regenerates ids
        that don't, so matching its convention keeps them stable.
      * Sections appear in SUMMARY_SECTIONS order, which is the order
        they render in.
    """
    sections: dict[str, dict] = {}
    meeting_name = ""

    def _blocks(value) -> list[dict]:
        raw_blocks = value.get("blocks") if isinstance(value, dict) else value
        if not isinstance(raw_blocks, list):
            return []
        out = []
        for b in raw_blocks:
            content = b.get("content") if isinstance(b, dict) else b
            if content is None:
                continue
            content = str(content).strip()
            if content:
                out.append(content)
        return out

    if isinstance(raw, dict):
        for key, value in raw.items():
            if key == "MeetingName":
                # Usually a string; occasionally a section wrapping one block.
                if isinstance(value, str):
                    meeting_name = value.strip()
                else:
                    got = _blocks(value)
                    meeting_name = got[0] if got else ""
                continue
            sections[key] = _blocks(value)
    elif isinstance(raw, list):
        known = {k for k, _ in SUMMARY_SECTIONS}
        for sec in raw:
            if not isinstance(sec, dict):
                continue
            title = str(sec.get("title") or "").strip()
            if not title:
                continue
            if title == "MeetingName":
                got = _blocks(sec)
                meeting_name = got[0] if got else meeting_name
            elif title in known:
                sections[title] = _blocks(sec)
            elif not meeting_name:
                # An unrecognised title is the model having put the topic
                # in a section name rather than in MeetingName.
                meeting_name = title

    result: dict = {"MeetingName": meeting_name or "Untitled meeting"}
    for key, title in SUMMARY_SECTIONS:
        contents = sections.get(key) or []
        result[key] = {
            "title": title,
            "blocks": [
                {
                    "id": f"{key.lower()}-{i + 1}",
                    "type": "bullet",
                    "content": text,
                    "color": "default",
                }
                for i, text in enumerate(contents)
            ],
        }
    return result


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
