'use client';

/**
 * DatesOracle — empathic "what's next for you two" widget. Sits on the home
 * grid. Watches the decrypted date ledger (add / vote / schedule / complete
 * events) and surfaces ONE context-aware prompt at a time, prioritised by
 * urgency:
 *
 *   1. Date scheduled within the next 48h → enthusiastic reminder + a
 *      keyword-driven unique remark ("Pizza and movie? Don't forget a
 *      sneaky dessert.")
 *   2. Completed past date still missing a reflection → gentle follow-up.
 *   3. Matched idea with no schedule → "pick a day".
 *   4. Lots of matches but none scheduled → "you have N matches waiting".
 *   5. Only low-energy ideas in the bank → "set a high-energy one for next
 *      week".
 *   6. Ideas in bank but no matches → "anything catching your eye?"
 *   7. Nothing at all → "no dates planned?"
 *   8. No recent activity → "been a minute since your last date".
 *
 * If several messages qualify at once, rotates through them every ~5s. Tap
 * the card → opens the full Dates feature in a FeatureSheet.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { displayName as fmtDisplayName } from '@/lib/domain/displayName';
import { uniqueMembers } from '@/lib/domain/members';
import { isDateMatched, requiredVoters as needVoters } from '@/lib/domain/dateMatch';
import {
  dominantRecentCategory,
  inferCategoryForTitle,
  matchScoreForUserIdea,
  suggestDatesForRoomState,
  useRoomVibeState,
  type DateArchetype,
  type DateCategory,
} from '@/lib/domain/dateHeuristics';
import { Dates } from './Dates';
import { FeatureSheet } from './FeatureSheet';
import { useRoom } from './RoomProvider';
import { SectionHeader } from './design/SectionHeader';

// 'alert' = partner just voted on something — brightest and loudest.
type Tone = 'alert' | 'excited' | 'warm' | 'curious' | 'soft';

function firstWord(name: string): string {
  const t = name.trim();
  const i = t.search(/\s/);
  return i === -1 ? t : t.slice(0, i);
}

interface OracleMessage {
  id: string;
  headline: string;
  body: string;
  emoji: string;
  tone: Tone;
  /** Optional inline action attached to this message. Renderer
   *  shows it as a row of pill buttons under the body so users can
   *  vote / add an idea without opening the full sheet. */
  action?:
    | { kind: 'quick_vote'; ideaId: string }
    | { kind: 'add_archetype'; archetype: DateArchetype };
}

const ROTATE_MS = 5500;
const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Tone → colour palette
// ---------------------------------------------------------------------------

function toneStyle(tone: Tone): {
  bg: string;
  bgDark: string;
  glow: string;
  accentHue: number;
} {
  switch (tone) {
    case 'alert':
      // Hot magenta/fuchsia — "your partner just voted!" Loudest tone we
      // have; meant to catch the eye mid-scroll.
      return {
        bg: 'linear-gradient(110deg, hsla(320, 95%, 94%, 0.98) 0%, hsla(350, 92%, 90%, 0.92) 100%)',
        bgDark: 'linear-gradient(110deg, hsla(320, 72%, 22%, 0.9) 0%, hsla(350, 62%, 26%, 0.85) 100%)',
        glow: '0 0 60px 6px hsla(325, 92%, 65%, 0.7)',
        accentHue: 325,
      };
    case 'excited':
      // Warm pinks/roses — "date night tomorrow!"
      return {
        bg: 'linear-gradient(110deg, hsla(340, 92%, 96%, 0.95) 0%, hsla(10, 85%, 92%, 0.85) 100%)',
        bgDark: 'linear-gradient(110deg, hsla(340, 60%, 18%, 0.85) 0%, hsla(10, 55%, 22%, 0.8) 100%)',
        glow: '0 0 48px 4px hsla(340, 85%, 70%, 0.55)',
        accentHue: 340,
      };
    case 'warm':
      // Amber/peach — matches, scheduling prompts.
      return {
        bg: 'linear-gradient(110deg, hsla(30, 92%, 96%, 0.95) 0%, hsla(55, 85%, 92%, 0.85) 100%)',
        bgDark: 'linear-gradient(110deg, hsla(30, 60%, 18%, 0.85) 0%, hsla(55, 55%, 22%, 0.8) 100%)',
        glow: '0 0 40px 3px hsla(35, 82%, 68%, 0.5)',
        accentHue: 35,
      };
    case 'curious':
      // Soft violet — "anything catching your eye?"
      return {
        bg: 'linear-gradient(110deg, hsla(280, 92%, 96%, 0.95) 0%, hsla(310, 85%, 92%, 0.85) 100%)',
        bgDark: 'linear-gradient(110deg, hsla(280, 60%, 18%, 0.85) 0%, hsla(310, 55%, 22%, 0.8) 100%)',
        glow: '0 0 40px 3px hsla(285, 80%, 70%, 0.5)',
        accentHue: 285,
      };
    case 'soft':
    default:
      // Cool lavender — "no dates planned?" (gentle, not guilty)
      return {
        bg: 'linear-gradient(110deg, hsla(240, 92%, 96%, 0.95) 0%, hsla(275, 85%, 92%, 0.85) 100%)',
        bgDark: 'linear-gradient(110deg, hsla(240, 55%, 18%, 0.85) 0%, hsla(275, 50%, 22%, 0.8) 100%)',
        glow: '0 0 36px 3px hsla(260, 75%, 72%, 0.45)',
        accentHue: 260,
      };
  }
}

