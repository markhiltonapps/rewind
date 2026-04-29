'use client';

import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Mic, Monitor, Lock } from 'lucide-react';

interface OnboardingProps {
  onComplete: () => void;
}

const BACKEND = 'http://localhost:5167';

export function Onboarding({ onComplete }: OnboardingProps) {
  const [autoRecord, setAutoRecord] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  async function persist(autoRecordEnabled: boolean) {
    setSubmitting(true);
    try {
      await fetch(`${BACKEND}/settings/recording`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          auto_record_enabled: autoRecordEnabled,
          has_seen_onboarding: true,
        }),
      });
      try {
        await invoke('set_auto_record', { enabled: autoRecordEnabled });
      } catch {
        // The Rust orchestrator picks up the value on next startup as a fallback.
      }
      onComplete();
    } catch (err) {
      console.error('Failed to save onboarding settings', err);
      setSubmitting(false);
    }
  }

  async function handleGetStarted() {
    await persist(autoRecord);
  }

  async function handleConfigureLater() {
    // Don't change auto_record_enabled — keep whatever default the backend has.
    setSubmitting(true);
    try {
      await fetch(`${BACKEND}/settings/recording`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ has_seen_onboarding: true }),
      });
      onComplete();
    } catch (err) {
      console.error('Failed to dismiss onboarding', err);
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="w-full max-w-lg rounded-2xl bg-white p-8 shadow-2xl">
        <h1 className="text-2xl font-semibold text-gray-900">Welcome to Neato Rewind</h1>
        <p className="mt-3 text-sm leading-relaxed text-gray-700">
          Neato Rewind automatically captures and transcribes your meetings and calls.
          When you join a Zoom, Teams, WebEx, Skype, or GoToMeeting call, recording starts
          automatically.
        </p>

        <div className="mt-6 space-y-3">
          <h2 className="text-sm font-medium uppercase tracking-wider text-gray-500">
            What's captured
          </h2>
          <ul className="space-y-2 text-sm text-gray-700">
            <li className="flex items-start gap-3">
              <Mic className="mt-0.5 h-4 w-4 flex-none text-gray-500" />
              <span>Your microphone audio.</span>
            </li>
            <li className="flex items-start gap-3">
              <Monitor className="mt-0.5 h-4 w-4 flex-none text-gray-500" />
              <span>System audio (other participants).</span>
            </li>
            <li className="flex items-start gap-3">
              <Lock className="mt-0.5 h-4 w-4 flex-none text-gray-500" />
              <span>Nothing is uploaded — recordings stay on your device by default.</span>
            </li>
          </ul>
        </div>

        <label className="mt-6 flex cursor-pointer items-start justify-between rounded-lg border border-gray-200 bg-gray-50 p-4">
          <div className="pr-4">
            <div className="text-sm font-medium text-gray-900">Auto-record meetings</div>
            <div className="mt-1 text-xs text-gray-600">
              Detect Teams, Zoom, WebEx, Skype, and GoToMeeting calls and start recording
              automatically. You can change this anytime in Settings.
            </div>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={autoRecord}
            onClick={() => setAutoRecord((v) => !v)}
            className={`relative mt-1 inline-flex h-6 w-11 flex-none items-center rounded-full transition-colors ${
              autoRecord ? 'bg-[#FF6B35]' : 'bg-gray-300'
            }`}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                autoRecord ? 'translate-x-6' : 'translate-x-1'
              }`}
            />
          </button>
        </label>

        <div className="mt-8 flex gap-3">
          <button
            type="button"
            onClick={handleGetStarted}
            disabled={submitting}
            className="flex-1 rounded-lg bg-[#FF6B35] px-4 py-2.5 text-sm font-medium text-white shadow-sm transition hover:bg-[#e85a25] disabled:opacity-60"
          >
            Get started
          </button>
          <button
            type="button"
            onClick={handleConfigureLater}
            disabled={submitting}
            className="rounded-lg border border-gray-200 bg-white px-4 py-2.5 text-sm font-medium text-gray-700 transition hover:bg-gray-50 disabled:opacity-60"
          >
            I'll configure later
          </button>
        </div>
      </div>
    </div>
  );
}
