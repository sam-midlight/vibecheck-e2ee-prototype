'use client';

import { use, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { KeyChangeBanner } from '@/components/KeyChangeBanner';
import { errorMessage } from '@/lib/errors';
import { getSupabase } from '@/lib/supabase/client';
import {
  CryptoError,
  decryptBlob,
  decryptRoomName,
  encryptBlob,
  encryptRoomName,
  fromBase64,
  getIdentity,
  observeContact,
  rotateRoomKey,
  unwrapRoomKey,
  type Identity,
  type RoomKey,
} from '@/lib/e2ee-core';
import {
  addRoomMember,
  bumpRoomGeneration,
  decodeBlobRow,
  fetchIdentity,
  getMyWrappedRoomKey,
  insertBlob,
  listBlobs,
  listRoomMembers,
  renameRoom,
  subscribeBlobs,
  type BlobRow,
  type RoomMemberRow,
  type RoomRow,
} from '@/lib/supabase/queries';

interface DecodedBlob {
  id: string;
  senderId: string;
  createdAt: string;
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
  const [userId, setUserId] = useState<string | null>(null);
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [room, setRoom] = useState<RoomRow | null>(null);
  const [roomKey, setRoomKey] = useState<RoomKey | null>(null);
  const [roomName, setRoomName] = useState<string | null>(null);
  const [members, setMembers] = useState<RoomMemberRow[]>([]);
  const [blobs, setBlobs] = useState<DecodedBlob[]>([]);
  const [renameOpen, setRenameOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const roomKeyRef = useRef<RoomKey | null>(null);

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

      const wrapped = await getMyWrappedRoomKey({
        roomId,
        userId: uid,
        generation: roomRow.current_generation,
      });
      if (!wrapped) {
        throw new Error(
          'you are not a current-generation member of this room (may need to be re-invited)',
        );
      }
      const rk = await unwrapRoomKey(
        { wrapped, generation: roomRow.current_generation },
        id.x25519PublicKey,
        id.x25519PrivateKey,
      );
      setRoomKey(rk);
      roomKeyRef.current = rk;

      if (roomRow.name_ciphertext && roomRow.name_nonce) {
        try {
          const name = await decryptRoomName({
            ciphertext: await fromBase64(roomRow.name_ciphertext),
            nonce: await fromBase64(roomRow.name_nonce),
            roomId,
            roomKey: rk,
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
        rows.map((row) => decodeAndVerify(row, rk, id, uid)),
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

  // Subscribe to realtime blobs for this room.
  useEffect(() => {
    if (!identity || !userId) return;
    const unsub = subscribeBlobs(roomId, async (row) => {
      const rk = roomKeyRef.current;
      if (!rk) return;
      const decoded = await decodeAndVerify(row, rk, identity, userId);
      setBlobs((prev) => {
        if (prev.some((b) => b.id === decoded.id)) return prev;
        return [...prev, decoded];
      });
    });
    return unsub;
  }, [roomId, identity, userId]);

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
          </p>
        </div>
        <button
          onClick={() => setRenameOpen(true)}
          className="shrink-0 rounded border border-neutral-300 px-2 py-1 text-xs dark:border-neutral-700"
        >
          {roomName ? 'rename' : 'set name'}
        </button>
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
      />

      <BlobFeed blobs={blobs} selfUserId={userId} />

      <Composer
        roomId={roomId}
        userId={userId}
        identity={identity}
        roomKey={roomKey}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------

async function decodeAndVerify(
  row: BlobRow,
  rk: RoomKey,
  viewerIdentity: Identity,
  viewerUserId: string,
): Promise<DecodedBlob> {
  try {
    const blob = await decodeBlobRow(row);
    if (blob.generation !== rk.generation) {
      return {
        id: row.id,
        senderId: row.sender_id,
        createdAt: row.created_at,
        payload: null,
        verified: false,
        error: `blob is at generation ${blob.generation}, current room key is gen ${rk.generation}`,
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
      payload,
      verified: true,
    };
  } catch (e) {
    const message = e instanceof CryptoError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e);
    return {
      id: row.id,
      senderId: row.sender_id,
      createdAt: row.created_at,
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
}: {
  room: RoomRow;
  members: RoomMemberRow[];
  selfUserId: string;
  identity: Identity;
  roomKey: RoomKey;
  onChange: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function rotateOut(removedUserId: string) {
    if (!confirm(`Remove ${removedUserId.slice(0, 8)}… and rotate the room key?`)) return;
    setBusy(true);
    setError(null);
    try {
      const supabase = getSupabase();
      const keepMembers = members.filter((m) => m.user_id !== removedUserId);
      // Fetch each remaining member's X25519 pub.
      const keepPubs = await Promise.all(
        keepMembers.map(async (m) => {
          if (m.user_id === selfUserId) {
            return { userId: m.user_id, x25519Pub: identity.x25519PublicKey };
          }
          const pub = await fetchIdentity(m.user_id);
          if (!pub) throw new Error(`no identity for ${m.user_id}`);
          await observeContact(m.user_id, pub);
          return { userId: m.user_id, x25519Pub: pub.x25519PublicKey };
        }),
      );
      // Generate next room key and wrap per remaining member.
      const { next, wraps } = await rotateRoomKey(
        roomKey.generation,
        keepPubs.map((k) => k.x25519Pub),
      );
      // Insert new generation rows for each remaining member.
      for (let i = 0; i < keepPubs.length; i++) {
        await addRoomMember({
          roomId: room.id,
          userId: keepPubs[i].userId,
          generation: next.generation,
          wrappedRoomKey: wraps[i].wrapped,
        });
      }
      // If the room has an encrypted name, re-encrypt it under the new key so
      // remaining members can still read it at the new generation. Decrypt
      // with the old key first (AD is bound to generation).
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
          // Don't block rotation on a name-recrypt failure; clear the name instead.
          console.error('name re-encrypt failed, clearing', errorMessage(err));
          await renameRoom({ roomId: room.id, nameCiphertext: null, nameNonce: null });
        }
      }
      // Bump generation pointer.
      await bumpRoomGeneration(room.id, next.generation);
      // Delete removed user's rows (all generations for clean-up).
      await supabase
        .from('room_members')
        .delete()
        .eq('room_id', room.id)
        .eq('user_id', removedUserId);
      onChange();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded border border-neutral-200 p-3 text-sm dark:border-neutral-800">
      <h2 className="mb-2 text-sm font-semibold">Members (gen {room.current_generation})</h2>
      <ul className="space-y-1">
        {members.map((m) => (
          <li key={`${m.user_id}-${m.generation}`} className="flex items-center justify-between">
            <code className="font-mono text-xs text-neutral-500">
              {m.user_id}{m.user_id === selfUserId ? ' (you)' : ''}
            </code>
            {m.user_id !== selfUserId && (
              <button
                onClick={() => void rotateOut(m.user_id)}
                disabled={busy}
                className="rounded border border-red-300 px-2 py-0.5 text-xs text-red-700 disabled:opacity-50 dark:border-red-800 dark:text-red-400"
              >
                remove + rotate
              </button>
            )}
          </li>
        ))}
      </ul>
      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
    </section>
  );
}

// ---------------------------------------------------------------------------

function BlobFeed({ blobs, selfUserId }: { blobs: DecodedBlob[]; selfUserId: string }) {
  const sorted = useMemo(
    () => [...blobs].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    [blobs],
  );
  return (
    <section className="rounded border border-neutral-200 p-3 dark:border-neutral-800">
      <h2 className="mb-2 text-sm font-semibold">Messages</h2>
      {sorted.length === 0 && (
        <p className="text-sm text-neutral-500">no messages yet</p>
      )}
      <ul className="space-y-2">
        {sorted.map((b) => (
          <li
            key={b.id}
            className={`rounded px-3 py-2 text-sm ${b.senderId === selfUserId ? 'bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900' : 'bg-neutral-100 dark:bg-neutral-900'}`}
          >
            <div className="mb-1 flex items-center justify-between gap-2 text-[10px] uppercase tracking-wide opacity-70">
              <span>
                {b.senderId === selfUserId ? 'you' : `${b.senderId.slice(0, 8)}…`}
                {b.verified ? ' · ✓ signed' : ' · ✗ invalid'}
              </span>
              <span>{new Date(b.createdAt).toLocaleTimeString()}</span>
            </div>
            {b.verified ? (
              <pre className="whitespace-pre-wrap break-words font-mono text-xs">
                {safeStringify(b.payload)}
              </pre>
            ) : (
              <p className="text-xs text-red-500">error: {b.error}</p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
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
}: {
  roomId: string;
  userId: string;
  identity: Identity;
  roomKey: RoomKey;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!text.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const blob = await encryptBlob({
        payload: { text, ts: Date.now() },
        roomId,
        roomKey,
        senderEd25519PrivateKey: identity.ed25519PrivateKey,
      });
      await insertBlob({ roomId, senderId: userId, blob });
      setText('');
      // Realtime will deliver it back into the feed.
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={send} className="flex gap-2">
      <input
        type="text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="type a message…"
        className="flex-1 rounded border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
      />
      <button
        type="submit"
        disabled={busy}
        className="rounded bg-neutral-900 px-4 py-2 text-sm text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
      >
        send
      </button>
      {error && <p className="text-xs text-red-600">{error}</p>}
    </form>
  );
}

