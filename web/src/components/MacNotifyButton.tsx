'use client';
import { useState } from 'react';

export function MacNotifyButton() {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [state, setState] = useState<'idle' | 'loading' | 'ok' | 'error'>('idle');

  if (state === 'ok') return <span className="text-rwtext2 text-sm">Thanks — we'll email you when macOS is ready.</span>;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setState('loading');
    try {
      const r = await fetch('/api/notify-macos', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      setState(r.ok ? 'ok' : 'error');
    } catch { setState('error'); }
  }

  if (!open) {
    return (
      <button onClick={() => setOpen(true)}
        className="rounded-lg border border-rwline px-5 py-3 font-semibold text-rwtext2">
        macOS — Notify me
      </button>
    );
  }
  return (
    <form onSubmit={submit} className="flex gap-2 items-center">
      <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)}
        placeholder="you@company.com"
        className="rounded-lg border border-rwline bg-rwpanel2 px-3 py-2 text-rwtext placeholder:text-rwtext3" />
      <button type="submit" disabled={state === 'loading'}
        className="rounded-lg border border-rwline px-4 py-2 text-rwtext2">
        {state === 'loading' ? '…' : 'Notify me'}
      </button>
    </form>
  );
}
