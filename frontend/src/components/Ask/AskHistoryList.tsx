'use client';

import { Pin, PinOff, Trash2, History } from 'lucide-react';
import type { AskHistoryEntry } from './types';
import { formatRelative } from './types';

interface Props {
  entries: AskHistoryEntry[];
  loading: boolean;
  activeId?: number | null;
  onSelect: (entry: AskHistoryEntry) => void;
  onTogglePin: (entry: AskHistoryEntry) => void;
  onDelete: (entry: AskHistoryEntry) => void;
  /** Compact variant for the per-recording panel. */
  compact?: boolean;
  emptyHint?: string;
}

export function AskHistoryList({
  entries,
  loading,
  activeId,
  onSelect,
  onTogglePin,
  onDelete,
  compact,
  emptyHint,
}: Props) {
  if (loading) {
    return (
      <div className="text-[12px] text-rw-text-tertiary px-1 py-2">Loading…</div>
    );
  }

  if (entries.length === 0) {
    return (
      <div className="text-[12px] text-rw-text-tertiary px-1 py-2 leading-relaxed">
        {emptyHint ?? 'Your past questions will appear here.'}
      </div>
    );
  }

  const pinned = entries.filter((e) => e.pinned);
  const rest = entries.filter((e) => !e.pinned);

  const renderRow = (entry: AskHistoryEntry) => {
    const isActive = activeId === entry.id;
    return (
      <div
        key={entry.id}
        className={`group relative rounded-rw-md border transition-colors ${
          isActive
            ? 'border-rw-primary bg-rw-primary-bg'
            : 'border-rw-border bg-rw-card hover:bg-rw-hover'
        }`}
      >
        <button
          type="button"
          onClick={() => onSelect(entry)}
          className="w-full text-left px-2.5 py-2"
          title={entry.question}
        >
          {/* Right padding leaves room for the action buttons that
              fade in on hover, so long questions never slide under them. */}
          <div
            className={`text-[12.5px] text-rw-text-primary pr-12 ${
              compact ? 'line-clamp-1' : 'line-clamp-2'
            }`}
          >
            {entry.question}
          </div>
          <div className="flex items-center gap-1.5 mt-1 text-[10.5px] text-rw-text-tertiary">
            <span>{formatRelative(entry.created_at)}</span>
            {entry.scope_label && (
              <>
                <span>·</span>
                <span className="truncate">{entry.scope_label}</span>
              </>
            )}
          </div>
        </button>

        <div className="absolute top-1.5 right-1.5 flex items-center gap-0.5">
          <button
            type="button"
            onClick={() => onTogglePin(entry)}
            title={entry.pinned ? 'Unpin' : 'Pin to top'}
            aria-label={entry.pinned ? 'Unpin question' : 'Pin question to top'}
            className={`p-1 rounded hover:bg-rw-hover transition-opacity ${
              entry.pinned
                ? 'text-rw-primary opacity-100'
                : 'text-rw-text-tertiary opacity-0 group-hover:opacity-100 focus:opacity-100'
            }`}
          >
            {entry.pinned ? (
              <Pin className="w-3.5 h-3.5 fill-current" />
            ) : (
              <Pin className="w-3.5 h-3.5" />
            )}
          </button>
          <button
            type="button"
            onClick={() => onDelete(entry)}
            title="Delete"
            aria-label="Delete question"
            className="p-1 rounded text-rw-text-tertiary hover:text-rw-danger-text hover:bg-rw-danger-bg opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-3">
      {pinned.length > 0 && (
        <div className="space-y-1.5">
          <div className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-rw-text-tertiary px-1">
            <Pin className="w-3 h-3" /> Pinned
          </div>
          {pinned.map(renderRow)}
        </div>
      )}
      {rest.length > 0 && (
        <div className="space-y-1.5">
          {pinned.length > 0 && (
            <div className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-rw-text-tertiary px-1">
              <History className="w-3 h-3" /> Recent
            </div>
          )}
          {rest.map(renderRow)}
        </div>
      )}
    </div>
  );
}
