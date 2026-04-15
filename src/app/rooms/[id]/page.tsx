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
  getIdentity,
  observeContact,
  prepareImageForUpload,
  rotateRoomKey,
  unwrapRoomKey,
  type ImageAttachmentHeader,
  type Identity,
  type RoomKey,
} from '@/lib/e2ee-core';
import {
  addRoomMember,
  bumpRoomGeneration,
  decodeBlobRow,
  deleteAttachment,
  deleteRoom,
  downloadAttachment,
  fetchIdentity,
  insertBlob,
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

interface DecodedBlob {
  id: string;
  senderId: string;
  createdAt: string;
  generation: number;
  payload: unknown;
  verified: boolean;
  error?: string;
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
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [room, setRoom] = useState<RoomRow | null>(null);
  const [roomKey, setRoomKey] = useState<RoomKey | null>(null);
  const [roomKeysByGen, setRoomKeysByGen] = useState<Map<number, RoomKey>>(
    () => new Map(),
  );
  const [roomName, setRoomName] = useState<string | null>(null);
  const [members, setMembers] = useState<RoomMemberRow[]>([]);
  const [blobs, setBlobs] = useState<DecodedBlob[]>([]);
  const [renameOpen, setRenameOpen] = useState(false);
  const [rtStatus, setRtStatus] = useState<string>('connecting');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const roomKeyRef = useRef<RoomKey | null>(null);
  const roomKeysByGenRef = useRef<Map<number, RoomKey>>(new Map());

  const loadAll = useCallback(
    async (uid: string, id: Identity) => {
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

      // Unwrap every generation the viewer is a member of. The current-gen
      // key is used for sending + rename; the full map lets us decrypt old
      // blobs after a key rotation.
      const myRows = await listMyRoomKeyRows(roomId, uid);
      const byGen = new Map<number, RoomKey>();
      for (const r of myRows) {
        try {
          const wrapped = await fromBase64(r.wrapped_room_key);
          const rk = await unwrapRoomKey(
            { wrapped, generation: r.generation },
            id.x25519PublicKey,
            id.x25519PrivateKey,
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
          'you are not a current-generation member of this room (may need to be re-invited)',
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
        rows.map((row) => decodeAndVerify(row, byGen, id, uid)),
      );
      setBlobs(decoded);
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
        const id = await getIdentity(data.user.id);
        if (!id) throw new Error('no local identity');
        setIdentity(id);
        await loadAll(data.user.id, id);
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
      if (byGen.size === 0 || !identity || !userId) return;
      const decoded = await decodeAndVerify(row, byGen, identity, userId);
      setBlobs((prev) => {
        if (prev.some((b) => b.id === decoded.id)) return prev;
        return [...prev, decoded];
      });
    },
    [identity, userId],
  );

  // Subscribe to realtime blobs for this room.
  useEffect(() => {
    if (!identity || !userId) return;
    const unsub = subscribeBlobs(
      roomId,
      (row) => {
        void ingestBlobRow(row);
      },
      (status) => setRtStatus(status),
    );
    return unsub;
  }, [roomId, identity, userId, ingestBlobRow]);

  if (loading) return <p className="text-sm text-neutral-500">loading…</p>;
  if (error) {
    return (
      <div className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
        {error}
      </div>
    );
  }
  if (!room || !identity || !userId || !roomKey) return null;

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
            // Also refresh the room row so name_ciphertext is current in state.
            void loadAll(userId, identity);
          }}
        />
      )}

      <MemberList
        room={room}
        members={members.filter((m) => m.generation === room.current_generation)}
        selfUserId={userId}
        identity={identity}
        roomKey={roomKey}
        onChange={() => void loadAll(userId, identity)}
        onLeft={() => router.replace('/rooms')}
      />

      <BlobFeed
        blobs={blobs}
        selfUserId={userId}
        roomId={roomId}
        roomKeysByGen={roomKeysByGen}
      />

      <Composer
        roomId={roomId}
        userId={userId}
        identity={identity}
        roomKey={roomKey}
        onSent={ingestBlobRow}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------

