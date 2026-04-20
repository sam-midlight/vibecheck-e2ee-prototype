'use client';

/**
 * Room-level tab bar: [Home | Safe Space] pill tabs plus action buttons
 * (Sunday report, 14-day report, invite, leave, notifications).
 *
 * Active tab is driven by the parent — this is a dumb presentational
 * component. Tabs route via <Link>; actions delegate to their existing
 * self-contained components (InviteToRoomButton, LeaveRoomButton,
 * NotificationCenter).
 */

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { motion } from 'framer-motion';
import { InviteModal } from './InviteToRoomModal';
import { LeaveRoomButton } from './LeaveRoomButton';
import { NotificationCenter } from './NotificationCenter';

export type RoomTabId = 'home' | 'date-night' | 'safe-space';

export function RoomTabs({
  active,
  roomId,
  myUserId,
  isSoleMember,
}: {
  active: RoomTabId;
  roomId: string;
  myUserId: string;
  isSoleMember: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <Tabs active={active} roomId={roomId} />
      <div className="flex flex-wrap items-center gap-2">
        <NotificationCenter />
        {/* Desktop: two separate dropdowns (Reports + Room). Mobile: one
            combined menu that holds all four actions under a single ⋯.
            Gives the iPhone header a clean `[icons] · 🔔 · ⋯` layout. */}
        <div className="hidden sm:flex sm:items-center sm:gap-2">
          <ReportsDropdown roomId={roomId} />
          <RoomActionsDropdown
            roomId={roomId}
            myUserId={myUserId}
            isSoleMember={isSoleMember}
          />
        </div>
        <div className="sm:hidden">
          <MobileRoomMenu
            roomId={roomId}
            myUserId={myUserId}
            isSoleMember={isSoleMember}
          />
        </div>
      </div>
    </div>
  );
}

/**
 * Combined mobile dropdown — collapses Reports ▾ + ⋯ Room ▾ into a single
 * menu on narrow viewports so the top action bar stays tight. Invite
 * modal is portalled from here too (same hoisted-state trick that lets
 * the dialog survive the dropdown closing).
 */
function MobileRoomMenu({
  roomId,
  myUserId,
  isSoleMember,
}: {
  roomId: string;
  myUserId: string;
  isSoleMember: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointer(e: PointerEvent) {
      const el = wrapRef.current;
      if (el && !el.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <>
      <div ref={wrapRef} className="relative">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-haspopup="menu"
          aria-expanded={open}
          className="flex h-9 items-center justify-center rounded-full border border-white/50 bg-white/60 px-3 font-display italic text-sm text-neutral-700 shadow-sm backdrop-blur-md active:scale-[0.96] dark:border-white/10 dark:bg-neutral-900/60 dark:text-neutral-300"
        >
          ⋯
        </button>
        {open && (
          <div
            role="menu"
            className="absolute right-0 top-full z-40 mt-2 flex w-60 flex-col overflow-hidden rounded-2xl border border-white/60 bg-white/95 shadow-2xl backdrop-blur-md dark:border-white/10 dark:bg-neutral-900/95"
          >
            <p className="px-4 pt-3 text-[10px] font-medium uppercase tracking-[0.18em] text-neutral-500">
              Reports
            </p>
            <Link
              role="menuitem"
              href={`/rooms/${roomId}/sunday`}
              onClick={() => setOpen(false)}
              className="flex items-center gap-2 px-4 py-2.5 font-display italic text-sm text-neutral-800 hover:bg-pink-50/70 dark:text-neutral-200 dark:hover:bg-pink-950/40"
            >
              <span aria-hidden>🌅</span>
              <span>Sunday report</span>
            </Link>
            <Link
              role="menuitem"
              href={`/rooms/${roomId}/report`}
              onClick={() => setOpen(false)}
              className="flex items-center gap-2 px-4 py-2.5 font-display italic text-sm text-neutral-800 hover:bg-amber-50/70 dark:text-neutral-200 dark:hover:bg-amber-950/40"
            >
              <span aria-hidden>📊</span>
              <span>Fortnightly report</span>
            </Link>
            <p className="border-t border-neutral-200/60 px-4 pb-1 pt-3 text-[10px] font-medium uppercase tracking-[0.18em] text-neutral-500 dark:border-neutral-700/60">
              Room
            </p>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                setInviteOpen(true);
              }}
              className="flex items-center gap-2 px-4 py-2.5 text-left font-display italic text-sm text-blue-800 hover:bg-blue-50/80 dark:text-blue-200 dark:hover:bg-blue-950/40"
            >
              <span aria-hidden>✉️</span>
              <span>Invite someone</span>
            </button>
            <div className="[&>*]:w-full [&>button]:!flex [&>button]:!w-full [&>button]:!justify-start [&>button]:!items-center [&>button]:!gap-2 [&>button]:!rounded-none [&>button]:!border-0 [&>button]:!bg-transparent [&>button]:!px-4 [&>button]:!py-2.5 [&>button]:!text-left [&>button]:!font-display [&>button]:!text-sm  [&>button]:!text-red-700 [&>button:hover]:!bg-red-50/80 dark:[&>button]:!text-red-300 dark:[&>button:hover]:!bg-red-950/40">
              <LeaveRoomButton
                roomId={roomId}
                userId={myUserId}
                isSoleMember={isSoleMember}
              />
            </div>
          </div>
        )}
      </div>
      {inviteOpen && <InviteModal onClose={() => setInviteOpen(false)} />}
    </>
  );
}

