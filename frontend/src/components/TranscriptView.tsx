'use client';

import { Transcript } from '@/types';
import { useEffect, useMemo, useRef, useState, useCallback } from 'react';

interface TranscriptViewProps {
  transcripts: Transcript[];
  speakerMap?: Record<string, string>;
  onSpeakerRename?: (original: string, newName: string | null) => void;
}

// Phase 4 Task 2: Premium Minimalism transcript rendering.
//
// Behavior unchanged — same Transcript[] data shape from the parent,
// same scroll-to-bottom on update. New visual layer:
//   * Per-segment card chrome from the parent's outer card; this
//     component only paints the inner content.
//   * Gemini transcripts (Phase 4 Task 1C) come back as a single
//     segment containing speaker-labeled paragraphs ("Speaker 1: ...
//     \nSpeaker 2: ..."). We parse those into separate visual turns
//     with deterministic-color avatar circles, which is a render-
//     only transform — the underlying Transcript stays a single row.
//   * Whisper-style multi-segment transcripts (older recordings) keep
//     their per-card layout. No avatars there because the speaker
//     identity is unknown.

interface SpeakerTurn {
  speaker: string;     // raw label from the transcript ("Speaker 1", "A", ...)
  initial: string;     // 1-2 char chip label
  text: string;
  index: number;       // deterministic index for color cycling
  // Phase 6 Task 3: per-turn timestamp if Gemini emitted one in
  // "[MM:SS]" or "[HH:MM:SS]" form. Older recordings without
  // timestamps in their text leave this undefined; the renderer
  // falls back to the segment-level timestamp pill.
  timestamp?: string;
}

// Phase 4 Task 2.5: palette discipline. Task 2 cycled six colors per
// speaker, which competed for attention. New treatment: most speakers
// get one of three grayscale shades; the most-active speaker (highest
// turn count) gets Neato teal so the meeting's main voice naturally
// pops. The accent color is decided per-render based on turn counts,
// not per-speaker hash, so a long meeting where Speaker 1 talks once
// and Speaker 2 talks 30 times correctly highlights Speaker 2.
const AVATAR_GRAY_RAMP: Array<[string, string]> = [
  ['#E5E2D9', '#5C5A55'], // light warm grey
  ['#D1CDC0', '#3A3833'], // medium warm grey
  ['#94928C', '#FFFFFF'], // dark warm grey, white text
];
const AVATAR_ACCENT: [string, string] = ['#DFF1EE', '#1A6F66']; // teal-bg / teal-text

function pickGrayscale(label: string): [string, string] {
  // Stable hash → ramp index, deterministic so the same speaker keeps
  // the same shade across re-renders.
  let hash = 0;
  for (let i = 0; i < label.length; i++) {
    hash = (hash * 31 + label.charCodeAt(i)) & 0xffff;
  }
  return AVATAR_GRAY_RAMP[hash % AVATAR_GRAY_RAMP.length];
}

// Parse a single transcript text blob into speaker turns. If no
// "Speaker X:" markers are present, returns null and the caller
// falls back to plain prose.
//
// Phase 6 Task 3: also captures an optional "[MM:SS]" or "[HH:MM:SS]"
// timestamp prefix that the Gemini prompt now requests at the start
// of each speaker turn. Older transcripts (recorded before the
// prompt change) won't have these prefixes — the regex makes the
// timestamp group optional so both formats parse cleanly.
function parseSpeakerTurns(text: string): SpeakerTurn[] | null {
  // (^|\n)              line start
  // \s*                 optional leading space
  // (?:\[(\d…)\]\s+)?   optional "[MM:SS] " or "[HH:MM:SS] " prefix
  // (Speaker …)         speaker label, up to 40 chars before the colon
  // :                   colon delimiter
  const re =
    /(^|\n)\s*(?:\[(\d{1,2}:\d{2}(?::\d{2})?)\]\s+)?(Speaker\s+[^\n:]{1,40}):/g;
  const matches: Array<{
    idx: number;
    speaker: string;
    timestamp?: string;
    valueStart: number;
  }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    matches.push({
      idx: m.index + (m[1] ? m[1].length : 0),
      timestamp: m[2] || undefined,
      speaker: m[3].trim(),
      valueStart: m.index + m[0].length,
    });
  }
  if (matches.length === 0) return null;

  const turns: SpeakerTurn[] = matches.map((match, i) => {
    const end = i + 1 < matches.length ? matches[i + 1].idx : text.length;
    const body = text.slice(match.valueStart, end).trim();
    const rawInitial = match.speaker
      .replace(/^Speaker\s+/i, '')
      .trim()
      .slice(0, 2)
      .toUpperCase() || '?';
    const initial = rawInitial; // resolved to mapped name initials at render time
    return {
      speaker: match.speaker,
      initial,
      text: body,
      index: i,
      timestamp: match.timestamp,
    };
  });

  // If the parser produced turns but they all have empty bodies, treat
  // it as un-parseable (defensive — shouldn't happen with Gemini's
  // current format).
  if (turns.every((t) => !t.text)) return null;

  return turns;
}

