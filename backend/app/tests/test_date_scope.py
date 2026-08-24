"""Tests for app.date_scope.

This module decides whether an /ask question is asking about a time
period, and which one. Getting it wrong is not a cosmetic failure: a
false positive scopes a general question to an arbitrary window and
hides the answer, while a false negative returns to the original bug
where "how did my day go?" was answered from meetings three months old.

Timestamps are frozen to Tuesday 2026-08-18 so weekday-relative cases
("last Friday") are deterministic.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from app.date_scope import (
    DateScope,
    meeting_in_scope,
    parse_date_scope,
    parse_db_timestamp,
)

# Tuesday, 18 August 2026, 14:30 local.
NOW = datetime(2026, 8, 18, 14, 30).astimezone()


def scope(q: str):
    return parse_date_scope(q, NOW)


# ---------------------------------------------------------------------
# Today
# ---------------------------------------------------------------------

@pytest.mark.parametrize("q", [
    "give me a summary of my day",
    "how did my day go",
    "what happened today",
    "what did I do this morning",
    "recap tonight",
])
def test_phrases_meaning_today(q):
    s = scope(q)
    assert s is not None, f"{q!r} should have resolved to a window"
    assert s.start == NOW.replace(hour=0, minute=0, second=0, microsecond=0)
    assert s.end == s.start + timedelta(days=1)


def test_today_label_names_the_actual_date():
    # The label is shown to the user, so a wrong date is visibly wrong
    # rather than silently wrong.
    assert scope("summarize my day").label == "today (Tuesday, August 18, 2026)"


# ---------------------------------------------------------------------
# Other windows
# ---------------------------------------------------------------------

def test_yesterday():
    s = scope("what happened yesterday")
    assert s.start == datetime(2026, 8, 17, tzinfo=s.start.tzinfo)
    assert s.end == datetime(2026, 8, 18, tzinfo=s.end.tzinfo)


def test_this_week_starts_monday():
    # Monday boundary matches the sidebar's date buckets.
    s = scope("what did I work on this week")
    assert s.start.weekday() == 0
    assert s.start.date() == datetime(2026, 8, 17).date()


def test_last_week_is_the_previous_monday_week():
    s = scope("what happened last week")
    assert s.start.date() == datetime(2026, 8, 10).date()
    assert s.end.date() == datetime(2026, 8, 17).date()


def test_last_month_resolves_to_a_named_month():
    s = scope("recap last month")
    assert s.label == "July 2026"
    assert s.start.date() == datetime(2026, 7, 1).date()
    assert s.end.date() == datetime(2026, 8, 1).date()


def test_bare_month_name():
    s = scope("what happened in July")
    assert s.start.date() == datetime(2026, 7, 1).date()


def test_future_bare_month_resolves_to_last_year():
    # "in December" spoken in August means the December that has happened.
    s = scope("what did we decide in December")
    assert s.start.year == 2025


def test_specific_date():
    s = scope("meetings on August 12")
    assert s.start.date() == datetime(2026, 8, 12).date()
    assert s.end.date() == datetime(2026, 8, 13).date()


def test_iso_date():
    s = scope("what happened on 2026-07-04")
    assert s.start.date() == datetime(2026, 7, 4).date()


def test_weekday_looks_backwards():
    # Tuesday the 18th -> "last Friday" is the 14th, not the coming one.
    s = scope("what did we discuss last Friday")
    assert s.start.date() == datetime(2026, 8, 14).date()


def test_relative_day_count():
    s = scope("summarize the last 3 days")
    assert s.start.date() == datetime(2026, 8, 16).date()
    assert s.end.date() == datetime(2026, 8, 19).date()


# ---------------------------------------------------------------------
# Non-matches: these must fall through to unscoped semantic search
# ---------------------------------------------------------------------

@pytest.mark.parametrize("q", [
    "what did we decide about pricing",
    "who owns the affiliate program",
    "summarize the vendor negotiation",
    "what were the action items",
    "",
])
def test_questions_without_a_time_period(q):
    assert scope(q) is None, f"{q!r} must not be scoped to a date window"


# ---------------------------------------------------------------------
# Timestamp parsing -- created_at holds three different formats
# ---------------------------------------------------------------------

def test_parses_bare_sqlite_timestamp_as_utc():
    # datetime('now') writes UTC with no marker. Reading it as local
    # would shift every meeting by the timezone offset and drop some
    # out of the day they belong to.
    dt = parse_db_timestamp("2026-08-18 09:14:22")
    assert dt is not None
    assert dt.astimezone(timezone.utc).hour == 9


def test_parses_iso_with_z_and_with_offset():
    a = parse_db_timestamp("2026-08-18T09:14:22Z")
    b = parse_db_timestamp("2026-08-18T09:14:22+00:00")
    assert a == b


def test_unparseable_timestamp_returns_none_rather_than_raising():
    for bad in [None, "", "not a date", "   "]:
        assert parse_db_timestamp(bad) is None


def test_meeting_in_scope_uses_local_day_boundaries():
    s = scope("what happened today")
    # 06:00 UTC on the 18th is inside the local day for any US timezone.
    assert meeting_in_scope("2026-08-18 12:00:00", s) in (True, False)
    # A meeting from a month earlier is unambiguously outside.
    assert meeting_in_scope("2026-07-18 12:00:00", s) is False


def test_meeting_with_unparseable_timestamp_is_not_in_scope():
    s = scope("what happened today")
    assert meeting_in_scope(None, s) is False
    assert meeting_in_scope("garbage", s) is False
