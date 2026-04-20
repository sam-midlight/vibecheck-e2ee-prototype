'use client';

import { useState } from 'react';
import { errorMessage } from '@/lib/errors';

type Status = 'idle' | 'sending' | 'ready' | 'error';

export function MagicLinkForm() {
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setStatus('sending');
    setError(null);
    setLink(null);
    setCopied(false);
    const redirectTo =
      typeof window !== 'undefined'
        ? `${window.location.origin}/auth/callback`
        : undefined;
    try {
      const res = await fetch('/api/dev/magic-link', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, redirectTo }),
      });
      const body = (await res.json()) as { url?: string; error?: string };
      if (!res.ok || !body.url) {
        throw new Error(body.error ?? `request failed: ${res.status}`);
      }
      setLink(body.url);
      setStatus('ready');
    } catch (err) {
      setError(errorMessage(err));
      setStatus('error');
    }
  }

  async function copy() {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable; user can select the text manually
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3">
      <label className="font-display italic text-sm text-neutral-800 dark:text-neutral-200">
        Email
      </label>
      <input
        type="email"
        required
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        className="rounded-xl border border-neutral-200 bg-white/90 px-3 py-2.5 text-sm text-neutral-900 placeholder:italic placeholder:text-neutral-400 outline-none transition-colors focus:border-neutral-300 focus:ring-2 focus:ring-neutral-300/40 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
        placeholder="you@example.com"
        autoComplete="email"
      />
      <button
        type="submit"
        disabled={status === 'sending'}
        className="rounded-full bg-gradient-to-br from-neutral-700 via-neutral-800 to-neutral-900 px-5 py-2.5 font-display italic text-sm text-white shadow-[0_8px_20px_-4px_rgba(0,0,0,0.35),inset_0_2px_3px_rgba(255,255,255,0.15)] ring-1 ring-white/10 transition-all hover:scale-[1.02] active:scale-[1.04] disabled:opacity-50 dark:from-neutral-100 dark:via-white dark:to-neutral-200 dark:text-neutral-900 dark:ring-neutral-900/10"
      >
        {status === 'sending' ? 'generating…' : 'Generate magic link'}
      </button>

      {status === 'ready' && link && (
        <div className="rounded-2xl border border-amber-300/60 bg-amber-50/70 p-4 text-xs text-amber-900 shadow-lg backdrop-blur-md dark:border-amber-800/40 dark:bg-amber-950/50 dark:text-amber-100">
          <p className="font-display italic text-sm">Dev shortcut — no email sent.</p>
          <p className="mt-1">
            Copy this URL and open it (same browser, new tab):
          </p>
          <div className="mt-2 break-all rounded-xl bg-white/70 p-2 font-mono text-[11px] dark:bg-neutral-900/60">
            {link}
          </div>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={() => void copy()}
              className="rounded-full border border-neutral-300/60 bg-white/70 px-3 py-1 text-[11px] font-medium transition-transform duration-150 hover:bg-white active:scale-95 dark:border-neutral-700 dark:bg-neutral-900/60 dark:hover:bg-neutral-900"
            >
              {copied ? 'copied ✓' : 'copy'}
            </button>
            <a
              href={link}
              className="rounded-full bg-gradient-to-br from-neutral-700 via-neutral-800 to-neutral-900 px-3 py-1 font-display italic text-[11px] text-white shadow-[0_4px_10px_-2px_rgba(0,0,0,0.35)] ring-1 ring-white/10 transition-transform duration-150 hover:scale-[1.02] active:scale-95 dark:from-neutral-100 dark:via-white dark:to-neutral-200 dark:text-neutral-900 dark:ring-neutral-900/10"
            >
              open →
            </a>
          </div>
        </div>
      )}

      {error && (
        <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
      )}
    </form>
  );
}
