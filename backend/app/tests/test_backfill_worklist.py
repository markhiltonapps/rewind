"""Tests for the backfill work-list query.

Backfill used to ask "does this meeting have any chunks?" rather than
"is this meeting's index complete?". A meeting whose transcript was
embedded but whose summary was not already had rows, so it was skipped
forever and the index could never be repaired.

On a live database that meant 176 meetings with completed summaries and
no summary chunks, while backfill reported nothing to do.

The query is exercised against a temporary SQLite file rather than
mocked, because the bug was in the SQL itself.
"""

from __future__ import annotations

import re
import sqlite3
from pathlib import Path

import pytest

SRC = Path(__file__).resolve().parents[1] / "embeddings.py"


def _predicate() -> str:
    """The real _HAS_EMBEDDABLE_CONTENT, read from the module source."""
    return re.search(
        r'_HAS_EMBEDDABLE_CONTENT = """(.*?)"""', SRC.read_text(encoding="utf-8"), re.S
    ).group(1)


def _worklist_sql() -> str:
    """The real work-list query, extracted from backfill()."""
    src = SRC.read_text(encoding="utf-8")
    body = src[src.index("async def backfill("):]
    sql = re.search(r'f"""\s*(SELECT m\.id FROM meetings m.*?)"""', body, re.S).group(1)
    return sql.replace("{_HAS_EMBEDDABLE_CONTENT}", _predicate())


@pytest.fixture()
def db(tmp_path):
    con = sqlite3.connect(tmp_path / "t.db")
    con.executescript(
        """
        CREATE TABLE meetings (id TEXT PRIMARY KEY, title TEXT, created_at TEXT);
        CREATE TABLE transcripts (id INTEGER PRIMARY KEY, meeting_id TEXT, transcript TEXT);
        CREATE TABLE summary_processes (meeting_id TEXT PRIMARY KEY, status TEXT, result TEXT);
        CREATE TABLE transcript_embeddings (
            id INTEGER PRIMARY KEY, meeting_id TEXT, kind TEXT
        );
        """
    )
    yield con
    con.close()


def add_meeting(con, mid, *, transcript=True, summary=None, chunks=()):
    con.execute("INSERT INTO meetings VALUES (?,?,?)", (mid, mid, "2026-08-01"))
    if transcript:
        con.execute("INSERT INTO transcripts (meeting_id, transcript) VALUES (?,?)",
                    (mid, "some words"))
    if summary is not None:
        con.execute("INSERT INTO summary_processes VALUES (?,?,?)", (mid, *summary))
    for kind in chunks:
        con.execute("INSERT INTO transcript_embeddings (meeting_id, kind) VALUES (?,?)",
                    (mid, kind))
    con.commit()


def worklist(con):
    return {r[0] for r in con.execute(_worklist_sql())}


def test_unindexed_meeting_is_picked_up(db):
    add_meeting(db, "never-indexed")
    assert worklist(db) == {"never-indexed"}


def test_meeting_missing_only_its_summary_is_picked_up(db):
    # The regression: transcript chunks exist, so the old query skipped it.
    add_meeting(db, "partial",
                summary=("completed", '{"BottomLine": {}}'),
                chunks=("transcript", "transcript"))
    assert "partial" in worklist(db)


def test_fully_indexed_meeting_is_left_alone(db):
    add_meeting(db, "done",
                summary=("completed", '{"BottomLine": {}}'),
                chunks=("transcript", "summary"))
    assert worklist(db) == set()


def test_meeting_without_a_summary_is_not_chased_forever(db):
    # No summary to embed, so a transcript-only index is complete. Listing
    # it would make backfill re-embed the same meetings on every run.
    add_meeting(db, "no-summary", chunks=("transcript",))
    assert worklist(db) == set()


def test_status_case_does_not_matter(db):
    # Every real write path stores lowercase 'completed'; the onboarding
    # seed writes uppercase. Both must count.
    add_meeting(db, "lower", summary=("completed", "{}"), chunks=("transcript",))
    add_meeting(db, "upper", summary=("COMPLETED", "{}"), chunks=("transcript",))
    assert worklist(db) == {"lower", "upper"}


def test_empty_or_failed_summary_is_not_treated_as_indexable(db):
    add_meeting(db, "empty-result", summary=("completed", "   "), chunks=("transcript",))
    add_meeting(db, "errored", summary=("error", "{}"), chunks=("transcript",))
    assert worklist(db) == set()


def test_meeting_with_no_content_at_all_is_skipped(db):
    # Blank recordings produce zero chunks; listing them would pin the
    # indexing banner below 100% forever.
    add_meeting(db, "blank", transcript=False)
    assert worklist(db) == set()
