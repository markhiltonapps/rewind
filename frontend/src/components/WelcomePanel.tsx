'use client';

// Phase 5 Task 2: in-pane welcome panel shown on first launch only.
// Renders as an overlay on the Home (+ New Call) route when the
// SidebarProvider's hasSeenWelcomePanel flag is false. Three dismiss
// paths:
//   1. "Start your first recording" CTA  - dismiss + reveal recording
//      controls behind the panel
//   2. Click sample meeting in sidebar   - sidebar handler dismisses
//      automatically on first meeting click
//   3. "Skip welcome" link               - dismiss only
//
// Distinct from the older Onboarding consent modal (Phase 2a) which
// gates auto-record permissions. Both can coexist; the consent modal
// shows before this panel on a fresh install.

import { useSidebar } from '@/components/Sidebar/SidebarProvider';

const SAMPLE_MEETING_ID = 'meeting-sample-onboarding';

interface Props {
  onDismiss: () => void;
}

export function WelcomePanel({ onDismiss }: Props) {
  const { meetings } = useSidebar();
  // Hide the "Or open the Sample..." line if the seed never inserted
  // (existing user, or the user already deleted the sample meeting).
  const sampleExists = meetings.some((m) => m.id === SAMPLE_MEETING_ID);

  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center px-8 bg-rw-bg-recede">
      <div className="max-w-md text-center">
        <h1 className="text-[28px] leading-tight text-rw-text-primary mb-3">
          Welcome to{' '}
          <span className="font-mono tracking-tight">NEATO_REWIND</span>
        </h1>
        <p className="text-[14px] leading-relaxed text-rw-text-secondary mb-6">
          Bot-free meeting recording with AI summaries. Your audio stays on
          your machine; only the transcript goes to Gemini.
        </p>

        <div className="bg-rw-card border border-rw-border rounded-rw-md p-4 mb-6 text-left">
          <p className="text-[11px] font-mono tracking-[0.5px] uppercase text-rw-text-tertiary mb-2">
            TRY IT
          </p>
          <ol className="text-[14px] text-rw-text-secondary space-y-2 list-decimal list-inside leading-relaxed">
            <li>
              Click <strong>+ New Call</strong> in the sidebar to record a
              meeting
            </li>
            {sampleExists && (
              <li>
                Or open the{' '}
                <strong>Sample: Q4 Product Roadmap Review</strong> below to
                see what Neato Rewind produces
              </li>
            )}
          </ol>
        </div>

        <button
          type="button"
          onClick={onDismiss}
          className="text-[11px] font-mono tracking-[0.5px] uppercase text-rw-text-tertiary hover:text-rw-text-secondary"
        >
          Skip welcome
        </button>
      </div>
    </div>
  );
}
