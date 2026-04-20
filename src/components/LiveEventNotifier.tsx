'use client';

/**
 * LiveEventNotifier — fires in-app toasts when notable realtime events
 * arrive in the current room. The toast carries an Action button that
 * routes to the relevant feature so a click takes you to the thing the
 * notification was about.
 *
 * Mounted once inside the RoomProvider's children so every page using
 * the provider (home, safe-space, date-night, sunday) gets it for free.
 *
 * Suppression rules:
 *   - Bootstrap backlog: any event with createdAt < mount time is
 *     considered historical and never toasts.
 *   - Self events: never toast for things I just did.
 *   - Same-page suppression: if I'm already on the destination URL,
 *     skip the toast — landing notification is redundant.
 *   - Optimistic temps: skip the temp- placeholder records; the real
 *     row will arrive a moment later via realtime.
 */

import { useEffect, useMemo, useRef } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { displayName } from '@/lib/domain/displayName';
import type { RoomEvent } from '@/lib/domain/events';
import { isDateMatched } from '@/lib/domain/dateMatch';
import { uniqueMembers } from '@/lib/domain/members';
import { useRoom } from './RoomProvider';

interface NotifSpec {
  emoji: string;
  message: (name: string) => string;
  /** Action button label shown on the toast. */
  actionLabel: string;
  /** URL to navigate to when the action is clicked. */
  url: (roomId: string) => string;
}

/**
 * Per-event-type notification config. Events not listed here don't
 * toast — slider drags, love-tank tweaks, reactions are too noisy.
 */
const NOTIFS: Partial<Record<RoomEvent['type'], NotifSpec>> = {
  message: {
    emoji: '💬',
    message: (n) => `${n} sent a message`,
    actionLabel: 'Open chat',
    url: (id) => `/rooms/${id}#vibechat`,
  },
  gratitude_send: {
    emoji: '♥',
    message: (n) => `${n} sent you a heart`,
    actionLabel: 'Open Gratitude',
    url: (id) => `/rooms/${id}?open=gratitude`,
  },
  homework_set: {
    emoji: '🌱',
    message: (n) => `${n} set a new intention`,
    actionLabel: 'Open',
    url: (id) => `/rooms/${id}?open=intention`,
  },
  date_idea_add: {
    emoji: '💡',
    message: (n) => `${n} added a date idea`,
    actionLabel: 'Open Dates',
    url: (id) => `/rooms/${id}?open=dates`,
  },
  date_idea_vote: {
    emoji: '💖',
    message: (n) => `${n} voted on a date idea`,
    actionLabel: 'Open Dates',
    url: (id) => `/rooms/${id}?open=dates`,
  },
  date_idea_schedule: {
    emoji: '📅',
    message: (n) => `${n} scheduled a date`,
    actionLabel: 'Open Dates',
    url: (id) => `/rooms/${id}?open=dates`,
  },
  date_idea_complete: {
    emoji: '✨',
    message: (n) => `${n} marked a date complete`,
    actionLabel: 'Open Dates',
    url: (id) => `/rooms/${id}?open=dates`,
  },
  wishlist_add: {
    emoji: '🎁',
    message: (n) => `${n} added to the wishlist`,
    actionLabel: 'Open Wishlist',
    url: (id) => `/rooms/${id}?open=wishlist`,
  },
  time_capsule_post: {
    emoji: '⏳',
    message: (n) => `${n} sealed a time capsule`,
    actionLabel: 'Open Capsules',
    url: (id) => `/rooms/${id}?open=time_capsules`,
  },
  mind_reader_post: {
    emoji: '🔮',
    message: (n) => `${n} planted a thought`,
    actionLabel: 'Open Mind Reader',
    url: (id) => `/rooms/${id}?open=mind_reader`,
  },
  mind_reader_solve: {
    emoji: '🔮',
    message: (n) => `${n} solved a thought`,
    actionLabel: 'Open Mind Reader',
    url: (id) => `/rooms/${id}?open=mind_reader`,
  },
  bribe: {
    emoji: '🤝',
    message: (n) => `${n} offered a bribe`,
    actionLabel: 'Open',
    url: (id) => `/rooms/${id}`,
  },
  ritual_complete: {
    emoji: '🌅',
    message: (n) => `${n} completed a ritual`,
    actionLabel: 'Open',
    url: (id) => `/rooms/${id}?open=rituals`,
  },
  date_post: {
    emoji: '📌',
    message: (n) => `${n} pinned to a date vault`,
    actionLabel: 'Open vault',
    // Vault path filled in by the per-event override below — this
    // url() never actually fires for date_post.
    url: (id) => `/rooms/${id}/date-night`,
  },
  date_memory: {
    emoji: '📸',
    message: (n) => `${n} captured a memory`,
    actionLabel: 'Open vault',
    url: (id) => `/rooms/${id}/date-night`,
  },
  date_invite_update: {
    emoji: '👥',
    message: (n) => `${n} updated the guests on a date`,
    actionLabel: 'Open vault',
    url: (id) => `/rooms/${id}/date-night`,
  },
};

