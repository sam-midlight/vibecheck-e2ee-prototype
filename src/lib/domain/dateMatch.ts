/**
 * Centralised match-detection for date ideas.
 *
 * One source of truth so DatesOracle, IdeaCard, MatchedDatesBoard,
 * MemoryBank, DateVault, and LiveEventNotifier never disagree about
 * whether a given idea is matched. Previously each site re-rolled
 * the rule, and one of them ignored invitedUserIds — which meant a
 * targeted date in a 3+-member room would never flip to "matched"
 * in the IdeaCard even after every invited voter had said yes.
 *
 * Pure functions; no React, no events written.
 */

export interface MinimalIdea {
  /** Empty / missing = whole-room (untargeted). Otherwise the
   *  explicit invited set. Filtered downstream against the room's
   *  current member list. */
  invitedUserIds: string[];
  voters: Set<string>;
}

/** The list of users whose vote is REQUIRED for an idea to match,
 *  intersected with the current-gen member list. Defaults to the
 *  whole room when the idea is untargeted. The voters set isn't
 *  needed here — pass either a MinimalIdea or just an object with
 *  invitedUserIds. */
export function requiredVoters(
  idea: { invitedUserIds: string[] },
  memberIds: string[],
): string[] {
  if (idea.invitedUserIds.length === 0) return memberIds;
  const memberSet = new Set(memberIds);
  return idea.invitedUserIds.filter((u) => memberSet.has(u));
}

/**
 * True iff every required voter has cast a yes AND the total voter
 * count is at least 2 (single-person matches don't count as a
 * relationship event — that floor avoids self-celebration in a
 * sole-member room).
 */
export function isDateMatched(
  idea: MinimalIdea,
  memberIds: string[],
): boolean {
  const need = requiredVoters(idea, memberIds);
  if (need.length === 0) return false;
  if (idea.voters.size < 2) return false;
  for (const uid of need) {
    if (!idea.voters.has(uid)) return false;
  }
  return true;
}
