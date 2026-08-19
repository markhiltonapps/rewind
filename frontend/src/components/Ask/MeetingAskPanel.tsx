'use client';

// "Ask about this recording" — a Q&A panel scoped to a single meeting.
//
// Sends POST /ask with `meeting_id` set, which makes the backend read
// that meeting's chunks directly instead of running a corpus-wide
// vector search. Answers are saved to the same ask_history table,
// filtered to this meeting, so each recording keeps its own thread of
// questions that can be reopened, pinned, or deleted.

import { useState } from 'react';
import { Sparkles, Loader2, ArrowUp, ChevronDown, ChevronRight } from 'lucide-react';
import { AskAnswer } from './AskAnswer';
import { AskHistoryList } from './AskHistoryList';
import { useAskHistory } from './useAskHistory';
import { BACKEND, type AskResponse, type AskHistoryEntry } from './types';

const SUGGESTIONS = [
  'What were the action items?',
  'What decisions were made?',
  'Summarize the key points in three bullets.',
  'What questions were left unanswered?',
];

interface Props {
  meetingId: string;
  meetingTitle?: string;
}

export function MeetingAskPanel({ meetingId, meetingTitle }: Props) {
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<AskResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeHistoryId, setActiveHistoryId] = useState<number | null>(null);

  const history = useAskHistory({ meetingId });

  async function submit(q?: string) {
    const text = (q ?? question).trim();
    if (!text || submitting) return;
    setSubmitting(true);
    setError(null);
    if (q) setQuestion(q);
    try {
      const resp = await fetch(`${BACKEND}/ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: text, meeting_id: meetingId }),
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
    });
    setQuestion(entry.question);
    setActiveHistoryId(entry.id);
    setError(null);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void submit();
    }
  }

  return (
    <div className="border border-rw-border rounded-rw-lg bg-rw-card overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-4 py-3 hover:bg-rw-hover transition-colors text-left"
        aria-expanded={open}
      >
        {open ? (
          <ChevronDown className="w-4 h-4 text-rw-text-tertiary flex-shrink-0" />
        ) : (
          <ChevronRight className="w-4 h-4 text-rw-text-tertiary flex-shrink-0" />
        )}
        <Sparkles className="w-4 h-4 text-rw-primary flex-shrink-0" />
        <span className="text-[14px] font-medium text-rw-text-primary">
          Ask about this recording
        </span>
        {history.entries.length > 0 && (
          <span className="ml-auto text-[11px] text-rw-text-tertiary">
            {history.entries.length} saved
          </span>
        )}
      </button>

      {open && (
        <div className="px-4 pb-4 space-y-4 border-t border-rw-border pt-4">
          <div className="border border-rw-border rounded-rw-md bg-rw-bg-app p-2.5">
            <textarea
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder={
                meetingTitle
                  ? `Ask anything about "${meetingTitle}"…`
                  : 'Ask anything about this recording…'
              }
              rows={2}
              disabled={submitting}
              className="w-full bg-transparent text-[13.5px] text-rw-text-primary placeholder:text-rw-text-tertiary resize-y min-h-[48px] focus:outline-none"
            />
            <div className="flex justify-between items-center mt-2 pt-2 border-t border-rw-border">
              <span className="text-[11px] text-rw-text-tertiary">
                Cmd/Ctrl + Enter to submit
              </span>
              <button
                type="button"
                onClick={() => submit()}
                disabled={submitting || !question.trim()}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[12.5px] font-medium rounded-rw-md bg-rw-primary text-white hover:opacity-90 disabled:opacity-50"
              >
                {submitting ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <ArrowUp className="w-3.5 h-3.5" />
                )}
                {submitting ? 'Thinking…' : 'Ask'}
              </button>
            </div>
          </div>

          {/* Starter prompts — only before the first answer, so they
              don't clutter the panel once it's in use. */}
          {!result && !submitting && (
            <div className="flex flex-wrap gap-1.5">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => submit(s)}
                  className="px-2.5 py-1 text-[11.5px] rounded-full border border-rw-border text-rw-text-secondary hover:bg-rw-hover hover:border-rw-border-strong transition-colors"
                >
                  {s}
                </button>
              ))}
            </div>
          )}

          {error && (
            <div className="px-3 py-2 rounded-rw-md text-[12.5px] bg-rw-danger-bg text-rw-danger-text">
              {error}
            </div>
          )}

          {result && (
            <AskAnswer
              answer={result.answer}
              citations={result.citations}
              hideSources
              model={result.model || undefined}
              elapsedMs={result.model ? result.elapsed_ms : undefined}
            />
          )}

          {history.entries.length > 0 && (
            <div className="pt-3 border-t border-rw-border">
              <div className="text-[10px] uppercase tracking-wider text-rw-text-tertiary mb-2 px-1">
                Saved questions
              </div>
              <AskHistoryList
                entries={history.entries}
                loading={history.loading}
                activeId={activeHistoryId}
                onSelect={restore}
                onTogglePin={history.togglePin}
                onDelete={history.remove}
                compact
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
