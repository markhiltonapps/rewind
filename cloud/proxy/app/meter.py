"""Usage metering and cost estimation for the rewind-proxy service.

Pricing is derived from Gemini 2.5 Flash constants defined in
backend/app/costs.py (and verified against https://ai.google.dev/pricing):

  Audio input:  $1.00 / 1M tokens  (≈ 32 tokens per audio-second)
  Text  input:  $0.30 / 1M tokens  (Flash text, used for summarize)
  Embed input:  $0.15 / 1M tokens  (gemini-embedding-001)

USD_PER_AUDIO_SECOND = (32 tokens/sec * $1.00) / 1_000_000 = 0.000032
USD_PER_TOKEN        = $0.30 / 1_000_000 = 3e-7
  (embed is cheaper at $0.15/1M but we use a single blended constant here;
   callers that need per-model precision should compute directly from costs.py)
"""

from app.auth import AuthedUser

# ---------------------------------------------------------------------------
# Pricing constants  — source: backend/app/costs.py + ai.google.dev/pricing
# ---------------------------------------------------------------------------

# Audio: Gemini 2.5 Flash prices audio input at $1.00/1M tokens.
# Flash transcribes at ~32 tokens per audio-second, so:
#   $1.00 / 1_000_000 tokens  *  32 tokens/sec  =  $0.000032 / sec
USD_PER_AUDIO_SECOND: float = 32.0 * 1.00 / 1_000_000   # 3.2e-05

# Text/token: Flash text input is $0.30/1M tokens (costs.py: PRICE_FLASH_TEXT_INPUT_PER_M).
# Used for both "summarize" (text) and "embed" (embed rate is $0.15/1M — slightly
# conservative / over-estimates embed; acceptable for a single-constant proxy meter).
USD_PER_TOKEN: float = 0.30 / 1_000_000                  # 3e-07


# ---------------------------------------------------------------------------
# Pure cost calculation  (no I/O — easy to unit-test)
# ---------------------------------------------------------------------------

def estimate_cost(kind: str, raw_units: float) -> float:
    """Return estimated USD cost for a single proxy call.

    Args:
        kind:       "transcribe"  → raw_units are audio seconds
                    "summarize"   → raw_units are tokens
                    "embed"       → raw_units are tokens
        raw_units:  numeric quantity of the unit above.

    Raises:
        ValueError: if kind is not recognised.
    """
    if kind == "transcribe":
        return raw_units * USD_PER_AUDIO_SECOND
    if kind in ("summarize", "embed"):
        return raw_units * USD_PER_TOKEN
    raise ValueError(f"Unknown kind: {kind!r}. Expected 'transcribe', 'summarize', or 'embed'.")


# ---------------------------------------------------------------------------
# Async record
# ---------------------------------------------------------------------------

async def record_usage(db, user: AuthedUser, kind: str, raw_units: float) -> None:
    """Compute cost estimate and persist a usage row via db.insert_usage."""
    est = estimate_cost(kind, raw_units)
    await db.insert_usage(
        user_id=user.user_id,
        email=user.email,
        kind=kind,
        raw_units=raw_units,
        est_cost_usd=est,
    )
