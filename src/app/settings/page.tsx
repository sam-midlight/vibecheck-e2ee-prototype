'use client';

import { useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { RecoveryPhraseModal } from '@/components/RecoveryPhraseModal';
import { getIdentity, type Identity } from '@/lib/e2ee-core';
import { getSupabase } from '@/lib/supabase/client';
import { deleteRecoveryBlob, hasRecoveryBlob } from '@/lib/supabase/queries';

export default function SettingsPage() {
  return (
    <AppShell requireAuth>
      <SettingsInner />
    </AppShell>
  );
}

function SettingsInner() {
  const [userId, setUserId] = useState<string | null>(null);
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [hasPhrase, setHasPhrase] = useState<boolean | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const supabase = getSupabase();
      const { data } = await supabase.auth.getUser();
      if (!data.user) return;
      setUserId(data.user.id);
      setIdentity(await getIdentity(data.user.id));
      setHasPhrase(await hasRecoveryBlob(data.user.id));
    })().catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  async function handleRemove() {
    if (!userId) return;
    if (!confirm('Remove recovery phrase? If you lose all your devices, you won\u2019t be able to recover this account.')) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await deleteRecoveryBlob(userId);
      setHasPhrase(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!userId || !identity) {
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
        ) : hasPhrase ? (
          <div className="space-y-2">
            <p className="text-sm text-emerald-700 dark:text-emerald-300">
              A recovery phrase is set up for this account.
            </p>
            <p className="text-xs text-neutral-600 dark:text-neutral-400">
              If you lose the phrase (or it leaks), generate a new one — the
              old phrase stops working immediately.
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => setShowModal(true)}
                disabled={busy}
                className="rounded border border-neutral-300 px-3 py-1.5 text-xs dark:border-neutral-700"
              >
                rotate phrase
              </button>
              <button
                onClick={() => void handleRemove()}
                disabled={busy}
                className="rounded border border-red-300 px-3 py-1.5 text-xs text-red-700 dark:border-red-800 dark:text-red-400"
              >
                remove phrase
              </button>
            </div>
          </div>
        ) : (
          <div className="rounded-md border border-amber-300 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950">
            <p className="text-sm">
              {skipped
                ? 'You skipped setting up a recovery phrase.'
                : 'You don\u2019t have a recovery phrase.'}{' '}
              If you lose every signed-in device, your account and its data
              become unrecoverable.
            </p>
            <button
              onClick={() => setShowModal(true)}
              className="mt-2 rounded bg-neutral-900 px-3 py-1.5 text-xs text-white dark:bg-white dark:text-neutral-900"
            >
              Set up recovery phrase
            </button>
          </div>
        )}
      </section>

      {error && (
        <p className="text-sm text-red-600 dark:text-red-400">Error: {error}</p>
      )}

      {showModal && (
        <RecoveryPhraseModal
          userId={userId}
          identity={identity}
          hideSkip
          onDone={(result) => {
            setShowModal(false);
            if (result === 'saved') {
              setHasPhrase(true);
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
