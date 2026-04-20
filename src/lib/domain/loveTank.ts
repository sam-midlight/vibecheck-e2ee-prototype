/**
 * Love Tank utilities — pure, client-side only.
 *
 * The "Actionable Love Tank" stores a map of love-language → allocated
 * percentage (each category 0–100, sum + tank level ≤ 100). Widgets built
 * on top of that state should consult `getTopNeed()` rather than walking the
 * map by hand — it handles the tie and empty cases consistently.
 *
 * Why pure: this has to be trivially portable into an iOS / Android home-
 * screen widget context (e.g., a native widget running the same projection
 * over a cached decrypted snapshot). No React, no Supabase, no side effects.
 */

import { LOVE_LANGUAGES, type LoveLanguage } from './events';

/** Shape of the needs map — absent keys are semantically zero. */
export type NeedsMap = Partial<Record<LoveLanguage, number>>;

/**
 * Result of picking the "top need" for a user.
 * - `needs`: one entry normally, 2+ on a tie (descending order matches
 *   `LOVE_LANGUAGES` iteration order for stable rendering).
 * - `value`: the shared top percentage (all tied needs share this value).
 */
export interface TopNeedResult {
  needs: LoveLanguage[];
  value: number;
}

/**
 * Find the highest-allocated need(s) in a needs map.
 *
 * Returns `null` when every allocation is ≤ 0 — meaning either the tank is
 * fully topped up or the user simply hasn't broken anything down. Callers
 * can branch on null to render a "Tank is balanced" state.
 *
 * On ties, every need sharing the top value is returned, so the UI can
 * render "⏰ Quality time & 🎁 Gifts" rather than arbitrarily picking one.
 */
export function getTopNeed(needs: NeedsMap): TopNeedResult | null {
  let max = 0;
  const winners: LoveLanguage[] = [];
  for (const k of LOVE_LANGUAGES) {
    const v = needs[k] ?? 0;
    if (v <= 0) continue;
    if (v > max) {
      max = v;
      winners.length = 0;
      winners.push(k);
    } else if (v === max) {
      winners.push(k);
    }
  }
  return winners.length === 0 ? null : { needs: winners, value: max };
}

/** Human labels + emoji for a need. Kept here (not in the component) so any
 *  surface — web, native widget, export — can render consistently. */
export const NEED_LABEL: Record<LoveLanguage, string> = {
  quality_time: 'Quality time',
  physical_affection: 'Physical affection',
  words_of_affirmation: 'Words of affirmation',
  acts_of_service: 'Acts of service',
  gifts: 'Gifts',
};

export const NEED_EMOJI: Record<LoveLanguage, string> = {
  quality_time: '⏰',
  physical_affection: '🤗',
  words_of_affirmation: '💬',
  acts_of_service: '🛠️',
  gifts: '🎁',
};

/** Format a TopNeedResult as a single human-readable string. Handy for
 *  headless contexts (toast titles, widget strings, PDF exports). */
export function formatTopNeed(result: TopNeedResult | null): string {
  if (!result) return 'Tank is balanced ✨';
  const parts = result.needs.map(
    (k) => `${NEED_EMOJI[k]} ${NEED_LABEL[k]}`,
  );
  const label =
    parts.length === 1
      ? parts[0]
      : parts.length === 2
        ? `${parts[0]} & ${parts[1]}`
        : `${parts.slice(0, -1).join(', ')}, & ${parts[parts.length - 1]}`;
  return `${label} · ${result.value}%`;
}