function firstWord(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '';
  const idx = trimmed.search(/\s/);
  return idx === -1 ? trimmed : trimmed.slice(0, idx);
}

export function LiveEventNotifier() {
  const { events, members, myUserId, room, displayNames } = useRoom();
  const router = useRouter();
  const pathname = usePathname();
  // mountTimeRef anchors "what counts as new". Anything older than this
  // is the backlog and never toasts; anything newer is realtime.
  const mountTimeRef = useRef(Date.now());
  const seenRef = useRef<Set<string>>(new Set());
  // Match transitions are derived state, not events — track which
  // ideaIds we've already celebrated so a re-fold doesn't double-toast.
  const matchSeenRef = useRef<Set<string>>(new Set());

  const memberIds = useMemo(
    () => (room ? uniqueMembers(members, room.current_generation).map((m) => m.user_id) : []),
    [members, room],
  );

  // Match-landed detector — runs on every events change, derives the
  // current matched-set per the centralised isDateMatched helper, and
  // fires a celebratory toast for any ideaId that just transitioned
  // into matched. Bootstraps the seen set on first mount so historical
  // matches don't toast on page load.
  const bootstrappedMatchesRef = useRef(false);
  useEffect(() => {
    if (!myUserId || !room || memberIds.length === 0) return;
    interface IdeaState {
      title: string;
      invitedUserIds: string[];
      inviteUpdateTs: number;
      voters: Set<string>;
      deleted: boolean;
    }
    const ideas: Record<string, IdeaState> = {};
    const latestVote: Record<string, { ts: number; kind: 'vote' | 'unvote' }> = {};
    for (const rec of events) {
      const ev = rec.event;
      if (ev.type === 'date_idea_add' && !ideas[ev.ideaId]) {
        ideas[ev.ideaId] = {
          title: ev.title,
          invitedUserIds: ev.invitedUserIds ?? [],
          inviteUpdateTs: 0,
          voters: new Set(),
          deleted: false,
        };
      } else if (ev.type === 'date_invite_update' && ideas[ev.ideaId]) {
        if (ev.ts > ideas[ev.ideaId].inviteUpdateTs) {
          ideas[ev.ideaId].invitedUserIds = ev.invitedUserIds;
          ideas[ev.ideaId].inviteUpdateTs = ev.ts;
        }
      } else if (ev.type === 'date_idea_delete' && ideas[ev.ideaId]) {
        ideas[ev.ideaId].deleted = true;
      } else if (ev.type === 'date_idea_vote' || ev.type === 'date_idea_unvote') {
        const key = `${ev.ideaId}:${rec.senderId}`;
        const prior = latestVote[key];
        if (!prior || ev.ts >= prior.ts) {
          latestVote[key] = {
            ts: ev.ts,
            kind: ev.type === 'date_idea_vote' ? 'vote' : 'unvote',
          };
        }
      }
    }
    for (const [key, entry] of Object.entries(latestVote)) {
      if (entry.kind !== 'vote') continue;
      const [ideaId, uid] = key.split(':');
      const idea = ideas[ideaId];
      if (idea && !idea.deleted) idea.voters.add(uid);
    }
    const matchedIds: string[] = [];
    for (const [id, idea] of Object.entries(ideas)) {
      if (idea.deleted) continue;
      if (isDateMatched({ invitedUserIds: idea.invitedUserIds, voters: idea.voters }, memberIds)) {
        matchedIds.push(id);
      }
    }
    if (!bootstrappedMatchesRef.current) {
      // First pass: backfill the seen set so historical matches don't
      // toast on page load. Only NEW transitions fire after this.
      for (const id of matchedIds) matchSeenRef.current.add(id);
      bootstrappedMatchesRef.current = true;
      return;
    }
    for (const id of matchedIds) {
      if (matchSeenRef.current.has(id)) continue;
      matchSeenRef.current.add(id);
      const idea = ideas[id];
      // Skip if I'm in a targeted vault I'm not invited to.
      if (idea.invitedUserIds.length > 0 && !idea.invitedUserIds.includes(myUserId)) continue;
      const dest = `/rooms/${room.id}/dates/${id}`;
      const destPath = dest.split(/[?#]/)[0];
      const showToast = pathname !== destPath;
      if (showToast) {
        toast(`💖 You matched on ${idea.title}!`, {
          duration: 9000,
          action: {
            label: 'Open vault',
            onClick: () => router.push(dest),
          },
        });
      }
    }
  }, [events, memberIds, myUserId, room, pathname, router]);

  useEffect(() => {
    if (!myUserId || !room) return;

    // Build a dateId → invitedUserIds index in one pass so vault
    // event toasts can be scoped to invited members. Empty set
    // means the date is untargeted (whole room) and everyone gets
    // the toast.
    const invitedByDate: Record<string, Set<string>> = {};
    const inviteUpdateTsByDate: Record<string, number> = {};
    for (const rec of events) {
      const ev = rec.event;
      if (ev.type === 'date_idea_add' && ev.invitedUserIds && ev.invitedUserIds.length > 0) {
        if (!invitedByDate[ev.ideaId]) {
          invitedByDate[ev.ideaId] = new Set(ev.invitedUserIds);
        }
      } else if (ev.type === 'date_invite_update') {
        const prior = inviteUpdateTsByDate[ev.ideaId] ?? 0;
        if (ev.ts > prior) {
          inviteUpdateTsByDate[ev.ideaId] = ev.ts;
          // Empty array means "open to whole room" — clear any prior set.
          if (ev.invitedUserIds.length === 0) {
            delete invitedByDate[ev.ideaId];
          } else {
            invitedByDate[ev.ideaId] = new Set(ev.invitedUserIds);
          }
        }
      }
    }

    for (const rec of events) {
      if (seenRef.current.has(rec.id)) continue;
      seenRef.current.add(rec.id);
      if (rec.id.startsWith('temp-')) continue;
      if (rec.senderId === myUserId) continue;
      const createdMs = new Date(rec.createdAt).getTime();
      if (createdMs < mountTimeRef.current) continue;
      const spec = NOTIFS[rec.event.type];
      if (!spec) continue;

      // Vault-scoped events (date_post / date_memory / date_invite_update)
      // carry a date identifier. Resolve the per-event URL here and skip
      // the toast if I'm not invited to this date's vault.
      let dest = spec.url(room.id);
      if (rec.event.type === 'date_post' || rec.event.type === 'date_memory') {
        const dateId = rec.event.dateId;
        const invited = invitedByDate[dateId];
        if (invited && !invited.has(myUserId)) continue; // not invited
        dest = `/rooms/${room.id}/dates/${dateId}`;
      } else if (rec.event.type === 'date_invite_update') {
        // Only ping members who ended up in the new invited set —
        // pinging removed guests would be needlessly hurtful.
        const newInvited = new Set(rec.event.invitedUserIds);
        if (newInvited.size > 0 && !newInvited.has(myUserId)) continue;
        dest = `/rooms/${room.id}/dates/${rec.event.ideaId}`;
      }

      const name = firstWord(displayName(rec.senderId, displayNames, myUserId));
      // If the user is already on the destination page, the toast adds
      // nothing — they can already see the new event. Strip query/hash
      // for the path comparison.
      const destPath = dest.split(/[?#]/)[0];
      if (pathname === destPath) continue;
      toast(`${spec.emoji} ${spec.message(name)}`, {
        duration: 7000,
        action: {
          label: spec.actionLabel,
          onClick: () => router.push(dest),
        },
      });
    }
  }, [events, myUserId, room, displayNames, pathname, router]);

  return null;
}
