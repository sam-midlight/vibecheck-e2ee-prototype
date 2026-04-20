'use client';

/**
 * Date heuristics — archetype catalog + suggestion / matching math
 * driven by the room's vibe vector (useVibeState).
 *
 * The Oracle uses these helpers to:
 *   - Suggest 2–3 archetypes when the idea bank is empty, biased
 *     toward the room's current vibe.
 *   - Score any existing user-added idea against the current vibe
 *     ("90% match for tonight's energy").
 *   - Detect monoculture in recent completed dates and nudge for
 *     diversity ("3 chill in a row — try something with some kick").
 *
 * Pure projection — no events written. Safe to call from any client
 * component that already has the projected event stream in scope.
 */

import { useMemo } from 'react';
import { useRoom } from '@/components/RoomProvider';
import { uniqueMembers } from './members';
import { resolveDimension, resolvePolarity, type DimensionReading, type VibeState } from './vibeState';
import type { SliderDimension, SliderPolarity } from './events';

// ---------------------------------------------------------------------------
// Archetype catalog
// ---------------------------------------------------------------------------

export type DateCategory =
  | 'chill'
  | 'tender'
  | 'adventure'
  | 'social'
  | 'cosy'
  | 'creative';

export interface DateArchetype {
  id: string;
  title: string;
  category: DateCategory;
  /** Energy budget per the existing event schema. */
  energy: 'low' | 'medium' | 'high';
  /** Ideal vibe state this idea fits — each axis in [-1, +1]. The
   *  match score is the distance from the room's current vector. */
  ideal: { physical: number; emotional: number; social: number };
  /** One-line teaser shown under the title in the suggestion card. */
  blurb: string;
  emoji: string;
}

/** Modest curated set; expand opportunistically as we learn what
 *  resonates. Each archetype's ideal vector says "this is the room
 *  state where this idea is most welcome." */
export const DATE_ARCHETYPES: DateArchetype[] = [
  // CHILL — low physical energy, gentle emotional tone, modest social.
  {
    id: 'chill_eye_gaze',
    title: 'Phone-free eye gazing',
    category: 'chill',
    energy: 'low',
    ideal: { physical: -0.4, emotional: 0.4, social: 0.0 },
    blurb: 'Two minutes of quiet eye contact. No talking, no phones.',
    emoji: '👁️',
  },
  {
    id: 'chill_parallel_read',
    title: 'Parallel reading',
    category: 'chill',
    energy: 'low',
    ideal: { physical: -0.4, emotional: 0.0, social: -0.2 },
    blurb: 'Same couch, different books. Cosy without the pressure to talk.',
    emoji: '📚',
  },
  {
    id: 'chill_bath',
    title: 'Long bath together',
    category: 'cosy',
    energy: 'low',
    ideal: { physical: -0.5, emotional: 0.5, social: -0.2 },
    blurb: 'Warm water, dim lights, no agenda.',
    emoji: '🛁',
  },

  // TENDER — emotional connection front and centre.
  {
    id: 'tender_letter',
    title: 'Write each other a short letter',
    category: 'tender',
    energy: 'low',
    ideal: { physical: 0.0, emotional: 0.6, social: 0.0 },
    blurb: 'Five sentences each. Read aloud. Done.',
    emoji: '💌',
  },
  {
    id: 'tender_photo_review',
    title: 'Look at old photos together',
    category: 'tender',
    energy: 'low',
    ideal: { physical: -0.2, emotional: 0.5, social: 0.0 },
    blurb: 'Pick a year. Scroll back. Notice what made you laugh.',
    emoji: '📷',
  },

  // ADVENTURE — high physical energy.
  {
    id: 'adv_walk',
    title: 'Spontaneous walk somewhere new',
    category: 'adventure',
    energy: 'medium',
    ideal: { physical: 0.4, emotional: 0.2, social: 0.3 },
    blurb: 'Pick a direction neither of you has walked. See what you find.',
    emoji: '🥾',
  },
  {
    id: 'adv_dance',
    title: 'Living-room dance party',
    category: 'adventure',
    energy: 'high',
    ideal: { physical: 0.6, emotional: 0.4, social: 0.3 },
    blurb: 'Three songs, no choreography. Bonus points for goofy.',
    emoji: '💃',
  },
  {
    id: 'adv_drive',
    title: 'Aimless drive with a shared playlist',
    category: 'adventure',
    energy: 'medium',
    ideal: { physical: 0.3, emotional: 0.2, social: 0.2 },
    blurb: 'No destination. One picks the music, the other picks the turns.',
    emoji: '🚗',
  },

  // SOCIAL — high social energy.
  {
    id: 'social_dinner',
    title: 'Cook a meal for someone',
    category: 'social',
    energy: 'medium',
    ideal: { physical: 0.2, emotional: 0.3, social: 0.6 },
    blurb: 'Invite a friend over and feed them.',
    emoji: '🍝',
  },
  {
    id: 'social_game',
    title: 'Board game night',
    category: 'social',
    energy: 'medium',
    ideal: { physical: 0.1, emotional: 0.2, social: 0.5 },
    blurb: 'Loser owes a 5-minute back rub.',
    emoji: '🎲',
  },

  // CREATIVE.
  {
    id: 'creative_paint',
    title: 'Paint each other badly',
    category: 'creative',
    energy: 'medium',
    ideal: { physical: 0.0, emotional: 0.4, social: 0.0 },
    blurb: 'Twenty minutes, watercolours, no rules. Worst painting wins.',
    emoji: '🎨',
  },
  {
    id: 'creative_cook',
    title: 'Bake something neither of you has tried',
    category: 'creative',
    energy: 'medium',
    ideal: { physical: 0.2, emotional: 0.3, social: 0.0 },
    blurb: 'Disasters allowed.',
    emoji: '🥐',
  },
];

