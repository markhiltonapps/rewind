'use client';

import React, { useEffect, useState } from 'react';
import { Bell, User, Lock, Database, Palette, ArrowLeft, Mic } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { invoke } from '@tauri-apps/api/core';

const BACKEND = 'http://localhost:5167';

const SUPPORTED_APPS = [
  'Microsoft Teams',
  'Zoom',
  'Cisco WebEx',
  'Skype',
  'GoToMeeting',
];

function RecordingSection() {
  const [autoRecord, setAutoRecord] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const resp = await fetch(`${BACKEND}/settings/recording`);
        if (!resp.ok) throw new Error(`status ${resp.status}`);
        const data = await resp.json();
        if (!cancelled) setAutoRecord(Boolean(data.auto_record_enabled));
      } catch (err) {
        if (!cancelled) {
          setAutoRecord(true);
          setError('Could not load settings — showing default.');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function toggleAutoRecord(next: boolean) {
    const prev = autoRecord;
    setAutoRecord(next);
    setSaving(true);
    setError(null);
    try {
      const resp = await fetch(`${BACKEND}/settings/recording`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ auto_record_enabled: next }),
      });
      if (!resp.ok) throw new Error(`status ${resp.status}`);
      try {
        await invoke('set_auto_record', { enabled: next });
      } catch (err) {
        console.warn('set_auto_record command failed; backend updated though', err);
      }
    } catch (err) {
      console.error('Failed to update auto_record_enabled', err);
      setAutoRecord(prev);
      setError('Could not save. Try again.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="border rounded-lg p-6">
      <div className="flex items-center gap-2 mb-4">
        <Mic className="w-5 h-5" />
        <h2 className="text-xl font-semibold">Recording</h2>
      </div>

      <label className="flex items-start justify-between p-3 rounded-md cursor-pointer hover:bg-gray-50">
        <div className="pr-4">
          <div className="font-medium text-gray-900">Auto-record meetings and videos</div>
          <div className="mt-1 text-sm text-gray-600">
            Automatically detect and record when you join Teams, Zoom, WebEx, Skype, or
            GoToMeeting calls.
          </div>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={autoRecord ?? false}
          disabled={autoRecord === null || saving}
          onClick={() => autoRecord !== null && toggleAutoRecord(!autoRecord)}
          className={`relative mt-1 inline-flex h-6 w-11 flex-none items-center rounded-full transition-colors ${
            autoRecord ? 'bg-[#FF6B35]' : 'bg-gray-300'
          } ${autoRecord === null || saving ? 'opacity-60' : ''}`}
        >
          <span
            className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
              autoRecord ? 'translate-x-6' : 'translate-x-1'
            }`}
          />
        </button>
      </label>

      {error && (
        <div className="mt-2 text-sm text-red-600">{error}</div>
      )}

      <div className="mt-6">
        <h3 className="text-sm font-medium uppercase tracking-wider text-gray-500 mb-3">
          Detected apps in this version
        </h3>
        <ul className="space-y-1.5 text-sm text-gray-700">
          {SUPPORTED_APPS.map((app) => (
            <li key={app} className="flex items-center gap-2">
              <span className="h-1.5 w-1.5 rounded-full bg-[#FF6B35]" />
              <span>{app}</span>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-xs italic text-gray-500">
          Browser-based meetings (Google Meet, Teams web, Zoom web) and YouTube/video
          detection coming in Phase 2b.
        </p>
      </div>
    </div>
  );
}

export default function SettingsPage() {
  const router = useRouter();

  const settingsSections = [
    {
      title: 'Account',
      icon: <User className="w-5 h-5" />,
      items: ['Profile', 'Email', 'Password']
    },
    {
      title: 'Notifications',
      icon: <Bell className="w-5 h-5" />,
      items: ['Email Notifications', 'Push Notifications', 'Meeting Reminders']
    },
    {
      title: 'Privacy',
      icon: <Lock className="w-5 h-5" />,
      items: ['Data Sharing', 'Meeting Access', 'Recording Settings']
    },
    {
      title: 'Storage',
      icon: <Database className="w-5 h-5" />,
      items: ['Storage Usage', 'Auto-delete Settings', 'Backup']
    },
    {
      title: 'Appearance',
      icon: <Palette className="w-5 h-5" />,
      items: ['Theme', 'Font Size', 'Language']
    }
  ];

  return (
    <div className="p-8 max-w-4xl mx-auto">
      <div className="flex items-center gap-4 mb-8">
        <button
          onClick={() => router.back()}
          className="flex items-center gap-2 text-gray-600 hover:text-gray-900 transition-colors"
        >
          <ArrowLeft className="w-5 h-5" />
          <span>Back</span>
        </button>
        <h1 className="text-3xl font-bold">Settings</h1>
      </div>

      <div className="space-y-8">
        <RecordingSection />

        {settingsSections.map((section) => (
          <div key={section.title} className="border rounded-lg p-6">
            <div className="flex items-center gap-2 mb-4">
              {section.icon}
              <h2 className="text-xl font-semibold">{section.title}</h2>
            </div>
            <div className="space-y-4">
              {section.items.map((item) => (
                <div key={item} className="flex items-center justify-between p-3 hover:bg-gray-50 rounded-md cursor-pointer">
                  <span>{item}</span>
                  <button className="text-blue-600 hover:text-blue-800">Configure</button>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
