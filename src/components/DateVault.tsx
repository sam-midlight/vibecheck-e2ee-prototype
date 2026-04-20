'use client';

/**
 * DateVault — pop-up sub-room for a single matched date.
 *
 * Lives at /rooms/{roomId}/dates/{dateId}. Self-contained surface with:
 *   - Header: title, energy badge, T-minus countdown, back link.
 *   - Vibe preview dock: live mini-cards for each member's current
 *     vibe vector so you check in on each other while planning.
 *   - Spark prompts: hardcoded library, energy-aware.
 *   - Wall of intent: text + photo posts, scoped by dateId via the
 *     new `date_post` event. Reuses the encrypted-image attachment
 *     primitive (same as Messages).
 *   - Decision Roulette: per-date slices via the existing
 *     `date_roulette_*` events with the new optional dateId field.
 *   - Capture memory: posts a date_memory event (text or photo).
 *
 * Auto-archive: once `scheduledAt + 24h` has passed, the vault is
 * "locked" — read-only, archive view only. Detection lives in
 * MemoryBank's projection; this component just shows a banner + hides
 * compose surfaces.
 *
 * Looming glow: the page background gradient shifts hue based on the
 * date's inferred category (chill = lavender, adventure = ember,
 * etc.). Pure CSS, no extra deps.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { AnimatePresence, motion } from 'framer-motion';
import { displayName as fmtDisplayName } from '@/lib/domain/displayName';
import { describeError } from '@/lib/domain/errors';
import { uniqueMembers } from '@/lib/domain/members';
import { hueForUser } from '@/lib/domain/userTheme';
import { markVaultSeen } from '@/lib/domain/vaultSeen';
import { useVibeState } from '@/lib/domain/vibeState';
import {
  inferCategoryForTitle,
  type DateCategory,
} from '@/lib/domain/dateHeuristics';
import {
  decryptImageAttachment,
  prepareImageForUpload,
} from '@/lib/e2ee-core';
import {
  downloadAttachment,
  uploadAttachment,
} from '@/lib/supabase/queries';
import type { ImageAttachmentHeader, RoomEvent } from '@/lib/domain/events';
import { Roulette } from './Roulette';
import {
  useRoom,
  useRoomProjection,
  type RoomEventRecord,
} from './RoomProvider';

const DAY_MS = 24 * 60 * 60 * 1000;

interface DateState {
  ideaId: string;
  title: string;
  energy: 'low' | 'medium' | 'high';
  invitedUserIds: string[];
  /** Latest-ts of any date_invite_update for this date. */
  inviteUpdateTs: number;
  scheduledAt: string | null;
  scheduledTs: number | null;
  voters: Set<string>;
  completedBy: Set<string>;
  deleted: boolean;
}

// ---------------------------------------------------------------------------
// Looming-glow palette per inferred date category.
// ---------------------------------------------------------------------------

const CATEGORY_GLOW: Record<DateCategory, { from: string; to: string; accent: string }> = {
  chill:     { from: 'hsla(265, 60%, 25%, 0.45)', to: 'hsla(220, 50%, 20%, 0.55)', accent: '#a78bfa' },
  tender:    { from: 'hsla(330, 60%, 28%, 0.50)', to: 'hsla(15, 55%, 25%, 0.55)',  accent: '#f472b6' },
  cosy:      { from: 'hsla(30, 60%, 28%, 0.50)',  to: 'hsla(355, 50%, 22%, 0.55)', accent: '#fb923c' },
  adventure: { from: 'hsla(15, 70%, 30%, 0.55)',  to: 'hsla(40, 65%, 25%, 0.55)',  accent: '#fb923c' },
  social:    { from: 'hsla(55, 65%, 28%, 0.50)',  to: 'hsla(20, 60%, 25%, 0.55)',  accent: '#facc15' },
  creative:  { from: 'hsla(190, 55%, 25%, 0.50)', to: 'hsla(280, 50%, 25%, 0.55)', accent: '#22d3ee' },
};

// ---------------------------------------------------------------------------
// Spark prompts — hardcoded library tuned to the date's energy level.
// ---------------------------------------------------------------------------

const SPARK_PROMPTS: Record<'low' | 'medium' | 'high', string[]> = {
  low: [
    'What\'s a small thing today that made you smile?',
    'When did you last feel completely safe with each other?',
    'Pick one quality you appreciate about each other right now.',
    'What\'s something you\'re looking forward to next week?',
    'Describe a memory you\'d like to revisit.',
  ],
  medium: [
    'If you could redo one moment from this week, what would you tweak?',
    'What\'s a small adventure you\'d love to take together?',
    'Trade one piece of gossip — work, friends, family.',
    'What song would you put on right now if you could?',
    'Pick one thing you\'d each like to learn this year.',
  ],
  high: [
    'Take a silly selfie in the kitchen.',
    'Two-minute dance break — pick a song each.',
    'Make up a fake biography for a stranger you saw today.',
    'Race to the corner. Loser owes a back rub.',
    'Try a brand new high-five handshake.',
  ],
};

// ---------------------------------------------------------------------------
// Main Vault
// ---------------------------------------------------------------------------

