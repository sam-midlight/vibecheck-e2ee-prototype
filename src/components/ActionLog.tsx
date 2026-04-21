'use client';

/**
 * ActionLog — bottom-of-sidebar widget that lists every actionable
 * thing in the room, derived from the projected event stream.
 *
 * Items appear and disappear based on the underlying STATE, never
 * just because the viewer looked — so seeing the list doesn't make
 * a "4 ideas to vote on" entry vanish; voting on them does.
 *
 * Replaces the previous NudgeBar (which used per-user view cursors
 * and showed one item at a time). Kept in the same widget slot.
 */

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { displayName as fmtDisplayName } from '@/lib/domain/displayName';
import { uniqueMembers } from '@/lib/domain/members';
import { useRoom, useRoomProjection } from './RoomProvider';

const DAY_MS = 24 * 60 * 60 * 1000;

interface ActionItem {
  id: string;
  emoji: string;
  text: string;
  /** Optional small badge ("4", "9+"). */
  count?: number;
  /** Optional live countdown string ("3d 4h"). */
  countdown?: string;
  href: string;
  /** Lower = higher priority for sort. */
  priority: number;
}

// ---------------------------------------------------------------------------
// Projection — a single pass over events that captures every
// actionable signal at once. Cheap enough for small rooms; running
// six independent useRoomProjection hooks would refold the same
// stream six times.
// ---------------------------------------------------------------------------

interface ActionState {
  /** Date ideas, indexed by ideaId. */
  ideas: Record<string, {
    title: string;
    energy: 'low' | 'medium' | 'high';
    authorId: string;
    invitedUserIds: string[];
    inviteUpdateTs: number;
    scheduledTs: number | null;
    deleted: boolean;
    /** uid → latest yes/no */
    votes: Record<string, { voted: boolean; ts: number }>;
    completedBy: Set<string>;
  }>;
  /** Mind reader puzzles still unsolved by me, keyed by gameId. */
  mindReader: Record<string, { authorId: string; ts: number; solved: boolean }>;
  /** Wishlist items by author uid → live (un-claimed, un-deleted) count. */
  wishlistByAuthor: Record<string, number>;
  /** Active affection marks targeted at me that haven't been
   *  received/retracted yet. */
  myAffections: Record<string, { senderId: string; kind: string; ts: number }>;
}

function emptyState(): ActionState {
  return {
    ideas: {},
    mindReader: {},
    wishlistByAuthor: {},
    myAffections: {},
  };
}

function useActionState(): ActionState {
  const { myUserId } = useRoom();
  return useRoomProjection<ActionState>(
    (acc, rec) => {
      const ev = rec.event;
      const state = acc as ActionState & { _wishlistTs?: Record<string, { authorId: string; deleted: boolean; claimed: boolean; ts: number }> };
      if (!state._wishlistTs) state._wishlistTs = {};

      switch (ev.type) {
        case 'date_idea_add':
          if (!state.ideas[ev.ideaId]) {
            state.ideas[ev.ideaId] = {
              title: ev.title,
              energy: ev.energy,
              authorId: rec.senderId,
              invitedUserIds: ev.invitedUserIds ?? [],
              inviteUpdateTs: 0,
              scheduledTs: null,
              deleted: false,
              votes: {},
              completedBy: new Set(),
            };
          }
          break;
        case 'date_invite_update': {
          const idea = state.ideas[ev.ideaId];
          if (!idea) break;
          if (ev.ts <= idea.inviteUpdateTs) break;
          idea.invitedUserIds = ev.invitedUserIds;
          idea.inviteUpdateTs = ev.ts;
          break;
        }
        case 'date_idea_delete':
          if (state.ideas[ev.ideaId]) state.ideas[ev.ideaId].deleted = true;
          break;
        case 'date_idea_schedule': {
          const i = state.ideas[ev.ideaId];
          if (i) i.scheduledTs = Date.parse(ev.scheduledAt) || null;
          break;
        }
        case 'date_idea_vote':
        case 'date_idea_unvote': {
          const i = state.ideas[ev.ideaId];
          if (!i) break;
          const prior = i.votes[rec.senderId];
          if (prior && prior.ts >= ev.ts) break;
          i.votes[rec.senderId] = { voted: ev.type === 'date_idea_vote', ts: ev.ts };
          break;
        }
        case 'date_idea_complete': {
          const i = state.ideas[ev.ideaId];
          if (i) i.completedBy.add(rec.senderId);
          break;
        }

        case 'mind_reader_post':
          if (rec.senderId !== myUserId) {
            state.mindReader[ev.gameId] = {
              authorId: rec.senderId,
              ts: ev.ts,
              solved: false,
            };
          }
          break;
        case 'mind_reader_solve':
          // Anyone solving the puzzle clears it from the action log.
          if (state.mindReader[ev.gameId]) {
            state.mindReader[ev.gameId].solved = true;
          }
          break;
        case 'mind_reader_delete':
          delete state.mindReader[ev.gameId];
          break;

        case 'wishlist_add':
          state._wishlistTs[ev.itemId] = {
            authorId: rec.senderId,
            deleted: false,
            claimed: false,
            ts: ev.ts,
          };
          break;
        case 'wishlist_claim': {
          const w = state._wishlistTs[ev.itemId];
          if (w) w.claimed = true;
          break;
        }
        case 'wishlist_delete': {
          const w = state._wishlistTs[ev.itemId];
          if (w) w.deleted = true;
          break;
        }

        case 'affection_send':
          if (ev.to === myUserId) {
            state.myAffections[ev.affectionId] = {
              senderId: rec.senderId,
              kind: ev.kind,
              ts: ev.ts,
            };
          }
          break;
        case 'affection_receive':
        case 'affection_retract':
          delete state.myAffections[ev.affectionId];
          break;
      }

      // Recompute wishlistByAuthor from the latest snapshot of
      // _wishlistTs so this stays an in-pass derived count.
      const wb: Record<string, number> = {};
      for (const w of Object.values(state._wishlistTs)) {
        if (w.deleted || w.claimed) continue;
        if (w.authorId === myUserId) continue; // don't surface my own wishlist
        wb[w.authorId] = (wb[w.authorId] ?? 0) + 1;
      }
      state.wishlistByAuthor = wb;

      // Re-emit private state so the next call's acc preserves it.
      return state as ActionState;
    },
    emptyState(),
    [myUserId],
  );
}

