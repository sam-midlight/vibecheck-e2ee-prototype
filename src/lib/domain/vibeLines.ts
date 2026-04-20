'use client';

/**
 * Vibe Lines — empathic, single-sentence reads of each member's
 * current vibe.
 *
 * V2: vector-based. Each member's slider state collapses to a 3D
 * (physical, emotional, social) vector via useVibeState. The vector
 * classifies into a named state, and we pick a templated line for
 * that state, token-substituting the dominant slider title.
 *
 * V1's per-title heuristics still serve as a fallback "spotlight"
 * line for the love-tank reading — that's the only thing not yet
 * fully expressible through the vector system.
 *
 * Pure projection — single pass, nothing written from here.
 */

import { useMemo } from 'react';
import { useRoom } from '@/components/RoomProvider';
import { displayName as fmtDisplayName } from './displayName';
import { uniqueMembers } from './members';
import { hueForUser } from './userTheme';
import {
  classifyVibeState,
  resolveDimension,
  resolvePolarity,
  type DimensionReading,
  type VibeState,
  type VibeStateName,
} from './vibeState';
import type { SliderDimension, SliderPolarity } from './events';

/** Where clicking this line should take the viewer. */
export type VibeTarget =
  | { kind: 'slider'; title: string }
  | { kind: 'love_tank' };

export interface VibeLine {
  id: string;
  text: string;
  emoji: string;
  /** 0–360 HSL hue. */
  hue: number;
  /** 'high' = stronger glow / saturated; 'mid' = subtle. */
  intensity: 'mid' | 'high';
  /** Member this line is about (their userId). */
  subjectUid: string;
  /** Which feature + sub-target to open on click. */
  target: VibeTarget;
}

interface SliderDefAcc {
  title: string;
  dimension: SliderDimension;
  polarity: SliderPolarity;
  definedTs: number;
  deletedTs: number;
}

interface SliderValAcc {
  value: number;
  ts: number;
}

interface LoveTankVal {
  level: number;
  ts: number;
}

// ---------------------------------------------------------------------------
// Templated lines per named vibe state.
//
// Tokens:
//   {name}     — first name of the subject
//   {dominant} — title (lowercased) of the slider pulling the dominant
//                axis hardest. Only meaningful for states whose copy
//                actually uses it; templates that don't need it omit it.
// ---------------------------------------------------------------------------

interface StateTemplate {
  emoji: string;
  intensity: 'mid' | 'high';
  /** Hue offset applied on top of the user's theme hue (HSL). Lets
   *  the same state read slightly different per person while staying
   *  in their colour family. */
  hueShift: number;
  /** Lines are picked deterministically by hashing the subject's uid
   *  + state name, so the same person doesn't see a different line on
   *  every refresh but two people in the same state get distinct copy. */
  lines: string[];
}

