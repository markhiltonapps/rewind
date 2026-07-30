'use client';

// Phase 7 Task 2: Ask page — RAG over the user's meeting corpus.
//
// Pipeline (all in the backend):
//   POST /ask {question} → {answer, citations, model, elapsed_ms}
//
// The answer is markdown from Gemini. Citations like
// "[Meeting Title](#cite-3)" are rewritten to clickable meeting
// links via react-markdown's component override — clicking
// navigates to /meeting-details for the right meeting_id.
//
// The page also renders the raw citation chips below the answer so
// the user can see what was retrieved even if Gemini didn't cite
// everything inline.

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import ReactMarkdown from 'react-markdown';
import { Sparkles, Loader2, ArrowUp } from 'lucide-react';
import { useSidebar } from '@/components/Sidebar/SidebarProvider';

const BACKEND = 'http://localhost:5167';

interface Citation {
  n: number;
  meeting_id: string;
  meeting_title: string;
  meeting_created_at: string;
  snippet: string;
  kind: 'transcript' | 'summary';
  distance: number;
}

interface AskResponse {
  answer: string;
  citations: Citation[];
  model: string;
  elapsed_ms: number;
}

function formatDate(iso: string | null | undefined): string {
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

export default function AskPage() {
  const router = useRouter();
  const { setCurrentMeeting } = useSidebar();
  const [question, setQuestion] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<AskResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Pluck citation #N out of "#cite-N" hrefs. Returns null when not
  // a citation anchor (regular external links pass through).
  function citationIdx(href: string): number | null {
    const m = href.match(/^#cite-(\d+)$/);
    if (!m) return null;
    const n = parseInt(m[1], 10);
    return Number.isFinite(n) ? n : null;
  }

  function navigateToCitation(c: Citation) {
    setCurrentMeeting({ id: c.meeting_id, title: c.meeting_title });
    router.push('/meeting-details');
  }

  async function submit() {
    const q = question.trim();
    if (!q || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const resp = await fetch(`${BACKEND}/ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: q, top_k: 10 }),
      });
      if (!resp.ok) {
        let detail = `status ${resp.status}`;
        try {
          const body = await resp.json();
          if (body?.detail) detail = body.detail;
        } catch {
          /* keep status code */
        }
        throw new Error(detail);
      }
      const data = (await resp.json()) as AskResponse;
      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Cmd/Ctrl-Enter submits; plain Enter inserts a newline so users
    // can write multi-line questions without surprise.
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void submit();
    }
  }

  return (
    <div className="px-8 py-10 max-w-[820px] mx-auto">
      <div className="flex items-center gap-2 mb-6">
        <Sparkles className="w-5 h-5 text-rw-primary" />
        <h1 className="text-[22px] font-medium text-rw-text-primary">
          Ask your meetings
        </h1>
      </div>
      <p className="text-[13px] text-rw-text-secondary mb-5 leading-relaxed">
        Ask anything across your indexed meetings. The assistant searches your
        transcripts and summaries, then synthesizes an answer with citations
        back to the source meetings.
      </p>

      <div className="border border-rw-border rounded-rw-lg bg-rw-card p-3 mb-8">
        <textarea
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="e.g. What did the customer ask about onboarding? Who promised to follow up with Sheldon?"
          rows={3}
          disabled={submitting}
          className="w-full bg-transparent text-[14px] text-rw-text-primary placeholder:text-rw-text-tertiary resize-y min-h-[64px] focus:outline-none"
        />
        <div className="flex justify-between items-center mt-2 pt-2 border-t border-rw-border">
          <span className="text-[11px] text-rw-text-tertiary">
            Cmd/Ctrl + Enter to submit
          </span>
          <button
            type="button"
            onClick={submit}
            disabled={submitting || !question.trim()}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[13px] font-medium rounded-rw-md bg-rw-primary text-white hover:opacity-90 disabled:opacity-50"
          >
            {submitting ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <ArrowUp className="w-3.5 h-3.5" />
            )}
            {submitting ? 'Searching…' : 'Ask'}
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-6 px-3 py-2 rounded-rw-md text-[13px] bg-rw-danger-bg text-rw-danger-text">
          {error}
        </div>
      )}

      {result && (
        <div className="space-y-6">
          <div className="prose prose-sm max-w-none text-[14px] leading-relaxed text-rw-text-primary">
            <ReactMarkdown
              components={{
                a: ({ href, children, ...rest }) => {
                  const n = href ? citationIdx(href) : null;
                  if (n !== null) {
                    const c = result.citations.find((x) => x.n === n);
                    if (c) {
                      return (
                        <button
                          type="button"
                          onClick={() => navigateToCitation(c)}
                          className="text-rw-primary underline underline-offset-2 hover:opacity-80"
                          title={`Open: ${c.meeting_title}`}
                        >
                          {children}
                        </button>
                      );
                    }
                  }
                  // External / unknown — render as a normal link.
                  return (
                    <a href={href} {...rest}>
                      {children}
                    </a>
                  );
                },
              }}
            >
              {result.answer}
            </ReactMarkdown>
          </div>

          <div>
            <div className="text-[11px] uppercase tracking-wider text-rw-text-tertiary mb-2">
              Sources ({result.citations.length})
            </div>
            <div className="space-y-2">
              {result.citations.map((c) => (
                <button
                  type="button"
                  key={c.n}
                  onClick={() => navigateToCitation(c)}
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

          <div className="text-[11px] text-rw-text-tertiary pt-2 border-t border-rw-border">
            {result.model} · {result.elapsed_ms} ms
          </div>
        </div>
      )}
    </div>
  );
}
