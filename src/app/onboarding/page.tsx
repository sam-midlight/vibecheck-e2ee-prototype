'use client';

/**
 * First-time onboarding flow. Two steps:
 *
 *   1. Name — capture the user's preferred display name, save locally.
 *   2. Choose a path — create a new private room, or join one an existing
 *      partner has invited them to (pending invites shown live).
 *
 * Bails out to /rooms if the user already belongs to any room (so
 * /onboarding is never a nag for returning users). Bails to / if not
 * authenticated, and to /auth/bootstrap if device keys are missing.
 */

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AppShell } from '@/components/AppShell';
import { getSupabase } from '@/lib/supabase/client';
import {
  fromBase64,
  generateRoomKey,
  unwrapRoomKey,
} from '@/lib/e2ee-core';
import {
  loadEnrolledDevice,
  wrapRoomKeyForAllMyDevices,
  type EnrolledDevice,
} from '@/lib/bootstrap';
import {
  createRoom,
  deleteInvite,
  listMyInvites,
  listMyRooms,
  subscribeInvites,
  type RoomInviteRow,
} from '@/lib/supabase/queries';
import {
  loadMyDisplayName,
  saveMyDisplayName,
} from '@/lib/domain/myDisplayName';
import { describeError } from '@/lib/domain/errors';
import { Loading } from '@/components/OrganicLoader';

type Step = 'loading' | 'name' | 'choose' | 'working';

export default function OnboardingPage() {
  return (
    <AppShell requireAuth>
      <OnboardingInner />
    </AppShell>
  );
}

