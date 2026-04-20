'use client';

/**
 * DateNightPortal — the minimalist anchor on /rooms/{id}/date-night.
 * One state at a time:
 *
 *   No matches → centered glass banner: "No dates planned yet."
 *   Match(es)  → "You have a date: {title}!" hero pill + Open Vault.
 *
 * Multi-match view: the topmost matched/scheduled date gets the hero
 * treatment; any sibling matches stack below as smaller pills. The
 * page deliberately does not duplicate the home-page widgets — that's
 * what /rooms/{id} is for.
 *
 * Drives the same projection MatchedDatesBoard used to read so vote
 * arrival via realtime flips the banner instantly (the centralised
 * isDateMatched helper already honours invitedUserIds).
 */

import { useMemo } from 'react';
import Link from 'next/link';
import { motion } from 'framer-motion';
import { isDateMatched } from '@/lib/domain/dateMatch';
import { uniqueMembers } from '@/lib/domain/members';
import { useVaultUnread } from '@/lib/domain/vaultSeen';
import { useRoom, useRoomProjection } from './RoomProvider';

const DAY_MS = 24 * 60 * 60 * 1000;

interface PortalIdea {
  ideaId: string;
  title: string;
  energy: 'low' | 'medium' | 'high';
  invitedUserIds: string[];
  scheduledAt: string | null;
  scheduledTs: number | null;
  voters: Set<string>;
  completedBy: Set<string>;
  deleted: boolean;
}

interface PortalState {
  upcoming: PortalIdea[];
  matchesNoSchedule: PortalIdea[];
}

function usePortalState(): PortalState {
  const { members, room } = useRoom();
  const memberIds = useMemo(
    () => (room ? uniqueMembers(members, room.current_generation).map((m) => m.user_id) : []),
    [members, room],
  );
  return useRoomProjection<PortalState>(
    (acc, rec) => {
      const ev = rec.event;
      const state = acc as PortalState & {
        _ideas?: Record<string, PortalIdea>;
        _votes?: Record<string, { ts: number; kind: 'vote' | 'unvote' }>;
        _inviteUpdates?: Record<string, { ts: number; invited: string[] }>;
      };
      if (!state._ideas) state._ideas = {};
      if (!state._votes) state._votes = {};
      if (!state._inviteUpdates) state._inviteUpdates = {};
      const ideas = state._ideas;
      const votes = state._votes;
      const inviteUpdates = state._inviteUpdates;

      switch (ev.type) {
        case 'date_idea_add': {
          if (!ideas[ev.ideaId]) {
            ideas[ev.ideaId] = {
              ideaId: ev.ideaId,
              title: ev.title,
              energy: ev.energy,
              invitedUserIds: ev.invitedUserIds ?? [],
              scheduledAt: null,
              scheduledTs: null,
              voters: new Set(),
              completedBy: new Set(),
              deleted: false,
            };
          }
          break;
        }
        case 'date_invite_update': {
          const prior = inviteUpdates[ev.ideaId];
          if (!prior || ev.ts > prior.ts) {
            inviteUpdates[ev.ideaId] = { ts: ev.ts, invited: ev.invitedUserIds };
          }
          break;
        }
        case 'date_idea_delete': {
          const idea = ideas[ev.ideaId];
          if (idea) idea.deleted = true;
          break;
        }
        case 'date_idea_schedule': {
          const idea = ideas[ev.ideaId];
          if (!idea) break;
          idea.scheduledAt = ev.scheduledAt;
          idea.scheduledTs = Date.parse(ev.scheduledAt) || null;
          break;
        }
        case 'date_idea_vote': {
          const key = `${ev.ideaId}:${rec.senderId}`;
          const prior = votes[key];
          if (!prior || ev.ts >= prior.ts) votes[key] = { ts: ev.ts, kind: 'vote' };
          break;
        }
        case 'date_idea_unvote': {
          const key = `${ev.ideaId}:${rec.senderId}`;
          const prior = votes[key];
          if (!prior || ev.ts >= prior.ts) votes[key] = { ts: ev.ts, kind: 'unvote' };
          break;
        }
        case 'date_idea_complete': {
          const idea = ideas[ev.ideaId];
          if (idea) idea.completedBy.add(rec.senderId);
          break;
        }
      }

      // Apply latest invite-update over the original ideaAdd's set.
      for (const [ideaId, entry] of Object.entries(inviteUpdates)) {
        const idea = ideas[ideaId];
        if (idea) idea.invitedUserIds = entry.invited;
      }
      // Resolve voters from latest vote/unvote per (ideaId, sender).
      for (const idea of Object.values(ideas)) idea.voters.clear();
      for (const [key, entry] of Object.entries(votes)) {
        if (entry.kind !== 'vote') continue;
        const [ideaId, uid] = key.split(':');
        const idea = ideas[ideaId];
        if (idea && !idea.deleted) idea.voters.add(uid);
      }

      const now = Date.now();
      const live = Object.values(ideas).filter((i) => !i.deleted);
      const matches = live.filter((i) => isDateMatched(i, memberIds));
      const scheduled = matches.filter((i) => i.scheduledTs != null);
      const upcoming = scheduled
        .filter((i) => i.scheduledTs! >= now - 4 * DAY_MS) // include "just happened"
        .sort((a, b) => (a.scheduledTs ?? 0) - (b.scheduledTs ?? 0));
      const matchesNoSchedule = matches
        .filter((i) => i.scheduledTs == null)
        .sort((a, b) => b.voters.size - a.voters.size);
      // CRUCIAL: re-emit the private accumulator state so the next
      // event call sees it. Without this, every reduction starts
      // fresh with an empty ideas map, the matches list stays empty,
      // and the portal renders "No dates planned yet" forever even
      // after a real match has landed (the bug Sam hit).
      return {
        upcoming,
        matchesNoSchedule,
        _ideas: ideas,
        _votes: votes,
        _inviteUpdates: inviteUpdates,
      } as PortalState;
    },
    { upcoming: [], matchesNoSchedule: [] },
  );
}

