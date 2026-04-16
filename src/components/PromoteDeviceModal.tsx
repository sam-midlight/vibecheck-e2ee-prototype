'use client';

/**
 * "Promote this device to primary" (Matrix-style multi-primary).
 *
 * When a device was enrolled via the v3 approval flow, it holds a device
 * bundle but no UMK priv — so it can't sign issuance certs for new devices
 * and its PendingApprovalBanner stays hidden. This modal lets the user
 * unwrap UMK from the recovery blob using their 24-word phrase and stash
 * it locally, turning this device into a co-primary that can approve
 * further devices alongside the original primary.
 *
 * Why this is safe(r than v1/v2): we're not transmitting UMK priv over
 * the wire. The phrase is the pre-existing UMK-recovery credential; any
 * device that holds the phrase can already unwrap UMK. We're just doing
 * it on demand instead of only during "fresh-device recovery".
 *
 * Pin-lock interaction: if this device has a passphrase wrap, we also
 * re-wrap the device state + new UMK with the passphrase so the UMK
 * survives the next lock cycle. Otherwise the user would need to
 * re-promote after every re-unlock.
 */

import { useState } from 'react';
import { errorMessage } from '@/lib/errors';
import {
  decodeRecoveryBlob,
  getDeviceBundle,
  getSodium,
  isPhraseValid,
  putBackupKey,
  putSelfSigningKey,
  putUserMasterKey,
  putUserSigningKey,
  putWrappedIdentity,
  splitPhrase,
  unwrapUserMasterKeyWithPhrase,
  wrapDeviceStateWithPin,
  type SelfSigningKey,
  type UserMasterKey,
  type UserSigningKey,
} from '@/lib/e2ee-core';
import {
  fetchUserMasterKeyPub,
  getRecoveryBlob,
} from '@/lib/supabase/queries';

interface Props {
  userId: string;
  /** If true, we also need the PIN passphrase to re-wrap the local blob. */
  pinEnabled: boolean;
  onDone: (result: 'promoted' | 'cancelled') => void;
}