/**
 * Single "⋯ Room" dropdown — consolidates the two low-frequency room
 * actions (Invite someone, Leave room) into one menu so the top bar
 * isn't crowded. Reuses the actual interactive components (they manage
 * their own modals/confirmations) by rendering them directly inside
 * the menu items — the dropdown stays open just long enough for the
 * child to take over.
 */
function RoomActionsDropdown({
  roomId,
  myUserId,
  isSoleMember,
}: {
  roomId: string;
  myUserId: string;
  isSoleMember: boolean;
}) {
  const [open, setOpen] = useState(false);
  // Invite modal + leave confirm state live at the dropdown level, NOT
  // inside conditionally-rendered menu items. Previously we nested the
  // invite button inside the dropdown; clicks on the invite MODAL (which
  // portals to body, outside the dropdown's wrapRef) then fired the
  // dropdown's outside-click handler, which closed the dropdown, which
  // unmounted the invite button, which unmounted the modal state —
  // dialog blinked closed instantly. Hoisting the modal state fixes it.
  const [inviteOpen, setInviteOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointer(e: PointerEvent) {
      const el = wrapRef.current;
      if (el && !el.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <>
      <div ref={wrapRef} className="relative">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-haspopup="menu"
          aria-expanded={open}
          className="rounded-full border border-white/50 bg-white/60 px-4 py-2 font-display italic text-sm text-neutral-700 shadow-sm backdrop-blur-md transition-all hover:bg-white/80 hover:shadow-md active:scale-[0.98] dark:border-white/10 dark:bg-neutral-900/60 dark:text-neutral-300 dark:hover:bg-neutral-900/80"
        >
          ⋯ Room{' '}
          <span aria-hidden className="ml-0.5 text-[10px] opacity-70">▾</span>
        </button>
        {open && (
          <div
            role="menu"
            className="absolute right-0 top-full z-40 mt-2 flex w-56 flex-col gap-1 overflow-hidden rounded-2xl border border-white/60 bg-white/90 p-2 shadow-xl backdrop-blur-md dark:border-white/10 dark:bg-neutral-900/85"
          >
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                setInviteOpen(true);
              }}
              className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left font-display italic text-sm text-blue-800 transition-colors hover:bg-blue-50/80 dark:text-blue-200 dark:hover:bg-blue-950/40"
            >
              <span aria-hidden>✉️</span>
              <span>Invite someone</span>
            </button>
            <div className="[&>*]:w-full [&>button]:!flex [&>button]:!w-full [&>button]:!justify-start [&>button]:!rounded-xl [&>button]:!border-0 [&>button]:!bg-transparent [&>button]:!px-3 [&>button]:!py-2 [&>button]:!text-left [&>button]:!font-display [&>button]:!text-sm  [&>button]:!text-red-700 [&>button:hover]:!bg-red-50/80 dark:[&>button]:!text-red-300 dark:[&>button:hover]:!bg-red-950/40">
              <LeaveRoomButton
                roomId={roomId}
                userId={myUserId}
                isSoleMember={isSoleMember}
              />
            </div>
          </div>
        )}
      </div>
      {inviteOpen && <InviteModal onClose={() => setInviteOpen(false)} />}
    </>
  );
}

