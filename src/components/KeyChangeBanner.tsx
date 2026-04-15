'use client';

import { useEffect, useState } from 'react';
import { onKeyChange, acceptKeyChange, type KeyChangeEvent } from '@/lib/e2ee-core';
import { fetchPublicDevices, fetchUserMasterKeyPub } from '@/lib/supabase/queries';

/**
 * Listens globally for TOFU key-change events. Each unacknowledged change
 * renders as a banner row with "Trust new key" / "Dismiss" buttons.
 */
export function KeyChangeBanner() {
  const [events, setEvents] = useState<KeyChangeEvent[]>([]);

  useEffect(() => {
    const unsub = onKeyChange((event) => {
      // Cap to the most recent 50 to bound memory under repeated key changes.
      setEvents((prev) => (prev.length >= 50 ? [...prev.slice(-49), event] : [...prev, event]));
    });
    return unsub;
  }, []);

  if (events.length === 0) return null;

  async function trust(e: KeyChangeEvent) {
    const umk = await fetchUserMasterKeyPub(e.userId);
    if (!umk) return;
    const devices = await fetchPublicDevices(e.userId);
    // Pick the most-recent active device's x25519 pub for the TOFU cache.
    const latest = devices[devices.length - 1];
    if (!latest) return;
    await acceptKeyChange(e.userId, {
      ed25519PublicKey: umk.ed25519PublicKey,
      x25519PublicKey: latest.x25519PublicKey,
      selfSignature: new Uint8Array(0),
    });
    setEvents((prev) => prev.filter((x) => x !== e));
  }
  function dismiss(e: KeyChangeEvent) {
    setEvents((prev) => prev.filter((x) => x !== e));
  }

  return (
    <div className="space-y-2">
      {events.map((event, i) => (
        <div
          key={i}
          className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-950"
        >
          <p>
            <strong>⚠ Encryption key changed</strong> for user{' '}
            <code className="font-mono text-xs">{event.userId}</code>. This
            usually means they reinstalled or reset their account. If you
            weren&apos;t expecting this, confirm with them through another
            channel before trusting.
          </p>
          <div className="mt-2 flex gap-2">
            <button
              onClick={() => void trust(event)}
              className="rounded bg-neutral-900 px-2 py-1 text-xs text-white dark:bg-white dark:text-neutral-900"
            >
              trust new key
            </button>
            <button
              onClick={() => dismiss(event)}
              className="rounded border border-neutral-300 px-2 py-1 text-xs dark:border-neutral-700"
            >
              dismiss
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