const STATE_TEMPLATES: Record<VibeStateName, StateTemplate> = {
  depleted: {
    emoji: '🪫',
    intensity: 'high',
    hueShift: 0,
    lines: [
      '{name} is running on fumes everywhere',
      '{name} is depleted across the board',
      'Tank-low day for {name} — physically and emotionally',
    ],
  },
  overwhelmed: {
    emoji: '🌪️',
    intensity: 'high',
    hueShift: -10,
    lines: [
      '{name} is feeling a surge of {dominant}',
      '{name} is overwhelmed — emotionally drained, socially flat',
      "It's a lot for {name} right now",
    ],
  },
  tender: {
    emoji: '🫧',
    intensity: 'mid',
    hueShift: 20,
    lines: [
      '{name} is tender today — go gentle',
      '{name} is feeling {dominant} more than usual',
      'A softer day for {name}',
    ],
  },
  cocooning: {
    emoji: '🍵',
    intensity: 'mid',
    hueShift: -30,
    lines: [
      '{name} needs space — quiet company welcome',
      "{name}'s socialness is at a low ebb",
      '{name} is in cocoon mode',
    ],
  },
  wired_alone: {
    emoji: '🌙',
    intensity: 'mid',
    hueShift: 30,
    lines: [
      "{name}'s body is quiet but their head is wide awake",
      '{name} is physically low but sharp',
      'Restless rest for {name}',
    ],
  },
  restless: {
    emoji: '⚡',
    intensity: 'mid',
    hueShift: 10,
    lines: [
      "{name} has energy but no one to spend it on",
      '{name} is restless — wants to do something with someone',
      'Pent-up energy for {name}',
    ],
  },
  bright: {
    emoji: '☀️',
    intensity: 'high',
    hueShift: 0,
    lines: [
      '{name} is bright across the board',
      'A glow-up day for {name}',
      "{name} is on it — body, heart, social all up",
    ],
  },
  connected: {
    emoji: '🤝',
    intensity: 'mid',
    hueShift: 15,
    lines: [
      '{name} is socially full and emotionally up',
      '{name} is in a connecting mood',
      'Open and present — {name} is reaching out',
    ],
  },
  recharged: {
    emoji: '🌿',
    intensity: 'mid',
    hueShift: -5,
    lines: [
      '{name} is on the up',
      'Things are landing well for {name}',
      "{name}'s {dominant} is the lift today",
    ],
  },
  steady: {
    emoji: '✨',
    intensity: 'mid',
    hueShift: 0,
    lines: [
      '{name} is steady today',
      'Nothing loud for {name} — just here',
      "{name}'s vibe is balanced",
    ],
  },
};

/** Pick a deterministic template line for this (uid, state) pair. */
function pickLine(uid: string, state: VibeStateName): string {
  const template = STATE_TEMPLATES[state];
  let h = 0;
  const seed = `${uid}:${state}`;
  for (let i = 0; i < seed.length; i++) {
    h = (h * 31 + seed.charCodeAt(i)) | 0;
  }
  return template.lines[Math.abs(h) % template.lines.length];
}

/** Token-substitute name and dominant slider into a template. */
function substitute(template: string, name: string, dominant: string | null): string {
  return template
    .replaceAll('{name}', name)
    .replaceAll('{dominant}', dominant ? dominant.toLowerCase() : 'something');
}

/** Map hex colour to an HSL hue (0–360). Used to derive a per-user
 *  base hue for the oracle banner glow. */
