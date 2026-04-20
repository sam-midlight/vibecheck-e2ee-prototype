'use client';

/**
 * Reusable bribe submission form.
 *
 * Callers pass the current balance (so we can cap/validate the amount and
 * show affordability) and an async onSubmit that emits the actual bribe
 * event into the room. We handle the amount/comment inputs, validation,
 * busy state, and basic error surfacing.
 */

import { useState } from 'react';
import { describeError } from '@/lib/domain/errors';

export function BribeForm({
  balance,
  label,
  onCancel,
  onSubmit,
  minAmount = 1,
}: {
  balance: number;
  label: string;
  onCancel: () => void;
  onSubmit: (amount: number, comment: string | undefined) => Promise<void>;
  minAmount?: number;
}) {
  const [amount, setAmount] = useState<number>(Math.max(minAmount, 3));
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canAfford = amount <= balance;
  const valid = amount >= minAmount && canAfford;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(amount, comment.trim() || undefined);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      className="mt-3 space-y-3 rounded-2xl border border-rose-300/60 bg-rose-50/70 p-4 shadow-sm backdrop-blur-md dark:border-rose-800/40 dark:bg-rose-950/40"
    >
      <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-rose-800 dark:text-rose-300">
        🪙 {label} · balance {balance}♥
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-[11px] font-medium uppercase tracking-wide text-rose-800 dark:text-rose-300">
          amount
        </label>
        <input
          type="number"
          min={minAmount}
          max={Math.max(minAmount, balance)}
          value={amount}
          onChange={(e) => setAmount(Math.max(minAmount, Number(e.target.value) | 0))}
          disabled={busy}
          className="w-24 rounded-xl border border-rose-200 bg-white/90 px-3 py-2 text-right font-mono text-sm font-semibold tabular-nums text-rose-950 outline-none focus:border-rose-300 focus:ring-2 focus:ring-rose-300/40 dark:border-rose-800 dark:bg-neutral-950 dark:text-rose-100"
        />
        <span
          className={`text-xs ${
            canAfford
              ? 'text-rose-700 dark:text-rose-300'
              : 'text-red-700 dark:text-red-400'
          }`}
        >
          {canAfford ? `leaves ${balance - amount}♥` : `short by ${amount - balance}♥`}
        </span>
      </div>
      <input
        type="text"
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        placeholder="optional comment"
        maxLength={500}
        disabled={busy}
        className="block w-full rounded-xl border border-rose-200 bg-white/90 px-3 py-2 text-sm text-neutral-900 placeholder:italic placeholder:text-rose-300 outline-none transition-colors focus:border-rose-300 focus:ring-2 focus:ring-rose-300/40 dark:border-rose-800 dark:bg-neutral-950 dark:text-neutral-100"
      />
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={!valid || busy}
          className="rounded-full bg-gradient-to-br from-rose-300 via-rose-500 to-pink-600 px-5 py-2 font-display italic text-sm text-white shadow-[0_8px_20px_-4px_rgba(244,63,94,0.55),inset_0_2px_3px_rgba(255,255,255,0.4),inset_0_-3px_6px_rgba(159,18,57,0.3)] ring-1 ring-rose-200/60 transition-all hover:scale-[1.04] active:scale-[1.06] disabled:opacity-50"
        >
          {busy ? 'sending…' : `Spend ${amount}♥`}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="rounded-full border border-rose-200 bg-white/80 px-4 py-2 font-display italic text-sm text-rose-900 transition-all hover:scale-[1.04] hover:bg-white active:scale-[1.02] disabled:opacity-50 dark:border-rose-800 dark:bg-neutral-900/60 dark:text-rose-200"
        >
          Cancel
        </button>
      </div>
      {error && <p className="text-xs text-red-600">{error}</p>}
    </form>
  );
}
