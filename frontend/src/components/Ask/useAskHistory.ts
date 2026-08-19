'use client';

import { useCallback, useEffect, useState } from 'react';
import { BACKEND, type AskHistoryEntry } from './types';

interface Options {
  /** Scope history to one recording. */
  meetingId?: string;
  /** Exclude per-recording exchanges (the corpus-wide Ask page). */
  globalOnly?: boolean;
  limit?: number;
}

/**
 * Loads and mutates saved /ask exchanges.
 *
 * Pin and delete update local state optimistically and roll back if the
 * request fails — history is a convenience surface, so it should feel
 * instant and never block on the network.
 */
export function useAskHistory({ meetingId, globalOnly, limit = 100 }: Options = {}) {
  const [entries, setEntries] = useState<AskHistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const params = new URLSearchParams({ limit: String(limit) });
    if (meetingId) params.set('meeting_id', meetingId);
    else if (globalOnly) params.set('global_only', 'true');
    try {
      const resp = await fetch(`${BACKEND}/ask/history?${params}`, {
        cache: 'no-store',
      });
      if (!resp.ok) throw new Error(`status ${resp.status}`);
      const data = await resp.json();
      setEntries(Array.isArray(data) ? data : []);
    } catch {
      // History is non-essential — fail quiet rather than blocking the
      // page on a backend that's still warming up.
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [meetingId, globalOnly, limit]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const togglePin = useCallback(async (entry: AskHistoryEntry) => {
    const next = !entry.pinned;
    setEntries((prev) =>
      sortEntries(
        prev.map((e) => (e.id === entry.id ? { ...e, pinned: next } : e)),
      ),
    );
    try {
      const resp = await fetch(`${BACKEND}/ask/history/${entry.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pinned: next }),
      });
      if (!resp.ok) throw new Error(`status ${resp.status}`);
    } catch {
      setEntries((prev) =>
        sortEntries(
          prev.map((e) => (e.id === entry.id ? { ...e, pinned: !next } : e)),
        ),
      );
    }
  }, []);

  const remove = useCallback(async (entry: AskHistoryEntry) => {
    const snapshot = entry;
    setEntries((prev) => prev.filter((e) => e.id !== entry.id));
    try {
      const resp = await fetch(`${BACKEND}/ask/history/${entry.id}`, {
        method: 'DELETE',
      });
      if (!resp.ok && resp.status !== 404) throw new Error(`status ${resp.status}`);
    } catch {
      setEntries((prev) => sortEntries([...prev, snapshot]));
    }
  }, []);

  return { entries, loading, refresh, togglePin, remove };
}

/** Pinned first, then newest first — mirrors the backend ordering. */
function sortEntries(list: AskHistoryEntry[]): AskHistoryEntry[] {
  return [...list].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return b.created_at.localeCompare(a.created_at);
  });
}
