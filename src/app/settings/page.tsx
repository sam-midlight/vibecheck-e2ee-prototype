'use client';

import { useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { RecoveryPhraseModal } from '@/components/RecoveryPhraseModal';
import {
  clearDeviceBundle,
  clearWrappedIdentity,
  getDeviceBundle,
  getUserMasterKey,
  hasWrappedIdentity,
  putWrappedIdentity,
  wrapDeviceStateWithPin,
  type DeviceKeyBundle,
  type UserMasterKey,
} from '@/lib/e2ee-core';
import { useRouter } from 'next/navigation';
import { getSupabase } from '@/lib/supabase/client';
import { hasRecoveryBlob } from '@/lib/supabase/queries';

export default function SettingsPage() {
  return (
    <AppShell requireAuth>
      <SettingsInner />
    </AppShell>
  );
}

function SettingsInner() {
  const router = useRouter();
  const [userId, setUserId] = useState<string | null>(null);
  const [device, setDevice] = useState<DeviceKeyBundle | null>(null);
  const [umk, setUmk] = useState<UserMasterKey | null>(null);
  const [hasPhrase, setHasPhrase] = useState<boolean | null>(null);
  const [pinEnabled, setPinEnabled] = useState<boolean | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [showPinSetup, setShowPinSetup] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const supabase = getSupabase();
      const { data } = await supabase.auth.getUser();
      if (!data.user) return;
      setUserId(data.user.id);
      setDevice(await getDeviceBundle(data.user.id));
      setUmk(await getUserMasterKey(data.user.id));
      setHasPhrase(await hasRecoveryBlob(data.user.id));
      setPinEnabled(await hasWrappedIdentity(data.user.id));
    })().catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  async function handleDisablePin() {
    if (!userId) return;
    if (
      !confirm(
        'Disable passphrase lock? The identity will go back to being readable from IndexedDB on this device without a passphrase.',
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await clearWrappedIdentity(userId);
      setPinEnabled(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleLockNow() {
    if (!userId) return;
    if (
      !confirm(
        'Lock now? The plaintext identity copy is cleared from this device and you\u2019ll be sent to the unlock screen. In-flight room tabs will also fail their next load.',
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await clearDeviceBundle(userId);
      // Also drop UMK priv from memory (if this device held it); unlock
      // will re-materialize it from the wrapped blob using the passphrase.
      const { clearUserMasterKey } = await import('@/lib/e2ee-core');
      await clearUserMasterKey(userId);
      router.replace('/auth/callback');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  if (!userId || !device) {
    return <p className="text-sm text-neutral-500">loading…</p>;
  }

  const skipped =
    typeof window !== 'undefined' &&
    localStorage.getItem(`recovery_skipped_${userId}`) === '1';

  return (
    <div className="max-w-xl space-y-6">
      <h1 className="text-xl font-semibold">Settings</h1>

      <section className="space-y-3">
        <h2 className="text-sm font-medium uppercase tracking-wide text-neutral-500">
          Recovery phrase
        </h2>
        {hasPhrase === null ? (
          <p className="text-sm text-neutral-500">checking…</p>
        ) : !umk ? (
          <p className="text-xs text-neutral-600 dark:text-neutral-400">
            This device doesn&apos;t hold the User Master Key, so it can&apos;t
            rotate it. Open the app on your primary device (the one that
            created this account, or the one you last used to enter a recovery
            phrase) and rotate from there.
          </p>
        ) : (
          <div className="space-y-2">
            <p className="text-sm">
              {hasPhrase
                ? 'A recovery phrase is set up.'
                : skipped
                  ? 'You skipped setting up a recovery phrase.'
                  : 'No recovery phrase is set up yet.'}
            </p>
            <p className="text-xs text-neutral-600 dark:text-neutral-400">
              Clicking below generates a fresh master key, re-signs every
              device&apos;s cert under the new key, and wraps the new key
              with a new 24-word phrase. Any other device you&apos;re signed
              into becomes orphaned and will need to re-link.
            </p>
            <button
              onClick={() => setShowModal(true)}
              disabled={busy}
              className="rounded bg-neutral-900 px-3 py-1.5 text-xs text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
            >
              Rotate &amp; generate new phrase
            </button>
          </div>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium uppercase tracking-wide text-neutral-500">
          Device passphrase lock
        </h2>
        <p className="text-xs text-neutral-600 dark:text-neutral-400">
          Without this, your identity private keys sit in this browser\u2019s
          IndexedDB as plaintext — readable by browser extensions, disk
          forensics, or anyone else who uses this profile. With it, the keys
          are Argon2id-wrapped and you enter a passphrase on each new session.
        </p>
        {pinEnabled === null ? (
          <p className="text-sm text-neutral-500">checking…</p>
        ) : pinEnabled ? (
          <div className="space-y-2">
            <p className="text-sm text-emerald-700 dark:text-emerald-300">
              Passphrase lock is enabled on this device.
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => void handleLockNow()}
                disabled={busy}
                className="rounded border border-neutral-300 px-3 py-1.5 text-xs dark:border-neutral-700"
              >
                lock now
              </button>
              <button
                onClick={() => void handleDisablePin()}
                disabled={busy}
                className="rounded border border-red-300 px-3 py-1.5 text-xs text-red-700 dark:border-red-800 dark:text-red-400"
              >
                disable lock
              </button>
            </div>
          </div>
        ) : (
          <div className="rounded-md border border-neutral-300 bg-neutral-50 p-3 dark:border-neutral-700 dark:bg-neutral-900">
            <button
              onClick={() => setShowPinSetup(true)}
              className="rounded bg-neutral-900 px-3 py-1.5 text-xs text-white dark:bg-white dark:text-neutral-900"
            >
              Set passphrase
            </button>
          </div>
        )}
      </section>

      {error && (
        <p className="text-sm text-red-600 dark:text-red-400">Error: {error}</p>
      )}

      {showPinSetup && (
        <PinSetupModal
          onCancel={() => setShowPinSetup(false)}
          onSave={async (passphrase) => {
            if (!userId || !device) return;
            const blob = await wrapDeviceStateWithPin(device, umk, passphrase, userId);
            await putWrappedIdentity(userId, blob);
            setPinEnabled(true);
            setShowPinSetup(false);
          }}
        />
      )}

      {showModal && umk && (
        <RecoveryPhraseModal
          userId={userId}
          umk={umk}
          hideSkip
          rotate
          onDone={async (result) => {
            setShowModal(false);
            if (result === 'saved') {
              setHasPhrase(true);
              // The rotation swapped the locally-held UMK; pick up the new one.
              const { getUserMasterKey } = await import('@/lib/e2ee-core');
              setUmk(await getUserMasterKey(userId));
              if (typeof window !== 'undefined') {
                localStorage.removeItem(`recovery_skipped_${userId}`);
              }
            }
          }}
        />
      )}
    </div>
  );
}

function PinSetupModal({
  onCancel,
  onSave,
}: {
  onCancel: () => void;
  onSave: (passphrase: string) => Promise<void>;
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
      setErr(e instanceof Error ? e.message : String(e));
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
        <h3 className="text-base font-semibold">Set a device passphrase</h3>
        <p className="text-xs text-neutral-600 dark:text-neutral-400">
          Used to unlock your identity on this device. Argon2id-based — brute-force
          is slow but not impossible for short PINs; pick 8+ characters if you can.
          If you forget it and don\u2019t have a recovery phrase, this device is
          unrecoverable.
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
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded border border-neutral-300 px-3 py-1.5 text-xs disabled:opacity-50 dark:border-neutral-700"
          >
            cancel
          </button>
        </div>
      </form>
    </div>
  );
}
