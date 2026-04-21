'use client';

/**
 * Per-vault "last seen" timestamp tracker.
 *
 * Each device persists a per-(user, dateId) timestamp in localStorage
 * that captures "when did this user last open this vault." Used by:
 *   - MatchedDatesBoard to render an unread badge on the "Open vault"
 *     pill when there are new posts / memories / spins since I looked.
 *   - DateVault.tsx itself to bump the timestamp on mount.
 *
 * NOT in the encrypted ledger — this is per-device personal state.
 * Keeps the room event log free of "viewer cursor" noise that doesn't
 * help anyone but you.
 */

import { useEffect, useState } from 'react';
import { useRoom, useRoomProjection } from '@/components/RoomProvider';

const KEY_PREFIX = 'vibecheck-2:vault-seen:';

function key(userId: string, dateId: string): string {
  return `${KEY_PREFIX}${userId}:${dateId}`;
}

/** Read the last-seen ts (ms epoch). Returns 0 if never seen. */
export function getVaultLastSeen(userId: string, dateId: string): number {
  if (typeof window === 'undefined') return 0;
  try {
    const raw = window.localStorage.getItem(key(userId, dateId));
    if (!raw) return 0;
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

/** Write the current time as the last-seen ts. */
export function markVaultSeen(userId: string, dateId: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key(userId, dateId), String(Date.now()));
    // Notify same-tab subscribers; storage events only fire across tabs.
    window.dispatchEvent(new CustomEvent('vibecheck:vault-seen', { detail: { userId, dateId } }));
  } catch {
    /* noop */
  }
}

/** Subscribe to last-seen changes (localStorage + custom event). */
function useLastSeen(userId: string | null, dateId: string): number {
  const [ts, setTs] = useState(() =>
    userId ? getVaultLastSeen(userId, dateId) : 0,
  );
  useEffect(() => {
    if (!userId) {
      setTs(0);
      return;
    }
    const uid = userId;
    setTs(getVaultLastSeen(uid, dateId));
    function refresh() {
      setTs(getVaultLastSeen(uid, dateId));
    }
    function onCustom(e: Event) {
      const detail = (e as CustomEvent).detail as
        | { userId?: string; dateId?: string }
        | undefined;
      if (!detail) return;
      if (detail.userId === uid && detail.dateId === dateId) refresh();
    }
    function onStorage(e: StorageEvent) {
      if (e.key === key(uid, dateId)) refresh();
    }
    window.addEventListener('vibecheck:vault-seen', onCustom as EventListener);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener('vibecheck:vault-seen', onCustom as EventListener);
      window.removeEventListener('storage', onStorage);
    };
  }, [userId, dateId]);
  return ts;
}

/**
 * useVaultUnread — returns counts of unread vault activity since the
 * viewer last opened that vault. Counts are per category so the UI
 * can decide what to surface; total is the sum.
 */
export interface VaultUnread {
  posts: number;
  memories: number;
  spins: number;
  total: number;
  /** Most recent activity ts across all three buckets (or 0). */
  lastActivityTs: number;
}

export function useVaultUnread(dateId: string): VaultUnread {
  const { myUserId } = useRoom();
  const lastSeen = useLastSeen(myUserId, dateId);
  return useRoomProjection<VaultUnread>(
    (acc, rec) => {
      const ev = rec.event;
      const isVaultEvent =
        (ev.type === 'date_post' && ev.dateId === dateId) ||
        (ev.type === 'date_memory' && ev.dateId === dateId) ||
        (ev.type === 'date_roulette_spin' && ev.dateId === dateId);
      if (!isVaultEvent) return acc;
      // My own activity doesn't count as unread for me.
      if (rec.senderId === myUserId) return acc;
      if (ev.ts <= lastSeen) return acc;
      const next = { ...acc };
      if (ev.type === 'date_post') next.posts++;
      else if (ev.type === 'date_memory') next.memories++;
      else if (ev.type === 'date_roulette_spin') next.spins++;
      next.total = next.posts + next.memories + next.spins;
      next.lastActivityTs = Math.max(next.lastActivityTs, ev.ts);
      return next;
    },
    { posts: 0, memories: 0, spins: 0, total: 0, lastActivityTs: 0 },
    [dateId, myUserId, lastSeen],
  );
}
