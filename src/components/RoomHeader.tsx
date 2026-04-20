'use client';

/**
 * Room header with inline rename.
 *
 * The name comes from the encrypted event stream (latest `room_rename`
 * event wins) — the server never learns it. Blank name reverts to the
 * default "Room {id8}" rendering.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  decryptRoomName,
  encryptRoomName,
  fromBase64,
} from '@/lib/e2ee-core';
import { describeError } from '@/lib/domain/errors';
import { loadRoomNameHint, saveRoomNameHint } from '@/lib/domain/roomNameHints';
import { fetchActiveCallForRoom, subscribeRoomCalls, updateRoomName } from '@/lib/supabase/queries';
import { InviteModal } from './InviteToRoomModal';
import { useRoom } from './RoomProvider';

export function RoomHeader() {
  const router = useRouter();
  const { room, roomKey, events, appendEvent } = useRoom();

  // Track whether a call is currently active in this room so the button can
  // surface "join" vs "call" affordances. Combine an initial fetch with the
  // calls realtime subscription (rows INSERT on start, UPDATE on end).
  const [hasActiveCall, setHasActiveCall] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  useEffect(() => {
    if (!room) return;
    let cancelled = false;
    void fetchActiveCallForRoom(room.id)
      .then((row) => {
        if (!cancelled) setHasActiveCall(!!row && row.ended_at == null);
      })
      .catch(() => {
        /* non-fatal; button just renders as 'start' */
      });
    const unsub = subscribeRoomCalls(room.id, (row, _event) => {
      if (!row) return;
      setHasActiveCall(row.ended_at == null);
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, [room]);

  const customName = useMemo(() => {
    let latestTs = 0;
    let latestName = '';
    for (const rec of events) {
      if (rec.event.type !== 'room_rename') continue;
      if (rec.event.ts > latestTs) {
        latestTs = rec.event.ts;
        latestName = rec.event.name;
      }
    }
    const trimmed = latestName.trim();
    return trimmed.length > 0 ? trimmed : null;
  }, [events]);

  // Column fallback: joiners may have missed a room_rename event from a
  // prior generation (their current roomKey can't decrypt older blobs,
  // so the rename falls out of their event stream). The encrypted column
  // on the rooms row survives that — if it decrypts with our roomKey we
  // prefer it over the default name.
  const [columnName, setColumnName] = useState<string | null>(null);
  useEffect(() => {
    if (!room || !roomKey) {
      setColumnName(null);
      return;
    }
    if (!room.name_ciphertext || !room.name_nonce) {
      setColumnName(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const ct = await fromBase64(room.name_ciphertext!);
        const nonce = await fromBase64(room.name_nonce!);
        const decrypted = await decryptRoomName({
          ciphertext: ct,
          nonce,
          roomId: room.id,
          roomKey,
        });
        if (cancelled) return;
        const trimmed = (decrypted ?? '').trim();
        setColumnName(trimmed.length > 0 ? trimmed : null);
      } catch {
        // Column was sealed under an older generation's key — not fatal.
        if (!cancelled) setColumnName(null);
      }
    })();
    return () => { cancelled = true; };
  }, [room, roomKey]);

  // Per-device fallback stashed when the user accepted an invite that
  // carried the room name. Survives across the event-stream + column
  // paths both failing for a joiner.
  const nameHint = useMemo(
    () => (room ? loadRoomNameHint(room.id) : null),
    [room],
  );

  const defaultName = room ? `Room ${room.id.slice(0, 8)}` : 'Room';
  // Resolution order: live partner rename (event) → rooms-row column →
  // local invite-carried hint → default.
  const displayName = customName ?? columnName ?? nameHint ?? defaultName;

  // Whenever we successfully resolve a name from either a live path (event
  // or column), backfill the hint so future loads render instantly. Keeps
  // the local stash in sync if the owner renames after the invite was sent.
  useEffect(() => {
    if (!room) return;
    const resolved = customName ?? columnName;
    if (!resolved) return;
    if (resolved === nameHint) return;
    saveRoomNameHint(room.id, resolved);
  }, [room, customName, columnName, nameHint]);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset draft whenever the authoritative name changes (e.g., partner renamed)
  // and we're not already editing.
  const currentName = customName ?? columnName ?? nameHint ?? '';
  useEffect(() => {
    if (!editing) setDraft(currentName);
  }, [currentName, editing]);

  function startEditing() {
    setDraft(currentName);
    setError(null);
    setEditing(true);
    queueMicrotask(() => inputRef.current?.select());
  }

  function cancel() {
    setEditing(false);
    setError(null);
    setDraft(currentName);
  }

  async function save() {
    const name = draft.trim().slice(0, 100);
    // If name matches the current name (or both are blank), just exit.
    if (name === currentName) {
      cancel();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // Dual-write the encrypted-column path (fast read) PLUS the rename
      // event (back-compat + realtime). The column write is best-effort —
      // if migration 0006 hasn't been applied yet the columns don't exist
      // and the update rejects, but the event path still delivers the rename.
      if (room && roomKey && name.length > 0) {
        try {
          const { ciphertext, nonce } = await encryptRoomName({
            name,
            roomId: room.id,
            roomKey,
          });
          await updateRoomName({
            roomId: room.id,
            nameCiphertext: ciphertext,
            nameNonce: nonce,
          });
        } catch (err) {
          // Surface this instead of silent-warn: if the column write fails
          // the partner never sees the new name reliably.
          console.error('room-name column update failed', err);
          setError(`Name saved locally but server write failed: ${describeError(err)}`);
        }
      } else if (room && name.length === 0) {
        try {
          await updateRoomName({
            roomId: room.id,
            nameCiphertext: null,
            nameNonce: null,
          });
        } catch (err) {
          console.warn('room-name column clear failed; event-only rename', err);
        }
      }
      await appendEvent({ type: 'room_rename', name, ts: Date.now() });
      setEditing(false);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  if (!room) return null;

  if (editing) {
    return (
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
        className="flex min-w-0 flex-wrap items-center gap-2"
      >
        <input
          ref={inputRef}
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') cancel();
          }}
          maxLength={100}
          placeholder={defaultName}
          disabled={busy}
          className="min-w-0 flex-1 rounded-xl border border-white/60 bg-white/80 px-3 py-1 font-display italic tracking-tight text-neutral-900 shadow-sm backdrop-blur-md outline-none focus:border-white/90 focus:ring-2 focus:ring-amber-500/20 dark:border-white/10 dark:bg-neutral-900/70 dark:text-neutral-100"
          style={{ fontSize: 34, lineHeight: 1.1, fontWeight: 400 }}
          aria-label="room name"
        />
        <button
          type="submit"
          disabled={busy}
          className="rounded-full border border-white/50 bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white shadow-sm transition-all hover:shadow-md active:scale-[0.98] disabled:opacity-50 dark:bg-white dark:text-neutral-900"
        >
          {busy ? 'saving…' : 'save'}
        </button>
        <button
          type="button"
          onClick={cancel}
          disabled={busy}
          className="rounded-full border border-white/50 bg-white/60 px-3 py-1.5 text-xs text-neutral-700 backdrop-blur-md transition-all hover:bg-white/80 active:scale-[0.98] disabled:opacity-50 dark:border-white/10 dark:bg-neutral-900/60 dark:text-neutral-300"
        >
          cancel
        </button>
        {error && (
          <p className="w-full text-xs text-red-600">{error}</p>
        )}
      </form>
    );
  }

  return (
    <div className="mb-3 flex min-w-0 items-center gap-2">
      <h1
        className="truncate font-display italic tracking-tight"
        style={{ fontSize: 34, lineHeight: 1.1, fontWeight: 400 }}
      >
        {currentName ? (
          displayName
        ) : (
          <>
            Room{' '}
            <code className="font-mono text-lg">{room.id.slice(0, 8)}</code>
          </>
        )}
      </h1>
      <button
        type="button"
        onClick={startEditing}
        aria-label="rename room"
        title="rename room"
        className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full border border-white/50 bg-white/60 text-neutral-600 shadow-sm backdrop-blur-md transition-all hover:bg-white/80 hover:text-neutral-900 hover:shadow-md active:scale-[0.96] dark:border-white/10 dark:bg-neutral-900/60 dark:text-neutral-400 dark:hover:bg-neutral-900/80 dark:hover:text-neutral-100"
      >
        ✎
      </button>
      <button
        type="button"
        onClick={() => router.push(`/rooms/${room.id}/call`)}
        aria-label={hasActiveCall ? 'join active call' : 'start E2EE video call'}
        title={hasActiveCall ? 'A call is live in this room — click to join' : 'Start an E2EE video call'}
        className={
          hasActiveCall
            ? 'flex flex-shrink-0 items-center gap-1.5 rounded-full bg-emerald-500/90 px-3 py-1.5 text-xs font-semibold text-white shadow-md transition-all hover:bg-emerald-500 hover:shadow-lg active:scale-[0.96]'
            : 'flex flex-shrink-0 items-center gap-1.5 rounded-full border border-white/50 bg-white/60 px-3 py-1.5 text-xs font-medium text-neutral-700 shadow-sm backdrop-blur-md transition-all hover:bg-white/80 hover:text-neutral-900 hover:shadow-md active:scale-[0.96] dark:border-white/10 dark:bg-neutral-900/60 dark:text-neutral-300 dark:hover:bg-neutral-900/80 dark:hover:text-neutral-100'
        }
      >
        {hasActiveCall && (
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-white opacity-75"></span>
            <span className="relative inline-flex h-2 w-2 rounded-full bg-white"></span>
          </span>
        )}
        <span aria-hidden>📹</span>
        <span>{hasActiveCall ? 'join' : 'call'}</span>
      </button>
      <button
        type="button"
        onClick={() => setInviteOpen(true)}
        aria-label="invite someone to this room"
        title="Invite someone to this room"
        className="flex flex-shrink-0 items-center gap-1.5 rounded-full border border-white/50 bg-white/60 px-3 py-1.5 text-xs font-medium text-neutral-700 shadow-sm backdrop-blur-md transition-all hover:bg-white/80 hover:text-neutral-900 hover:shadow-md active:scale-[0.96] dark:border-white/10 dark:bg-neutral-900/60 dark:text-neutral-300 dark:hover:bg-neutral-900/80 dark:hover:text-neutral-100"
      >
        <span aria-hidden>💌</span>
        <span>invite</span>
      </button>
      {inviteOpen && <InviteModal onClose={() => setInviteOpen(false)} />}
    </div>
  );
}
