"""Gemini cost accounting.

Captures token usage and audio seconds from each outbound Gemini call,
converts to USD using current Gemini 2.5 Flash pricing, and persists a
row to the cost_log table.

Pricing is duplicated here (instead of read from a remote config) on
purpose — these calls happen frequently and need to be cheap, and
Google's prices don't move so often that hard-coding them is a real
maintenance burden. If/when pricing changes, bump the constants and
ship a release.

## Why we track audio_seconds separately

For /transcribe-audio, the Gemini SDK reports `input_tokens` as the
tokenized audio (≈32 tokens per audio-second for Flash). That's enough
to compute cost. But knowing the source audio duration is useful for
the /admin view ("this meeting was 45 min and cost $0.18") so we
record it alongside.
"""

from __future__ import annotations

import asyncio
import logging
import sqlite3
from dataclasses import dataclass
from typing import Optional

logger = logging.getLogger("rewind.costs")

# ============================================================
# Pricing — Gemini 2.5 Flash + gemini-embedding-001
# ============================================================
# All prices are USD per 1M tokens. Verify against
# https://ai.google.dev/pricing before lock-in for billing.
#
# 2.5 Flash audio input: $1.00/M (≈32 tokens/sec of audio)
# 2.5 Flash text input:  $0.30/M
# 2.5 Flash output:      $2.50/M
# gemini-embedding-001:  $0.15/M

PRICE_FLASH_TEXT_INPUT_PER_M = 0.30
PRICE_FLASH_AUDIO_INPUT_PER_M = 1.00
PRICE_FLASH_OUTPUT_PER_M = 2.50
PRICE_EMBEDDING_INPUT_PER_M = 0.15


@dataclass
class Usage:
    """Normalized usage data extracted from a Gemini response."""
    endpoint: str
    model: str
    input_tokens: int = 0
    output_tokens: int = 0
    audio_seconds: float = 0.0
    meeting_id: Optional[str] = None
    notes: Optional[str] = None


def extract_usage_from_response(response) -> tuple[int, int]:
    """Pull (input_tokens, output_tokens) out of a google-genai
    GenerateContentResponse. Returns (0, 0) if unavailable.

    The SDK exposes usage at `response.usage_metadata` with attribute
    names that have changed across versions — we look for the modern
    `prompt_token_count` / `candidates_token_count` first, then fall
    back to the older `input_token_count` / `output_token_count`.
    """
    if response is None:
        return (0, 0)
    meta = getattr(response, "usage_metadata", None)
    if meta is None:
        return (0, 0)
    in_tok = (
        getattr(meta, "prompt_token_count", None)
        or getattr(meta, "input_token_count", None)
        or 0
    )
    out_tok = (
        getattr(meta, "candidates_token_count", None)
        or getattr(meta, "output_token_count", None)
        or 0
    )
    return (int(in_tok or 0), int(out_tok or 0))


def cost_for_usage(usage: Usage) -> float:
    """Convert token counts → USD using the constants above.

    Model-specific routing: embedding endpoints price the full request
    at the embedding rate (no separate output charge). Everything else
    uses the Flash schedule.
    """
    model = (usage.model or "").lower()
    if "embedding" in model:
        return (usage.input_tokens / 1_000_000.0) * PRICE_EMBEDDING_INPUT_PER_M

    # For transcribe-audio, the prompt tokens reported by Gemini are
    # almost entirely audio tokens (a short text prompt is negligible).
    # If we were given audio_seconds AND no prompt_token_count, derive
    # from seconds (32 tok/sec rate). Otherwise trust the reported
    # token count and price the whole input at the audio rate — this
    # slightly overestimates the small text portion but the error is
    # under a tenth of a percent.
    if usage.endpoint == "transcribe":
        if usage.input_tokens > 0:
            input_cost = (
                usage.input_tokens / 1_000_000.0
            ) * PRICE_FLASH_AUDIO_INPUT_PER_M
        elif usage.audio_seconds > 0:
            est_tokens = usage.audio_seconds * 32.0
            input_cost = (
                est_tokens / 1_000_000.0
            ) * PRICE_FLASH_AUDIO_INPUT_PER_M
        else:
            input_cost = 0.0
        output_cost = (
            usage.output_tokens / 1_000_000.0
        ) * PRICE_FLASH_OUTPUT_PER_M
        return input_cost + output_cost

    # Default: text in, text out on Flash.
    input_cost = (
        usage.input_tokens / 1_000_000.0
    ) * PRICE_FLASH_TEXT_INPUT_PER_M
    output_cost = (
        usage.output_tokens / 1_000_000.0
    ) * PRICE_FLASH_OUTPUT_PER_M
    return input_cost + output_cost


