'use client';

import { use, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AppShell } from '@/components/AppShell';
import { KeyChangeBanner } from '@/components/KeyChangeBanner';
import { errorMessage } from '@/lib/errors';
import { getSupabase } from '@/lib/supabase/client';
import {
  CryptoError,
  decryptBlob,
  decryptImageAttachment,
  decryptRoomName,
  encryptBlob,
  encryptRoomName,
  fromBase64,
  observeContact,
  prepareImageForUpload,
  rotateRoomKey,
  signInviteEnvelope,
  signMembershipWrap,
  unwrapRoomKey,
  verifyMembershipWrap,
  verifyPublicDevice,
  wrapRoomKeyFor,
  type DeviceKeyBundle,
  type ImageAttachmentHeader,
  type PublicDevice,
  type RoomKey,
} from '@/lib/e2ee-core';
import {
  createInvite,
  decodeBlobRow,
  deleteAttachment,
  deleteRoom,
  downloadAttachment,
  fetchPublicDevices,
  fetchUserMasterKeyPub,
  insertBlob,
  kickAndRotate,
  listBlobs,
  listMyRoomKeyRows,
  listRoomMembers,
  renameRoom,
  subscribeBlobs,
  uploadAttachment,
  type BlobRow,
  type RoomMemberRow,
  type RoomRow,
} from '@/lib/supabase/queries';
import { loadEnrolledDevice } from '@/lib/bootstrap';

interface DecodedBlob {
  id: string;
  senderId: string;
  createdAt: string;
  generation: number;
  payload: unknown;
  verified: boolean;
  error?: string;
  /** True when this row exists but THIS device has no key for its generation
   *  (e.g. it was sent before we joined, or after we were kicked). We hide
   *  these from the feed rather than render "invalid" rows for them. */
  missingKey?: boolean;
}

/** Latest nickname a user has set in this room. Keyed by user_id. */
type NicknameMap = Map<string, { name: string; ts: number }>;

/** Nickname payload shape. */
interface NicknamePayload {
  type: 'nickname';
  name: string;
  ts: number;
}

const NICKNAME_MAX = 40;

function isNicknamePayload(p: unknown): p is NicknamePayload {
  if (typeof p !== 'object' || p === null) return false;
  const t = (p as { type?: unknown }).type;
  const n = (p as { name?: unknown }).name;
  const ts = (p as { ts?: unknown }).ts;
  return t === 'nickname' && typeof n === 'string' && typeof ts === 'number';
}

function updateNicknamesFromBlob(prev: NicknameMap, b: DecodedBlob): NicknameMap {
  if (!b.verified || !isNicknamePayload(b.payload)) return prev;
  const existing = prev.get(b.senderId);
  if (existing && existing.ts >= b.payload.ts) return prev;
  const next = new Map(prev);
  next.set(b.senderId, { name: b.payload.name, ts: b.payload.ts });
  return next;
}

function displayNameFor(
  userId: string,
  selfUserId: string,
  nicknames: NicknameMap,
): string {
  if (userId === selfUserId) return 'you';
  const nick = nicknames.get(userId);
  if (nick && nick.name.trim()) return nick.name;
  return `${userId.slice(0, 8)}…`;
}

export default function RoomDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: roomId } = use(params);
  return (
    <AppShell requireAuth>
      <RoomInner roomId={roomId} />
    </AppShell>
  );
}

