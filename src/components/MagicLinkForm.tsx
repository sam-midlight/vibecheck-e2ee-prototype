'use client';

import { useState } from 'react';
import { getSupabase } from '@/lib/supabase/client';
import { errorMessage } from '@/lib/errors';

type Status = 'idle' | 'sending' | 'sent' | 'error';

export function MagicLinkForm() {
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setStatus('sending');
    setError(null);
    const emailRedirectTo =
      typeof window !== 'undefined'
        ? `${window.location.origin}/auth/callback`
        : undefined;
    try {
      const { error: otpError } = await getSupabase().auth.signInWithOtp({
        email,
        options: emailRedirectTo ? { emailRedirectTo } : undefined,
      });
      if (otpError) throw otpError;
      setStatus('sent');
    } catch (err) {
      setError(errorMessage(err));
      setStatus('error');
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
        disabled={status === 'sending' || status === 'sent'}
        className="rounded-full bg-gradient-to-br from-neutral-700 via-neutral-800 to-neutral-900 px-5 py-2.5 font-display italic text-sm text-white shadow-[0_8px_20px_-4px_rgba(0,0,0,0.35),inset_0_2px_3px_rgba(255,255,255,0.15)] ring-1 ring-white/10 transition-all hover:scale-[1.02] active:scale-[1.04] disabled:opacity-50 dark:from-neutral-100 dark:via-white dark:to-neutral-200 dark:text-neutral-900 dark:ring-neutral-900/10"
      >
        {status === 'sending' ? 'sending…' : status === 'sent' ? 'sent ✓' : 'Send magic link'}
      </button>

      {status === 'sent' && (
        <div className="rounded-2xl border border-emerald-300/60 bg-emerald-50/70 p-4 text-xs text-emerald-900 shadow-lg backdrop-blur-md dark:border-emerald-800/40 dark:bg-emerald-950/50 dark:text-emerald-100">
          <p className="font-display italic text-sm">Check your inbox.</p>
          <p className="mt-1">
            We sent a sign-in link to <span className="font-mono">{email}</span>. Open it in this browser to continue.
          </p>
        </div>
      )}

      {error && (
        <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
      )}
    </form>
  );
}
