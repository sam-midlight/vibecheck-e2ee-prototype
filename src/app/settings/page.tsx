'use client';

/**
 * Settings — merged skin.
 *
 * Child's claymorphic card presentation + Notifications section; Parent's
 * full security surface is preserved intact:
 *   - PromoteDeviceModal for the SSK-only / no-keys → primary promotion
 *   - RecoveryPhraseModal in both set-up AND rotate modes (rotate passes
 *     the device bundle so the ghost-device picker can run)
 *   - Dev-mode toggle (advanced utility)
 *
 * Revoke flow is unchanged from both: sign revocation (v2 SSK preferred,
 * v1 UMK fallback) → revokeDevice RPC → tab-sync broadcast →
 * rotateAllRoomsIAdmin → cascadeRevocationIntoActiveCalls.
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AppShell } from '@/components/AppShell';
import { Loading } from '@/components/OrganicLoader';
import { PinSetupModal } from '@/components/PinSetupModal';
import { PromoteDeviceModal } from '@/components/PromoteDeviceModal';
import { PushSubscribeButton } from '@/components/PushSubscribeButton';
import { RecoveryPhraseModal } from '@/components/RecoveryPhraseModal';
import { TosModal, TOS_CURRENT_VERSION } from '@/components/TosModal';
import {
  cascadeRevocationIntoActiveCalls,
  loadEnrolledDevice,
  rotateAllRoomsIAdmin,
  type EnrolledDevice,
} from '@/lib/bootstrap';
import {
  clearDeviceBundle,
  clearSelfSigningKey,
  clearUserMasterKey,
  clearUserSigningKey,
  decryptDeviceDisplayName,
  fromBase64,
  getSelfSigningKey,
  getUserMasterKey,
  getUserSigningKey,
  hasWrappedIdentity,
  putWrappedIdentity,
  signDeviceRevocation,
  signDeviceRevocationV2,
  wrapDeviceStateWithPin,
  type SelfSigningKey,
  type UserMasterKey,
  type UserSigningKey,
} from '@/lib/e2ee-core';
import { describeError } from '@/lib/domain/errors';
import { getSupabase } from '@/lib/supabase/client';
import {
  hasRecoveryBlob,
  listDeviceRows,
  revokeDevice,
  type DeviceRow,
} from '@/lib/supabase/queries';
import { broadcastIdentityChange } from '@/lib/tab-sync';
import { useDevMode } from '@/lib/use-dev-mode';

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
  const [enrolled, setEnrolled] = useState<EnrolledDevice | null>(null);
  // enrolled.umk is the canonical UMK state, but we mirror it here so the
  // promote / rotate modals can bump it without us needing to re-run
  // loadEnrolledDevice on every close.
  const [umk, setUmk] = useState<UserMasterKey | null>(null);
  const [ssk, setSsk] = useState<SelfSigningKey | null>(null);
  const [usk, setUsk] = useState<UserSigningKey | null>(null);
  const [hasPhrase, setHasPhrase] = useState<boolean | null>(null);
  const [pinEnabled, setPinEnabled] = useState<boolean | null>(null);
  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [deviceLabels, setDeviceLabels] = useState<Map<string, string>>(
    () => new Map(),
  );
  const [showRecovery, setShowRecovery] = useState(false);
  const [rotatingPhrase, setRotatingPhrase] = useState(false);
  const [showPinSetup, setShowPinSetup] = useState(false);
  const [showPromote, setShowPromote] = useState(false);
  const [showRevoked, setShowRevoked] = useState(false);
  const [showTos, setShowTos] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [devMode, setDevMode] = useDevMode();

  useEffect(() => {
    (async () => {
      const supabase = getSupabase();
      const { data } = await supabase.auth.getUser();
      if (!data.user) return;
      setUserId(data.user.id);
      const dev = await loadEnrolledDevice(data.user.id);
      setEnrolled(dev);
      setUmk(dev?.umk ?? (await getUserMasterKey(data.user.id)));
      setSsk(await getSelfSigningKey(data.user.id));
      setUsk(await getUserSigningKey(data.user.id));
      setHasPhrase(await hasRecoveryBlob(data.user.id));
      setPinEnabled(await hasWrappedIdentity(data.user.id));
      if (dev) await reloadDevices(data.user.id, dev);
    })().catch((e) => setError(describeError(e)));
  }, []);

  async function reloadDevices(uid: string, dev: EnrolledDevice) {
    const rows = await listDeviceRows(uid);
    setDevices(rows);
    // Decrypt only the labels sealed to this device's pubkey. Others
    // appear as "(sealed)" — we don't have the priv to open them.
    const entries = await Promise.all(
      rows.map(async (r): Promise<[string, string] | null> => {
        if (!r.display_name_ciphertext) return null;
        try {
          const ct = await fromBase64(r.display_name_ciphertext);
          const plain = await decryptDeviceDisplayName(
            ct,
            dev.deviceBundle.x25519PublicKey,
            dev.deviceBundle.x25519PrivateKey,
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

  async function refreshKeyState(uid: string) {
    // Call after promote / rotate so the UI reflects the new key set.
    setUmk(await getUserMasterKey(uid));
    setSsk(await getSelfSigningKey(uid));
    setUsk(await getUserSigningKey(uid));
  }

  // Revoking requires SSK (preferred, cross-signing era) or UMK (pre-cross).
  const canRevoke = !!(ssk || umk);
  // Recovery-phrase rotation re-issues the UMK itself, so it needs UMK access.
  const canEditRecoveryPhrase = umk != null;

  async function handleRevokeDevice(targetDeviceId: string) {
    if (!userId || !enrolled || !canRevoke) return;
    if (enrolled.deviceBundle.deviceId === targetDeviceId) {
      setError(
        'Can\u2019t revoke the device you\u2019re currently using from itself. Revoke it from another of your devices.',
      );
      return;
    }
    if (
      !confirm(
        'Revoke this device? It will immediately stop being able to read new room messages, and any session it holds will fail the sanity check on next app load and be signed out.',
      )
    )
      return;
    setBusy(true);
    setError(null);
    try {
      const revokedAtMs = Date.now();
      const signature = ssk
        ? await signDeviceRevocationV2(
            { userId, deviceId: targetDeviceId, revokedAtMs },
            ssk.ed25519PrivateKey,
          )
        : await signDeviceRevocation(
            { userId, deviceId: targetDeviceId, revokedAtMs },
            umk!.ed25519PrivateKey,
          );
      await revokeDevice({
        deviceId: targetDeviceId,
        revokedAtMs,
        revocationSignature: signature,
      });
      // Sibling tabs of the revoked device need to drop to sign-in.
      broadcastIdentityChange('device-revoked', userId);
      // Cascade 1: rotate every room I admin so the revoked device is
      // excluded from new-gen wraps. filterActiveDevices in the rotation
      // helper skips revoked certs.
      try {
        const result = await rotateAllRoomsIAdmin({
          userId,
          device: enrolled.deviceBundle,
        });
        if (result.failures.length > 0) {
          console.warn(
            `revoke cascade (rooms): ${result.rotated} rotated, ${result.failures.length} failed`,
            result.failures,
          );
        }
      } catch (err) {
        console.warn('room revoke cascade failed:', describeError(err));
      }
      // Cascade 2: rotate every active call this device participates in
      // so the revoked device can't decrypt post-revoke frames.
      try {
        const callResult = await cascadeRevocationIntoActiveCalls({
          userId,
          revokedDeviceId: targetDeviceId,
          device: enrolled.deviceBundle,
        });
        if (callResult.failures.length > 0) {
          console.warn(
            `revoke cascade (calls): ${callResult.rotated} rotated, ${callResult.failures.length} failed`,
            callResult.failures,
          );
        }
      } catch (err) {
        console.warn('call revoke cascade failed:', describeError(err));
      }
      await reloadDevices(userId, enrolled);
    } catch (e) {
      setError(describeError(e));
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
    )
      return;
    setBusy(true);
    setError(null);
    try {
      await clearDeviceBundle(userId);
      await clearUserMasterKey(userId);
      await clearSelfSigningKey(userId);
      await clearUserSigningKey(userId);
      router.replace('/auth/callback');
    } catch (e) {
      setError(describeError(e));
      setBusy(false);
    }
  }

  if (!userId || !enrolled) {
    return <Loading />;
  }

  const skipped =
    typeof window !== 'undefined' &&
    localStorage.getItem(`recovery_skipped_${userId}`) === '1';

  return (
    <div className="max-w-xl space-y-8">
      <h1 className="font-display italic text-2xl tracking-tight">Settings</h1>

      {/* Notifications -------------------------------------------------- */}
      <section className="space-y-3 rounded-2xl border border-white/60 bg-white/75 p-5 shadow-lg backdrop-blur-md dark:border-white/10 dark:bg-neutral-900/70">
        <h2 className="text-[11px] font-medium uppercase tracking-[0.18em] text-neutral-700 dark:text-neutral-300">
          Notifications
        </h2>
        <p className="text-sm leading-relaxed text-neutral-700 dark:text-neutral-300">
          Get a gentle ping when something new lands in your room — a
          message, a heart, a matched date. The push payload is generic
          (&ldquo;💫 something new&rdquo;); never any content.
        </p>
        <PushSubscribeButton />
      </section>

      {/* Recovery phrase ----------------------------------------------- */}
      <section className="space-y-3 rounded-2xl border border-white/60 bg-white/75 p-5 shadow-lg backdrop-blur-md dark:border-white/10 dark:bg-neutral-900/70">
        <h2 className="text-[11px] font-medium uppercase tracking-[0.18em] text-neutral-700 dark:text-neutral-300">
          Recovery phrase
        </h2>
        {hasPhrase === null ? (
          <p className="text-sm text-neutral-600 dark:text-neutral-300">checking…</p>
        ) : !canEditRecoveryPhrase ? (
          // This device doesn't hold the UMK — either SSK-only (approved
          // from a primary that didn't share MSK) or no keys at all.
          // Promote-with-phrase is the path back to full primary.
          <div className="space-y-2">
            {ssk ? (
              <p className="text-xs text-neutral-700 dark:text-neutral-300">
                This device holds the Self-Signing Key (can approve devices
                and revoke), but not the Master Signing Key. To rotate the
                recovery phrase or the MSK itself, enter your 24-word phrase
                to promote to full primary.
              </p>
            ) : (
              <p className="text-xs text-neutral-700 dark:text-neutral-300">
                This device doesn&apos;t hold any signing keys — it was
                linked from a pre-cross-signing primary that didn&apos;t
                share them. Approve this device again from a co-primary,
                or enter your recovery phrase below.
              </p>
            )}
            {hasPhrase ? (
              <button
                onClick={() => setShowPromote(true)}
                disabled={busy}
                className="mt-1 rounded-full bg-gradient-to-br from-amber-200 via-amber-300 to-amber-400 px-5 py-2 font-display italic text-sm text-amber-950 shadow-[0_8px_20px_-4px_rgba(217,119,6,0.5),inset_0_2px_3px_rgba(255,255,255,0.55),inset_0_-3px_6px_rgba(146,64,14,0.25)] ring-1 ring-amber-200/60 transition-all hover:scale-[1.04] active:scale-[1.06] disabled:opacity-50"
              >
                Promote with recovery phrase
              </button>
            ) : (
              <p className="text-xs italic text-neutral-600 dark:text-neutral-400">
                No recovery phrase is set up either. Open the app on your
                primary device to set one up from there.
              </p>
            )}
          </div>
        ) : hasPhrase ? (
          <div className="space-y-2">
            <p className="text-sm text-emerald-800 dark:text-emerald-300">
              A recovery phrase is set up for this account.
            </p>
            <p className="text-xs text-neutral-700 dark:text-neutral-300">
              Rotating generates a fresh master key, re-signs every device&apos;s
              cert under the new key, and wraps the new key with a new 24-word
              phrase. The old phrase stops working immediately.
            </p>
            <button
              onClick={() => {
                setRotatingPhrase(true);
                setShowRecovery(true);
              }}
              disabled={busy}
              className="mt-1 rounded-full bg-gradient-to-br from-amber-200 via-amber-300 to-amber-400 px-5 py-2 font-display italic text-sm text-amber-950 shadow-[0_8px_20px_-4px_rgba(217,119,6,0.5),inset_0_2px_3px_rgba(255,255,255,0.55),inset_0_-3px_6px_rgba(146,64,14,0.25)] ring-1 ring-amber-200/60 transition-all hover:scale-[1.04] active:scale-[1.06] disabled:opacity-50"
            >
              Rotate phrase
            </button>
          </div>
        ) : (
          <div className="rounded-2xl border border-amber-300/60 bg-amber-50/85 p-5 shadow-sm backdrop-blur-md dark:border-amber-700/50 dark:bg-amber-950/70">
            <p className="text-sm leading-relaxed text-amber-950 dark:text-amber-100">
              {skipped
                ? 'You skipped setting up a recovery phrase.'
                : 'You don\u2019t have a recovery phrase yet.'}{' '}
              If you lose every signed-in device, your account and its data
              become unrecoverable.
            </p>
            <button
              onClick={() => {
                setRotatingPhrase(false);
                setShowRecovery(true);
              }}
              disabled={busy}
              className="mt-3 rounded-full bg-gradient-to-br from-amber-200 via-amber-300 to-amber-400 px-5 py-2 font-display italic text-sm text-amber-950 shadow-[0_8px_20px_-4px_rgba(217,119,6,0.5),inset_0_2px_3px_rgba(255,255,255,0.55),inset_0_-3px_6px_rgba(146,64,14,0.25)] ring-1 ring-amber-200/60 transition-all hover:scale-[1.04] active:scale-[1.06] disabled:opacity-50"
            >
              Set up recovery phrase
            </button>
          </div>
        )}
      </section>

      {/* Your devices -------------------------------------------------- */}
      <section className="space-y-3 rounded-2xl border border-white/60 bg-white/75 p-5 shadow-lg backdrop-blur-md dark:border-white/10 dark:bg-neutral-900/70">
        <h2 className="text-[11px] font-medium uppercase tracking-[0.18em] text-neutral-700 dark:text-neutral-300">
          Your devices
        </h2>
        <p className="text-xs leading-relaxed text-neutral-700 dark:text-neutral-300">
          Each device has its own keys. Revoking signs a revocation cert
          that every other client enforces — revoked devices stop being
          able to decrypt new room messages. Only labels sealed to this
          device are readable here; others show as &ldquo;sealed.&rdquo;
        </p>
        {devices.length === 0 ? (
          <p className="text-sm text-neutral-600 dark:text-neutral-300">(no devices yet)</p>
        ) : (
          <ul className="space-y-2">
            {devices
              .filter((d) => showRevoked || d.revoked_at_ms == null)
              .map((d) => {
                const isSelf = enrolled.deviceBundle.deviceId === d.id;
                const revoked = d.revoked_at_ms != null;
                const label =
                  deviceLabels.get(d.id) ??
                  (d.display_name_ciphertext ? '(sealed)' : '(no label)');
                return (
                  <li
                    key={d.id}
                    className="flex items-start justify-between gap-2 rounded-xl border border-white/60 bg-white/70 px-3 py-2 text-xs shadow-sm backdrop-blur-md dark:border-white/10 dark:bg-neutral-900/60"
                  >
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <span className="flex flex-wrap items-baseline gap-2">
                        <span className="font-display italic text-sm text-neutral-900 dark:text-neutral-50">
                          {label}
                        </span>
                        {isSelf && (
                          <span className="text-[10px] uppercase tracking-[0.12em] text-emerald-700 dark:text-emerald-400">
                            this device
                          </span>
                        )}
                        {revoked && (
                          <span className="text-[10px] uppercase tracking-[0.12em] text-red-700 dark:text-red-400">
                            revoked
                          </span>
                        )}
                      </span>
                      <code
                        className="font-mono text-[10px] text-neutral-600 dark:text-neutral-400"
                        title={d.id}
                      >
                        {d.id.slice(0, 8)}
                      </code>
                      <span className="text-[10px] text-neutral-600 dark:text-neutral-400">
                        added {new Date(d.created_at).toLocaleDateString()}
                      </span>
                    </div>
                    {!isSelf && !revoked && canRevoke && (
                      <button
                        onClick={() => void handleRevokeDevice(d.id)}
                        disabled={busy}
                        className="shrink-0 rounded-full border border-red-300 bg-white/80 px-3 py-1 text-[11px] font-display italic text-red-700 transition-all hover:scale-[1.04] hover:bg-white active:scale-[1.02] disabled:opacity-50 dark:border-red-800/60 dark:bg-neutral-900/60 dark:text-red-300"
                      >
                        revoke
                      </button>
                    )}
                  </li>
                );
              })}
          </ul>
        )}
        {devices.some((d) => d.revoked_at_ms != null) && (
          <button
            onClick={() => setShowRevoked((v) => !v)}
            className="text-[11px] text-neutral-600 underline underline-offset-2 transition-colors hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100"
          >
            {showRevoked
              ? 'hide revoked devices'
              : `show ${devices.filter((d) => d.revoked_at_ms != null).length} revoked device(s)`}
          </button>
        )}
        {!canRevoke && (
          <p className="text-[11px] italic text-neutral-600 dark:text-neutral-400">
            Revoking requires the Self-Signing Key. Approve this device from a co-primary, or enter your recovery phrase to promote it.
          </p>
        )}
      </section>

      {/* Device passphrase lock ---------------------------------------- */}
      <section className="space-y-3 rounded-2xl border border-white/60 bg-white/75 p-5 shadow-lg backdrop-blur-md dark:border-white/10 dark:bg-neutral-900/70">
        <h2 className="text-[11px] font-medium uppercase tracking-[0.18em] text-neutral-700 dark:text-neutral-300">
          Device passphrase lock
        </h2>
        <p className="text-xs leading-relaxed text-neutral-700 dark:text-neutral-300">
          Your device keys are Argon2id-wrapped in IndexedDB and require
          this passphrase on each new session. Without it, a browser
          extension, disk forensics tool, or anyone with access to this
          browser profile could read your private keys.
        </p>
        {pinEnabled === null ? (
          <p className="text-sm text-neutral-600 dark:text-neutral-300">checking…</p>
        ) : pinEnabled ? (
          <div className="space-y-2">
            <p className="text-sm text-emerald-800 dark:text-emerald-300">
              Passphrase lock is enabled on this device.
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => void handleLockNow()}
                disabled={busy}
                className="rounded-full border border-neutral-300 bg-white/80 px-4 py-1.5 font-display italic text-xs text-neutral-800 transition-all hover:scale-[1.04] hover:bg-white active:scale-[1.02] disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-900/60 dark:text-neutral-200"
              >
                Lock now
              </button>
              <button
                onClick={() => setShowPinSetup(true)}
                disabled={busy}
                className="rounded-full border border-neutral-300 bg-white/80 px-4 py-1.5 font-display italic text-xs text-neutral-800 transition-all hover:scale-[1.04] hover:bg-white active:scale-[1.02] disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-900/60 dark:text-neutral-200"
              >
                Change passphrase
              </button>
            </div>
          </div>
        ) : (
          <div className="rounded-2xl border border-amber-300/60 bg-amber-50/85 p-4 shadow-sm backdrop-blur-md dark:border-amber-700/50 dark:bg-amber-950/70">
            <p className="text-sm leading-relaxed text-amber-950 dark:text-amber-100">
              No passphrase lock set on this device. Setting one wraps your
              local keys at rest.
            </p>
            <button
              onClick={() => setShowPinSetup(true)}
              className="mt-3 rounded-full bg-gradient-to-br from-amber-200 via-amber-300 to-amber-400 px-5 py-2 font-display italic text-sm text-amber-950 shadow-[0_8px_20px_-4px_rgba(217,119,6,0.5),inset_0_2px_3px_rgba(255,255,255,0.55),inset_0_-3px_6px_rgba(146,64,14,0.25)] ring-1 ring-amber-200/60 transition-all hover:scale-[1.04] active:scale-[1.06]"
            >
              Set passphrase now
            </button>
          </div>
        )}
      </section>

      {/* Legal --------------------------------------------------------- */}
      <section className="space-y-3 rounded-2xl border border-white/60 bg-white/75 p-5 shadow-lg backdrop-blur-md dark:border-white/10 dark:bg-neutral-900/70">
        <h2 className="text-[11px] font-medium uppercase tracking-[0.18em] text-neutral-700 dark:text-neutral-300">
          Legal
        </h2>
        <p className="text-xs leading-relaxed text-neutral-700 dark:text-neutral-300">
          Read the current Terms of Service. You accepted version{' '}
          <code className="rounded bg-white/70 px-1.5 py-0.5 font-mono text-[10px] text-neutral-700 dark:bg-neutral-800/70 dark:text-neutral-200">
            {TOS_CURRENT_VERSION}
          </code>{' '}
          when you joined.
        </p>
        <button
          onClick={() => setShowTos(true)}
          className="rounded-full border border-neutral-300 bg-white/80 px-4 py-1.5 font-display italic text-xs text-neutral-800 transition-all hover:scale-[1.04] hover:bg-white active:scale-[1.02] dark:border-neutral-700 dark:bg-neutral-900/60 dark:text-neutral-200"
        >
          Review Terms of Service
        </button>
      </section>

      {/* Advanced ------------------------------------------------------ */}
      <section className="space-y-3 rounded-2xl border border-white/60 bg-white/75 p-5 shadow-lg backdrop-blur-md dark:border-white/10 dark:bg-neutral-900/70">
        <h2 className="text-[11px] font-medium uppercase tracking-[0.18em] text-neutral-700 dark:text-neutral-300">
          Advanced
        </h2>
        <label className="flex cursor-pointer items-start gap-3 text-sm">
          <input
            type="checkbox"
            checked={devMode}
            onChange={(e) => setDevMode(e.target.checked)}
            className="mt-1"
          />
          <span className="text-neutral-700 dark:text-neutral-300">
            <span className="font-medium">Developer mode</span>
            <span className="mt-0.5 block text-xs text-neutral-600 dark:text-neutral-400">
              Exposes the /status diagnostic dashboard and extra per-message
              metadata. Safe to toggle; purely UI-side.
            </span>
          </span>
        </label>
      </section>

      {error && (
        <p className="rounded-2xl border border-red-300/60 bg-red-50/80 p-3 text-sm text-red-800 shadow-sm backdrop-blur-md dark:border-red-800/40 dark:bg-red-950/50 dark:text-red-200">
          Error: {error}
        </p>
      )}

      <p className="pt-2 text-center font-mono text-[10px] text-neutral-500 dark:text-neutral-500">
        {process.env.NEXT_PUBLIC_BUILD_TIME} (UTC+10)  {process.env.NEXT_PUBLIC_GIT_SHA}
      </p>

      {/* Modals -------------------------------------------------------- */}
      {showRecovery && umk && (
        <RecoveryPhraseModal
          userId={userId}
          umk={umk}
          device={enrolled.deviceBundle}
          hideSkip
          rotate={rotatingPhrase}
          onDone={async (result) => {
            setShowRecovery(false);
            const wasRotating = rotatingPhrase;
            setRotatingPhrase(false);
            if (result === 'saved') {
              try {
                setHasPhrase(true);
                if (wasRotating) await refreshKeyState(userId);
                if (typeof window !== 'undefined') {
                  localStorage.removeItem(`recovery_skipped_${userId}`);
                }
              } catch (e) {
                setError(describeError(e));
              }
            }
          }}
        />
      )}

      {showPinSetup && (
        <PinSetupModal
          onCancel={() => setShowPinSetup(false)}
          heading={pinEnabled ? 'Change device passphrase' : 'Set a device passphrase'}
          onSave={async (passphrase) => {
            const blob = await wrapDeviceStateWithPin(
              enrolled.deviceBundle,
              umk,
              passphrase,
              userId,
              { ssk, usk },
            );
            await putWrappedIdentity(userId, blob);
            setPinEnabled(true);
            setShowPinSetup(false);
          }}
        />
      )}

      {showPromote && (
        <PromoteDeviceModal
          userId={userId}
          pinEnabled={pinEnabled ?? false}
          onDone={async (result) => {
            setShowPromote(false);
            if (result === 'promoted') {
              try {
                await refreshKeyState(userId);
              } catch (e) {
                setError(describeError(e));
              }
            }
          }}
        />
      )}

      {showTos && userId && (
        <TosModal userId={userId} readOnly onClose={() => setShowTos(false)} />
      )}
    </div>
  );
}
