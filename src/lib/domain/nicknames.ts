/**
 * Local Nicknames.
 *
 * Personal device-only map of userId → nickname. Never synced to the server,
 * never visible to anyone else. A nickname *overrides* the event-stream
 * display name — it's this viewer's preferred rendering, not a shared one.
 *
 * Storage key is app-scoped (not room-scoped) because a user's UUID is the
 * same in every room they're in, and it would be annoying to re-nickname
 * them per room.
 */

'use client';

import { useCallback, useEffect, useState } from 'react';

const STORAGE_KEY = 'vibecheck-2:nicknames';

export function loadNicknames(): Record<string, string> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v !== 'string') continue;
      const trimmed = v.trim();
      if (trimmed) out[k] = trimmed;
    }
    return out;
  } catch {
    return {};
  }
}

export function saveNicknames(map: Record<string, string>): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // quota / security errors — nicknames are a nicety, drop silently.
  }
}

/**
 * Reactive hook. Returns the current map + a setter. Syncs across tabs via
 * the `storage` event so renaming someone in one tab lights up in another.
 */
export function useNicknames() {
  const [nicknames, setMap] = useState<Record<string, string>>({});

  // Lazy-load on mount so SSR doesn't touch localStorage.
  useEffect(() => {
    setMap(loadNicknames());
    function onStorage(e: StorageEvent) {
      if (e.key === STORAGE_KEY) setMap(loadNicknames());
    }
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const setNickname = useCallback((userId: string, name: string) => {
    setMap((prev) => {
      const next = { ...prev };
      const trimmed = name.trim().slice(0, 60);
      if (trimmed) next[userId] = trimmed;
      else delete next[userId];
      saveNicknames(next);
      return next;
    });
  }, []);

  const clearNickname = useCallback((userId: string) => {
    setMap((prev) => {
      if (!(userId in prev)) return prev;
      const next = { ...prev };
      delete next[userId];
      saveNicknames(next);
      return next;
    });
  }, []);

  return { nicknames, setNickname, clearNickname };
}