async function decodeAndVerify(
  row: BlobRow,
  roomKeysByGen: Map<number, RoomKey>,
  viewerIdentity: Identity,
  viewerUserId: string,
): Promise<DecodedBlob> {
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
        error: `no key for generation ${blob.generation} (you weren't a member at that time)`,
      };
    }
    // Need the sender's ed25519_pub. Fetch if not us.
    let senderEd: Uint8Array;
    if (row.sender_id === viewerUserId) {
      senderEd = viewerIdentity.ed25519PublicKey;
    } else {
      const pub = await fetchIdentity(row.sender_id);
      if (!pub) throw new Error('sender has no published identity');
      // TOFU is best-effort: a key-change banner shouldn't fail the decode.
      try {
        await observeContact(row.sender_id, pub);
      } catch (err) {
        console.error('observeContact failed for', row.sender_id, errorMessage(err));
      }
      senderEd = pub.ed25519PublicKey;
    }
    const payload = await decryptBlob<unknown>({
      blob,
      roomId: row.room_id,
      roomKey: rk,
      senderEd25519PublicKey: senderEd,
    });
    return {
      id: row.id,
      senderId: row.sender_id,
      createdAt: row.created_at,
      generation: blob.generation,
      payload,
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
  identity,
  roomKey,
  onChange,
  onLeft,
}: {
  room: RoomRow;
  members: RoomMemberRow[];
  selfUserId: string;
  identity: Identity;
  roomKey: RoomKey;
  onChange: () => void;
  onLeft: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isAdmin = room.created_by === selfUserId;

  /**
   * Rotate the room key for `keepUserIds`, re-encrypt the room name under
   * the new key, bump the generation pointer, and delete every row for
   * `removeUserIds` across all generations. Shared between the admin
   * "kick" path and the self-service "leave" path.
   */
  async function rotateAndRemove(params: {
    keep: RoomMemberRow[];
    removeUserIds: string[];
  }) {
    const supabase = getSupabase();
    const { keep, removeUserIds } = params;

    if (keep.length > 0) {
      const keepPubs = await Promise.all(
        keep.map(async (m) => {
          if (m.user_id === selfUserId) {
            return { userId: m.user_id, x25519Pub: identity.x25519PublicKey };
          }
          const pub = await fetchIdentity(m.user_id);
          if (!pub) throw new Error(`no identity for ${m.user_id}`);
          await observeContact(m.user_id, pub);
          return { userId: m.user_id, x25519Pub: pub.x25519PublicKey };
        }),
      );
      const { next, wraps } = await rotateRoomKey(
        roomKey.generation,
        keepPubs.map((k) => k.x25519Pub),
      );
      for (let i = 0; i < keepPubs.length; i++) {
        await addRoomMember({
          roomId: room.id,
          userId: keepPubs[i].userId,
          generation: next.generation,
          wrappedRoomKey: wraps[i].wrapped,
        });
      }
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
            await renameRoom({
              roomId: room.id,
              nameCiphertext: enc.ciphertext,
              nameNonce: enc.nonce,
            });
          }
        } catch (err) {
          console.error('name re-encrypt failed, clearing', errorMessage(err));
          await renameRoom({ roomId: room.id, nameCiphertext: null, nameNonce: null });
        }
      }
      await bumpRoomGeneration(room.id, next.generation);
    }
    for (const uid of removeUserIds) {
      await supabase
        .from('room_members')
        .delete()
        .eq('room_id', room.id)
        .eq('user_id', uid);
    }
  }

  async function kickMember(removedUserId: string) {
    if (!confirm(`Remove ${removedUserId.slice(0, 8)}… and rotate the room key?`)) return;
    setBusy(true);
    setError(null);
    try {
      const keep = members.filter((m) => m.user_id !== removedUserId);
      await rotateAndRemove({ keep, removeUserIds: [removedUserId] });
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
      await rotateAndRemove({ keep: remaining, removeUserIds: [selfUserId] });
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
      <ul className="space-y-1">
        {members.map((m) => {
          const self = m.user_id === selfUserId;
          return (
            <li
              key={`${m.user_id}-${m.generation}`}
              className="flex items-center justify-between"
            >
              <code className="font-mono text-xs text-neutral-500">
                {m.user_id}
                {self ? ' (you)' : ''}
                {m.user_id === room.created_by ? ' · admin' : ''}
              </code>
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
}: {
  blobs: DecodedBlob[];
  selfUserId: string;
  roomId: string;
  roomKeysByGen: Map<number, RoomKey>;
}) {
  const [showSystem, setShowSystem] = useState(false);
  const sorted = useMemo(
    () => [...blobs].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    [blobs],
  );
  const visible = useMemo(
    () => (showSystem ? sorted : sorted.filter((b) => !isSystemPayload(b.payload))),
    [sorted, showSystem],
  );
  const hiddenCount = sorted.length - visible.length;

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
                  {b.senderId === selfUserId ? 'you' : `${b.senderId.slice(0, 8)}…`}
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

function RealtimeBadge({ status }: { status: string }) {
  const live = status === 'SUBSCRIBED';
  const color = live
    ? 'text-emerald-600 dark:text-emerald-400'
    : 'text-amber-600 dark:text-amber-400';
  const dot = live ? '●' : '○';
  const label = live ? 'live' : status.toLowerCase();
  return (
    <span className={color} title={`realtime channel: ${status}`}>
      {dot} {label}
    </span>
  );
}

/** System noise emitted by /status (health probes). Not user content. */
function isSystemPayload(p: unknown): boolean {
  if (typeof p !== 'object' || p === null) return false;
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
  identity,
  roomKey,
  onSent,
}: {
  roomId: string;
  userId: string;
  identity: Identity;
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
        senderEd25519PrivateKey: identity.ed25519PrivateKey,
      });
      const row = await insertBlob({ roomId, senderId: userId, blob, id: blobId });
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
      senderEd25519PrivateKey: identity.ed25519PrivateKey,
    });
    const row = await insertBlob({ roomId, senderId: userId, blob });
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

