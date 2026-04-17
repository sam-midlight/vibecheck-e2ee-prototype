'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { RecoveryPhraseModal } from '@/components/RecoveryPhraseModal';
import { RecoveryPhraseEntry } from '@/components/RecoveryPhraseEntry';
import { getSupabase } from '@/lib/supabase/client';
import {
  bytesEqual,
  clearDeviceBundle,
  clearUserMasterKey,
  clearWrappedIdentity,
  encryptDeviceDisplayName,
  fromBase64,
  generateApprovalCode,
  generateApprovalSalt,
  generateDeviceKeyBundle,
  getWrappedIdentity,
  hasWrappedIdentity,
  hashApprovalCode,
  putDeviceBundle,
  putDeviceRecord,
  putWrappedIdentity,
  signDeviceIssuance,
  unwrapDeviceStateWithPin,
  verifyDeviceIssuance,
  wrapDeviceStateWithPin,
  type DeviceKeyBundle,
} from '@/lib/e2ee-core';
import {
  bootstrapNewUser,
  inferDeviceName,
  loadEnrolledDevice,
  type EnrolledDevice,
} from '@/lib/bootstrap';
import { PinSetupModal } from '@/components/PinSetupModal';
import { errorMessage } from '@/lib/errors';
import {
  createApprovalRequest,
  deleteApprovalRequest,
  fetchPublicDevices,
  fetchUserMasterKeyPub,
  hasRecoveryBlob,
  nukeIdentityServer,
  setDeviceDisplayNameCiphertext,
} from '@/lib/supabase/queries';

type Step =
  | 'exchanging-code'
  | 'checking-identity'
  | 'generating-identity'
  | 'publishing-identity'
  | 'registering-device'
  | 'offer-recovery-setup'
  | 'require-pin-setup'
  | 'device-linking-chooser'
  | 'awaiting-approval'
  | 'entering-recovery'
  | 'unlock-passphrase'
  | 'confirm-nuclear'
  | 'nuking'
  | 'done'
  | 'error';

/**
 * Verify that a local device state (from plaintext IDB or from an unlock) still
 * chains to the user's currently-published UMK. Returns:
 *
 *   - 'ok'            — cert chain valid; safe to proceed.
 *   - 'orphan'        — this device is definitively dead: UMK was rotated
 *                       elsewhere, device row was revoked, or the cert no
 *                       longer verifies. Caller MUST wipe local state and
 *                       route to recovery.
 *   - 'indeterminate' — could not establish a verdict (no published UMK row
 *                       when we expected one). Caller should surface an error
 *                       rather than wipe.
 *
 * Network errors propagate — let the outer run()'s catch send the user to the
 * `error` step rather than silently mis-classifying a flake as orphan.
 */
async function verifyLocalChainOrMarkOrphan(
  uid: string,
  local: EnrolledDevice,
): Promise<'ok' | 'orphan' | 'indeterminate'> {
  const publishedUmk = await fetchUserMasterKeyPub(uid);
  if (!publishedUmk) return 'indeterminate';
  const umkPubsMatch =
    local.umk == null ||
    (await bytesEqual(
      local.umk.ed25519PublicKey,
      publishedUmk.ed25519PublicKey,
    ));
  if (!umkPubsMatch) return 'orphan';
  // Verify SSK cross-sig if present for v2 cert dispatch.
  let sskPub: Uint8Array | undefined;
  if (publishedUmk.sskPub && publishedUmk.sskCrossSignature) {
    try {
      const { verifySskCrossSignature } = await import('@/lib/e2ee-core');
      await verifySskCrossSignature(publishedUmk.ed25519PublicKey, publishedUmk.sskPub, publishedUmk.sskCrossSignature);
      sskPub = publishedUmk.sskPub;
    } catch { /* fall back to MSK-only */ }
  }
  const devices = await fetchPublicDevices(uid);
  const myDevice = devices.find(
    (d) => d.deviceId === local.deviceBundle.deviceId,
  );
  if (!myDevice) return 'orphan';
  try {
    await verifyDeviceIssuance(
      {
        userId: uid,
        deviceId: myDevice.deviceId,
        deviceEd25519PublicKey: myDevice.ed25519PublicKey,
        deviceX25519PublicKey: myDevice.x25519PublicKey,
        createdAtMs: myDevice.createdAtMs,
      },
      myDevice.issuanceSignature,
      publishedUmk.ed25519PublicKey,
      sskPub,
    );
  } catch {
    return 'orphan';
  }
  return 'ok';
}

