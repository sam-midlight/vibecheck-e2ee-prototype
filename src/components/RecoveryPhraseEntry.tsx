'use client';

/**
 * Device-B recovery flow: user has signed in via magic link on a fresh
 * device with no linked peer available. They enter their 24-word phrase to
 * unwrap their identity from `recovery_blobs` and install it locally.
 */

import { useState } from 'react';
import {
  bytesEqual,
  decodeRecoveryBlob,
  derivePublicIdentity,
  isPhraseValid,
  publicIdentityFingerprint,
  putDeviceRecord,
  putIdentity,
  splitPhrase,
  unwrapIdentityWithPhrase,
  type Identity,
} from '@/lib/e2ee-core';
import {
  fetchIdentity,
  getRecoveryBlob,
  registerDevice,
} from '@/lib/supabase/queries';

interface Props {
  userId: string;
  onRecovered: (identity: Identity) => void;
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
        throw new Error('No recovery blob found for this account. Either you never set one up, or you rotated it from another device.');
      }
      const blob = await decodeRecoveryBlob(row);
      const privs = await unwrapIdentityWithPhrase(blob, phrase, userId);

      // Combine unwrapped privs with the server's published public halves.
      const pub = await fetchIdentity(userId);
      if (!pub) throw new Error('No published identity exists for this account.');
      const identity: Identity = {
        ed25519PublicKey: pub.ed25519PublicKey,
        x25519PublicKey: pub.x25519PublicKey,
        ed25519PrivateKey: privs.ed25519PrivateKey,
        x25519PrivateKey: privs.x25519PrivateKey,
      };

      // Sanity check: derive pubs from the privs and verify they match.
      const derived = await derivePublicIdentity(identity);
      const edOk = await bytesEqual(derived.ed25519PublicKey, pub.ed25519PublicKey);
      const xOk = await bytesEqual(derived.x25519PublicKey, pub.x25519PublicKey);
      if (!edOk || !xOk) {
        throw new Error(
          'Recovery unwrapped, but the keys don\u2019t match the published identity. Refusing to install.',
        );
      }

      await putIdentity(userId, identity);
      const deviceId = await registerDevice({
        userId,
        devicePublicKey: identity.x25519PublicKey,
        displayName: inferDeviceName(),
      });
      await putDeviceRecord(userId, deviceId, inferDeviceName());

      // Paranoia: log fingerprint so user can compare against their main device.
      console.info(
        'installed identity fingerprint:',
        await publicIdentityFingerprint(pub),
      );

      onRecovered(identity);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <h2 className="text-lg font-semibold">Enter your recovery phrase</h2>
      <p className="text-sm text-neutral-700 dark:text-neutral-300">
        Paste or type all 24 words, separated by spaces. The phrase is used
        to unwrap your keys locally — it&apos;s never sent to our servers.
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
      <p className="text-xs text-neutral-500">
        {wordCount} / 24 words
      </p>
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

function inferDeviceName(): string {
  if (typeof navigator === 'undefined') return 'device';
  const ua = navigator.userAgent;
  if (/Mobile|Android|iPhone|iPad/i.test(ua)) return 'Mobile browser';
  if (/Firefox/i.test(ua)) return 'Firefox';
  if (/Edg\//i.test(ua)) return 'Edge';
  if (/Chrome/i.test(ua)) return 'Chrome';
  if (/Safari/i.test(ua)) return 'Safari';
  return 'Browser';
}
