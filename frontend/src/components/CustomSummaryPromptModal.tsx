'use client';

// Phase 4 Task 1B: per-meeting custom summary prompt modal.
// Phase 4 Task 1D: + saved-prompt library (categorized dropdown,
//                    save-to-library form, ✨ Enhance with AI).
//
// Entry point: gear icon on the meeting-detail toolbar.
//
// Architecture: textarea is the single source of truth for "what
// will be applied". The saved-prompts dropdown writes into the
// textarea (and tracks selection); editing the textarea diverges the
// selection (so use_count only bumps on a verbatim apply). The
// enhance side-by-side rewrites the textarea on accept. Save &
// Regenerate persists to the meeting via the existing PATCH
// /meetings/{id}/custom-prompt endpoint and triggers the parent's
// regenerate flow.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Sparkles, Save, Trash2, X, CheckCircle2, Loader2 } from 'lucide-react';

const BACKEND = 'http://localhost:5167';
const MAX_PROMPT_LEN = 4000;
const MAX_NAME_LEN = 80;
const MAX_CATEGORY_LEN = 40;

export interface SavedPrompt {
  id: number;
  name: string;
  category: string;
  prompt_text: string;
  is_starter: boolean;
  created_at: string;
  use_count: number;
}

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

// ───────────────────────────────────────────────────────────────────
// Small UI atoms
// ───────────────────────────────────────────────────────────────────

function SavedFlash({ at }: { at: number | null }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (at === null) return;
    setVisible(true);
    const t = setTimeout(() => setVisible(false), 1500);
    return () => clearTimeout(t);
  }, [at]);
  if (!visible) return null;
  return (
    <span className="inline-flex items-center gap-1 text-xs text-green-700">
      <CheckCircle2 className="w-3.5 h-3.5" />
      Saved
    </span>
  );
}

// ───────────────────────────────────────────────────────────────────
// Main component
// ───────────────────────────────────────────────────────────────────

