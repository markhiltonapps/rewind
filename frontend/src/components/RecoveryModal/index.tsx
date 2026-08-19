'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { X, RotateCw, CheckCircle, AlertCircle } from 'lucide-react';

interface RecoveryFile {
  path: string;
  filename: string;
  size_bytes: number;
  modified_secs: number;
}

type FileStatus = 'idle' | 'recovering' | 'done' | 'error';

interface FileState {
  status: FileStatus;
  error?: string;
}

function formatDate(secs: number): string {
  return new Date(secs * 1000).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface Props {
  onClose: () => void;
  onRecovered: () => void;
}

export function RecoveryModal({ onClose, onRecovered }: Props) {
  const [files, setFiles] = useState<RecoveryFile[]>([]);
  const [statuses, setStatuses] = useState<Record<string, FileState>>({});
  const [loading, setLoading] = useState(true);
  const [recoveringAll, setRecoveringAll] = useState(false);

  useEffect(() => {
    invoke<RecoveryFile[]>('list_recovery_files')
      .then((f) => {
        setFiles([...f].reverse());
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const setFileStatus = (path: string, s: FileState) =>
    setStatuses((prev) => ({ ...prev, [path]: s }));

  const recoverOne = useCallback(
    async (file: RecoveryFile) => {
      setFileStatus(file.path, { status: 'recovering' });
      try {
        await invoke('retry_transcription', { recoveryPath: file.path });
        setFileStatus(file.path, { status: 'done' });
        onRecovered();
      } catch (e) {
        setFileStatus(file.path, { status: 'error', error: String(e) });
      }
    },
    [onRecovered],
  );

  const recoverAll = useCallback(async () => {
    setRecoveringAll(true);
    const pending = files.filter((f) => {
      const s = statuses[f.path]?.status;
      return !s || s === 'idle' || s === 'error';
    });
    for (const file of pending) {
      await recoverOne(file);
    }
    setRecoveringAll(false);
  }, [files, statuses, recoverOne]);

  const pendingCount = files.filter((f) => {
    const s = statuses[f.path]?.status;
    return !s || s === 'idle' || s === 'error';
  }).length;

  const doneCount = files.filter(
    (f) => statuses[f.path]?.status === 'done',
  ).length;

  return (
    <div
      className="fixed inset-0 bg-black/50 z-[1000] flex items-center justify-center"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-rw-card border border-rw-border rounded-rw-lg w-[520px] max-w-[90vw] max-h-[80vh] flex flex-col overflow-hidden shadow-rw-modal">

        {/* Header */}
        <div className="flex items-start justify-between px-4 pt-4 pb-3 border-b border-rw-border">
          <div>
            <div className="text-[15px] font-semibold text-rw-text-primary mb-0.5">
              Pending Recoveries
            </div>
            <div className="text-[12px] text-rw-text-tertiary">
              {files.length} recording{files.length !== 1 ? 's' : ''} saved locally that failed to transcribe
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-rw-text-tertiary hover:text-rw-text-primary p-1 rounded transition-colors"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        {/* Recover All bar */}
        {files.length > 0 && (
          <div className="px-4 py-2.5 border-b border-rw-border flex items-center gap-3">
            <button
              onClick={recoverAll}
              disabled={recoveringAll || pendingCount === 0}
              className={`px-3.5 py-1.5 text-[13px] font-medium rounded-rw-sm transition-colors ${
                recoveringAll || pendingCount === 0
                  ? 'bg-rw-subtle text-rw-text-tertiary cursor-not-allowed'
                  : 'bg-rw-primary text-rw-text-on-primary hover:bg-rw-primary-hover cursor-pointer'
              }`}
            >
              {recoveringAll
                ? 'Recovering…'
                : `Recover All (${pendingCount} remaining)`}
            </button>
            {doneCount > 0 && (
              <span className="text-[12px] text-rw-success-text font-medium">
                {doneCount} recovered ✓
              </span>
            )}
            <span className="text-[11px] text-rw-text-tertiary ml-auto">
              Large files may take several minutes each
            </span>
          </div>
        )}

        {/* File list */}
        <div className="overflow-y-auto flex-1">
          {loading ? (
            <div className="p-6 text-center text-rw-text-tertiary text-[13px]">
              Loading…
            </div>
          ) : files.length === 0 ? (
            <div className="p-6 text-center text-rw-text-tertiary text-[13px]">
              No pending recoveries.
            </div>
          ) : (
            files.map((file) => {
              const s = statuses[file.path];
              const st = s?.status ?? 'idle';
              return (
                <div
                  key={file.path}
                  className={`flex items-center gap-3 px-4 py-2.5 border-b border-rw-border ${
                    st === 'done'
                      ? 'bg-rw-success-bg'
                      : st === 'error'
                        ? 'bg-rw-danger-bg'
                        : ''
                  }`}
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-[13px] font-medium text-rw-text-primary mb-0.5">
                      {formatDate(file.modified_secs)}
                    </div>
                    <div className="text-[11px] text-rw-text-tertiary">
                      {formatSize(file.size_bytes)}
                      {file.size_bytes > 500 * 1024 * 1024 && (
                        <span className="text-rw-warning-text"> · large file</span>
                      )}
                    </div>
                    {st === 'error' && s?.error && (
                      <div className="text-[11px] text-rw-danger-text mt-0.5 break-words">
                        {s.error}
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5">
                    {st === 'done' && (
                      <CheckCircle size={16} className="text-rw-success-text" />
                    )}
                    {st === 'recovering' && (
                      <RotateCw size={16} className="text-rw-text-tertiary animate-spin" />
                    )}
                    {(st === 'idle' || st === 'error') && (
                      <button
                        onClick={() => recoverOne(file)}
                        className="border border-rw-border rounded-rw-sm px-2.5 py-1 text-[12px] text-rw-text-primary hover:bg-rw-hover transition-colors"
                      >
                        {st === 'error' ? 'Retry' : 'Recover'}
                      </button>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
