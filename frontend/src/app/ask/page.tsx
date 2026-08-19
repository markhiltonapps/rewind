'use client';

// Phase 7 Task 2: Ask page — RAG over the user's meeting corpus.
//
// Pipeline (all in the backend):
//   POST /ask {question} → {answer, citations, scope, mode, history_id}
//
// The backend picks its own retrieval strategy: questions naming a time
// period ("how did my day go?") are filtered to meetings actually in
// that window before synthesis, so the answer can't be assembled out of
// three-month-old standups. When that happens it returns a `scope`
// label, which we surface as a chip above the answer.
//
// Every exchange is saved to /ask/history, listed in the right-hand
// column where it can be reopened, pinned, or deleted.

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Sparkles, Loader2, ArrowUp, MessageSquarePlus } from 'lucide-react';
import { useSidebar } from '@/components/Sidebar/SidebarProvider';
import { AskAnswer } from '@/components/Ask/AskAnswer';
import { AskHistoryList } from '@/components/Ask/AskHistoryList';
import { useAskHistory } from '@/components/Ask/useAskHistory';
import {
  BACKEND,
  type AskResponse,
  type Citation,
  type AskHistoryEntry,
} from '@/components/Ask/types';

export default function AskPage() {
  const router = useRouter();
  const { setCurrentMeeting } = useSidebar();
  const [question, setQuestion] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<AskResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Which history row the displayed answer came from, so the list can
  // highlight it. Set both when restoring a row and after a new ask.
  const [activeHistoryId, setActiveHistoryId] = useState<number | null>(null);

  const history = useAskHistory({ globalOnly: true });

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
      setActiveHistoryId(data.history_id ?? null);
      void history.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  function restore(entry: AskHistoryEntry) {
    setResult({
      answer: entry.answer,
      citations: entry.citations,
      model: '',
      elapsed_ms: 0,
      scope: entry.scope_label,
    });
    setQuestion(entry.question);
    setActiveHistoryId(entry.id);
    setError(null);
  }

  function startNew() {
    setResult(null);
    setQuestion('');
    setActiveHistoryId(null);
    setError(null);
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
    <div className="px-8 py-10 max-w-[1180px] mx-auto">
      <div className="flex items-center justify-between gap-4 mb-6">
        <div className="flex items-center gap-2">
          <Sparkles className="w-5 h-5 text-rw-primary" />
          <h1 className="text-[22px] font-medium text-rw-text-primary">
            Ask your meetings
          </h1>
        </div>
        {(result || question) && (
          <button
            type="button"
            onClick={startNew}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-[12px] rounded-rw-md border border-rw-border text-rw-text-secondary hover:bg-rw-hover transition-colors"
          >
            <MessageSquarePlus className="w-3.5 h-3.5" />
            New question
          </button>
        )}
      </div>

      {/* Two columns at desktop width, stacked below 1024px. */}
      <div className="flex flex-col lg:flex-row gap-8 items-start">
        <div className="flex-1 min-w-0 w-full">
          <p className="text-[13px] text-rw-text-secondary mb-5 leading-relaxed">
            Ask anything across your indexed meetings. The assistant searches
            your transcripts and summaries, then synthesizes an answer with
            citations back to the source meetings. Questions that name a time
            period — &ldquo;how did my day go?&rdquo;, &ldquo;what happened last
            week?&rdquo; — are answered only from meetings recorded in that
            window.
          </p>

          <div className="border border-rw-border rounded-rw-lg bg-rw-card p-3 mb-8">
            <textarea
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="e.g. How did my day go? What did the customer ask about onboarding?"
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
            <AskAnswer
              answer={result.answer}
              citations={result.citations}
              scope={result.scope}
              model={result.model || undefined}
              elapsedMs={result.model ? result.elapsed_ms : undefined}
              onOpenCitation={navigateToCitation}
            />
          )}
        </div>

        <aside className="w-full lg:w-[320px] lg:flex-shrink-0">
          <div className="text-[11px] uppercase tracking-wider text-rw-text-tertiary mb-2 px-1">
            Saved questions
          </div>
          <AskHistoryList
            entries={history.entries}
            loading={history.loading}
            activeId={activeHistoryId}
            onSelect={restore}
            onTogglePin={history.togglePin}
            onDelete={history.remove}
            emptyHint="Questions you ask are saved here. Pin the ones you want to keep at the top."
          />
        </aside>
      </div>
    </div>
  );
}
