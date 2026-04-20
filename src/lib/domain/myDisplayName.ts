/**
 * The user's own preferred display name, stored locally on this device.
 *
 * This is set during onboarding. When the user enters a room, RoomProvider
 * auto-emits a `display_name_set` event carrying this value so partners see
 * the chosen name instead of a UUID. One-time bootstrap per room.
 *
 * It's a personal default — nicknames (what I call others) are separate,
 * stored by userId in nicknames.ts.
 */

'use client';

const KEY = 'vibecheck-2:my-display-name';

export function loadMyDisplayName(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

export function saveMyDisplayName(name: string): void {
  if (typeof window === 'undefined') return;
  const trimmed = name.trim().slice(0, 60);
  try {
    if (trimmed) localStorage.setItem(KEY, trimmed);
    else localStorage.removeItem(KEY);
  } catch {
    // storage quota / security exception — not load-bearing.
  }
}
