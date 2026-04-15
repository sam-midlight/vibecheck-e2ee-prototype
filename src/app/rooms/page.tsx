'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { KeyChangeBanner } from '@/components/KeyChangeBanner';
import { errorMessage } from '@/lib/errors';
import { getSupabase } from '@/lib/supabase/client';
import {
  fromBase64,
  generateRoomKey,
  getIdentity,
  observeContact,
  unwrapRoomKey,
  wrapRoomKeyFor,
  type Identity,
} from '@/lib/e2ee-core';
import {
  addRoomMember,
  createInvite,
  createRoom,
  deleteInvite,
  fetchIdentity,
  getMyWrappedRoomKey,
  listMyInvites,
  listMyRooms,
  type RoomInviteRow,
  type RoomRow,
} from '@/lib/supabase/queries';

export default function RoomsPage() {
  return (
    <AppShell requireAuth>
      <RoomsInner />
    </AppShell>
  );
}

function RoomsInner() {
  const [userId, setUserId] = useState<string | null>(null);
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [rooms, setRooms] = useState<RoomRow[]>([]);
  const [invites, setInvites] = useState<RoomInviteRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(
    async (uid: string) => {
      try {
        const [r, i] = await Promise.all([listMyRooms(uid), listMyInvites(uid)]);
        setRooms(r);
        setInvites(i);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [],
  );

  useEffect(() => {
    (async () => {
      const supabase = getSupabase();
      const { data } = await supabase.auth.getUser();
      if (!data.user) return;
      setUserId(data.user.id);
      const id = await getIdentity(data.user.id);
      setIdentity(id);
      await reload(data.user.id);
      setLoading(false);
    })();
  }, [reload]);

  if (loading || !userId) {
    return <p className="text-sm text-neutral-500">loading…</p>;
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <KeyChangeBanner />

      <section className="rounded border border-neutral-200 p-4 dark:border-neutral-800">
        <h2 className="text-sm font-semibold">Your user ID</h2>
        <p className="mt-1 text-xs text-neutral-500">
          Share this with someone to let them invite you. It&apos;s your Supabase
          user ID.
        </p>
        <div className="mt-2 flex items-center gap-2">
          <code className="flex-1 break-all rounded bg-neutral-100 p-2 font-mono text-xs dark:bg-neutral-900">
            {userId}
          </code>
          <button
            onClick={() => void navigator.clipboard.writeText(userId)}
            className="rounded border border-neutral-300 px-2 py-1 text-xs dark:border-neutral-700"
          >
            copy
          </button>
        </div>
      </section>

      {invites.length > 0 && identity && (
        <section className="space-y-2">
          <h2 className="text-base font-semibold">Pending invites</h2>
          {invites.map((invite) => (
            <InviteCard
              key={invite.id}
              invite={invite}
              userId={userId}
              identity={identity}
              onDone={() => void reload(userId)}
            />
          ))}
        </section>
      )}

      <section>
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold">Your rooms</h2>
        </div>
        {rooms.length === 0 && (
          <p className="mt-2 text-sm text-neutral-500">No rooms yet. Create one below.</p>
        )}
        <ul className="mt-2 space-y-2">
          {rooms.map((room) => (
            <li
              key={room.id}
              className="flex items-center justify-between rounded border border-neutral-200 px-3 py-2 text-sm dark:border-neutral-800"
            >
              <div>
                <span className="font-mono text-xs text-neutral-500">{room.id.slice(0, 8)}</span>{' '}
                <span className="ml-2 rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] uppercase dark:bg-neutral-900">
                  {room.kind}
                </span>
                <span className="ml-2 text-xs text-neutral-500">gen {room.current_generation}</span>
                {room.parent_room_id && (
                  <span className="ml-2 text-xs text-neutral-500">
                    ↳ child of {room.parent_room_id.slice(0, 8)}
                  </span>
                )}
              </div>
              <Link
                href={`/rooms/${room.id}`}
                className="rounded bg-neutral-900 px-2 py-1 text-xs text-white dark:bg-white dark:text-neutral-900"
              >
                open →
              </Link>
            </li>
          ))}
        </ul>
      </section>

      {identity && (
        <>
          <CreateRoomForm
            userId={userId}
            identity={identity}
            rooms={rooms}
            onCreated={() => void reload(userId)}
          />
          {rooms.length > 0 && (
            <InviteForm
              userId={userId}
              identity={identity}
              rooms={rooms}
              onInvited={() => void reload(userId)}
            />
          )}
        </>
      )}

      {error && <p className="text-sm text-red-600">Error: {error}</p>}
    </div>
  );
}

function InviteCard({
  invite,
  userId,
  identity,
  onDone,
}: {
  invite: RoomInviteRow;
  userId: string;
  identity: Identity;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function accept() {
    setBusy(true);
    setError(null);
    try {
      // Unwrap the room key using our own X25519 keypair.
      const wrappedBytes = await fromBase64(invite.wrapped_room_key);
      const roomKey = await unwrapRoomKey(
        { wrapped: wrappedBytes, generation: invite.generation },
        identity.x25519PublicKey,
        identity.x25519PrivateKey,
      );
      // Re-wrap for ourselves and insert room_members.
      const selfWrap = await wrapRoomKeyFor(roomKey, identity.x25519PublicKey);
      await addRoomMember({
        roomId: invite.room_id,
        userId,
        generation: invite.generation,
        wrappedRoomKey: selfWrap.wrapped,
      });
      await deleteInvite(invite.id);
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function decline() {
    setBusy(true);
    try {
      await deleteInvite(invite.id);
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded border border-blue-200 bg-blue-50 p-3 text-sm dark:border-blue-900 dark:bg-blue-950">
      <div>
        Invite to room{' '}
        <code className="font-mono text-xs">{invite.room_id.slice(0, 8)}</code>{' '}
        from <code className="font-mono text-xs">{invite.created_by.slice(0, 8)}</code>
      </div>
      <div className="mt-2 flex gap-2">
        <button
          onClick={() => void accept()}
          disabled={busy}
          className="rounded bg-neutral-900 px-2 py-1 text-xs text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
        >
          accept
        </button>
        <button
          onClick={() => void decline()}
          disabled={busy}
          className="rounded border border-neutral-300 px-2 py-1 text-xs disabled:opacity-50 dark:border-neutral-700"
        >
          decline
        </button>
      </div>
      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
    </div>
  );
}

function CreateRoomForm({
  userId,
  identity,
  rooms,
  onCreated,
}: {
  userId: string;
  identity: Identity;
  rooms: RoomRow[];
  onCreated: () => void;
}) {
  const [kind, setKind] = useState<'pair' | 'group'>('pair');
  const [parentId, setParentId] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const room = await createRoom({
        kind,
        parentRoomId: parentId || null,
        createdBy: userId,
      });
      const roomKey = await generateRoomKey(room.current_generation);
      const selfWrap = await wrapRoomKeyFor(roomKey, identity.x25519PublicKey);
      await addRoomMember({
        roomId: room.id,
        userId,
        generation: room.current_generation,
        wrappedRoomKey: selfWrap.wrapped,
      });
      onCreated();
      setParentId('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={create}
      className="space-y-3 rounded border border-neutral-200 p-4 dark:border-neutral-800"
    >
      <h2 className="text-base font-semibold">Create room</h2>
      <div className="flex gap-3 text-sm">
        <label className="flex items-center gap-1">
          <input
            type="radio"
            checked={kind === 'pair'}
            onChange={() => setKind('pair')}
          />{' '}
          pair (2-person)
        </label>
        <label className="flex items-center gap-1">
          <input
            type="radio"
            checked={kind === 'group'}
            onChange={() => setKind('group')}
          />{' '}
          group
        </label>
      </div>
      <div>
        <label className="text-xs text-neutral-500">
          parent room (optional; for pair-inside-group)
        </label>
        <select
          value={parentId}
          onChange={(e) => setParentId(e.target.value)}
          className="mt-1 block w-full rounded border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900"
        >
          <option value="">(none)</option>
          {rooms
            .filter((r) => r.kind === 'group')
            .map((r) => (
              <option key={r.id} value={r.id}>
                {r.id.slice(0, 8)} · {r.kind}
              </option>
            ))}
        </select>
      </div>
      <button
        type="submit"
        disabled={busy}
        className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
      >
        {busy ? 'creating…' : 'create'}
      </button>
      {error && <p className="text-xs text-red-600">{error}</p>}
    </form>
  );
}

function InviteForm({
  userId,
  identity,
  rooms,
  onInvited,
}: {
  userId: string;
  identity: Identity;
  rooms: RoomRow[];
  onInvited: () => void;
}) {
  const [roomId, setRoomId] = useState(rooms[0]?.id ?? '');
  const [inviteeId, setInviteeId] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      if (!roomId || !inviteeId) throw new Error('pick a room and enter a user id');
      const room = rooms.find((r) => r.id === roomId);
      if (!room) throw new Error('room not found');
      // Fetch the invitee's public identity.
      const inviteePub = await fetchIdentity(inviteeId);
      if (!inviteePub) throw new Error('that user has no published identity');
      // TOFU observation (emits key-change events if applicable). Best-effort —
      // a banner is informational and shouldn't abort the invite.
      try {
        await observeContact(inviteeId, inviteePub);
      } catch (err) {
        console.error('observeContact failed for invitee', inviteeId, errorMessage(err));
      }
      // Need our wrapped room key so we can unwrap the roomKey, then re-wrap for invitee.
      const myWrapped = await getMyWrappedRoomKey({
        roomId,
        userId,
        generation: room.current_generation,
      });
      if (!myWrapped) throw new Error('you are not a current-generation member of that room');
      const roomKey = await unwrapRoomKey(
        { wrapped: myWrapped, generation: room.current_generation },
        identity.x25519PublicKey,
        identity.x25519PrivateKey,
      );
      const inviteeWrap = await wrapRoomKeyFor(roomKey, inviteePub.x25519PublicKey);
      await createInvite({
        roomId,
        invitedUserId: inviteeId,
        invitedX25519Pub: inviteePub.x25519PublicKey,
        generation: room.current_generation,
        wrappedRoomKey: inviteeWrap.wrapped,
        createdBy: userId,
      });
      setStatus('Invite sent.');
      setInviteeId('');
      onInvited();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      className="space-y-3 rounded border border-neutral-200 p-4 dark:border-neutral-800"
    >
      <h2 className="text-base font-semibold">Invite someone</h2>
      <div>
        <label className="text-xs text-neutral-500">room</label>
        <select
          value={roomId}
          onChange={(e) => setRoomId(e.target.value)}
          className="mt-1 block w-full rounded border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900"
        >
          {rooms.map((r) => (
            <option key={r.id} value={r.id}>
              {r.id.slice(0, 8)} · {r.kind} · gen {r.current_generation}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className="text-xs text-neutral-500">
          invitee user ID (they copy it from their Rooms page)
        </label>
        <input
          type="text"
          value={inviteeId}
          onChange={(e) => setInviteeId(e.target.value.trim())}
          placeholder="00000000-0000-0000-0000-000000000000"
          className="mt-1 block w-full rounded border border-neutral-300 px-2 py-1 font-mono text-xs dark:border-neutral-700 dark:bg-neutral-900"
        />
      </div>
      <button
        type="submit"
        disabled={busy}
        className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
      >
        {busy ? 'sending…' : 'send invite'}
      </button>
      {status && <p className="text-xs text-emerald-600">{status}</p>}
      {error && <p className="text-xs text-red-600">{error}</p>}
    </form>
  );
}
