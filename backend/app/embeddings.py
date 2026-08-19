"""Phase 7 Task 1: RAG embedding pipeline for meeting transcripts.

Stores chunked transcript + summary text and their Gemini
text-embedding-004 vectors in the existing SQLite DB, using sqlite-vec's
vec0 virtual table for similarity search.

## Tables

- `transcript_embeddings` — source-of-truth row per chunk: text,
  hash, kind ('transcript' or 'summary'), meeting linkage, timestamps.
- `transcript_embeddings_vec` — `vec0` virtual table holding the
  768-dim float32 vectors, joined to `transcript_embeddings` by
  rowid. The vec0 rowid matches `transcript_embeddings.id` so
  retrieval can join cleanly.

## Lifecycle

- `init_schema(db_path)`: idempotent — creates both tables. Called
  once at backend startup.
- `embed_meeting(db_path, meeting_id, gemini_api_key)`: re-embeds a
  meeting end-to-end. Deletes prior chunks for that meeting, chunks
  transcript + summary, embeds, inserts. Idempotent.
- `search(...)`: separate module — Phase 2. This module only handles
  writes + status.
- `status(db_path)`: cheap counts, plus in-flight backfill state.
- `backfill(db_path, gemini_api_key)`: embed every meeting missing
  chunks. Single-flight via an asyncio lock.

## Cost note

Gemini `text-embedding-004` is currently free at the public tier
within generous rate limits. A typical meeting produces 5-20 chunks;
backfilling hundreds of meetings stays well within the per-minute
cap.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import re
import sqlite3
import struct
import time
from typing import Optional

import aiosqlite
from google import genai
from google.genai import types as genai_types

logger = logging.getLogger(__name__)

# Phase 7 Task 1: Google's current production embedding model.
# `text-embedding-004` was retired for newly-issued keys and returns
# 404 on batchEmbedContents; `gemini-embedding-001` is the supported
# replacement. It defaults to 3072-dim, but we pass
# output_dimensionality=768 to keep the vec0 schema compact (and
# matched to typical RAG retrieval — 768 is well within the
# point-of-diminishing-returns range for similarity search).
EMBED_MODEL = "gemini-embedding-001"
EMBED_DIM = 768

# Approximate token budget per chunk. 1 token ≈ 4 chars for English.
# 500 tokens lands in the sweet spot for RAG: small enough that the
# top-K retrieved chunks fit comfortably in the synthesis prompt, big
# enough that each chunk carries useful context.
CHUNK_TARGET_CHARS = 2000  # ~500 tokens
CHUNK_HARD_MAX_CHARS = 3500  # ~875 tokens — hard cap for forced splits

# Single-flight backfill: concurrent /embeddings/backfill calls return
# the current state instead of double-running.
_backfill_lock = asyncio.Lock()
_backfill_state = {
    "in_progress": False,
    "indexed_this_run": 0,
    "remaining_this_run": 0,
}


def _open(db_path: str) -> sqlite3.Connection:
    """Open a sqlite connection with the sqlite-vec extension loaded.
    Synchronous; used only for schema init and write paths inside
    sync blocks called via `to_thread`."""
    import sqlite_vec
    conn = sqlite3.connect(db_path)
    conn.enable_load_extension(True)
    sqlite_vec.load(conn)
    conn.enable_load_extension(False)
    return conn


def init_schema(db_path: str) -> None:
    """Idempotent — create the two embedding tables if absent."""
    with _open(db_path) as conn:
        cur = conn.cursor()
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS transcript_embeddings (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                meeting_id TEXT NOT NULL,
                chunk_idx INTEGER NOT NULL,
                text TEXT NOT NULL,
                text_hash TEXT NOT NULL,
                kind TEXT NOT NULL,
                start_timestamp TEXT,
                speakers TEXT,
                embedded_at TEXT NOT NULL
            )
            """
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS idx_te_meeting "
            "ON transcript_embeddings(meeting_id)"
        )
        cur.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_te_meeting_chunk "
            "ON transcript_embeddings(meeting_id, kind, chunk_idx)"
        )
        cur.execute(
            f"CREATE VIRTUAL TABLE IF NOT EXISTS transcript_embeddings_vec "
            f"USING vec0(embedding float[{EMBED_DIM}])"
        )
        conn.commit()
    logger.info("[embeddings] schema initialized at %s", db_path)