/**
 * Single "Reports ▾" pill that opens a small dropdown with both report
 * destinations. Replaces the two prior buttons (🌅 Sunday + 📊 14-day) so the
 * top action bar is less crowded.
 */
function ReportsDropdown({ roomId }: { roomId: string }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointer(e: PointerEvent) {
      const el = wrapRef.current;
      if (el && !el.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="rounded-full border border-white/50 bg-gradient-to-r from-pink-50/80 to-amber-50/80 px-4 py-2 font-display italic text-sm text-neutral-700 shadow-sm backdrop-blur-md transition-all hover:shadow-md active:scale-[0.98] dark:border-white/10 dark:from-pink-950/40 dark:to-amber-950/40 dark:text-neutral-300"
      >
        📊 Reports{' '}
        <span aria-hidden className="ml-0.5 text-[10px] opacity-70">▾</span>
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-40 mt-2 w-56 overflow-hidden rounded-2xl border border-white/60 bg-white/90 py-1 text-sm shadow-xl backdrop-blur-md dark:border-white/10 dark:bg-neutral-900/85"
        >
          <Link
            role="menuitem"
            href={`/rooms/${roomId}/sunday`}
            onClick={() => setOpen(false)}
            className="flex items-center gap-2 px-4 py-2.5 font-display italic text-neutral-800 transition-colors hover:bg-pink-50/70 dark:text-neutral-200 dark:hover:bg-pink-950/40"
          >
            <span aria-hidden>🌅</span>
            <span>Sunday report</span>
          </Link>
          <Link
            role="menuitem"
            href={`/rooms/${roomId}/report`}
            onClick={() => setOpen(false)}
            className="flex items-center gap-2 px-4 py-2.5 font-display italic text-neutral-800 transition-colors hover:bg-amber-50/70 dark:text-neutral-200 dark:hover:bg-amber-950/40"
          >
            <span aria-hidden>📊</span>
            <span>Fortnightly report</span>
          </Link>
        </div>
      )}
    </div>
  );
}

function Tabs({ active, roomId }: { active: RoomTabId; roomId: string }) {
  const items: { id: RoomTabId; label: string; emoji: string; href: string }[] = [
    { id: 'home',       label: 'Home',       emoji: '🏡',  href: `/rooms/${roomId}` },
    { id: 'date-night', label: 'Date night', emoji: '💕',  href: `/rooms/${roomId}/date-night` },
    { id: 'safe-space', label: 'Safe space', emoji: '🛡️', href: `/rooms/${roomId}/safe-space` },
  ];
  return (
    <nav
      aria-label="Room sections"
      className="relative flex items-center gap-1 rounded-full border border-white/60 bg-white/60 p-1 shadow-sm backdrop-blur-md dark:border-white/10 dark:bg-neutral-900/60"
    >
      {items.map((it) => {
        const isActive = it.id === active;
        return (
          <Link
            key={it.id}
            href={it.href}
            aria-current={isActive ? 'page' : undefined}
            className="relative flex items-center gap-1.5 rounded-full px-4 py-1.5 font-display italic text-sm transition-colors"
          >
            {isActive && (
              <motion.span
                layoutId="room-tab-active"
                className="absolute inset-0 rounded-full bg-neutral-900 shadow-sm dark:bg-white"
                transition={{ type: 'spring', stiffness: 320, damping: 28 }}
                aria-hidden
              />
            )}
            <span
              className={`relative ${
                isActive
                  ? 'text-white dark:text-neutral-900'
                  : 'text-neutral-700 dark:text-neutral-300'
              }`}
            >
              {it.emoji}
            </span>
            <span
              className={`relative hidden sm:inline ${
                isActive
                  ? 'text-white dark:text-neutral-900'
                  : 'text-neutral-700 dark:text-neutral-300'
              }`}
            >
              {it.label}
            </span>
          </Link>
        );
      })}
    </nav>
  );
}
