'use client';

/**
 * useVibeState — projects the room's slider/love-tank events into a
 * 3D vibe vector per user (physical / emotional / social, each in
 * [-1, +1]) plus per-dimension dominance metadata so the Vibe Oracle
 * can pull a deterministic, combinatorial empathic line out of the
 * combined state.
 *
 * Design follows Sam's "Weighted Vector" proposal:
 *   - Each slider tagged with a dimension + polarity.
 *   - Polarity-adjusted score (0–100) per slider.
 *   - Mean per dimension → axis score → normalize to [-1, +1].
 *   - For each axis, also remember the dominant slider (the one
 *     pulling that axis hardest, after polarity adjustment) so
 *     templated lines can name it: "Sam is feeling a surge of
 *     {SliderName}".
 *
 * Backwards-compatible with legacy slider_define events that don't
 * carry dimension/polarity — see resolveDimension/resolvePolarity.
 *
 * Pure projection — single pass over events, no events written here.
 */

import { useMemo } from 'react';
import { useRoom } from '@/components/RoomProvider';
import { uniqueMembers } from './members';
import {
  SLIDER_DIMENSIONS,
  type SliderDimension,
  type SliderPolarity,
} from './events';

// ---------------------------------------------------------------------------
// Backfill: derive dimension + polarity for legacy or under-specified
// slider definitions from the title and labels.
// ---------------------------------------------------------------------------

const TITLE_TO_DIMENSION: Array<[RegExp, SliderDimension]> = [
  // Emotional first because some titles overlap (e.g. "energy" of mood).
  [/anxiety|stress|mood|happy|sad|love|affection|tender|emotion|grief|joy|calm/i, 'emotional'],
  [/social|bandwidth|connect|alone|crowd|lonely|company|talkative|hangs/i, 'social'],
  [/energy|hunger|sleep|rest|tired|body|sick|pain|focus|sharp|fatigue|hydration|fitness/i, 'physical'],
];

/** Default to emotional — least likely to mislead in absence of evidence. */
export function resolveDimension(
  explicit: SliderDimension | undefined,
  title: string,
): SliderDimension {
  if (explicit) return explicit;
  for (const [re, dim] of TITLE_TO_DIMENSION) {
    if (re.test(title)) return dim;
  }
  return 'emotional';
}

/** Titles where high values are bad rather than good. */
const KNOWN_INVERTED = new Set([
  'hunger',
  'anxiety',
  'stress',
  'pain',
  'tired',
  'fatigue',
  'overwhelm',
  'frustration',
]);

export function resolvePolarity(
  explicit: SliderPolarity | undefined,
  title: string,
): SliderPolarity {
  if (explicit) return explicit;
  return KNOWN_INVERTED.has(title.trim().toLowerCase()) ? 'inverted' : 'normal';
}

// ---------------------------------------------------------------------------
// Vibe state shape
// ---------------------------------------------------------------------------

export interface DimensionReading {
  /** Mean polarity-adjusted score (0–100). Higher = better, regardless
   *  of how individual sliders are oriented. */
  score: number;
  /** Normalised to [-1, +1] for combination math. */
  axis: number;
  /** Dominant slider for this dimension — the one whose adjusted
   *  score is furthest from 50 (in either direction). Useful for
   *  token-substitution in oracle lines. null if no sliders set. */
  dominantTitle: string | null;
  dominantValue: number | null;
  /** True when the dominant slider's polarity-adjusted score is
   *  itself in the warning band (< 30). */
  dominantNegative: boolean;
}

export interface VibeState {
  physical: DimensionReading;
  emotional: DimensionReading;
  social: DimensionReading;
}

const EMPTY_DIMENSION: DimensionReading = {
  score: 50,
  axis: 0,
  dominantTitle: null,
  dominantValue: null,
  dominantNegative: false,
};

const EMPTY_STATE: VibeState = {
  physical: EMPTY_DIMENSION,
  emotional: EMPTY_DIMENSION,
  social: EMPTY_DIMENSION,
};

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

interface SliderDef {
  title: string;
  dimension: SliderDimension;
  polarity: SliderPolarity;
  definedTs: number;
  deletedTs: number;
}

interface SliderVal {
  value: number;
  ts: number;
}

