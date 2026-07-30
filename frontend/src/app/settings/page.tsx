'use client';

import React, { useEffect, useMemo, useState } from 'react';
// Phase 4 Task 2.5: section icons removed — they read as decorative
// clutter against the Neato palette. Headings stand alone.
import { ArrowLeft, CheckCircle2, ChevronDown, Sun } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { invoke } from '@tauri-apps/api/core';
import { useSidebar } from '@/components/Sidebar/SidebarProvider';

const BACKEND = 'http://localhost:5167';

// Phase 4 Task 1B: source-key catalog. The first entry of each tuple
// is the canonical key the backend stores in `auto_record_sources`
// (also matches the keys process_to_source_key/label_to_source_key
// emit on the Rust side). The Discord row is shown as
// "experimental" — default OFF — until the detector layer actually
// gates Discord usage (mod.rs has the mapping but no Discord-specific
// detector ships in v1).
const SOURCE_CATALOG: ReadonlyArray<{
  key: string;
  label: string;
  experimental?: boolean;
}> = [
  { key: 'teams', label: 'Microsoft Teams' },
  { key: 'meet', label: 'Google Meet' },
  { key: 'zoom', label: 'Zoom' },
  { key: 'webex', label: 'Webex' },
  { key: 'discord', label: 'Discord', experimental: true },
  // Phase 7 Task 5: "Browser audio" controls whether YouTube /
  // Vimeo / etc. trigger recording. Default ON; uncheck to suppress.
  { key: 'browser', label: 'Browser audio (YouTube, etc.)' },
];

const THEME_OPTIONS = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'System' },
] as const;

type Theme = (typeof THEME_OPTIONS)[number]['value'];

interface AppSettings {
  auto_record_enabled: boolean;
  auto_record_sources: string[];
  default_folder_id: string | null;
  theme: Theme;
  about: {
    version: string;
    transcription_provider: string;
    summary_provider: string;
  };
}

// Toggle pill — used for both auto_record_enabled and per-source rows.
//
// Phase 4 Task 2.5 bug fix: the previous version relied entirely on
// Tailwind utility classes derived from the rw-* CSS variables. On
// some configurations the `bg-rw-border-strong` class wasn't reaching
// the rendered DOM (most likely a stale Tailwind JIT cache from the
// Task 2 → Task 2.5 token swap), which left the off-state track
// white-on-white and the entire toggle invisible. Switching to inline
// styles backed by the CSS variables (rather than utility classes)
// guarantees the colors land regardless of class generation.
function Toggle({
  value,
  onChange,
  disabled,
  ariaLabel,
}: {
  value: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  const trackColor = value
    ? 'var(--rw-primary)'
    : 'var(--rw-border-strong)';
  return (
    <button
      type="button"
      role="switch"
      aria-checked={value}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onChange(!value)}
      className={`relative inline-flex flex-none items-center rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-rw-primary/30 ${
        disabled ? 'opacity-60 cursor-not-allowed' : ''
      }`}
      style={{
        backgroundColor: trackColor,
        width: '44px',
        height: '24px',
      }}
    >
      <span
        className="inline-block rounded-full bg-white transition-transform"
        style={{
          width: '20px',
          height: '20px',
          transform: value ? 'translateX(22px)' : 'translateX(2px)',
          boxShadow: '0 1px 2px rgba(0, 0, 0, 0.1)',
        }}
      />
    </button>
  );
}

// Small "Saved" pill that auto-hides after a short delay. Used by each
// section to acknowledge a successful PATCH without piling toasts.
function SavedFlash({ at }: { at: number | null }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (at === null) return;
    setVisible(true);
    const timer = setTimeout(() => setVisible(false), 1500);
    return () => clearTimeout(timer);
  }, [at]);
  if (!visible) return null;
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-rw-sm text-[11px] font-medium bg-rw-success-bg text-rw-success-text">
      <CheckCircle2 className="w-3 h-3" />
      Saved
    </span>
  );
}