export function PromoteDeviceModal({ userId, pinEnabled, onDone }: Props) {
  const [phrase, setPhrase] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const wordCount = splitPhrase(phrase).filter(Boolean).length;
  const canSubmit =
    !busy &&
    wordCount === 24 &&
    (!pinEnabled || passphrase.length > 0);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (wordCount !== 24) {
        throw new Error(`Need 24 words, you entered ${wordCount}.`);
      }
      if (!isPhraseValid(phrase)) {
        throw new Error('That phrase doesn\u2019t pass BIP-39 checksum. Check for typos.');
      }

      const row = await getRecoveryBlob(userId);
      if (!row) {
        throw new Error(
          'No recovery blob found for this account. Either you never set one up, or it was rotated away.',
        );
      }
      const blob = await decodeRecoveryBlob(row);
      const unwrapped = await unwrapUserMasterKeyWithPhrase(blob, phrase, userId);

      // Verify the unwrapped UMK priv derives the published UMK pub.
      // Rejects tampered blobs and catches "wrong account" mismatches.
      const sodium = await getSodium();
      const derivedPub = sodium.crypto_sign_ed25519_sk_to_pk(
        unwrapped.ed25519PrivateKey,
      );
      const publishedPub = await fetchUserMasterKeyPub(userId);
      if (!publishedPub) {
        throw new Error('No published UMK exists for this account.');
      }
      if (!bytesEq(derivedPub, publishedPub.ed25519PublicKey)) {
        throw new Error(
          'Recovery unwrapped, but the UMK doesn\u2019t match the published key. Refusing to install.',
        );
      }

      const umk: UserMasterKey = {
        ed25519PublicKey: derivedPub,
        ed25519PrivateKey: unwrapped.ed25519PrivateKey,
      };

      // Stash MSK locally.
      await putUserMasterKey(userId, umk);

      // v4 recovery blobs carry SSK + USK privs. Reconstruct and store.
      let ssk: SelfSigningKey | null = null;
      let usk: UserSigningKey | null = null;
      if (unwrapped.sskPriv && unwrapped.uskPriv) {
        const sskPub = sodium.crypto_sign_ed25519_sk_to_pk(unwrapped.sskPriv);
        const uskPub = sodium.crypto_sign_ed25519_sk_to_pk(unwrapped.uskPriv);
        ssk = { ed25519PublicKey: sskPub, ed25519PrivateKey: unwrapped.sskPriv };
        usk = { ed25519PublicKey: uskPub, ed25519PrivateKey: unwrapped.uskPriv };
        await putSelfSigningKey(userId, ssk);
        await putUserSigningKey(userId, usk);
      }

      // v3/v4 recovery blobs carry the backup key.
      if (unwrapped.backupKey) {
        await putBackupKey(userId, unwrapped.backupKey);
      }

      // If pin-lock is enabled, re-wrap the device state + all keys under
      // the same passphrase so they survive the next lock cycle.
      if (pinEnabled) {
        const device = await getDeviceBundle(userId);
        if (!device) {
          throw new Error(
            'No device bundle on this device — unexpected. Re-sign-in and try again.',
          );
        }
        const { unwrapDeviceStateWithPin } = await import('@/lib/e2ee-core');
        const { getWrappedIdentity } = await import('@/lib/e2ee-core');
        const existing = await getWrappedIdentity(userId);
        if (!existing) {
          throw new Error('pin is enabled but no wrapped identity blob found');
        }
        // Trial unwrap — throws DECRYPT_FAILED on a wrong passphrase.
        await unwrapDeviceStateWithPin(existing, passphrase, userId);

        // Re-wrap with SSK/USK if we recovered them (v3 pin-lock format).
        const rewrapped = await wrapDeviceStateWithPin(
          device,
          umk,
          passphrase,
          userId,
          { ssk, usk },
        );
        await putWrappedIdentity(userId, rewrapped);
      }

      onDone('promoted');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <form
        onSubmit={submit}
        className="w-full max-w-xl space-y-4 rounded-lg bg-white p-6 shadow-xl dark:bg-neutral-900"
      >
        <h2 className="text-lg font-semibold">Promote this device to primary</h2>
        <p className="text-sm text-neutral-700 dark:text-neutral-300">
          This device was linked from another device, so it doesn&apos;t hold
          your User Master Key — which means it can&apos;t approve new device
          sign-ins. Enter your 24-word recovery phrase to unwrap the UMK locally.
          After this, this device can approve further devices alongside your
          original primary.
        </p>
        <p className="text-xs text-neutral-500">
          The phrase never leaves this browser. It&apos;s used to decrypt the
          UMK priv from your recovery blob.
        </p>
        <textarea
          value={phrase}
          onChange={(e) => setPhrase(e.target.value)}
          rows={4}
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          className="w-full rounded border border-neutral-300 p-3 font-mono text-sm dark:border-neutral-700 dark:bg-neutral-950"
          placeholder="word1 word2 word3 … word24"
        />
        <p className="text-xs text-neutral-500">{wordCount} / 24 words</p>

        {pinEnabled && (
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-neutral-500">
              Also enter your device passphrase so we can re-wrap this
              device&apos;s keys to include the UMK.
            </span>
            <input
              type="password"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              autoComplete="current-password"
              className="rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-950"
            />
          </label>
        )}

        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

        <div className="flex gap-2 pt-1">
          <button
            type="submit"
            disabled={!canSubmit}
            className="rounded bg-neutral-900 px-4 py-2 text-sm text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
          >
            {busy ? 'promoting\u2026' : 'Promote this device'}
          </button>
          <button
            type="button"
            onClick={() => onDone('cancelled')}
            disabled={busy}
            className="rounded border border-neutral-300 px-4 py-2 text-sm dark:border-neutral-700"
          >
            cancel
          </button>
        </div>
      </form>
    </div>
  );
}

function bytesEq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}