export function DateVault({ dateId }: { dateId: string }) {
  const { events, members, room, myUserId, displayNames, memberEmojis } = useRoom();

  // Reduce events into the date's state.
  const date = useRoomProjection<DateState | null>((acc, rec) => {
    const ev = rec.event;
    switch (ev.type) {
      case 'date_idea_add': {
        if (ev.ideaId !== dateId) return acc;
        if (acc) return acc;
        return {
          ideaId: ev.ideaId,
          title: ev.title,
          energy: ev.energy,
          invitedUserIds: ev.invitedUserIds ?? [],
          inviteUpdateTs: 0,
          scheduledAt: null,
          scheduledTs: null,
          voters: new Set(),
          completedBy: new Set(),
          deleted: false,
        };
      }
      case 'date_invite_update': {
        if (ev.ideaId !== dateId || !acc) return acc;
        if (ev.ts <= acc.inviteUpdateTs) return acc;
        return {
          ...acc,
          invitedUserIds: ev.invitedUserIds,
          inviteUpdateTs: ev.ts,
        };
      }
      case 'date_idea_delete':
        return ev.ideaId === dateId && acc ? { ...acc, deleted: true } : acc;
      case 'date_idea_schedule':
        if (ev.ideaId !== dateId || !acc) return acc;
        return {
          ...acc,
          scheduledAt: ev.scheduledAt,
          scheduledTs: Date.parse(ev.scheduledAt) || null,
        };
      case 'date_idea_vote':
        if (ev.ideaId !== dateId || !acc) return acc;
        return { ...acc, voters: new Set([...acc.voters, rec.senderId]) };
      case 'date_idea_unvote':
        if (ev.ideaId !== dateId || !acc) return acc;
        const next = new Set(acc.voters);
        next.delete(rec.senderId);
        return { ...acc, voters: next };
      case 'date_idea_complete':
        if (ev.ideaId !== dateId || !acc) return acc;
        return {
          ...acc,
          completedBy: new Set([...acc.completedBy, rec.senderId]),
        };
    }
    return acc;
  }, null);

  const memberRows = useMemo(
    () => (room ? uniqueMembers(members, room.current_generation) : []),
    [members, room],
  );

  // Tick once per second so the countdown stays live without the
  // whole projection refolding.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const h = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(h);
  }, []);

  // Mark this vault as seen on mount AND whenever new vault-scoped
  // activity arrives while the user is here. Idempotent — bumps the
  // localStorage cursor to the latest known event ts in this room.
  useEffect(() => {
    if (!myUserId) return;
    markVaultSeen(myUserId, dateId);
  }, [myUserId, dateId, events.length]);

  if (!room || !myUserId) return null;
  if (!date || date.deleted) {
    return (
      <main className="mx-auto max-w-2xl px-4 pb-16 pt-10 text-sm">
        <Link
          href={`/rooms/${room.id}/date-night`}
          className="font-display italic text-neutral-700 underline underline-offset-4 dark:text-neutral-300"
        >
          ← back to dates
        </Link>
        <div className="mt-6 rounded-3xl border border-white/40 bg-white/40 p-8 shadow-lg backdrop-blur-md dark:border-white/10 dark:bg-neutral-900/45">
          <p className="font-display italic text-2xl text-neutral-900 dark:text-neutral-50">
            This date isn&apos;t around anymore.
          </p>
          <p className="mt-2 text-neutral-700 dark:text-neutral-300">
            It might have been deleted, or the link is from another room.
          </p>
        </div>
      </main>
    );
  }

  const category = inferCategoryForTitle(date.title, date.energy);
  const glow = CATEGORY_GLOW[category];
  const allCompleted =
    memberRows.length > 0 &&
    memberRows.every((m) => date.completedBy.has(m.user_id));
  const expiredAt = date.scheduledTs != null ? date.scheduledTs + DAY_MS : null;
  const isLocked =
    allCompleted || (expiredAt != null && now > expiredAt);

  // Empty invitedUserIds = whole room (legacy + untargeted dates).
  // Otherwise the vault is scoped to that explicit set.
  const isTargeted = date.invitedUserIds.length > 0;
  const invitedSet = new Set(date.invitedUserIds);
  const amInvited = !isTargeted || invitedSet.has(myUserId);
  // For the chip row, prefer the invited list when targeted; fall
  // back to all current-gen members otherwise.
  const displayedRoster = isTargeted
    ? memberRows.filter((m) => invitedSet.has(m.user_id))
    : memberRows;
  // Read-only mode: not invited OR vault locked. Compose surfaces
  // hide; reading still works because every encrypted blob is
  // visible to every room member by design.
  const readOnly = isLocked || !amInvited;

  return (
    <>
      {/* Looming glow — fixed gradient overlay that sits behind the
          page content but above the lava lamp. Slowly drifts hue
          via animate-pulse-like keyframes. */}
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 -z-[1] transition-opacity duration-700"
        style={{
          background: `radial-gradient(ellipse 70% 55% at 18% 0%, ${glow.from}, transparent 60%),
                       radial-gradient(ellipse 70% 55% at 82% 90%, ${glow.to}, transparent 60%)`,
        }}
      />

      <main className="mx-auto max-w-3xl space-y-5 px-4 pb-24 pt-6">
        <VaultHeader
          roomId={room.id}
          date={date}
          now={now}
          glowAccent={glow.accent}
          isLocked={isLocked}
        />

        <VaultControls
          dateId={dateId}
          date={date}
          memberRows={memberRows}
          memberEmojis={memberEmojis}
          displayNames={displayNames}
          myUserId={myUserId}
          readOnly={readOnly}
        />

        <InvitedRoster
          isTargeted={isTargeted}
          amInvited={amInvited}
          displayedRoster={displayedRoster}
          memberEmojis={memberEmojis}
          displayNames={displayNames}
          myUserId={myUserId}
        />

        <VibePreviewDock memberRows={displayedRoster} memberEmojis={memberEmojis} displayNames={displayNames} myUserId={myUserId} />

        {!readOnly && <SparkButton energy={date.energy} />}

        <WallOfIntent
          dateId={dateId}
          isLocked={readOnly}
          memberEmojis={memberEmojis}
          displayNames={displayNames}
          myUserId={myUserId}
        />

        {/* Real Roulette wheel scoped to this dateId. Same graphics
            and behaviour as the room-level one — just a unique slice
            pool that lives only inside this vault. Read-only when the
            vault is locked or the viewer is a spectator. */}
        <section className="rounded-3xl border border-white/40 bg-white/45 p-3 shadow-lg backdrop-blur-md dark:border-white/10 dark:bg-neutral-900/50">
          <div className="mb-2 flex items-center justify-between">
            <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-neutral-700 dark:text-neutral-300">
              Decision roulette
            </span>
            {readOnly && (
              <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-neutral-500">
                read-only
              </span>
            )}
          </div>
          <Roulette dateId={dateId} variant="date_night" />
        </section>

        {!readOnly && <CaptureMemoryButton dateId={dateId} />}

        {!readOnly && (
          <MarkCompleteButton
            dateId={dateId}
            iCompleted={date.completedBy.has(myUserId)}
            allCompleted={allCompleted}
          />
        )}

        {isLocked && (
          <div className="rounded-3xl border border-white/40 bg-white/45 p-5 text-center text-sm text-neutral-800 shadow-lg backdrop-blur-md dark:border-white/10 dark:bg-neutral-900/55 dark:text-neutral-200">
            <p className="font-display italic text-lg">
              🔒 Vault locked — moved to the Memory Bank.
            </p>
            <p className="mt-2 text-xs text-neutral-700 dark:text-neutral-300">
              Posts and roulette spins are read-only. Memories captured
              during the date stay forever.
            </p>
          </div>
        )}
      </main>
    </>
  );
}

