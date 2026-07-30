'use client';

// Phase 7 Task 1: surfaces RAG-embedding backfill progress.
//
// Polls GET /embeddings/status; if any meetings are unindexed AND no
// backfill is already in flight, fires POST /embeddings/backfill once
// per mount. While indexing is happening it shows a bottom-centered
// pill with the running count. When indexing is complete or there's
// nothing to do, renders null.
//
// The auto-kickoff is intentional: from the user's perspective, the
// app's meetings should "just be searchable" — exposing a manual
// "start indexing" button would be friction without value.

import { useEffect, useRef, useState } from 'react';

interface EmbeddingStatus {
  indexed: number;
  total: number;
  in_progress: boolean;
  indexed_this_run: number;
  remaining_this_run: number;
}

const BACKEND = 'http://localhost:5167';
const POLL_MS = 2000;

export default function IndexingBanner() {
  const [status, setStatus] = useState<EmbeddingStatus | null>(null);
  const [dismissed, setDismissed] = useState(false);
  // Single-shot guard so we don't keep POSTing /backfill while the
  // first call's task is still settling into the in_progress flag.
  const backfillKicked = useRef(false);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const fetchStatus = async () => {
      if (cancelled) return;
      try {
        const resp = await fetch(`${BACKEND}/embeddings/status`, {
          cache: 'no-store',
        });
        if (!resp.ok) {
          // Backend may not be up yet — retry later, don't kick off.
          if (!cancelled) timer = setTimeout(fetchStatus, POLL_MS * 2);
          return;
        }
        const s = (await resp.json()) as EmbeddingStatus;
        if (cancelled) return;
        setStatus(s);

        // Kick off backfill once per mount when there's a gap and
        // nothing in flight. The Python side coalesces concurrent
        // calls via an asyncio lock, but skipping the second POST
        // keeps the network quiet.
        if (
          !backfillKicked.current &&
          s.total > 0 &&
          s.indexed < s.total &&
          !s.in_progress
        ) {
          backfillKicked.current = true;
          try {
            await fetch(`${BACKEND}/embeddings/backfill`, {
              method: 'POST',
            });
          } catch (err) {
            console.warn('[IndexingBanner] backfill kickoff failed', err);
          }
        }

        // Keep polling while indexing isn't done.
        const done = s.indexed >= s.total && !s.in_progress;
        if (!done && !cancelled) {
          timer = setTimeout(fetchStatus, POLL_MS);
        }
      } catch {
        if (!cancelled) timer = setTimeout(fetchStatus, POLL_MS * 2);
      }
    };

    fetchStatus();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  if (!status) return null;
  if (dismissed) return null;
  // No meetings yet, or every meeting already embedded: render
  // nothing. Idle state is invisible.
  if (status.total === 0) return null;
  if (status.indexed >= status.total && !status.in_progress) return null;

  const remaining = Math.max(0, status.total - status.indexed);
  const label = status.in_progress
    ? `Indexing meetings for AI search — ${status.indexed} of ${status.total}…`
    : `Preparing to index ${remaining} meeting${remaining === 1 ? '' : 's'}…`;

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[40] bg-rw-card border border-rw-border rounded-full shadow-rw-modal px-4 py-2 flex items-center gap-3 max-w-[calc(100vw-2rem)]"
    >
      <span
        className="inline-block w-3 h-3 rounded-full border-2 border-rw-text-tertiary border-t-rw-text-primary animate-spin"
        aria-hidden
      />
      <span className="text-[12px] text-rw-text-secondary whitespace-nowrap">
        {label}
      </span>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        className="text-rw-text-tertiary hover:text-rw-text-primary leading-none text-base ml-1"
        aria-label="Dismiss"
      >
        ×
      </button>
    </div>
  );
}
