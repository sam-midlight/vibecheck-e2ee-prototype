'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AppShell } from '@/components/AppShell';
import { KeyChangeBanner } from '@/components/KeyChangeBanner';
import { getSupabase } from '@/lib/supabase/client';
import {
  fromBase64,
  generateRoomKey,
  unwrapRoomKey,
} from '@/lib/e2ee-core';
import {
  loadEnrolledDevice,
  selfLeaveRoom,
  sendInviteToAllDevices,
  wrapRoomKeyForAllMyDevices,
  type EnrolledDevice,
} from '@/lib/bootstrap';
import {
  createRoom,
  deleteInvite,
  deleteRoom,
  fetchPublicDevices,
  getMyWrappedRoomKey,
  listMyInvites,
  listMyRooms,
  listRoomMembersByRoom,
  subscribeInvites,
  subscribeRoomMemberships,
  type RoomInviteRow,
  type RoomMemberRow,
  type RoomRow,
} from '@/lib/supabase/queries';
import { appendEventToRoom, renameRoom } from '@/lib/domain/appendToRoom';
import { describeError } from '@/lib/domain/errors';
import { resolveRoomName } from '@/lib/domain/roomName';
import { useNicknames } from '@/lib/domain/nicknames';
import { Loading } from '@/components/OrganicLoader';

export default function RoomsPage() {
  return (
    <AppShell requireAuth>
      <RoomsInner />
    </AppShell>
  );
}

