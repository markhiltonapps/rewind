'use client';

import { useEffect, useRef } from 'react';

interface EditableTitleProps {
  title: string;
  isEditing: boolean;
  onStartEditing: () => void;
  onFinishEditing: () => void;
  onChange: (value: string) => void;
  onDelete?: () => void;
  /** Phase 3 Task 6: optional max length for the input (default 200). */
  maxLength?: number;
  /** Phase 3 Task 6: shown when the input is empty during edit. */
  placeholder?: string;
}

export const EditableTitle: React.FC<EditableTitleProps> = ({
  title,
  isEditing,
  onStartEditing,
  onFinishEditing,
  onChange,
  onDelete,
  maxLength = 200,
  placeholder = 'Untitled meeting',
}) => {
  const titleInputRef = useRef<HTMLInputElement>(null);
  // Phase 3 Task 6: snapshot the title at the moment editing starts so
  // we can revert on Escape or empty-Enter without forcing the caller
  // to track previous state. Refreshed every time isEditing flips
  // false → true.
  const snapshotRef = useRef<string>(title);
  // Track whether we've already finished editing, to avoid the
  // onBlur handler firing AFTER an Enter/Escape commit (browsers fire
  // blur synchronously when the input is unmounted on the next render
  // cycle — without this guard we double-commit).
  const finishedRef = useRef<boolean>(false);

  useEffect(() => {
    if (isEditing) {
      snapshotRef.current = title;
      finishedRef.current = false;
    }
    // We deliberately don't depend on `title` here — the snapshot is
    // captured at edit-start, not on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEditing]);

  const finish = (commit: boolean) => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    if (commit) {
      const trimmed = title.trim();
      if (!trimmed) {
        // Empty after trim → revert silently.
        onChange(snapshotRef.current);
      } else if (trimmed !== title) {
        // Apply trim — store canonical form.
        onChange(trimmed);
      }
    } else {
      // Cancel: revert to snapshot. onChange before onFinishEditing
      // so the caller's effect / save handler reads the reverted value.
      onChange(snapshotRef.current);
    }
    onFinishEditing();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      finish(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      finish(false);
    }
  };

  return isEditing ? (
    <input
      ref={titleInputRef}
      type="text"
      value={title}
      onChange={(e) => onChange(e.target.value)}
      onBlur={() => finish(true)}
      onKeyDown={handleKeyDown}
      placeholder={placeholder}
      maxLength={maxLength}
      className="text-2xl font-bold bg-transparent border-none focus:outline-none focus:ring-2 focus:ring-blue-500 rounded px-1"
      autoFocus
    />
  ) : (
    <div className="group flex items-center space-x-2">
      <h1
        className="text-2xl font-bold cursor-pointer hover:bg-gray-50 rounded px-1"
        onClick={onStartEditing}
      >
        {title}
      </h1>
      <div className="flex space-x-1">
        <button
          onClick={onStartEditing}
          className="opacity-0 group-hover:opacity-100 transition-opacity duration-200 p-1 hover:bg-gray-100 rounded"
          title="Edit section title"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
          </svg>
        </button>
        {onDelete && (
          <button
            onClick={onDelete}
            className="opacity-0 group-hover:opacity-100 transition-opacity duration-200 p-1 hover:bg-gray-100 rounded text-red-600"
            title="Delete section"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M3 6h18" />
              <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
              <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
};
