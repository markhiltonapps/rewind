"""Natural-language date-scope extraction for /ask queries.

Motivation
----------
`/ask` retrieves chunks by pure semantic similarity. That works for
needle questions ("what did we decide about pricing?") but fails badly
for *time-scoped* questions ("how did my day go?", "what happened last
week?"):

  * Semantic similarity has no notion of *when* — a July standup and a
    today standup look equally relevant to "summarize my day".
  * Transcripts are full of relative language ("this morning", "later
    today"). With no anchor date, the model reads those phrases inside
    a three-month-old transcript and reports them as if they were now.

So before retrieval we check whether the question names a time period.
When it does, we filter the corpus to meetings that actually fall in
that window rather than trusting the vector index to sort it out — and
if there are none, we can say so plainly instead of hallucinating a day
out of stale chunks.

This is deliberately heuristic (regex, not an LLM pre-pass): it is
free, adds no latency, and is predictable enough to reason about. Any
phrasing it doesn't recognize simply falls through to the existing
semantic path, which is the pre-existing behavior — so a miss degrades
to "no worse than before", never to a wrong answer.

Week boundary is Monday 00:00 local, matching the sidebar's date
buckets (frontend/src/lib/date-buckets.ts).
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

__all__ = [
    "DateScope",
    "parse_date_scope",
    "parse_db_timestamp",
    "meeting_in_scope",
]


@dataclass(frozen=True)
class DateScope:
    """A resolved [start, end) window in the user's LOCAL timezone."""

    start: datetime  # inclusive, tz-aware local
    end: datetime    # exclusive, tz-aware local
    label: str       # human-readable, e.g. "today (Monday, August 18, 2026)"

    def contains(self, dt: datetime) -> bool:
        return self.start <= dt < self.end


# ----------------------------------------------------------------------
# Timestamp parsing
# ----------------------------------------------------------------------

_TZ_SUFFIX_RE = re.compile(r"[+-]\d{2}:?\d{2}$")


def parse_db_timestamp(value) -> datetime | None:
    """Parse a `meetings.created_at` value into a tz-aware LOCAL datetime.

    The column holds a mix of formats depending on which code path wrote
    the row:
      * ISO-8601 with offset  ("2026-08-18T09:14:22+00:00")
      * ISO-8601 with Z       ("2026-08-18T09:14:22Z")
      * bare SQLite datetime  ("2026-08-18 09:14:22")  ← UTC by convention

    A bare timestamp with no marker is treated as UTC, mirroring
    `parseTimestamp` in the frontend's date-buckets.ts. Returns None for
    anything unparseable so callers can skip the row rather than crash.
    """
    if value is None:
        return None
    if isinstance(value, datetime):
        dt = value
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone()

    s = str(value).strip()
    if not s:
        return None

    normalized = s
    if normalized.endswith("Z"):
        normalized = normalized[:-1] + "+00:00"
    # SQLite's space separator isn't valid ISO-8601 before Python 3.11.
    if " " in normalized and "T" not in normalized:
        normalized = normalized.replace(" ", "T", 1)

    try:
        dt = datetime.fromisoformat(normalized)
    except ValueError:
        # Last resort: date-only rows.
        try:
            dt = datetime.strptime(s[:10], "%Y-%m-%d")
        except ValueError:
            return None

    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone()


def meeting_in_scope(created_at, scope: DateScope) -> bool:
    """True when a meeting's created_at falls inside the scope window."""
    dt = parse_db_timestamp(created_at)
    return dt is not None and scope.contains(dt)


# ----------------------------------------------------------------------
# Scope parsing
# ----------------------------------------------------------------------

_MONTHS = {
    "january": 1, "jan": 1,
    "february": 2, "feb": 2,
    "march": 3, "mar": 3,
    "april": 4, "apr": 4,
    "may": 5,
    "june": 6, "jun": 6,
    "july": 7, "jul": 7,
    "august": 8, "aug": 8,
    "september": 9, "sep": 9, "sept": 9,
    "october": 10, "oct": 10,
    "november": 11, "nov": 11,
    "december": 12, "dec": 12,
}

_WEEKDAYS = {
    "monday": 0, "mon": 0,
    "tuesday": 1, "tue": 1, "tues": 1,
    "wednesday": 2, "wed": 2,
    "thursday": 3, "thu": 3, "thurs": 3,
    "friday": 4, "fri": 4,
    "saturday": 5, "sat": 5,
    "sunday": 6, "sun": 6,
}

_MONTH_ALT = "|".join(sorted(_MONTHS, key=len, reverse=True))
_WEEKDAY_ALT = "|".join(sorted(_WEEKDAYS, key=len, reverse=True))


def _start_of_day(now: datetime) -> datetime:
    return now.replace(hour=0, minute=0, second=0, microsecond=0)


def _start_of_week(now: datetime) -> datetime:
    """Most recent Monday at 00:00 local."""
    sod = _start_of_day(now)
    return sod - timedelta(days=sod.weekday())


def _add_months(dt: datetime, delta: int) -> datetime:
    month_index = dt.month - 1 + delta
    year = dt.year + month_index // 12
    month = month_index % 12 + 1
    return dt.replace(year=year, month=month, day=1)


