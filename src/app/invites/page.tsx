'use client';

/**
 * Room Invites inbox.
 *
 * Lifted out of /rooms so pending invites have a dedicated, more prominent
 * surface — the user reported friction with recipients finding invites. The
 * nav item in AppShell carries a badge count, and this page just lists the
 * invites with accept / decline affordances.
 *
 * Logic (key unwrap → re-wrap for self → insert membership → delete invite)
 * mirrors the existing InviteCard on /rooms; it's been re-skinned to match
 * the new visual language.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { AppShell } from '@/components/AppShell';
import { Loading } from '@/components/OrganicLoader';
import { errorMessage } from '@/lib/errors';
import {
  fromBase64,
  unwrapRoomKey,
} from '@/lib/e2ee-core';
import {
  loadEnrolledDevice,
  wrapRoomKeyForAllMyDevices,
  type EnrolledDevice,
} from '@/lib/bootstrap';
import { getSupabase } from '@/lib/supabase/client';
import {
  deleteInvite,
  listMyInvites,
  subscribeInvites,
  type RoomInviteRow,
} from '@/lib/supabase/queries';

export default function InvitesPage() {
  return (
    <AppShell requireAuth>
      <InvitesInner />
    </AppShell>
  );
}

function InvitesInner() {
  const router = useRouter();
  const [userId, setUserId] = useState<string | null>(null);
  const [device, setDevice] = useState<EnrolledDevice | null>(null);
  const [invites, setInvites] = useState<RoomInviteRow[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async (uid: string) => {
    const rows = await listMyInvites(uid);
    setInvites(rows);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const supabase = getSupabase();
        const { data } = await supabase.auth.getUser();
        if (!data.user) return;
        if (cancelled) return;
        setUserId(data.user.id);
        const id = await loadEnrolledDevice(data.user.id);
        if (cancelled) return;
        if (id) setDevice(id);
        await reload(data.user.id);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [reload]);

  // Realtime: new invites pop in without a manual refresh.
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

  // Backend writes one invite row per recipient device (each row carries a
  // device-specific key wrap). For the inbox, fold those back to one card
  // per (room × inviter) so a multi-device user doesn't see N copies of
  // the same conceptual invite. Prefer the row addressed to THIS device
  // when picking the representative — accept then unwraps from a row
  // it actually has the key for.
  const groupedInvites = useMemo(() => {
    const groups = new Map<
      string,
      { primary: RoomInviteRow; siblingIds: string[] }
    >();
    const myDeviceId = device?.deviceBundle.deviceId;
    for (const inv of invites) {
      const key = `${inv.room_id}:${inv.created_by}`;
      const existing = groups.get(key);
      if (!existing) {
        groups.set(key, { primary: inv, siblingIds: [inv.id] });
        continue;
      }
      existing.siblingIds.push(inv.id);
      const primaryMatches =
        existing.primary.invited_device_id === myDeviceId;
      const candidateMatches = inv.invited_device_id === myDeviceId;
      if (candidateMatches && !primaryMatches) {
        existing.primary = inv;
      }
    }
    return Array.from(groups.values());
  }, [invites, device]);

  if (loading || !userId) {
    return <Loading />;
  }

  return (
    <div className="mx-auto max-w-2xl space-y-8 pb-16">
      <section className="pt-6 text-center">
        <p className="text-[11px] font-medium uppercase tracking-[0.2em] text-neutral-500">
          Your inbox
        </p>
        <h1 className="mt-3 font-display italic text-3xl tracking-tight sm:text-4xl">
          Room invites
        </h1>
        <p className="mx-auto mt-3 max-w-md text-sm leading-relaxed text-neutral-600 dark:text-neutral-400">
          People who&apos;ve invited you into their space. Accepting unwraps
          the room key for your device and adds you as a member. Declining
          just removes the invite.
        </p>
      </section>

      {invites.length === 0 && device && (
        <section className="rounded-2xl border border-white/60 bg-white/70 p-8 text-center shadow-lg backdrop-blur-md dark:border-white/10 dark:bg-neutral-900/55">
          <p className="text-4xl" aria-hidden>🕊️</p>
          <p className="mt-3 text-sm leading-relaxed text-neutral-600 dark:text-neutral-300">
            No pending invites. When someone invites you into their room
            it&apos;ll show up here — you&apos;ll also see a badge on the
            &quot;Room invites&quot; link at the top.
          </p>
          <Link
            href="/rooms"
            className="mt-5 inline-block rounded-full border border-neutral-200 bg-white/80 px-4 py-2 font-display italic text-sm text-neutral-700 transition-all hover:scale-[1.04] hover:bg-white active:scale-[1.02] dark:border-neutral-700 dark:bg-neutral-900/60 dark:text-neutral-200"
          >
            Back to your rooms
          </Link>
        </section>
      )}

      {groupedInvites.length > 0 && device && (
        <section>
          <h2 className="text-[11px] font-medium uppercase tracking-[0.18em] text-neutral-500">
            {groupedInvites.length} pending
          </h2>
          <div className="mt-3 space-y-3">
            {groupedInvites.map(({ primary, siblingIds }) => (
              <InviteCard
                key={primary.id}
                invite={primary}
                siblingIds={siblingIds}
                userId={userId}
                device={device}
                onAccepted={() => {
                  void reload(userId);
                  router.push(`/rooms/${primary.room_id}`);
                }}
                onDeclined={() => void reload(userId)}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function InviteCard({
  invite,
  siblingIds,
  userId,
  device,
  onAccepted,
  onDeclined,
}: {
  invite: RoomInviteRow;
  /** Every invite-row id in the same (room × inviter) group, including
   *  invite.id. Accept/decline cleans up all of them so stale rows
   *  addressed to other devices on this account don't linger. */
  siblingIds: string[];
  userId: string;
  device: EnrolledDevice;
  onAccepted: () => void;
  onDeclined: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function deleteAllSiblings() {
    await Promise.all(siblingIds.map((id) => deleteInvite(id)));
  }

  async function accept() {
    setBusy(true);
    setError(null);
    try {
      // The v3 invite is sealed to a specific device. The dedupe step
      // upstream prefers the row addressed to this device, but be defensive.
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

      // wrapRoomKeyForAllMyDevices: wraps for every active device on my
      // account so I can open this room from any of them, and uploads to
      // server-side key_backup if a backup key is available.
      await wrapRoomKeyForAllMyDevices({
        roomId: invite.room_id,
        userId,
        roomKey: { key: roomKey.key, generation: invite.generation },
        signerDevice: device.deviceBundle,
      });
      await deleteAllSiblings();
      onAccepted();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function decline() {
    setBusy(true);
    try {
      await deleteAllSiblings();
      onDeclined();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-2xl border border-blue-200/70 bg-gradient-to-br from-blue-50/90 to-indigo-50/80 p-5 shadow-lg backdrop-blur-md transition-transform duration-200 ease-out hover:scale-[1.01] dark:border-blue-800/50 dark:from-blue-950/50 dark:to-indigo-950/40">
      <div className="flex items-start gap-3">
        <span aria-hidden className="text-2xl leading-none">💌</span>
        <div className="min-w-0 flex-1">
          <p className="font-display italic text-base text-neutral-900 dark:text-neutral-50">
            Invite to a private room
          </p>
          <p className="mt-1 text-sm leading-relaxed text-neutral-600 dark:text-neutral-300">
            From{' '}
            <code className="rounded bg-white/70 px-1.5 py-0.5 font-mono text-xs text-neutral-700 dark:bg-neutral-800/70 dark:text-neutral-200">
              {invite.created_by.slice(0, 8)}
            </code>
            {' · Room '}
            <code className="rounded bg-white/70 px-1.5 py-0.5 font-mono text-xs text-neutral-700 dark:bg-neutral-800/70 dark:text-neutral-200">
              {invite.room_id.slice(0, 8)}
            </code>
          </p>
          <p className="mt-1.5 text-[11px] text-neutral-500">
            Received {new Date(invite.created_at).toLocaleString()}
          </p>
        </div>
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => void accept()}
          disabled={busy}
          className="rounded-full bg-gradient-to-br from-blue-400 via-blue-500 to-indigo-600 px-5 py-2 font-display italic text-sm text-white shadow-[0_8px_20px_-4px_rgba(37,99,235,0.5),inset_0_2px_3px_rgba(255,255,255,0.4),inset_0_-3px_6px_rgba(30,64,175,0.3)] ring-1 ring-blue-200/60 transition-all hover:scale-[1.04] active:scale-[1.06] disabled:opacity-50"
        >
          {busy ? 'accepting…' : 'Accept invite'}
        </button>
        <button
          type="button"
          onClick={() => void decline()}
          disabled={busy}
          className="rounded-full border border-blue-200 bg-white/80 px-4 py-2 font-display italic text-sm text-blue-900 transition-all hover:scale-[1.04] hover:bg-white active:scale-[1.02] disabled:opacity-50 dark:border-blue-800 dark:bg-neutral-900/60 dark:text-blue-200"
        >
          Decline
        </button>
      </div>
      {error && <p className="mt-3 text-xs text-red-600">{error}</p>}
    </div>
  );
}
