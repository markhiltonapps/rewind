'use client';

import { Transcript } from '@/types';
import { useEffect, useRef } from 'react';

interface TranscriptViewProps {
  transcripts: Transcript[];
}

export const TranscriptView: React.FC<TranscriptViewProps> = ({ transcripts }) => {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [transcripts]);

  return (
    <div ref={containerRef} className="h-full overflow-y-auto px-4 py-2">
      {transcripts?.map((transcript) => (
        <div key={transcript.id + Math.random().toString(36).substring(2, 9)} className="mb-3 p-2 bg-gray-50 rounded-lg">
          <span className="text-xs text-gray-500 block mb-1">{transcript.timestamp}</span>
          {/* Phase 4 Task 1C: Gemini's end-of-recording transcript is a
              single segment of speaker-labelled prose ("Speaker 1:
              ...\nSpeaker 2: ..."). whitespace-pre-wrap preserves the
              line breaks between speaker turns. The legacy Whisper
              segments still render fine since each is its own card. */}
          <p className="text-sm text-gray-800 whitespace-pre-wrap">{transcript.text}</p>
        </div>
      ))}
    </div>
  );
};
