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
  signDeviceIssuance,
  unwrapDeviceStateWithPin,
  verifyDeviceIssuance,
  type DeviceKeyBundle,
} from '@/lib/e2ee-core';
import {
  bootstrapNewUser,
  inferDeviceName,
  loadEnrolledDevice,
  type EnrolledDevice,
} from '@/lib/bootstrap';
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
  | 'device-linking-chooser'
  | 'awaiting-approval'
  | 'entering-recovery'
  | 'unlock-passphrase'
  | 'confirm-nuclear'
  | 'nuking'
  | 'done'
  | 'error';

export default function AuthCallbackPage() {
  const router = useRouter();
  const [step, setStep] = useState<Step>('exchanging-code');
  const [error, setError] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [enrolled, setEnrolled] = useState<EnrolledDevice | null>(null);
  const [recoveryBlobExists, setRecoveryBlobExists] = useState(false);

  const ranRef = useRef(false);

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
        setError(userErr?.message ?? 'not signed in');
        setStep('error');
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
        // Orphan-device guard: does our local UMK pub (if any) or our device
        // cert still chain to the published UMK pub?
        const umkPubsMatch =
          local.umk == null ||
          (await bytesEqual(
            local.umk.ed25519PublicKey,
            publishedUmk.ed25519PublicKey,
          ));
        if (!umkPubsMatch) {
          console.warn(
            'local UMK does not match published UMK — orphan device; wiping local state',
          );
          await clearDeviceBundle(uid);
          await clearUserMasterKey(uid);
          const hasPhrase = await hasRecoveryBlob(uid);
          if (!cancelled) {
            setRecoveryBlobExists(hasPhrase);
            setStep('device-linking-chooser');
          }
          return;
        }

        // Also verify our device cert still chains to the published UMK.
        const devices = await fetchPublicDevices(uid);
        const myDevice = devices.find((d) => d.deviceId === local.deviceBundle.deviceId);
        if (!myDevice) {
          console.warn('local device_id not present in published device list — orphan');
          await clearDeviceBundle(uid);
          await clearUserMasterKey(uid);
          const hasPhrase = await hasRecoveryBlob(uid);
          if (!cancelled) {
            setRecoveryBlobExists(hasPhrase);
            setStep('device-linking-chooser');
          }
          return;
        }
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
          );
        } catch {
          console.warn('local device cert failed to verify against published UMK — orphan');
          await clearDeviceBundle(uid);
          await clearUserMasterKey(uid);
          setStep('device-linking-chooser');
          return;
        }

        if (!cancelled) {
          setEnrolled(local);
          setStep('done');
          router.replace('/rooms');
        }
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
        setError(e instanceof Error ? e.message : String(e));
        setStep('error');
      }
    });

    return () => {
      cancelled = true;
    };
  }, [router]);

  const handleRecoveryDone = useCallback(
    (result: 'saved' | 'skipped') => {
      if (result === 'skipped' && userId) {
        localStorage.setItem(`recovery_skipped_${userId}`, '1');
      }
      setStep('done');
      router.replace('/status');
    },
    [router, userId],
  );

  const handleRecovered = useCallback(
    (recovered: EnrolledDevice) => {
      setEnrolled(recovered);
      setStep('done');
      router.replace('/rooms');
    },
    [router],
  );

  const handleNuclearConfirmed = useCallback(async () => {
    if (!userId) return;
    setStep('nuking');
    setError(null);
    try {
      await clearDeviceBundle(userId);
      await clearUserMasterKey(userId);
      await nukeIdentityServer(userId);
      const fresh = await bootstrapNewUser(userId);
      localStorage.removeItem(`recovery_skipped_${userId}`);
      setEnrolled(fresh);
      setStep('offer-recovery-setup');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
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
          onUnlocked={handleRecovered}
          onError={(msg) => {
            setError(msg);
            setStep('error');
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
  onError,
}: {
  userId: string;
  onUnlocked: (enrolled: EnrolledDevice) => void;
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
      onUnlocked({ userId, deviceBundle: state.deviceBundle, umk: state.umk });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
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
      <button
        type="submit"
        disabled={busy}
        className="rounded bg-neutral-900 px-3 py-1.5 text-xs text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
      >
        {busy ? 'unlocking…' : 'unlock'}
      </button>
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
          await deleteApprovalRequest(request.id).catch(() => {});
          if (!cancelled) onInstalled({ userId, deviceBundle: bundle, umk: null });
          if (pollHandle) clearInterval(pollHandle);
        };

        pollHandle = setInterval(() => {
          void tryInstall().catch((e) => {
            if (!cancelled) onError(e instanceof Error ? e.message : String(e));
          });
        }, 2000);
        void tryInstall().catch(() => {
          // non-fatal on first poll
        });
      } catch (e) {
        if (!cancelled) onError(e instanceof Error ? e.message : String(e));
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
