'use client';

/**
 * Device-B recovery flow (v3, per-device identities).
 *
 * User has signed in via magic link on a fresh device with no linked peer
 * available. They enter their 24-word phrase to unwrap the USER MASTER KEY
 * from `recovery_blobs`, then this device generates its own device bundle,
 * UMK signs the device's issuance cert locally, and we register the device.
 * The UMK priv is kept on this device so the user can approve further
 * devices from here.
 */

import { useState } from 'react';
import { errorMessage } from '@/lib/errors';
import {
  decodeRecoveryBlob,
  getSodium,
  isPhraseValid,
  splitPhrase,
  unwrapUserMasterKeyWithPhrase,
  type UserMasterKey,
} from '@/lib/e2ee-core';
import {
  fetchUserMasterKeyPub,
  getRecoveryBlob,
} from '@/lib/supabase/queries';
import { enrollDeviceWithUmk, type EnrolledDevice } from '@/lib/bootstrap';

interface Props {
  userId: string;
  onRecovered: (enrolled: EnrolledDevice) => void;
  onBack?: () => void;
}

export function RecoveryPhraseEntry({ userId, onRecovered, onBack }: Props) {
  const [phrase, setPhrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const words = splitPhrase(phrase).filter(Boolean);
  const wordCount = words.length;

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
          'No recovery blob found for this account. Either you never set one up, or you rotated it from another device.',
        );
      }
      const blob = await decodeRecoveryBlob(row);
      const unwrapped = await unwrapUserMasterKeyWithPhrase(blob, phrase, userId);

      // Derive UMK pub from the unwrapped priv and verify it matches the
      // server's published UMK pub. Rejects tampered recovery blobs.
      const sodium = await getSodium();
      const derivedPub = sodium.crypto_sign_ed25519_sk_to_pk(
        unwrapped.ed25519PrivateKey,
      );
      const publishedPub = await fetchUserMasterKeyPub(userId);
      if (!publishedPub) {
        throw new Error('No published UMK exists for this account.');
      }
      const matches = bytesEq(derivedPub, publishedPub.ed25519PublicKey);
      if (!matches) {
        throw new Error(
          'Recovery unwrapped, but the UMK doesn\u2019t match the published key. Refusing to install.',
        );
      }

      const umk: UserMasterKey = {
        ed25519PublicKey: derivedPub,
        ed25519PrivateKey: unwrapped.ed25519PrivateKey,
      };
      const enrolled = await enrollDeviceWithUmk(userId, umk);
      onRecovered(enrolled);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <h2 className="text-lg font-semibold">Enter your recovery phrase</h2>
      <p className="text-sm text-neutral-700 dark:text-neutral-300">
        Paste or type all 24 words, separated by spaces. The phrase is used
        to unwrap your User Master Key locally — it&apos;s never sent to our
        servers. This device will then generate its own per-device keys.
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
      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
      <div className="flex gap-2">
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            disabled={busy}
            className="rounded border border-neutral-300 px-4 py-2 text-sm dark:border-neutral-700"
          >
            back
          </button>
        )}
        <button
          type="submit"
          disabled={busy || wordCount !== 24}
          className="rounded bg-neutral-900 px-4 py-2 text-sm text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
        >
          {busy ? 'unwrapping…' : 'recover account'}
        </button>
      </div>
    </form>
  );
}

function bytesEq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}