export const TranscriptView: React.FC<TranscriptViewProps> = ({
  transcripts,
  speakerMap = {},
  onSpeakerRename,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  // Inline-edit state: which raw speaker label is being edited right now.
  const [editingLabel, setEditingLabel] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const editInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [transcripts]);

  useEffect(() => {
    if (editingLabel && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingLabel]);

  const startEdit = useCallback((rawLabel: string) => {
    if (!onSpeakerRename) return;
    setEditValue(speakerMap[rawLabel] ?? rawLabel);
    setEditingLabel(rawLabel);
  }, [onSpeakerRename, speakerMap]);

  const commitEdit = useCallback((rawLabel: string) => {
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== rawLabel) {
      onSpeakerRename?.(rawLabel, trimmed);
    } else if (!trimmed) {
      onSpeakerRename?.(rawLabel, null); // clear mapping
    }
    setEditingLabel(null);
  }, [editValue, onSpeakerRename]);

  // Pre-parse turns per segment so we don't redo regex work on every
  // scroll-driven re-render of the parent. Phase 4 Task 2.5: also
  // count turns per speaker so we can highlight the most-active voice
  // in teal across the entire transcript (not per-segment).
  const parsedSegments = useMemo(
    () =>
      (transcripts ?? []).map((t) => ({
        transcript: t,
        turns: parseSpeakerTurns(t.text),
      })),
    [transcripts],
  );

  const mostActiveSpeaker = useMemo(() => {
    const counts = new Map<string, number>();
    for (const seg of parsedSegments) {
      if (!seg.turns) continue;
      for (const turn of seg.turns) {
        counts.set(turn.speaker, (counts.get(turn.speaker) ?? 0) + 1);
      }
    }
    let best: string | null = null;
    let bestN = 0;
    for (const [speaker, n] of counts) {
      if (n > bestN) {
        best = speaker;
        bestN = n;
      }
    }
    return best;
  }, [parsedSegments]);

  return (
    <div ref={containerRef} className="h-full overflow-y-auto px-5 py-4">
      {/* Phase 5 Task 2: empty-state hint. Shown when no transcript
          segments are present yet — covers both "+New Call before
          recording" and "after deleting all meetings". Subtle so it
          doesn't compete with the recording controls. */}
      {parsedSegments.length === 0 && (
        <div className="flex flex-col items-center justify-center h-full text-center px-8">
          <p className="text-[14px] text-rw-text-tertiary mb-2">
            No transcript yet
          </p>
          <p className="text-[12px] text-rw-text-tertiary">
            Start recording to capture this meeting, or pick one from the
            sidebar.
          </p>
        </div>
      )}
      {parsedSegments.map(({ transcript, turns }) => {
        // Speaker-labeled segment: render each turn as a flex row with
        // an avatar on the left.
        if (turns) {
          return (
            <div key={transcript.id} className="space-y-4">
              {turns.map((turn) => {
                const [bg, fg] =
                  turn.speaker === mostActiveSpeaker
                    ? AVATAR_ACCENT
                    : pickGrayscale(turn.speaker);
                return (
                  <div
                    key={`${transcript.id}-${turn.index}`}
                    className="flex gap-3"
                  >
                    <div
                      className="flex-shrink-0 w-8 h-8 rounded-full inline-flex items-center justify-center text-[11px] font-medium"
                      style={{ background: bg, color: fg }}
                      aria-hidden
                    >
                      {speakerMap[turn.speaker]
                        ? speakerMap[turn.speaker].split(' ').map((w: string) => w[0]).join('').slice(0, 2).toUpperCase()
                        : turn.initial}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2 mb-0.5">
                        {editingLabel === turn.speaker ? (
                          <input
                            ref={editInputRef}
                            value={editValue}
                            onChange={(e) => setEditValue(e.target.value)}
                            onBlur={() => commitEdit(turn.speaker)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') commitEdit(turn.speaker);
                              if (e.key === 'Escape') setEditingLabel(null);
                            }}
                            className="text-[13px] font-medium text-rw-text-primary border-b border-rw-primary bg-transparent outline-none w-40"
                          />
                        ) : (
                          <span
                            className={`text-[13px] font-medium text-rw-text-primary ${onSpeakerRename ? 'cursor-pointer hover:underline decoration-dotted underline-offset-2' : ''}`}
                            title={onSpeakerRename ? 'Click to rename speaker' : undefined}
                            onClick={() => startEdit(turn.speaker)}
                          >
                            {speakerMap[turn.speaker] ?? turn.speaker}
                          </span>
                        )}
                        <span className="font-mono text-[11px] text-rw-text-tertiary">
                          {turn.timestamp ?? transcript.timestamp}
                        </span>
                      </div>
                      <p className="text-[14px] leading-[1.6] text-rw-text-primary whitespace-pre-wrap">
                        {turn.text}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          );
        }

        // Un-labeled segment (Whisper-style or short Gemini output):
        // render plain prose with the original timestamp pill.
        return (
          <div
            key={transcript.id}
            className="mb-4 rounded-rw-md bg-rw-subtle px-3 py-2.5 border border-rw-border"
          >
            <span className="font-mono text-[11px] text-rw-text-tertiary block mb-1">
              {transcript.timestamp}
            </span>
            <p className="text-[14px] leading-[1.6] text-rw-text-primary whitespace-pre-wrap">
              {transcript.text}
            </p>
          </div>
        );
      })}
      {parsedSegments.length > 0 && (
        <div className="mt-6 mb-2 text-center font-mono text-[11px] uppercase tracking-[0.8px] font-medium text-rw-text-tertiary">
          End of transcript
        </div>
      )}
    </div>
  );
};
