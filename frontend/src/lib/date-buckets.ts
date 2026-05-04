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

export function bucketMeetings<T extends { created_at?: string | Date | null }>(
  meetings: T[],
  now: Date = new Date()
): Record<DateBucket, T[]> {
  const buckets: Record<DateBucket, T[]> = {
    'today': [],
    'yesterday': [],
    'this-week': [],
    'earlier': [],
  };
  for (const m of meetings) {
    // Items without a parseable created_at fall into 'earlier' so
    // they never get lost. Backend should always send a marked ISO
    // timestamp post-Phase-3-Task-5-fix; this guard covers
    // transitional entries (optimistic insert that hasn't round-
    // tripped to the server yet) and any legacy / unrecognized
    // format.
    const d = parseTimestamp(m.created_at ?? null);
    const bucket: DateBucket = d ? getDateBucket(d, now) : 'earlier';
    buckets[bucket].push(m);
  }
  return buckets;
}
