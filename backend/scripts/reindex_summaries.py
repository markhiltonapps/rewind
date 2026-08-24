"""Re-index meetings whose summaries were never embedded.

Why this is needed
------------------
`_gather_meeting_text` filtered on `status = 'COMPLETED'` while every
write path stores lowercase `'completed'`, so no summary was ever
embedded. Ask has only ever searched raw transcripts.

Fixing the comparison isn't enough on its own. `/embeddings/backfill`
selects meetings with NO chunks at all:

    LEFT JOIN transcript_embeddings e ON e.meeting_id = m.id
    WHERE e.id IS NULL

Affected meetings already have transcript chunks, so backfill skips
them and their summaries stay missing forever. This script targets
exactly the meetings that have a completed summary but no chunk of
kind='summary', and re-embeds each through
`POST /embeddings/embed/{meeting_id}` (delete-then-insert, so it is
safe to re-run).

Requires the v0.1.2+ backend to be running -- on an older build the
case-sensitive filter still applies and summaries would be skipped
again. The script checks for this and refuses to run blind.

Superseded by /embeddings/backfill
---------------------------------
As of v0.1.8 backfill selects meetings whose index is INCOMPLETE, not
just meetings with no chunks at all, so it repairs this on its own:

    Invoke-RestMethod -Method Post -Uri http://localhost:5167/embeddings/backfill

This script is kept for the case where you want to re-index a bounded
subset (--limit) and watch it meeting by meeting.

Usage
-----
    python scripts/reindex_summaries.py            # re-index what's missing
    python scripts/reindex_summaries.py --dry-run  # just report
    python scripts/reindex_summaries.py --limit 10 # try a few first
"""

from __future__ import annotations

import argparse
import os
import sqlite3
import sys
import time
from pathlib import Path

import requests

BACKEND_URL = os.environ.get("REWIND_BACKEND", "http://127.0.0.1:5167")


def db_path() -> Path:
    appdata = os.environ.get("APPDATA")
    if appdata:
        p = Path(appdata) / "com.neatoventures.rewind" / "meeting_minutes.db"
        if p.is_file():
            return p
    return Path("meeting_minutes.db")


def find_missing(con: sqlite3.Connection) -> list[tuple[str, str]]:
    """Meetings with a completed summary but no summary chunk indexed."""
    return con.execute(
        """
        SELECT m.id, m.title
        FROM meetings m
        JOIN summary_processes s
          ON s.meeting_id = m.id
         AND UPPER(s.status) = 'COMPLETED'
         AND TRIM(COALESCE(s.result, '')) <> ''
        WHERE NOT EXISTS (
            SELECT 1 FROM transcript_embeddings e
            WHERE e.meeting_id = m.id AND e.kind = 'summary'
        )
        ORDER BY m.created_at DESC
        """
    ).fetchall()


def probe_one(meeting_id: str, path: Path) -> bool:
    """Re-index ONE meeting and confirm a summary chunk actually appeared.

    There is no version endpoint, and route-sniffing can't distinguish
    the builds that matter here: the fix was a change to a SQL
    comparison, not a new route. So rather than guess, embed a single
    meeting and look at the result. On an older backend this costs one
    wasted call instead of 179.
    """
    try:
        r = requests.post(
            f"{BACKEND_URL}/embeddings/embed/{meeting_id}", timeout=300
        )
        if not r.ok:
            print(f"  probe failed: HTTP {r.status_code} {r.text[:200]}",
                  file=sys.stderr)
            return False
    except requests.RequestException as e:
        print(f"  probe failed: {e}", file=sys.stderr)
        return False

    con = sqlite3.connect(str(path))
    n = con.execute(
        "SELECT COUNT(*) FROM transcript_embeddings "
        "WHERE meeting_id = ? AND kind = 'summary'",
        (meeting_id,),
    ).fetchone()[0]
    con.close()
    return n > 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--db", default=None)
    args = ap.parse_args()

    path = Path(args.db) if args.db else db_path()
    if not path.is_file():
        print(f"Database not found: {path}", file=sys.stderr)
        return 1
    print(f"DB: {path}")

    con = sqlite3.connect(str(path))
    missing = find_missing(con)

    total_summaries = con.execute(
        "SELECT COUNT(*) FROM summary_processes "
        "WHERE UPPER(status)='COMPLETED' AND TRIM(COALESCE(result,'')) <> ''"
    ).fetchone()[0]
    summary_chunks = con.execute(
        "SELECT COUNT(*) FROM transcript_embeddings WHERE kind='summary'"
    ).fetchone()[0]
    con.close()

    print(f"meetings with a completed summary : {total_summaries}")
    print(f"summary chunks currently indexed  : {summary_chunks}")
    print(f"meetings missing summary chunks   : {len(missing)}")
    print()

    if not missing:
        print("Nothing to do.")
        return 0

    if args.limit:
        missing = missing[: args.limit]
        print(f"(limited to {len(missing)})")

    if args.dry_run:
        for mid, title in missing[:20]:
            print(f"  would re-index {mid}  {title[:60]}")
        if len(missing) > 20:
            print(f"  ... and {len(missing) - 20} more")
        return 0

    # Prove the running backend actually indexes summaries before
    # spending ~180 re-embeds finding out that it doesn't.
    probe_id, probe_title = missing[0]
    print(f"Probing with one meeting: {probe_title[:60]}")
    if not probe_one(probe_id, path):
        print(
            "\nThat meeting re-indexed without producing a summary chunk, "
            "which means this backend still has the summary-indexing bug "
            "(fixed in v0.1.2). Install the latest app, restart it, and "
            "re-run this script.",
            file=sys.stderr,
        )
        return 1
    print("  probe OK -- summaries are being indexed\n")
    missing = missing[1:]
    if not missing:
        print("That was the only one. Done.")
        return 0

    print(f"Re-indexing {len(missing)} more meetings via {BACKEND_URL} ...")
    print("(each re-embeds the whole meeting, so this takes a moment each)")
    ok = 1  # the probe counts
    failed = 0
    started = time.time()
    for i, (mid, title) in enumerate(missing, start=1):
        try:
            r = requests.post(
                f"{BACKEND_URL}/embeddings/embed/{mid}", timeout=300
            )
            if r.ok:
                ok += 1
                status = "ok"
            else:
                failed += 1
                status = f"HTTP {r.status_code}"
        except requests.RequestException as e:
            failed += 1
            status = f"error: {e}"
        print(f"  [{i}/{len(missing)}] {title[:52]:<52} {status}", flush=True)

    print()
    print(f"Done in {time.time() - started:.0f}s -- {ok} re-indexed, {failed} failed")

    con = sqlite3.connect(str(path))
    now = con.execute(
        "SELECT COUNT(*) FROM transcript_embeddings WHERE kind='summary'"
    ).fetchone()[0]
    con.close()
    print(f"summary chunks now indexed: {now} (was {summary_chunks})")
    if now <= summary_chunks:
        print(
            "No new summary chunks appeared. The backend is probably still "
            "an older build.",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