export default function SettingsPage() {
  const router = useRouter();
  // Phase 3 Task 9: pull saved-prompt cache + the per-folder default
  // setter from the sidebar context. The Folder Defaults section
  // renders one row per folder with an inline-edit dropdown grouped
  // by category — same data shape as the gear modal's picker.
  const {
    folders,
    savedPrompts,
    setFolderDefaultPrompt,
    refreshFolders,
    // Phase 8 Task 9: auto-summary toggle persists through the
    // sidebar context (it owns the /settings/recording fetch and the
    // POST persistor). Reading it here means we don't need a second
    // fetch from Settings.
    autoSummarizeEnabled,
    setAutoSummarizeEnabled,
  } = useSidebar();
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  // Phase 3 Task 9: id of the folder whose default prompt is being
  // edited inline. null = no row in edit mode.
  const [editingFolderId, setEditingFolderId] = useState<string | null>(null);
  const [editingDraft, setEditingDraft] = useState<number | null>(null);
  const [savingFolderDefault, setSavingFolderDefault] = useState(false);

  // Initial load. Failure leaves settings=null so the form stays in
  // its loading state — preferable to silently rendering wrong values.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const resp = await fetch(`${BACKEND}/settings`);
        if (!resp.ok) throw new Error(`status ${resp.status}`);
        const data = (await resp.json()) as AppSettings;
        if (!cancelled) setSettings(data);
      } catch (err) {
        console.error('Failed to load /settings', err);
        if (!cancelled) setError('Could not load settings.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Optimistic PATCH. Apply locally, send to backend, revert on
   * failure. The optional `afterSave` runs only on success — used to
   * propagate `auto_record_sources` to the Rust detector and to flip
   * the master `set_auto_record` Tauri command for the auto-record
   * toggle.
   */
  async function patch(
    updates: Partial<AppSettings>,
    afterSave?: (next: AppSettings) => Promise<void> | void,
  ) {
    if (!settings) return;
    const prev = settings;
    const next = { ...settings, ...updates };
    setSettings(next);
    setError(null);
    try {
      const body: Record<string, unknown> = {};
      if ('auto_record_enabled' in updates) body.auto_record_enabled = updates.auto_record_enabled;
      if ('auto_record_sources' in updates) body.auto_record_sources = updates.auto_record_sources;
      if ('default_folder_id' in updates) body.default_folder_id = updates.default_folder_id;
      if ('theme' in updates) body.theme = updates.theme;
      const resp = await fetch(`${BACKEND}/settings`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!resp.ok) throw new Error(`status ${resp.status}`);
      const fresh = (await resp.json()) as AppSettings;
      setSettings(fresh);
      setSavedAt(Date.now());
      if (afterSave) {
        try {
          await afterSave(fresh);
        } catch (err) {
          // afterSave failure (e.g. Tauri command unavailable in dev
          // browser) shouldn't roll back the persisted setting — log
          // and continue. The next app launch will sync from the DB.
          console.warn('settings afterSave hook failed', err);
        }
      }
    } catch (err) {
      console.error('PATCH /settings failed', err);
      setSettings(prev);
      setError('Could not save. Try again.');
    }
  }

  // Keyed lookup for the folder dropdown so we can show "Uncategorized"
  // for null and a fallback for orphaned ids (folder deleted while a
  // settings row still pointed at it).
  const folderLookup = useMemo(() => {
    const m = new Map<string, string>();
    for (const f of folders) m.set(f.id, f.name);
    return m;
  }, [folders]);

  // Phase 3 Task 9: group savedPrompts by category (alphabetical
  // within each) for the inline edit <select>. Same shape the
  // CustomSummaryPromptModal uses, kept local to avoid re-fetching.
  const groupedPrompts = useMemo(() => {
    const groups = new Map<string, typeof savedPrompts>();
    for (const p of savedPrompts) {
      const arr = groups.get(p.category) ?? [];
      arr.push(p);
      groups.set(p.category, arr);
    }
    const sortedCategories = Array.from(groups.keys()).sort((a, b) =>
      a.localeCompare(b),
    );
    return sortedCategories.map((category) => ({
      category,
      items: (groups.get(category) ?? []).slice().sort((a, b) =>
        a.name.localeCompare(b.name),
      ),
    }));
  }, [savedPrompts]);

  return (
    <div className="p-8 max-w-3xl mx-auto">
      <div className="flex items-center gap-4 mb-8">
        <button
          onClick={() => router.back()}
          className="flex items-center gap-2 text-[13px] text-rw-text-secondary hover:text-rw-text-primary transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>Back</span>
        </button>
        <h1 className="text-[20px] font-medium text-rw-text-primary">Settings</h1>
        <div className="ml-auto"><SavedFlash at={savedAt} /></div>
      </div>

      {error && (
        <div className="mb-6 px-4 py-3 rounded-rw-md bg-rw-danger-bg text-[13px] text-rw-danger-text">
          {error}
        </div>
      )}

      {settings === null ? (
        <div className="text-[13px] text-rw-text-tertiary">Loading settings…</div>
      ) : (
        <div className="space-y-4">
          {/* === Recording === */}
          <section className="border border-rw-border rounded-rw-lg px-7 py-6 bg-rw-card">
            <header className="mb-5">
              <h2 className="text-[17px] font-medium text-rw-text-primary">Recording</h2>
            </header>

            <label className="flex items-start justify-between p-3 rounded-md cursor-pointer hover:bg-gray-50">
              <div className="pr-4">
                <div className="font-medium text-gray-900">Auto-record meetings</div>
                <div className="mt-1 text-sm text-gray-600">
                  Automatically detect and start recording when a supported
                  meeting begins.
                </div>
              </div>
              <Toggle
                value={settings.auto_record_enabled}
                ariaLabel="Auto-record meetings"
                onChange={(next) =>
                  patch({ auto_record_enabled: next }, async () => {
                    // Mirror to Rust so the FSM gates immediately.
                    try {
                      await invoke('set_auto_record', { enabled: next });
                    } catch (err) {
                      console.warn('set_auto_record command failed', err);
                    }
                    // Also apply the source list to the FSM so the new
                    // master state is observed alongside per-app gating.
                    try {
                      await invoke('set_auto_record_sources', {
                        sources: settings.auto_record_sources,
                      });
                    } catch (err) {
                      // Older builds without this command — non-fatal.
                    }
                  })
                }
              />
            </label>

            {/* Phase 8 Task 9: auto-generate summary on stop. Persists
                via the sidebar context (which owns /settings/recording
                state) so the meeting-saved listener and this toggle
                share one source of truth. */}
            <label className="flex items-start justify-between p-3 rounded-md cursor-pointer hover:bg-gray-50">
              <div className="pr-4">
                <div className="font-medium text-gray-900">Auto-generate summary</div>
                <div className="mt-1 text-sm text-gray-600">
                  As soon as a recording stops, kick off the AI summary in
                  the background. The next meeting can start recording
                  while the previous one is still being summarized.
                </div>
              </div>
              <Toggle
                value={autoSummarizeEnabled === true}
                disabled={autoSummarizeEnabled === null}
                ariaLabel="Auto-generate summary"
                onChange={(next) => {
                  void setAutoSummarizeEnabled(next).then(() => {
                    setSavedAt(Date.now());
                  });
                }}
              />
            </label>

            {settings.auto_record_enabled && (
              <div className="mt-4 pl-3">
                <h3 className="text-sm font-medium uppercase tracking-wider text-gray-500 mb-2">
                  Auto-record sources
                </h3>
                <ul className="divide-y divide-gray-100">
                  {SOURCE_CATALOG.map(({ key, label, experimental }) => {
                    const enabled = settings.auto_record_sources.includes(key);
                    return (
                      <li
                        key={key}
                        className="flex items-center justify-between py-2.5"
                      >
                        <div>
                          <div className="text-sm text-gray-900">
                            {label}
                            {experimental && (
                              <span className="ml-2 text-xs text-gray-500 italic">
                                experimental
                              </span>
                            )}
                          </div>
                        </div>
                        <Toggle
                          value={enabled}
                          ariaLabel={`Auto-record ${label}`}
                          onChange={(next) => {
                            // Phase 4 Task 1B: full-list semantics.
                            // The backend replaces the column with what
                            // we send, so we always serialize the
                            // entire computed set.
                            const set = new Set(settings.auto_record_sources);
                            if (next) set.add(key);
                            else set.delete(key);
                            const sources = Array.from(set);
                            patch({ auto_record_sources: sources }, async () => {
                              try {
                                await invoke('set_auto_record_sources', {
                                  sources,
                                });
                              } catch (err) {
                                console.warn(
                                  'set_auto_record_sources command failed',
                                  err,
                                );
                              }
                            });
                          }}
                        />
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
          </section>

          {/* === Defaults === */}
          <section className="border border-rw-border rounded-rw-lg px-7 py-6 bg-rw-card">
            <header className="mb-5">
              <h2 className="text-[17px] font-medium text-rw-text-primary">Defaults</h2>
            </header>

            <label className="flex items-start justify-between gap-4 p-3 rounded-md hover:bg-gray-50">
              <div className="pr-4">
                <div className="font-medium text-gray-900">
                  Default folder for new recordings
                </div>
                <div className="mt-1 text-sm text-gray-600">
                  New auto-detected and manual recordings land here. Set to
                  Uncategorized to leave them at the top level.
                </div>
              </div>
              <div className="relative">
                <select
                  value={settings.default_folder_id ?? ''}
                  onChange={(e) => {
                    const value = e.target.value || null;
                    patch({ default_folder_id: value });
                  }}
                  className="appearance-none pr-8 pl-3 py-2 text-sm bg-white border border-gray-300 rounded-md hover:border-gray-400 focus:outline-none focus:ring-1 focus:ring-blue-500"
                >
                  <option value="">Uncategorized</option>
                  {folders.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
                  {settings.default_folder_id &&
                    !folderLookup.has(settings.default_folder_id) && (
                      <option value={settings.default_folder_id}>
                        (deleted folder)
                      </option>
                    )}
                </select>
                <ChevronDown className="w-4 h-4 absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none text-gray-500" />
              </div>
            </label>
          </section>

          {/* === Folder defaults === Phase 3 Task 9 ===
              One row per folder. Each row shows the currently-assigned
              default summary prompt (or "None") with an Edit button
              that swaps the cell into a categorized <select>. Save
              fires PATCH /folders/{id} with default_prompt_id. */}
          <section className="border border-rw-border rounded-rw-lg px-7 py-6 bg-rw-card">
            <header className="mb-5">
              <h2 className="text-[17px] font-medium text-rw-text-primary">
                Folder defaults
              </h2>
              <p className="mt-1 text-sm text-rw-text-secondary">
                Set a default summary prompt for each folder. Meetings in
                that folder use the template automatically on first
                summary generation.
              </p>
            </header>

            {folders.length === 0 ? (
              <div className="text-[13px] text-rw-text-tertiary">
                Create folders in the sidebar to set default prompts.
              </div>
            ) : (
              <div className="divide-y divide-rw-border">
                {folders.map((f) => {
                  const isEditing = editingFolderId === f.id;
                  return (
                    <div
                      key={f.id}
                      className="flex items-center justify-between gap-4 py-3"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="text-[13px] font-medium text-rw-text-primary truncate">
                          {f.name}
                        </div>
                        {!isEditing && (
                          <div className="mt-0.5">
                            {f.default_prompt_name ? (
                              <>
                                <span className="text-[13px] text-rw-text-primary">
                                  {f.default_prompt_name}
                                </span>
                                {f.default_prompt_category && (
                                  <span className="ml-2 text-[11px] text-rw-text-tertiary">
                                    {f.default_prompt_category}
                                  </span>
                                )}
                              </>
                            ) : (
                              <span className="text-[13px] text-rw-text-tertiary">
                                None
                              </span>
                            )}
                          </div>
                        )}
                      </div>

                      {isEditing ? (
                        <div className="flex items-center gap-2">
                          <select
                            value={editingDraft === null ? '' : String(editingDraft)}
                            disabled={savingFolderDefault}
                            onChange={(e) => {
                              const v = e.target.value;
                              setEditingDraft(v === '' ? null : Number(v));
                            }}
                            className="appearance-none px-3 py-1.5 text-[13px] border border-rw-border rounded-rw-md bg-rw-card text-rw-text-primary focus:outline-none focus:ring-2 focus:ring-rw-primary-bg focus:border-rw-primary"
                          >
                            <option value="">None</option>
                            {groupedPrompts.map((g) => (
                              <optgroup key={g.category} label={g.category}>
                                {g.items.map((p) => (
                                  <option key={p.id} value={p.id}>
                                    {p.name}
                                  </option>
                                ))}
                              </optgroup>
                            ))}
                          </select>
                          <button
                            type="button"
                            disabled={savingFolderDefault}
                            onClick={() => {
                              setEditingFolderId(null);
                              setEditingDraft(null);
                            }}
                            className="px-2.5 py-1.5 text-[12px] text-rw-text-secondary hover:text-rw-text-primary"
                          >
                            Cancel
                          </button>
                          <button
                            type="button"
                            disabled={savingFolderDefault}
                            onClick={async () => {
                              setSavingFolderDefault(true);
                              const ok = await setFolderDefaultPrompt(
                                f.id,
                                editingDraft,
                              );
                              setSavingFolderDefault(false);
                              if (ok) {
                                setSavedAt(Date.now());
                                setEditingFolderId(null);
                                setEditingDraft(null);
                                // Refresh global state so other rows
                                // pick up any side-effects (none today
                                // — defensive in case ON DELETE
                                // SET NULL fired between the cache
                                // load and the PATCH).
                                await refreshFolders();
                              } else {
                                setError('Could not save folder default. Try again.');
                              }
                            }}
                            className="px-2.5 py-1.5 text-[12px] font-medium rounded-rw-md bg-rw-primary text-white hover:opacity-90 disabled:opacity-60"
                          >
                            {savingFolderDefault ? 'Saving…' : 'Save'}
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => {
                            setEditingFolderId(f.id);
                            setEditingDraft(f.default_prompt_id ?? null);
                          }}
                          className="px-2.5 py-1.5 text-[12px] text-rw-text-secondary hover:text-rw-text-primary border border-rw-border rounded-rw-md hover:border-rw-border-strong"
                        >
                          Edit
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {/* === Appearance === */}
          <section className="border border-rw-border rounded-rw-lg px-7 py-6 bg-rw-card">
            <header className="mb-5">
              <h2 className="text-[17px] font-medium text-rw-text-primary">Appearance</h2>
            </header>

            <label className="flex items-center justify-between gap-4 p-3 rounded-md hover:bg-gray-50">
              <div>
                <div className="font-medium text-gray-900 flex items-center gap-2">
                  <Sun className="w-4 h-4" />
                  Theme
                </div>
                <div className="mt-1 text-sm text-gray-600">
                  Light, Dark, or follow your system. (Persisted; live theme
                  switching ships with v0.5.)
                </div>
              </div>
              <div className="relative">
                <select
                  value={settings.theme}
                  onChange={(e) => patch({ theme: e.target.value as Theme })}
                  className="appearance-none pr-8 pl-3 py-2 text-sm bg-white border border-gray-300 rounded-md hover:border-gray-400 focus:outline-none focus:ring-1 focus:ring-blue-500"
                >
                  {THEME_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
                <ChevronDown className="w-4 h-4 absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none text-gray-500" />
              </div>
            </label>
          </section>

          {/* === About === */}
          <section className="border border-rw-border rounded-rw-lg px-7 py-6 bg-rw-card">
            <header className="mb-5">
              <h2 className="text-[17px] font-medium text-rw-text-primary">About</h2>
            </header>

            <dl className="grid grid-cols-3 gap-y-2 text-sm">
              <dt className="text-gray-500">Version</dt>
              <dd className="col-span-2 text-gray-900">
                Neato Rewind v{settings.about.version}
              </dd>

              <dt className="text-gray-500">Transcription</dt>
              <dd className="col-span-2 text-gray-900">
                {settings.about.transcription_provider}
              </dd>

              <dt className="text-gray-500">Summary</dt>
              <dd className="col-span-2 text-gray-900">
                {settings.about.summary_provider}
              </dd>

              <dt className="text-gray-500">Support</dt>
              <dd className="col-span-2 text-gray-900">
                <a
                  href="mailto:support@neatoventures.com"
                  className="text-blue-600 hover:underline"
                >
                  support@neatoventures.com
                </a>
              </dd>

              <dt className="text-gray-500">Privacy</dt>
              <dd className="col-span-2 text-gray-900">
                Audio and transcripts are sent to Google Gemini for
                transcription and summarization. Nothing is stored
                outside your machine.
              </dd>

              <dt className="text-gray-500">Account</dt>
              <dd className="col-span-2">
                <button
                  type="button"
                  disabled
                  className="text-sm text-gray-400 cursor-not-allowed"
                  title="Coming soon"
                >
                  Sign out (coming soon)
                </button>
              </dd>
            </dl>
          </section>
        </div>
      )}
    </div>
  );
}
