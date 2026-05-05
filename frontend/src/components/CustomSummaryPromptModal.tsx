'use client';

// Phase 4 Task 1B: per-meeting custom summary prompt.
// Replaces the previous ModelSettingsModal that opened off the meeting
// toolbar's gear icon. The user types a one-off instruction (e.g.
// "Focus on action items only.") which the backend appends to the
// standard summary template on the next /process-transcript call.

import { useEffect, useState } from 'react';

const BACKEND = 'http://localhost:5167';
const MAX_PROMPT_LEN = 800;

interface Props {
  meetingId: string;
  open: boolean;
  onClose: () => void;
  /**
   * Triggers a regenerate after the prompt has been persisted. The
   * caller already has the full regenerate flow wired up (poll,
   * Auto-rename guard, etc.) so the modal stays decoupled.
   */
  onRegenerate: () => void | Promise<void>;
}

export function CustomSummaryPromptModal({
  meetingId,
  open,
  onClose,
  onRegenerate,
}: Props) {
  const [prompt, setPrompt] = useState('');
  const [initial, setInitial] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch the persisted prompt when the modal opens. Reset state on
  // close so a re-open of a different meeting doesn't show stale text.
  useEffect(() => {
    if (!open) {
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const resp = await fetch(
          `${BACKEND}/meetings/${meetingId}/custom-prompt`,
        );
        if (!resp.ok) throw new Error(`status ${resp.status}`);
        const data = await resp.json();
        if (cancelled) return;
        const value = data?.prompt ?? '';
        setPrompt(value);
        setInitial(value);
      } catch (err) {
        if (!cancelled) {
          console.error('Failed to load custom prompt', err);
          setError('Could not load the saved prompt.');
          setPrompt('');
          setInitial('');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, meetingId]);

  if (!open) return null;

  const trimmed = prompt.trim();
  const dirty = trimmed !== (initial ?? '').trim();

  // Persist the prompt (or clear it when blank). On success kick off
  // the parent's regenerate flow and close the modal. On failure
  // surface the error and leave the modal open.
  async function persistAndRegenerate() {
    setSaving(true);
    setError(null);
    try {
      const resp = await fetch(
        `${BACKEND}/meetings/${meetingId}/custom-prompt`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          // null vs "" are treated identically server-side; we send
          // null when the textarea is empty to make the cleared state
          // explicit on the wire.
          body: JSON.stringify({ prompt: trimmed.length ? trimmed : null }),
        },
      );
      if (!resp.ok) throw new Error(`status ${resp.status}`);
      onClose();
      await onRegenerate();
    } catch (err) {
      console.error('Failed to save custom prompt', err);
      setError('Could not save. Try again.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg p-6 max-w-lg w-full mx-4 shadow-xl">
        <div className="flex justify-between items-start mb-3">
          <div>
            <h3 className="text-lg font-semibold text-gray-900">
              Custom Summary Prompt
            </h3>
            <p className="mt-1 text-sm text-gray-600">
              Add a one-off instruction for this meeting&apos;s summary.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-500 hover:text-gray-700"
            aria-label="Close"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="h-5 w-5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>

        <p className="mt-1 mb-2 text-xs text-gray-500">
          Example: <span className="italic">
            &ldquo;Focus on technical decisions and action items for the
            engineering team. Skip pleasantries and small talk.&rdquo;
          </span>
        </p>

        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value.slice(0, MAX_PROMPT_LEN))}
          rows={5}
          disabled={loading || saving}
          placeholder={
            loading ? 'Loading…' : 'Add an instruction for this meeting only…'
          }
          className="w-full px-3 py-2 text-sm bg-white border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500 resize-y disabled:bg-gray-50"
        />
        <div className="mt-1 flex justify-between text-xs text-gray-500">
          <span>
            Applied to the next <strong>Generate Note</strong> or{' '}
            <strong>Regenerate</strong>.
          </span>
          <span>
            {prompt.length}/{MAX_PROMPT_LEN}
          </span>
        </div>

        {error && (
          <div className="mt-3 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-md">
            {error}
          </div>
        )}

        <div className="mt-5 flex items-center justify-between">
          {initial && initial.length > 0 ? (
            <button
              type="button"
              onClick={() => setPrompt('')}
              disabled={saving}
              className="text-sm text-gray-600 hover:text-gray-900"
            >
              Clear
            </button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="px-4 py-2 text-sm text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={persistAndRegenerate}
              disabled={saving || loading}
              className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed"
              title={
                dirty
                  ? 'Save the prompt and regenerate the summary'
                  : 'Regenerate the summary'
              }
            >
              {saving ? 'Saving…' : 'Save & Regenerate'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