export function DateNightPortal() {
  const portal = usePortalState();
  const { room, myUserId } = useRoom();
  if (!room || !myUserId) return null;

  const hasAnything =
    portal.upcoming.length > 0 || portal.matchesNoSchedule.length > 0;

  if (!hasAnything) {
    return <EmptyBanner />;
  }

  // Pick the hero: the next upcoming if any, else the first matches-
  // awaiting-schedule.
  const hero =
    portal.upcoming[0] ??
    portal.matchesNoSchedule[0];
  const others = [
    ...portal.upcoming.slice(hero === portal.upcoming[0] ? 1 : 0),
    ...portal.matchesNoSchedule.slice(hero === portal.matchesNoSchedule[0] ? 1 : 0),
  ];

  return (
    <div className="space-y-4">
      <HeroBanner roomId={room.id} idea={hero} myUserId={myUserId} />
      {others.length > 0 && (
        <ul className="space-y-2">
          {others.map((i) => (
            <li key={i.ideaId}>
              <SecondaryPill roomId={room.id} idea={i} myUserId={myUserId} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function EmptyBanner() {
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.5, ease: 'easeOut' }}
      className="mx-auto mt-12 flex min-h-[40vh] flex-col items-center justify-center rounded-3xl border border-white/40 bg-white/40 p-10 text-center shadow-2xl backdrop-blur-md dark:border-white/10 dark:bg-neutral-900/45"
    >
      <span aria-hidden className="text-5xl opacity-80">🕊️</span>
      <h1 className="mt-4 font-display italic text-3xl text-neutral-900 dark:text-neutral-50 sm:text-4xl">
        No dates planned yet.
      </h1>
      <p className="mt-3 max-w-sm text-sm leading-relaxed text-neutral-700 dark:text-neutral-300">
        Add an idea on the home page, vote with your partner, and a vault
        opens here the moment you both say yes.
      </p>
    </motion.div>
  );
}

function HeroBanner({
  roomId,
  idea,
  myUserId,
}: {
  roomId: string;
  idea: PortalIdea;
  myUserId: string;
}) {
  const unread = useVaultUnread(idea.ideaId);
  const isTargeted = idea.invitedUserIds.length > 0;
  const amInvited = !isTargeted || idea.invitedUserIds.includes(myUserId);
  const now = Date.now();
  const diff = idea.scheduledTs != null ? idea.scheduledTs - now : null;
  const countdown = diff != null && diff > 0 ? formatCountdown(diff) : null;
  const happenedAlready =
    idea.scheduledTs != null && idea.scheduledTs < now;

  return (
    <Link
      href={`/rooms/${roomId}/dates/${idea.ideaId}`}
      className="group block overflow-hidden rounded-3xl border-2 border-pink-300/70 bg-gradient-to-br from-pink-50/95 via-rose-50/90 to-amber-50/85 p-7 shadow-[0_18px_44px_-8px_rgba(244,63,94,0.35)] ring-1 ring-pink-200/60 backdrop-blur-md transition-transform duration-200 ease-out hover:scale-[1.012] dark:border-pink-700/50 dark:from-pink-950/60 dark:via-rose-950/50 dark:to-amber-950/40"
    >
      <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-pink-700 dark:text-pink-300">
        {happenedAlready
          ? 'Recent date — drop in'
          : countdown
            ? 'You have a date'
            : 'Matched — pick a day'}
      </p>
      <h2 className="mt-2 font-display italic text-3xl tracking-tight text-neutral-900 dark:text-neutral-50 sm:text-4xl">
        {idea.title}!
      </h2>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {idea.scheduledAt && (
          <span className="rounded-full bg-white/85 px-3 py-1 font-display italic text-sm text-pink-900 shadow-sm ring-1 ring-pink-200/60 dark:bg-neutral-900/80 dark:text-pink-200">
            {formatAbsolute(idea.scheduledTs!)}
          </span>
        )}
        {countdown && (
          <span className="rounded-full bg-pink-900/90 px-3 py-1 font-display italic text-sm text-white shadow-sm dark:bg-pink-200 dark:text-pink-950">
            in {countdown}
          </span>
        )}
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-neutral-600 dark:text-neutral-400">
          · {idea.energy}-energy
        </span>
        {isTargeted && !amInvited && (
          <span className="rounded-full border border-amber-300 bg-amber-50/90 px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.14em] text-amber-800 dark:border-amber-700 dark:bg-amber-950/60 dark:text-amber-100">
            👀 spectating
          </span>
        )}
      </div>
      <div className="mt-5 flex items-center gap-2">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-gradient-to-br from-pink-400 via-pink-500 to-rose-600 px-5 py-2 font-display italic text-sm text-white shadow-md ring-1 ring-pink-200/60 transition-transform group-hover:scale-[1.04]">
          Click to enter →
          {unread.total > 0 && (
            <span
              className="ml-1 inline-flex h-5 min-w-[20px] items-center justify-center rounded-full bg-white px-1.5 font-mono text-[10px] font-bold tabular-nums text-rose-600 shadow-sm"
              aria-label={`${unread.total} new in this vault`}
            >
              {unread.total > 9 ? '9+' : unread.total}
            </span>
          )}
        </span>
      </div>
    </Link>
  );
}

function SecondaryPill({
  roomId,
  idea,
  myUserId,
}: {
  roomId: string;
  idea: PortalIdea;
  myUserId: string;
}) {
  const unread = useVaultUnread(idea.ideaId);
  const isTargeted = idea.invitedUserIds.length > 0;
  const amInvited = !isTargeted || idea.invitedUserIds.includes(myUserId);
  return (
    <Link
      href={`/rooms/${roomId}/dates/${idea.ideaId}`}
      className="group flex items-center justify-between gap-3 rounded-2xl border border-white/50 bg-white/65 px-5 py-3 shadow-md backdrop-blur-md transition-transform duration-200 ease-out hover:scale-[1.01] dark:border-white/10 dark:bg-neutral-900/55"
    >
      <div className="min-w-0 flex-1">
        <p className="font-display italic text-base text-neutral-900 dark:text-neutral-50 sm:text-lg">
          {idea.title}
        </p>
        <p className="mt-0.5 font-mono text-[10px] uppercase tracking-[0.18em] text-neutral-600 dark:text-neutral-400">
          {idea.scheduledTs
            ? formatAbsolute(idea.scheduledTs)
            : 'pick a day'}
          {' · '}
          {idea.energy}-energy
          {isTargeted && !amInvited && ' · 👀 spectating'}
        </p>
      </div>
      <span className="flex flex-shrink-0 items-center gap-1.5 rounded-full bg-pink-900/85 px-3 py-1 font-display italic text-xs text-white transition-transform group-hover:scale-[1.04] dark:bg-pink-200 dark:text-pink-950">
        Open
        {unread.total > 0 && (
          <span className="ml-1 inline-flex h-4 min-w-[16px] items-center justify-center rounded-full bg-white px-1 font-mono text-[9px] font-bold tabular-nums text-rose-600">
            {unread.total > 9 ? '9+' : unread.total}
          </span>
        )}
      </span>
    </Link>
  );
}

function formatAbsolute(ts: number): string {
  return new Date(ts).toLocaleString([], {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function formatCountdown(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  if (days > 1) return `${days} days`;
  if (days === 1) return `1 day ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}
