// Phase 3 Task 5: temporal grouping for the sidebar Meetings list.
//
// Each meeting is bucketed into one of four named windows based on
// its `created_at` timestamp evaluated against the user's local time.
// Empty buckets are skipped at render time. "This Week" excludes
// today and yesterday so a meeting only ever lands in one bucket.
//
// Week boundary: Monday at 00:00 local. ISO 8601 / business
// convention. (Sunday-as-week-start would also be defensible but
// Monday produces fewer "Today is Monday and the rest of last week
// is Earlier" surprises.)
//
// Meetings older than the current week are grouped by calendar month
// (e.g. "August 2026", "July 2026") so the user can navigate older
// recordings without everything collapsing into one undifferentiated
// "Earlier" heap.

export type DateBucket = 'today' | 'yesterday' | 'this-week' | 'earlier';

export const DATE_BUCKET_LABELS: Record<DateBucket, string> = {
  'today': 'Today',
  'yesterday': 'Yesterday',
  'this-week': 'This Week',
  'earlier': 'Earlier',
};

export const DATE_BUCKET_ORDER: DateBucket[] = [
  'today',
  'yesterday',
  'this-week',
  'earlier',
];

export function getDateBucket(date: Date, now: Date = new Date()): DateBucket {
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);

  const startOfYesterday = new Date(startOfToday);
  startOfYesterday.setDate(startOfYesterday.getDate() - 1);

  // Most recent Monday at 00:00 local.
  // getDay(): 0 = Sun, 1 = Mon, ..., 6 = Sat.
  const startOfWeek = new Date(startOfToday);
  const dayOfWeek = startOfWeek.getDay();
  const daysToSubtract = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  startOfWeek.setDate(startOfWeek.getDate() - daysToSubtract);

  if (date >= startOfToday) return 'today';
  if (date >= startOfYesterday) return 'yesterday';
  if (date >= startOfWeek) return 'this-week';
  return 'earlier';
}

/**
 * Phase 3 Task 5 fix: parse a timestamp value into an absolute Date.
 *
 * V8/Chromium parses bare SQL timestamps like "2026-05-04 00:26:30"
 * (no T, no Z, no offset) as LOCAL time, which is wrong for SQLite's
 * UTC-by-convention `datetime('now')` output. We append a `Z` to
 * force UTC interpretation when no timezone marker is present. The
 * backend was also fixed to ship ISO-with-offset format; this is
 * defense-in-depth for any future regression or legacy row that
 * slipped through.
 *
 * Returns null for null/empty/invalid input so callers can decide
 * how to handle an unparseable timestamp.
 */
export function parseTimestamp(value: string | Date | null | undefined): Date | null {
  if (!value) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  let s = value.trim();
  if (!s) return null;

  // If the string has no timezone marker, treat as UTC.
  // Markers we accept: trailing Z, trailing +HH:MM or -HH:MM offset
  // (anywhere in the time portion), or 'T' with a recognizable
  // chrono::DateTime / RFC 3339 shape that already has a Z somewhere.
  const hasMarker =
    s.endsWith('Z') ||
    /[+-]\d{2}:?\d{2}$/.test(s) ||
    /[Tt]\d{2}:\d{2}:\d{2}(?:\.\d+)?[Zz]/.test(s);

  if (!hasMarker) {
    // Replace the space-separator (SQLite format) with 'T' to get a
    // valid ISO-ish string, then append Z for UTC.
    s = s.replace(' ', 'T') + 'Z';
  }

  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** One bucket group returned by bucketMeetings. */
export interface BucketGroup<T> {
  key: string;   // stable, unique — used as React key and header id
  label: string; // display label ("Today", "August 2026", …)
  meetings: T[];
}

/**
 * Partition meetings into ordered display groups:
 *   Today · Yesterday · This Week · <Month Year> · <Month Year> · …
 *
 * Older meetings are broken into calendar-month buckets (newest first)
 * so users with months of history don't see everything under one
 * "Earlier" label. Meetings without a parseable date fall last.
 */
export function bucketMeetings<T extends { created_at?: string | Date | null }>(
  meetings: T[],
  now: Date = new Date()
): BucketGroup<T>[] {
  // Compute boundaries once (local midnight = user's day boundary).
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);

  const startOfYesterday = new Date(startOfToday);
  startOfYesterday.setDate(startOfYesterday.getDate() - 1);

  const startOfWeek = new Date(startOfToday);
  const dayOfWeek = startOfWeek.getDay();
  startOfWeek.setDate(startOfWeek.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1));

  const today: T[] = [];
  const yesterday: T[] = [];
  const thisWeek: T[] = [];
  const byMonth = new Map<string, T[]>(); // key: "YYYY-MM"
  const undated: T[] = [];

  for (const m of meetings) {
    const d = parseTimestamp(m.created_at ?? null);
    if (!d) {
      undated.push(m);
      continue;
    }
    if (d >= startOfToday) {
      today.push(m);
    } else if (d >= startOfYesterday) {
      yesterday.push(m);
    } else if (d >= startOfWeek) {
      thisWeek.push(m);
    } else {
      // Use LOCAL year/month so the label matches the user's calendar.
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      if (!byMonth.has(key)) byMonth.set(key, []);
      byMonth.get(key)!.push(m);
    }
  }

  const groups: BucketGroup<T>[] = [];
  if (today.length) groups.push({ key: 'today', label: 'Today', meetings: today });
  if (yesterday.length) groups.push({ key: 'yesterday', label: 'Yesterday', meetings: yesterday });
  if (thisWeek.length) groups.push({ key: 'this-week', label: 'This Week', meetings: thisWeek });

  // Sort monthly buckets newest-first ("2026-08" before "2026-07").
  const sortedMonths = [...byMonth.entries()].sort(([a], [b]) => b.localeCompare(a));
  for (const [key, ms] of sortedMonths) {
    const [yr, mo] = key.split('-');
    const label = new Date(parseInt(yr, 10), parseInt(mo, 10) - 1, 1)
      .toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    groups.push({ key, label, meetings: ms });
  }

  // Meetings with no parseable date go last.
  if (undated.length) {
    groups.push({ key: 'earlier', label: 'Earlier', meetings: undated });
  }

  return groups;
}