// ---------------------------------------------------------------------------
// Header — title, energy chip, T-minus countdown, back link
// ---------------------------------------------------------------------------

function VaultHeader({
  roomId,
  date,
  now,
  glowAccent,
  isLocked,
}: {
  roomId: string;
  date: DateState;
  now: number;
  glowAccent: string;
  isLocked: boolean;
}) {
  const diff = date.scheduledTs != null ? date.scheduledTs - now : null;
  const countdown = diff != null && diff > 0 ? formatCountdown(diff) : null;
  return (
    <header className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <Link
          href={`/rooms/${roomId}/date-night`}
          className="inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.18em] text-neutral-600 transition-colors hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100"
        >
          ← all dates
        </Link>
        <Link
          href={`/rooms/${roomId}`}
          className="inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.18em] text-neutral-600 transition-colors hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100"
        >
          🏠 main room
        </Link>
      </div>
      <div
        className="rounded-3xl border border-white/40 bg-white/45 p-5 shadow-lg backdrop-blur-md dark:border-white/10 dark:bg-neutral-900/50"
        style={{ boxShadow: `0 12px 40px -8px ${glowAccent}55, 0 4px 12px rgba(0,0,0,0.2)` }}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-neutral-600 dark:text-neutral-400">
              {date.energy} energy {isLocked ? '· locked' : '· vault'}
            </p>
            <h1 className="mt-1 font-display italic text-3xl leading-tight text-neutral-900 dark:text-neutral-50 sm:text-4xl">
              {date.title}
            </h1>
            {date.scheduledAt && (
              <p className="mt-1 text-sm text-neutral-700 dark:text-neutral-300">
                {new Date(date.scheduledTs!).toLocaleString([], {
                  weekday: 'short',
                  month: 'short',
                  day: 'numeric',
                  hour: 'numeric',
                  minute: '2-digit',
                })}
              </p>
            )}
          </div>
          {countdown && (
            <div className="rounded-2xl border border-white/60 bg-white/85 px-3 py-2 text-center shadow-sm backdrop-blur-md dark:border-white/10 dark:bg-neutral-900/70">
              <p className="font-mono text-[9px] uppercase tracking-[0.18em] text-neutral-600 dark:text-neutral-300">
                T-minus
              </p>
              <p className="mt-0.5 font-display italic text-xl tabular-nums text-neutral-900 dark:text-neutral-50">
                {countdown}
              </p>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}

// ---------------------------------------------------------------------------
// VaultControls — Edit time + Manage guests, inline expandable
// ---------------------------------------------------------------------------

function VaultControls({
  dateId,
  date,
  memberRows,
  memberEmojis,
  displayNames,
  myUserId,
  readOnly,
}: {
  dateId: string;
  date: DateState;
  memberRows: { user_id: string }[];
  memberEmojis: Record<string, string>;
  displayNames: Record<string, string>;
  myUserId: string;
  readOnly: boolean;
}) {
  const [open, setOpen] = useState<'time' | 'guests' | null>(null);
  if (readOnly) return null;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setOpen(open === 'time' ? null : 'time')}
          aria-expanded={open === 'time'}
          className="rounded-full border border-white/60 bg-white/80 px-3 py-1 font-display italic text-xs text-neutral-800 transition-all hover:bg-white active:scale-[1.02] dark:border-white/10 dark:bg-neutral-900/60 dark:text-neutral-200"
        >
          ⏰ {date.scheduledAt ? 'Edit time' : 'Set time'}
        </button>
        <button
          type="button"
          onClick={() => setOpen(open === 'guests' ? null : 'guests')}
          aria-expanded={open === 'guests'}
          className="rounded-full border border-white/60 bg-white/80 px-3 py-1 font-display italic text-xs text-neutral-800 transition-all hover:bg-white active:scale-[1.02] dark:border-white/10 dark:bg-neutral-900/60 dark:text-neutral-200"
        >
          👥 Manage guests
        </button>
      </div>
      {open === 'time' && <EditTimeForm dateId={dateId} current={date.scheduledAt} onDone={() => setOpen(null)} />}
      {open === 'guests' && (
        <ManageGuestsForm
          dateId={dateId}
          currentInvited={date.invitedUserIds}
          memberRows={memberRows}
          memberEmojis={memberEmojis}
          displayNames={displayNames}
          myUserId={myUserId}
          onDone={() => setOpen(null)}
        />
      )}
    </div>
  );
}

function EditTimeForm({
  dateId,
  current,
  onDone,
}: {
  dateId: string;
  current: string | null;
  onDone: () => void;
}) {
  const { appendEvent } = useRoom();
  // datetime-local needs a YYYY-MM-DDTHH:mm slug. ISO strings carry
  // timezone — slice to local format.
  const initial = useMemo(() => {
    if (!current) return '';
    const d = new Date(current);
    if (Number.isNaN(d.getTime())) return '';
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }, [current]);
  const [value, setValue] = useState<string>(initial);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!value) return;
    setBusy(true);
    setErr(null);
    try {
      const iso = new Date(value).toISOString();
      await appendEvent({
        type: 'date_idea_schedule',
        ideaId: dateId,
        scheduledAt: iso,
        ts: Date.now(),
      });
      onDone();
    } catch (e) {
      setErr(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={save}
      className="flex flex-wrap items-end gap-2 rounded-2xl border border-white/40 bg-white/45 p-3 shadow-sm backdrop-blur-md dark:border-white/10 dark:bg-neutral-900/50"
    >
      <label className="flex flex-col gap-1">
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-neutral-700 dark:text-neutral-300">
          When
        </span>
        <input
          type="datetime-local"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="rounded-xl border border-white/40 bg-white/80 px-3 py-1.5 text-sm text-neutral-900 outline-none focus:border-amber-300 focus:ring-2 focus:ring-amber-300/40 dark:border-white/10 dark:bg-neutral-950 dark:text-neutral-100"
        />
      </label>
      <button
        type="submit"
        disabled={busy || !value}
        className="rounded-full bg-gradient-to-br from-amber-300 via-amber-400 to-orange-500 px-4 py-1.5 font-display italic text-sm text-white shadow-sm ring-1 ring-amber-200/60 transition-all hover:scale-[1.04] active:scale-[1.02] disabled:opacity-50"
      >
        {busy ? 'saving…' : 'Save'}
      </button>
      <button
        type="button"
        onClick={onDone}
        className="rounded-full px-3 py-1.5 text-xs text-neutral-500 hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-100"
      >
        cancel
      </button>
      {err && <p className="basis-full text-xs text-red-600">{err}</p>}
    </form>
  );
}

function ManageGuestsForm({
  dateId,
  currentInvited,
  memberRows,
  memberEmojis,
  displayNames,
  myUserId,
  onDone,
}: {
  dateId: string;
  currentInvited: string[];
  memberRows: { user_id: string }[];
  memberEmojis: Record<string, string>;
  displayNames: Record<string, string>;
  myUserId: string;
  onDone: () => void;
}) {
  const { appendEvent } = useRoom();
  const isCurrentlyTargeted = currentInvited.length > 0;
  // Default to the current invited set, or whole room if untargeted.
  const initialChosen = useMemo(
    () =>
      new Set(
        isCurrentlyTargeted
          ? currentInvited
          : memberRows.map((m) => m.user_id),
      ),
    [currentInvited, memberRows, isCurrentlyTargeted],
  );
  const [chosen, setChosen] = useState<Set<string>>(initialChosen);
  const [openToRoom, setOpenToRoom] = useState<boolean>(!isCurrentlyTargeted);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function toggle(uid: string) {
    setChosen((prev) => {
      const next = new Set(prev);
      if (next.has(uid)) next.delete(uid);
      else next.add(uid);
      return next;
    });
  }

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      // "Open to whole room" emits an empty array which clears any
      // prior targeting and reverts to whole-room semantics.
      const invitedUserIds = openToRoom
        ? []
        : (() => {
            const set = new Set(chosen);
            // Always preserve the current viewer in the invited set
            // when targeting — otherwise you'd lock yourself out.
            set.add(myUserId);
            return Array.from(set);
          })();
      await appendEvent({
        type: 'date_invite_update',
        ideaId: dateId,
        invitedUserIds,
        ts: Date.now(),
      });
      onDone();
    } catch (e) {
      setErr(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3 rounded-2xl border border-white/40 bg-white/45 p-3 shadow-sm backdrop-blur-md dark:border-white/10 dark:bg-neutral-900/50">
      <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-neutral-700 dark:text-neutral-300">
        Guests
      </p>
      <p className="text-xs leading-relaxed text-neutral-700 dark:text-neutral-300">
        Add or remove people from this date room without affecting the main
        room&apos;s membership. Uninvited members stay in the main room and
        can spectate, but can&apos;t post or capture memories here.
      </p>
      <div className="flex gap-1.5">
        <button
          type="button"
          onClick={() => setOpenToRoom(true)}
          className={`flex-1 rounded-xl border px-2 py-1.5 text-[11px] transition-all ${
            openToRoom
              ? 'border-emerald-500 bg-white/95 font-medium shadow-sm dark:border-emerald-400 dark:bg-neutral-900/85'
              : 'border-white/40 bg-white/60 hover:bg-white/80 dark:border-white/10 dark:bg-neutral-900/40'
          }`}
        >
          Whole room
        </button>
        <button
          type="button"
          onClick={() => setOpenToRoom(false)}
          className={`flex-1 rounded-xl border px-2 py-1.5 text-[11px] transition-all ${
            !openToRoom
              ? 'border-emerald-500 bg-white/95 font-medium shadow-sm dark:border-emerald-400 dark:bg-neutral-900/85'
              : 'border-white/40 bg-white/60 hover:bg-white/80 dark:border-white/10 dark:bg-neutral-900/40'
          }`}
        >
          Specific people
        </button>
      </div>
      {!openToRoom && (
        <div className="flex flex-wrap gap-1.5">
          {memberRows.map((m) => {
            const isMe = m.user_id === myUserId;
            const selected = isMe || chosen.has(m.user_id);
            const name = firstWord(fmtDisplayName(m.user_id, displayNames, myUserId, null));
            const emoji = memberEmojis[m.user_id];
            return (
              <button
                key={m.user_id}
                type="button"
                disabled={isMe}
                onClick={() => toggle(m.user_id)}
                className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] transition-all ${
                  selected
                    ? 'border-emerald-400 bg-white/95 text-neutral-900 shadow-sm dark:border-emerald-500 dark:bg-neutral-900/80 dark:text-neutral-100'
                    : 'border-white/40 bg-white/60 text-neutral-700 hover:bg-white/80 dark:border-white/10 dark:bg-neutral-900/40 dark:text-neutral-300'
                } ${isMe ? 'cursor-default opacity-90' : ''}`}
                title={isMe ? 'you (always invited)' : undefined}
              >
                {emoji && <span aria-hidden>{emoji}</span>}
                <span className="font-medium">{isMe ? 'you' : name}</span>
              </button>
            );
          })}
        </div>
      )}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => void save()}
          disabled={busy}
          className="rounded-full bg-gradient-to-br from-amber-300 via-amber-400 to-orange-500 px-4 py-1.5 font-display italic text-sm text-white shadow-sm ring-1 ring-amber-200/60 transition-all hover:scale-[1.04] active:scale-[1.02] disabled:opacity-50"
        >
          {busy ? 'saving…' : 'Save guests'}
        </button>
        <button
          type="button"
          onClick={onDone}
          className="rounded-full px-3 py-1.5 text-xs text-neutral-500 hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-100"
        >
          cancel
        </button>
      </div>
      {err && <p className="text-xs text-red-600">{err}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Invited roster + uninvited-viewer banner
// ---------------------------------------------------------------------------

function InvitedRoster({
  isTargeted,
  amInvited,
  displayedRoster,
  memberEmojis,
  displayNames,
  myUserId,
}: {
  isTargeted: boolean;
  amInvited: boolean;
  displayedRoster: { user_id: string }[];
  memberEmojis: Record<string, string>;
  displayNames: Record<string, string>;
  myUserId: string;
}) {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-neutral-700 dark:text-neutral-300">
          {isTargeted ? 'Invited' : 'Whole room'}
        </span>
        {displayedRoster.map((m) => {
          const hue = hueForUser(m.user_id);
          const name = firstWord(
            fmtDisplayName(m.user_id, displayNames, myUserId, null),
          );
          const emoji = memberEmojis[m.user_id];
          const isMe = m.user_id === myUserId;
          return (
            <span
              key={m.user_id}
              className="inline-flex items-center gap-1.5 rounded-full border bg-white/80 px-2.5 py-0.5 text-[11px] shadow-sm backdrop-blur-md dark:bg-neutral-900/60"
              style={{
                borderColor: hue,
                boxShadow: isMe ? `0 0 0 2px ${hue}44` : undefined,
              }}
            >
              {emoji && <span aria-hidden>{emoji}</span>}
              <span className="font-medium text-neutral-900 dark:text-neutral-50">
                {isMe ? 'you' : name}
              </span>
            </span>
          );
        })}
      </div>

      {isTargeted && !amInvited && (
        <div
          role="status"
          className="rounded-2xl border border-amber-300/70 bg-amber-50/80 px-3 py-2 text-xs text-amber-900 shadow-sm backdrop-blur-md dark:border-amber-700/50 dark:bg-amber-950/60 dark:text-amber-100"
        >
          <span className="font-display italic">Spectator mode —</span> this
          vault was set up for someone else. You can read along; posts,
          roulette, and memory capture are disabled.
        </div>
      )}
    </div>
  );
}

function formatCountdown(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  if (mins > 0) return `${mins}m ${secs}s`;
  return `${secs}s`;
}

// ---------------------------------------------------------------------------
// Vibe Preview Dock — small live cards per member with their P/E/S axes
// ---------------------------------------------------------------------------

function VibePreviewDock({
  memberRows,
  memberEmojis,
  displayNames,
  myUserId,
}: {
  memberRows: { user_id: string }[];
  memberEmojis: Record<string, string>;
  displayNames: Record<string, string>;
  myUserId: string;
}) {
  return (
    <div className="overflow-x-auto">
      <div className="flex gap-2 pb-1">
        {memberRows.map((m) => (
          <MemberVibeChip
            key={m.user_id}
            uid={m.user_id}
            emoji={memberEmojis[m.user_id]}
            name={firstWord(fmtDisplayName(m.user_id, displayNames, myUserId, null))}
          />
        ))}
      </div>
    </div>
  );
}

function MemberVibeChip({
  uid,
  emoji,
  name,
}: {
  uid: string;
  emoji?: string;
  name: string;
}) {
  const state = useVibeState(uid);
  const hue = hueForUser(uid);
  // Convert axis (-1..+1) to a 0–100% bar fill anchored at 50%.
  const barFor = (axis: number) => {
    const clamped = Math.max(-1, Math.min(1, axis));
    return Math.round((clamped + 1) * 50);
  };
  return (
    <div
      className="flex min-w-[120px] flex-col gap-1 rounded-2xl border border-white/40 bg-white/40 p-2.5 backdrop-blur-md dark:border-white/10 dark:bg-neutral-900/45"
      style={{ borderColor: `${hue}55` }}
    >
      <div className="flex items-center gap-1.5">
        <span aria-hidden style={{ color: hue }} className="text-base leading-none">
          {emoji ?? '●'}
        </span>
        <span className="truncate font-display italic text-sm text-neutral-900 dark:text-neutral-50">
          {name}
        </span>
      </div>
      <VibeBar label="P" pct={barFor(state.physical.axis)} hue={hue} />
      <VibeBar label="E" pct={barFor(state.emotional.axis)} hue={hue} />
      <VibeBar label="S" pct={barFor(state.social.axis)} hue={hue} />
    </div>
  );
}

function VibeBar({ label, pct, hue }: { label: string; pct: number; hue: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="font-mono text-[9px] text-neutral-600 dark:text-neutral-400">{label}</span>
      <div className="h-1.5 flex-1 rounded-full bg-neutral-200/60 dark:bg-neutral-800/60">
        <div
          className="h-full rounded-full transition-all"
          style={{ width: `${pct}%`, background: hue }}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Spark — energy-aware conversation/challenge prompt
// ---------------------------------------------------------------------------

function SparkButton({ energy }: { energy: 'low' | 'medium' | 'high' }) {
  const [active, setActive] = useState<string | null>(null);
  function pull() {
    const lib = SPARK_PROMPTS[energy];
    const idx = Math.floor(Math.random() * lib.length);
    setActive(lib[idx]);
  }
  return (
    <div className="rounded-3xl border border-white/40 bg-white/45 p-4 shadow-lg backdrop-blur-md dark:border-white/10 dark:bg-neutral-900/50">
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-neutral-700 dark:text-neutral-300">
          Spark
        </span>
        <button
          type="button"
          onClick={pull}
          className="rounded-full border border-amber-300 bg-amber-50/90 px-3 py-1 font-display italic text-xs text-amber-900 transition-all hover:scale-[1.04] active:scale-[1.02] dark:border-amber-700 dark:bg-amber-950/60 dark:text-amber-100"
        >
          ✨ pull a spark
        </button>
      </div>
      {active && (
        <p className="mt-2 font-display italic text-base leading-snug text-neutral-900 dark:text-neutral-50">
          &ldquo;{active}&rdquo;
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Wall of Intent — text + photo posts scoped to this date.
// ---------------------------------------------------------------------------

interface VaultPost {
  postId: string;
  senderId: string;
  kind: 'text' | 'photo';
  text?: string;
  attachment?: ImageAttachmentHeader;
  ts: number;
  recordId: string;
}

function WallOfIntent({
  dateId,
  isLocked,
  memberEmojis,
  displayNames,
  myUserId,
}: {
  dateId: string;
  isLocked: boolean;
  memberEmojis: Record<string, string>;
  displayNames: Record<string, string>;
  myUserId: string;
}) {
  const posts = useRoomProjection<VaultPost[]>((acc, rec) => {
    const ev = rec.event;
    if (ev.type === 'date_post') {
      if (ev.dateId !== dateId) return acc;
      return [
        ...acc,
        {
          postId: ev.postId,
          senderId: rec.senderId,
          kind: ev.kind,
          text: ev.text,
          attachment: ev.attachment,
          ts: ev.ts,
          recordId: rec.id,
        },
      ];
    }
    if (ev.type === 'date_post_delete') {
      return acc.filter((p) => p.postId !== ev.postId);
    }
    return acc;
  }, []);

  const sorted = useMemo(
    () => [...posts].sort((a, b) => b.ts - a.ts),
    [posts],
  );

  return (
    <section className="space-y-3 rounded-3xl border border-white/40 bg-white/45 p-4 shadow-lg backdrop-blur-md dark:border-white/10 dark:bg-neutral-900/50">
      <div className="flex items-center justify-between">
        <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-neutral-700 dark:text-neutral-300">
          Wall of intent
        </span>
        <span className="font-mono text-[10px] tabular-nums text-neutral-500">
          {sorted.length} {sorted.length === 1 ? 'post' : 'posts'}
        </span>
      </div>
      {!isLocked && <WallComposer dateId={dateId} />}
      {sorted.length === 0 ? (
        <p className="rounded-2xl border border-white/40 bg-white/30 p-4 text-center font-display italic text-sm text-neutral-700 dark:border-white/10 dark:bg-neutral-900/30 dark:text-neutral-300">
          Nothing pinned yet — add the first thought, photo, or link.
        </p>
      ) : (
        <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {sorted.map((p) => (
            <PostCard
              key={p.postId}
              post={p}
              isLocked={isLocked}
              isMine={p.senderId === myUserId}
              senderName={firstWord(fmtDisplayName(p.senderId, displayNames, myUserId, null))}
              senderEmoji={memberEmojis[p.senderId]}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function PostCard({
  post,
  isLocked,
  isMine,
  senderName,
  senderEmoji,
}: {
  post: VaultPost;
  isLocked: boolean;
  isMine: boolean;
  senderName: string;
  senderEmoji?: string;
}) {
  const { appendEvent } = useRoom();
  return (
    <li
      className="relative rounded-2xl border border-white/50 bg-white/85 p-3 shadow-sm backdrop-blur-md dark:border-white/10 dark:bg-neutral-900/65"
      style={{ transform: `rotate(${(post.ts % 5) - 2}deg)` }}
    >
      <div className="mb-1 flex items-center justify-between text-[10px] text-neutral-600 dark:text-neutral-400">
        <span className="flex items-center gap-1">
          {senderEmoji && <span aria-hidden>{senderEmoji}</span>}
          <span className="font-medium">{senderName}</span>
        </span>
        {isMine && !isLocked && (
          <button
            type="button"
            aria-label="delete post"
            onClick={() =>
              void appendEvent({
                type: 'date_post_delete',
                postId: post.postId,
                ts: Date.now(),
              })
            }
            className="rounded-full px-1.5 text-neutral-400 transition-colors hover:text-red-600"
          >
            ×
          </button>
        )}
      </div>
      {post.attachment && <PostImage header={post.attachment} />}
      {post.text && (
        <p className="mt-1 whitespace-pre-wrap break-words text-sm text-neutral-900 dark:text-neutral-50">
          {post.text}
        </p>
      )}
    </li>
  );
}

function PostImage({ header }: { header: ImageAttachmentHeader }) {
  const { room, roomKey } = useRoom();
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let revoke: string | null = null;
    let cancelled = false;
    (async () => {
      if (!room || !roomKey) return;
      try {
        const encryptedBytes = await downloadAttachment({
          roomId: room.id,
          blobId: header.blobId,
        });
        const plaintext = await decryptImageAttachment({
          encryptedBytes,
          roomKey,
          roomId: room.id,
          blobId: header.blobId,
          generation: roomKey.generation,
        });
        if (cancelled) return;
        const blob = new Blob([plaintext.slice().buffer as ArrayBuffer], {
          type: header.mime,
        });
        const url = URL.createObjectURL(blob);
        revoke = url;
        setSrc(url);
      } catch {
        /* noop */
      }
    })();
    return () => {
      cancelled = true;
      if (revoke) URL.revokeObjectURL(revoke);
    };
  }, [header, room, roomKey]);
  return (
    <div className="overflow-hidden rounded-xl">
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt="post"
          className="block w-full object-cover"
          style={{ aspectRatio: `${header.w} / ${header.h}` }}
        />
      ) : (
        <div
          className="bg-neutral-200 dark:bg-neutral-800"
          style={{ aspectRatio: `${header.w} / ${header.h}` }}
        />
      )}
    </div>
  );
}

function WallComposer({ dateId }: { dateId: string }) {
  const { appendEvent, room, roomKey } = useRoom();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function postText(e: React.FormEvent) {
    e.preventDefault();
    if (!text.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      await appendEvent({
        type: 'date_post',
        postId: crypto.randomUUID(),
        dateId,
        kind: 'text',
        text: text.trim(),
        ts: Date.now(),
      });
      setText('');
    } catch (e) {
      setErr(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  async function postPhoto(file: File) {
    if (!room || !roomKey) return;
    setBusy(true);
    setErr(null);
    try {
      const blobId = crypto.randomUUID();
      const { encryptedBytes, header } = await prepareImageForUpload({
        file,
        roomKey,
        roomId: room.id,
        blobId,
      });
      await uploadAttachment({ roomId: room.id, blobId, encryptedBytes });
      const attachmentHeader: Extract<RoomEvent, { type: 'date_post' }>['attachment'] = {
        type: 'image',
        blobId,
        mime: header.mime,
        w: header.w,
        h: header.h,
        byteLen: header.byteLen,
        placeholder: header.placeholder,
      };
      await appendEvent({
        type: 'date_post',
        postId: crypto.randomUUID(),
        dateId,
        kind: 'photo',
        text: text.trim() || undefined,
        attachment: attachmentHeader,
        ts: Date.now(),
      });
      setText('');
    } catch (e) {
      setErr(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={postText} className="space-y-2">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="pin a thought, plan, or link…"
        rows={2}
        maxLength={2000}
        className="block w-full rounded-2xl border border-white/40 bg-white/80 p-3 text-sm text-neutral-900 placeholder:italic placeholder:text-neutral-400 outline-none transition-colors focus:border-amber-300 focus:ring-2 focus:ring-amber-300/40 dark:border-white/10 dark:bg-neutral-950 dark:text-neutral-100"
      />
      <div className="flex flex-wrap gap-2">
        <button
          type="submit"
          disabled={busy || !text.trim()}
          className="rounded-full bg-gradient-to-br from-amber-300 via-amber-400 to-orange-500 px-4 py-1.5 font-display italic text-sm text-white shadow-sm ring-1 ring-amber-200/60 transition-all hover:scale-[1.04] active:scale-[1.02] disabled:opacity-50"
        >
          {busy ? 'pinning…' : 'Pin text'}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void postPhoto(f);
            if (fileInputRef.current) fileInputRef.current.value = '';
          }}
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={busy}
          className="rounded-full border border-white/60 bg-white/80 px-4 py-1.5 font-display italic text-sm text-neutral-800 transition-all hover:bg-white active:scale-[1.02] disabled:opacity-50 dark:border-white/10 dark:bg-neutral-900/60 dark:text-neutral-200"
        >
          📷 Add photo
        </button>
      </div>
      {err && <p className="text-xs text-red-600">{err}</p>}
    </form>
  );
}

// ---------------------------------------------------------------------------
// Date-Vault Roulette — uses the existing date_roulette_* events with
// the new optional dateId scoping.
// ---------------------------------------------------------------------------

interface VaultSlice {
  sliceId: string;
  label: string;
}

interface VaultSpin {
  spinId: string;
  winnerLabel: string;
  ts: number;
}

// DateVaultRoulette removed — replaced by the real <Roulette dateId={...} />
// component. Kept the VaultSlice / VaultSpin interfaces above unused (they
// were inline-only) since they're trivial and removing them touches more
// scope than is worth here.

// ---------------------------------------------------------------------------
// MarkCompleteButton — emits date_idea_complete from this user. When
// every invited member has completed (allCompleted), the vault auto-
// locks and slides into the Memory Bank — no extra event needed for
// the archive transition.
// ---------------------------------------------------------------------------

function MarkCompleteButton({
  dateId,
  iCompleted,
  allCompleted,
}: {
  dateId: string;
  iCompleted: boolean;
  allCompleted: boolean;
}) {
  const { appendEvent } = useRoom();
  const [open, setOpen] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function complete(text: string) {
    setBusy(true);
    setErr(null);
    try {
      await appendEvent({
        type: 'date_idea_complete',
        ideaId: dateId,
        feedback: text.trim().slice(0, 1000),
        ts: Date.now(),
      });
      setFeedback('');
      setOpen(false);
    } catch (e) {
      setErr(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-3xl border border-white/40 bg-white/45 p-3 shadow-sm backdrop-blur-md dark:border-white/10 dark:bg-neutral-900/50">
      {!iCompleted && !open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="w-full rounded-full bg-gradient-to-br from-emerald-300 via-emerald-500 to-teal-600 px-4 py-2 font-display italic text-sm text-white shadow-sm ring-1 ring-emerald-200/60 transition-all hover:scale-[1.02] active:scale-[1.04]"
        >
          ✨ Mark date as complete
        </button>
      )}
      {!iCompleted && open && (
        <div className="space-y-2">
          <p className="font-display italic text-sm text-neutral-900 dark:text-neutral-50">
            How did the date go?
          </p>
          <p className="text-xs text-neutral-700 dark:text-neutral-300">
            Once both of you wrap, this comment is frozen into the
            Memory Bank — no edits.
          </p>
          <textarea
            value={feedback}
            onChange={(e) => setFeedback(e.target.value.slice(0, 1000))}
            placeholder="What landed, what didn't, anything you want to remember…"
            rows={3}
            maxLength={1000}
            autoFocus
            className="block w-full rounded-2xl border border-white/40 bg-white/80 p-3 text-sm text-neutral-900 placeholder:italic placeholder:text-neutral-400 outline-none focus:border-emerald-400 focus:ring-2 focus:ring-emerald-300/40 dark:border-white/10 dark:bg-neutral-950 dark:text-neutral-100"
          />
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void complete(feedback)}
              disabled={busy}
              className="rounded-full bg-gradient-to-br from-emerald-300 via-emerald-500 to-teal-600 px-4 py-1.5 font-display italic text-sm text-white shadow-sm ring-1 ring-emerald-200/60 transition-all hover:scale-[1.04] active:scale-[1.02] disabled:opacity-50"
            >
              {busy ? 'wrapping up…' : 'Save & complete'}
            </button>
            <button
              type="button"
              onClick={() => void complete('')}
              disabled={busy}
              className="rounded-full border border-white/60 bg-white/80 px-4 py-1.5 font-display italic text-sm text-neutral-800 transition-all hover:bg-white active:scale-[1.02] disabled:opacity-50 dark:border-white/10 dark:bg-neutral-900/60 dark:text-neutral-200"
            >
              Skip the comment
            </button>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setFeedback('');
              }}
              disabled={busy}
              className="rounded-full px-3 py-1.5 text-xs text-neutral-500 hover:text-neutral-800 disabled:opacity-50 dark:text-neutral-400 dark:hover:text-neutral-100"
            >
              cancel
            </button>
          </div>
        </div>
      )}
      {iCompleted && (
        allCompleted ? (
          <p className="text-center font-display italic text-sm text-emerald-800 dark:text-emerald-300">
            ✓ Everyone wrapped — vault locking, sliding to your Memory Bank.
          </p>
        ) : (
          <p className="text-center font-display italic text-sm text-neutral-700 dark:text-neutral-300">
            ✓ You marked it complete · waiting on your partner to do the same.
          </p>
        )
      )}
      {err && <p className="mt-2 text-xs text-red-600">{err}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Capture Memory — text highlight or photo posted as a `date_memory`
// ---------------------------------------------------------------------------

function CaptureMemoryButton({ dateId }: { dateId: string }) {
  const { appendEvent, room, roomKey } = useRoom();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function saveText() {
    if (!text.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      await appendEvent({
        type: 'date_memory',
        memoryId: crypto.randomUUID(),
        dateId,
        kind: 'text',
        text: text.trim().slice(0, 280),
        ts: Date.now(),
      });
      setText('');
      setOpen(false);
    } catch (e) {
      setErr(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  async function savePhoto(file: File) {
    if (!room || !roomKey) return;
    setBusy(true);
    setErr(null);
    try {
      const blobId = crypto.randomUUID();
      const { encryptedBytes, header } = await prepareImageForUpload({
        file,
        roomKey,
        roomId: room.id,
        blobId,
      });
      await uploadAttachment({ roomId: room.id, blobId, encryptedBytes });
      const attachment: Extract<RoomEvent, { type: 'date_memory' }>['attachment'] = {
        type: 'image',
        blobId,
        mime: header.mime,
        w: header.w,
        h: header.h,
        byteLen: header.byteLen,
        placeholder: header.placeholder,
      };
      await appendEvent({
        type: 'date_memory',
        memoryId: crypto.randomUUID(),
        dateId,
        kind: 'photo',
        text: text.trim() ? text.trim().slice(0, 280) : undefined,
        attachment,
        ts: Date.now(),
      });
      setText('');
      setOpen(false);
    } catch (e) {
      setErr(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-3xl border border-white/40 bg-white/45 p-4 shadow-lg backdrop-blur-md dark:border-white/10 dark:bg-neutral-900/50">
      {!open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="w-full rounded-full bg-gradient-to-br from-rose-300 via-rose-400 to-pink-500 px-4 py-2 font-display italic text-sm text-white shadow-sm ring-1 ring-rose-200/60 transition-all hover:scale-[1.02] active:scale-[1.04]"
        >
          📸 Capture memory
        </button>
      ) : (
        <div className="space-y-2">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value.slice(0, 280))}
            placeholder="one-line highlight from the night…"
            rows={2}
            maxLength={280}
            className="block w-full rounded-2xl border border-white/40 bg-white/80 p-3 text-sm text-neutral-900 placeholder:italic placeholder:text-neutral-400 outline-none focus:border-rose-300 focus:ring-2 focus:ring-rose-300/40 dark:border-white/10 dark:bg-neutral-950 dark:text-neutral-100"
          />
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void saveText()}
              disabled={busy || !text.trim()}
              className="rounded-full bg-gradient-to-br from-rose-300 via-rose-400 to-pink-500 px-4 py-1.5 font-display italic text-sm text-white shadow-sm ring-1 ring-rose-200/60 transition-all hover:scale-[1.04] active:scale-[1.02] disabled:opacity-50"
            >
              {busy ? 'saving…' : 'Save highlight'}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void savePhoto(f);
                if (fileInputRef.current) fileInputRef.current.value = '';
              }}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={busy}
              className="rounded-full border border-white/60 bg-white/80 px-4 py-1.5 font-display italic text-sm text-neutral-800 transition-all hover:bg-white active:scale-[1.02] disabled:opacity-50 dark:border-white/10 dark:bg-neutral-900/60 dark:text-neutral-200"
            >
              📷 Photo
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              disabled={busy}
              className="rounded-full px-3 py-1.5 text-xs text-neutral-500 hover:text-neutral-800 disabled:opacity-50 dark:text-neutral-400 dark:hover:text-neutral-100"
            >
              cancel
            </button>
          </div>
          {err && <p className="text-xs text-red-600">{err}</p>}
        </div>
      )}
    </div>
  );
}

function firstWord(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '';
  const idx = trimmed.search(/\s/);
  return idx === -1 ? trimmed : trimmed.slice(0, idx);
}

// Re-export to keep barrel-import sites quiet about unused.
export type { RoomEventRecord };