// ---------------------------------------------------------------------------
// Generators — one per action category.
// ---------------------------------------------------------------------------

function formatCountdown(ms: number): string {
  if (ms <= 0) return 'now';
  const totalSec = Math.floor(ms / 1000);
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  if (days > 1) return `${days}d`;
  if (days === 1) return `1d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

function firstWord(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '';
  const idx = trimmed.search(/\s/);
  return idx === -1 ? trimmed : trimmed.slice(0, idx);
}

function useActionItems(): ActionItem[] {
  const { members, room, myUserId, displayNames } = useRoom();
  const action = useActionState();
  // Tick once per minute so countdowns freshen without churning the
  // whole event projection.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const h = window.setInterval(() => setNow(Date.now()), 60 * 1000);
    return () => window.clearInterval(h);
  }, []);

  return useMemo(() => {
    if (!room || !myUserId) return [];
    const memberIds = uniqueMembers(members, room.current_generation).map((m) => m.user_id);
    const memberSet = new Set(memberIds);
    const items: ActionItem[] = [];

    // ---- 1. Affection waiting on screen (highest priority — they're
    //         literally floating on the page right now). ----
    const affectionCount = Object.keys(action.myAffections).length;
    if (affectionCount > 0) {
      items.push({
        id: 'affection-pending',
        emoji: '💋',
        text: `${affectionCount} affection mark${affectionCount === 1 ? '' : 's'} waiting`,
        count: affectionCount,
        href: `/rooms/${room.id}`,
        priority: 5,
      });
    }

    // ---- 2. Past-scheduled vaults I haven't completed yet. ----
    for (const [ideaId, i] of Object.entries(action.ideas)) {
      if (i.deleted) continue;
      if (i.scheduledTs == null) continue;
      if (i.scheduledTs > now) continue;
      // Only surface for invited members (or whole-room if untargeted).
      if (i.invitedUserIds.length > 0 && !i.invitedUserIds.includes(myUserId)) continue;
      if (i.completedBy.has(myUserId)) continue;
      // Stale (>14 days past) — drop it; the user clearly skipped it.
      if (now - i.scheduledTs > 14 * DAY_MS) continue;
      items.push({
        id: `wrap-${ideaId}`,
        emoji: '✨',
        text: `${i.title} — wrap it up`,
        href: `/rooms/${room.id}/dates/${ideaId}`,
        priority: 10,
      });
    }

    // ---- 3. Upcoming scheduled vaults — countdown chips. ----
    const upcoming = Object.entries(action.ideas)
      .filter(([, i]) => !i.deleted && i.scheduledTs != null && i.scheduledTs > now)
      .filter(([, i]) =>
        i.invitedUserIds.length === 0 || i.invitedUserIds.includes(myUserId),
      )
      .sort(([, a], [, b]) => (a.scheduledTs ?? 0) - (b.scheduledTs ?? 0))
      .slice(0, 3);
    for (const [ideaId, i] of upcoming) {
      items.push({
        id: `vault-${ideaId}`,
        emoji: '💖',
        text: i.title,
        countdown: formatCountdown((i.scheduledTs ?? 0) - now),
        href: `/rooms/${room.id}/dates/${ideaId}`,
        priority: 20,
      });
    }

    // ---- 4. Date ideas I can vote on. ----
    let votablePending = 0;
    for (const i of Object.values(action.ideas)) {
      if (i.deleted) continue;
      if (i.scheduledTs != null) continue; // already locked in
      if (i.authorId === myUserId) continue; // don't ping me about my own
      // Targeted dates only count if I'm invited.
      if (i.invitedUserIds.length > 0 && !i.invitedUserIds.includes(myUserId)) continue;
      const myVote = i.votes[myUserId];
      if (myVote?.voted) continue; // I already said yes
      votablePending++;
    }
    if (votablePending > 0) {
      items.push({
        id: 'votes-pending',
        emoji: '💕',
        text: `${votablePending} date idea${votablePending === 1 ? '' : 's'} to vote on`,
        count: votablePending,
        href: `/rooms/${room.id}?open=dates`,
        priority: 30,
      });
    }

    // ---- 5. Mind reader puzzles waiting to be solved. ----
    const mrPending = Object.values(action.mindReader).filter(
      (m) => !m.solved && memberSet.has(m.authorId),
    );
    if (mrPending.length > 0) {
      const author = mrPending[0].authorId;
      const name = firstWord(fmtDisplayName(author, displayNames, myUserId, null));
      items.push({
        id: 'mind-reader',
        emoji: '🔮',
        text:
          mrPending.length === 1
            ? `${name} posted a mind reader for you`
            : `${mrPending.length} mind readers to solve`,
        count: mrPending.length > 1 ? mrPending.length : undefined,
        href: `/rooms/${room.id}?open=mind_reader`,
        priority: 35,
      });
    }

    // ---- 6. Wishlist items other members have added. ----
    for (const [authorId, count] of Object.entries(action.wishlistByAuthor)) {
      if (!memberSet.has(authorId)) continue;
      const name = firstWord(fmtDisplayName(authorId, displayNames, myUserId, null));
      items.push({
        id: `wishlist-${authorId}`,
        emoji: '🎁',
        text: `${name} has ${count} thing${count === 1 ? '' : 's'} in their wishlist`,
        count,
        href: `/rooms/${room.id}?open=wishlist`,
        priority: 50,
      });
    }

    return items.sort((a, b) => a.priority - b.priority);
  }, [action, members, room, myUserId, displayNames, now]);
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ActionLog() {
  const items = useActionItems();
  return (
    <section className="rounded-2xl border border-white/50 bg-white/55 p-4 shadow-lg backdrop-blur-md dark:border-white/10 dark:bg-neutral-900/50">
      <header className="mb-2 flex items-center justify-between">
        <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-neutral-700 dark:text-neutral-300">
          Action log
        </span>
        {items.length > 0 && (
          <span className="rounded-full bg-rose-500/85 px-2 py-0.5 font-mono text-[9px] tabular-nums text-white shadow-sm">
            {items.length}
          </span>
        )}
      </header>
      {items.length === 0 ? (
        <p className="rounded-xl border border-white/40 bg-white/40 px-3 py-4 text-center text-sm italic text-neutral-700 dark:border-white/10 dark:bg-neutral-900/30 dark:text-neutral-300">
          ✨ All caught up.
        </p>
      ) : (
        <ul className="space-y-1.5">
          {items.map((item) => (
            <li key={item.id}>
              <Link
                href={item.href}
                className="group flex items-center gap-2 rounded-xl border border-white/40 bg-white/70 px-3 py-2 text-sm shadow-sm backdrop-blur-md transition-transform duration-150 ease-out hover:scale-[1.015] dark:border-white/10 dark:bg-neutral-900/55"
              >
                <span aria-hidden className="text-lg leading-none">
                  {item.emoji}
                </span>
                <span className="min-w-0 flex-1 truncate font-display italic text-neutral-900 dark:text-neutral-50">
                  {item.text}
                </span>
                {item.countdown && (
                  <span className="shrink-0 rounded-full bg-pink-900/85 px-2 py-0.5 font-mono text-[10px] tabular-nums text-white dark:bg-pink-200 dark:text-pink-950">
                    {item.countdown}
                  </span>
                )}
                {item.count != null && !item.countdown && (
                  <span className="shrink-0 rounded-full bg-neutral-900/10 px-2 py-0.5 font-mono text-[10px] tabular-nums text-neutral-700 dark:bg-white/15 dark:text-neutral-200">
                    {item.count > 9 ? '9+' : item.count}
                  </span>
                )}
                <span
                  aria-hidden
                  className="shrink-0 text-xs text-neutral-500 transition-transform group-hover:translate-x-0.5"
                >
                  →
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
