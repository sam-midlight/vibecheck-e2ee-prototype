'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { RecoveryPhraseModal } from '@/components/RecoveryPhraseModal';
import { RecoveryPhraseEntry } from '@/components/RecoveryPhraseEntry';
import { getSupabase } from '@/lib/supabase/client';
import {
  buildLinkPayload,
  generateApprovalCode,
  generateApprovalSalt,
  generateIdentity,
  getDeviceRecord,
  getIdentity,
  hashApprovalCode,
  openSealedIdentity,
  putDeviceRecord,
  putIdentity,
  toBase64,
  toPublicIdentity,
  type DeviceLinkingKeys,
  type Identity,
} from '@/lib/e2ee-core';
import {
  createApprovalRequest,
  deleteApprovalRequest,
  fetchIdentity,
  fetchLinkHandoff,
  hasRecoveryBlob,
  publishIdentity,
  registerDevice,
  subscribeLinkHandoff,
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
  | 'done'
  | 'error';

export default function AuthCallbackPage() {
  const router = useRouter();
  const [step, setStep] = useState<Step>('exchanging-code');
  const [error, setError] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [recoveryBlobExists, setRecoveryBlobExists] = useState(false);

  const ranRef = useRef(false);

  useEffect(() => {
    if (ranRef.current) return;
    ranRef.current = true;
    let cancelled = false;

    async function run() {
      const supabase = getSupabase();

      // Implicit flow: the magic link returns tokens in the URL hash. Supabase's
      // detectSessionInUrl init parses them asynchronously and then clears the
      // hash itself — don't touch window.location here or we race the parse.
      // getSession() awaits that init so the subsequent getUser() is safe.
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

      const published = await fetchIdentity(uid);
      const local = await getIdentity(uid);

      if (published && local) {
        const deviceRecord = await getDeviceRecord(uid);
        if (!deviceRecord) await ensureDeviceRegistered(uid, local);
        if (!cancelled) {
          setStep('done');
          router.replace('/rooms');
        }
        return;
      }

      if (published && !local) {
        const hasPhrase = await hasRecoveryBlob(uid);
        if (!cancelled) {
          setRecoveryBlobExists(hasPhrase);
          setStep('device-linking-chooser');
        }
        return;
      }

      // No identity on server → first-ever device.
      if (!cancelled) setStep('generating-identity');
      const newIdentity = await generateIdentity();
      await putIdentity(uid, newIdentity);

      if (!cancelled) setStep('publishing-identity');
      await publishIdentity(uid, await toPublicIdentity(newIdentity));

      if (!cancelled) setStep('registering-device');
      await ensureDeviceRegistered(uid, newIdentity);

      if (!cancelled) {
        setIdentity(newIdentity);
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
    (recovered: Identity) => {
      setIdentity(recovered);
      setStep('done');
      router.replace('/rooms');
    },
    [router],
  );

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
          Generating Ed25519 + X25519 keys
        </StepLine>
        <StepLine
          active={step === 'publishing-identity'}
          done={after('publishing-identity', step)}
        >
          Publishing public keys (self-signed)
        </StepLine>
        <StepLine active={step === 'registering-device'} done={after('registering-device', step)}>
          Registering this device
        </StepLine>
      </ul>

      {step === 'offer-recovery-setup' && userId && identity && (
        <RecoveryPhraseModal
          userId={userId}
          identity={identity}
          onDone={handleRecoveryDone}
        />
      )}

      {step === 'device-linking-chooser' && userId && (
        <LinkingChooser
          userId={userId}
          recoveryBlobExists={recoveryBlobExists}
          onChooseApproval={() => setStep('awaiting-approval')}
          onChooseRecovery={() => setStep('entering-recovery')}
        />
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

      {step === 'error' && (
        <p className="mt-4 text-sm text-red-600 dark:text-red-400">Error: {error}</p>
      )}
    </main>
  );
}

function LinkingChooser({
  recoveryBlobExists,
  onChooseApproval,
  onChooseRecovery,
}: {
  userId: string;
  recoveryBlobExists: boolean;
  onChooseApproval: () => void;
  onChooseRecovery: () => void;
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
            If you&apos;re still signed in on another browser or device,
            we&apos;ll show a 6-digit code here. Enter it on the other device
            to transfer your keys.
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
            {recoveryBlobExists
              ? 'Use your 24-word recovery phrase to restore keys on this device.'
              : 'No recovery phrase was set up for this account. This option won\u2019t work unless you created one earlier.'}
          </p>
          <button
            onClick={onChooseRecovery}
            disabled={!recoveryBlobExists}
            className="mt-2 rounded border border-neutral-300 px-3 py-1.5 text-xs disabled:opacity-50 dark:border-neutral-700"
          >
            enter phrase →
          </button>
        </div>
      </div>
    </div>
  );
}

function AwaitingApproval({
  userId,
  onInstalled,
  onBack,
  onError,
}: {
  userId: string;
  onInstalled: (identity: Identity) => void;
  onBack: () => void;
  onError: (msg: string) => void;
}) {
  const [code, setCode] = useState<string | null>(null);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [status, setStatus] = useState<'preparing' | 'waiting' | 'installing'>('preparing');

  // Keep the linking priv in a ref so cleanup can't see a stale closure.
  const linkingKeysRef = useRef<DeviceLinkingKeys | null>(null);
  const ranRef = useRef(false);
  const requestIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (ranRef.current) return;
    ranRef.current = true;

    let unsub: (() => void) | null = null;
    let cancelled = false;

    (async () => {
      try {
        const linkingKeys = await buildLinkPayload();
        linkingKeysRef.current = linkingKeys;
        const plainCode = await generateApprovalCode();
        const salt = await generateApprovalSalt();
        const codeHash = await hashApprovalCode(plainCode, salt);
        const request = await createApprovalRequest({
          userId,
          linkingPubkey: linkingKeys.x25519PublicKey,
          codeHash,
          codeSalt: salt,
          linkNonce: linkingKeys.linkNonce,
        });
        if (cancelled) {
          await deleteApprovalRequest(request.id).catch(() => {});
          return;
        }
        requestIdRef.current = request.id;
        setRequestId(request.id);
        setCode(plainCode);
        setStatus('waiting');

        const tryInstall = async () => {
          const keys = linkingKeysRef.current;
          if (!keys) return;
          const row = await fetchLinkHandoff(keys.linkNonce);
          if (!row) return;
          setStatus('installing');
          const sealed = row.sealedPayload;
          const identity = await openSealedIdentity(sealed, keys);
          await putIdentity(userId, identity);
          const deviceId = await registerDevice({
            userId,
            devicePublicKey: identity.x25519PublicKey,
            displayName: inferDeviceName(),
          });
          await putDeviceRecord(userId, deviceId, inferDeviceName());
          if (!cancelled) onInstalled(identity);
        };

        unsub = subscribeLinkHandoff(linkingKeys.linkNonce, () => {
          void tryInstall().catch((e) => {
            if (!cancelled) onError(e instanceof Error ? e.message : String(e));
          });
        });
        // Poll once in case the handoff already landed before we subscribed.
        void tryInstall().catch((e) => {
          if (!cancelled) onError(e instanceof Error ? e.message : String(e));
        });
      } catch (e) {
        if (!cancelled) onError(e instanceof Error ? e.message : String(e));
      }
    })();

    return () => {
      cancelled = true;
      if (unsub) unsub();
      const id = requestIdRef.current;
      if (id) void deleteApprovalRequest(id).catch(() => {});
    };
  }, [userId, onInstalled, onError]);

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
            Waiting for approval… (expires in ~10 minutes)
          </p>
        </>
      )}
      {status === 'installing' && (
        <p className="text-neutral-600">Installing keys locally…</p>
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

async function ensureDeviceRegistered(userId: string, identity: Identity): Promise<void> {
  const displayName = inferDeviceName();
  const deviceId = await registerDevice({
    userId,
    devicePublicKey: identity.x25519PublicKey,
    displayName,
  });
  await putDeviceRecord(userId, deviceId, displayName);
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
];

function after(step: Step, current: Step): boolean {
  if (current === 'error') return false;
  const currIdx = STEP_ORDER.indexOf(current);
  if (currIdx === -1) {
    // Branches after registering-device: everything in STEP_ORDER is done.
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