function RoomsInner() {
  const router = useRouter();
  const [userId, setUserId] = useState<string | null>(null);
  const [device, setDevice] = useState<EnrolledDevice | null>(null);
  const [rooms, setRooms] = useState<RoomRow[]>([]);
  const [invites, setInvites] = useState<RoomInviteRow[]>([]);
  const [roomNames, setRoomNames] = useState<Record<string, string>>({});
  const [membersByRoom, setMembersByRoom] = useState<
    Record<string, RoomMemberRow[]>
  >({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { nicknames, setNickname } = useNicknames();

  const reload = useCallback(
    async (uid: string) => {
      try {
        const [r, i] = await Promise.all([listMyRooms(uid), listMyInvites(uid)]);
        setRooms(r);
        setInvites(i);
        if (r.length > 0) {
          const byRoom = await listRoomMembersByRoom(r.map((x) => x.id));
          setMembersByRoom(byRoom);
        } else {
          setMembersByRoom({});
        }
      } catch (e) {
        setError(describeError(e));
      }
    },
    [],
  );

  useEffect(() => {
    (async () => {
      const supabase = getSupabase();
      const { data } = await supabase.auth.getUser();
      if (!data.user) return;
      const dev = await loadEnrolledDevice(data.user.id);
      if (!dev) {
        router.replace('/auth/bootstrap');
        return;
      }
      setUserId(data.user.id);
      setDevice(dev);
      await reload(data.user.id);
      setLoading(false);
    })();
  }, [reload, router]);

  // Realtime: when someone invites me, pop the new invite into the list
  // without waiting for a manual refresh.
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

  // Realtime: when I'm newly added to a room (via Quick Add from a creator,
  // or by accepting an invite in another tab), refresh the room list so the
  // room appears without requiring a page reload.
  useEffect(() => {
    if (!userId) return;
    const unsub = subscribeRoomMemberships(userId, () => {
      void reload(userId);
    });
    return unsub;
  }, [userId]);

  // Resolve custom room names by pulling the latest `room_rename` event from
  // each room's encrypted stream. Runs in parallel; names pop in as they
  // resolve without blocking the rest of the list.
  useEffect(() => {
    if (!userId || !device || rooms.length === 0) return;
    let cancelled = false;
    for (const room of rooms) {
      void resolveRoomName({
        roomId: room.id,
        userId,
        device,
        currentGeneration: room.current_generation,
      }).then((name) => {
        if (cancelled || !name) return;
        setRoomNames((prev) => ({ ...prev, [room.id]: name }));
      });
    }
    return () => {
      cancelled = true;
    };
  }, [userId, device, rooms]);

  if (loading || !userId) {
    return <Loading />;
  }

  return (
    <div className="mx-auto max-w-2xl space-y-8 pb-16">
      <KeyChangeBanner />

      {/* Hero */}
      <section className="pt-6 text-center">
        <p className="text-xs uppercase tracking-[0.2em] text-neutral-500">
          Your spaces
        </p>
        <h1 className="mt-3 font-display italic text-3xl tracking-tight sm:text-4xl">
          {rooms.length === 0
            ? 'Let\u2019s set up your first room.'
            : rooms.length === 1
              ? 'One quiet space, waiting.'
              : `${rooms.length} rooms — pick one to step into.`}
        </h1>
        <p className="mx-auto mt-3 max-w-md text-sm text-neutral-600 dark:text-neutral-400">
          Rooms are private, encrypted, and named only on your device. Invite
          someone by sharing your ID; accept their invite here.
        </p>
      </section>

      {/* Your user ID */}
      <section className="rounded-2xl border border-white/60 bg-white/60 p-5 shadow-lg backdrop-blur-md dark:border-white/10 dark:bg-neutral-900/50">
        <h2 className="text-[10px] uppercase tracking-[0.2em] text-neutral-500">
          Your user ID
        </h2>
        <p className="mt-2 text-xs text-neutral-500">
          Share this with your partner so they can invite you to a room.
        </p>
        <div className="mt-3 flex items-center gap-2">
          <code className="flex-1 break-all rounded-xl border border-white/60 bg-white/70 p-2.5 font-mono text-xs backdrop-blur-md dark:border-white/10 dark:bg-neutral-900/60">
            {userId}
          </code>
          <button
            onClick={() => void navigator.clipboard.writeText(userId)}
            className="rounded-full border border-white/50 bg-white/60 px-3 py-1.5 text-xs text-neutral-700 shadow-sm backdrop-blur-md transition-all hover:bg-white/80 hover:shadow-md active:scale-[0.98] dark:border-white/10 dark:bg-neutral-900/60 dark:text-neutral-300"
          >
            copy
          </button>
        </div>
      </section>

      {invites.length > 0 && device && (
        <section>
          <h2 className="text-[10px] uppercase tracking-[0.2em] text-neutral-500">
            Pending invites
          </h2>
          <div className="mt-3 space-y-2">
            {invites.map((invite) => (
              <InviteCard
                key={invite.id}
                invite={invite}
                userId={userId}
                device={device}
                onDone={() => void reload(userId)}
              />
            ))}
          </div>
        </section>
      )}

      <section>
        <div className="flex items-center justify-between">
          <h2 className="text-[10px] uppercase tracking-[0.2em] text-neutral-500">
            Your rooms
          </h2>
        </div>
        {rooms.length === 0 && (
          <p className="mt-3 text-sm text-neutral-500">
            No rooms yet. Create one below, or accept an invite from your
            partner.
          </p>
        )}
        <ul className="mt-2 space-y-2">
          {rooms.map((room) => {
            const customName = roomNames[room.id];
            const currentGenMembers = (membersByRoom[room.id] ?? []).filter(
              (m) => m.generation === room.current_generation,
            );
            const currentGenPartners = currentGenMembers
              .filter((m) => m.user_id !== userId)
              .map((m) => m.user_id);
            const isSoleMember = currentGenMembers.length === 1;
            return (
              <RoomCard
                key={room.id}
                room={room}
                customName={customName}
                partnerIds={currentGenPartners}
                isSoleMember={isSoleMember}
                nicknames={nicknames}
                onSetNickname={setNickname}
                userId={userId}
                device={device}
                onRenamed={(newName) =>
                  setRoomNames((prev) => ({ ...prev, [room.id]: newName }))
                }
                onRemoved={() => void reload(userId)}
              />
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
              roomNames={roomNames}
              onInvited={() => void reload(userId)}
            />
          )}
        </>
      )}

      {error && <p className="text-sm text-red-600">Error: {error}</p>}
    </div>
  );
}

/**
 * "You & X, Y" row under the room title. Each partner is a clickable chip;
 * clicking opens an inline editor to set/update a local nickname for them.
 */
function RoomOccupants({
  partnerIds,
  nicknames,
  onSetNickname,
}: {
  partnerIds: string[];
  nicknames: Record<string, string>;
  onSetNickname: (userId: string, name: string) => void;
}) {
  return (
    <div className="mt-0.5 flex flex-wrap items-center gap-1 text-xs text-neutral-600 dark:text-neutral-400">
      <span>You</span>
      {partnerIds.length === 0 ? (
        <span className="text-neutral-500">· no partner yet</span>
      ) : (
        partnerIds.map((uid, i) => (
          <span key={uid} className="flex items-center gap-1">
            {i === 0 ? <span>&amp;</span> : <span>,</span>}
            <PartnerChip
              userId={uid}
              nickname={nicknames[uid]}
              onSetNickname={onSetNickname}
            />
          </span>
        ))
      )}
    </div>
  );
}

function PartnerChip({
  userId,
  nickname,
  onSetNickname,
}: {
  userId: string;
  nickname: string | undefined;
  onSetNickname: (userId: string, name: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(nickname ?? '');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) setDraft(nickname ?? '');
  }, [editing, nickname]);

  function save() {
    onSetNickname(userId, draft);
    setEditing(false);
  }

  if (editing) {
    return (
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
        className="inline-flex items-center gap-1"
      >
        <input
          ref={inputRef}
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setEditing(false);
          }}
          onBlur={save}
          maxLength={60}
          placeholder="nickname"
          className="w-28 rounded-full border border-white/60 bg-white/80 px-2 py-0.5 text-xs outline-none focus:ring-2 focus:ring-neutral-900/10 dark:border-white/10 dark:bg-neutral-900/70 dark:focus:ring-white/20"
          aria-label={`nickname for ${userId.slice(0, 8)}`}
        />
      </form>
    );
  }

  const label = nickname?.trim() || `${userId.slice(0, 8)}…`;
  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      title={nickname ? `click to edit nickname · ${userId}` : `click to add a local nickname · ${userId}`}
      className={`rounded-full px-2 py-0.5 text-xs transition-colors hover:bg-white/60 dark:hover:bg-white/10 ${
        nickname
          ? 'font-medium text-neutral-900 dark:text-neutral-100'
          : 'text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100'
      }`}
    >
      {label}
    </button>
  );
}

