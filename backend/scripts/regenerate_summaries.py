"""Regenerate meeting summaries in bulk with the current prompt.

The summary prompt lives server-side (cloud/proxy/app/gemini.py), so a
prompt improvement applies to every summary generated from then on --
but it does not rewrite summaries that already exist. The app's
Regenerate button redoes one meeting at a time, which is fine for a
handful and tedious for a hundred.

This drives the same endpoint the button does, over a chosen set of
meetings.

Regenerating also re-indexes the meeting for search, so a regenerated
meeting does NOT additionally need reindex_summaries.py. Use that script
only for meetings you want searchable without paying to re-summarize.

Usage
-----
    python scripts/regenerate_summaries.py --dry-run
    python scripts/regenerate_summaries.py --limit 5        # try a few
    python scripts/regenerate_summaries.py --since 2026-08-01
    python scripts/regenerate_summaries.py --all            # everything
    python scripts/regenerate_summaries.py --id meeting-123 --id meeting-456

Defaults to --dry-run behaviour if no selector is given, so a bare run
can't spend money by accident.
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
# Matches what the app sends from page-content.tsx.
MODEL = "gemini"
MODEL_NAME = "gemini-2.5-flash"


def db_path() -> Path:
    appdata = os.environ.get("APPDATA")
    if appdata:
        p = Path(appdata) / "com.neatoventures.rewind" / "meeting_minutes.db"
        if p.is_file():
            return p
    return Path("meeting_minutes.db")


def select_meetings(con, args) -> list[tuple[str, str, str]]:
    """(id, title, created_at) for the meetings the flags select."""
    if args.id:
        marks = ",".join("?" for _ in args.id)
        rows = con.execute(
            f"SELECT id, title, created_at FROM meetings WHERE id IN ({marks})",
            tuple(args.id),
        ).fetchall()
    else:
        sql = """
            SELECT m.id, m.title, m.created_at
            FROM meetings m
            WHERE EXISTS (
                SELECT 1 FROM transcripts t
                WHERE t.meeting_id = m.id
                  AND TRIM(COALESCE(t.transcript, '')) <> ''
            )
        """
        params: list = []
        if args.since:
            sql += " AND m.created_at >= ?"
            params.append(args.since)
        sql += " ORDER BY m.created_at DESC"
        rows = con.execute(sql, tuple(params)).fetchall()
    if args.limit:
        rows = rows[: args.limit]
    return rows


def transcript_for(con, meeting_id: str) -> str:
    rows = con.execute(
        "SELECT transcript FROM transcripts WHERE meeting_id = ? ORDER BY id",
        (meeting_id,),
    ).fetchall()
    return "\n".join(r[0] or "" for r in rows).strip()


def regenerate(meeting_id: str, text: str, timeout: float = 900.0) -> tuple[bool, str]:
    """POST /process-transcript, then poll /get-summary until it settles."""
    try:
        r = requests.post(
            f"{BACKEND_URL}/process-transcript",
            json={
                "text": text,
                "model": MODEL,
                "model_name": MODEL_NAME,
                "meeting_id": meeting_id,
                "chunk_size": 40000,
                "overlap": 1000,
            },
            timeout=120,
        )
        if not r.ok:
            return False, f"HTTP {r.status_code}: {r.text[:160]}"
        process_id = r.json().get("process_id")
        if not process_id:
            return False, "no process_id returned"
    except requests.RequestException as e:
        return False, f"request failed: {e}"

    started = time.time()
    while time.time() - started < timeout:
        time.sleep(5)
        try:
            s = requests.get(f"{BACKEND_URL}/get-summary/{process_id}", timeout=60)
            if s.status_code == 202:
                continue
            body = s.json()
            status = body.get("status")
            if status == "error":
                return False, str(body.get("error"))[:160]
            if status == "completed":
                data = body.get("data") or {}
                filled = sum(
                    1
                    for k, v in data.items()
                    if isinstance(v, dict) and v.get("blocks")
                )
                return True, f"{filled} sections"
        except requests.RequestException:
            continue  # transient; keep polling
    return False, "timed out"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--all", action="store_true", help="every meeting with a transcript")
    ap.add_argument("--since", help="only meetings created on/after YYYY-MM-DD")
    ap.add_argument("--id", action="append", help="specific meeting id (repeatable)")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--db", default=None)
    args = ap.parse_args()

    if not (args.all or args.since or args.id):
        print("Pick what to regenerate: --all, --since YYYY-MM-DD, or --id <id>.")
        print("Add --dry-run first to see the list.\n")
        ap.print_help()
        return 1

    path = Path(args.db) if args.db else db_path()
    if not path.is_file():
        print(f"Database not found: {path}", file=sys.stderr)
        return 1

    con = sqlite3.connect(str(path))
    rows = select_meetings(con, args)
    print(f"DB: {path}")
    print(f"selected {len(rows)} meetings\n")

    if args.dry_run:
        for mid, title, created in rows[:40]:
            print(f"  {created[:10]}  {title[:58]}")
        if len(rows) > 40:
            print(f"  ... and {len(rows) - 40} more")
        print("\n--dry-run: nothing regenerated.")
        con.close()
        return 0

    ok = failed = skipped = 0
    started = time.time()
    for i, (mid, title, created) in enumerate(rows, start=1):
        text = transcript_for(con, mid)
        if not text:
            skipped += 1
            print(f"  [{i}/{len(rows)}] {title[:48]:<48} skipped (no transcript)")
            continue
        good, detail = regenerate(mid, text)
        if good:
            ok += 1
        else:
            failed += 1
        print(f"  [{i}/{len(rows)}] {title[:48]:<48} "
              f"{'ok' if good else 'FAILED'} ({detail})", flush=True)

    con.close()
    print()
    print(f"Done in {time.time() - started:.0f}s -- "
          f"{ok} regenerated, {failed} failed, {skipped} skipped")
    print("Regenerated meetings are re-indexed for search automatically.")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