def _pack_embedding(emb: list[float]) -> bytes:
    """sqlite-vec accepts float32 little-endian byte blobs."""
    return struct.pack(f"{len(emb)}f", *emb)


# Matches "Speaker N:" at line start, optionally preceded by a
# "[MM:SS]" timestamp marker (Gemini's transcribe output) or "[HH:MM:SS]".
_SPEAKER_TURN_RE = re.compile(
    r"(?:^|\n)\s*(?:\[\d{1,2}:\d{2}(?::\d{2})?\]\s+)?(Speaker\s+[^\n:]{1,40}):",
    re.MULTILINE,
)


def _chunk_text(text: str) -> list[str]:
    """Split `text` into chunks of roughly CHUNK_TARGET_CHARS,
    preferring speaker-turn boundaries, then paragraph breaks, then
    hard character splits as last resort.

    A "turn" = one Speaker label + its monologue until the next label.
    Consecutive turns accumulate into a chunk until the running length
    exceeds CHUNK_TARGET_CHARS; a single turn longer than
    CHUNK_HARD_MAX_CHARS is hard-split.
    """
    text = (text or "").strip()
    if not text:
        return []

    matches = list(_SPEAKER_TURN_RE.finditer(text))
    turns: list[str] = []
    if matches:
        first_start = matches[0].start()
        if first_start > 0:
            preamble = text[:first_start].strip()
            if preamble:
                turns.append(preamble)
        for i, m in enumerate(matches):
            end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
            turn = text[m.start():end].strip()
            if turn:
                turns.append(turn)
    else:
        # No speaker labels — fall back to paragraph splits.
        turns = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
        if not turns:
            turns = [text]

    chunks: list[str] = []
    buf: list[str] = []
    buf_len = 0
    for turn in turns:
        if len(turn) > CHUNK_HARD_MAX_CHARS:
            # Flush any buffered turns, then hard-split this one.
            if buf:
                chunks.append("\n\n".join(buf))
                buf, buf_len = [], 0
            for i in range(0, len(turn), CHUNK_HARD_MAX_CHARS):
                chunks.append(turn[i:i + CHUNK_HARD_MAX_CHARS])
            continue
        if buf_len + len(turn) > CHUNK_TARGET_CHARS and buf:
            chunks.append("\n\n".join(buf))
            buf, buf_len = [], 0
        buf.append(turn)
        buf_len += len(turn) + 2  # +2 for the "\n\n" separator

    if buf:
        chunks.append("\n\n".join(buf))

    return [c for c in chunks if c.strip()]


def _hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


