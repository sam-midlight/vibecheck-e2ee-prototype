'use client';

/**
 * Per-device "room name hint" storage. Populated when a user accepts an
 * invite that carried an encrypted room name (new post-0009 invite field).
 * The room's RoomHeader reads this as an additional fallback after the
 * event-stream scan and column decrypt, so joiners see the current name
 * the moment they land on the room page, even if the column path or
 * event decrypt races against the initial load.
 *
 * Strictly a local convenience — not authoritative, not shared.
 */

const KEY_PREFIX = 'vibecheck-2:room-name-hint:';

function key(roomId: string): string {
  return `${KEY_PREFIX}${roomId}`;
}

export function saveRoomNameHint(roomId: string, name: string): void {
  if (typeof window === 'undefined') return;
  const trimmed = name.trim().slice(0, 120);
  try {
    if (trimmed) localStorage.setItem(key(roomId), trimmed);
    else localStorage.removeItem(key(roomId));
  } catch {
    // Storage quota / security exceptions — not load-bearing.
  }
}

export function loadRoomNameHint(roomId: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(key(roomId));
    if (!raw) return null;
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}