def _fmt_day(day: datetime) -> str:
    """"Monday, August 18, 2026" — no zero-padded day, portably.

    (`%-d` is glibc-only and `%#d` is Windows-only, so neither is safe
    to use directly here.)
    """
    return f"{day.strftime('%A, %B')} {day.day}, {day.year}"


def _day_label(day: datetime, prefix: str) -> str:
    return f"{prefix} ({_fmt_day(day)})"


def parse_date_scope(question: str, now: datetime | None = None) -> DateScope | None:
    """Extract a [start, end) window from a natural-language question.

    Returns None when the question names no recognizable time period, in
    which case the caller should fall back to unscoped semantic search.
    """
    if not question:
        return None
    if now is None:
        now = datetime.now().astimezone()

    q = question.lower()
    today = _start_of_day(now)
    day = timedelta(days=1)

    # --- Explicit relative days -------------------------------------
    # "my day" / "today" / "this morning" all mean the current day. We
    # check these first because they are the most common phrasing and
    # the one that motivated this module.
    if re.search(r"\b(today|todays|today's|this morning|this afternoon|this evening|tonight)\b", q) \
            or re.search(r"\b(my|the) day\b", q):
        return DateScope(today, today + day, _day_label(today, "today"))

    if re.search(r"\b(yesterday|yesterdays|yesterday's|last night)\b", q):
        y = today - day
        return DateScope(y, today, _day_label(y, "yesterday"))

    if re.search(r"\bday before yesterday\b", q):
        d = today - 2 * day
        return DateScope(d, d + day, _day_label(d, "the day before yesterday"))

    # --- Weeks -------------------------------------------------------
    start_this_week = _start_of_week(now)
    if re.search(r"\b(this week|the week|current week)\b", q):
        return DateScope(start_this_week, today + day, "this week")
    if re.search(r"\b(last week|past week|previous week)\b", q):
        return DateScope(start_this_week - 7 * day, start_this_week, "last week")

    # --- Months ------------------------------------------------------
    start_this_month = today.replace(day=1)
    if re.search(r"\b(this month|current month)\b", q):
        return DateScope(start_this_month, today + day, "this month")
    if re.search(r"\b(last month|previous month|past month)\b", q):
        prev = _add_months(start_this_month, -1)
        return DateScope(prev, start_this_month, prev.strftime("%B %Y"))

    # --- "last/past N days|weeks|months" -----------------------------
    m = re.search(r"\b(?:last|past|previous)\s+(\d{1,3})\s+(day|week|month)s?\b", q)
    if m:
        n = int(m.group(1))
        unit = m.group(2)
        if n >= 1:
            if unit == "day":
                start = today - (n - 1) * day
            elif unit == "week":
                start = today - (7 * n - 1) * day
            else:
                start = _add_months(start_this_month, -n)
            return DateScope(start, today + day, f"the last {n} {unit}{'s' if n != 1 else ''}")

    # --- "on August 12" / "Aug 12, 2026" / "August 12th" -------------
    m = re.search(
        rf"\b(?:on\s+)?({_MONTH_ALT})\s+(\d{{1,2}})(?:st|nd|rd|th)?(?:,?\s+(\d{{4}}))?\b", q
    )
    if m:
        month = _MONTHS[m.group(1)]
        dom = int(m.group(2))
        year = int(m.group(3)) if m.group(3) else today.year
        try:
            d = today.replace(year=year, month=month, day=dom)
        except ValueError:
            d = None
        if d is not None:
            # No explicit year and the date is in the future → the user
            # means last year's occurrence.
            if m.group(3) is None and d > today:
                d = d.replace(year=year - 1)
            return DateScope(d, d + day, f"{d.strftime('%B')} {d.day}, {d.year}")

    # --- Bare month name: "in July" / "during August 2026" -----------
    m = re.search(rf"\b(?:in|during|from|for)\s+({_MONTH_ALT})(?:\s+(\d{{4}}))?\b", q)
    if m:
        month = _MONTHS[m.group(1)]
        year = int(m.group(2)) if m.group(2) else today.year
        start = today.replace(year=year, month=month, day=1)
        if m.group(2) is None and start > today:
            start = start.replace(year=year - 1)
        return DateScope(start, _add_months(start, 1), start.strftime("%B %Y"))

    # --- "last Tuesday" / "on Friday" --------------------------------
    m = re.search(rf"\b(?:last|this|on)\s+({_WEEKDAY_ALT})\b", q)
    if m:
        target = _WEEKDAYS[m.group(1)]
        delta = (today.weekday() - target) % 7
        if delta == 0:
            delta = 7  # "last Monday" on a Monday means the previous one
        d = today - delta * day
        return DateScope(d, d + day, _day_label(d, d.strftime("%A")))

    # --- ISO date: "2026-08-18" --------------------------------------
    m = re.search(r"\b(\d{4})-(\d{2})-(\d{2})\b", q)
    if m:
        try:
            d = today.replace(
                year=int(m.group(1)), month=int(m.group(2)), day=int(m.group(3))
            )
            return DateScope(d, d + day, f"{d.strftime('%B')} {d.day}, {d.year}")
        except ValueError:
            pass

    return None
