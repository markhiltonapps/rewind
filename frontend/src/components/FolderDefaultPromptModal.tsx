'use client';

// Phase 3 Task 9: small modal opened from the sidebar context menu's
// "Default prompt..." item and from the Settings folder-defaults
// table. Single dropdown grouped by category, plus Save / Cancel.
// Saving fires PATCH /folders/{id} with default_prompt_id (the
// SidebarProvider's setFolderDefaultPrompt does the request and keeps
// local state in sync).

import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import {
  useSidebar,
  type Folder,
  type SavedPromptOption,
} from '@/components/Sidebar/SidebarProvider';

interface Props {
  folder: Folder;
  open: boolean;
  onClose: () => void;
}

function groupByCategory(prompts: SavedPromptOption[]) {
  const groups = new Map<string, SavedPromptOption[]>();
  for (const p of prompts) {
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
}

export function FolderDefaultPromptModal({ folder, open, onClose }: Props) {
  const { savedPrompts, setFolderDefaultPrompt } = useSidebar();
  // Local edit state — null = "None". Initialised from the folder's
  // current value each time the modal opens so reopening after a
  // previous save reflects the saved value.
  const [draft, setDraft] = useState<number | null>(folder.default_prompt_id ?? null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setDraft(folder.default_prompt_id ?? null);
      setError(null);
    }
  }, [open, folder.default_prompt_id]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, onClose]);

  const groups = groupByCategory(savedPrompts);

  if (!open) return null;

  async function handleSave() {
    setSaving(true);
    setError(null);
    const ok = await setFolderDefaultPrompt(folder.id, draft);
    setSaving(false);
    if (!ok) {
      setError('Could not save. Try again.');
      return;
    }
    onClose();
  }

  return (
    <>
      <div
        className="fixed inset-0 z-[60]"
        style={{ backgroundColor: 'rgba(0, 0, 0, 0.4)' }}
        onClick={onClose}
      />
      <div
        className="fixed left-1/2 top-1/2 z-[61] w-[440px] -translate-x-1/2 -translate-y-1/2 rounded-rw-lg border border-rw-border bg-rw-card shadow-xl"
        // Hotfix: previous build read var(--rw-color-bg-card) which
        // doesn't exist (actual variable is --rw-bg-card). With the
        // typo'd name resolving to nothing the modal card was
        // transparent and the page bled through. Match the
        // CustomSummaryPromptModal pattern.
        style={{ backgroundColor: 'var(--rw-bg-card)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-rw-border">
          <div>
            <div className="text-[15px] font-medium text-rw-text-primary">
              Default summary prompt
            </div>
            <div className="text-[12px] text-rw-text-tertiary mt-0.5">
              Folder: {folder.name}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-rw-text-tertiary hover:text-rw-text-primary"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-3">
          <p className="text-[12px] text-rw-text-secondary">
            Applied automatically when a meeting in this folder gets its
            first summary. The user can still override per-meeting via the
            gear icon.
          </p>
          <div>
            <select
              value={draft === null ? '' : String(draft)}
              onChange={(e) => {
                const v = e.target.value;
                setDraft(v === '' ? null : Number(v));
              }}
              className="w-full px-3 py-2 text-[13px] border border-rw-border rounded-rw-md bg-rw-card text-rw-text-primary focus:outline-none focus:ring-2 focus:ring-rw-primary-bg focus:border-rw-primary"
            >
              <option value="">None</option>
              {groups.map((g) => (
                <optgroup key={g.category} label={g.category}>
                  {g.items.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
            {savedPrompts.length === 0 && (
              <p className="text-[12px] text-rw-text-tertiary mt-2">
                No saved prompts yet. Save one from a meeting&rsquo;s gear icon
                to assign it here.
              </p>
            )}
          </div>

          {error && (
            <div className="px-3 py-2 rounded-rw-md text-[12px] bg-rw-danger-bg text-rw-danger-text">
              {error}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 px-5 py-3 border-t border-rw-border">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="px-3 py-1.5 text-[13px] text-rw-text-secondary hover:text-rw-text-primary"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="px-3 py-1.5 text-[13px] font-medium rounded-rw-md bg-rw-primary text-white hover:opacity-90 disabled:opacity-60"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </>
  );
}
