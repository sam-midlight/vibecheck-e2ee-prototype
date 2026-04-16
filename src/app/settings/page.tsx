'use client';

import { useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { PinSetupModal } from '@/components/PinSetupModal';
import { RecoveryPhraseModal } from '@/components/RecoveryPhraseModal';
import { errorMessage } from '@/lib/errors';
import { rotateAllRoomsIAdmin } from '@/lib/bootstrap';
import {
  clearDeviceBundle,
  clearWrappedIdentity,
  decryptDeviceDisplayName,
  fromBase64,
  getDeviceBundle,
  getUserMasterKey,
  hasWrappedIdentity,
  publicIdentityFingerprint,
  putWrappedIdentity,
  signDeviceRevocation,
  wrapDeviceStateWithPin,
  type DeviceKeyBundle,
  type UserMasterKey,
} from '@/lib/e2ee-core';
import { useRouter } from 'next/navigation';
import { getSupabase } from '@/lib/supabase/client';
import {
  fetchUserMasterKeyPub,
  hasRecoveryBlob,
  listDevices,
  revokeDevice,
  type DeviceRow,
} from '@/lib/supabase/queries';

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
  const [myFingerprint, setMyFingerprint] = useState<string | null>(null);
  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [deviceLabels, setDeviceLabels] = useState<Map<string, string>>(() => new Map());
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
      // Compute own UMK-derived safety number for the "your number" strip.
      try {
        const umkPub = await fetchUserMasterKeyPub(data.user.id);
        if (umkPub) {
          setMyFingerprint(
            await publicIdentityFingerprint({
              ed25519PublicKey: umkPub.ed25519PublicKey,
              x25519PublicKey: umkPub.ed25519PublicKey,
              selfSignature: new Uint8Array(0),
            }),
          );
        }
      } catch {
        // non-fatal
      }
      await reloadDevices(data.user.id);
    })().catch((e) => setError(errorMessage(e)));
  }, []);

  async function reloadDevices(uid: string) {
    const rows = await listDevices(uid);
    setDevices(rows);
    // Decrypt each display_name_ciphertext with the local device's x25519
    // priv. crypto_box_seal_open succeeds only for rows sealed to this
    // device's pub — so we decrypt our own label and leave others opaque.
    const local = await getDeviceBundle(uid);
    if (!local) return;
    const entries = await Promise.all(
      rows.map(async (r): Promise<[string, string] | null> => {
        if (!r.display_name_ciphertext) return null;
        try {
          const ct = await fromBase64(r.display_name_ciphertext);
          const plain = await decryptDeviceDisplayName(
            ct,
            local.x25519PublicKey,
            local.x25519PrivateKey,
          );
          return plain ? [r.id, plain] : null;
        } catch {
          return null;
        }
      }),
    );
    setDeviceLabels(
      new Map(entries.filter((e): e is [string, string] => e !== null)),
    );
  }

  async function handleRevokeDevice(targetDeviceId: string) {
    if (!userId || !umk) return;
    if (device?.deviceId === targetDeviceId) {
      setError(
        'Cannot revoke the device you\u2019re currently using from itself. Revoke it from another of your devices.',
      );
      return;
    }
    if (
      !confirm(
        'Revoke this device? It will immediately stop being able to read new room messages, and any session it holds will fail the sanity check on next app load and be signed out.',
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const revokedAtMs = Date.now();
      const signature = await signDeviceRevocation(
        { userId, deviceId: targetDeviceId, revokedAtMs },
        umk.ed25519PrivateKey,
      );
      await revokeDevice({
        deviceId: targetDeviceId,
        revokedAtMs,
        revocationSignature: signature,
      });
      // Cascade: rotate every room this user admins so the revoked
      // device is immediately excluded from new-gen wraps.
      // filterActiveDevices in the rotation helper skips revoked certs.
      if (device) {
        try {
          const result = await rotateAllRoomsIAdmin({ userId, device });
          if (result.failures.length > 0) {
            console.warn(
              `revoke cascade: ${result.rotated} room(s) rotated, ${result.failures.length} failed`,
              result.failures,
            );
          }
        } catch (err) {
          console.warn('revoke cascade failed:', errorMessage(err));
        }
      }
      await reloadDevices(userId);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  // NOTE: "Disable lock" was removed as part of enforcing PIN-lock as a
  // default. Users can change their passphrase but not revert to plaintext
  // keys. If future you needs to re-enable the escape hatch, bring back
  // clearWrappedIdentity + a button that warns about the downgrade.
  void clearWrappedIdentity;

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
      setError(errorMessage(e));
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

      <section className="space-y-2">
        <h2 className="text-sm font-medium uppercase tracking-wide text-neutral-500">
          Your safety number
        </h2>
        <p className="text-xs text-neutral-600 dark:text-neutral-400">
          Read this out to other members over a call or in person to confirm
          they see the same number. If the numbers don&apos;t match, someone
          is impersonating one of you.
        </p>
        <code className="block rounded bg-neutral-100 px-3 py-2 font-mono text-sm tracking-wide dark:bg-neutral-900">
          🔑 {myFingerprint ?? '(loading…)'}
        </code>
      </section>

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
          Your devices
        </h2>
        <p className="text-xs text-neutral-600 dark:text-neutral-400">
          Each device has its own keys. Revoking a device UMK-signs a
          revocation cert that every other client will enforce — revoked
          devices immediately fail the cert chain and can&apos;t decrypt new
          room messages. Only labels sealed to this device are readable
          here; others show as &ldquo;sealed.&rdquo;
        </p>
        {devices.length === 0 ? (
          <p className="text-sm text-neutral-500">(no devices yet)</p>
        ) : (
          <ul className="space-y-2">
            {devices.map((d) => {
              const isSelf = device?.deviceId === d.id;
              const revoked = d.revoked_at_ms != null;
              const label =
                deviceLabels.get(d.id) ??
                (d.display_name_ciphertext ? '(sealed)' : '(no label)');
              return (
                <li
                  key={d.id}
                  className="flex items-start justify-between gap-2 rounded border border-neutral-200 px-2 py-1 text-xs dark:border-neutral-800"
                >
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="flex items-baseline gap-2">
                      <span className="font-medium">{label}</span>
                      {isSelf && (
                        <span className="text-[10px] uppercase tracking-wide text-emerald-700 dark:text-emerald-400">
                          this device
                        </span>
                      )}
                      {revoked && (
                        <span className="text-[10px] uppercase tracking-wide text-red-700 dark:text-red-400">
                          revoked
                        </span>
                      )}
                    </span>
                    <code
                      className="font-mono text-[10px] text-neutral-500"
                      title={d.id}
                    >
                      {d.id.slice(0, 8)}
                    </code>
                    <span className="text-[10px] text-neutral-500">
                      added {new Date(d.created_at).toLocaleDateString()}
                    </span>
                  </div>
                  {!isSelf && !revoked && umk && (
                    <button
                      onClick={() => void handleRevokeDevice(d.id)}
                      disabled={busy}
                      className="shrink-0 rounded border border-red-300 px-2 py-0.5 text-[11px] text-red-700 disabled:opacity-50 dark:border-red-800 dark:text-red-400"
                    >
                      revoke
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {!umk && (
          <p className="text-[11px] text-neutral-500">
            Revoking requires the User Master Key. Open the app on your
            primary device (or enter your recovery phrase) to revoke from
            there.
          </p>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium uppercase tracking-wide text-neutral-500">
          Device passphrase lock
        </h2>
        <p className="text-xs text-neutral-600 dark:text-neutral-400">
          Your device keys are Argon2id-wrapped in IndexedDB and require this
          passphrase on each new session. Without it, a browser extension,
          disk forensics tool, or anyone with access to this browser profile
          could read your private keys.
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
                onClick={() => setShowPinSetup(true)}
                disabled={busy}
                className="rounded border border-neutral-300 px-3 py-1.5 text-xs dark:border-neutral-700"
              >
                change passphrase
              </button>
            </div>
          </div>
        ) : (
          <div className="rounded-md border border-amber-300 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950">
            <p className="text-xs text-amber-900 dark:text-amber-200">
              No passphrase lock set. A passphrase is required.
            </p>
            <button
              onClick={() => setShowPinSetup(true)}
              className="mt-2 rounded bg-neutral-900 px-3 py-1.5 text-xs text-white dark:bg-white dark:text-neutral-900"
            >
              Set passphrase now
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
          device={device}
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

