'use client';

import { useState } from 'react';
import { errorMessage } from '@/lib/errors';

export function PinSetupModal({
  onCancel,
  onSave,
  mandatory,
  heading,
  blurb,
}: {
  onCancel?: () => void;
  onSave: (passphrase: string) => Promise<void>;
  /** If true, no Cancel button — used for first-time setup where the PIN is a
   *  required step (enforced default). */
  mandatory?: boolean;
  heading?: string;
  blurb?: string;
}) {
  const [passphrase, setPassphrase] = useState('');
  const [confirmPassphrase, setConfirmPassphrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    if (passphrase.length < 4) {
      setErr('passphrase must be at least 4 characters (8+ strongly recommended)');
      return;
    }
    if (passphrase !== confirmPassphrase) {
      setErr('passphrases do not match');
      return;
    }
    setBusy(true);
    try {
      await onSave(passphrase);
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
      <form
        onSubmit={submit}
        className="w-full max-w-md space-y-4 rounded-3xl border border-white/60 bg-white/95 p-6 text-sm shadow-2xl backdrop-blur-md dark:border-white/10 dark:bg-neutral-900/95"
      >
        <div>
          <h3 className="font-display italic text-2xl text-neutral-900 dark:text-neutral-50">
            {heading ?? 'Set a device passphrase'}
          </h3>
          <p className="mt-2 text-sm leading-relaxed text-neutral-700 dark:text-neutral-300">
            {blurb ??
              'Used to unlock your identity on this device. Argon2id-based — brute-force is slow but not impossible for short PINs; pick 8+ characters if you can. If you forget it and don\u2019t have a recovery phrase, this device is unrecoverable.'}
          </p>
          {mandatory && (
            <p className="mt-2 text-xs leading-relaxed text-amber-700 dark:text-amber-300">
              One-time setup — required so your keys can&apos;t be read at rest. You can change this passphrase later in Settings.
            </p>
          )}
        </div>

        <div className="space-y-3">
          <label className="block">
            <span className="text-[11px] font-medium uppercase tracking-[0.18em] text-neutral-700 dark:text-neutral-300">
              Passphrase
            </span>
            <input
              type="password"
              autoFocus
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              className="mt-1.5 block w-full rounded-xl border border-neutral-300 bg-white/95 px-3 py-2 text-sm text-neutral-900 outline-none transition-colors focus:border-amber-300 focus:ring-2 focus:ring-amber-300/40 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
            />
          </label>
          <label className="block">
            <span className="text-[11px] font-medium uppercase tracking-[0.18em] text-neutral-700 dark:text-neutral-300">
              Confirm
            </span>
            <input
              type="password"
              value={confirmPassphrase}
              onChange={(e) => setConfirmPassphrase(e.target.value)}
              className="mt-1.5 block w-full rounded-xl border border-neutral-300 bg-white/95 px-3 py-2 text-sm text-neutral-900 outline-none transition-colors focus:border-amber-300 focus:ring-2 focus:ring-amber-300/40 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
            />
          </label>
        </div>

        {err && <p className="text-xs text-red-600 dark:text-red-400">{err}</p>}

        <div className="flex gap-2 pt-1">
          <button
            type="submit"
            disabled={busy}
            className="rounded-full bg-gradient-to-br from-amber-200 via-amber-300 to-amber-400 px-5 py-2 font-display italic text-sm text-amber-950 shadow-[0_8px_20px_-4px_rgba(217,119,6,0.5),inset_0_2px_3px_rgba(255,255,255,0.55),inset_0_-3px_6px_rgba(146,64,14,0.25)] ring-1 ring-amber-200/60 transition-all hover:scale-[1.04] active:scale-[1.06] disabled:opacity-50"
          >
            {busy ? 'saving…' : 'Save passphrase'}
          </button>
          {!mandatory && onCancel && (
            <button
              type="button"
              onClick={onCancel}
              disabled={busy}
              className="rounded-full border border-neutral-300 bg-white/80 px-4 py-2 font-display italic text-sm text-neutral-800 transition-all hover:scale-[1.04] hover:bg-white active:scale-[1.02] disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-900/60 dark:text-neutral-200"
            >
              Cancel
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