function OnboardingInner() {
  const router = useRouter();
  const [step, setStep] = useState<Step>('loading');
  const [userId, setUserId] = useState<string | null>(null);
  const [device, setDevice] = useState<EnrolledDevice | null>(null);
  const [invites, setInvites] = useState<RoomInviteRow[]>([]);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const refreshInvites = useCallback(async (uid: string) => {
    const inv = await listMyInvites(uid);
    setInvites(inv);
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const sb = getSupabase();
        const { data } = await sb.auth.getUser();
        if (!data.user) {
          router.replace('/');
          return;
        }
        setUserId(data.user.id);

        const id = await loadEnrolledDevice(data.user.id);
        if (!id) {
          router.replace('/auth/bootstrap');
          return;
        }
        setDevice(id);

        // Already onboarded? Send them to the dashboard.
        const rooms = await listMyRooms(data.user.id);
        if (rooms.length > 0) {
          router.replace('/rooms');
          return;
        }

        await refreshInvites(data.user.id);

        const stored = loadMyDisplayName();
        if (stored) {
          setName(stored);
          setStep('choose');
        } else {
          setStep('name');
        }
      } catch (e) {
        setError(describeError(e));
        setStep('choose');
      }
    })();
  }, [router, refreshInvites]);

  useEffect(() => {
    if (!userId) return;
    const unsub = subscribeInvites(userId, (row) => {
      setInvites((prev) => {
        if (prev.some((i) => i.id === row.id)) return prev;
        return [row, ...prev];
      });
    });
    return unsub;
  }, [userId]);

  function saveName(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    saveMyDisplayName(trimmed);
    setStep('choose');
  }

  async function doCreateRoom() {
    if (!userId || !device) return;
    setStep('working');
    setError(null);
    try {
      const room = await createRoom({ kind: 'pair', createdBy: userId });
      const roomKey = await generateRoomKey(room.current_generation);
      await wrapRoomKeyForAllMyDevices({
        roomId: room.id,
        userId,
        roomKey: { key: roomKey.key, generation: room.current_generation },
        signerDevice: device.deviceBundle,
      });
      router.replace(`/rooms/${room.id}`);
    } catch (e) {
      setError(describeError(e));
      setStep('choose');
    }
  }

  async function acceptInvite(invite: RoomInviteRow) {
    if (!userId || !device) return;
    setStep('working');
    setError(null);
    try {
      if (invite.invited_device_id && invite.invited_device_id !== device.deviceBundle.deviceId) {
        throw new Error(
          'this invite was issued to a different device on your account — accept it from that device, or ask the inviter to re-send',
        );
      }
      const wrappedBytes = await fromBase64(invite.wrapped_room_key);
      const roomKey = await unwrapRoomKey(
        { wrapped: wrappedBytes, generation: invite.generation },
        device.deviceBundle.x25519PublicKey,
        device.deviceBundle.x25519PrivateKey,
      );
      await wrapRoomKeyForAllMyDevices({
        roomId: invite.room_id,
        userId,
        roomKey: { key: roomKey.key, generation: invite.generation },
        signerDevice: device.deviceBundle,
      });
      await deleteInvite(invite.id);
      router.replace(`/rooms/${invite.room_id}`);
    } catch (e) {
      setError(describeError(e));
      setStep('choose');
    }
  }

  if (step === 'loading') {
    return (
      <div className="p-8">
        <Loading />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-8 pb-16 pt-6">
      {step === 'name' && (
        <NameStep
          name={name}
          setName={setName}
          onSubmit={saveName}
        />
      )}
      {(step === 'choose' || step === 'working') && userId && (
        <ChooseStep
          name={name}
          userId={userId}
          invites={invites}
          busy={step === 'working'}
          error={error}
          onCreate={doCreateRoom}
          onAccept={acceptInvite}
          onRefreshInvites={() => userId && void refreshInvites(userId)}
          onEditName={() => setStep('name')}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function NameStep({
  name,
  setName,
  onSubmit,
}: {
  name: string;
  setName: (n: string) => void;
  onSubmit: (e: React.FormEvent) => void;
}) {
  return (
    <section className="rounded-3xl border border-white/60 bg-white/70 p-8 shadow-xl backdrop-blur-md dark:border-white/10 dark:bg-neutral-900/60">
      <p className="text-[10px] uppercase tracking-[0.2em] text-neutral-500">
        Onboarding · Step 1 of 2
      </p>
      <h1 className="mt-4 font-display italic text-3xl tracking-tight sm:text-4xl">
        Welcome to VibeCheck.
      </h1>
      <p className="mt-3 text-base text-neutral-600 dark:text-neutral-400">
        A quiet, end-to-end-encrypted place for the two of you. Let&apos;s start
        with something simple.
      </p>

      <form onSubmit={onSubmit} className="mt-8 space-y-4">
        <label className="block">
          <span className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
            What should we call you?
          </span>
          <input
            autoFocus
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Ashton"
            maxLength={60}
            required
            className="mt-2 block w-full rounded-xl border border-white/60 bg-white/80 px-4 py-3 text-base outline-none backdrop-blur-md focus:border-white/90 focus:ring-2 focus:ring-neutral-900/10 dark:border-white/10 dark:bg-neutral-900/70 dark:focus:ring-white/20"
          />
          <span className="mt-2 block text-xs text-neutral-500">
            Saved on this device only. Your partner will see this name when
            you&apos;re in a room together.
          </span>
        </label>
        <div className="flex justify-end">
          <button
            type="submit"
            disabled={!name.trim()}
            className="rounded-full bg-neutral-900 px-6 py-2.5 text-sm font-medium text-white shadow-sm transition-all hover:shadow-md active:scale-[0.98] disabled:opacity-50 dark:bg-white dark:text-neutral-900"
          >
            continue →
          </button>
        </div>
      </form>
    </section>
  );
}

// ---------------------------------------------------------------------------

function ChooseStep({
  name,
  userId,
  invites,
  busy,
  error,
  onCreate,
  onAccept,
  onRefreshInvites,
  onEditName,
}: {
  name: string;
  userId: string;
  invites: RoomInviteRow[];
  busy: boolean;
  error: string | null;
  onCreate: () => void;
  onAccept: (invite: RoomInviteRow) => void;
  onRefreshInvites: () => void;
  onEditName: () => void;
}) {
  const [expanded, setExpanded] = useState<'create' | 'join' | null>(null);

  return (
    <>
      <section className="rounded-3xl border border-white/60 bg-white/70 p-8 shadow-xl backdrop-blur-md dark:border-white/10 dark:bg-neutral-900/60">
        <p className="text-[10px] uppercase tracking-[0.2em] text-neutral-500">
          Onboarding · Step 2 of 2
        </p>
        <h1 className="mt-4 font-display italic text-3xl tracking-tight sm:text-4xl">
          Nice to meet you, {name || 'friend'}.
        </h1>
        <p className="mt-3 text-base text-neutral-600 dark:text-neutral-400">
          How would you like to begin?{' '}
          <button
            type="button"
            onClick={onEditName}
            className="underline decoration-neutral-400 underline-offset-2 hover:text-neutral-900 dark:hover:text-neutral-100"
          >
            change name
          </button>
        </p>

        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          <PathCard
            emoji="🆕"
            title="Create a new private room"
            body="A brand-new space, just for the two of you. You can invite your partner from inside once it&rsquo;s open."
            cta={busy && expanded === 'create' ? 'creating…' : 'create'}
            selected={expanded === 'create'}
            disabled={busy}
            onClick={() => {
              setExpanded('create');
              onCreate();
            }}
          />
          <PathCard
            emoji="🤝"
            title="Join an existing room"
            body="Your partner already set up a room and invited you? Accept it here."
            cta={expanded === 'join' ? 'hide' : 'show invites'}
            selected={expanded === 'join'}
            disabled={busy}
            onClick={() => {
              setExpanded((p) => (p === 'join' ? null : 'join'));
              onRefreshInvites();
            }}
          />
        </div>

        {error && (
          <p className="mt-4 rounded-xl border border-red-300 bg-red-50/80 p-3 text-sm text-red-900 dark:border-red-800 dark:bg-red-950/60 dark:text-red-200">
            {error}
          </p>
        )}
      </section>

      {expanded === 'join' && (
        <JoinPanel
          userId={userId}
          invites={invites}
          busy={busy}
          onAccept={onAccept}
          onRefresh={onRefreshInvites}
        />
      )}
    </>
  );
}

function PathCard({
  emoji,
  title,
  body,
  cta,
  selected,
  disabled,
  onClick,
}: {
  emoji: string;
  title: string;
  body: string;
  cta: string;
  selected: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`flex flex-col items-start gap-2 rounded-2xl border p-5 text-left shadow-sm backdrop-blur-md transition-all hover:shadow-md active:scale-[0.99] disabled:opacity-60 ${
        selected
          ? 'border-amber-300/70 bg-gradient-to-br from-amber-50/80 to-rose-50/70 ring-1 ring-amber-200/50 dark:border-amber-600/30 dark:from-amber-950/40 dark:to-rose-950/30'
          : 'border-white/60 bg-white/60 hover:bg-white/80 dark:border-white/10 dark:bg-neutral-900/50 dark:hover:bg-neutral-900/70'
      }`}
    >
      <span className="text-3xl leading-none">{emoji}</span>
      <span className="text-base font-semibold">{title}</span>
      <span className="text-sm text-neutral-600 dark:text-neutral-400">
        {body}
      </span>
      <span className="mt-2 inline-flex items-center rounded-full bg-neutral-900/90 px-3 py-1 text-xs font-medium text-white dark:bg-white dark:text-neutral-900">
        {cta} →
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------

function JoinPanel({
  userId,
  invites,
  busy,
  onAccept,
  onRefresh,
}: {
  userId: string;
  invites: RoomInviteRow[];
  busy: boolean;
  onAccept: (invite: RoomInviteRow) => void;
  onRefresh: () => void;
}) {
  return (
    <section className="rounded-3xl border border-white/60 bg-white/70 p-6 shadow-lg backdrop-blur-md dark:border-white/10 dark:bg-neutral-900/60">
      {invites.length > 0 ? (
        <>
          <p className="text-[10px] uppercase tracking-[0.2em] text-neutral-500">
            Pending invites
          </p>
          <ul className="mt-3 space-y-2">
            {invites.map((inv) => (
              <li
                key={inv.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-white/60 bg-white/70 p-4 shadow-sm backdrop-blur-md dark:border-white/10 dark:bg-neutral-900/60"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-sm">
                    <span className="font-medium">Room invite</span>{' '}
                    <span className="text-neutral-500">
                      from <code className="font-mono text-xs">{inv.created_by.slice(0, 8)}…</code>
                    </span>
                  </p>
                  <p className="mt-0.5 text-[10px] text-neutral-500">
                    room <code className="font-mono">{inv.room_id.slice(0, 8)}</code> · gen{' '}
                    {inv.generation}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => onAccept(inv)}
                  disabled={busy}
                  className="rounded-full bg-neutral-900 px-4 py-2 text-xs font-medium text-white shadow-sm transition-all hover:shadow-md active:scale-[0.98] disabled:opacity-50 dark:bg-white dark:text-neutral-900"
                >
                  accept
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <>
          <p className="text-[10px] uppercase tracking-[0.2em] text-neutral-500">
            No invites yet
          </p>
          <p className="mt-3 text-sm text-neutral-700 dark:text-neutral-300">
            Share your user ID with your partner. On their device, they
            can paste it into the invite form and send you a room invite —
            it&apos;ll appear right here.
          </p>
          <div className="mt-4 flex items-center gap-2 rounded-xl border border-white/60 bg-white/80 p-3 dark:border-white/10 dark:bg-neutral-900/70">
            <code className="flex-1 break-all font-mono text-xs text-neutral-700 dark:text-neutral-300">
              {userId}
            </code>
            <button
              type="button"
              onClick={() => void navigator.clipboard.writeText(userId)}
              className="rounded-full border border-white/60 bg-white/70 px-3 py-1 text-xs transition-all hover:bg-white/90 active:scale-[0.98] dark:border-white/10 dark:bg-neutral-900/60"
            >
              copy
            </button>
          </div>
          <button
            type="button"
            onClick={onRefresh}
            disabled={busy}
            className="mt-4 rounded-full border border-white/60 bg-white/60 px-4 py-2 text-xs transition-all hover:bg-white/80 active:scale-[0.98] disabled:opacity-50 dark:border-white/10 dark:bg-neutral-900/60"
          >
            check again
          </button>
        </>
      )}
    </section>
  );
}
