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
      <label className="text-sm font-medium">Email</label>
      <input
        type="email"
        required
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        className="rounded border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
        placeholder="you@example.com"
        autoComplete="email"
      />
      <button
        type="submit"
        disabled={status === 'sending'}
        className="rounded bg-neutral-900 px-4 py-2 text-sm text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
      >
        {status === 'sending' ? 'generating…' : 'generate magic link'}
      </button>

      {status === 'ready' && link && (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
          <p className="font-semibold">Dev shortcut — no email sent.</p>
          <p className="mt-1">
            Copy this URL and open it (same browser, new tab):
          </p>
          <div className="mt-2 break-all rounded bg-white p-2 font-mono text-[11px] dark:bg-neutral-900">
            {link}
          </div>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={() => void copy()}
              className="rounded border border-neutral-300 px-2 py-1 text-[11px] transition-transform duration-150 hover:bg-neutral-100 active:scale-95 dark:border-neutral-700 dark:hover:bg-neutral-800"
            >
              {copied ? 'copied ✓' : 'copy'}
            </button>
            <a
              href={link}
              className="rounded bg-neutral-900 px-2 py-1 text-[11px] text-white transition-transform duration-150 hover:bg-neutral-700 active:scale-95 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
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