function RoomCard({
  room,
  customName,
  partnerIds,
  isSoleMember,
  nicknames,
  onSetNickname,
  userId,
  device,
  onRenamed,
  onRemoved,
}: {
  room: RoomRow;
  customName: string | undefined;
  partnerIds: string[];
  isSoleMember: boolean;
  nicknames: Record<string, string>;
  onSetNickname: (userId: string, name: string) => void;
  userId: string;
  device: EnrolledDevice | null;
  onRenamed: (newName: string) => void;
  onRemoved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(customName ?? '');
  const [savingRename, setSavingRename] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);

  const [menuOpen, setMenuOpen] = useState(false);
  const [confirm, setConfirm] = useState<null | 'leave' | 'delete'>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const menuRef = useRef<HTMLDivElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    function onClick(e: MouseEvent) {
      if (!menuRef.current) return;
      if (!menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    }
    window.addEventListener('mousedown', onClick);
    return () => window.removeEventListener('mousedown', onClick);
  }, [menuOpen]);

  function startEditing() {
    if (!device) return;
    setDraft(customName ?? '');
    setRenameError(null);
    setEditing(true);
    queueMicrotask(() => renameInputRef.current?.select());
  }

  function cancelEditing() {
    setEditing(false);
    setRenameError(null);
    setDraft(customName ?? '');
  }

  async function saveRename() {
    if (!device) return;
    const name = draft.trim().slice(0, 100);
    if (name === (customName ?? '')) {
      cancelEditing();
      return;
    }
    setSavingRename(true);
    setRenameError(null);
    try {
      await renameRoom({
        roomId: room.id,
        generation: room.current_generation,
        userId,
        device,
        name,
      });
      onRenamed(name);
      setEditing(false);
    } catch (e) {
      setRenameError(describeError(e));
    } finally {
      setSavingRename(false);
    }
  }

  async function confirmLeave() {
    if (!device) return;
    setBusy(true);
    setActionError(null);
    try {
      // Sole current-gen member? No one's left to rotate the key for, so
      // just drop the room. Multi-member? Route through selfLeaveRoom so
      // kick_and_rotate bumps the generation and the leaver can't decrypt
      // anything posted after their exit.
      if (isSoleMember) {
        await deleteRoom(room.id);
      } else {
        await selfLeaveRoom({
          roomId: room.id,
          userId,
          device: device.deviceBundle,
          room,
        });
      }
      setConfirm(null);
      onRemoved();
    } catch (e) {
      setActionError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  async function confirmDelete() {
    setBusy(true);
    setActionError(null);
    try {
      await deleteRoom(room.id);
      setConfirm(null);
      onRemoved();
    } catch (e) {
      setActionError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  const displayName = customName ?? `Room ${room.id.slice(0, 8)}`;

  return (
    <li className="rounded-2xl border border-white/50 bg-white/60 px-4 py-3 text-sm shadow-sm backdrop-blur-md dark:border-white/10 dark:bg-neutral-900/50">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          {editing ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void saveRename();
              }}
              className="flex flex-wrap items-center gap-2"
            >
              <input
                ref={renameInputRef}
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') cancelEditing();
                }}
                maxLength={100}
                placeholder={`Room ${room.id.slice(0, 8)}`}
                disabled={savingRename}
                aria-label="room name"
                className="min-w-0 flex-1 rounded-lg border border-white/60 bg-white/80 px-2.5 py-1 text-sm font-medium text-neutral-900 shadow-sm outline-none focus:border-white/90 focus:ring-2 focus:ring-neutral-900/10 dark:border-white/10 dark:bg-neutral-900/70 dark:text-neutral-100 dark:focus:ring-white/20"
              />
              <button
                type="submit"
                disabled={savingRename}
                className="rounded-full bg-neutral-900 px-3 py-1 text-[11px] font-medium text-white shadow-sm transition-all hover:shadow-md active:scale-[0.98] disabled:opacity-50 dark:bg-white dark:text-neutral-900"
              >
                {savingRename ? 'saving…' : 'save'}
              </button>
              <button
                type="button"
                onClick={cancelEditing}
                disabled={savingRename}
                className="rounded-full border border-white/60 bg-white/60 px-3 py-1 text-[11px] text-neutral-700 transition-all hover:bg-white/80 active:scale-[0.98] disabled:opacity-50 dark:border-white/10 dark:bg-neutral-900/60 dark:text-neutral-300"
              >
                cancel
              </button>
              {renameError && (
                <p className="w-full text-[11px] text-red-600">{renameError}</p>
              )}
            </form>
          ) : (
            <div className="flex min-w-0 items-center gap-1.5">
              <div className="truncate font-medium text-neutral-900 dark:text-neutral-100">
                {displayName}
              </div>
              {device && (
                <button
                  type="button"
                  onClick={startEditing}
                  aria-label="rename room"
                  title="rename room"
                  className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full text-[11px] text-neutral-500 transition-colors hover:bg-white/80 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-900/80 dark:hover:text-neutral-100"
                >
                  ✎
                </button>
              )}
            </div>
          )}
          {!editing && (
            <>
              <RoomOccupants
                partnerIds={partnerIds}
                nicknames={nicknames}
                onSetNickname={onSetNickname}
              />
              <div className="mt-1 flex flex-wrap items-center gap-2 text-[10px] text-neutral-500">
                <code className="font-mono">{room.id.slice(0, 8)}</code>
                <span className="rounded-full bg-neutral-900/5 px-1.5 py-0.5 uppercase dark:bg-white/5">
                  {room.kind}
                </span>
                <span>gen {room.current_generation}</span>
                {room.parent_room_id && (
                  <span>↳ child of {room.parent_room_id.slice(0, 8)}</span>
                )}
              </div>
            </>
          )}
        </div>
        {!editing && (
          <div className="flex flex-shrink-0 items-center gap-2">
            <Link
              href={`/rooms/${room.id}`}
              className="rounded-full bg-neutral-900 px-3 py-1.5 text-xs text-white shadow-sm transition-all hover:shadow-md active:scale-[0.98] dark:bg-white dark:text-neutral-900"
            >
              open →
            </Link>
            <div ref={menuRef} className="relative">
              <button
                type="button"
                onClick={() => setMenuOpen((o) => !o)}
                aria-label="room actions"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                className="flex h-7 w-7 items-center justify-center rounded-full border border-white/50 bg-white/60 text-neutral-600 shadow-sm backdrop-blur-md transition-all hover:bg-white/80 hover:text-neutral-900 active:scale-[0.96] dark:border-white/10 dark:bg-neutral-900/60 dark:text-neutral-400 dark:hover:bg-neutral-900/80 dark:hover:text-neutral-100"
              >
                ⋯
              </button>
              {menuOpen && (
                <div
                  role="menu"
                  className="absolute right-0 z-10 mt-1 w-44 rounded-xl border border-white/60 bg-white/90 p-1 text-xs shadow-lg backdrop-blur-md dark:border-white/10 dark:bg-neutral-900/90"
                >
                  <button
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      startEditing();
                    }}
                    className="block w-full rounded-lg px-3 py-1.5 text-left text-neutral-800 transition-colors hover:bg-neutral-900/5 dark:text-neutral-200 dark:hover:bg-white/10"
                  >
                    Rename room
                  </button>
                  <button
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      setActionError(null);
                      setConfirm(isSoleMember ? 'delete' : 'leave');
                    }}
                    className={`block w-full rounded-lg px-3 py-1.5 text-left font-medium transition-colors ${
                      isSoleMember
                        ? 'text-red-700 hover:bg-red-500/10 dark:text-red-400'
                        : 'text-amber-700 hover:bg-amber-500/10 dark:text-amber-400'
                    }`}
                  >
                    {isSoleMember ? 'Delete room…' : 'Leave room…'}
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {confirm === 'leave' && (
        <ConfirmModal
          tone="amber"
          title="Leave this room?"
          body={
            <>
              <p>
                You&apos;ll stop receiving new messages and lose access to
                everything encrypted for you in this room.
              </p>
              <p className="mt-2">
                Your partner can re-invite you later. If they do, you&apos;ll
                start fresh — you won&apos;t regain access to past encrypted
                messages unless you still have old keys.
              </p>
            </>
          }
          confirmLabel="Leave room"
          busy={busy}
          error={actionError}
          onConfirm={() => void confirmLeave()}
          onCancel={() => {
            setConfirm(null);
            setActionError(null);
          }}
        />
      )}

      {confirm === 'delete' && (
        <ConfirmModal
          tone="red"
          title="Delete this room?"
          body={
            <>
              <p className="font-medium">
                This will permanently delete this room and all encrypted
                history. This cannot be undone.
              </p>
              <p className="mt-2">
                Everyone&apos;s memberships, pending invites, and every
                encrypted message in this room will be destroyed.
              </p>
            </>
          }
          confirmLabel="Delete room forever"
          busy={busy}
          error={actionError}
          onConfirm={() => void confirmDelete()}
          onCancel={() => {
            setConfirm(null);
            setActionError(null);
          }}
        />
      )}
    </li>
  );
}

