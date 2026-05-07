'use client';

// Phase 6 Task 1: global search results page.
// Reads ?q= from the URL, hits the backend's /search endpoint, and
// renders a list of result cards. Click a result -> selectCurrentMeeting
// + router.push('/meeting-details') so the existing meeting view loads.
//
// The search input itself lives in the sidebar (Sidebar/index.tsx);
// this page is just the rendering side of the contract.

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useSidebar } from '@/components/Sidebar/SidebarProvider';

const BACKEND = 'http://localhost:5167';

interface SearchResult {
  meeting_id: string;
  title: string;
  created_at: string;
  snippet: string;
  match_field: 'title' | 'transcript';
}

function highlightMatch(text: string, query: string): React.ReactNode {
  // Case-insensitive split on the query term, re-emit with <mark>
  // around each match. We escape the query for the regex character
  // class to keep punctuation in the user's input from breaking
  // the pattern.
  if (!query) return text;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(${escaped})`, 'gi');
  const parts = text.split(re);
  return parts.map((part, i) =>
    re.test(part) ? (
      <mark
        key={i}
        className="bg-rw-warning-bg text-rw-text-primary px-0.5 rounded"
      >
        {part}
      </mark>
    ) : (
      <span key={i}>{part}</span>
    ),
  );
}

function formatDate(iso: string): string {
  try {
    const dt = new Date(iso);
    if (isNaN(dt.getTime())) return iso;
    return dt.toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

function SearchResults() {
  const params = useSearchParams();
  const router = useRouter();
  const { setCurrentMeeting } = useSidebar();
  const q = (params.get('q') ?? '').trim();
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!q) {
      setResults([]);
      setError(null);
      return;
    }
    let cancelled = false;
    setResults(null); // loading
    setError(null);
    (async () => {
      try {
        const resp = await fetch(
          `${BACKEND}/search?q=${encodeURIComponent(q)}&limit=50`,
        );
        if (!resp.ok) throw new Error(`status ${resp.status}`);
        const data = (await resp.json()) as SearchResult[];
        if (cancelled) return;
        setResults(data);
      } catch (err) {
        if (cancelled) return;
        console.error('Search fetch failed', err);
        setError('Search failed. Try again.');
        setResults([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [q]);

  function openResult(r: SearchResult) {
    setCurrentMeeting({ id: r.meeting_id, title: r.title });
    router.push('/meeting-details');
  }

  if (!q) {
    return (
      <div className="px-8 py-10">
        <h1 className="text-[20px] font-medium text-rw-text-primary mb-2">
          Search
        </h1>
        <p className="text-[13px] text-rw-text-tertiary">
          Type in the search box at the top of the sidebar to find meetings
          by title or transcript content.
        </p>
      </div>
    );
  }

  return (
    <div className="px-8 py-8 max-w-3xl">
      <div className="flex items-baseline justify-between mb-5">
        <h1 className="text-[20px] font-medium text-rw-text-primary">
          Search results
        </h1>
        <span className="text-[12px] text-rw-text-tertiary">
          {results === null
            ? 'Searching…'
            : `${results.length} ${results.length === 1 ? 'match' : 'matches'} for `}
          {results !== null && (
            <span className="text-rw-text-secondary">&ldquo;{q}&rdquo;</span>
          )}
        </span>
      </div>

      {error && (
        <div className="mb-4 px-4 py-3 rounded-rw-md bg-rw-danger-bg text-[13px] text-rw-danger-text">
          {error}
        </div>
      )}

      {results === null ? (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="h-20 bg-rw-subtle border border-rw-border rounded-rw-lg animate-pulse"
            />
          ))}
        </div>
      ) : results.length === 0 ? (
        <div className="px-4 py-8 text-center">
          <p className="text-[13px] text-rw-text-tertiary mb-1">
            No matches for <strong>&ldquo;{q}&rdquo;</strong>.
          </p>
          <p className="text-[12px] text-rw-text-tertiary">
            Try a different word or shorter phrase.
          </p>
        </div>
      ) : (
        <ul className="space-y-2">
          {results.map((r) => (
            <li key={`${r.meeting_id}-${r.match_field}`}>
              <button
                type="button"
                onClick={() => openResult(r)}
                className="w-full text-left px-4 py-3 bg-rw-card border border-rw-border rounded-rw-lg hover:border-rw-border-strong hover:bg-rw-hover transition-colors"
              >
                <div className="flex items-baseline justify-between gap-3">
                  <div className="text-[14px] font-medium text-rw-text-primary truncate">
                    {highlightMatch(r.title, q)}
                  </div>
                  <div className="text-[11px] text-rw-text-tertiary flex-shrink-0">
                    {formatDate(r.created_at)}
                  </div>
                </div>
                {r.match_field === 'transcript' && (
                  <p className="mt-1.5 text-[12px] text-rw-text-secondary leading-relaxed line-clamp-2">
                    {highlightMatch(r.snippet, q)}
                  </p>
                )}
                {r.match_field === 'title' && (
                  <p className="mt-1.5 text-[11px] text-rw-text-tertiary">
                    Title match
                  </p>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function SearchPage() {
  // useSearchParams requires a Suspense boundary in the App Router.
  return (
    <Suspense
      fallback={<div className="px-8 py-10 text-rw-text-tertiary">Loading…</div>}
    >
      <SearchResults />
    </Suspense>
  );
}