/**
 * Per-user vibe state. Hook reads the same event stream every other
 * projection uses, so it stays in sync with VibeSliders + vibeLines.
 */
export function useVibeState(userId: string | null): VibeState {
  const { events, members, room } = useRoom();

  return useMemo(() => {
    if (!userId || !room) return EMPTY_STATE;
    // Sanity: only consider current-gen members so a stale uid from
    // an old generation doesn't accidentally show readings.
    const currentMemberIds = new Set(
      uniqueMembers(members, room.current_generation).map((m) => m.user_id),
    );
    if (!currentMemberIds.has(userId)) return EMPTY_STATE;

    const defs: Record<string, SliderDef> = {};
    const vals: Record<string, SliderVal> = {};

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
      } else if (ev.type === 'slider_set' && rec.senderId === userId) {
        const prior = vals[ev.sliderId];
        if (!prior || ev.ts > prior.ts) {
          vals[ev.sliderId] = { value: ev.value, ts: ev.ts };
        }
      }
    }

    const buckets: Record<
      SliderDimension,
      Array<{ adjusted: number; raw: number; title: string }>
    > = { physical: [], emotional: [], social: [] };

    for (const [sliderId, def] of Object.entries(defs)) {
      if (def.definedTs <= def.deletedTs) continue;
      const v = vals[sliderId];
      if (!v) continue;
      const adjusted =
        def.polarity === 'inverted' ? 100 - v.value : v.value;
      buckets[def.dimension].push({
        adjusted,
        raw: v.value,
        title: def.title.trim(),
      });
    }

    function reduceBucket(
      bucket: Array<{ adjusted: number; raw: number; title: string }>,
    ): DimensionReading {
      if (bucket.length === 0) return EMPTY_DIMENSION;
      const meanAdjusted =
        bucket.reduce((s, x) => s + x.adjusted, 0) / bucket.length;
      // Dominant = the slider whose adjusted score is furthest from
      // the 50 midpoint (its absolute "loudness" right now).
      let dominant = bucket[0];
      let bestDistance = Math.abs(bucket[0].adjusted - 50);
      for (const item of bucket.slice(1)) {
        const d = Math.abs(item.adjusted - 50);
        if (d > bestDistance) {
          dominant = item;
          bestDistance = d;
        }
      }
      return {
        score: meanAdjusted,
        axis: (meanAdjusted - 50) / 50,
        dominantTitle: dominant.title,
        dominantValue: dominant.raw,
        dominantNegative: dominant.adjusted < 30,
      };
    }

    return {
      physical: reduceBucket(buckets.physical),
      emotional: reduceBucket(buckets.emotional),
      social: reduceBucket(buckets.social),
    };
  }, [events, members, room, userId]);
}

// ---------------------------------------------------------------------------
// Named-state classification — maps a (P, E, S) vector to one of the
// known "vibe states", each with a small library of templated lines.
// ---------------------------------------------------------------------------

export type VibeStateName =
  | 'overwhelmed'
  | 'tender'
  | 'restless'
  | 'wired_alone'
  | 'depleted'
  | 'recharged'
  | 'bright'
  | 'connected'
  | 'cocooning'
  | 'steady';

/** Classify a vibe vector. Order matters: rules earlier win on ties. */
export function classifyVibeState(state: VibeState): VibeStateName {
  const { physical: P, emotional: E, social: S } = state;
  const low = (r: DimensionReading) => r.axis <= -0.3;
  const high = (r: DimensionReading) => r.axis >= 0.3;

  // Compound lows take precedence — they signal real distress.
  if (low(P) && low(E) && low(S)) return 'depleted';
  if (low(E) && low(S)) return 'overwhelmed';
  if (low(E) && !low(S) && !low(P)) return 'tender';
  if (low(S) && !low(E) && !low(P)) return 'cocooning';
  if (low(P) && !low(E) && !low(S)) return 'wired_alone';
  if (high(P) && low(S)) return 'restless';

  // Compound highs.
  if (high(P) && high(E) && high(S)) return 'bright';
  if (high(E) && high(S)) return 'connected';
  if (high(P) || high(E)) return 'recharged';

  return 'steady';
}

for (const dim of SLIDER_DIMENSIONS) {
  void dim; // re-export keeper
}
