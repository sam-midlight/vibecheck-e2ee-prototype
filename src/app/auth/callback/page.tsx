'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { RecoveryPhraseModal } from '@/components/RecoveryPhraseModal';
import { RecoveryPhraseEntry } from '@/components/RecoveryPhraseEntry';
import { getSupabase } from '@/lib/supabase/client';
import {
  buildLinkPayload,
  clearIdentity,
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
  nukeIdentityServer,
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
  | 'confirm-nuclear'
  | 'nuking'
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

  const handleNuclearConfirmed = useCallback(async () => {
    if (!userId) return;
    setStep('nuking');
    setError(null);
    try {
      // Wipe any stale local state first (TOFU cache, orphan device record).
      await clearIdentity(userId);
      // Server-side: leave rooms, cancel invites/approvals, drop devices + recovery blob.
      await nukeIdentityServer(userId);
      // Fresh identity.
      const fresh = await generateIdentity();
      await putIdentity(userId, fresh);
      await publishIdentity(userId, await toPublicIdentity(fresh));
      await ensureDeviceRegistered(userId, fresh);
      // Clear the "I dismissed the recovery prompt" flag so it offers again —
      // they just learned what losing it means.
      localStorage.removeItem(`recovery_skipped_${userId}`);
      setIdentity(fresh);
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

      <div className="mt-4 border-t border-amber-300 pt-3 dark:border-amber-800">
        <p className="text-xs text-neutral-600 dark:text-neutral-400">
          Locked out for good? Neither of the above will work if you have no
          other signed-in device <em>and</em> no recovery phrase.
        </p>
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
      <div className="flex items-start gap-2">
        <span aria-hidden className="text-xl leading-none">⚠</span>
        <div>
          <p className="font-semibold text-red-900 dark:text-red-100">
            Nuclear option: reset your encryption identity
          </p>
          <p className="mt-1 text-xs text-red-800 dark:text-red-200">
            This is irreversible. Read carefully before continuing.
          </p>
        </div>
      </div>

      <div className="rounded bg-white p-3 text-xs dark:bg-neutral-900">
        <p className="font-medium">What will be destroyed</p>
        <ul className="mt-1 list-disc space-y-0.5 pl-5 text-neutral-700 dark:text-neutral-300">
          <li>
            Your old encryption keys (gone forever). Every encrypted message
            you ever received will become permanently unreadable to you.
          </li>
          <li>Your membership in every room you were in.</li>
          <li>All invites currently waiting for you.</li>
          <li>Your recovery phrase (if any) will no longer work.</li>
          <li>Every device registered to you is revoked.</li>
        </ul>
      </div>

      <div className="rounded bg-white p-3 text-xs dark:bg-neutral-900">
        <p className="font-medium">What your contacts will see</p>
        <p className="mt-1 text-neutral-700 dark:text-neutral-300">
          A red &ldquo;key changed&rdquo; banner next to your name — identical
          to what they&apos;d see if an attacker stole your account. They must
          re-trust you out of band (ask you in person / on another channel
          that this was really you) and re-invite you to any shared rooms.
        </p>
      </div>

      <div className="rounded bg-white p-3 text-xs dark:bg-neutral-900">
        <p className="font-medium">What you keep</p>
        <p className="mt-1 text-neutral-700 dark:text-neutral-300">
          Your login (magic link to your email still works), your user ID, and
          your email address. You just get new encryption keys and an empty
          rooms list.
        </p>
      </div>

      <label className="flex items-start gap-2 text-xs text-neutral-800 dark:text-neutral-200">
        <input
          type="checkbox"
          checked={acknowledged}
          onChange={(e) => setAcknowledged(e.target.checked)}
          className="mt-0.5"
        />
        <span>
          I understand that past encrypted messages will be permanently
          unreadable to me, and my contacts will see a security warning next
          to my name.
        </span>
      </label>

      <div>
        <label className="block text-xs text-neutral-800 dark:text-neutral-200">
          Type <code className="rounded bg-neutral-200 px-1 font-mono dark:bg-neutral-800">{CONFIRM_PHRASE}</code> to continue:
        </label>
        <input
          type="text"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          className="mt-1 w-full rounded border border-neutral-300 bg-white px-2 py-1 font-mono text-xs dark:border-neutral-700 dark:bg-neutral-900"
        />
      </div>

      <div className="flex items-center gap-2">
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
  'confirm-nuclear',
  'nuking',
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