// ---------------------------------------------------------------------------
// Unique remark per scheduled date — keyword heuristics
// ---------------------------------------------------------------------------

const KEYWORD_REMARKS: { re: RegExp; remark: string }[] = [
  { re: /\bpizza|pasta|italian\b/i,          remark: 'Don\u2019t forget a sneaky dessert — tiramisu maybe?' },
  { re: /\bmovie|film|cinema\b/i,            remark: 'Pick the snacks together before you start.' },
  { re: /\brestaurant|dinner|fine.?dining\b/i, remark: 'Reservation already? Tuesdays are easier.' },
  { re: /\bwalk|hike|trail|bushwalk\b/i,     remark: 'Water bottle + a shared playlist will do it.' },
  { re: /\bbeach|ocean|sea\b/i,              remark: 'Pack a towel each and a book you don\u2019t plan to read.' },
  { re: /\bpub|bar|cocktail|drink\b/i,       remark: 'Set a two-drink soft limit together — the night lands better.' },
  { re: /\bpicnic\b/i,                       remark: 'A cheese board plus one silly snack = elite picnic energy.' },
  { re: /\bcook|bake|baking|bread\b/i,       remark: 'Decide up front who\u2019s sous chef, who\u2019s head chef.' },
  { re: /\bgame|boardgame|board.game|chess|cards\b/i, remark: 'Loser owes a 5-minute back rub — raise the stakes.' },
  { re: /\bcoffee|café|cafe|espresso\b/i,    remark: 'Try somewhere neither of you has been before.' },
  { re: /\bart|gallery|museum|exhibit\b/i,   remark: 'Pick one piece each and make up a fake story about it.' },
  { re: /\bconcert|gig|show|live.music\b/i,  remark: 'Put the artist on loud on the way there.' },
  { re: /\bdrive|road.?trip\b/i,             remark: 'Someone picks the music, someone picks the turns. Swap halfway.' },
  { re: /\bbrunch|breakfast\b/i,             remark: 'Eggs benedict is a love language. Settle the bill in advance.' },
  { re: /\bmassage|spa|sauna\b/i,            remark: 'No phones past the entrance — make it a rule.' },
  { re: /\bdance|dancing|club\b/i,           remark: 'One slow song, one silly song, one pure joy song.' },
  { re: /\bswim|pool|ocean\b/i,              remark: 'Pack a snack — you\u2019ll be hungry after.' },
  { re: /\bstar|astronomy|sky\b/i,           remark: 'Check moon phase first — new moons are the best.' },
];

function remarkFor(title: string): string {
  const hit = KEYWORD_REMARKS.find(({ re }) => re.test(title));
  return hit?.remark ?? 'Put your phones on do-not-disturb before you head out.';
}

function describeWhen(ts: number, now: number): string {
  const diff = ts - now;
  const mins = Math.round(diff / 60000);
  if (diff < 0) return 'just now';
  if (mins < 60) return `in ${mins}m`;
  const hours = Math.round(diff / (60 * 60 * 1000));
  if (hours < 6) return `in ${hours}h`;
  const sameDay =
    new Date(ts).toDateString() === new Date(now).toDateString();
  if (sameDay) return 'tonight';
  const tomorrow =
    new Date(ts).toDateString() ===
    new Date(now + DAY_MS).toDateString();
  if (tomorrow) return 'tomorrow';
  const weekday = new Date(ts).toLocaleDateString(undefined, { weekday: 'long' });
  if (diff < 7 * DAY_MS) return weekday.toLowerCase();
  return new Date(ts).toLocaleDateString();
}

