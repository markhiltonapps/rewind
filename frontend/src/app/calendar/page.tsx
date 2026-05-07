'use client';

// Phase 6 Task 2: Calendar view of recordings.
// 7×6 month grid on the left, "[Selected day]'s Recordings" pane on
// the right. Each day cell shows up to 3 horizontal bars (one per
// recording made that day) plus a "+N more" pill if there are
// extra. Click a day to swap the right pane to that day's list;
// click a recording card in the right pane to open the meeting.
//
// Backend: zero new endpoints. The existing meetings list from
// SidebarProvider is the source of truth — `created_at` placement
// drives both the bars and the right pane.

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ChevronLeft,
  ChevronRight,
  MoreVertical,
  Clock,
  Folder as FolderIcon,
} from 'lucide-react';
import {
  useSidebar,
  type CurrentMeeting,
  type Folder,
} from '@/components/Sidebar/SidebarProvider';

// ───────────────────────────────────────────────────────────────────
// Date helpers (local timezone, no Date library — kept dep-free)
// ───────────────────────────────────────────────────────────────────

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}
function addMonths(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth() + n, 1);
}
function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}
function dayKey(d: Date): string {
  // YYYY-MM-DD in local tz, used as map keys.
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function parseMeetingDate(raw: string | undefined): Date | null {
  if (!raw) return null;
  const dt = new Date(raw);
  if (isNaN(dt.getTime())) return null;
  return dt;
}

// ───────────────────────────────────────────────────────────────────
// Folder color cycle for left-stripe + bar accents.
// Mirrors the unobtrusive folder-color palette (warm greys + teal +
// coral) without competing with the rest of the UI. Index by folder
// id hash so a given folder stays consistent across renders.
// ───────────────────────────────────────────────────────────────────

const FOLDER_COLORS: Array<{ stripe: string; bar: string }> = [
  { stripe: '#1A6F66', bar: '#1A6F66' }, // teal
  { stripe: '#D86F5C', bar: '#D86F5C' }, // coral
  { stripe: '#7B6FBE', bar: '#7B6FBE' }, // muted purple
  { stripe: '#5C7DBE', bar: '#5C7DBE' }, // muted blue
  { stripe: '#7E9059', bar: '#7E9059' }, // sage
  { stripe: '#B8895E', bar: '#B8895E' }, // tan
];
const NEUTRAL_COLOR = { stripe: '#94928C', bar: '#94928C' }; // warm grey for "Uncategorized"

function colorForFolder(folderId: string | null | undefined): {
  stripe: string;
  bar: string;
} {
  if (!folderId) return NEUTRAL_COLOR;
  let hash = 0;
  for (let i = 0; i < folderId.length; i++) {
    hash = (hash * 31 + folderId.charCodeAt(i)) & 0x7fffffff;
  }
  return FOLDER_COLORS[hash % FOLDER_COLORS.length];
}

// ───────────────────────────────────────────────────────────────────
// Page
// ───────────────────────────────────────────────────────────────────

export default function CalendarPage() {
  const router = useRouter();
  const { meetings, folders, setCurrentMeeting } = useSidebar();
  const today = useMemo(() => new Date(), []);
  const [viewMonth, setViewMonth] = useState<Date>(() => startOfMonth(today));
  const [selectedDay, setSelectedDay] = useState<Date>(today);

  // Reset selected day when navigating months: pick day-1 of the new
  // month unless the new month contains today (then today).
  useEffect(() => {
    const todayInView =
      today.getFullYear() === viewMonth.getFullYear() &&
      today.getMonth() === viewMonth.getMonth();
    setSelectedDay(todayInView ? today : viewMonth);
  }, [viewMonth, today]);

  // Group meetings by local YYYY-MM-DD so day cells can read them by
  // key in O(1).
  const meetingsByDay: Record<string, CurrentMeeting[]> = useMemo(() => {
    const out: Record<string, CurrentMeeting[]> = {};
    for (const m of meetings) {
      const dt = parseMeetingDate(m.created_at);
      if (!dt) continue;
      const k = dayKey(dt);
      (out[k] ||= []).push(m);
    }
    // Sort each bucket chronologically (earliest first).
    for (const k of Object.keys(out)) {
      out[k].sort((a, b) => {
        const da = parseMeetingDate(a.created_at)?.getTime() ?? 0;
        const db = parseMeetingDate(b.created_at)?.getTime() ?? 0;
        return da - db;
      });
    }
    return out;
  }, [meetings]);

  const folderById: Map<string, Folder> = useMemo(() => {
    const m = new Map<string, Folder>();
    for (const f of folders) m.set(f.id, f);
    return m;
  }, [folders]);

  // Build the 7×6 grid: starts on the Sunday on or before day 1 of
  // viewMonth, fills 42 cells.
  const gridDays: Date[] = useMemo(() => {
    const first = startOfMonth(viewMonth);
    const start = new Date(first);
    start.setDate(first.getDate() - first.getDay()); // Sun = 0
    const cells: Date[] = [];
    for (let i = 0; i < 42; i++) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      cells.push(d);
    }
    return cells;
  }, [viewMonth]);

  const monthLabel = viewMonth.toLocaleString(undefined, {
    month: 'long',
    year: 'numeric',
  });
  const selectedDayLabel = isSameDay(selectedDay, today)
    ? "Today's Recordings"
    : `Recordings on ${selectedDay.toLocaleDateString(undefined, {
        weekday: 'long',
        month: 'short',
        day: 'numeric',
      })}`;
  const selectedDaySubtitle = selectedDay.toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });

  const selectedDayMeetings = meetingsByDay[dayKey(selectedDay)] ?? [];

  function openMeeting(m: CurrentMeeting) {
    setCurrentMeeting({ id: m.id, title: m.title });
    router.push('/meeting-details');
  }

  return (
    <div className="flex h-screen overflow-hidden">
      {/* ── Left: calendar grid ── */}
      <div className="flex-1 min-w-0 flex flex-col px-8 py-6 overflow-hidden">
        {/* Header */}
        <header className="flex items-start justify-between mb-6">
          <div>
            <h1 className="text-[24px] font-medium text-rw-text-primary leading-tight">
              Calendar
            </h1>
            <p className="text-[13px] text-rw-text-secondary mt-0.5">
              Browse your recordings by day
            </p>
          </div>
          <button
            type="button"
            disabled
            title="More options (coming soon)"
            className="w-9 h-9 border border-rw-border bg-rw-card rounded-rw-md inline-flex items-center justify-center text-rw-text-tertiary cursor-not-allowed"
            aria-label="More options"
          >
            <MoreVertical className="w-4 h-4" />
          </button>
        </header>

        {/* Toolbar */}
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setViewMonth((m) => addMonths(m, -1))}
              className="w-8 h-8 inline-flex items-center justify-center rounded-rw-md hover:bg-rw-hover text-rw-text-secondary"
              aria-label="Previous month"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <div className="px-3 py-1.5 text-[14px] font-medium text-rw-text-primary min-w-[140px] text-center">
              {monthLabel}
            </div>
            <button
              type="button"
              onClick={() => setViewMonth((m) => addMonths(m, 1))}
              className="w-8 h-8 inline-flex items-center justify-center rounded-rw-md hover:bg-rw-hover text-rw-text-secondary"
              aria-label="Next month"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={() => {
                setViewMonth(startOfMonth(new Date()));
                setSelectedDay(new Date());
              }}
              className="ml-2 px-3 py-1.5 text-[12px] font-medium border border-rw-border rounded-rw-md text-rw-text-secondary hover:bg-rw-hover hover:text-rw-text-primary"
            >
              Today
            </button>
          </div>

          {/* Day/Week/Month toggle — Month only enabled for v1 */}
          <div
            role="group"
            aria-label="View mode"
            className="inline-flex border border-rw-border rounded-rw-md overflow-hidden text-[12px]"
          >
            <button
              type="button"
              disabled
              title="Day view — coming later"
              className="px-3 py-1.5 text-rw-text-tertiary cursor-not-allowed"
            >
              Day
            </button>
            <button
              type="button"
              disabled
              title="Week view — coming later"
              className="px-3 py-1.5 text-rw-text-tertiary cursor-not-allowed border-l border-rw-border"
            >
              Week
            </button>
            <button
              type="button"
              className="px-3 py-1.5 bg-rw-card text-rw-text-primary font-medium border-l border-rw-border"
              aria-pressed="true"
            >
              Month
            </button>
          </div>
        </div>

        {/* Weekday headers */}
        <div className="grid grid-cols-7 text-[11px] font-medium uppercase tracking-[0.5px] text-rw-text-tertiary border-t border-l border-r border-rw-border rounded-t-rw-md bg-rw-card">
          {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => (
            <div key={d} className="px-3 py-2 border-r last:border-r-0 border-rw-border">
              {d}
            </div>
          ))}
        </div>

        {/* Day grid */}
        <div className="grid grid-cols-7 grid-rows-6 flex-1 border-l border-r border-b border-rw-border rounded-b-rw-md overflow-hidden">
          {gridDays.map((d, idx) => {
            const inMonth = d.getMonth() === viewMonth.getMonth();
            const isToday = isSameDay(d, today);
            const isSelected = isSameDay(d, selectedDay);
            const dayMeetings = meetingsByDay[dayKey(d)] ?? [];
            // Cells render up to 3 bars + a "+N more" indicator.
            const visibleBars = dayMeetings.slice(0, 3);
            const extraCount = dayMeetings.length - visibleBars.length;
            return (
              <button
                type="button"
                key={idx}
                onClick={() => setSelectedDay(d)}
                className={`relative text-left border-r border-b border-rw-border last:border-r-0 px-2 pt-2 pb-1 min-h-[80px] transition-colors ${
                  isSelected
                    ? 'bg-rw-primary-bg/40'
                    : 'bg-rw-card hover:bg-rw-hover'
                }`}
                aria-pressed={isSelected}
              >
                <div className="flex items-center gap-1">
                  {isToday ? (
                    <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-rw-text-primary text-rw-card text-[12px] font-medium">
                      {d.getDate()}
                    </span>
                  ) : (
                    <span
                      className={`text-[12px] ${
                        inMonth
                          ? 'text-rw-text-primary'
                          : 'text-rw-text-tertiary'
                      }`}
                    >
                      {d.getDate()}
                    </span>
                  )}
                </div>
                <div className="mt-1.5 space-y-1">
                  {visibleBars.map((m) => {
                    const folder = m.folder_id ? folderById.get(m.folder_id) : undefined;
                    const color = colorForFolder(m.folder_id);
                    return (
                      <div
                        key={m.id}
                        className="h-[6px] rounded-sm"
                        style={{ backgroundColor: color.bar, opacity: inMonth ? 1 : 0.4 }}
                        title={`${m.title}${folder ? ` · ${folder.name}` : ''}`}
                      />
                    );
                  })}
                  {extraCount > 0 && (
                    <div className="text-[10px] text-rw-text-tertiary pt-0.5">
                      +{extraCount} more
                    </div>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Right: selected day's recordings ── */}
      <aside className="w-[340px] flex-shrink-0 border-l border-rw-border bg-rw-bg-recede flex flex-col overflow-hidden">
        <header className="px-5 py-5 border-b border-rw-border">
          <h2 className="text-[18px] font-medium text-rw-text-primary leading-tight">
            {selectedDayLabel}
          </h2>
          <p className="text-[12px] text-rw-text-secondary mt-1">
            {selectedDaySubtitle}
          </p>
        </header>
        <div className="flex-1 overflow-y-auto p-4 space-y-2">
          {selectedDayMeetings.length === 0 ? (
            <p className="text-[12px] text-rw-text-tertiary mt-2 text-center">
              No recordings on this day.
            </p>
          ) : (
            selectedDayMeetings.map((m) => {
              const folder = m.folder_id ? folderById.get(m.folder_id) : undefined;
              const color = colorForFolder(m.folder_id);
              const dt = parseMeetingDate(m.created_at);
              const time = dt
                ? dt.toLocaleTimeString(undefined, {
                    hour: 'numeric',
                    minute: '2-digit',
                  })
                : '';
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => openMeeting(m)}
                  className="w-full text-left flex bg-rw-card border border-rw-border rounded-rw-md hover:border-rw-border-strong hover:bg-rw-hover transition-colors overflow-hidden"
                >
                  <div
                    className="w-1 flex-shrink-0"
                    style={{ backgroundColor: color.stripe }}
                    aria-hidden
                  />
                  <div className="flex-1 min-w-0 px-3 py-2.5">
                    <div className="text-[13px] font-medium text-rw-text-primary truncate">
                      {m.title}
                    </div>
                    <div className="mt-1 flex items-center gap-3 text-[11px] text-rw-text-secondary">
                      {time && (
                        <span className="inline-flex items-center gap-1">
                          <Clock className="w-3 h-3" />
                          {time}
                        </span>
                      )}
                      {folder && (
                        <span className="inline-flex items-center gap-1 truncate">
                          <FolderIcon className="w-3 h-3" />
                          <span className="truncate">{folder.name}</span>
                        </span>
                      )}
                    </div>
                    {m.tags && m.tags.length > 0 && (
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {m.tags.slice(0, 4).map((t) => (
                          <span
                            key={t.id}
                            className="text-[10px] px-1.5 py-0.5 rounded-rw-sm bg-rw-primary-bg text-rw-info-text"
                          >
                            #{t.name}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </button>
              );
            })
          )}
        </div>
      </aside>
    </div>
  );
}