async def _embed_batch(
    client: genai.Client,
    texts: list[str],
    db_path: Optional[str] = None,
    meeting_id: Optional[str] = None,
) -> list[list[float]]:
    """Embed a list of strings via Gemini in batches of 32. Retries
    once on transient errors."""
    out: list[list[float]] = []
    if not texts:
        return out
    # gemini-embedding-001 batches via `:batchEmbedContents` (one
    # HTTP call covers up to ~100 inputs). 16 keeps the per-call
    # response time small while collapsing 10-20× the round trips
    # compared to single-shot calls. Empirically 16 returns in
    # ~300-500ms versus a single call at ~200ms — net throughput is
    # ~10× higher.
    BATCH = 16
    # Gemini free tier: 100 embed_content requests/min. Sleep ~700ms
    # between batched calls so a single backfill run can't trip the
    # limit on its own (~85 calls/min sustained). Removed for per-
    # meeting embeds in the live path because those are sparse.
    THROTTLE_S = 0.7
    cfg = genai_types.EmbedContentConfig(
        output_dimensionality=EMBED_DIM,
        task_type="RETRIEVAL_DOCUMENT",
    )
    for i in range(0, len(texts), BATCH):
        batch = texts[i:i + BATCH]
        last_err: Optional[Exception] = None
        # Up to 5 attempts on 429: 5s, 15s, 30s, 60s waits. The
        # Gemini quota window is 60s sliding, so by attempt 4 we're
        # guaranteed past it. Other errors get the shorter retry.
        attempt_delays = [5.0, 15.0, 30.0, 60.0]
        max_attempts = len(attempt_delays) + 1
        for attempt in range(max_attempts):
            try:
                resp = await client.aio.models.embed_content(
                    model=EMBED_MODEL,
                    contents=batch,
                    config=cfg,
                )
                if len(resp.embeddings) != len(batch):
                    raise RuntimeError(
                        f"Embedding count mismatch: requested "
                        f"{len(batch)}, got {len(resp.embeddings)}"
                    )
                for e in resp.embeddings:
                    if len(e.values) != EMBED_DIM:
                        raise RuntimeError(
                            f"Unexpected embedding dim {len(e.values)} "
                            f"(expected {EMBED_DIM})"
                        )
                    out.append(list(e.values))
                # Phase 8 Task 1: cost log per successful batch. Only
                # runs when caller threaded db_path (skipped in unit
                # tests / smoke scripts that don't care).
                if db_path:
                    try:
                        import costs as _costs  # noqa: E402
                        in_tok, _ = _costs.extract_usage_from_response(resp)
                        if in_tok == 0:
                            # Embedding responses sometimes omit
                            # usage_metadata; estimate from char count.
                            in_tok = max(
                                1, sum(len(t) for t in batch) // 4
                            )
                        await _costs.record_usage(
                            db_path,
                            _costs.Usage(
                                endpoint="embed_doc",
                                model=EMBED_MODEL,
                                input_tokens=in_tok,
                                meeting_id=meeting_id,
                                notes=f"batch of {len(batch)}",
                            ),
                        )
                    except Exception as cost_err:
                        logger.warning(
                            "[embeddings] doc-embed cost log failed: %s",
                            cost_err,
                        )
                break
            except Exception as err:
                last_err = err
                # 429 — back off and retry. Look for the retryDelay
                # hint in the error message and use that if longer.
                msg = str(err)
                is_429 = "429" in msg or "RESOURCE_EXHAUSTED" in msg
                if is_429 and attempt < len(attempt_delays):
                    delay = attempt_delays[attempt]
                    # Try to extract the API's recommended retryDelay
                    # (e.g. "Please retry in 5.8s."). Use the larger
                    # of our backoff and the API hint.
                    import re as _re
                    m = _re.search(
                        r"retry in (\d+(?:\.\d+)?)s", msg
                    )
                    if m:
                        delay = max(delay, float(m.group(1)) + 0.5)
                    logger.info(
                        "[embeddings] 429 on batch — waiting %.1fs "
                        "(attempt %d/%d)",
                        delay, attempt + 1, max_attempts,
                    )
                    await asyncio.sleep(delay)
                    continue
                if attempt < max_attempts - 1 and not is_429:
                    # Non-429 transient — short retry.
                    await asyncio.sleep(1.0)
                    continue
                raise
        # Throttle between successful batches so a long backfill run
        # paces under the 100/min free-tier limit. Skip on the last
        # batch (no point waiting before returning).
        if i + BATCH < len(texts):
            await asyncio.sleep(THROTTLE_S)
    return out


async def _gather_meeting_text(
    db_path: str, meeting_id: str
) -> tuple[list[tuple[str, str]], Optional[str]]:
    """Return (transcript_rows, summary_json_str_or_none).
    transcript_rows = list of (text, timestamp) ordered by transcript id."""
    transcripts: list[tuple[str, str]] = []
    summary_json: Optional[str] = None
    async with aiosqlite.connect(db_path) as conn:
        async with conn.execute(
            "SELECT transcript, timestamp FROM transcripts "
            "WHERE meeting_id = ? ORDER BY id",
            (meeting_id,),
        ) as cur:
            async for row in cur:
                transcripts.append((row[0] or "", row[1] or ""))
        async with conn.execute(
            "SELECT result FROM summary_processes "
            "WHERE meeting_id = ? AND status = 'COMPLETED'",
            (meeting_id,),
        ) as cur:
            row = await cur.fetchone()
            if row and row[0]:
                summary_json = row[0]
    return transcripts, summary_json