// ---------------------------------------------------------------------------
// Projection → prioritised messages
// ---------------------------------------------------------------------------

interface Idea {
  ideaId: string;
  title: string;
  energy: 'low' | 'medium' | 'high';
  /** Empty set means "whole room" (legacy or untargeted ideas). */
  invitedUserIds: Set<string>;
  /** ts of the most recent date_invite_update that wrote
   *  invitedUserIds. 0 means it still reflects the original
   *  date_idea_add. Latest-ts wins. */
  inviteUpdateTs: number;
  addedTs: number;
  deleted: boolean;
  scheduledAt: string | null;
  scheduledTs: number | null;
  voters: Set<string>;
  completedBy: Set<string>;
}

function useDatesOracleMessages(): OracleMessage[] {
  const { events, members, room, myUserId, displayNames } = useRoom();
  const roomVibe = useRoomVibeState();

  return useMemo<OracleMessage[]>(() => {
    if (!room) return [];
    const memberIds = uniqueMembers(members, room.current_generation).map(
      (m) => m.user_id,
    );
    if (memberIds.length === 0) return [];
    const memberSet = new Set(memberIds);

    const ideas: Record<string, Idea> = {};
    // Latest vote/unvote per (ideaId, senderId) — keyed by `${ideaId}:${uid}`.
    const latestVote: Record<string, { ts: number; kind: 'vote' | 'unvote' }> = {};
    // Latest complete per (ideaId, senderId).
    const latestComplete: Record<string, number> = {};

    for (const rec of events) {
      const ev = rec.event;
      switch (ev.type) {
        case 'date_idea_add': {
          if (!ideas[ev.ideaId]) {
            ideas[ev.ideaId] = {
              ideaId: ev.ideaId,
              title: ev.title,
              energy: ev.energy,
              invitedUserIds: new Set(ev.invitedUserIds ?? []),
              inviteUpdateTs: 0,
              addedTs: ev.ts,
              deleted: false,
              scheduledAt: null,
              scheduledTs: null,
              voters: new Set(),
              completedBy: new Set(),
            };
          }
          break;
        }
        case 'date_invite_update': {
          const idea = ideas[ev.ideaId];
          if (!idea) break;
          if (ev.ts <= idea.inviteUpdateTs) break;
          idea.invitedUserIds = new Set(ev.invitedUserIds);
          idea.inviteUpdateTs = ev.ts;
          break;
        }
        case 'date_idea_delete': {
          if (ideas[ev.ideaId]) ideas[ev.ideaId].deleted = true;
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
          const prior = latestVote[key];
          if (!prior || ev.ts >= prior.ts) {
            latestVote[key] = { ts: ev.ts, kind: 'vote' };
          }
          break;
        }
        case 'date_idea_unvote': {
          const key = `${ev.ideaId}:${rec.senderId}`;
          const prior = latestVote[key];
          if (!prior || ev.ts >= prior.ts) {
            latestVote[key] = { ts: ev.ts, kind: 'unvote' };
          }
          break;
        }
        case 'date_idea_complete': {
          const key = `${ev.ideaId}:${rec.senderId}`;
          if (!latestComplete[key] || ev.ts > latestComplete[key]) {
            latestComplete[key] = ev.ts;
            const idea = ideas[ev.ideaId];
            if (idea) idea.completedBy.add(rec.senderId);
          }
          break;
        }
      }
    }

    // Resolve active voters per idea from the latest vote/unvote per sender.
    for (const [key, entry] of Object.entries(latestVote)) {
      if (entry.kind !== 'vote') continue;
      const [ideaId, uid] = key.split(':');
      const idea = ideas[ideaId];
      if (idea && !idea.deleted) idea.voters.add(uid);
    }

    const now = Date.now();
    const live = Object.values(ideas).filter((i) => !i.deleted);
    // The set of users whose vote is REQUIRED to "match" an idea.
    // Centralised so DatesOracle, IdeaCard, MatchedDatesBoard, and the
    // match-landed toast in LiveEventNotifier all agree.
    const requiredVoters = (i: Idea): string[] =>
      needVoters({ invitedUserIds: [...i.invitedUserIds] }, memberIds);
    const matches = live.filter((i) =>
      isDateMatched({ invitedUserIds: [...i.invitedUserIds], voters: i.voters }, memberIds),
    );
    void memberSet;
    const scheduled = live.filter((i) => i.scheduledTs != null);
    const upcoming48h = scheduled
      .filter((i) => i.scheduledTs! > now && i.scheduledTs! - now < 2 * DAY_MS)
      .sort((a, b) => a.scheduledTs! - b.scheduledTs!);
    const needsReflection = scheduled
      .filter(
        (i) =>
          i.scheduledTs! < now &&
          i.scheduledTs! > now - 30 * DAY_MS &&
          memberIds.some((uid) => !i.completedBy.has(uid)),
      )
      .sort((a, b) => b.scheduledTs! - a.scheduledTs!);
    const matchesWithoutSchedule = matches.filter((i) => i.scheduledTs == null);
    const lowOnly =
      live.length > 0 &&
      live.every((i) => i.energy === 'low') &&
      matches.length === 0;
    const ideasNoMatches = live.filter((i) => {
      const need = requiredVoters(i);
      return i.voters.size > 0 && need.some((uid) => !i.voters.has(uid));
    });
    const mostRecentComplete = Math.max(
      0,
      ...live.map((i) =>
        i.scheduledTs && i.scheduledTs < now && memberIds.every((uid) => i.completedBy.has(uid))
          ? i.scheduledTs
          : 0,
      ),
    );

    // Partition partial-vote ideas. Now respects targeting:
    // "partner voted, I haven't" only counts when I'M one of the
    // invited voters and a different invited voter has voted.
    const partnerVotedForMe: Idea[] = [];
    const iVotedAlone: Idea[] = [];
    if (myUserId) {
      for (const i of live) {
        if (i.scheduledTs != null) continue;
        const need = requiredVoters(i);
        if (need.length === 0) continue;
        if (!need.includes(myUserId)) continue; // I'm not invited
        const allRequiredVoted = need.every((uid) => i.voters.has(uid));
        if (allRequiredVoted) continue;
        const iVoted = i.voters.has(myUserId);
        const otherInvitedVoted = need.some((uid) => uid !== myUserId && i.voters.has(uid));
        if (otherInvitedVoted && !iVoted) partnerVotedForMe.push(i);
        else if (iVoted && !otherInvitedVoted) iVotedAlone.push(i);
      }
    }

    const out: OracleMessage[] = [];

    // (1) Upcoming in 48h — time-sensitive, highest priority.
    // Proximity-aware copy: morning-of and 1-hour-before variants.
    for (const i of upcoming48h) {
      const when = describeWhen(i.scheduledTs!, now);
      const minsUntil = Math.round((i.scheduledTs! - now) / 60000);
      const hoursUntil = minsUntil / 60;
      let headline: string;
      let body: string;
      if (minsUntil <= 70 && minsUntil > 0) {
        headline = `Phones away soon — ${i.title}`;
        body = `Starting in about ${minsUntil} min. ${remarkFor(i.title)}`;
      } else if (hoursUntil <= 14 && new Date(i.scheduledTs!).toDateString() === new Date(now).toDateString()) {
        headline = `Tonight — ${i.title}`;
        body = `${remarkFor(i.title)}`;
      } else {
        headline = `Date night ${when}!`;
        body = `${i.title}. ${remarkFor(i.title)}`;
      }
      out.push({
        id: `upcoming-${i.ideaId}`,
        headline,
        body,
        emoji: '💕',
        tone: 'excited',
      });
    }

    // (2) Partner just voted on something — LOUD. User explicitly flagged
    // this as the signal that matters most after upcoming scheduled dates,
    // so we emit one alert per pending idea (up to 3) at the brightest tone.
    for (const i of partnerVotedForMe.slice(0, 3)) {
      const partnerNames = [...i.voters]
        .filter((uid) => uid !== myUserId)
        .map((uid) => firstWord(fmtDisplayName(uid, displayNames, myUserId, null)))
        .filter((n) => n.length > 0);
      const namePart =
        partnerNames.length === 0
          ? 'Your partner'
          : partnerNames.length === 1
            ? partnerNames[0]
            : `${partnerNames.slice(0, -1).join(', ')} + ${partnerNames[partnerNames.length - 1]}`;
      out.push({
        id: `partner-voted-${i.ideaId}`,
        headline: `${namePart} voted for ${i.title}!`,
        body: 'They\u2019re into this one. Jump in and make it a match.',
        emoji: '💘',
        tone: 'alert',
        // Quick-vote action: lets the user say yes/maybe inline
        // without opening the sheet.
        action: { kind: 'quick_vote', ideaId: i.ideaId },
      });
    }

    // (3) Needs reflection — gentle nudge.
    for (const i of needsReflection.slice(0, 2)) {
      out.push({
        id: `reflect-${i.ideaId}`,
        headline: 'How was it?',
        body: `${i.title} is waiting on a short reflection to close it out.`,
        emoji: '💭',
        tone: 'warm',
      });
    }

    // (4) Matches without schedule.
    if (matchesWithoutSchedule.length === 1) {
      const m = matchesWithoutSchedule[0];
      out.push({
        id: `match-${m.ideaId}`,
        headline: 'You\u2019ve got a match!',
        body: `${m.title}. Pick a day and it\u2019s locked in.`,
        emoji: '💖',
        tone: 'warm',
      });
    } else if (matchesWithoutSchedule.length > 1) {
      out.push({
        id: 'matches-many',
        headline: `${matchesWithoutSchedule.length} matches waiting.`,
        body: 'Pick the next one and put it on the calendar — don\u2019t let good ideas go stale.',
        emoji: '💖',
        tone: 'warm',
      });
    }

    // (5) You voted and your partner hasn't — softer than partner-voted.
    for (const i of iVotedAlone.slice(0, 2)) {
      out.push({
        id: `self-voted-${i.ideaId}`,
        headline: `Waiting on a vote back.`,
        body: `You voted for ${i.title} — share it with them and see if they\u2019re in.`,
        emoji: '⏳',
        tone: 'curious',
      });
    }

    // (6) Only low-energy ideas in the bank.
    if (lowOnly && upcoming48h.length === 0) {
      out.push({
        id: 'low-only',
        headline: 'Mix in a big one?',
        body: 'A few short date ideas in the bank — let\u2019s set a high-energy one for next week.',
        emoji: '⚡',
        tone: 'curious',
      });
    }

    // (7) Ideas in bank, nobody's voted yet.
    const ideasNoVotes = live.filter(
      (i) => i.voters.size === 0 && i.scheduledTs == null,
    );
    if (out.length === 0 && ideasNoVotes.length > 0) {
      out.push({
        id: 'bank-no-votes',
        headline: 'A few ideas floating around.',
        body: 'Nobody\u2019s voted yet. Anything catching your eye?',
        emoji: '👀',
        tone: 'curious',
      });
    }

    // (8) Nothing at all → vibe-aware archetype suggestions.
    if (out.length === 0 && live.length === 0) {
      // Recent completed categories drive the diversity-aware suggestion.
      const recentCompleted = live
        .filter((i) => i.scheduledTs != null && i.scheduledTs < now)
        .sort((a, b) => b.scheduledTs! - a.scheduledTs!)
        .slice(0, 5)
        .map((i) => inferCategoryForTitle(i.title, i.energy));
      const suggestions = suggestDatesForRoomState(roomVibe, recentCompleted, 3);
      // Lead with one nudge that frames the suggestions in vibe terms.
      out.push({
        id: 'vibe-suggest-intro',
        headline: vibeIntroFor(roomVibe),
        body: 'Tap a suggestion to drop it in your bank — your partner will see it.',
        emoji: '🗓️',
        tone: 'soft',
      });
      for (const a of suggestions) {
        out.push({
          id: `suggest-${a.id}`,
          headline: `${a.emoji} ${a.title}`,
          body: a.blurb,
          emoji: a.emoji,
          tone: toneForCategory(a.category),
          action: { kind: 'add_archetype', archetype: a },
        });
      }
    }

    // (8b) Diversity nudge — three of the same in a row in completed
    // dates → suggest something different from the dominant category.
    {
      const recent = live
        .filter((i) => i.scheduledTs != null && i.scheduledTs < now)
        .sort((a, b) => b.scheduledTs! - a.scheduledTs!)
        .slice(0, 3)
        .map((i) => inferCategoryForTitle(i.title, i.energy));
      const dominant = dominantRecentCategory(recent, 0.66);
      if (dominant && live.length > 0 && upcoming48h.length === 0) {
        out.push({
          id: `diversity-${dominant}`,
          headline: nudgeHeadlineFor(dominant),
          body: nudgeBodyFor(dominant),
          emoji: '🌗',
          tone: 'curious',
        });
      }
    }

    // (9) Been a minute since the last completed date.
    if (
      out.length === 0 &&
      upcoming48h.length === 0 &&
      mostRecentComplete > 0 &&
      now - mostRecentComplete > 14 * DAY_MS
    ) {
      const days = Math.round((now - mostRecentComplete) / DAY_MS);
      out.push({
        id: 'stale',
        headline: `It\u2019s been ${days} days.`,
        body: 'Since your last date. The idea bank has some starters if you\u2019re blank.',
        emoji: '🕯️',
        tone: 'soft',
      });
    }

    // (10) Calm fallback: a date IS scheduled but it's outside every
    // other bucket (not within 48h, not needs-reflection, not stale).
    // Without this the widget could go to zero messages and unmount
    // — a known regression where "set a date for 2 weeks from now"
    // would silently disappear the Dates Oracle from the sidebar.
    if (out.length === 0) {
      const futureScheduled = scheduled
        .filter((i) => i.scheduledTs! > now)
        .sort((a, b) => a.scheduledTs! - b.scheduledTs!);
      if (futureScheduled.length > 0) {
        const next = futureScheduled[0];
        const when = describeWhen(next.scheduledTs!, now);
        out.push({
          id: `next-up-${next.ideaId}`,
          headline: `${next.title} — ${when}`,
          body: 'On the calendar. Tap to plan in the vault.',
          emoji: '🗓️',
          tone: 'soft',
        });
      }
    }

    // (11) Final calm fallback: ideas exist but nothing else fired.
    // Keeps the widget resident on the sidebar instead of unmounting.
    if (out.length === 0 && live.length > 0) {
      out.push({
        id: 'all-quiet',
        headline: 'All quiet on the dates front.',
        body: 'Tap to browse your ideas and votes.',
        emoji: '🌿',
        tone: 'soft',
      });
    }

    // Silence the unused-variable warning for the legacy "partial vote"
    // list that the two more-specific buckets above supersede.
    void ideasNoMatches;

    return out;
  }, [events, members, room, myUserId, displayNames, roomVibe]);
}

