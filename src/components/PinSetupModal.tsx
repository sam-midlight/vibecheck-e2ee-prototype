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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <form
        onSubmit={submit}
        className="w-full max-w-sm space-y-3 rounded bg-white p-4 text-sm dark:bg-neutral-900"
      >
        <h3 className="text-base font-semibold">
          {heading ?? 'Set a device passphrase'}
        </h3>
        <p className="text-xs text-neutral-600 dark:text-neutral-400">
          {blurb ??
            'Used to unlock your identity on this device. Argon2id-based — brute-force is slow but not impossible for short PINs; pick 8+ characters if you can. If you forget it and don\u2019t have a recovery phrase, this device is unrecoverable.'}
        </p>
        <div>
          <label className="text-xs text-neutral-500">passphrase</label>
          <input
            type="password"
            autoFocus
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            className="mt-1 block w-full rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900"
          />
        </div>
        <div>
          <label className="text-xs text-neutral-500">confirm</label>
          <input
            type="password"
            value={confirmPassphrase}
            onChange={(e) => setConfirmPassphrase(e.target.value)}
            className="mt-1 block w-full rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900"
          />
        </div>
        {err && <p className="text-xs text-red-600">{err}</p>}
        <div className="flex gap-2">
          <button
            type="submit"
            disabled={busy}
            className="rounded bg-neutral-900 px-3 py-1.5 text-xs text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
          >
            {busy ? 'saving…' : 'save'}
          </button>
          {!mandatory && onCancel && (
            <button
              type="button"
              onClick={onCancel}
              disabled={busy}
              className="rounded border border-neutral-300 px-3 py-1.5 text-xs disabled:opacity-50 dark:border-neutral-700"
            >
              cancel
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