def _summary_to_text(summary_json_str: str) -> str:
    """Flatten the AI summary JSON (whatever shape it is) into a single
    readable string so it can be embedded. Best-effort; unknown shapes
    fall back to the raw JSON."""
    if not summary_json_str:
        return ""
    try:
        obj = json.loads(summary_json_str)
    except Exception:
        return summary_json_str
    parts: list[str] = []
    if isinstance(obj, dict):
        for key, value in obj.items():
            if isinstance(value, str):
                if value.strip():
                    parts.append(f"{key}: {value}")
            elif isinstance(value, list):
                items_s = "; ".join(str(v) for v in value if str(v).strip())
                if items_s:
                    parts.append(f"{key}: {items_s}")
            elif isinstance(value, dict):
                parts.append(f"{key}: {json.dumps(value)}")
    else:
        parts.append(json.dumps(obj))
    return "\n\n".join(parts)


def _write_chunks_sync(
    db_path: str,
    meeting_id: str,
    items: list[dict],
    embeddings: list[list[float]],
    now: str,
) -> None:
    """The SQL-write portion of embed_meeting, factored out to run on
    a worker thread via asyncio.to_thread so the asyncio event loop
    isn't blocked while sqlite-vec inserts a few hundred vectors."""
    with _open(db_path) as conn:
        cur = conn.cursor()
        prior_ids = [
            r[0]
            for r in cur.execute(
                "SELECT id FROM transcript_embeddings WHERE meeting_id = ?",
                (meeting_id,),
            )
        ]
        if prior_ids:
            qmarks = ",".join("?" * len(prior_ids))
            cur.execute(
                f"DELETE FROM transcript_embeddings_vec "
                f"WHERE rowid IN ({qmarks})",
                prior_ids,
            )
            cur.execute(
                "DELETE FROM transcript_embeddings WHERE meeting_id = ?",
                (meeting_id,),
            )
        for it, emb in zip(items, embeddings):
            cur.execute(
                """
                INSERT INTO transcript_embeddings (
                    meeting_id, chunk_idx, text, text_hash, kind,
                    start_timestamp, speakers, embedded_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    meeting_id,
                    it["idx"],
                    it["text"],
                    _hash(it["text"]),
                    it["kind"],
                    it["start_timestamp"],
                    None,  # speakers: reserved for Phase 7 follow-up
                    now,
                ),
            )
            row_id = cur.lastrowid
            cur.execute(
                "INSERT INTO transcript_embeddings_vec(rowid, embedding) "
                "VALUES (?, ?)",
                (row_id, _pack_embedding(emb)),
            )
        conn.commit()


async def embed_meeting(
    db_path: str, meeting_id: str, gemini_api_key: str
) -> int:
    """Re-embed every chunk for `meeting_id`. Returns the chunk count
    written. Idempotent: prior chunks for the meeting are deleted
    before re-insert."""
    if not gemini_api_key:
        logger.warning(
            "[embeddings] %s: no GEMINI_API_KEY — skipping", meeting_id
        )
        return 0

    transcripts, summary_json = await _gather_meeting_text(db_path, meeting_id)
    if not transcripts and not summary_json:
        logger.info("[embeddings] %s: nothing to embed", meeting_id)
        return 0

    # Build chunk list. Transcripts first, then summary.
    transcript_text = "\n\n".join(t[0] for t in transcripts if t[0].strip())
    transcript_chunks = _chunk_text(transcript_text)
    transcript_start = transcripts[0][1] if transcripts else None

    summary_chunks: list[str] = []
    if summary_json:
        summary_text = _summary_to_text(summary_json)
        if summary_text:
            summary_chunks = _chunk_text(summary_text)

    items: list[dict] = []
    for i, c in enumerate(transcript_chunks):
        items.append({
            "kind": "transcript",
            "idx": i,
            "text": c,
            "start_timestamp": transcript_start,
        })
    for i, c in enumerate(summary_chunks):
        items.append({
            "kind": "summary",
            "idx": i,
            "text": c,
            "start_timestamp": None,
        })

    if not items:
        return 0

    client = genai.Client(api_key=gemini_api_key)
    embeddings = await _embed_batch(
        client,
        [it["text"] for it in items],
        db_path=db_path,
        meeting_id=meeting_id,
    )

    now = time.strftime("%Y-%m-%dT%H:%M:%S")
    await asyncio.to_thread(
        _write_chunks_sync, db_path, meeting_id, items, embeddings, now
    )

    logger.info("[embeddings] %s: embedded %d chunks", meeting_id, len(items))
    return len(items)


# A meeting is worth indexing only if it has embeddable text — a non-empty
# transcript row, or a COMPLETED non-empty summary. Blank / failed recordings
# have neither, produce zero chunks in embed_meeting(), and so never get a row
# in transcript_embeddings. Counting them toward "needs indexing" pins the
# indexing banner at indexed < total forever, so both status() (total) and
# backfill() (the work list) exclude them via this predicate. `m` must be the
# meetings-table alias in the surrounding query. Contains no user input, so
# it's safe to inline into the query string.
_HAS_EMBEDDABLE_CONTENT = """
    (
        EXISTS (
            SELECT 1 FROM transcripts t
            WHERE t.meeting_id = m.id
              AND TRIM(COALESCE(t.transcript, '')) <> ''
        )
        OR EXISTS (
            SELECT 1 FROM summary_processes s
            WHERE s.meeting_id = m.id
              AND s.status = 'COMPLETED'
              AND TRIM(COALESCE(s.result, '')) <> ''
        )
    )
"""


async def status(db_path: str) -> dict:
    """Cheap counts + in-flight backfill state. Safe to poll at 1Hz.

    `total` counts only meetings that HAVE embeddable content (see
    _HAS_EMBEDDABLE_CONTENT) so a blank/failed recording — which can never
    produce an embedding row — can't pin the indexing banner at
    indexed < total forever."""
    async with aiosqlite.connect(db_path) as conn:
        async with conn.execute(
            f"SELECT COUNT(*) FROM meetings m WHERE {_HAS_EMBEDDABLE_CONTENT}"
        ) as cur:
            total = (await cur.fetchone())[0]
        try:
            async with conn.execute(
                "SELECT COUNT(DISTINCT meeting_id) FROM transcript_embeddings",
            ) as cur:
                indexed = (await cur.fetchone())[0]
        except aiosqlite.OperationalError:
            # Table not yet created (first boot before init_schema ran).
            indexed = 0
    return {
        "indexed": indexed,
        "total": total,
        "in_progress": _backfill_state["in_progress"],
        "indexed_this_run": _backfill_state["indexed_this_run"],
        "remaining_this_run": _backfill_state["remaining_this_run"],
    }


async def backfill(db_path: str, gemini_api_key: str) -> dict:
    """Embed every meeting that has no chunks yet. Single-flight: a
    concurrent call returns the current status without restarting."""
    if _backfill_lock.locked():
        return await status(db_path)
    async with _backfill_lock:
        _backfill_state["in_progress"] = True
        try:
            async with aiosqlite.connect(db_path) as conn:
                async with conn.execute(
                    f"""
                    SELECT m.id FROM meetings m
                    LEFT JOIN transcript_embeddings e
                        ON e.meeting_id = m.id
                    WHERE e.id IS NULL
                      AND {_HAS_EMBEDDABLE_CONTENT}
                    GROUP BY m.id
                    ORDER BY m.created_at DESC
                    """
                ) as cur:
                    missing = [row[0] async for row in cur]

            _backfill_state["indexed_this_run"] = 0
            _backfill_state["remaining_this_run"] = len(missing)
            logger.info(
                "[embeddings] backfill: %d meetings to embed", len(missing)
            )

            for mid in missing:
                try:
                    await embed_meeting(db_path, mid, gemini_api_key)
                except Exception as e:
                    logger.warning(
                        "[embeddings] backfill %s failed: %s", mid, e
                    )
                _backfill_state["indexed_this_run"] += 1
                _backfill_state["remaining_this_run"] = max(
                    0, len(missing) - _backfill_state["indexed_this_run"]
                )

            return await status(db_path)
        finally:
            _backfill_state["in_progress"] = False


async def search(
    db_path: str,
    query: str,
    gemini_api_key: str,
    top_k: int = 10,
) -> list[dict]:
    """Embed `query` (using task_type=RETRIEVAL_QUERY for asymmetric
    retrieval) and ANN-search the vec0 index. Returns top_k hits
    joined with meeting metadata, each shape:

      {
        "meeting_id": str,
        "meeting_title": str,
        "meeting_created_at": str,
        "kind": "transcript" | "summary",
        "text": str,            # the chunk text
        "snippet": str,         # first ~200 chars, for display
        "start_timestamp": str | None,
        "distance": float,      # vec0 distance (lower = better)
      }
    """
    if not query or not query.strip():
        return []
    if not gemini_api_key:
        raise RuntimeError("GEMINI_API_KEY not configured")

    client = genai.Client(api_key=gemini_api_key)
    # Asymmetric retrieval: query gets RETRIEVAL_QUERY task_type so its
    # embedding lives in the same space as our RETRIEVAL_DOCUMENT
    # chunks. Mismatched task_types degrade recall noticeably.
    cfg = genai_types.EmbedContentConfig(
        output_dimensionality=EMBED_DIM,
        task_type="RETRIEVAL_QUERY",
    )
    resp = await client.aio.models.embed_content(
        model=EMBED_MODEL,
        contents=[query.strip()],
        config=cfg,
    )
    if not resp.embeddings or len(resp.embeddings[0].values) != EMBED_DIM:
        raise RuntimeError("query embedding failed")
    qvec = _pack_embedding(list(resp.embeddings[0].values))

    # Phase 8 Task 1: cost log for the query embed. Token count comes
    # from usage_metadata when present; otherwise estimate from input
    # length (4 chars/tok rough heuristic, only used as a fallback).
    try:
        import costs as _costs  # noqa: E402
        in_tok, _ = _costs.extract_usage_from_response(resp)
        if in_tok == 0:
            in_tok = max(1, len(query) // 4)
        await _costs.record_usage(
            db_path,
            _costs.Usage(
                endpoint="embed_query",
                model=EMBED_MODEL,
                input_tokens=in_tok,
            ),
        )
    except Exception as cost_err:
        logger.warning("[embeddings.search] cost log failed: %s", cost_err)

    def _do() -> list[dict]:
        with _open(db_path) as conn:
            # vec0's MATCH operator returns rows ordered by distance
            # ascending. Join back to transcript_embeddings on rowid
            # for the text + metadata, then to meetings for the
            # display title.
            rows = conn.execute(
                """
                SELECT
                    te.meeting_id,
                    te.kind,
                    te.text,
                    te.start_timestamp,
                    m.title,
                    m.created_at,
                    v.distance
                FROM transcript_embeddings_vec v
                JOIN transcript_embeddings te ON te.id = v.rowid
                LEFT JOIN meetings m ON m.id = te.meeting_id
                WHERE v.embedding MATCH ? AND k = ?
                ORDER BY v.distance
                """,
                (qvec, top_k),
            ).fetchall()
        out = []
        for r in rows:
            text = r[2] or ""
            snippet = text[:220].rstrip()
            if len(text) > 220:
                snippet += "…"
            out.append({
                "meeting_id": r[0],
                "kind": r[1],
                "text": text,
                "start_timestamp": r[3],
                "meeting_title": r[4] or "(untitled)",
                "meeting_created_at": r[5],
                "snippet": snippet,
                "distance": float(r[6]),
            })
        return out

    return await asyncio.to_thread(_do)


async def fetch_meeting_chunks(
    db_path: str,
    meeting_ids: list[str],
    max_per_meeting: int = 6,
    prefer_summary: bool = True,
) -> list[dict]:
    """Fetch chunks for specific meetings WITHOUT vector search.

    Used by the date-scoped and single-meeting `/ask` paths, where the
    candidate set is already narrowed by an exact filter. Running ANN
    search there would be both wasteful and wrong: for "how did my day
    go?" we want *everything* that happened in the window, not the
    handful of chunks that happen to sit nearest the question vector.

    `prefer_summary` puts AI-summary chunks first within each meeting.
    They're already condensed, so when `max_per_meeting` forces a trim
    we keep the highest-signal content and drop raw transcript tail.

    Returns the same dict shape as `search()`, with `distance` set to
    0.0 (there is no vector distance on this path).
    """
    if not meeting_ids:
        return []

    def _do() -> list[dict]:
        placeholders = ",".join("?" for _ in meeting_ids)
        with _open(db_path) as conn:
            rows = conn.execute(
                f"""
                SELECT
                    te.meeting_id,
                    te.kind,
                    te.text,
                    te.start_timestamp,
                    m.title,
                    m.created_at,
                    te.chunk_idx
                FROM transcript_embeddings te
                LEFT JOIN meetings m ON m.id = te.meeting_id
                WHERE te.meeting_id IN ({placeholders})
                ORDER BY m.created_at DESC, te.chunk_idx ASC
                """,
                tuple(meeting_ids),
            ).fetchall()

        # Group by meeting so the per-meeting cap applies independently.
        by_meeting: dict[str, list] = {}
        for r in rows:
            by_meeting.setdefault(r[0], []).append(r)

        out = []
        # Preserve the meeting_ids ordering the caller gave us (newest
        # first, typically) rather than dict insertion order.
        for mid in meeting_ids:
            group = by_meeting.get(mid)
            if not group:
                continue
            if prefer_summary:
                group = sorted(group, key=lambda r: (0 if r[1] == "summary" else 1, r[6]))
            for r in group[:max_per_meeting]:
                text = r[2] or ""
                snippet = text[:220].rstrip()
                if len(text) > 220:
                    snippet += "…"
                out.append({
                    "meeting_id": r[0],
                    "kind": r[1],
                    "text": text,
                    "start_timestamp": r[3],
                    "meeting_title": r[4] or "(untitled)",
                    "meeting_created_at": r[5],
                    "snippet": snippet,
                    "distance": 0.0,
                })
        return out

    return await asyncio.to_thread(_do)


async def search_within_meetings(
    db_path: str,
    query: str,
    gemini_api_key: str,
    meeting_ids: list[str],
    top_k: int = 10,
) -> list[dict]:
    """Semantic search restricted to a set of meetings.

    sqlite-vec's `MATCH ... AND k = ?` doesn't support pushing an
    arbitrary WHERE clause into the ANN scan, so we over-fetch and
    filter in Python. The over-fetch factor is generous because the
    target meetings may rank poorly against the global corpus — the
    whole point of scoping is that the user cares about these meetings
    regardless of how they compare to everything else.

    Falls back to `fetch_meeting_chunks` when the filtered result is
    thin, so a scoped question never comes back empty-handed just
    because the ANN neighborhood missed.
    """
    if not meeting_ids:
        return []

    wanted = set(meeting_ids)
    # Scale the over-fetch with how narrow the filter is, capped so we
    # don't drag the entire index through Python for a huge corpus.
    over_fetch = min(400, max(top_k * 10, 100))

    try:
        hits = await search(db_path, query, gemini_api_key, top_k=over_fetch)
    except Exception as e:
        logger.warning(
            "[embeddings] scoped ANN search failed (%s); "
            "falling back to direct chunk fetch",
            e,
        )
        return await fetch_meeting_chunks(db_path, meeting_ids)

    filtered = [h for h in hits if h["meeting_id"] in wanted][:top_k]

    # If ANN surfaced little or nothing from the scoped set, fall back
    # to reading those meetings directly.
    if len(filtered) < min(3, top_k):
        return await fetch_meeting_chunks(db_path, meeting_ids)
    return filtered


async def delete_meeting_embeddings(db_path: str, meeting_id: str) -> None:
    """Called from /delete-meeting so the FK-less embedding tables
    don't accumulate orphan rows."""
    def _do():
        with _open(db_path) as conn:
            cur = conn.cursor()
            prior_ids = [
                r[0]
                for r in cur.execute(
                    "SELECT id FROM transcript_embeddings "
                    "WHERE meeting_id = ?",
                    (meeting_id,),
                )
            ]
            if prior_ids:
                qmarks = ",".join("?" * len(prior_ids))
                cur.execute(
                    f"DELETE FROM transcript_embeddings_vec "
                    f"WHERE rowid IN ({qmarks})",
                    prior_ids,
                )
                cur.execute(
                    "DELETE FROM transcript_embeddings WHERE meeting_id = ?",
                    (meeting_id,),
                )
                conn.commit()
    await asyncio.to_thread(_do)
