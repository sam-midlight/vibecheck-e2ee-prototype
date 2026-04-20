import type { RoomMemberRow } from '@/lib/supabase/queries';

/**
 * Filters to current-generation members and dedupes by user_id, preserving
 * the first-seen device row for each user.
 *
 * Use this anywhere you want a list of PEOPLE in the room (orbs, sliders,
 * gratitude recipients, vibe lines). Don't use it where you genuinely
 * want one row per device — admin device-management UIs, key revocation
 * flows, anything inspecting the per-device wrap.
 */
export function uniqueMembers(
  members: RoomMemberRow[],
  generation: number,
): RoomMemberRow[] {
  return members
    .filter((m) => m.generation === generation)
    .filter(
      (m, i, arr) => arr.findIndex((x) => x.user_id === m.user_id) === i,
    );
}