// ---------------------------------------------------------------------------
// Helpers for the vibe-suggest message (intro headline + tone + nudge copy)
// ---------------------------------------------------------------------------

function vibeIntroFor(state: { physical: { axis: number }; emotional: { axis: number }; social: { axis: number } }): string {
  const { physical: P, emotional: E, social: S } = state;
  if (P.axis < -0.3 && E.axis > 0.2) return 'Soft and slow — try one of these';
  if (P.axis > 0.3 && S.axis > 0.2) return 'Energy to spend — go bigger';
  if (S.axis < -0.3) return 'Quiet day — gentle ideas';
  if (E.axis > 0.4) return 'Tender mood — lean into it';
  return 'A few ideas tuned to where you both are';
}

function toneForCategory(category: DateCategory): Tone {
  switch (category) {
    case 'adventure':
    case 'social':
      return 'warm';
    case 'tender':
    case 'cosy':
      return 'curious';
    case 'creative':
      return 'curious';
    case 'chill':
    default:
      return 'soft';
  }
}

function nudgeHeadlineFor(cat: DateCategory): string {
  switch (cat) {
    case 'chill':     return 'Lots of chill lately';
    case 'adventure': return 'Lots of adventure lately';
    case 'social':    return 'Lots of social lately';
    case 'tender':    return 'Lots of tender lately';
    case 'cosy':      return 'Lots of cosy lately';
    case 'creative':  return 'Lots of creative lately';
  }
}

