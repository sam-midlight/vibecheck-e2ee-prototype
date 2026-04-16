'use client';

import { useEffect, useRef, useState } from 'react';
import {
  onKeyChange,
  onVerificationBreak,
  acceptKeyChange,
  type KeyChangeEvent,
  type VerificationBreakEvent,
} from '@/lib/e2ee-core';
import { getSupabase } from '@/lib/supabase/client';
import { fetchPublicDevices, fetchUserMasterKeyPub } from '@/lib/supabase/queries';

/**
 * Listens globally for TOFU key-change events. Each unacknowledged change
 * renders as a banner row with "Trust new key" / "Dismiss" buttons.
 * Self key changes (own UMK rotation) are auto-accepted silently.
 */
export function KeyChangeBanner() {
  const [events, setEvents] = useState<KeyChangeEvent[]>([]);
  const [breakEvents, setBreakEvents] = useState<VerificationBreakEvent[]>([]);
  const selfUidRef = useRef<string | null>(null);

  useEffect(() => {
    void getSupabase()
      .auth.getUser()
      .then(({ data }) => {
        selfUidRef.current = data.user?.id ?? null;
      });
  }, []);

  useEffect(() => {
    const unsub = onKeyChange(async (event) => {
      // Auto-accept own key changes — these fire after UMK rotation on
      // this device and are expected, not suspicious.
      if (selfUidRef.current && event.userId === selfUidRef.current) {
        try {
          const umk = await fetchUserMasterKeyPub(event.userId);
          if (!umk) return;
          const devices = await fetchPublicDevices(event.userId);
          const latest = devices[devices.length - 1];
          if (!latest) return;
          await acceptKeyChange(event.userId, {
            ed25519PublicKey: umk.ed25519PublicKey,
            x25519PublicKey: latest.x25519PublicKey,
            selfSignature: new Uint8Array(0),
          });
        } catch {
          // non-fatal
        }
        return;
      }
      setEvents((prev) =>
        prev.length >= 50 ? [...prev.slice(-49), event] : [...prev, event],
      );
    });
    return unsub;
  }, []);

  useEffect(() => {
    const unsub = onVerificationBreak((event) => {
      // Don't also show the amber banner for the same event
      setEvents((prev) => prev.filter((e) => e.userId !== event.userId));
      setBreakEvents((prev) =>
        prev.length >= 50 ? [...prev.slice(-49), event] : [...prev, event],
      );
    });
    return unsub;
  }, []);

  if (events.length === 0 && breakEvents.length === 0) return null;

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
      {breakEvents.map((event, i) => (
        <div
          key={`break-${i}`}
          className="rounded-md border border-red-400 bg-red-50 p-3 text-sm dark:border-red-800 dark:bg-red-950"
        >
          <p>
            <strong className="text-red-800 dark:text-red-200">
              Security alert: verified contact&apos;s identity changed
            </strong>
            {' '}for user{' '}
            <code className="font-mono text-xs">{event.userId}</code>. You
            previously verified this person via emoji comparison. Their
            encryption keys have changed — this could mean they reset their
            account, OR someone is impersonating them. <strong>Do not send
            sensitive messages until you re-verify.</strong>
          </p>
          <div className="mt-2 flex gap-2">
            <button
              onClick={() => {
                void trust(event);
                setBreakEvents((prev) => prev.filter((x) => x !== event));
              }}
              className="rounded bg-red-700 px-2 py-1 text-xs text-white"
            >
              trust + re-verify later
            </button>
            <button
              onClick={() => setBreakEvents((prev) => prev.filter((x) => x !== event))}
              className="rounded border border-neutral-300 px-2 py-1 text-xs dark:border-neutral-700"
            >
              dismiss
            </button>
          </div>
        </div>
      ))}
      {events.map((event, i) => (
        <div
          key={`change-${i}`}
          className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-950"
        >
          <p>
            <strong>Encryption key changed</strong> for user{' '}
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
