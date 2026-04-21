'use client';

/**
 * Per-member "mood" projection.
 *
 * The "mood" is a single number 0–100 derived from each member's three
 * hero sliders (Hunger inverted, Energy, Affection). Missing values drop
 * out rather than skew the average. The same projection feeds:
 *
 *   - <MemberMoodOrbs />     — the breathing row above the Vibe Oracle
 *   - OrbActionMenu          — the long-press popover ("View their vibe")
 *   - SafeSpace ghost bubbles — author's hue → glowing border
 *   - VibeOrb                 — the big sun's hue is the *room average* of
 *                               the same per-member scores (avg of avgs).
 *
 * Centralising it here means anywhere we want to colour something by
 * "{name}'s current vibe" reads from one source of truth and one tier
 * → palette mapping.
 */

import { useMemo } from 'react';
import { useRoomCore, useRoomEvents } from '@/components/RoomProvider';
import { displayName as fmtDisplayName } from './displayName';
import { uniqueMembers } from './members';

export type MoodTier = 'drained' | 'mid' | 'lifted' | 'unknown';

export interface MemberMood {
  uid: string;
  name: string;
  emoji: string;
  /** 0–100. 50 if no readings (paired with `hasData=false`). */
  score: number;
  tier: MoodTier;
  hasData: boolean;
  /** Representative hue for this tier, used by ghost bubbles + popovers. */
  hue: number;
}

export interface TierStyle {
  /** Inline CSS background (claymorphic radial gradient). */
  gradient: string;
  /** Inline box-shadow for the orb glow. */
  glow: string;
  /** Framer Motion `filter` keyframe array for slow hue cycling. */
  filterCycle: string[];
}

const HERO_TITLES = new Set(['hunger', 'energy', 'affection']);

export function tierFromScore(score: number, hasData: boolean): MoodTier {
  if (!hasData) return 'unknown';
  if (score < 25) return 'drained';
  if (score >= 75) return 'lifted';
  return 'mid';
}

/** Single representative hue per tier. Used where we need a non-cycling hue
 *  (e.g. ghost-bubble border colour, popover accents). */
export function hueForTier(tier: MoodTier): number {
  switch (tier) {
    case 'drained': return 10;   // warm coral
    case 'lifted':  return 320;  // pink
    case 'mid':     return 270;  // lavender
    case 'unknown': return 220;  // cool neutral
  }
}

export function tierStyle(tier: MoodTier): TierStyle {
  switch (tier) {
    case 'drained':
      return {
        gradient:
          'radial-gradient(circle at 30% 25%, hsla(20, 95%, 92%, 0.95), hsla(8, 80%, 62%, 1) 70%)',
        glow: '0 0 18px 2px hsla(10, 80%, 65%, 0.55)',
        filterCycle: ['hue-rotate(-12deg)', 'hue-rotate(22deg)', 'hue-rotate(-12deg)'],
      };
    case 'lifted':
      return {
        gradient:
          'radial-gradient(circle at 30% 25%, hsla(50, 95%, 94%, 0.95), hsla(45, 92%, 64%, 1) 70%)',
        glow: '0 0 22px 3px hsla(48, 92%, 68%, 0.6)',
        filterCycle: ['hue-rotate(0deg)', 'hue-rotate(-90deg)', 'hue-rotate(0deg)'],
      };
    case 'mid':
      return {
        gradient:
          'radial-gradient(circle at 30% 25%, hsla(280, 90%, 94%, 0.95), hsla(265, 55%, 70%, 1) 70%)',
        glow: '0 0 16px 2px hsla(275, 70%, 70%, 0.5)',
        filterCycle: ['hue-rotate(-15deg)', 'hue-rotate(15deg)', 'hue-rotate(-15deg)'],
      };
    case 'unknown':
    default:
      return {
        gradient:
          'radial-gradient(circle at 30% 25%, hsla(0, 0%, 96%, 0.95), hsla(220, 8%, 78%, 1) 70%)',
        glow: '0 0 12px 1px hsla(220, 6%, 75%, 0.4)',
        filterCycle: ['hue-rotate(0deg)', 'hue-rotate(0deg)'],
      };
  }
}

export function tierLabel(tier: MoodTier): string {
  switch (tier) {
    case 'drained': return 'drained';
    case 'lifted':  return 'lifted';
    case 'mid':     return 'steady';
    default:        return 'unknown';
  }
}

export function useMemberMoods(): MemberMood[] {
  const { events } = useRoomEvents();
  const { members, room, myUserId, displayNames, memberEmojis } = useRoomCore();

  return useMemo<MemberMood[]>(() => {
    if (!room) return [];
    const memberIds = uniqueMembers(members, room.current_generation).map(
      (m) => m.user_id,
    );
    if (memberIds.length === 0) return [];

    const defs: Record<string, { title: string; definedTs: number; deletedTs: number }> = {};
    const vals: Record<string, Record<string, { v: number; ts: number }>> = {};
    for (const rec of events) {
      const ev = rec.event;
      if (ev.type === 'slider_define') {
        const prev = defs[ev.sliderId];
        if (!prev || ev.ts > prev.definedTs) {
          defs[ev.sliderId] = { title: ev.title, definedTs: ev.ts, deletedTs: prev?.deletedTs ?? 0 };
        }
      } else if (ev.type === 'slider_delete') {
        const prev = defs[ev.sliderId];
        if (prev && ev.ts > prev.deletedTs) {
          defs[ev.sliderId] = { ...prev, deletedTs: ev.ts };
        }
      } else if (ev.type === 'slider_set') {
        const prior = vals[ev.sliderId]?.[rec.senderId];
        if (!prior || ev.ts > prior.ts) {
          vals[ev.sliderId] = {
            ...(vals[ev.sliderId] ?? {}),
            [rec.senderId]: { v: ev.value, ts: ev.ts },
          };
        }
      }
    }

    const heroIdByTitle: Record<string, { sliderId: string; inverted: boolean }> = {};
    for (const [sliderId, d] of Object.entries(defs)) {
      if (d.definedTs <= d.deletedTs) continue;
      const key = d.title.trim().toLowerCase();
      if (!HERO_TITLES.has(key)) continue;
      heroIdByTitle[key] = { sliderId, inverted: key === 'hunger' };
    }

    return memberIds.map((uid) => {
      const samples: number[] = [];
      for (const key of HERO_TITLES) {
        const hero = heroIdByTitle[key];
        if (!hero) continue;
        const v = vals[hero.sliderId]?.[uid]?.v;
        if (v == null) continue;
        samples.push(hero.inverted ? 100 - v : v);
      }
      const hasData = samples.length > 0;
      const score = hasData
        ? samples.reduce((a, b) => a + b, 0) / samples.length
        : 50;
      const tier = tierFromScore(score, hasData);
      return {
        uid,
        name: firstWord(fmtDisplayName(uid, displayNames, myUserId, null)),
        emoji: memberEmojis[uid] ?? '',
        score,
        tier,
        hasData,
        hue: hueForTier(tier),
      };
    });
  }, [events, members, room, myUserId, displayNames, memberEmojis]);
}

function firstWord(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '';
  const idx = trimmed.search(/\s/);
  return idx === -1 ? trimmed : trimmed.slice(0, idx);
}
