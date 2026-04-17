'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { KeyChangeBanner } from '@/components/KeyChangeBanner';
import { errorMessage } from '@/lib/errors';
import { getSupabase } from '@/lib/supabase/client';
import {
  CryptoError,
  decryptRoomName,
  encryptRoomName,
  fromBase64,
  generateRoomKey,
  observeContact,
  unwrapRoomKey,
  verifyInviteEnvelope,
  type DeviceKeyBundle,
  type PublicDevice,
} from '@/lib/e2ee-core';
import {
  createRoom,
  deleteInvite,
  deleteInvitesForUserInRoom,
  fetchPublicDevices,
  fetchUserMasterKeyPub,
  getMyWrappedRoomKey,
  listMyInvites,
  listMyRooms,
  renameRoom,
  subscribeInvites,
  type RoomInviteRow,
  type RoomRow,
} from '@/lib/supabase/queries';
import { loadEnrolledDevice, sendInviteToAllDevices, wrapRoomKeyForAllMyDevices } from '@/lib/bootstrap';
import { publicIdentityFingerprint, verifyPublicDevice as verifyPublicDeviceChain } from '@/lib/e2ee-core';

function bytesEq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

export default function RoomsPage() {
  return (
    <AppShell requireAuth>
      <RoomsInner />
    </AppShell>
  );
}

