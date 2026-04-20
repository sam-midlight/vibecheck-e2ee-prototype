/**
 * Canonical helper for rendering a user in the UI.
 *
 * - Renders `selfLabel` (defaults to "you") when the id matches the viewer.
 * - Otherwise renders their chosen display name if set.
 * - Falls back to the truncated UUID prefix `xxxxxxxx…` when no name exists.
 *
 * Pass `selfLabel: null` when you want the actual name even for the viewer
 * (e.g. legend rows where "you" would be ambiguous alongside other metrics).
 */

export function displayName(
  userId: string,
  displayNames: Record<string, string>,
  myUserId: string | null,
  selfLabel: string | null = 'you',
): string {
  if (selfLabel && userId === myUserId) return selfLabel;
  const name = displayNames[userId]?.trim();
  if (name) return name;
  return `${userId.slice(0, 8)}…`;
}