export default function AuthCallbackPage() {
  const router = useRouter();
  const [step, setStep] = useState<Step>('exchanging-code');
  const [error, setError] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [enrolled, setEnrolled] = useState<EnrolledDevice | null>(null);
  const [recoveryBlobExists, setRecoveryBlobExists] = useState(false);
  /** Navigation target once the mandatory PIN setup finishes. */
  const [pendingDest, setPendingDest] = useState<'/rooms' | '/status'>('/rooms');

  const ranRef = useRef(false);

  /**
   * Gate for the final "navigate into the app" moment. If a wrapped
   * identity doesn't exist for this user on this device, the user must
   * set a passphrase before proceeding (enforced default — Point 19).
   */
  async function proceedOrRequirePin(uid: string, dest: '/rooms' | '/status') {
    const wrapped = await hasWrappedIdentity(uid);
    if (!wrapped) {
      setPendingDest(dest);
      setStep('require-pin-setup');
      return;
    }
    setStep('done');
    router.replace(dest);
  }

  /**
   * Definitive orphan — wipe all three local artefacts (plaintext bundle,
   * plaintext UMK, AND the wrapped blob) and route to recovery. We clear the
   * wrapped blob here because its contents are stale (the UMK priv inside is
   * either the pre-rotation one or the cert it signs is revoked); leaving it
   * would just re-prompt for a passphrase on next sign-in that would re-detect
   * the orphan state and loop.
   *
   * NOT used by the "I forgot my passphrase" escape hatch — the blob might
   * still be valid there and the user may remember the passphrase later.
   */
  async function routeToOrphanRecovery(uid: string) {
    await clearDeviceBundle(uid);
    await clearUserMasterKey(uid);
    await clearWrappedIdentity(uid);
    const hasPhrase = await hasRecoveryBlob(uid);
    setRecoveryBlobExists(hasPhrase);
    setStep(hasPhrase ? 'entering-recovery' : 'device-linking-chooser');
  }

  useEffect(() => {
    if (ranRef.current) return;
    ranRef.current = true;
    let cancelled = false;

    async function run() {
      const supabase = getSupabase();
      await supabase.auth.getSession();
      if (cancelled) return;
      setStep('checking-identity');

      const { data: userData, error: userErr } = await supabase.auth.getUser();
      if (userErr || !userData.user) {
        // No active session — can't continue with the callback flow.
        // Common on mobile when the magic link is opened in a different
        // browser context than the one that requested it, or when the
        // URL-hash token fails to parse. Send the user back to the landing
        // page so they can try again cleanly, rather than dead-ending on
        // a cryptic "Auth session missing!" error screen.
        console.warn('auth callback: no session, routing to /', userErr?.message);
        router.replace('/');
        return;
      }
      const uid = userData.user.id;
      setUserId(uid);

      const publishedUmk = await fetchUserMasterKeyPub(uid);
      const local = await loadEnrolledDevice(uid);

      // Passphrase lock: if wrapped blob exists and plaintext is absent,
      // the user has locked the device and must unlock before proceeding.
      if (!local && (await hasWrappedIdentity(uid))) {
        if (!cancelled) setStep('unlock-passphrase');
        return;
      }

      if (publishedUmk && local) {
        const verdict = await verifyLocalChainOrMarkOrphan(uid, local);
        if (cancelled) return;
        if (verdict === 'orphan') {
          console.warn('local device no longer chains to published UMK — orphan; wiping');
          await routeToOrphanRecovery(uid);
          return;
        }
        if (verdict === 'indeterminate') {
          // Shouldn't happen here — we're inside `publishedUmk && local` —
          // but be defensive rather than silently proceed.
          setError('could not verify this device against the server');
          setStep('error');
          return;
        }
        setEnrolled(local);
        await proceedOrRequirePin(uid, '/rooms');
        return;
      }

      if (publishedUmk && !local) {
        const hasPhrase = await hasRecoveryBlob(uid);
        if (!cancelled) {
          setRecoveryBlobExists(hasPhrase);
          setStep('device-linking-chooser');
        }
        return;
      }

      // No identity on server → first-ever device.
      if (!cancelled) setStep('generating-identity');
      const fresh = await bootstrapNewUser(uid);
      if (!cancelled) {
        setEnrolled(fresh);
        setStep('offer-recovery-setup');
      }
    }

    run().catch((e) => {
      console.error(e);
      if (!cancelled) {
        setError(errorMessage(e));
        setStep('error');
      }
    });

    return () => {
      cancelled = true;
    };
    // proceedOrRequirePin is defined in this component; including it would
    // trip the exhaustive-deps rule without adding meaningful tracking
    // (the ref-like ranRef already gates this effect to a single run).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router]);

  const handleRecoveryDone = useCallback(
    async (result: 'saved' | 'skipped') => {
      if (result === 'skipped' && userId) {
        localStorage.setItem(`recovery_skipped_${userId}`, '1');
      }
      if (userId) await proceedOrRequirePin(userId, '/status');
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [userId],
  );

  const handleRecovered = useCallback(
    async (recovered: EnrolledDevice) => {
      setEnrolled(recovered);
      if (!userId) return;
      // The device state we just installed is brand new (from recovery phrase
      // or device approval). Any pre-existing wrapped blob belongs to the old,
      // now-abandoned identity — stale device priv / stale UMK priv. Clear it
      // so proceedOrRequirePin forces a fresh passphrase setup rather than
      // skipping the gate because a stale blob happens to exist.
      await clearWrappedIdentity(userId);
      await proceedOrRequirePin(userId, '/rooms');
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [userId],
  );

  /**
   * Unlock path — unlike recovery/approval (which install fresh state that is
   * by construction valid), a wrapped blob may be stale: the user could have
   * rotated UMK or been revoked from another device while this one was idle.
   * We MUST chain-check before navigating, otherwise AppShell catches the
   * stale cert post-nav, signs the user out, and the next magic-link sign-in
   * routes straight back to this unlock screen — an infinite loop.
   */
  const handleUnlocked = useCallback(
    async (recovered: EnrolledDevice) => {
      setEnrolled(recovered);
      if (!userId) return;
      const verdict = await verifyLocalChainOrMarkOrphan(userId, recovered);
      if (verdict === 'orphan') {
        console.warn('unlocked device is orphan (stale UMK or revoked) — routing to recovery');
        await routeToOrphanRecovery(userId);
        return;
      }
      if (verdict === 'indeterminate') {
        setError('could not verify this device against the server — please refresh and try again');
        setStep('error');
        return;
      }
      await proceedOrRequirePin(userId, '/rooms');
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [userId],
  );

  /**
   * "I forgot my passphrase" — functionally equivalent to orphan recovery
   * from the user's point of view, but we do NOT delete the wrapped blob:
   * the blob may still hold valid keys (it's just the user's memory that's
   * failed), and the user might remember the passphrase later. If they
   * complete recovery here, the subsequent PIN-setup re-wraps fresh state
   * and overwrites the blob anyway.
   */
  const handleForgotPassphrase = useCallback(async () => {
    if (!userId) return;
    const hasPhrase = await hasRecoveryBlob(userId);
    setRecoveryBlobExists(hasPhrase);
    setStep('device-linking-chooser');
  }, [userId]);

  const handleNuclearConfirmed = useCallback(async () => {
    if (!userId) return;
    setStep('nuking');
    setError(null);
    try {
      await clearDeviceBundle(userId);
      await clearUserMasterKey(userId);
      // Nuclear means the wrapped blob's contents are useless too — clearing
      // it here prevents `proceedOrRequirePin` (post-recovery-setup) from
      // finding a stale blob and skipping the mandatory PIN prompt for the
      // brand-new identity.
      await clearWrappedIdentity(userId);
      await nukeIdentityServer(userId);
      const fresh = await bootstrapNewUser(userId);
      localStorage.removeItem(`recovery_skipped_${userId}`);
      setEnrolled(fresh);
      setStep('offer-recovery-setup');
    } catch (e) {
      setError(errorMessage(e));
      setStep('error');
    }
  }, [userId]);

  return (
    <main className="mx-auto max-w-xl p-8">
      <h1 className="text-xl font-semibold">Signing you in…</h1>
      <ul className="mt-4 space-y-1 text-sm">
        <StepLine active={step === 'exchanging-code'} done={after('exchanging-code', step)}>
          Exchanging sign-in code
        </StepLine>
        <StepLine active={step === 'checking-identity'} done={after('checking-identity', step)}>
          Checking identity
        </StepLine>
        <StepLine
          active={step === 'generating-identity'}
          done={after('generating-identity', step)}
        >
          Generating UMK + device keys
        </StepLine>
        <StepLine
          active={step === 'publishing-identity'}
          done={after('publishing-identity', step)}
        >
          Publishing UMK pub
        </StepLine>
        <StepLine active={step === 'registering-device'} done={after('registering-device', step)}>
          Registering this device + issuing cert
        </StepLine>
      </ul>

      {step === 'offer-recovery-setup' && userId && enrolled?.umk && (
        <RecoveryPhraseModal
          userId={userId}
          umk={enrolled.umk}
          onDone={handleRecoveryDone}
        />
      )}

      {step === 'device-linking-chooser' && userId && (
        <LinkingChooser
          userId={userId}
          recoveryBlobExists={recoveryBlobExists}
          onChooseApproval={() => setStep('awaiting-approval')}
          onChooseRecovery={() => setStep('entering-recovery')}
          onChooseNuclear={() => setStep('confirm-nuclear')}
        />
      )}

      {step === 'confirm-nuclear' && userId && (
        <NuclearConfirm
          onConfirm={() => void handleNuclearConfirmed()}
          onBack={() => setStep('device-linking-chooser')}
        />
      )}

      {step === 'nuking' && (
        <div className="mt-6 rounded-md border border-red-300 bg-red-50 p-4 text-sm dark:border-red-800 dark:bg-red-950">
          <p className="font-medium">Resetting your identity…</p>
          <p className="mt-1 text-xs text-neutral-600 dark:text-neutral-400">
            Leaving rooms, revoking devices, generating new keys.
          </p>
        </div>
      )}

      {step === 'awaiting-approval' && userId && (
        <AwaitingApproval
          userId={userId}
          onInstalled={handleRecovered}
          onBack={() => setStep('device-linking-chooser')}
          onError={(msg) => {
            setError(msg);
            setStep('error');
          }}
        />
      )}

      {step === 'entering-recovery' && userId && (
        <RecoveryPhraseEntry
          userId={userId}
          onRecovered={handleRecovered}
          onBack={() => setStep('device-linking-chooser')}
        />
      )}

      {step === 'unlock-passphrase' && userId && (
        <UnlockPassphrase
          userId={userId}
          onUnlocked={handleUnlocked}
          onForgot={handleForgotPassphrase}
          onError={(msg) => {
            setError(msg);
            setStep('error');
          }}
        />
      )}

      {step === 'require-pin-setup' && userId && enrolled && (
        <PinSetupModal
          mandatory
          heading="Set a passphrase to protect this device"
          blurb="A passphrase is required. Without it, your identity keys would sit in this browser's IndexedDB as plaintext and be readable by browser extensions, disk forensics, or anyone else using this profile. Pick something you'll remember — if you forget it, recovery requires your 24-word phrase."
          onSave={async (passphrase) => {
            const { getSelfSigningKey, getUserSigningKey } = await import('@/lib/e2ee-core');
            const localSsk = await getSelfSigningKey(userId);
            const localUsk = await getUserSigningKey(userId);
            const blob = await wrapDeviceStateWithPin(
              enrolled.deviceBundle,
              enrolled.umk,
              passphrase,
              userId,
              { ssk: localSsk, usk: localUsk },
            );
            await putWrappedIdentity(userId, blob);
            setStep('done');
            router.replace(pendingDest);
          }}
        />
      )}

      {step === 'error' && (
        <p className="mt-4 text-sm text-red-600 dark:text-red-400">Error: {error}</p>
      )}
    </main>
  );
}

function UnlockPassphrase({
  userId,
  onUnlocked,
  onForgot,
  onError,
}: {
  userId: string;
  onUnlocked: (enrolled: EnrolledDevice) => void;
  onForgot: () => void;
  onError: (msg: string) => void;
}) {
  const [passphrase, setPassphrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const blob = await getWrappedIdentity(userId);
      if (!blob) {
        onError('no wrapped identity on this device');
        return;
      }
      const state = await unwrapDeviceStateWithPin(blob, passphrase, userId);
      // Re-stash plaintext for the session so downstream callers work.
      await putDeviceBundle(userId, state.deviceBundle);
      if (state.umk) {
        const { putUserMasterKey } = await import('@/lib/e2ee-core');
        await putUserMasterKey(userId, state.umk);
      }
      if (state.ssk) {
        const { putSelfSigningKey } = await import('@/lib/e2ee-core');
        await putSelfSigningKey(userId, state.ssk);
      }
      if (state.usk) {
        const { putUserSigningKey } = await import('@/lib/e2ee-core');
        await putUserSigningKey(userId, state.usk);
      }
      onUnlocked({ userId, deviceBundle: state.deviceBundle, umk: state.umk });
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      className="mt-6 space-y-3 rounded-md border border-neutral-300 bg-white p-4 text-sm dark:border-neutral-700 dark:bg-neutral-900"
    >
      <h2 className="text-base font-semibold">Unlock this device</h2>
      <p className="text-xs text-neutral-600 dark:text-neutral-400">
        This device is protected by a passphrase. Enter it to decrypt your
        identity for this session.
      </p>
      <input
        type="password"
        autoFocus
        value={passphrase}
        onChange={(e) => setPassphrase(e.target.value)}
        className="block w-full rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900"
      />
      {err && <p className="text-xs text-red-600">{err}</p>}
      <div className="flex items-center justify-between gap-3 pt-1">
        <button
          type="submit"
          disabled={busy}
          className="rounded bg-neutral-900 px-3 py-1.5 text-xs text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
        >
          {busy ? 'unlocking…' : 'unlock'}
        </button>
        <button
          type="button"
          onClick={onForgot}
          disabled={busy}
          className="text-xs text-neutral-500 underline underline-offset-2 hover:text-neutral-800 disabled:opacity-50 dark:text-neutral-400 dark:hover:text-neutral-200"
        >
          Forgot your passphrase?
        </button>
      </div>
      <p className="pt-1 text-[11px] text-neutral-500">
        If you&apos;ve forgotten it, you can recover using another signed-in
        device, your 24-word recovery phrase, or reset your identity.
      </p>
    </form>
  );
}

function LinkingChooser({
  recoveryBlobExists,
  onChooseApproval,
  onChooseRecovery,
  onChooseNuclear,
}: {
  userId: string;
  recoveryBlobExists: boolean;
  onChooseApproval: () => void;
  onChooseRecovery: () => void;
  onChooseNuclear: () => void;
}) {
  return (
    <div className="mt-6 space-y-4 rounded-md border border-amber-300 bg-amber-50 p-4 text-sm dark:border-amber-800 dark:bg-amber-950">
      <p>
        <strong>This device doesn&apos;t have your encryption keys yet.</strong>
      </p>
      <div className="space-y-3">
        <div className="rounded border border-neutral-300 bg-white p-3 dark:border-neutral-700 dark:bg-neutral-900">
          <p className="font-medium">Approve from another device</p>
          <p className="mt-1 text-xs text-neutral-600 dark:text-neutral-400">
            Show a 6-digit code here; enter it on a device you&apos;re already
            signed into. That device will cross-sign this new device&apos;s
            keys — no root-identity transfer.
          </p>
          <button
            onClick={onChooseApproval}
            className="mt-2 rounded bg-neutral-900 px-3 py-1.5 text-xs text-white dark:bg-white dark:text-neutral-900"
          >
            request approval →
          </button>
        </div>

        <div className="rounded border border-neutral-300 bg-white p-3 dark:border-neutral-700 dark:bg-neutral-900">
          <p className="font-medium">Enter recovery phrase</p>
          <p className="mt-1 text-xs text-neutral-600 dark:text-neutral-400">
            Your 24-word phrase unwraps your User Master Key locally. This
            device then generates its own device keys and self-signs its cert.
          </p>
          <button
            onClick={onChooseRecovery}
            disabled={!recoveryBlobExists}
            className="mt-2 rounded border border-neutral-300 px-3 py-1.5 text-xs disabled:opacity-40 dark:border-neutral-700"
          >
            enter phrase →
          </button>
          {!recoveryBlobExists && (
            <p className="mt-1 text-[11px] text-neutral-500">
              No recovery phrase set up for this account.
            </p>
          )}
        </div>

        <button
          onClick={onChooseNuclear}
          className="mt-2 text-xs font-medium text-red-700 underline underline-offset-2 hover:text-red-800 dark:text-red-400 dark:hover:text-red-300"
        >
          Reset identity (start over) →
        </button>
      </div>
    </div>
  );
}

function NuclearConfirm({
  onConfirm,
  onBack,
}: {
  onConfirm: () => void;
  onBack: () => void;
}) {
  const CONFIRM_PHRASE = 'RESET MY IDENTITY';
  const [typed, setTyped] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const ready = typed === CONFIRM_PHRASE && acknowledged;
  return (
    <div className="mt-6 space-y-4 rounded-md border-2 border-red-400 bg-red-50 p-4 text-sm dark:border-red-700 dark:bg-red-950">
      <p className="font-semibold text-red-900 dark:text-red-100">
        ⚠ Nuclear option: reset your encryption identity
      </p>
      <p className="text-xs text-red-800 dark:text-red-200">
        This is irreversible. Your old UMK, all device certs, every room
        membership, and any recovery phrase stop working immediately. Contacts
        will see a red &ldquo;key changed&rdquo; banner next to your name.
      </p>
      <label className="flex items-start gap-2 text-xs text-neutral-800 dark:text-neutral-200">
        <input
          type="checkbox"
          checked={acknowledged}
          onChange={(e) => setAcknowledged(e.target.checked)}
          className="mt-0.5"
        />
        <span>I understand this is permanent and contacts will see a warning.</span>
      </label>
      <div>
        <label className="block text-xs">
          Type <code className="rounded bg-neutral-200 px-1 font-mono dark:bg-neutral-800">{CONFIRM_PHRASE}</code> to continue:
        </label>
        <input
          type="text"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          className="mt-1 w-full rounded border border-neutral-300 bg-white px-2 py-1 font-mono text-xs dark:border-neutral-700 dark:bg-neutral-900"
        />
      </div>
      <div className="flex gap-2">
        <button
          onClick={onBack}
          className="rounded border border-neutral-300 px-3 py-1.5 text-xs dark:border-neutral-700"
        >
          back
        </button>
        <button
          onClick={onConfirm}
          disabled={!ready}
          className="rounded bg-red-700 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40 hover:bg-red-800"
        >
          Reset identity now
        </button>
      </div>
    </div>
  );
}

/**
 * B-side of device approval (v3).
 *
 * B generates its own device bundle LOCALLY. B posts an approval request
 * row with the bundle's pubkeys + device_id. A verifies the 6-digit code,
 * fetches the request, signs an issuance cert for B using UMK priv, and
 * INSERTS a `devices` row with that cert. B polls the device list for its
 * own device_id to appear, verifies the cert against the published UMK pub,
 * and finishes enrollment.
 *
 * No root-identity transfer. No sealed payload. The transport is a signed
 * certificate plus a user-visible code binding.
 */
function AwaitingApproval({
  userId,
  onInstalled,
  onBack,
  onError,
}: {
  userId: string;
  onInstalled: (enrolled: EnrolledDevice) => void;
  onBack: () => void;
  onError: (msg: string) => void;
}) {
  const [code, setCode] = useState<string | null>(null);
  const [status, setStatus] = useState<'preparing' | 'waiting' | 'installing'>('preparing');

  const bundleRef = useRef<DeviceKeyBundle | null>(null);
  const ranRef = useRef(false);
  const requestIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (ranRef.current) return;
    ranRef.current = true;
    let cancelled = false;
    let pollHandle: ReturnType<typeof setInterval> | null = null;

    (async () => {
      try {
        const deviceId = crypto.randomUUID();
        const bundle = await generateDeviceKeyBundle(deviceId);
        bundleRef.current = bundle;
        const createdAtMs = Date.now();
        const plainCode = await generateApprovalCode();
        const salt = await generateApprovalSalt();
        // Reuse the existing transcript-binding helper; link_nonce stays
        // random so the hash remains distinct across retries.
        const linkNonce = crypto.getRandomValues(new Uint8Array(32));
        const codeHash = await hashApprovalCode(
          plainCode,
          salt,
          bundle.x25519PublicKey,
          linkNonce,
        );
        const request = await createApprovalRequest({
          userId,
          deviceId,
          deviceEd25519Pub: bundle.ed25519PublicKey,
          deviceX25519Pub: bundle.x25519PublicKey,
          createdAtMs,
          codeHash,
          codeSalt: salt,
          linkNonce,
        });
        if (cancelled) {
          await deleteApprovalRequest(request.id).catch(() => {});
          return;
        }
        requestIdRef.current = request.id;
        setCode(plainCode);
        setStatus('waiting');

        // Poll the device list for our cert to appear. Realtime on `devices`
        // is not published (see 0009), so polling is the mechanism.
        const tryInstall = async () => {
          const umkPub = await fetchUserMasterKeyPub(userId);
          if (!umkPub) return;
          // Verify SSK cross-sig for v2 cert dispatch.
          let pollSskPub: Uint8Array | undefined;
          if (umkPub.sskPub && umkPub.sskCrossSignature) {
            try {
              const { verifySskCrossSignature } = await import('@/lib/e2ee-core');
              await verifySskCrossSignature(umkPub.ed25519PublicKey, umkPub.sskPub, umkPub.sskCrossSignature);
              pollSskPub = umkPub.sskPub;
            } catch { /* fall back */ }
          }
          const devices = await fetchPublicDevices(userId);
          const mine = devices.find((d) => d.deviceId === deviceId);
          if (!mine) return;
          setStatus('installing');
          // Verify the cert before trusting it.
          await verifyDeviceIssuance(
            {
              userId,
              deviceId: mine.deviceId,
              deviceEd25519PublicKey: mine.ed25519PublicKey,
              deviceX25519PublicKey: mine.x25519PublicKey,
              createdAtMs: mine.createdAtMs,
            },
            mine.issuanceSignature,
            umkPub.ed25519PublicKey,
            pollSskPub,
          );
          // Also assert A signed our own pubkeys, not some swapped set.
          const edMatch = await bytesEqual(
            mine.ed25519PublicKey,
            bundle.ed25519PublicKey,
          );
          const xMatch = await bytesEqual(
            mine.x25519PublicKey,
            bundle.x25519PublicKey,
          );
          if (!edMatch || !xMatch) {
            throw new Error(
              'approved device pubs do not match locally-generated bundle',
            );
          }
          await putDeviceBundle(userId, bundle);
          const localName = inferDeviceName();
          await putDeviceRecord(userId, deviceId, localName);
          // Seal our own display name to our own x_pub and write to the
          // device row. Only this device can open it later.
          try {
            const dnCiphertext = await encryptDeviceDisplayName(
              localName,
              bundle.x25519PublicKey,
            );
            await setDeviceDisplayNameCiphertext({
              deviceId,
              displayNameCiphertext: dnCiphertext,
            });
          } catch (err) {
            console.warn('display-name seal failed (row stays unlabeled)', err);
          }
          // Pick up sealed keys from the approving device's device row.
          try {
            const { listDevices: listDeviceRows } = await import('@/lib/supabase/queries');
            const myRows = await listDeviceRows(userId);
            const myRow = myRows.find((r) => r.id === deviceId);
            const sodium = await (await import('@/lib/e2ee-core')).getSodium();

            // SSK + USK → signing_key_wrap
            if (myRow?.signing_key_wrap) {
              try {
                const sealedKeys = await fromBase64(myRow.signing_key_wrap);
                const packed = sodium.crypto_box_seal_open(
                  sealedKeys,
                  bundle.x25519PublicKey,
                  bundle.x25519PrivateKey,
                );
                // packed = ssk_priv(64) || usk_priv(64)
                const sskPriv = packed.slice(0, 64);
                const uskPriv = packed.slice(64, 128);
                const sskPub = sodium.crypto_sign_ed25519_sk_to_pk(sskPriv);
                const uskPub = sodium.crypto_sign_ed25519_sk_to_pk(uskPriv);
                sodium.memzero(packed);
                const { putSelfSigningKey, putUserSigningKey } =
                  await import('@/lib/e2ee-core');
                await putSelfSigningKey(userId, {
                  ed25519PublicKey: sskPub,
                  ed25519PrivateKey: sskPriv,
                });
                await putUserSigningKey(userId, {
                  ed25519PublicKey: uskPub,
                  ed25519PrivateKey: uskPriv,
                });
                // Defense-in-depth: null out signing_key_wrap after pickup.
                const supabaseLocal = (await import('@/lib/supabase/client')).getSupabase();
                await supabaseLocal
                  .from('devices')
                  .update({ signing_key_wrap: null })
                  .eq('id', deviceId);
              } catch (err) {
                console.warn('SSK/USK pickup failed:', err);
              }
            }

            // Backup key → backup_key_wrap
            if (myRow?.backup_key_wrap) {
              const sealedBk = await fromBase64(myRow.backup_key_wrap);
              const bk = sodium.crypto_box_seal_open(
                sealedBk,
                bundle.x25519PublicKey,
                bundle.x25519PrivateKey,
              );
              const { putBackupKey } = await import('@/lib/e2ee-core');
              await putBackupKey(userId, bk);
            }
          } catch (err) {
            console.warn('key pickup from device row failed:', err);
          }
          await deleteApprovalRequest(request.id).catch(() => {});
          if (!cancelled) onInstalled({ userId, deviceBundle: bundle, umk: null });
          if (pollHandle) clearInterval(pollHandle);
        };

        pollHandle = setInterval(() => {
          void tryInstall().catch((e) => {
            if (!cancelled) onError(errorMessage(e));
          });
        }, 2000);
        void tryInstall().catch(() => {
          // non-fatal on first poll
        });
      } catch (e) {
        if (!cancelled) onError(errorMessage(e));
      }
    })();

    return () => {
      cancelled = true;
      if (pollHandle) clearInterval(pollHandle);
      const id = requestIdRef.current;
      if (id) void deleteApprovalRequest(id).catch(() => {});
    };
  }, [userId, onInstalled, onError]);

  // Suppress lint for unused import seen only in JSX-free paths
  void fromBase64;

  return (
    <div className="mt-6 space-y-4 rounded-md border border-amber-300 bg-amber-50 p-4 text-sm dark:border-amber-800 dark:bg-amber-950">
      <p>
        <strong>Approve on another signed-in device.</strong>
      </p>
      {status === 'preparing' && <p className="text-neutral-600">Preparing request…</p>}
      {status === 'waiting' && code && (
        <>
          <p className="text-neutral-700 dark:text-neutral-300">
            Open this app on any device you&apos;re already signed into. A
            banner will appear asking you to enter this code:
          </p>
          <p className="rounded bg-white p-4 text-center font-mono text-3xl tracking-widest dark:bg-neutral-900">
            {code.slice(0, 3)} {code.slice(3)}
          </p>
          <p className="text-xs text-neutral-500">
            Waiting for approval… (expires in ~2 minutes)
          </p>
        </>
      )}
      {status === 'installing' && (
        <p className="text-neutral-600">Verifying cert and installing…</p>
      )}
      <button
        onClick={onBack}
        className="rounded border border-neutral-300 px-3 py-1 text-xs dark:border-neutral-700"
      >
        back
      </button>
    </div>
  );
}

// `signDeviceIssuance` only consumed inside bootstrap.ts / the banner on A's
// side; retaining the import in this file keeps TS happy if we later reuse.
void signDeviceIssuance;

const STEP_ORDER: Step[] = [
  'exchanging-code',
  'checking-identity',
  'generating-identity',
  'publishing-identity',
  'registering-device',
  'done',
];

const POST_REGISTRATION_BRANCHES: Step[] = [
  'offer-recovery-setup',
  'device-linking-chooser',
  'awaiting-approval',
  'entering-recovery',
  'confirm-nuclear',
  'nuking',
];

function after(step: Step, current: Step): boolean {
  if (current === 'error') return false;
  const currIdx = STEP_ORDER.indexOf(current);
  if (currIdx === -1) {
    return POST_REGISTRATION_BRANCHES.includes(current);
  }
  return currIdx > STEP_ORDER.indexOf(step);
}

function StepLine({
  active,
  done,
  children,
}: {
  active: boolean;
  done: boolean;
  children: React.ReactNode;
}) {
  const marker = done ? '✓' : active ? '…' : '·';
  const color = done
    ? 'text-emerald-600 dark:text-emerald-400'
    : active
      ? 'text-neutral-900 dark:text-neutral-100'
      : 'text-neutral-400';
  return (
    <li className={color}>
      <span className="inline-block w-4">{marker}</span> {children}
    </li>
  );
}
