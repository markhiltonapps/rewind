'use client';

import { useState } from 'react';
import { sendCode, verifyCode } from '@/lib/authClient';

export default function SignIn() {
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [stage, setStage] = useState<'email' | 'code'>('email');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSendCode(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const { error: err } = await sendCode(email);
    setLoading(false);
    if (err) {
      setError(err);
    } else {
      setStage('code');
    }
  }

  async function handleVerify(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const { error: err } = await verifyCode(email, code);
    setLoading(false);
    if (err) {
      setError(err);
    }
    // On success the auth listener in AuthGate picks up the session change.
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-rw-bg-app">
      <div className="w-full max-w-sm rounded-xl border border-rw-border bg-rw-bg-panel p-8 shadow-lg">
        <h1 className="mb-1 font-mono text-sm font-medium uppercase tracking-widest text-rw-text-tertiary">
          NEATO REWIND
        </h1>
        <h2 className="mb-6 text-xl font-semibold text-rw-text-primary">
          Sign in
        </h2>

        {stage === 'email' ? (
          <form onSubmit={handleSendCode} className="space-y-4">
            <div>
              <label
                htmlFor="email"
                className="mb-1 block text-sm font-medium text-rw-text-secondary"
              >
                Email address
              </label>
              <input
                id="email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                className="w-full rounded-lg border border-rw-border bg-rw-bg-input px-3 py-2 text-sm text-rw-text-primary placeholder:text-rw-text-tertiary focus:outline-none focus:ring-2 focus:ring-rw-accent"
              />
            </div>
            {error && (
              <p className="text-sm text-red-500">{error}</p>
            )}
            <button
              type="submit"
              disabled={loading}
              className="w-full rounded-lg bg-rw-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50 transition-opacity"
            >
              {loading ? 'Sending…' : 'Send code'}
            </button>
          </form>
        ) : (
          <form onSubmit={handleVerify} className="space-y-4">
            <p className="text-sm text-rw-text-secondary">
              Check your email — we sent a code to{' '}
              <span className="font-medium text-rw-text-primary">{email}</span>.
            </p>
            <div>
              <label
                htmlFor="code"
                className="mb-1 block text-sm font-medium text-rw-text-secondary"
              >
                Verification code
              </label>
              <input
                id="code"
                type="text"
                inputMode="numeric"
                pattern="[0-9]{6,8}"
                maxLength={8}
                required
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                placeholder="12345678"
                className="w-full rounded-lg border border-rw-border bg-rw-bg-input px-3 py-2 font-mono text-lg tracking-widest text-rw-text-primary placeholder:text-rw-text-tertiary focus:outline-none focus:ring-2 focus:ring-rw-accent"
              />
            </div>
            {error && (
              <p className="text-sm text-red-500">{error}</p>
            )}
            <button
              type="submit"
              disabled={loading}
              className="w-full rounded-lg bg-rw-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50 transition-opacity"
            >
              {loading ? 'Verifying…' : 'Verify'}
            </button>
            <button
              type="button"
              onClick={() => { setStage('email'); setError(null); setCode(''); }}
              className="w-full text-sm text-rw-text-tertiary hover:text-rw-text-secondary transition-colors"
            >
              Use a different email
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