function RoomsInner() {
  const [userId, setUserId] = useState<string | null>(null);
  const [device, setDevice] = useState<DeviceKeyBundle | null>(null);
  const [rooms, setRooms] = useState<RoomRow[]>([]);
  const [invites, setInvites] = useState<RoomInviteRow[]>([]);
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!userId || !device || rooms.length === 0) return;
    let cancelled = false;
    (async () => {
      const pairs = await Promise.all(
        rooms.map(async (r): Promise<[string, string] | null> => {
          if (!r.name_ciphertext || !r.name_nonce) return null;
          try {
            const wrapped = await getMyWrappedRoomKey({
              roomId: r.id,
              deviceId: device.deviceId,
              generation: r.current_generation,
            });
            if (!wrapped) return null;
            const roomKey = await unwrapRoomKey(
              { wrapped, generation: r.current_generation },
              device.x25519PublicKey,
              device.x25519PrivateKey,
            );
            const name = await decryptRoomName({
              ciphertext: await fromBase64(r.name_ciphertext),
              nonce: await fromBase64(r.name_nonce),
              roomId: r.id,
              roomKey,
            });
            return name ? [r.id, name] : null;
          } catch (e) {
            console.error('room-name decrypt failed', r.id, errorMessage(e));
            return null;
          }
        }),
      );
      if (cancelled) return;
      setNames(new Map(pairs.filter((p): p is [string, string] => p !== null)));
    })();
    return () => {
      cancelled = true;
    };
  }, [userId, device, rooms]);

  const reload = useCallback(
    async (uid: string) => {
      try {
        const [r, i] = await Promise.all([listMyRooms(uid), listMyInvites(uid)]);
        setRooms(r);
        setInvites(i);
      } catch (e) {
        setError(errorMessage(e));
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
      const enrolled = await loadEnrolledDevice(data.user.id);
      setDevice(enrolled?.deviceBundle ?? null);
      await reload(data.user.id);
      setLoading(false);
    })();
  }, [reload]);

  // Realtime: when someone invites me, pop the new invite into the list.
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

  // Poll every 30s for new rooms + name changes from other devices.
  // room_members is not in the realtime publication (0009 removed it for
  // metadata reasons), so polling is the cross-device sync mechanism.
  useEffect(() => {
    if (!userId) return;
    const interval = setInterval(() => void reload(userId), 30_000);
    return () => clearInterval(interval);
  }, [userId, reload]);

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

      {device && (() => {
        // With per-device invites, multiple rows exist per invite (one per
        // invitee device). Only show the one addressed to THIS device.
        const myInvites = invites.filter(
          (i) => i.invited_device_id === device.deviceId,
        );
        if (myInvites.length === 0) return null;
        return (
          <section className="space-y-2">
            <h2 className="text-base font-semibold">Pending invites</h2>
            {myInvites.map((invite) => (
              <InviteCard
                key={invite.id}
                invite={invite}
                userId={userId}
                device={device}
                onDone={() => void reload(userId)}
              />
            ))}
          </section>
        );
      })()}

      <section>
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold">Your rooms</h2>
        </div>
        {rooms.length === 0 && (
          <p className="mt-2 text-sm text-neutral-500">No rooms yet. Create one below.</p>
        )}
        <ul className="mt-2 space-y-2">
          {rooms.map((room) => {
            const name = names.get(room.id);
            return (
              <li
                key={room.id}
                className="flex items-center justify-between rounded border border-neutral-200 px-3 py-2 text-sm dark:border-neutral-800"
              >
                <div className="min-w-0">
                  {name ? (
                    <span className="font-medium">{name}</span>
                  ) : (
                    <span className="font-mono text-xs text-neutral-500">
                      {room.id.slice(0, 8)}
                    </span>
                  )}
                  <span className="ml-2 rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] uppercase dark:bg-neutral-900">
                    {room.kind}
                  </span>
                  <span className="ml-2 text-xs text-neutral-500">
                    gen {room.current_generation}
                  </span>
                  {room.parent_room_id && (
                    <span className="ml-2 text-xs text-neutral-500">
                      ↳ child of {room.parent_room_id.slice(0, 8)}
                    </span>
                  )}
                </div>
                <Link
                  href={`/rooms/${room.id}`}
                  className="ml-2 rounded bg-neutral-900 px-2 py-1 text-xs text-white dark:bg-white dark:text-neutral-900"
                >
                  open →
                </Link>
              </li>
            );
          })}
        </ul>
      </section>

      {device && (
        <>
          <CreateRoomForm
            userId={userId}
            device={device}
            rooms={rooms}
            onCreated={() => void reload(userId)}
          />
          {rooms.length > 0 && (
            <InviteForm
              userId={userId}
              device={device}
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
  device,
  onDone,
}: {
  invite: RoomInviteRow;
  userId: string;
  device: DeviceKeyBundle;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inviterFingerprint, setInviterFingerprint] = useState<string | null>(null);

  // Show the inviter's UMK fingerprint (the stable root identity anchor).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const umkPub = await fetchUserMasterKeyPub(invite.created_by);
        if (cancelled || !umkPub) return;
        // Reuse the fingerprint helper with UMK pub as both halves — stable hash.
        setInviterFingerprint(
          await publicIdentityFingerprint({
            ed25519PublicKey: umkPub.ed25519PublicKey,
            x25519PublicKey: umkPub.ed25519PublicKey,
            selfSignature: new Uint8Array(0),
          }),
        );
      } catch {
        // non-fatal
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [invite.created_by]);

  async function accept() {
    setBusy(true);
    setError(null);
    try {
      // Fetch inviter's UMK pub and device list; find the signing device
      // and verify its cert.
      const inviterUmk = await fetchUserMasterKeyPub(invite.created_by);
      if (!inviterUmk) throw new Error('inviter has no published UMK');
      let inviterSskPub: Uint8Array | undefined;
      if (inviterUmk.sskPub && inviterUmk.sskCrossSignature) {
        try {
          const { verifySskCrossSignature } = await import('@/lib/e2ee-core');
          await verifySskCrossSignature(inviterUmk.ed25519PublicKey, inviterUmk.sskPub, inviterUmk.sskCrossSignature);
          inviterSskPub = inviterUmk.sskPub;
        } catch { /* fall back */ }
      }
      const inviterDevices = await fetchPublicDevices(invite.created_by);
      const inviterDev = inviterDevices.find(
        (d) => d.deviceId === invite.inviter_device_id,
      );
      if (!inviterDev) {
        throw new Error('inviter device not found in published device list');
      }
      try {
        await verifyPublicDeviceChain(inviterDev, inviterUmk.ed25519PublicKey, inviterSskPub);
      } catch {
        throw new Error(
          'inviter device cert did not verify — refusing',
        );
      }

      const tofuContact = {
        ed25519PublicKey: inviterUmk.ed25519PublicKey,
        x25519PublicKey: inviterDev.x25519PublicKey,
        selfSignature: new Uint8Array(0),
      };
      const tofu = await observeContact(invite.created_by, tofuContact);
      if (tofu.status === 'changed') {
        throw new Error(
          'inviter\'s UMK has changed — acknowledge the key change banner before accepting',
        );
      }

      const invitedEd = await fromBase64(invite.invited_ed25519_pub);
      const invitedX = await fromBase64(invite.invited_x25519_pub);
      const wrappedBytes = await fromBase64(invite.wrapped_room_key);
      const envSig = await fromBase64(invite.inviter_signature);
      if (
        !bytesEq(invitedEd, device.ed25519PublicKey) ||
        !bytesEq(invitedX, device.x25519PublicKey)
      ) {
        throw new Error(
          'invite pubkeys don\'t match this device — refusing',
        );
      }

      try {
        await verifyInviteEnvelope(
          {
            roomId: invite.room_id,
            generation: invite.generation,
            invitedUserId: userId,
            invitedDeviceId: device.deviceId,
            invitedDeviceEd25519PublicKey: invitedEd,
            invitedDeviceX25519PublicKey: invitedX,
            wrappedRoomKey: wrappedBytes,
            inviterUserId: invite.created_by,
            inviterDeviceId: invite.inviter_device_id,
            expiresAtMs: invite.expires_at_ms,
          },
          envSig,
          inviterDev.ed25519PublicKey,
        );
      } catch (err) {
        if (err instanceof CryptoError && err.code === 'SIGNATURE_INVALID') {
          throw new Error(
            'invite signature did not verify — refusing (possible server tampering)',
          );
        }
        throw err;
      }

      // Unwrap the room key using this device's X25519 keypair, then
      // wrap for ALL of our active devices so every device can read
      // this room immediately — not just the one that accepted.
      const roomKey = await unwrapRoomKey(
        { wrapped: wrappedBytes, generation: invite.generation },
        device.x25519PublicKey,
        device.x25519PrivateKey,
      );
      await wrapRoomKeyForAllMyDevices({
        roomId: invite.room_id,
        userId,
        roomKey,
        signerDevice: device,
      });
      // Re-share any Megolm sessions this device holds to all our other
      // devices so they can decrypt recent messages in this room.
      try {
        const { reshareSessionsToDevice } = await import('@/lib/bootstrap');
        const { fetchAndVerifyDevices } = await import('@/lib/bootstrap');
        const { devices: myDevices } = await fetchAndVerifyDevices(userId);
        for (const d of myDevices) {
          if (d.deviceId === device.deviceId) continue;
          await reshareSessionsToDevice({
            roomId: invite.room_id,
            userId,
            signerDevice: device,
            targetDeviceId: d.deviceId,
            targetX25519Pub: d.x25519PublicKey,
          });
        }
      } catch (err) {
        console.warn('Megolm session re-share on accept failed:', err);
      }
      // Delete ALL sibling invite rows for this user+room (one existed
      // per device). The accepted one is consumed; the rest are stale.
      await deleteInvitesForUserInRoom(invite.room_id, userId);
      onDone();
    } catch (e) {
      setError(errorMessage(e));
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
      setError(errorMessage(e));
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
      {inviterFingerprint && (
        <div className="mt-1 text-xs text-neutral-600 dark:text-neutral-400">
          inviter safety number: <code className="font-mono">{inviterFingerprint}</code>
          <br />
          <span className="text-neutral-500">
            confirm this matches the inviter out-of-band (phone, in person) before accepting
          </span>
        </div>
      )}
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
  device,
  rooms,
  onCreated,
}: {
  userId: string;
  device: DeviceKeyBundle;
  rooms: RoomRow[];
  onCreated: () => void;
}) {
  const [kind, setKind] = useState<'pair' | 'group'>('pair');
  const [parentId, setParentId] = useState<string>('');
  const [name, setName] = useState('');
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
      await wrapRoomKeyForAllMyDevices({
        roomId: room.id,
        userId,
        roomKey,
        signerDevice: device,
      });
      if (name.trim()) {
        const enc = await encryptRoomName({ name, roomId: room.id, roomKey });
        await renameRoom({
          roomId: room.id,
          nameCiphertext: enc.ciphertext,
          nameNonce: enc.nonce,
        });
      }
      onCreated();
      setParentId('');
      setName('');
    } catch (e) {
      setError(errorMessage(e));
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
      <div>
        <label className="text-xs text-neutral-500">name (optional, encrypted)</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={120}
          placeholder="e.g. dinner planning"
          className="mt-1 block w-full rounded border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900"
        />
      </div>
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
  device,
  rooms,
  onInvited,
}: {
  userId: string;
  device: DeviceKeyBundle;
  rooms: RoomRow[];
  onInvited: () => void;
}) {
  const [roomId, setRoomId] = useState(rooms[0]?.id ?? '');
  const [inviteeId, setInviteeId] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fullness, setFullness] = useState<Map<string, boolean>>(new Map());

  // For each room, check whether it's already at capacity (only meaningful
  // for kind='pair' — groups have no cap in this prototype). A room counts
  // as "full" if it already has 2 distinct user_ids across members + pending
  // invites — matching the DB trigger (0007) which dedupes by user_id. Since
  // 0015 a single user has one row per device, so counting rows would flag a
  // pair with one multi-device user as full.
  useEffect(() => {
    if (!userId || rooms.length === 0) {
      setFullness(new Map());
      return;
    }
    let cancelled = false;
    (async () => {
      const supabase = getSupabase();
      const entries = await Promise.all(
        rooms.map(async (r): Promise<[string, boolean]> => {
          if (r.kind !== 'pair') return [r.id, false];
          const [members, invites] = await Promise.all([
            supabase
              .from('room_members')
              .select('user_id')
              .eq('room_id', r.id)
              .eq('generation', r.current_generation),
            supabase
              .from('room_invites')
              .select('invited_user_id')
              .eq('room_id', r.id),
          ]);
          const users = new Set<string>();
          for (const row of (members.data ?? []) as { user_id: string }[]) {
            users.add(row.user_id);
          }
          for (const row of (invites.data ?? []) as { invited_user_id: string }[]) {
            users.add(row.invited_user_id);
          }
          return [r.id, users.size >= 2];
        }),
      );
      if (cancelled) return;
      setFullness(new Map(entries));
    })();
    return () => {
      cancelled = true;
    };
  }, [userId, rooms]);

  const currentRoom = rooms.find((r) => r.id === roomId);
  const currentRoomFull = currentRoom ? fullness.get(currentRoom.id) ?? false : false;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      if (!roomId || !inviteeId) throw new Error('pick a room and enter a user id');
      const room = rooms.find((r) => r.id === roomId);
      if (!room) throw new Error('room not found');
      if (room.kind === 'pair' && fullness.get(room.id)) {
        throw new Error(
          'this pair room already has two people — pair rooms are capped at 2',
        );
      }
      // Fetch + verify invitee's UMK pub and device list. Pick the most
      // recently created active device as the invite target. Later, that
      // device will rewrap for the invitee's other devices on accept.
      const inviteeUmk = await fetchUserMasterKeyPub(inviteeId);
      if (!inviteeUmk) throw new Error('that user has no published UMK');
      let inviteeSskPub2: Uint8Array | undefined;
      if (inviteeUmk.sskPub && inviteeUmk.sskCrossSignature) {
        try {
          const { verifySskCrossSignature } = await import('@/lib/e2ee-core');
          await verifySskCrossSignature(inviteeUmk.ed25519PublicKey, inviteeUmk.sskPub, inviteeUmk.sskCrossSignature);
          inviteeSskPub2 = inviteeUmk.sskPub;
        } catch { /* fall back */ }
      }
      const inviteeDevices = await fetchPublicDevices(inviteeId);
      const activeDevices: PublicDevice[] = [];
      for (const d of inviteeDevices) {
        try {
          await verifyPublicDeviceChain(d, inviteeUmk.ed25519PublicKey, inviteeSskPub2);
          activeDevices.push(d);
        } catch {
          // skip revoked/invalid devices
        }
      }
      if (activeDevices.length === 0) {
        throw new Error('invitee has no active signed devices');
      }

      const tofuContact = {
        ed25519PublicKey: inviteeUmk.ed25519PublicKey,
        x25519PublicKey: activeDevices[0].x25519PublicKey,
        selfSignature: new Uint8Array(0),
      };
      const tofu = await observeContact(inviteeId, tofuContact);
      if (tofu.status === 'changed') {
        throw new Error(
          'invitee\'s UMK has changed since you last saw it — acknowledge the key change before inviting',
        );
      }

      const myWrapped = await getMyWrappedRoomKey({
        roomId,
        deviceId: device.deviceId,
        generation: room.current_generation,
      });
      if (!myWrapped) throw new Error('you are not a current-generation member of that room');
      const roomKey = await unwrapRoomKey(
        { wrapped: myWrapped, generation: room.current_generation },
        device.x25519PublicKey,
        device.x25519PrivateKey,
      );
      // Matrix-style: wrap for EVERY active device the invitee has, so
      // they can accept from any device — not just whichever one we pick.
      await sendInviteToAllDevices({
        roomId,
        generation: room.current_generation,
        roomKey,
        invitedUserId: inviteeId,
        invitedActiveDevices: activeDevices,
        inviterUserId: userId,
        inviterDevice: device,
        expiresAtMs: Date.now() + 60 * 60 * 24 * 7 * 1000,
      });
      setStatus('Invite sent.');
      setInviteeId('');
      onInvited();
    } catch (e) {
      setError(errorMessage(e));
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
          {rooms.map((r) => {
            const full = fullness.get(r.id) ?? false;
            const base = `${r.id.slice(0, 8)} · ${r.kind} · gen ${r.current_generation}`;
            const label = full ? `${base} · full` : base;
            return (
              <option key={r.id} value={r.id} disabled={full}>
                {label}
              </option>
            );
          })}
        </select>
        {currentRoomFull && (
          <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">
            Pair rooms are capped at 2 people. Delete this one and create a
            new room, or pick a different room to invite to.
          </p>
        )}
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
        disabled={busy || currentRoomFull}
        className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
      >
        {busy ? 'sending…' : 'send invite'}
      </button>
      {status && <p className="text-xs text-emerald-600">{status}</p>}
      {error && <p className="text-xs text-red-600">{error}</p>}
    </form>
  );
}
