'use client';

// Phase 6 Task 4: YouTube import modal.
// User pastes a YouTube URL; we POST to /youtube/summarize, navigate
// to the new meeting, and the existing summary pipeline takes over.
// If the auto-fetch fails (422 from the backend), we render a manual-
// paste fallback inline — same modal, no extra round-trip.

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, X, Youtube } from 'lucide-react';
import { useSidebar } from '@/components/Sidebar/SidebarProvider';

const BACKEND = 'http://localhost:5167';

interface Props {
  open: boolean;
  onClose: () => void;
}

interface SummarizeResponse {
  meeting_id: string;
  title: string;
  process_id: string;
}

export function YoutubeImportModal({ open, onClose }: Props) {
  const router = useRouter();
  const { setCurrentMeeting } = useSidebar();
  const [url, setUrl] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Manual-paste fallback shown when the auto-fetch returns 422.
  // Falls back to the same flow with /youtube/summarize-manual.
  const [showManual, setShowManual] = useState(false);
  const [manualTitle, setManualTitle] = useState('');
  const [manualTranscript, setManualTranscript] = useState('');

  useEffect(() => {
    if (open) {
      setUrl('');
      setError(null);
      setShowManual(false);
      setManualTitle('');
      setManualTranscript('');
      setSubmitting(false);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !submitting) {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, submitting, onClose]);

  if (!open) return null;

  function navigateToMeeting(resp: SummarizeResponse) {
    setCurrentMeeting({ id: resp.meeting_id, title: resp.title });
    router.push('/meeting-details');
    onClose();
  }

  async function handleSubmit() {
    const trimmed = url.trim();
    if (!trimmed) {
      setError('Paste a YouTube URL.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const resp = await fetch(`${BACKEND}/youtube/summarize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: trimmed }),
      });
      if (resp.status === 422) {
        // Transcript fetch failed → reveal the manual-paste fallback.
        let detail = 'Could not fetch the transcript automatically.';
        try {
          const body = await resp.json();
          if (body?.detail) detail = body.detail;
        } catch {
          /* keep default */
        }
        setError(detail);
        setShowManual(true);
        setSubmitting(false);
        return;
      }
      if (!resp.ok) {
        let detail = `status ${resp.status}`;
        try {
          const body = await resp.json();
          detail = body?.detail ?? detail;
        } catch {
          /* keep status code */
        }
        throw new Error(detail);
      }
      const data = (await resp.json()) as SummarizeResponse;
      navigateToMeeting(data);
    } catch (err) {
      console.error('YouTube summarize failed', err);
      setError(`Failed: ${err instanceof Error ? err.message : err}`);
      setSubmitting(false);
    }
  }

  async function handleManualSubmit() {
    const trimmedUrl = url.trim();
    const trimmedTitle = manualTitle.trim();
    const trimmedTranscript = manualTranscript.trim();
    if (!trimmedUrl || !trimmedTitle || !trimmedTranscript) {
      setError('Fill in URL, title, and transcript.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const resp = await fetch(`${BACKEND}/youtube/summarize-manual`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: trimmedUrl,
          title: trimmedTitle,
          transcript: trimmedTranscript,
        }),
      });
      if (!resp.ok) {
        let detail = `status ${resp.status}`;
        try {
          const body = await resp.json();
          detail = body?.detail ?? detail;
        } catch {
          /* */
        }
        throw new Error(detail);
      }
      const data = (await resp.json()) as SummarizeResponse;
      navigateToMeeting(data);
    } catch (err) {
      console.error('YouTube manual summarize failed', err);
      setError(`Failed: ${err instanceof Error ? err.message : err}`);
      setSubmitting(false);
    }
  }

  return (
    <>
      <div
        className="fixed inset-0 z-[60]"
        style={{ backgroundColor: 'rgba(0, 0, 0, 0.4)' }}
        onClick={() => !submitting && onClose()}
      />
      <div
        className="fixed left-1/2 top-1/2 z-[61] w-[520px] -translate-x-1/2 -translate-y-1/2 rounded-rw-lg border border-rw-border bg-rw-card shadow-xl"
        style={{ backgroundColor: 'var(--rw-bg-card)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-rw-border">
          <div className="flex items-center gap-2">
            <Youtube className="w-5 h-5 text-rw-coral" />
            <div>
              <div className="text-[15px] font-medium text-rw-text-primary">
                Summarize a YouTube video
              </div>
              <div className="text-[12px] text-rw-text-tertiary mt-0.5">
                Paste a YouTube URL — we&rsquo;ll fetch the transcript and
                run the same summary as a meeting.
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="text-rw-text-tertiary hover:text-rw-text-primary"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-3">
          <label className="block text-[12px] font-medium text-rw-text-secondary">
            YouTube URL
            <input
              type="url"
              autoFocus
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !showManual && !submitting) {
                  e.preventDefault();
                  void handleSubmit();
                }
              }}
              disabled={submitting}
              placeholder="https://www.youtube.com/watch?v=..."
              className="mt-1 w-full px-3 py-2 text-[13px] bg-rw-card border border-rw-border rounded-rw-md text-rw-text-primary focus:outline-none focus:ring-2 focus:ring-rw-primary-bg focus:border-rw-primary"
            />
          </label>

          {error && (
            <div className="px-3 py-2 rounded-rw-md text-[12px] bg-rw-danger-bg text-rw-danger-text">
              {error}
            </div>
          )}

          {showManual && (
            <div className="border-t border-rw-border pt-3 space-y-3">
              <p className="text-[12px] text-rw-text-secondary">
                <strong>Manual fallback.</strong> Open the video on
                YouTube, click <strong>&hellip;</strong> &rarr;{' '}
                <strong>Show transcript</strong>, copy the entire
                transcript text, and paste it below. We&rsquo;ll run the
                same summary pipeline against the pasted text.
              </p>
              <label className="block text-[12px] font-medium text-rw-text-secondary">
                Video title
                <input
                  type="text"
                  value={manualTitle}
                  onChange={(e) => setManualTitle(e.target.value)}
                  disabled={submitting}
                  placeholder="e.g. Lex Fridman: Interview with X"
                  className="mt-1 w-full px-3 py-2 text-[13px] bg-rw-card border border-rw-border rounded-rw-md text-rw-text-primary focus:outline-none focus:ring-2 focus:ring-rw-primary-bg focus:border-rw-primary"
                />
              </label>
              <label className="block text-[12px] font-medium text-rw-text-secondary">
                Transcript
                <textarea
                  value={manualTranscript}
                  onChange={(e) => setManualTranscript(e.target.value)}
                  disabled={submitting}
                  rows={10}
                  placeholder="Paste the transcript here…"
                  className="mt-1 w-full px-3 py-2 text-[12px] bg-rw-card border border-rw-border rounded-rw-md text-rw-text-primary focus:outline-none focus:ring-2 focus:ring-rw-primary-bg focus:border-rw-primary resize-y min-h-[180px]"
                />
              </label>
              <div className="text-[11px] text-rw-text-tertiary">
                {manualTranscript.length.toLocaleString()} characters
              </div>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 px-5 py-3 border-t border-rw-border">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="px-3 py-1.5 text-[13px] text-rw-text-secondary hover:text-rw-text-primary"
          >
            Cancel
          </button>
          {!showManual ? (
            <button
              type="button"
              onClick={handleSubmit}
              disabled={submitting}
              className="px-3 py-1.5 text-[13px] font-medium rounded-rw-md bg-rw-primary text-white hover:opacity-90 disabled:opacity-60 inline-flex items-center gap-1.5"
            >
              {submitting && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              {submitting ? 'Fetching transcript…' : 'Summarize'}
            </button>
          ) : (
            <button
              type="button"
              onClick={handleManualSubmit}
              disabled={submitting}
              className="px-3 py-1.5 text-[13px] font-medium rounded-rw-md bg-rw-primary text-white hover:opacity-90 disabled:opacity-60 inline-flex items-center gap-1.5"
            >
              {submitting && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              {submitting ? 'Saving…' : 'Use pasted transcript'}
            </button>
          )}
        </div>
      </div>
    </>
  );
}