function RoomInner({ roomId }: { roomId: string }) {
  const router = useRouter();
  const [userId, setUserId] = useState<string | null>(null);
  const [device, setDevice] = useState<DeviceKeyBundle | null>(null);
  const [room, setRoom] = useState<RoomRow | null>(null);
  const [roomKey, setRoomKey] = useState<RoomKey | null>(null);
  const [roomKeysByGen, setRoomKeysByGen] = useState<Map<number, RoomKey>>(
    () => new Map(),
  );
  const [roomName, setRoomName] = useState<string | null>(null);
  const [members, setMembers] = useState<RoomMemberRow[]>([]);
  const [blobs, setBlobs] = useState<DecodedBlob[]>([]);
  const [nicknames, setNicknames] = useState<NicknameMap>(() => new Map());
  const [renameOpen, setRenameOpen] = useState(false);
  const [rtStatus, setRtStatus] = useState<string>('connecting');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const roomKeyRef = useRef<RoomKey | null>(null);
  const roomKeysByGenRef = useRef<Map<number, RoomKey>>(new Map());

  const loadAll = useCallback(
    async (uid: string, dev: DeviceKeyBundle) => {
      const supabase = getSupabase();
      const { data: roomRow, error: roomErr } = await supabase
        .from('rooms')
        .select('*')
        .eq('id', roomId)
        .maybeSingle<RoomRow>();
      if (roomErr || !roomRow) {
        throw new Error(roomErr?.message ?? 'room not found');
      }
      setRoom(roomRow);

      // Unwrap every generation this DEVICE is a member of.
      const myRows = await listMyRoomKeyRows(roomId, dev.deviceId);
      const byGen = new Map<number, RoomKey>();
      for (const r of myRows) {
        try {
          const wrapped = await fromBase64(r.wrapped_room_key);
          const rk = await unwrapRoomKey(
            { wrapped, generation: r.generation },
            dev.x25519PublicKey,
            dev.x25519PrivateKey,
          );
          byGen.set(r.generation, rk);
        } catch (err) {
          console.error(
            `unwrap failed for room ${roomId} gen ${r.generation}`,
            errorMessage(err),
          );
        }
      }
      const current = byGen.get(roomRow.current_generation);
      if (!current) {
        throw new Error(
          'this device is not a current-generation member (may need re-invite or rewrap from another of your devices)',
        );
      }
      setRoomKey(current);
      roomKeyRef.current = current;
      setRoomKeysByGen(byGen);
      roomKeysByGenRef.current = byGen;

      if (roomRow.name_ciphertext && roomRow.name_nonce) {
        try {
          const name = await decryptRoomName({
            ciphertext: await fromBase64(roomRow.name_ciphertext),
            nonce: await fromBase64(roomRow.name_nonce),
            roomId,
            roomKey: current,
          });
          setRoomName(name);
        } catch (e) {
          console.error('room-name decrypt failed', errorMessage(e));
          setRoomName(null);
        }
      } else {
        setRoomName(null);
      }

      const mems = await listRoomMembers(roomId);
      setMembers(mems);

      const rows = await listBlobs(roomId);
      const decoded = await Promise.all(
        rows.map((row) => decodeAndVerify(row, byGen, uid)),
      );
      setBlobs(decoded);
      // Build the nickname map from the full history — the latest ts wins
      // per sender. Nickname blobs are stored alongside messages and
      // filtered out of the visible feed by isSystemPayload.
      let nickMap: NicknameMap = new Map();
      for (const b of decoded) nickMap = updateNicknamesFromBlob(nickMap, b);
      setNicknames(nickMap);
    },
    [roomId],
  );

  useEffect(() => {
    (async () => {
      try {
        const supabase = getSupabase();
        const { data } = await supabase.auth.getUser();
        if (!data.user) return;
        setUserId(data.user.id);
        const enrolled = await loadEnrolledDevice(data.user.id);
        if (!enrolled) throw new Error('no device bundle on this browser — re-link first');
        setDevice(enrolled.deviceBundle);
        await loadAll(data.user.id, enrolled.deviceBundle);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, [loadAll]);

  const ingestBlobRow = useCallback(
    async (row: BlobRow) => {
      const byGen = roomKeysByGenRef.current;
      if (byGen.size === 0 || !device || !userId) return;
      const decoded = await decodeAndVerify(row, byGen, userId);
      setBlobs((prev) => {
        if (prev.some((b) => b.id === decoded.id)) return prev;
        return [...prev, decoded];
      });
      setNicknames((prev) => updateNicknamesFromBlob(prev, decoded));
    },
    [device, userId],
  );

  useEffect(() => {
    if (!device || !userId) return;
    const unsub = subscribeBlobs(
      roomId,
      (row) => {
        void ingestBlobRow(row);
      },
      (status) => setRtStatus(status),
    );
    return unsub;
  }, [roomId, device, userId, ingestBlobRow]);

  if (loading) return <p className="text-sm text-neutral-500">loading…</p>;
  if (error) {
    return (
      <div className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
        {error}
      </div>
    );
  }
  if (!room || !device || !userId || !roomKey) return null;

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <KeyChangeBanner />

      <div className="flex items-baseline justify-between gap-3">
        <div className="min-w-0">
          <h1 className="truncate text-xl font-semibold">
            {roomName ?? (
              <span className="text-neutral-500">
                Room <code className="font-mono text-sm">{room.id.slice(0, 8)}</code>
              </span>
            )}
          </h1>
          <p className="text-xs text-neutral-500">
            {room.kind} · gen {room.current_generation} · {members.filter((m) => m.generation === room.current_generation).length} member(s)
            {roomName && (
              <>
                {' · '}
                <code className="font-mono">{room.id.slice(0, 8)}</code>
              </>
            )}
            {' · '}
            <RealtimeBadge status={rtStatus} />
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <button
            onClick={() => setRenameOpen(true)}
            className="rounded border border-neutral-300 px-2 py-1 text-xs dark:border-neutral-700"
          >
            {roomName ? 'rename' : 'set name'}
          </button>
          {room.created_by === userId && (
            <button
              onClick={async () => {
                const label = roomName ?? room.id.slice(0, 8);
                if (
                  !confirm(
                    `Delete room "${label}" for everyone?\n\nThis removes all members, invites, and every encrypted message in it. It cannot be undone.`,
                  )
                ) {
                  return;
                }
                try {
                  await deleteRoom(roomId);
                  router.replace('/rooms');
                } catch (e) {
                  setError(e instanceof Error ? e.message : String(e));
                }
              }}
              className="rounded border border-red-300 px-2 py-1 text-xs text-red-700 dark:border-red-800 dark:text-red-400"
            >
              delete
            </button>
          )}
        </div>
      </div>

      {renameOpen && (
        <RenameRoomDialog
          roomId={roomId}
          roomKey={roomKey}
          initialName={roomName ?? ''}
          onClose={() => setRenameOpen(false)}
          onSaved={(newName) => {
            setRoomName(newName);
            setRenameOpen(false);
            void loadAll(userId, device);
          }}
        />
      )}

      <MemberList
        room={room}
        members={members.filter((m) => m.generation === room.current_generation)}
        selfUserId={userId}
        device={device}
        roomKey={roomKey}
        nicknames={nicknames}
        onChange={() => void loadAll(userId, device)}
        onLeft={() => router.replace('/rooms')}
        onSendNickname={async (name) => {
          const blob = await encryptBlob({
            payload: { type: 'nickname', name, ts: Date.now() } satisfies NicknamePayload,
            roomId,
            roomKey,
            senderUserId: userId,
            senderDeviceId: device.deviceId,
            senderDeviceEd25519PrivateKey: device.ed25519PrivateKey,
          });
          const row = await insertBlob({
            roomId,
            senderId: userId,
            senderDeviceId: device.deviceId,
            blob,
          });
          await ingestBlobRow(row);
        }}
      />

      {room.created_by === userId && (
        <InRoomInviteForm
          room={room}
          roomName={roomName}
          userId={userId}
          device={device}
          roomKey={roomKey}
          currentMemberCount={
            members.filter((m) => m.generation === room.current_generation).length
          }
          onInvited={() => void loadAll(userId, device)}
        />
      )}

      <BlobFeed
        blobs={blobs}
        selfUserId={userId}
        roomId={roomId}
        roomKeysByGen={roomKeysByGen}
        nicknames={nicknames}
      />

      <Composer
        roomId={roomId}
        userId={userId}
        device={device}
        roomKey={roomKey}
        onSent={ingestBlobRow}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------

/**
 * Resolver cache: (userId, deviceId) -> verified device's ed25519 pub.
 * Built lazily as we decrypt blobs. Device certs are verified against the
 * user's UMK once per session; revoked/unverifiable devices are skipped.
 */
const deviceKeyCache: Map<string, Uint8Array | null> = new Map();
function cacheKey(userId: string, deviceId: string) {
  return `${userId}:${deviceId}`;
}

async function resolveSenderDeviceEd(
  userId: string,
  deviceId: string,
): Promise<Uint8Array | null> {
  const k = cacheKey(userId, deviceId);
  if (deviceKeyCache.has(k)) return deviceKeyCache.get(k) ?? null;
  const umk = await fetchUserMasterKeyPub(userId);
  if (!umk) {
    deviceKeyCache.set(k, null);
    return null;
  }
  const devices = await fetchPublicDevices(userId);
  const dev = devices.find((d) => d.deviceId === deviceId);
  if (!dev) {
    deviceKeyCache.set(k, null);
    return null;
  }
  try {
    await verifyPublicDevice(dev, umk.ed25519PublicKey);
  } catch {
    deviceKeyCache.set(k, null);
    return null;
  }
  // TOFU the UMK pub for this user.
  try {
    await observeContact(userId, {
      ed25519PublicKey: umk.ed25519PublicKey,
      x25519PublicKey: dev.x25519PublicKey,
      selfSignature: new Uint8Array(0),
    });
  } catch (err) {
    console.error('observeContact failed for', userId, errorMessage(err));
  }
  deviceKeyCache.set(k, dev.ed25519PublicKey);
  return dev.ed25519PublicKey;
}

async function decodeAndVerify(
  row: BlobRow,
  roomKeysByGen: Map<number, RoomKey>,
  viewerUserId: string,
): Promise<DecodedBlob> {
  void viewerUserId;
  try {
    const blob = await decodeBlobRow(row);
    const rk = roomKeysByGen.get(blob.generation);
    if (!rk) {
      return {
        id: row.id,
        senderId: row.sender_id,
        createdAt: row.created_at,
        generation: blob.generation,
        payload: null,
        verified: false,
        missingKey: true,
        error: `no key for generation ${blob.generation} (you weren't a member at that time)`,
      };
    }
    const decoded = await decryptBlob<unknown>({
      blob,
      roomId: row.room_id,
      roomKey: rk,
      resolveSenderDeviceEd25519Pub: resolveSenderDeviceEd,
    });
    return {
      id: row.id,
      senderId: decoded.senderUserId ?? row.sender_id,
      createdAt: row.created_at,
      generation: blob.generation,
      payload: decoded.payload,
      verified: true,
    };
  } catch (e) {
    const message = e instanceof CryptoError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e);
    return {
      id: row.id,
      senderId: row.sender_id,
      createdAt: row.created_at,
      generation: row.generation,
      payload: null,
      verified: false,
      error: message,
    };
  }
}

// ---------------------------------------------------------------------------

function MemberList({
  room,
  members,
  selfUserId,
  device,
  roomKey,
  nicknames,
  onChange,
  onLeft,
  onSendNickname,
}: {
  room: RoomRow;
  members: RoomMemberRow[];
  selfUserId: string;
  device: DeviceKeyBundle;
  roomKey: RoomKey;
  nicknames: NicknameMap;
  onChange: () => void;
  onLeft: () => void;
  onSendNickname: (name: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isAdmin = room.created_by === selfUserId;
  const selfNick = nicknames.get(selfUserId)?.name ?? '';
  const [nickDraft, setNickDraft] = useState(selfNick);
  const [nickBusy, setNickBusy] = useState(false);
  const [nickError, setNickError] = useState<string | null>(null);
  // Keep the edit box in sync if realtime delivers a new value for self.
  useEffect(() => {
    setNickDraft(selfNick);
  }, [selfNick]);

  async function saveNickname(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = nickDraft.trim();
    if (!trimmed) {
      setNickError('nickname cannot be empty');
      return;
    }
    if (trimmed.length > NICKNAME_MAX) {
      setNickError(`max ${NICKNAME_MAX} characters`);
      return;
    }
    if (trimmed === selfNick) return;
    setNickBusy(true);
    setNickError(null);
    try {
      await onSendNickname(trimmed);
    } catch (err) {
      setNickError(err instanceof Error ? err.message : String(err));
    } finally {
      setNickBusy(false);
    }
  }

  /**
   * Rotate the room key for all keepers' devices, sign each wrap with our
   * device's ed25519 priv, call the atomic RPC.
   */
  async function rotateAndRemove(params: {
    keeperMembers: RoomMemberRow[];
    removeUserIds: string[];
  }) {
    const { keeperMembers, removeUserIds } = params;

    const keeperUserIds = Array.from(new Set(keeperMembers.map((m) => m.user_id)));

    if (keeperUserIds.length === 0) {
      // Solo departing from what would become an empty room; clear self row.
      const supabase = getSupabase();
      for (const uid of removeUserIds) {
        await supabase
          .from('room_members')
          .delete()
          .eq('room_id', room.id)
          .eq('user_id', uid);
      }
      return;
    }

    // For each keeper user, verify UMK + pull the active device list.
    // Each device of a keeper gets its own wrap row at new gen.
    type Target = { userId: string; device: PublicDevice };
    const targets: Target[] = [];
    for (const uid of keeperUserIds) {
      if (uid === selfUserId) {
        targets.push({
          userId: uid,
          device: {
            userId: uid,
            deviceId: device.deviceId,
            ed25519PublicKey: device.ed25519PublicKey,
            x25519PublicKey: device.x25519PublicKey,
            createdAtMs: 0,
            issuanceSignature: new Uint8Array(0),
            revocation: null,
          },
        });
        continue;
      }
      const umk = await fetchUserMasterKeyPub(uid);
      if (!umk) throw new Error(`no published UMK for keeper ${uid.slice(0, 8)}`);
      const devices = await fetchPublicDevices(uid);
      let added = 0;
      for (const d of devices) {
        try {
          await verifyPublicDevice(d, umk.ed25519PublicKey);
        } catch {
          continue;
        }
        targets.push({ userId: uid, device: d });
        added += 1;
      }
      if (added === 0) {
        throw new Error(`keeper ${uid.slice(0, 8)} has no active signed devices`);
      }
    }

    // Trust for keepers is established at membership-change time (invite
    // accept cryptographically verifies the envelope against the signer
    // device's cert chain). We don't need to re-verify the keeper's current
    // wrap at rotation — but we DO refuse to proceed if we can't resolve
    // the keeper's devices (done above via fetchPublicDevices + verifyPublicDevice).
    void verifyMembershipWrap;

    const { next, wraps } = await rotateRoomKey(
      roomKey.generation,
      targets.map((t) => t.device.x25519PublicKey),
    );
    void wrapRoomKeyFor; // rotateRoomKey already wraps per recipient

    const wrapSigs = await Promise.all(
      targets.map((t, i) =>
        signMembershipWrap(
          {
            roomId: room.id,
            generation: next.generation,
            memberUserId: t.userId,
            memberDeviceId: t.device.deviceId,
            wrappedRoomKey: wraps[i].wrapped,
            signerDeviceId: device.deviceId,
          },
          device.ed25519PrivateKey,
        ),
      ),
    );

    // Re-encrypt the room name under the new key (if one is set). If decrypt
    // fails we fall through with null ciphertext, mirroring the pre-RPC
    // behavior of clearing the name rather than wedging the rotation.
    let newNameCiphertext: Uint8Array | null = null;
    let newNameNonce: Uint8Array | null = null;
    if (room.name_ciphertext && room.name_nonce) {
      try {
        const oldName = await decryptRoomName({
          ciphertext: await fromBase64(room.name_ciphertext),
          nonce: await fromBase64(room.name_nonce),
          roomId: room.id,
          roomKey,
        });
        if (oldName) {
          const enc = await encryptRoomName({
            name: oldName,
            roomId: room.id,
            roomKey: next,
          });
          newNameCiphertext = enc.ciphertext;
          newNameNonce = enc.nonce;
        }
      } catch (err) {
        console.error('name re-encrypt failed, clearing', errorMessage(err));
      }
    }

    // Atomic: RLS-safe evictee delete + new-gen inserts + gen bump + name,
    // all inside a single SECURITY DEFINER RPC. Concurrent rotations fail
    // fast via the conditional `current_generation` match.
    await kickAndRotate({
      roomId: room.id,
      evicteeUserIds: removeUserIds,
      oldGeneration: roomKey.generation,
      newGeneration: next.generation,
      wraps: targets.map((t, i) => ({
        userId: t.userId,
        deviceId: t.device.deviceId,
        wrappedRoomKey: wraps[i].wrapped,
        wrapSignature: wrapSigs[i],
      })),
      signerDeviceId: device.deviceId,
      nameCiphertext: newNameCiphertext,
      nameNonce: newNameNonce,
    });
  }

  async function kickMember(removedUserId: string) {
    if (!confirm(`Remove ${removedUserId.slice(0, 8)}… and rotate the room key?`)) return;
    setBusy(true);
    setError(null);
    try {
      const keeperMembers = members.filter((m) => m.user_id !== removedUserId);
      await rotateAndRemove({ keeperMembers, removeUserIds: [removedUserId] });
      onChange();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function rotateNow() {
    if (!isAdmin) return;
    const daysOld = room.last_rotated_at
      ? Math.floor((Date.now() - new Date(room.last_rotated_at).getTime()) / 86_400_000)
      : null;
    const note =
      daysOld != null
        ? `Last rotated ${daysOld} day(s) ago. `
        : '';
    if (
      !confirm(
        `${note}Rotate the room key now?\n\nThis bumps the generation, re-wraps the key for every current member, and forgets the previous key server-side — old messages stay readable on devices that have them cached, but an attacker who later steals the old ciphertext cannot decrypt history.`,
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await rotateAndRemove({ keeperMembers: members, removeUserIds: [] });
      onChange();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function leaveRoom() {
    const label = room.kind === 'pair' ? 'leave this pair' : 'leave this group';
    if (
      !confirm(
        `${label}?\n\nThe room key will be rotated so the remaining members' future messages stay private from you. Past messages you've already seen will still be readable on this device.`,
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const remaining = members.filter((m) => m.user_id !== selfUserId);
      await rotateAndRemove({ keeperMembers: remaining, removeUserIds: [selfUserId] });
      onLeft();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded border border-neutral-200 p-3 text-sm dark:border-neutral-800">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold">
          Members (gen {room.current_generation})
        </h2>
        <span className="text-[10px] uppercase tracking-wide text-neutral-500">
          {isAdmin ? 'you are the admin' : `admin: ${room.created_by.slice(0, 8)}…`}
        </span>
      </div>
      {isAdmin && (
        <div className="mb-2 flex items-center justify-between text-xs text-neutral-500">
          <span>
            {room.last_rotated_at
              ? `last rotated ${new Date(room.last_rotated_at).toLocaleDateString()}`
              : 'never rotated'}
          </span>
          <button
            onClick={() => void rotateNow()}
            disabled={busy}
            className="rounded border border-neutral-300 px-2 py-0.5 text-[11px] disabled:opacity-50 dark:border-neutral-700"
            title="Bump the key generation, re-wrap for all members, and purge older server-side wraps."
          >
            rotate now
          </button>
        </div>
      )}
      <form
        onSubmit={saveNickname}
        className="mb-2 flex items-center gap-2 rounded border border-neutral-200 px-2 py-1 text-xs dark:border-neutral-800"
      >
        <span className="text-neutral-500 shrink-0">your name here:</span>
        <input
          type="text"
          value={nickDraft}
          onChange={(e) => setNickDraft(e.target.value)}
          maxLength={NICKNAME_MAX}
          placeholder={`e.g. Sam (${selfUserId.slice(0, 4)})`}
          className="flex-1 rounded border border-neutral-300 px-2 py-0.5 text-xs dark:border-neutral-700 dark:bg-neutral-900"
        />
        <button
          type="submit"
          disabled={nickBusy || nickDraft.trim() === selfNick}
          className="rounded bg-neutral-900 px-2 py-0.5 text-[11px] text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
        >
          {nickBusy ? 'saving…' : 'save'}
        </button>
      </form>
      {nickError && (
        <p className="mb-2 text-xs text-red-600 dark:text-red-400">{nickError}</p>
      )}
      <ul className="space-y-1">
        {members.map((m) => {
          const self = m.user_id === selfUserId;
          const nick = nicknames.get(m.user_id)?.name?.trim();
          return (
            <li
              key={`${m.user_id}-${m.generation}`}
              className="flex items-center justify-between"
            >
              <span className="flex min-w-0 items-baseline gap-2">
                <span className="truncate font-medium">
                  {nick ?? `${m.user_id.slice(0, 8)}…`}
                  {self ? ' (you)' : ''}
                  {m.user_id === room.created_by ? ' · admin' : ''}
                </span>
                <code
                  className="font-mono text-[10px] text-neutral-500"
                  title={m.user_id}
                >
                  {m.user_id.slice(0, 8)}
                </code>
              </span>
              {isAdmin && !self && (
                <button
                  onClick={() => void kickMember(m.user_id)}
                  disabled={busy}
                  className="rounded border border-red-300 px-2 py-0.5 text-xs text-red-700 disabled:opacity-50 dark:border-red-800 dark:text-red-400"
                >
                  remove + rotate
                </button>
              )}
              {!isAdmin && self && (
                <button
                  onClick={() => void leaveRoom()}
                  disabled={busy}
                  className="rounded border border-amber-300 px-2 py-0.5 text-xs text-amber-800 disabled:opacity-50 dark:border-amber-800 dark:text-amber-300"
                >
                  leave
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {!isAdmin && (
        <p className="mt-2 text-[11px] text-neutral-500">
          Only the room admin can remove other members. You can leave this
          room yourself.
        </p>
      )}
      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
    </section>
  );
}

// ---------------------------------------------------------------------------

function BlobFeed({
  blobs,
  selfUserId,
  roomId,
  roomKeysByGen,
  nicknames,
}: {
  blobs: DecodedBlob[];
  selfUserId: string;
  roomId: string;
  roomKeysByGen: Map<number, RoomKey>;
  nicknames: NicknameMap;
}) {
  const [showSystem, setShowSystem] = useState(false);
  const sorted = useMemo(
    () => [...blobs].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    [blobs],
  );
  // Always drop rows this device can't decrypt (wrong generation). They're
  // from periods you weren't a member of the room; surfacing them just adds
  // noise and confuses returning members who were re-invited after a kick.
  const decryptable = useMemo(() => sorted.filter((b) => !b.missingKey), [sorted]);
  const visible = useMemo(
    () =>
      showSystem
        ? decryptable
        : decryptable.filter((b) => !isSystemPayload(b.payload)),
    [decryptable, showSystem],
  );
  const hiddenCount = decryptable.length - visible.length;

  return (
    <section className="rounded border border-neutral-200 p-3 dark:border-neutral-800">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold">Messages</h2>
        {hiddenCount > 0 && !showSystem && (
          <button
            onClick={() => setShowSystem(true)}
            className="text-xs text-neutral-500 underline underline-offset-2 hover:text-neutral-700 dark:hover:text-neutral-300"
          >
            show {hiddenCount} system event{hiddenCount === 1 ? '' : 's'}
          </button>
        )}
        {showSystem && (
          <button
            onClick={() => setShowSystem(false)}
            className="text-xs text-neutral-500 underline underline-offset-2 hover:text-neutral-700 dark:hover:text-neutral-300"
          >
            hide system events
          </button>
        )}
      </div>
      {visible.length === 0 && (
        <p className="text-sm text-neutral-500">no messages yet</p>
      )}
      <ul className="space-y-2">
        {visible.map((b) => {
          const selfBubble =
            b.senderId === selfUserId
              ? 'bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900'
              : 'bg-neutral-100 dark:bg-neutral-900';
          const imageHeader = b.verified ? asImagePayload(b.payload) : null;
          return (
            <li key={b.id} className={`rounded px-3 py-2 text-sm ${selfBubble}`}>
              <div className="mb-1 flex items-center justify-between gap-2 text-[10px] uppercase tracking-wide opacity-70">
                <span>
                  {displayNameFor(b.senderId, selfUserId, nicknames)}
                  {b.verified ? ' · ✓ signed' : ' · ✗ invalid'}
                </span>
                <span>{new Date(b.createdAt).toLocaleTimeString()}</span>
              </div>
              {!b.verified ? (
                <p className="text-xs text-red-500">error: {b.error}</p>
              ) : imageHeader ? (
                <ImageAttachment
                  roomId={roomId}
                  blobId={b.id}
                  generation={b.generation}
                  header={imageHeader}
                  roomKeysByGen={roomKeysByGen}
                />
              ) : (
                <pre className="whitespace-pre-wrap break-words font-mono text-xs">
                  {safeStringify(b.payload)}
                </pre>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Type-narrow a decoded blob payload to an image attachment header. */
function asImagePayload(p: unknown): ImageAttachmentHeader | null {
  if (typeof p !== 'object' || p === null) return null;
  const obj = p as Record<string, unknown>;
  if (obj.type !== 'image') return null;
  if (typeof obj.mime !== 'string') return null;
  if (typeof obj.w !== 'number' || typeof obj.h !== 'number') return null;
  if (typeof obj.placeholder !== 'string') return null;
  if (typeof obj.byteLen !== 'number') return null;
  return obj as unknown as ImageAttachmentHeader;
}

function ImageAttachment({
  roomId,
  blobId,
  generation,
  header,
  roomKeysByGen,
}: {
  roomId: string;
  blobId: string;
  generation: number;
  header: ImageAttachmentHeader;
  roomKeysByGen: Map<number, RoomKey>;
}) {
  const [fullUrl, setFullUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let createdUrl: string | null = null;
    (async () => {
      try {
        const rk = roomKeysByGen.get(generation);
        if (!rk) {
          throw new Error(
            `no key for generation ${generation} (you weren't a member at that time)`,
          );
        }
        const encrypted = await downloadAttachment({ roomId, blobId });
        const plaintext = await decryptImageAttachment({
          encryptedBytes: encrypted,
          roomKey: rk,
          roomId,
          blobId,
          generation,
        });
        if (cancelled) return;
        const blob = new Blob([plaintext.slice().buffer as ArrayBuffer], { type: header.mime });
        createdUrl = URL.createObjectURL(blob);
        setFullUrl(createdUrl);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
      if (createdUrl) URL.revokeObjectURL(createdUrl);
    };
    // roomKeysByGen identity is stable across renders (state Map) unless
    // generations change; adding it to deps would retrigger spuriously.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, blobId, generation, header.mime]);

  // Reserve layout space so the feed doesn't jump when the full image lands.
  const aspect = header.w > 0 && header.h > 0 ? `${header.w} / ${header.h}` : '4 / 3';
  const src = fullUrl ?? header.placeholder;

  return (
    <div
      className="relative max-w-full overflow-hidden rounded"
      style={{ aspectRatio: aspect, maxWidth: Math.min(header.w, 520) }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt=""
        width={header.w}
        height={header.h}
        className={`h-full w-full object-cover transition ${fullUrl ? '' : 'scale-105 blur-lg'}`}
      />
      {error && (
        <div className="absolute inset-x-0 bottom-0 bg-red-700/85 px-2 py-1 text-[10px] text-white">
          failed to load image: {error}
        </div>
      )}
    </div>
  );
}

// Supabase Realtime tenants on free tier sleep when idle and cold-start on the
/**
 * In-room invite form (admin only). Mirrors the rooms-page InviteForm but
 * pre-scoped to the current room — no room-picker, lifts pair-cap awareness
 * from the member count already loaded in state.
 */
function InRoomInviteForm({
  room,
  roomName,
  userId,
  device,
  roomKey,
  currentMemberCount,
  onInvited,
}: {
  room: RoomRow;
  roomName: string | null;
  userId: string;
  device: DeviceKeyBundle;
  roomKey: RoomKey;
  currentMemberCount: number;
  onInvited: () => void;
}) {
  const [inviteeId, setInviteeId] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const pairFull = room.kind === 'pair' && currentMemberCount >= 2;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      if (!inviteeId.trim()) throw new Error('enter a user id');
      if (pairFull) {
        throw new Error('pair rooms are capped at 2; remove someone first');
      }
      if (inviteeId === userId) {
        throw new Error("that's your own user id");
      }

      const inviteeUmk = await fetchUserMasterKeyPub(inviteeId);
      if (!inviteeUmk) throw new Error('that user has no published UMK');
      const inviteeDevices = await fetchPublicDevices(inviteeId);
      const active: PublicDevice[] = [];
      for (const d of inviteeDevices) {
        try {
          await verifyPublicDevice(d, inviteeUmk.ed25519PublicKey);
          active.push(d);
        } catch {
          // skip revoked/invalid
        }
      }
      if (active.length === 0) throw new Error('invitee has no active signed devices');
      const targetDev = active[active.length - 1];

      const tofu = await observeContact(inviteeId, {
        ed25519PublicKey: inviteeUmk.ed25519PublicKey,
        x25519PublicKey: targetDev.x25519PublicKey,
        selfSignature: new Uint8Array(0),
      });
      if (tofu.status === 'changed') {
        throw new Error(
          "invitee's UMK has changed since you last saw it — acknowledge the key change before inviting",
        );
      }

      const inviteeWrap = await wrapRoomKeyFor(roomKey, targetDev.x25519PublicKey);
      const expiresAtMs = Date.now() + 60 * 60 * 24 * 7 * 1000;
      const envelopeSig = await signInviteEnvelope(
        {
          roomId: room.id,
          generation: room.current_generation,
          invitedUserId: inviteeId,
          invitedDeviceId: targetDev.deviceId,
          invitedDeviceEd25519PublicKey: targetDev.ed25519PublicKey,
          invitedDeviceX25519PublicKey: targetDev.x25519PublicKey,
          wrappedRoomKey: inviteeWrap.wrapped,
          inviterUserId: userId,
          inviterDeviceId: device.deviceId,
          expiresAtMs,
        },
        device.ed25519PrivateKey,
      );
      await createInvite({
        roomId: room.id,
        invitedUserId: inviteeId,
        invitedDeviceId: targetDev.deviceId,
        invitedEd25519Pub: targetDev.ed25519PublicKey,
        invitedX25519Pub: targetDev.x25519PublicKey,
        generation: room.current_generation,
        wrappedRoomKey: inviteeWrap.wrapped,
        createdBy: userId,
        inviterDeviceId: device.deviceId,
        inviterSignature: envelopeSig,
        expiresAtMs,
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
      className="space-y-2 rounded border border-neutral-200 p-3 text-sm dark:border-neutral-800"
    >
      <h3 className="text-sm font-semibold">
        Invite someone to{' '}
        {roomName ? (
          <span>&ldquo;{roomName}&rdquo;</span>
        ) : (
          <code className="font-mono text-xs">{room.id.slice(0, 8)}</code>
        )}
      </h3>
      <div className="flex gap-2">
        <input
          type="text"
          value={inviteeId}
          onChange={(e) => setInviteeId(e.target.value)}
          placeholder="user id (uuid)"
          className="flex-1 rounded border border-neutral-300 px-2 py-1 font-mono text-xs dark:border-neutral-700 dark:bg-neutral-900"
        />
        <button
          type="submit"
          disabled={busy || pairFull}
          className="rounded bg-neutral-900 px-3 py-1 text-xs text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
        >
          {busy ? 'sending…' : 'invite'}
        </button>
      </div>
      {pairFull && (
        <p className="text-xs text-amber-700 dark:text-amber-400">
          Pair rooms are 2 people; remove someone first.
        </p>
      )}
      {status && <p className="text-xs text-emerald-700 dark:text-emerald-400">{status}</p>}
      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
    </form>
  );
}

// next subscribe. That handshake can flash CHANNEL_ERROR / TIMED_OUT for a few
// seconds before flipping to SUBSCRIBED. Showing the raw amber "channel_error"
// immediately makes the app look broken when it's actually just waking up, so
// we hold a neutral "connecting…" state for the first GRACE_MS and only
// escalate to the amber warning if the channel is still unhealthy after that.
const REALTIME_WARNING_GRACE_MS = 5000;

function RealtimeBadge({ status }: { status: string }) {
  if (status === 'SUBSCRIBED') {
    return (
      <span
        className="text-emerald-600 dark:text-emerald-400"
        title="realtime channel: SUBSCRIBED"
      >
        ● live
      </span>
    );
  }
  // Remount per status change via the `key` prop — that starts pastGrace
  // fresh and restarts the grace timer without a synchronous setState
  // reset inside the effect.
  return <NonLiveBadge key={status} status={status} />;
}

function NonLiveBadge({ status }: { status: string }) {
  const [pastGrace, setPastGrace] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setPastGrace(true), REALTIME_WARNING_GRACE_MS);
    return () => clearTimeout(t);
  }, []);

  if (!pastGrace) {
    return (
      <span
        className="text-neutral-500"
        title={`realtime channel: ${status} (waking up — free-tier tenants cold-start on first subscribe)`}
      >
        ○ connecting…
      </span>
    );
  }
  return (
    <span
      className="text-amber-600 dark:text-amber-400"
      title={`realtime channel: ${status}`}
    >
      ○ {status.toLowerCase()}
    </span>
  );
}

/** System noise not displayed in the message feed: /status probes +
 *  nickname payloads (nicknames surface in member-list + sender labels). */
function isSystemPayload(p: unknown): boolean {
  if (typeof p !== 'object' || p === null) return false;
  if (isNicknamePayload(p)) return true;
  const kind = (p as { kind?: unknown }).kind;
  return typeof kind === 'string' && kind.startsWith('status-');
}

function safeStringify(p: unknown): string {
  if (typeof p === 'object' && p !== null && 'text' in p && typeof (p as { text: unknown }).text === 'string') {
    return (p as { text: string }).text;
  }
  try {
    return JSON.stringify(p, null, 2);
  } catch {
    return String(p);
  }
}

// ---------------------------------------------------------------------------

function RenameRoomDialog({
  roomId,
  roomKey,
  initialName,
  onClose,
  onSaved,
}: {
  roomId: string;
  roomKey: RoomKey;
  initialName: string;
  onClose: () => void;
  onSaved: (name: string) => void;
}) {
  const [name, setName] = useState(initialName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const trimmed = name.trim();
      if (!trimmed) {
        await renameRoom({ roomId, nameCiphertext: null, nameNonce: null });
        onSaved('');
        return;
      }
      const enc = await encryptRoomName({ name: trimmed, roomId, roomKey });
      await renameRoom({
        roomId,
        nameCiphertext: enc.ciphertext,
        nameNonce: enc.nonce,
      });
      onSaved(trimmed);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <form
        onSubmit={save}
        className="w-full max-w-md space-y-3 rounded-lg bg-white p-5 shadow-xl dark:bg-neutral-900"
      >
        <h2 className="text-base font-semibold">Rename room</h2>
        <p className="text-xs text-neutral-500">
          The name is encrypted with the room key — members see it, the server
          only sees ciphertext. Leave blank to clear the name.
        </p>
        <input
          type="text"
          value={name}
          autoFocus
          onChange={(e) => setName(e.target.value)}
          maxLength={120}
          placeholder="e.g. dinner planning"
          className="block w-full rounded border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-950"
        />
        {error && <p className="text-xs text-red-600">{error}</p>}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-neutral-300 px-3 py-1.5 text-xs dark:border-neutral-700"
          >
            cancel
          </button>
          <button
            type="submit"
            disabled={busy}
            className="rounded bg-neutral-900 px-3 py-1.5 text-xs text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
          >
            {busy ? 'saving…' : 'save'}
          </button>
        </div>
      </form>
    </div>
  );
}

function Composer({
  roomId,
  userId,
  device,
  roomKey,
  onSent,
}: {
  roomId: string;
  userId: string;
  device: DeviceKeyBundle;
  roomKey: RoomKey;
  onSent: (row: BlobRow) => void;
}) {
  const [text, setText] = useState('');
  const [pendingImage, setPendingImage] = useState<File | null>(null);
  const [pendingImagePreview, setPendingImagePreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  function choosePendingImage(file: File | null) {
    if (pendingImagePreview) URL.revokeObjectURL(pendingImagePreview);
    setPendingImage(file);
    setPendingImagePreview(file ? URL.createObjectURL(file) : null);
  }

  useEffect(() => {
    return () => {
      if (pendingImagePreview) URL.revokeObjectURL(pendingImagePreview);
    };
  }, [pendingImagePreview]);

  async function sendImage() {
    if (!pendingImage) return;
    const blobId = crypto.randomUUID();
    let uploaded = false;
    try {
      const { encryptedBytes, header } = await prepareImageForUpload({
        file: pendingImage,
        roomKey,
        roomId,
        blobId,
      });
      await uploadAttachment({ roomId, blobId, encryptedBytes });
      uploaded = true;
      const blob = await encryptBlob({
        payload: header,
        roomId,
        roomKey,
        senderUserId: userId,
        senderDeviceId: device.deviceId,
        senderDeviceEd25519PrivateKey: device.ed25519PrivateKey,
      });
      const row = await insertBlob({
        roomId,
        senderId: userId,
        senderDeviceId: device.deviceId,
        blob,
        id: blobId,
      });
      choosePendingImage(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
      onSent(row);
    } catch (e) {
      // Roll back the storage object if the blobs-row insert failed after upload.
      if (uploaded) {
        await deleteAttachment({ roomId, blobId }).catch((err) => {
          console.warn('rollback delete failed', errorMessage(err));
        });
      }
      throw e;
    }
  }

  async function sendText() {
    const trimmed = text.trim();
    if (!trimmed) return;
    const blob = await encryptBlob({
      payload: { text: trimmed, ts: Date.now() },
      roomId,
      roomKey,
      senderUserId: userId,
      senderDeviceId: device.deviceId,
      senderDeviceEd25519PrivateKey: device.ed25519PrivateKey,
    });
    const row = await insertBlob({
      roomId,
      senderId: userId,
      senderDeviceId: device.deviceId,
      blob,
    });
    setText('');
    onSent(row);
  }

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!pendingImage && !text.trim()) return;
    setBusy(true);
    setError(null);
    try {
      if (pendingImage) await sendImage();
      if (text.trim()) await sendText();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={send} className="space-y-2">
      {pendingImagePreview && pendingImage && (
        <div className="flex items-center gap-3 rounded border border-neutral-300 bg-neutral-50 p-2 text-xs dark:border-neutral-700 dark:bg-neutral-950">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={pendingImagePreview}
            alt=""
            className="h-16 w-16 shrink-0 rounded object-cover"
          />
          <div className="min-w-0 flex-1">
            <div className="truncate font-medium">{pendingImage.name}</div>
            <div className="text-[11px] text-neutral-500">
              {(pendingImage.size / 1024).toFixed(0)} KB · will be re-encoded + encrypted before upload
            </div>
          </div>
          <button
            type="button"
            onClick={() => choosePendingImage(null)}
            className="rounded border border-neutral-300 px-2 py-1 text-[11px] dark:border-neutral-700"
          >
            remove
          </button>
        </div>
      )}
      <div className="flex items-stretch gap-2">
        <label
          title="attach image"
          className="flex cursor-pointer items-center rounded border border-neutral-300 px-3 text-sm hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-900"
        >
          📎
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0] ?? null;
              choosePendingImage(f);
            }}
          />
        </label>
        <input
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={pendingImage ? 'add a caption (optional)…' : 'type a message…'}
          className="flex-1 rounded border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
        />
        <button
          type="submit"
          disabled={busy || (!pendingImage && !text.trim())}
          className="rounded bg-neutral-900 px-4 py-2 text-sm text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
        >
          {busy ? 'sending…' : 'send'}
        </button>
      </div>
      {error && <p className="text-xs text-red-600">{error}</p>}
    </form>
  );
}

