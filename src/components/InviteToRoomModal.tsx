'use client';

/**
 * Frictionless in-room invite.
 *
 * Two paths:
 *   1. Quick Add — users I already share OTHER rooms with (or have a local
 *      nickname for) get a dropdown; selecting + confirming does the full
 *      crypto handshake (wrap room key for their X25519 pub) and direct-
 *      inserts a `room_members` row at the current generation. Allowed by
 *      existing `room_members_insert` RLS because the inserter is already
 *      a current-gen member.
 *   2. Share your ID — fallback for brand-new connections: shows the
 *      current user's own userId with a Copy button and, if available, a
 *      Web Share trigger. The partner pastes this into THEIR /rooms invite
 *      form to send a regular invite back.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { toast } from 'sonner';
import {
  sendInviteToAllDevices,
  wrapRoomKeyForAllMyDevices,
} from '@/lib/bootstrap';
import {
  fetchPublicDevices,
  listMyRooms,
  listRoomMembersByRoom,
} from '@/lib/supabase/queries';
import type { RoomKey } from '@/lib/e2ee-core';
import type { RoomRow } from '@/lib/supabase/queries';
import { useNicknames } from '@/lib/domain/nicknames';
import { readRoomCache } from '@/lib/domain/roomCache';
import { describeError } from '@/lib/domain/errors';
import { useRoom } from './RoomProvider';

interface Contact {
  userId: string;
  /** Best-available human name for this contact. See label priority below. */
  label: string;
  /** True when we only have the bare UUID — the UI can flag this specially. */
  isAnonymous: boolean;
}

export function InviteToRoomButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-full border border-white/50 bg-white/60 px-3 py-1.5 text-xs text-neutral-700 shadow-sm backdrop-blur-md transition-all hover:bg-white/80 hover:shadow-md active:scale-[0.98] dark:border-white/10 dark:bg-neutral-900/60 dark:text-neutral-300 dark:hover:bg-neutral-900/80"
      >
        + invite
      </button>
      {open && <InviteModal onClose={() => setOpen(false)} />}
    </>
  );
}

