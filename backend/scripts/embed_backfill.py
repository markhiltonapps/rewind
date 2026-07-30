"""Phase 7 Task 1: CLI entrypoint for the RAG embedding backfill.

Walks every meeting in the local meeting_minutes.db, chunks its
transcript + summary, and writes the Gemini text-embedding-004
vectors into transcript_embeddings + transcript_embeddings_vec.

Usage (from the backend dir):

    python scripts/embed_backfill.py
    python scripts/embed_backfill.py --db /path/to/meeting_minutes.db
    python scripts/embed_backfill.py --only meeting-1778270149470

Requires:
  * GEMINI_API_KEY in env, OR a settings row with geminiApiKey set.
  * sqlite-vec installed (pip install -r requirements.txt).

Idempotent: re-running re-embeds every meeting, replacing the
existing chunks. Safe to re-run anytime.
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import os
import sqlite3
import sys
from pathlib import Path

# Make `import embeddings` work whether the script is run as
# `python scripts/embed_backfill.py` or as a module.
_BACKEND_APP = Path(__file__).resolve().parent.parent / "app"
sys.path.insert(0, str(_BACKEND_APP))

import embeddings  # noqa: E402

# Load backend/.env so GEMINI_API_KEY is available when the user has
# only configured it via the env file (not in the settings row). The
# running backend does this via load_dotenv() at import; we replicate
# that here so the CLI script doesn't lie about "no key" when there is
# one ten feet away.
try:
    from dotenv import load_dotenv
    _ENV_PATH = Path(__file__).resolve().parent.parent / ".env"
    if _ENV_PATH.exists():
        load_dotenv(_ENV_PATH)
except Exception:
    pass

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("embed_backfill")


def _resolve_api_key(db_path: str) -> str:
    """env var first, then settings row."""
    env = os.environ.get("GEMINI_API_KEY")
    if env:
        return env
    try:
        with sqlite3.connect(db_path) as conn:
            row = conn.execute(
                "SELECT geminiApiKey FROM settings WHERE id = '1'"
            ).fetchone()
            if row and row[0]:
                return row[0]
    except Exception:
        pass
    raise SystemExit(
        "GEMINI_API_KEY not found in env or settings row. "
        "Set GEMINI_API_KEY before running."
    )


async def _main_async(db_path: str, only: str | None) -> int:
    embeddings.init_schema(db_path)
    key = _resolve_api_key(db_path)

    if only:
        n = await embeddings.embed_meeting(db_path, only, key)
        logger.info("embedded %d chunk(s) for %s", n, only)
        return 0

    st = await embeddings.status(db_path)
    logger.info(
        "starting backfill — indexed=%d total=%d", st["indexed"], st["total"]
    )
    final = await embeddings.backfill(db_path, key)
    logger.info(
        "backfill done — indexed=%d total=%d", final["indexed"], final["total"]
    )
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Backfill RAG embeddings for meetings."
    )
    parser.add_argument(
        "--db",
        default=str(Path(__file__).resolve().parent.parent / "meeting_minutes.db"),
        help="Path to meeting_minutes.db",
    )
    parser.add_argument(
        "--only",
        default=None,
        help="If set, embed only this meeting_id (skip everything else)",
    )
    args = parser.parse_args()
    if not Path(args.db).exists():
        raise SystemExit(f"DB not found: {args.db}")
    return asyncio.run(_main_async(args.db, args.only))


if __name__ == "__main__":
    raise SystemExit(main())
