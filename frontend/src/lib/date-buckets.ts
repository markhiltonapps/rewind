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
    // Items without a created_at fall into 'earlier' so they never
    // get lost. Backend should always send created_at post-Phase-3
    // Task 5 backend fix; this guard covers transitional / legacy
    // entries (e.g. a frontend-side optimistic insert that hasn't
    // round-tripped to the server yet).
    let bucket: DateBucket = 'earlier';
    if (m.created_at) {
      const d = typeof m.created_at === 'string'
        ? new Date(m.created_at)
        : m.created_at;
      if (!Number.isNaN(d.getTime())) {
        bucket = getDateBucket(d, now);
      }
    }
    buckets[bucket].push(m);
  }
  return buckets;
}