export function InviteModal({ onClose }: { onClose: () => void }) {
  const { room, roomKey, members, myUserId, myDevice } = useRoom();
  const { nicknames } = useNicknames();
  // RLS now requires Quick Add inserts (direct room_members INSERT) to come
  // from the room creator. Non-creators can still send regular invites on
  // the /rooms page.
  const isCreator = !!room && !!myUserId && room.created_by === myUserId;

  const [contacts, setContacts] = useState<Contact[]>([]);
  const [selected, setSelected] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadingContacts, setLoadingContacts] = useState(true);

  const currentMemberIds = useMemo(() => {
    if (!room) return new Set<string>();
    return new Set(
      members
        .filter((m) => m.generation === room.current_generation)
        .map((m) => m.user_id),
    );
  }, [members, room]);

  useEffect(() => {
    if (!myUserId || !room) return;
    let cancelled = false;
    (async () => {
      try {
        setLoadingContacts(true);
        const myRooms = await listMyRooms(myUserId);
        const otherRoomIds = myRooms
          .filter((r) => r.id !== room.id)
          .map((r) => r.id);
        const byRoom =
          otherRoomIds.length > 0
            ? await listRoomMembersByRoom(otherRoomIds)
            : {};
        const fromSharedRooms = new Set<string>();
        for (const rows of Object.values(byRoom)) {
          for (const row of rows) {
            if (row.user_id !== myUserId) fromSharedRooms.add(row.user_id);
          }
        }
        const fromNicknames = new Set<string>(Object.keys(nicknames));
        const all = new Set<string>([...fromSharedRooms, ...fromNicknames]);
        for (const uid of currentMemberIds) all.delete(uid); // exclude existing members

        // Fallback 2: published display names from other rooms I share with
        // this contact. Read from roomCache so we don't have to re-decrypt
        // every room's ledger. Latest `display_name_set` per sender wins.
        const publishedNames: Record<string, string> = {};
        if (cancelled) return;
        await Promise.all(
          otherRoomIds.map(async (rid) => {
            const cache = await readRoomCache(myUserId, rid);
            if (!cache) return;
            const latestTs: Record<string, number> = {};
            for (const rec of cache.events) {
              if (rec.event.type !== 'display_name_set') continue;
              const prior = latestTs[rec.senderId] ?? 0;
              if (rec.event.ts <= prior) continue;
              const trimmed = rec.event.name.trim();
              if (!trimmed) continue;
              latestTs[rec.senderId] = rec.event.ts;
              // Later rooms may have more-recent events; overwrite if newer.
              const priorGlobal =
                publishedNames[`${rec.senderId}:ts`] !== undefined
                  ? Number(publishedNames[`${rec.senderId}:ts`])
                  : 0;
              if (rec.event.ts > priorGlobal) {
                publishedNames[rec.senderId] = trimmed;
                publishedNames[`${rec.senderId}:ts`] = String(rec.event.ts);
              }
            }
          }),
        );
        if (cancelled) return;

        const list: Contact[] = Array.from(all).map((uid) => {
          // Label priority: (1) my nickname, (2) their published
          // display_name_set from a shared room cache, (3) UUID prefix.
          const nick = nicknames[uid]?.trim();
          const published = publishedNames[uid];
          const resolved =
            (nick && nick.length > 0 ? nick : undefined) ?? published;
          return {
            userId: uid,
            label: resolved ?? `${uid.slice(0, 8)}…`,
            isAnonymous: !resolved,
          };
        });
        // Names first, then anonymous entries.
        list.sort((a, b) => {
          if (a.isAnonymous !== b.isAnonymous) return a.isAnonymous ? 1 : -1;
          return a.label.localeCompare(b.label);
        });
        if (!cancelled) setContacts(list);
      } catch (e) {
        if (!cancelled)
          setError(describeError(e));
      } finally {
        if (!cancelled) setLoadingContacts(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [myUserId, room, nicknames, currentMemberIds]);

  const handleQuickAdd = useCallback(async () => {
    if (!room || !roomKey || !selected || !myUserId || !myDevice) return;
    setBusy(true);
    setError(null);
    try {
      // Per-device fan-out: send a sealed signed invite to every active
      // device the contact has. They accept from any of them.
      const theirDevices = await fetchPublicDevices(selected);
      if (theirDevices.length === 0) {
        throw new Error(
          "that user hasn't set up their encryption keys yet — ask them to sign in first",
        );
      }
      await sendInviteToAllDevices({
        roomId: room.id,
        generation: room.current_generation,
        roomKey: { key: roomKey.key, generation: room.current_generation },
        invitedUserId: selected,
        invitedActiveDevices: theirDevices,
        inviterUserId: myUserId,
        inviterDevice: myDevice.deviceBundle,
        expiresAtMs: Date.now() + 7 * 24 * 60 * 60 * 1000,
      });
      const name =
        contacts.find((c) => c.userId === selected)?.label ?? 'your contact';
      toast.success(`Invite sent to ${name}`);
      onClose();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }, [room, roomKey, selected, contacts, onClose, myUserId, myDevice]);

  if (typeof document === 'undefined' || !myUserId || !room || !roomKey) return null;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Invite to room"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-neutral-950/40 p-4 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div className="w-full max-w-md space-y-5 rounded-3xl border border-white/60 bg-white/80 p-6 text-sm shadow-2xl backdrop-blur-md dark:border-white/10 dark:bg-neutral-900/80">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-lg font-semibold tracking-tight">
              Invite to this room
            </h3>
            <p className="mt-1 text-xs text-neutral-500">
              They&apos;ll join end-to-end-encrypted, at the current room
              generation.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="close"
            className="flex h-7 w-7 items-center justify-center rounded-full border border-white/60 bg-white/70 text-neutral-500 transition-all hover:bg-white/90 hover:text-neutral-900 dark:border-white/10 dark:bg-neutral-900/60 dark:text-neutral-400 dark:hover:bg-neutral-900/80 dark:hover:text-neutral-100"
          >
            ✕
          </button>
        </div>

        {isCreator ? (
          <QuickAddSection
            contacts={contacts}
            loadingContacts={loadingContacts}
            selected={selected}
            setSelected={setSelected}
            busy={busy}
            onQuickAdd={() => void handleQuickAdd()}
          />
        ) : (
          <section className="rounded-2xl border border-white/60 bg-white/60 p-4 backdrop-blur-md dark:border-white/10 dark:bg-neutral-900/50">
            <h4 className="text-[10px] uppercase tracking-[0.2em] text-neutral-500">
              Quick add from your contacts
            </h4>
            <p className="mt-2 text-xs text-neutral-500">
              Only the room creator can add members directly. Share your
              invite ID below — the creator (or anyone they invite) can pick
              it up from their Rooms page.
            </p>
          </section>
        )}

        <div className="relative">
          <div className="absolute inset-0 flex items-center" aria-hidden>
            <div className="w-full border-t border-white/60 dark:border-white/10" />
          </div>
          <div className="relative flex justify-center text-[10px] uppercase tracking-[0.2em] text-neutral-500">
            <span className="bg-white/80 px-2 dark:bg-neutral-900/80">or send an invite</span>
          </div>
        </div>

        {myDevice && (
          <InviteByIdSection
            room={room}
            roomKey={roomKey}
            myUserId={myUserId}
            myDevice={myDevice}
            alreadyMemberIds={currentMemberIds}
          />
        )}

        <div className="relative">
          <div className="absolute inset-0 flex items-center" aria-hidden>
            <div className="w-full border-t border-white/60 dark:border-white/10" />
          </div>
          <div className="relative flex justify-center text-[10px] uppercase tracking-[0.2em] text-neutral-500">
            <span className="bg-white/80 px-2 dark:bg-neutral-900/80">or share yours</span>
          </div>
        </div>

        <ShareIdSection myUserId={myUserId} />

        {error && (
          <p className="rounded-xl border border-red-300/60 bg-red-50/70 p-3 text-xs text-red-800 dark:border-red-800/40 dark:bg-red-950/40 dark:text-red-200">
            {error}
          </p>
        )}
      </div>
    </div>,
    document.body,
  );
}

function QuickAddSection({
  contacts,
  loadingContacts,
  selected,
  setSelected,
  busy,
  onQuickAdd,
}: {
  contacts: Contact[];
  loadingContacts: boolean;
  selected: string;
  setSelected: (v: string) => void;
  busy: boolean;
  onQuickAdd: () => void;
}) {
  return (
    <section className="rounded-2xl border border-white/60 bg-white/60 p-4 backdrop-blur-md dark:border-white/10 dark:bg-neutral-900/50">
      <h4 className="text-[10px] uppercase tracking-[0.2em] text-neutral-500">
        Quick add from your contacts
      </h4>
      {loadingContacts ? (
        <p className="mt-2 text-xs text-neutral-500">loading contacts…</p>
      ) : contacts.length === 0 ? (
        <p className="mt-2 text-xs text-neutral-500">
          No known contacts yet. Once you share other rooms with people (or
          give them a nickname) they&apos;ll show up here.
        </p>
      ) : (
        <div className="mt-2 space-y-2">
          <select
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
            disabled={busy}
            className="block w-full rounded-xl border border-white/60 bg-white/80 px-3 py-2 text-sm outline-none backdrop-blur-md focus:border-white/90 focus:ring-2 focus:ring-neutral-900/10 dark:border-white/10 dark:bg-neutral-900/70 dark:focus:ring-white/20"
          >
            <option value="">Select a contact…</option>
            {contacts.map((c) => (
              <option key={c.userId} value={c.userId}>
                {c.isAnonymous
                  ? `${c.label} (no name set)`
                  : `${c.label} · ${c.userId.slice(0, 8)}`}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={onQuickAdd}
            disabled={busy || !selected}
            className="w-full rounded-full bg-neutral-900 px-4 py-2 text-xs font-medium text-white shadow-sm transition-all hover:shadow-md active:scale-[0.98] disabled:opacity-50 dark:bg-white dark:text-neutral-900"
          >
            {busy ? 'adding…' : 'Add to room'}
          </button>
        </div>
      )}
    </section>
  );
}

/**
 * InviteByIdSection — paste someone's user id, send them a real invite
 * (writes a row into room_invites). That row shows up live on the
 * recipient's /invites page via subscribeInvites, so they can accept it
 * and land inside the room. This is the path that was previously only
 * available on /rooms — bringing it into the in-room modal closes the
 * "where do I send an invite?" gap.
 */
function InviteByIdSection({
  room,
  roomKey,
  myUserId,
  myDevice,
  alreadyMemberIds,
}: {
  room: RoomRow;
  roomKey: RoomKey;
  myUserId: string;
  myDevice: import('@/lib/bootstrap').EnrolledDevice;
  alreadyMemberIds: Set<string>;
}) {
  const [inviteeId, setInviteeId] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setStatus(null);
    const id = inviteeId.trim();
    if (!id) return;
    // Sanity: make sure it looks like a UUID so we don't send garbage.
    if (!/^[0-9a-f-]{32,36}$/i.test(id)) {
      setError('That doesn\u2019t look like a user id.');
      return;
    }
    if (id === myUserId) {
      setError('That\u2019s your own id.');
      return;
    }
    if (alreadyMemberIds.has(id)) {
      setError('They\u2019re already in this room.');
      return;
    }
    setBusy(true);
    try {
      // Per-device fan-out: enumerate the invitee's active signed devices
      // and send a sealed signed invite per device.
      const theirDevices = await fetchPublicDevices(id);
      if (theirDevices.length === 0) {
        throw new Error('That user hasn\u2019t set up any signed devices yet.');
      }
      await sendInviteToAllDevices({
        roomId: room.id,
        generation: room.current_generation,
        roomKey: { key: roomKey.key, generation: room.current_generation },
        invitedUserId: id,
        invitedActiveDevices: theirDevices,
        inviterUserId: myUserId,
        inviterDevice: myDevice.deviceBundle,
        expiresAtMs: Date.now() + 7 * 24 * 60 * 60 * 1000,
      });
      // Note: the v3 invite envelope no longer carries roomNameCiphertext —
      // the joiner reads it from the rooms row directly post-accept.
      setStatus('Invite sent — they\u2019ll see it in their Room invites tab.');
      setInviteeId('');
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-2xl border border-white/60 bg-white/60 p-4 backdrop-blur-md dark:border-white/10 dark:bg-neutral-900/50">
      <h4 className="text-[10px] font-medium uppercase tracking-[0.2em] text-neutral-500">
        Send invite by user id
      </h4>
      <p className="mt-2 text-xs leading-relaxed text-neutral-500">
        Paste their id (top-right of their screen — little &quot;id&quot;
        pill). They&apos;ll see an invite in their Room invites tab right
        away.
      </p>
      <form onSubmit={send} className="mt-3 flex flex-wrap gap-2">
        <input
          type="text"
          value={inviteeId}
          onChange={(e) => {
            setInviteeId(e.target.value);
            setError(null);
            setStatus(null);
          }}
          placeholder="paste their user id…"
          disabled={busy}
          className="min-w-0 flex-1 rounded-xl border border-neutral-200 bg-white/90 px-3 py-2 font-mono text-xs text-neutral-900 placeholder:italic placeholder:text-neutral-400 outline-none focus:border-neutral-300 focus:ring-2 focus:ring-neutral-300/40 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
        />
        <button
          type="submit"
          disabled={busy || !inviteeId.trim()}
          className="rounded-full bg-gradient-to-br from-blue-400 via-blue-500 to-indigo-600 px-5 py-2 font-display italic text-sm text-white shadow-[0_8px_20px_-4px_rgba(37,99,235,0.5),inset_0_2px_3px_rgba(255,255,255,0.4),inset_0_-3px_6px_rgba(30,64,175,0.3)] ring-1 ring-blue-200/60 transition-all hover:scale-[1.04] active:scale-[1.06] disabled:opacity-50"
        >
          {busy ? 'sending…' : 'Send invite'}
        </button>
      </form>
      {status && (
        <p className="mt-2 text-xs text-emerald-700 dark:text-emerald-400">{status}</p>
      )}
      {error && (
        <p className="mt-2 text-xs text-red-600">{error}</p>
      )}
    </section>
  );
}

function ShareIdSection({ myUserId }: { myUserId: string }) {
  const [canShare, setCanShare] = useState(false);
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
      setCanShare(true);
    }
  }, []);

  useEffect(() => {
    return () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
    };
  }, []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(myUserId);
      setCopied(true);
      if (resetTimer.current) clearTimeout(resetTimer.current);
      resetTimer.current = setTimeout(() => setCopied(false), 1600);
    } catch {
      /* ignore */
    }
  }

  async function share() {
    try {
      await navigator.share({
        title: 'VibeCheck invite ID',
        text: `Invite me on VibeCheck — paste this user ID in your Rooms page invite form:\n\n${myUserId}`,
      });
    } catch {
      /* user cancelled or unsupported */
    }
  }

  return (
    <section className="rounded-2xl border border-white/60 bg-white/60 p-4 backdrop-blur-md dark:border-white/10 dark:bg-neutral-900/50">
      <h4 className="text-[10px] uppercase tracking-[0.2em] text-neutral-500">
        Share your invite ID
      </h4>
      <p className="mt-1 text-xs text-neutral-500">
        Give this to a partner who isn&apos;t in your contacts yet. They paste
        it into their Rooms page to send you a regular invite.
      </p>
      <div className="mt-2 flex items-center gap-2">
        <code className="flex-1 truncate rounded-xl border border-white/60 bg-white/70 px-2.5 py-1.5 font-mono text-xs text-neutral-700 backdrop-blur-md dark:border-white/10 dark:bg-neutral-900/60 dark:text-neutral-300">
          {myUserId}
        </code>
        <button
          type="button"
          onClick={() => void copy()}
          className="rounded-full border border-white/60 bg-white/70 px-3 py-1.5 text-xs font-medium text-neutral-700 shadow-sm transition-all hover:bg-white/90 hover:shadow-md active:scale-[0.98] dark:border-white/10 dark:bg-neutral-900/60 dark:text-neutral-300"
        >
          {copied ? 'copied ✓' : 'copy'}
        </button>
        {canShare && (
          <button
            type="button"
            onClick={() => void share()}
            className="rounded-full border border-white/60 bg-white/70 px-3 py-1.5 text-xs font-medium text-neutral-700 shadow-sm transition-all hover:bg-white/90 hover:shadow-md active:scale-[0.98] dark:border-white/10 dark:bg-neutral-900/60 dark:text-neutral-300"
          >
            share…
          </button>
        )}
      </div>
    </section>
  );
}