function hexToHue(hex: string): number {
  const h = hex.startsWith('#') ? hex.slice(1) : hex;
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  if (delta === 0) return 0;
  let hue = 0;
  if (max === r) hue = ((g - b) / delta) % 6;
  else if (max === g) hue = (b - r) / delta + 2;
  else hue = (r - g) / delta + 4;
  hue *= 60;
  return (hue + 360) % 360;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useVibeLines(): VibeLine[] {
  const { events, members, room, myUserId, displayNames } = useRoom();

  return useMemo<VibeLine[]>(() => {
    if (!room) return [];
    const memberIds = uniqueMembers(members, room.current_generation).map(
      (m) => m.user_id,
    );
    if (memberIds.length === 0) return [];

    // Single pass over events: build per-member state (defs + values).
    const sliderDefs: Record<string, SliderDefAcc> = {};
    const sliderVals: Record<string, Record<string, SliderValAcc>> = {};
    const loveTank: Record<string, LoveTankVal> = {};
    for (const rec of events) {
      const ev = rec.event;
      if (ev.type === 'slider_define') {
        const prev = sliderDefs[ev.sliderId];
        if (!prev || ev.ts > prev.definedTs) {
          sliderDefs[ev.sliderId] = {
            title: ev.title,
            dimension: resolveDimension(ev.dimension, ev.title),
            polarity: resolvePolarity(ev.polarity, ev.title),
            definedTs: ev.ts,
            deletedTs: prev?.deletedTs ?? 0,
          };
        }
      } else if (ev.type === 'slider_delete') {
        const prev = sliderDefs[ev.sliderId];
        if (prev && ev.ts > prev.deletedTs) {
          sliderDefs[ev.sliderId] = { ...prev, deletedTs: ev.ts };
        }
      } else if (ev.type === 'slider_set') {
        const prior = sliderVals[ev.sliderId]?.[rec.senderId];
        if (!prior || ev.ts > prior.ts) {
          sliderVals[ev.sliderId] = {
            ...(sliderVals[ev.sliderId] ?? {}),
            [rec.senderId]: { value: ev.value, ts: ev.ts },
          };
        }
      } else if (ev.type === 'love_tank_set') {
        const prior = loveTank[rec.senderId];
        if (!prior || ev.ts > prior.ts) {
          loveTank[rec.senderId] = { level: ev.level, ts: ev.ts };
        }
      }
    }

    const out: VibeLine[] = [];

    for (const uid of memberIds) {
      const name = firstWord(fmtDisplayName(uid, displayNames, myUserId, null));
      const baseHue = hexToHue(hueForUser(uid));

      // Build the user's vibe vector inline (mirrors useVibeState's
      // logic so we don't need to call hooks-per-uid).
      const buckets: Record<
        SliderDimension,
        Array<{ adjusted: number; raw: number; title: string }>
      > = { physical: [], emotional: [], social: [] };
      for (const [sliderId, def] of Object.entries(sliderDefs)) {
        if (def.definedTs <= def.deletedTs) continue;
        const v = sliderVals[sliderId]?.[uid];
        if (!v) continue;
        const adjusted = def.polarity === 'inverted' ? 100 - v.value : v.value;
        buckets[def.dimension].push({
          adjusted,
          raw: v.value,
          title: def.title.trim(),
        });
      }
      const reduce = (
        bucket: Array<{ adjusted: number; raw: number; title: string }>,
      ): DimensionReading => {
        if (bucket.length === 0) {
          return {
            score: 50,
            axis: 0,
            dominantTitle: null,
            dominantValue: null,
            dominantNegative: false,
          };
        }
        const meanAdjusted =
          bucket.reduce((s, x) => s + x.adjusted, 0) / bucket.length;
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
      };
      const state: VibeState = {
        physical: reduce(buckets.physical),
        emotional: reduce(buckets.emotional),
        social: reduce(buckets.social),
      };

      // Need at least one dimension with readings before we narrate.
      const anyReadings =
        state.physical.dominantTitle !== null ||
        state.emotional.dominantTitle !== null ||
        state.social.dominantTitle !== null;
      if (anyReadings) {
        const named = classifyVibeState(state);
        const tmpl = STATE_TEMPLATES[named];
        const dominantOverall =
          [state.emotional, state.physical, state.social]
            .filter((d) => d.dominantTitle !== null)
            .sort((a, b) => Math.abs(b.axis) - Math.abs(a.axis))[0]
            ?.dominantTitle ?? null;
        const text = substitute(pickLine(uid, named), name, dominantOverall);
        const target: VibeTarget =
          dominantOverall != null
            ? { kind: 'slider', title: dominantOverall }
            : { kind: 'slider', title: '' };
        out.push({
          id: `vector-${named}-${uid}`,
          text,
          emoji: tmpl.emoji,
          hue: (baseHue + tmpl.hueShift + 360) % 360,
          intensity: tmpl.intensity,
          subjectUid: uid,
          target,
        });
      }

      // Love-tank spotlights stay separate from the vector system —
      // they're load-bearing on their own and target a different
      // sheet on click.
      const tank = loveTank[uid];
      if (tank) {
        const tankT: VibeTarget = { kind: 'love_tank' };
        if (tank.level >= 85) {
          out.push({
            id: `tank-full-${uid}`,
            emoji: '💖',
            text: `${name}'s love tank is full`,
            hue: 330,
            intensity: 'high',
            subjectUid: uid,
            target: tankT,
          });
        } else if (tank.level > 0 && tank.level < 30) {
          out.push({
            id: `tank-low-${uid}`,
            emoji: '💔',
            text: `${name}'s love tank is running low`,
            hue: 350,
            intensity: 'high',
            subjectUid: uid,
            target: tankT,
          });
        }
      }
    }

    return out;
  }, [events, members, room, myUserId, displayNames]);
}

function firstWord(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '';
  const idx = trimmed.search(/\s/);
  return idx === -1 ? trimmed : trimmed.slice(0, idx);
}