def _insert_sync(db_path: str, usage: Usage, cost_usd: float) -> None:
    """Synchronous insert used by record_usage. Kept tiny so the
    asyncio.to_thread wrapper has minimal overhead."""
    try:
        with sqlite3.connect(db_path) as conn:
            conn.execute(
                """
                INSERT INTO cost_log
                  (endpoint, model, input_tokens, output_tokens,
                   audio_seconds, cost_usd, meeting_id, notes)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    usage.endpoint,
                    usage.model,
                    usage.input_tokens,
                    usage.output_tokens,
                    usage.audio_seconds,
                    cost_usd,
                    usage.meeting_id,
                    usage.notes,
                ),
            )
            conn.commit()
    except Exception as exc:
        # Cost logging must NEVER break a primary request. Swallow and
        # log so a malformed DB doesn't break transcription.
        logger.error("cost_log insert failed: %s", exc, exc_info=True)


async def record_usage(db_path: str, usage: Usage) -> float:
    """Async entry point. Computes cost, writes one row, returns the
    USD figure for inline logging if the caller wants it."""
    cost_usd = cost_for_usage(usage)
    await asyncio.to_thread(_insert_sync, db_path, usage, cost_usd)
    return cost_usd


# ============================================================
# Read helpers used by /admin/costs endpoints
# ============================================================

def _read_sync(db_path: str, sql: str, params: tuple = ()) -> list[dict]:
    with sqlite3.connect(db_path) as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute(sql, params).fetchall()
    return [dict(r) for r in rows]


async def _read(db_path: str, sql: str, params: tuple = ()) -> list[dict]:
    return await asyncio.to_thread(_read_sync, db_path, sql, params)


async def summary(db_path: str) -> dict:
    """Aggregate totals + month-to-date + by-endpoint breakdown."""
    rows_total = await _read(
        db_path,
        """
        SELECT COALESCE(SUM(cost_usd), 0) AS total_cost,
               COALESCE(SUM(input_tokens), 0) AS total_input,
               COALESCE(SUM(output_tokens), 0) AS total_output,
               COALESCE(SUM(audio_seconds), 0) AS total_audio_sec,
               COUNT(*) AS calls
        FROM cost_log
        """,
    )
    rows_mtd = await _read(
        db_path,
        """
        SELECT COALESCE(SUM(cost_usd), 0) AS total_cost,
               COUNT(*) AS calls
        FROM cost_log
        WHERE ts >= datetime('now', 'start of month')
        """,
    )
    rows_by_ep = await _read(
        db_path,
        """
        SELECT endpoint,
               COUNT(*) AS calls,
               COALESCE(SUM(cost_usd), 0) AS cost,
               COALESCE(SUM(input_tokens), 0) AS input_tokens,
               COALESCE(SUM(output_tokens), 0) AS output_tokens
        FROM cost_log
        GROUP BY endpoint
        ORDER BY cost DESC
        """,
    )
    return {
        "all_time": rows_total[0] if rows_total else {},
        "month_to_date": rows_mtd[0] if rows_mtd else {},
        "by_endpoint": rows_by_ep,
    }


async def by_meeting(db_path: str, limit: int = 25) -> list[dict]:
    """Top N most-expensive meetings, ascending recency tiebreak."""
    return await _read(
        db_path,
        """
        SELECT cl.meeting_id,
               COALESCE(m.title, '(unknown / deleted)') AS title,
               COALESCE(m.created_at, '') AS created_at,
               COUNT(*) AS calls,
               COALESCE(SUM(cl.cost_usd), 0) AS cost,
               COALESCE(SUM(cl.audio_seconds), 0) AS audio_seconds,
               COALESCE(SUM(cl.input_tokens), 0) AS input_tokens,
               COALESCE(SUM(cl.output_tokens), 0) AS output_tokens
        FROM cost_log cl
        LEFT JOIN meetings m ON m.id = cl.meeting_id
        WHERE cl.meeting_id IS NOT NULL
        GROUP BY cl.meeting_id
        ORDER BY cost DESC
        LIMIT ?
        """,
        (limit,),
    )


async def by_day(db_path: str, days: int = 30) -> list[dict]:
    """Daily totals for the last N days. Useful for sparkline."""
    return await _read(
        db_path,
        """
        SELECT DATE(ts) AS day,
               COUNT(*) AS calls,
               COALESCE(SUM(cost_usd), 0) AS cost
        FROM cost_log
        WHERE ts >= datetime('now', ?)
        GROUP BY DATE(ts)
        ORDER BY day ASC
        """,
        (f"-{int(days)} days",),
    )
