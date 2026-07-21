'use client';
import { useState } from 'react';

export function SignupForm({ variant = 'hero' }: { variant?: 'hero' | 'cta' }) {
  const [email, setEmail] = useState('');
  const [state, setState] = useState<'idle' | 'loading' | 'ok' | 'waitlisted' | 'error'>('idle');
  const [downloadUrl, setDownloadUrl] = useState('');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setState('loading');
    try {
      const r = await fetch('/api/signup', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const d = await r.json();
      if (d.status === 'ok') { setDownloadUrl(d.downloadUrl); setState('ok'); }
      else if (d.status === 'waitlisted') setState('waitlisted');
      else setState('error');
    } catch { setState('error'); }
  }

  if (state === 'ok') {
    return (
      <div className="w-full">
        <a href={downloadUrl} className="inline-block rounded-lg bg-rw-accent px-5 py-3 font-semibold text-rwbg">
          ⬇ Download for Windows
        </a>
        <div className="mt-4 max-w-md rounded-lg border border-rwline bg-rwpanel2 p-4 text-left">
          <p className="text-sm font-medium text-rwtext2">First time installing?</p>
          <p className="mt-1 text-[13px] leading-relaxed text-rwtext3">
            Windows may show a blue{' '}
            <span className="text-rwtext2">&ldquo;Windows protected your PC&rdquo;</span> screen — that&rsquo;s
            just because we&rsquo;re a new publisher, not because anything&rsquo;s wrong.
          </p>
          <ol className="mt-3 space-y-1.5 text-[13px] text-rwtext2">
            <li><span className="text-rwtext3">1.</span> Click <span className="font-medium">More info</span></li>
            <li><span className="text-rwtext3">2.</span> Click <span className="font-medium">Run anyway</span></li>
            <li><span className="text-rwtext3">3.</span> Follow the installer</li>
          </ol>
          <p className="mt-3 text-[12px] leading-relaxed text-rwtext3">
            We&rsquo;re finalizing our code-signing certificate to remove this prompt soon.
          </p>
        </div>
      </div>
    );
  }
  if (state === 'waitlisted') return <p className="text-rwtext2">You're on the list — we'll email you when a spot opens.</p>;

  return (
    <form onSubmit={submit} className="flex flex-wrap gap-3 items-center justify-center">
      <input
        type="email" required value={email} onChange={(e) => setEmail(e.target.value)}
        placeholder="you@company.com"
        className="rounded-lg border border-rwline bg-rwpanel2 px-4 py-3 text-rwtext placeholder:text-rwtext3 min-w-[240px]"
      />
      <button type="submit" disabled={state === 'loading'}
        className="rounded-lg bg-rw-accent px-5 py-3 font-semibold text-rwbg disabled:opacity-60">
        {state === 'loading' ? 'Working…' : variant === 'hero' ? '⬇ Get access' : 'Get access →'}
      </button>
      {state === 'error' && <p className="w-full text-sm text-red-400">Something went wrong — please try again.</p>}
    </form>
  );
}