function ConfirmModal({
  tone,
  title,
  body,
  confirmLabel,
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  tone: 'amber' | 'red';
  title: string;
  body: React.ReactNode;
  confirmLabel: string;
  busy: boolean;
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const toneClasses =
    tone === 'red'
      ? {
          border: 'border-red-400/70 dark:border-red-700',
          bg: 'bg-red-50/80 dark:bg-red-950/60',
          title: 'text-red-900 dark:text-red-100',
          button: 'bg-red-700 hover:bg-red-800 text-white',
        }
      : {
          border: 'border-amber-300/70 dark:border-amber-700',
          bg: 'bg-amber-50/80 dark:bg-amber-950/50',
          title: 'text-amber-900 dark:text-amber-100',
          button:
            'bg-amber-700 hover:bg-amber-800 text-white dark:bg-amber-200 dark:text-amber-950 dark:hover:bg-amber-100',
        };

  // Render into document.body so the modal isn't trapped inside the stacking
  // context created by ancestor backdrop-blur / transform / filter styles
  // (those turn `position: fixed` into a card-relative anchor instead of
  // viewport-relative, which put the confirm button behind neighboring cards).
  if (typeof document === 'undefined') return null;
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 z-[100] flex items-center justify-center bg-neutral-950/40 p-4 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onCancel();
      }}
    >
      <div
        className={`w-full max-w-md rounded-2xl border-2 ${toneClasses.border} ${toneClasses.bg} p-5 text-sm shadow-2xl backdrop-blur-md`}
      >
        <h3 className={`text-base font-semibold ${toneClasses.title}`}>
          {title}
        </h3>
        <div className="mt-3 text-neutral-700 dark:text-neutral-300">
          {body}
        </div>
        {error && (
          <p className="mt-3 rounded-lg border border-red-300/60 bg-red-50/70 p-2 text-xs text-red-800 dark:border-red-800/60 dark:bg-red-950/60 dark:text-red-200">
            {error}
          </p>
        )}
        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded-full border border-white/60 bg-white/70 px-4 py-1.5 text-xs font-medium text-neutral-700 backdrop-blur-md transition-all hover:bg-white/90 hover:shadow-sm active:scale-[0.98] disabled:opacity-50 dark:border-white/10 dark:bg-neutral-900/60 dark:text-neutral-300"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className={`rounded-full px-4 py-1.5 text-xs font-medium shadow-sm transition-all hover:shadow-md active:scale-[0.98] disabled:opacity-50 ${toneClasses.button}`}
          >
            {busy ? 'working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
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
  device: EnrolledDevice;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function accept() {
    setBusy(true);
    setError(null);
    try {
      // The invite row is sealed to a specific device's x25519_pub. Confirm
      // the row is addressed to THIS device before unwrapping.
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
      // Wrap the room key for every active device on my account so I can
      // open this room from any of them.
      await wrapRoomKeyForAllMyDevices({
        roomId: invite.room_id,
        userId,
        roomKey: { key: roomKey.key, generation: invite.generation },
        signerDevice: device.deviceBundle,
      });
      await deleteInvite(invite.id);
      onDone();
    } catch (e) {
      setError(describeError(e));
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
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-2xl border border-blue-300/60 bg-blue-50/70 p-4 text-sm shadow-lg backdrop-blur-md dark:border-blue-800/40 dark:bg-blue-950/40">
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
  device,
  rooms,
  onCreated,
}: {
  userId: string;
  device: EnrolledDevice;
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
      // wrapRoomKeyForAllMyDevices: wraps for every active device on my
      // account (so I can open this room from anywhere) and uploads to
      // server-side key_backup if a backup key is available.
      await wrapRoomKeyForAllMyDevices({
        roomId: room.id,
        userId,
        roomKey: { key: roomKey.key, generation: room.current_generation },
        signerDevice: device.deviceBundle,
      });
      onCreated();
      setParentId('');
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={create}
      className="space-y-3 rounded-2xl border border-white/60 bg-white/60 p-5 shadow-lg backdrop-blur-md dark:border-white/10 dark:bg-neutral-900/50"
    >
      <h2 className="text-[10px] uppercase tracking-[0.2em] text-neutral-500">
        Create room
      </h2>
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
  roomNames,
  onInvited,
}: {
  userId: string;
  device: EnrolledDevice;
  rooms: RoomRow[];
  roomNames: Record<string, string>;
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
      // Per-device invite: enumerate the invitee's active signed devices,
      // seal the room key + sign an envelope per device, write one
      // room_invites row per target. Invitee accepts from any device.
      const invitedDevices = await fetchPublicDevices(inviteeId);
      if (invitedDevices.length === 0) {
        throw new Error('that user has no active signed devices');
      }
      const myWrapped = await getMyWrappedRoomKey({
        roomId,
        deviceId: device.deviceBundle.deviceId,
        generation: room.current_generation,
      });
      if (!myWrapped) throw new Error('this device is not a current-generation member of that room');
      const roomKey = await unwrapRoomKey(
        { wrapped: myWrapped, generation: room.current_generation },
        device.deviceBundle.x25519PublicKey,
        device.deviceBundle.x25519PrivateKey,
      );
      await sendInviteToAllDevices({
        roomId,
        generation: room.current_generation,
        roomKey: { key: roomKey.key, generation: room.current_generation },
        invitedUserId: inviteeId,
        invitedActiveDevices: invitedDevices,
        inviterUserId: userId,
        inviterDevice: device.deviceBundle,
        expiresAtMs: Date.now() + 7 * 24 * 60 * 60 * 1000,
      });
      setStatus('Invite sent.');
      setInviteeId('');
      onInvited();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      className="space-y-3 rounded-2xl border border-white/60 bg-white/60 p-5 shadow-lg backdrop-blur-md dark:border-white/10 dark:bg-neutral-900/50"
    >
      <h2 className="text-[10px] uppercase tracking-[0.2em] text-neutral-500">
        Invite someone
      </h2>
      <div>
        <label className="text-xs text-neutral-500">room</label>
        <select
          value={roomId}
          onChange={(e) => setRoomId(e.target.value)}
          className="mt-1 block w-full rounded border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900"
        >
          {rooms.map((r) => {
            const name = roomNames[r.id];
            const label = name
              ? `${name} · ${r.kind}`
              : `Room ${r.id.slice(0, 8)} · ${r.kind}`;
            return (
              <option key={r.id} value={r.id}>
                {label}
              </option>
            );
          })}
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
