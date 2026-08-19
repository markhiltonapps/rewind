// Shared contract for the /ask endpoint and its history, used by both
// the corpus-wide Ask page and the per-recording ask panel.

export interface Citation {
  n: number;
  meeting_id: string;
  meeting_title: string;
  meeting_created_at: string;
  snippet: string;
  kind: 'transcript' | 'summary';
  distance: number;
}

export interface AskResponse {
  answer: string;
  citations: Citation[];
  model: string;
  elapsed_ms: number;
  // Human-readable date window when the question named one
  // ("today (Tuesday, August 18, 2026)"), else null.
  scope?: string | null;
  // Which retrieval path answered: 'semantic' | 'date-scoped' | 'meeting'.
  mode?: string;
  // Row id in ask_history; null when the history write failed.
  history_id?: number | null;
}

export interface AskHistoryEntry {
  id: number;
  created_at: string;
  question: string;
  answer: string;
  citations: Citation[];
  meeting_id: string | null;
  scope_label: string | null;
  pinned: boolean;
}

export const BACKEND = 'http://localhost:5167';

/** Format an ISO timestamp as a short date, e.g. "Aug 18, 2026". */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '';
  try {
    const dt = new Date(iso);
    if (isNaN(dt.getTime())) return iso;
    return dt.toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return iso;
  }
}

/** Relative age for history rows: "just now", "3h ago", "Aug 12". */
export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return '';
  const dt = new Date(iso);
  if (isNaN(dt.getTime())) return '';
  const diffMs = Date.now() - dt.getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