// ---------------------------------------------------------------------------
// Match scoring — Euclidean distance between archetype ideal and the
// room's current state, normalised to a 0–100 percentage.
// ---------------------------------------------------------------------------

const MAX_DISTANCE = Math.sqrt(2 * 2 * 3); // axes are [-1, +1] across 3 dims

function distance(a: VibeState, ideal: DateArchetype['ideal']): number {
  const dp = a.physical.axis - ideal.physical;
  const de = a.emotional.axis - ideal.emotional;
  const ds = a.social.axis - ideal.social;
  return Math.sqrt(dp * dp + de * de + ds * ds);
}

/** 0–100 fit. 100 = perfect alignment, 0 = maximally opposite. */
export function matchScoreForArchetype(
  state: VibeState,
  archetype: DateArchetype,
): number {
  const d = distance(state, archetype.ideal);
  return Math.round((1 - d / MAX_DISTANCE) * 100);
}

/** Score an existing user-added idea by inferring its archetype from
 *  its energy + a simple title-keyword heuristic. Returns null if no
 *  category can be inferred (rare). */
export function matchScoreForUserIdea(
  state: VibeState,
  idea: { title: string; energy: 'low' | 'medium' | 'high' },
): number {
  const inferredIdeal = inferIdealVector(idea);
  const d = Math.sqrt(
    (state.physical.axis - inferredIdeal.physical) ** 2 +
      (state.emotional.axis - inferredIdeal.emotional) ** 2 +
      (state.social.axis - inferredIdeal.social) ** 2,
  );
  return Math.round((1 - d / MAX_DISTANCE) * 100);
}

/** Quick category inference for free-form titles, biased by energy
 *  bucket. Used for the per-idea "vibe match %" indicator. */
export function inferCategoryForTitle(
  title: string,
  energy: 'low' | 'medium' | 'high',
): DateCategory {
  const t = title.toLowerCase();
  if (/dance|hike|run|cycle|swim|surf|climb|adventure|festival|trip/.test(t)) return 'adventure';
  if (/cook|bake|paint|draw|write|craft|make|build/.test(t)) return 'creative';
  if (/dinner|drink|brunch|party|friends|host|guests/.test(t)) return 'social';
  if (/letter|gaze|cuddle|massage|memory|photo/.test(t)) return 'tender';
  if (/bath|nap|tea|read|movie|cosy|cozy|blanket/.test(t)) return 'cosy';
  // Energy bucket as last-resort fallback.
  if (energy === 'high') return 'adventure';
  if (energy === 'low') return 'chill';
  return 'cosy';
}

function inferIdealVector(idea: {
  title: string;
  energy: 'low' | 'medium' | 'high';
}): DateArchetype['ideal'] {
  const cat = inferCategoryForTitle(idea.title, idea.energy);
  switch (cat) {
    case 'adventure': return { physical: 0.5, emotional: 0.3, social: 0.3 };
    case 'creative':  return { physical: 0.1, emotional: 0.4, social: 0.0 };
    case 'social':    return { physical: 0.2, emotional: 0.3, social: 0.6 };
    case 'tender':    return { physical: 0.0, emotional: 0.6, social: 0.0 };
    case 'cosy':      return { physical: -0.3, emotional: 0.3, social: -0.2 };
    case 'chill':
    default:          return { physical: -0.4, emotional: 0.2, social: 0.0 };
  }
}

// ---------------------------------------------------------------------------
// Suggestion engine
// ---------------------------------------------------------------------------

/** Top-N archetypes ordered by fit, with light diversity rules so we
 *  don't return three near-identical ideas. */
