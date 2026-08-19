'use client';

// Renders a synthesized answer plus its source citations. Shared by
// the corpus-wide Ask page and the per-recording ask panel — the only
// difference is that the per-recording panel hides the Sources list
// (every citation points at the meeting you're already looking at).

import ReactMarkdown from 'react-markdown';
import { CalendarDays } from 'lucide-react';
import type { Citation } from './types';
import { formatDate } from './types';

interface Props {
  answer: string;
  citations: Citation[];
  scope?: string | null;
  model?: string;
  elapsedMs?: number;
  /** Hide the Sources list — used in single-recording mode. */
  hideSources?: boolean;
  onOpenCitation?: (c: Citation) => void;
}

// Pluck citation #N out of a "#cite-N" href. Returns null for regular
// links so they pass through untouched.
function citationIdx(href: string): number | null {
  const m = href.match(/^#cite-(\d+)$/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

export function AskAnswer({
  answer,
  citations,
  scope,
  model,
  elapsedMs,
  hideSources,
  onOpenCitation,
}: Props) {
  return (
    <div className="space-y-5">
      {/* Scope chip — makes it visible which date window the answer
          actually covers, so a wrong interpretation is obvious at a
          glance rather than buried in the prose. */}
      {scope && (
        <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-rw-primary-bg text-rw-primary text-[11px] font-medium">
          <CalendarDays className="w-3 h-3" />
          Scoped to {scope}
        </div>
      )}

      <div className="prose prose-sm max-w-none text-[14px] leading-relaxed text-rw-text-primary">
        <ReactMarkdown
          components={{
            a: ({ href, children, ...rest }) => {
              const n = href ? citationIdx(href) : null;
              if (n !== null) {
                const c = citations.find((x) => x.n === n);
                if (c && onOpenCitation) {
                  return (
                    <button
                      type="button"
                      onClick={() => onOpenCitation(c)}
                      className="text-rw-primary underline underline-offset-2 hover:opacity-80"
                      title={`Open: ${c.meeting_title}`}
                    >
                      {children}
                    </button>
                  );
                }
                // Citation with nowhere to navigate (single-recording
                // mode): render as plain emphasis, not a dead link.
                return <span className="font-medium">{children}</span>;
              }
              return (
                <a href={href} {...rest}>
                  {children}
                </a>
              );
            },
          }}
        >
          {answer}
        </ReactMarkdown>
      </div>

      {!hideSources && citations.length > 0 && (
        <div>
          <div className="text-[11px] uppercase tracking-wider text-rw-text-tertiary mb-2">
            Sources ({citations.length})
          </div>
          <div className="space-y-2">
            {citations.map((c) => (
              <button
                type="button"
                key={c.n}
                onClick={() => onOpenCitation?.(c)}
                className="w-full text-left border border-rw-border rounded-rw-md bg-rw-card hover:bg-rw-hover px-3 py-2 transition-colors"
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[13px] text-rw-text-primary font-medium truncate">
                    [{c.n}] {c.meeting_title}
                  </span>
                  <span className="text-[11px] text-rw-text-tertiary whitespace-nowrap">
                    {formatDate(c.meeting_created_at)}
                    {c.kind === 'summary' ? ' · summary' : ''}
                  </span>
                </div>
                <div className="text-[12px] text-rw-text-secondary mt-1 line-clamp-2">
                  {c.snippet}
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      {model && (
        <div className="text-[11px] text-rw-text-tertiary pt-2 border-t border-rw-border">
          {model}
          {elapsedMs != null ? ` · ${elapsedMs} ms` : ''}
        </div>
      )}
    </div>
  );
}