function nudgeBodyFor(cat: DateCategory): string {
  switch (cat) {
    case 'chill':     return 'How about a higher-energy date this week to shake things up?';
    case 'adventure': return 'Maybe a slower one next — just the two of you, no destination.';
    case 'social':    return 'Maybe a quiet one next — just the two of you.';
    case 'tender':    return 'Could try something silly or active to round it out.';
    case 'cosy':      return 'Maybe pick something with more energy this week.';
    case 'creative':  return 'Maybe just be together, no project this time.';
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function DatesOracle() {
  const messages = useDatesOracleMessages();
  const { appendEvent } = useRoom();
  const [idx, setIdx] = useState(0);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  // Track ideaIds we've already voted on / archetypes we've added so
  // the buttons go to a "✓ Done" state instead of staying clickable.
  const [completed, setCompleted] = useState<Set<string>>(new Set());
  // Confetti latch — fires once per ideaId when it transitions into
  // a "match" message in the Oracle.
  const seenMatchesRef = useRef<Set<string>>(new Set());
  const [confettiKey, setConfettiKey] = useState<string | null>(null);

  useEffect(() => {
    if (messages.length < 2) return;
    const h = window.setInterval(() => setIdx((i) => i + 1), ROTATE_MS);
    return () => window.clearInterval(h);
  }, [messages.length]);

  // Detect new matches (id starting with `match-`) and trigger confetti.
  useEffect(() => {
    for (const m of messages) {
      if (!m.id.startsWith('match-')) continue;
      if (seenMatchesRef.current.has(m.id)) continue;
      seenMatchesRef.current.add(m.id);
      // Suppress if this is the initial mount — only celebrate live
      // transitions, not historical matches still pending schedule.
      if (seenMatchesRef.current.size > 1) {
        setConfettiKey(`${m.id}-${Date.now()}`);
        window.setTimeout(() => setConfettiKey(null), 1800);
      }
    }
  }, [messages]);

  if (messages.length === 0) return null;

  const safeIdx = idx % messages.length;
  const active = messages[safeIdx];
  const s = toneStyle(active.tone);

  async function handleQuickVote(ideaId: string) {
    if (busy) return;
    setBusy(true);
    try {
      await appendEvent({ type: 'date_idea_vote', ideaId, ts: Date.now() });
      setCompleted((prev) => new Set(prev).add(ideaId));
    } finally {
      setBusy(false);
    }
  }

  async function handleAddArchetype(arch: DateArchetype) {
    if (busy) return;
    setBusy(true);
    try {
      const ideaId = crypto.randomUUID();
      await appendEvent({
        type: 'date_idea_add',
        ideaId,
        title: arch.title,
        energy: arch.energy,
        ts: Date.now(),
      });
      // Auto-vote yes from me — they're adding it because they like it.
      await appendEvent({ type: 'date_idea_vote', ideaId, ts: Date.now() });
      setCompleted((prev) => new Set(prev).add(arch.id));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <motion.div
        role="button"
        tabIndex={0}
        onClick={() => setSheetOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setSheetOpen(true);
          }
        }}
        aria-label="open dates"
        className="relative w-full cursor-pointer overflow-hidden rounded-3xl border border-white/60 px-5 py-4 text-left backdrop-blur-md focus:outline-none focus-visible:ring-2 focus-visible:ring-pink-400 dark:border-white/10"
        style={{ background: s.bg }}
        animate={{
          scale: [1, 1.012, 1],
          boxShadow: [s.glow.replace('0.55)', '0.35)'), s.glow, s.glow.replace('0.55)', '0.35)')],
        }}
        transition={{
          scale:     { duration: 4.2, repeat: Infinity, ease: 'easeInOut' },
          boxShadow: { duration: 4.2, repeat: Infinity, ease: 'easeInOut' },
        }}
        whileHover={{ scale: 1.018 }}
        whileTap={{ scale: 1.005 }}
      >
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 hidden dark:block"
          style={{ background: s.bgDark }}
        />
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-60"
          style={{
            background:
              'radial-gradient(ellipse at 18% 0%, rgba(255,255,255,0.6), transparent 55%)',
          }}
        />

        <div className="relative">
          <SectionHeader
            label="Dates oracle"
            trailing={
              <span
                aria-hidden
                className="inline-flex h-2 w-2 animate-pulse rounded-full"
                style={{ backgroundColor: `hsl(${s.accentHue}, 80%, 55%)` }}
              />
            }
          />
        </div>

        <div className="relative mt-3 min-h-[3.25rem]">
          <AnimatePresence mode="wait">
            <motion.div
              key={active.id}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.55, ease: 'easeOut' }}
              className="flex items-start gap-3 pl-1"
            >
              <span className="mt-0.5 text-2xl leading-none" aria-hidden>
                {active.emoji}
              </span>
              <div className="min-w-0 flex-1">
                <p className="font-display italic text-lg leading-snug text-neutral-900 dark:text-neutral-50">
                  {active.headline}
                </p>
                <p className="mt-1 text-sm leading-relaxed text-neutral-700 dark:text-neutral-300">
                  {active.body}
                </p>
                {active.action?.kind === 'quick_vote' && (
                  <div className="mt-2 flex gap-1.5">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        void handleQuickVote((active.action as { ideaId: string }).ideaId);
                      }}
                      disabled={busy || completed.has((active.action as { ideaId: string }).ideaId)}
                      className="rounded-full border border-rose-300 bg-white/80 px-3 py-1 text-[11px] font-display italic text-rose-700 transition-all hover:scale-[1.04] active:scale-[1.02] disabled:opacity-50 dark:border-rose-700 dark:bg-neutral-900/60 dark:text-rose-200"
                    >
                      {completed.has((active.action as { ideaId: string }).ideaId) ? '✓ voted' : '💖 yes, in'}
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setSheetOpen(true);
                      }}
                      className="rounded-full border border-white/60 bg-white/60 px-3 py-1 text-[11px] font-display italic text-neutral-800 transition-all hover:bg-white/80 dark:border-white/10 dark:bg-neutral-900/50 dark:text-neutral-200"
                    >
                      open dates
                    </button>
                  </div>
                )}
                {active.action?.kind === 'add_archetype' && (
                  <div className="mt-2 flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        void handleAddArchetype((active.action as { archetype: DateArchetype }).archetype);
                      }}
                      disabled={busy || completed.has((active.action as { archetype: DateArchetype }).archetype.id)}
                      className="rounded-full border border-rose-300 bg-white/80 px-3 py-1 text-[11px] font-display italic text-rose-700 transition-all hover:scale-[1.04] active:scale-[1.02] disabled:opacity-50 dark:border-rose-700 dark:bg-neutral-900/60 dark:text-rose-200"
                    >
                      {completed.has((active.action as { archetype: DateArchetype }).archetype.id) ? '✓ added' : '+ add to bank'}
                    </button>
                  </div>
                )}
              </div>
            </motion.div>
          </AnimatePresence>
          {/* Confetti pulse on match */}
          {confettiKey && (
            <motion.div
              key={confettiKey}
              aria-hidden
              className="pointer-events-none absolute inset-0"
              initial={{ opacity: 0 }}
              animate={{ opacity: [0, 1, 0] }}
              transition={{ duration: 1.6, ease: 'easeOut' }}
            >
              {Array.from({ length: 14 }).map((_, i) => (
                <motion.span
                  key={i}
                  className="absolute text-2xl"
                  style={{ left: `${10 + (i * 6)}%`, top: '40%' }}
                  initial={{ y: 0, opacity: 0, scale: 0.6 }}
                  animate={{
                    y: [0, -40 - (i % 3) * 12, -80],
                    opacity: [1, 1, 0],
                    scale: [0.8, 1.1, 0.6],
                    rotate: i * 30,
                  }}
                  transition={{ duration: 1.4, ease: 'easeOut', delay: i * 0.04 }}
                >
                  {i % 3 === 0 ? '💖' : i % 3 === 1 ? '✨' : '🎉'}
                </motion.span>
              ))}
            </motion.div>
          )}
        </div>

        {messages.length > 1 && (
          <div className="relative mt-3 flex items-center gap-1.5">
            {messages.map((m, i) => (
              <button
                key={m.id}
                type="button"
                aria-label={`show dates reading ${i + 1} of ${messages.length}`}
                onClick={(e) => {
                  e.stopPropagation();
                  setIdx(i);
                }}
                className="h-1.5 rounded-full transition-all"
                style={{
                  width: i === safeIdx ? 18 : 6,
                  backgroundColor:
                    i === safeIdx
                      ? `hsl(${s.accentHue}, 70%, 50%)`
                      : 'rgba(0,0,0,0.18)',
                }}
              />
            ))}
          </div>
        )}
      </motion.div>

      <AnimatePresence>
        {sheetOpen && (
          <FeatureSheet
            key="dates-from-oracle"
            title="Dates"
            emoji="💕"
            onClose={() => setSheetOpen(false)}
          >
            <Dates />
          </FeatureSheet>
        )}
      </AnimatePresence>
    </>
  );
}