export function CustomSummaryPromptModal({
  meetingId,
  open,
  onClose,
  onRegenerate,
}: Props) {
  // Textarea state — the single source of truth for "what gets applied".
  const [prompt, setPrompt] = useState('');
  const [initial, setInitial] = useState<string | null>(null);
  const [meetingPromptLoaded, setMeetingPromptLoaded] = useState(false);

  // Saved prompts library.
  const [library, setLibrary] = useState<SavedPrompt[] | null>(null);
  const [libraryError, setLibraryError] = useState<string | null>(null);
  // The id of the saved prompt the textarea was filled from. Cleared
  // when the user edits the textarea so use_count only bumps on a
  // verbatim apply.
  const [selectedId, setSelectedId] = useState<number | null>(null);
  // Last value we wrote into the textarea via "pick a saved prompt" —
  // used to detect divergence after the user types.
  const sourceTextRef = useRef<string | null>(null);

  // Save-to-library inline form.
  const [showSaveForm, setShowSaveForm] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [saveCategory, setSaveCategory] = useState('');
  const [lastUsedCategory, setLastUsedCategory] = useState('General');
  const [savingNew, setSavingNew] = useState(false);

  // Enhance flow.
  const [enhancing, setEnhancing] = useState(false);
  const [enhancement, setEnhancement] = useState<{
    original: string;
    enhanced: string;
  } | null>(null);

  // Top-level modal status.
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  // ── Load meeting's persisted prompt + library when the modal opens ──
  useEffect(() => {
    if (!open) {
      // Reset on close so a re-open of a different meeting starts fresh.
      setError(null);
      setShowSaveForm(false);
      setEnhancement(null);
      setSelectedId(null);
      sourceTextRef.current = null;
      return;
    }

    let cancelled = false;
    setMeetingPromptLoaded(false);
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
        if (!cancelled) setMeetingPromptLoaded(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open, meetingId]);

  const refreshLibrary = useCallback(async () => {
    setLibraryError(null);
    try {
      const resp = await fetch(`${BACKEND}/saved-prompts`);
      if (!resp.ok) throw new Error(`status ${resp.status}`);
      const data = (await resp.json()) as SavedPrompt[];
      setLibrary(data);
    } catch (err) {
      console.error('Failed to load /saved-prompts', err);
      setLibrary([]);
      setLibraryError('Could not load saved prompts.');
    }
  }, []);

  useEffect(() => {
    if (open) refreshLibrary();
  }, [open, refreshLibrary]);

  // ── Keyboard shortcuts: Esc closes, Cmd/Ctrl+Enter saves ──
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        // Defer to avoid double-triggering when the focused textarea
        // would also handle Enter — saving will close the modal.
        void persistAndRegenerate();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, prompt, selectedId]);

  // ── Library category groupings (alphabetical within each) ──
  // Hoisted above the `if (!open) return null` early return so the
  // hook count stays stable across open/close cycles. React's Rules
  // of Hooks: every hook must be called in the same order on every
  // render — placing useMemo after a conditional return triggers
  // "Rendered more hooks than during the previous render" the moment
  // the modal reopens.
  const groupedLibrary = useMemo(() => {
    if (!library) return [] as Array<{ category: string; items: SavedPrompt[] }>;
    const groups = new Map<string, SavedPrompt[]>();
    for (const p of library) {
      const arr = groups.get(p.category) ?? [];
      arr.push(p);
      groups.set(p.category, arr);
    }
    const sortedCategories = Array.from(groups.keys()).sort((a, b) =>
      a.localeCompare(b),
    );
    return sortedCategories.map((category) => ({
      category,
      items: (groups.get(category) ?? []).sort((a, b) =>
        a.name.localeCompare(b.name),
      ),
    }));
  }, [library]);

  const knownCategories = useMemo(() => {
    if (!library) return ['General'];
    const set = new Set<string>(['General']);
    for (const p of library) set.add(p.category);
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [library]);

  if (!open) return null;

  const trimmed = prompt.trim();

  // Divergence: textarea was filled from a saved prompt but has been
  // edited. Cleared in the textarea onChange handler when the source
  // text no longer matches.
  const sourceText = sourceTextRef.current;
  const matchesSource =
    selectedId !== null && sourceText !== null && prompt === sourceText;

  // ── Pick a saved prompt → fill textarea, track source ──
  function pickSaved(promptId: number) {
    const found = (library ?? []).find((p) => p.id === promptId);
    if (!found) return;
    setPrompt(found.prompt_text);
    setSelectedId(promptId);
    sourceTextRef.current = found.prompt_text;
    // Picking dismisses any in-progress enhance comparison so the user
    // doesn't see a stale "Your version" against the new content.
    setEnhancement(null);
  }

  // ── Delete a saved prompt with confirm ──
  async function deleteSaved(promptId: number, name: string) {
    const ok = window.confirm(
      `Delete "${name}"? This cannot be undone.`,
    );
    if (!ok) return;
    try {
      const resp = await fetch(`${BACKEND}/saved-prompts/${promptId}`, {
        method: 'DELETE',
      });
      if (!resp.ok && resp.status !== 204) {
        throw new Error(`status ${resp.status}`);
      }
      // Refresh library; clear selection if we just deleted the one
      // currently filling the textarea.
      if (selectedId === promptId) {
        setSelectedId(null);
        sourceTextRef.current = null;
      }
      await refreshLibrary();
    } catch (err) {
      console.error('Delete failed', err);
      setError('Could not delete that prompt. Try again.');
    }
  }

  // ── Save-to-library form ──
  function openSaveForm() {
    setSaveName('');
    setSaveCategory(lastUsedCategory);
    setShowSaveForm(true);
  }

  async function submitSaveForm() {
    const name = saveName.trim();
    const category = saveCategory.trim();
    const text = prompt.trim();
    if (!name || !category || !text) {
      setError(
        !text
          ? 'Type something in the prompt field before saving.'
          : 'Name and category are required.',
      );
      return;
    }
    setSavingNew(true);
    setError(null);
    try {
      const resp = await fetch(`${BACKEND}/saved-prompts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.slice(0, MAX_NAME_LEN),
          category: category.slice(0, MAX_CATEGORY_LEN),
          prompt_text: text,
        }),
      });
      if (!resp.ok) throw new Error(`status ${resp.status}`);
      const created = (await resp.json()) as SavedPrompt;
      setLastUsedCategory(category);
      setShowSaveForm(false);
      setSavedAt(Date.now());
      // Treat the just-saved prompt as the current source so editing
      // diverges the selection like any other library pick.
      setSelectedId(created.id);
      sourceTextRef.current = created.prompt_text;
      await refreshLibrary();
    } catch (err) {
      console.error('Save to library failed', err);
      setError('Could not save. Try again.');
    } finally {
      setSavingNew(false);
    }
  }

  // ── Enhance with AI ──
  async function runEnhance() {
    if (!trimmed) return;
    const original = prompt;
    setEnhancing(true);
    setError(null);
    try {
      const resp = await fetch(`${BACKEND}/saved-prompts/enhance`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt_text: original }),
      });
      if (!resp.ok) {
        let detail = `status ${resp.status}`;
        try {
          const body = await resp.json();
          detail = body?.detail ?? detail;
        } catch {
          /* non-JSON body */
        }
        throw new Error(detail);
      }
      const data = await resp.json();
      setEnhancement({ original, enhanced: data.enhanced });
    } catch (err) {
      console.error('Enhance failed', err);
      setError(`Enhance failed: ${err instanceof Error ? err.message : err}`);
      setEnhancement(null);
    } finally {
      setEnhancing(false);
    }
  }

  function acceptEnhancement() {
    if (!enhancement) return;
    setPrompt(enhancement.enhanced);
    // Replacing via Enhance counts as divergence from any previously
    // picked saved prompt — clear the selection.
    setSelectedId(null);
    sourceTextRef.current = null;
    setEnhancement(null);
  }

  function rejectEnhancement() {
    setEnhancement(null);
  }

  // ── Save & Regenerate ──
  async function persistAndRegenerate() {
    setSaving(true);
    setError(null);
    try {
      const resp = await fetch(
        `${BACKEND}/meetings/${meetingId}/custom-prompt`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          // null vs "" are equivalent server-side; sending null when
          // empty makes the cleared state explicit on the wire.
          body: JSON.stringify({ prompt: trimmed.length ? trimmed : null }),
        },
      );
      if (!resp.ok) throw new Error(`status ${resp.status}`);

      // Bump use_count if this regenerate uses a saved prompt verbatim.
      // Best-effort — failure here doesn't fail the regenerate.
      if (selectedId !== null && matchesSource) {
        void fetch(`${BACKEND}/saved-prompts/${selectedId}/use`, {
          method: 'POST',
        }).catch((err) =>
          console.warn('use_count bump failed (non-fatal)', err),
        );
      }

      onClose();
      await onRegenerate();
    } catch (err) {
      console.error('Failed to save custom prompt', err);
      setError('Could not save. Try again.');
    } finally {
      setSaving(false);
    }
  }

  // ── Render ──
  return (
    /* Phase 4 Task 2.5 bug fix: backdrop is now a SIBLING of the panel
       inside an absolute-positioned container, not a parent. The
       earlier wrapper carried `bg-black/45` AND held the panel, which
       read as "page bleeding through the modal" on some setups. With
       siblings the panel cannot inherit any backdrop opacity, and
       shadow-rw-modal makes the lift unambiguous. The explicit
       inline backgroundColor is belt-and-suspenders against any
       Tailwind purge / class-generation hiccup hiding bg-rw-card. */
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div
        className="absolute inset-0 bg-black/45"
        onClick={onClose}
        aria-hidden
      />
      <div
        className="relative bg-rw-card rounded-rw-lg p-7 max-w-[720px] w-full mx-4 shadow-rw-modal max-h-[92vh] overflow-y-auto border border-rw-border"
        style={{ backgroundColor: 'var(--rw-bg-card)' }}
      >
        {/* Header */}
        <div className="flex justify-between items-start mb-3">
          <div>
            <h3 className="text-lg font-semibold text-gray-900">
              Custom Summary Prompt
            </h3>
            <p className="mt-1 text-sm text-gray-600">
              Apply a saved prompt or write a new instruction. The next time
              you generate or regenerate this meeting&apos;s summary, the
              instruction will be appended to the system prompt.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <SavedFlash at={savedAt} />
            <button
              type="button"
              onClick={onClose}
              className="text-gray-500 hover:text-gray-700"
              aria-label="Close"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        {/* ── Saved prompts ── */}
        <section className="mt-4">
          <h4 className="text-xs font-medium uppercase tracking-wider text-gray-500 mb-2">
            Saved prompts
          </h4>
          {library === null ? (
            <div className="h-9 bg-gray-100 rounded-md animate-pulse" />
          ) : libraryError ? (
            <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-md flex items-center justify-between">
              <span>{libraryError}</span>
              <button
                type="button"
                onClick={refreshLibrary}
                className="text-sm underline"
              >
                Retry
              </button>
            </div>
          ) : library.length === 0 ? (
            <div className="text-sm text-gray-500 italic px-3 py-2 border border-dashed border-gray-300 rounded-md">
              No saved prompts yet — write one below and click{' '}
              <strong>Save to library</strong>.
            </div>
          ) : (
            <div className="border border-gray-200 rounded-md divide-y divide-gray-100">
              {groupedLibrary.map(({ category, items }) => (
                <div key={category} className="py-1">
                  <div className="px-3 pt-1.5 pb-0.5 text-[11px] font-semibold uppercase tracking-wider text-gray-400">
                    {category}
                  </div>
                  <ul>
                    {items.map((p) => {
                      const isSelected = selectedId === p.id;
                      return (
                        <li
                          key={p.id}
                          className={`flex items-center justify-between px-3 py-1.5 hover:bg-gray-50 ${
                            isSelected ? 'bg-rw-primary-bg' : ''
                          }`}
                        >
                          <button
                            type="button"
                            onClick={() => pickSaved(p.id)}
                            className="flex-1 text-left text-sm text-gray-800 truncate"
                            title={p.prompt_text}
                          >
                            {p.name}
                            {p.use_count > 0 && (
                              <span className="ml-2 text-xs text-gray-400">
                                · used {p.use_count}×
                              </span>
                            )}
                          </button>
                          <button
                            type="button"
                            onClick={() => deleteSaved(p.id, p.name)}
                            className="ml-2 text-gray-400 hover:text-red-600"
                            title={`Delete "${p.name}"`}
                            aria-label={`Delete ${p.name}`}
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* ── Your instruction ── */}
        <section className="mt-5">
          <h4 className="text-xs font-medium uppercase tracking-wider text-gray-500 mb-2">
            Your instruction
          </h4>
          <textarea
            value={prompt}
            onChange={(e) => {
              const next = e.target.value.slice(0, MAX_PROMPT_LEN);
              setPrompt(next);
              // Editing diverges from the picked saved prompt. Clear
              // the selection so use_count won't bump on save.
              if (selectedId !== null && next !== sourceTextRef.current) {
                setSelectedId(null);
                sourceTextRef.current = null;
              }
            }}
            rows={5}
            disabled={!meetingPromptLoaded || saving}
            placeholder={
              meetingPromptLoaded
                ? 'Add an instruction for this meeting only…'
                : 'Loading…'
            }
            className="w-full px-3 py-2.5 text-[14px] bg-rw-card border border-rw-border rounded-rw-md focus:outline-none focus:ring-2 focus:ring-rw-primary-bg focus:border-rw-primary resize-y disabled:bg-rw-subtle min-h-[120px]"
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

          {/* Action row: enhance / save / clear */}
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={runEnhance}
              disabled={!trimmed || enhancing || saving}
              className="px-3 py-1.5 text-sm rounded-md border border-gray-300 bg-white hover:bg-gray-50 inline-flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {enhancing ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Sparkles className="w-4 h-4 text-purple-600" />
              )}
              Enhance with AI
            </button>
            <button
              type="button"
              onClick={openSaveForm}
              disabled={!trimmed || showSaveForm || saving}
              className="px-3 py-1.5 text-sm rounded-md border border-gray-300 bg-white hover:bg-gray-50 inline-flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Save className="w-4 h-4 text-gray-700" />
              Save to library
            </button>
            {prompt.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  setPrompt('');
                  setSelectedId(null);
                  sourceTextRef.current = null;
                  setEnhancement(null);
                }}
                disabled={saving}
                className="px-3 py-1.5 text-sm rounded-md text-gray-600 hover:text-gray-900"
              >
                Clear
              </button>
            )}
          </div>

          {/* Save-to-library form (inline) */}
          {showSaveForm && (
            <div className="mt-3 border border-gray-200 rounded-md p-3 bg-gray-50">
              <div className="grid grid-cols-2 gap-2">
                <label className="text-xs text-gray-600">
                  Name
                  <input
                    type="text"
                    value={saveName}
                    maxLength={MAX_NAME_LEN}
                    autoFocus
                    onChange={(e) => setSaveName(e.target.value)}
                    placeholder="e.g. Customer Pain Capture"
                    className="mt-1 w-full px-2.5 py-1.5 text-[13px] bg-rw-card border border-rw-border rounded-rw-md focus:outline-none focus:ring-2 focus:ring-rw-primary-bg focus:border-rw-primary"
                  />
                </label>
                <label className="text-xs text-gray-600">
                  Category
                  <input
                    type="text"
                    value={saveCategory}
                    maxLength={MAX_CATEGORY_LEN}
                    list="saved-prompt-categories"
                    onChange={(e) => setSaveCategory(e.target.value)}
                    placeholder="General"
                    className="mt-1 w-full px-2.5 py-1.5 text-[13px] bg-rw-card border border-rw-border rounded-rw-md focus:outline-none focus:ring-2 focus:ring-rw-primary-bg focus:border-rw-primary"
                  />
                  <datalist id="saved-prompt-categories">
                    {knownCategories.map((c) => (
                      <option key={c} value={c} />
                    ))}
                  </datalist>
                </label>
              </div>
              <div className="mt-2 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowSaveForm(false)}
                  disabled={savingNew}
                  className="px-3 py-1.5 text-sm text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-100"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={submitSaveForm}
                  disabled={
                    savingNew ||
                    !saveName.trim() ||
                    !saveCategory.trim() ||
                    !trimmed
                  }
                  className="px-3 py-1.5 text-[13px] font-medium text-rw-text-on-primary bg-rw-primary rounded-rw-md hover:bg-rw-primary-hover disabled:bg-rw-border-strong"
                >
                  {savingNew ? 'Saving…' : 'Save'}
                </button>
              </div>
            </div>
          )}
        </section>

        {/* ── Enhance comparison ── */}
        {enhancement && (
          <section className="mt-5">
            <h4 className="text-xs font-medium uppercase tracking-wider text-gray-500 mb-2">
              AI Enhancement
            </h4>
            <div className="grid grid-cols-2 gap-3">
              <div className="border border-gray-200 rounded-md p-3 bg-gray-50">
                <div className="text-xs font-semibold text-gray-600 mb-1">
                  Your version
                </div>
                <p className="text-sm text-gray-800 whitespace-pre-wrap">
                  {enhancement.original}
                </p>
                <button
                  type="button"
                  onClick={rejectEnhancement}
                  className="mt-3 px-3 py-1.5 text-xs rounded-md border border-gray-300 bg-white hover:bg-gray-100"
                >
                  Keep mine
                </button>
              </div>
              <div className="border border-rw-info-bg rounded-rw-md p-3 bg-rw-info-bg/40">
                <div className="text-[11px] font-medium uppercase tracking-[0.5px] text-rw-info-text mb-1.5 inline-flex items-center gap-1">
                  <Sparkles className="w-3.5 h-3.5" />
                  AI-enhanced version
                </div>
                <p className="text-[14px] leading-[1.6] text-rw-text-primary whitespace-pre-wrap">
                  {enhancement.enhanced}
                </p>
                <button
                  type="button"
                  onClick={acceptEnhancement}
                  className="mt-3 px-3 py-1.5 text-[12px] font-medium rounded-rw-md bg-rw-primary text-rw-text-on-primary hover:bg-rw-primary-hover"
                >
                  Use this
                </button>
              </div>
            </div>
          </section>
        )}

        {/* Error */}
        {error && (
          <div className="mt-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-md">
            {error}
          </div>
        )}

        {/* Footer */}
        <div className="mt-6 flex items-center justify-between">
          <span className="text-xs text-gray-400">
            {selectedId !== null && matchesSource
              ? 'Picked from library — use_count will increment'
              : selectedId !== null
                ? 'Edited from a saved prompt'
                : (initial?.length ?? 0) > 0
                  ? 'Editing the persisted prompt'
                  : ''}
          </span>
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
              disabled={saving || !meetingPromptLoaded}
              className="px-4 py-2 text-[13px] font-medium text-rw-text-on-primary bg-rw-primary rounded-rw-md hover:bg-rw-primary-hover disabled:bg-rw-border-strong disabled:cursor-not-allowed"
              title="Save the prompt and regenerate the summary (Cmd/Ctrl+Enter)"
            >
              {saving ? 'Saving…' : 'Save & Regenerate'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