export function suggestDatesForRoomState(
  state: VibeState,
  recentCategories: DateCategory[] = [],
  count: number = 3,
): DateArchetype[] {
  const recentSet = new Set(recentCategories);
  const scored = DATE_ARCHETYPES.map((a) => ({
    a,
    score: matchScoreForArchetype(state, a),
    // Mild penalty if the same category dominated the recent run —
    // keeps the suggestion list honest about variety.
    penalty: recentSet.has(a.category) ? 6 : 0,
  })).sort(
    (x, y) => y.score - y.penalty - (x.score - x.penalty),
  );
  // Pick top N, but enforce no more than 1 per category.
  const out: DateArchetype[] = [];
  const seenCat = new Set<DateCategory>();
  for (const { a } of scored) {
    if (seenCat.has(a.category)) continue;
    out.push(a);
    seenCat.add(a.category);
    if (out.length >= count) break;
  }
  return out;
}

/** Returns the dominant category in a recent-history list, or null
 *  if no single category accounts for the majority. Used by the
 *  diversity nudge. */
export function dominantRecentCategory(
  recent: DateCategory[],
  threshold: number = 0.6,
): DateCategory | null {
  if (recent.length === 0) return null;
  const counts: Partial<Record<DateCategory, number>> = {};
  for (const c of recent) counts[c] = (counts[c] ?? 0) + 1;
  for (const [cat, n] of Object.entries(counts)) {
    if (n != null && n / recent.length >= threshold) return cat as DateCategory;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Room-average vibe state — averages each axis across all current-gen
// members who have any slider readings. Skips members with no data.
// ---------------------------------------------------------------------------

export function useRoomVibeState(): VibeState {
  const { events, members, room } = useRoom();
  return useMemo(() => {
    const empty: VibeState = {
      physical: { score: 50, axis: 0, dominantTitle: null, dominantValue: null, dominantNegative: false },
      emotional: { score: 50, axis: 0, dominantTitle: null, dominantValue: null, dominantNegative: false },
      social: { score: 50, axis: 0, dominantTitle: null, dominantValue: null, dominantNegative: false },
    };
    if (!room) return empty;
    const memberIds = uniqueMembers(members, room.current_generation).map(
      (m) => m.user_id,
    );
    if (memberIds.length === 0) return empty;

    // Build defs/vals across all members for this room.
    interface Def {
      title: string;
      dimension: SliderDimension;
      polarity: SliderPolarity;
      definedTs: number;
      deletedTs: number;
    }
    const defs: Record<string, Def> = {};
    const vals: Record<string, Record<string, { value: number; ts: number }>> = {};
    for (const rec of events) {
      const ev = rec.event;
      if (ev.type === 'slider_define') {
        const prev = defs[ev.sliderId];
        if (!prev || ev.ts > prev.definedTs) {
          defs[ev.sliderId] = {
            title: ev.title,
            dimension: resolveDimension(ev.dimension, ev.title),
            polarity: resolvePolarity(ev.polarity, ev.title),
            definedTs: ev.ts,
            deletedTs: prev?.deletedTs ?? 0,
          };
        }
      } else if (ev.type === 'slider_delete') {
        const prev = defs[ev.sliderId];
        if (prev && ev.ts > prev.deletedTs) {
          defs[ev.sliderId] = { ...prev, deletedTs: ev.ts };
        }
      } else if (ev.type === 'slider_set' && memberIds.includes(rec.senderId)) {
        const prior = vals[ev.sliderId]?.[rec.senderId];
        if (!prior || ev.ts > prior.ts) {
          vals[ev.sliderId] = {
            ...(vals[ev.sliderId] ?? {}),
            [rec.senderId]: { value: ev.value, ts: ev.ts },
          };
        }
      }
    }

    const buckets: Record<SliderDimension, number[]> = {
      physical: [],
      emotional: [],
      social: [],
    };
    for (const [sliderId, def] of Object.entries(defs)) {
      if (def.definedTs <= def.deletedTs) continue;
      for (const uid of memberIds) {
        const v = vals[sliderId]?.[uid];
        if (!v) continue;
        const adjusted =
          def.polarity === 'inverted' ? 100 - v.value : v.value;
        buckets[def.dimension].push(adjusted);
      }
    }

    function reduce(scores: number[]): DimensionReading {
      if (scores.length === 0) {
        return {
          score: 50,
          axis: 0,
          dominantTitle: null,
          dominantValue: null,
          dominantNegative: false,
        };
      }
      const mean = scores.reduce((s, x) => s + x, 0) / scores.length;
      return {
        score: mean,
        axis: (mean - 50) / 50,
        dominantTitle: null,
        dominantValue: null,
        dominantNegative: false,
      };
    }

    return {
      physical: reduce(buckets.physical),
      emotional: reduce(buckets.emotional),
      social: reduce(buckets.social),
    };
  }, [events, members, room]);
}
