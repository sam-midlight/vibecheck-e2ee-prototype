/**
 * Unread tracking.
 *
 * Zero-knowledge means we can't store "last viewed" on the server. Per-room,
 * per-section timestamps live in localStorage keyed by roomId. A section is
 * "unread" when at least one partner-originated event within its event-type
 * set has a `createdAt` newer than the viewer's last-viewed timestamp.
 *
 * Self-events never mark anything unread (you don't owe yourself a
 * notification about your own click).
 */

'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRoom, type RoomEventRecord } from '@/components/RoomProvider';

export type SectionId =
  | 'homework'
  | 'vibe_sliders'
  | 'love_tank'
  | 'wishlist'
  | 'gratitude'
  | 'dates'
  | 'mind_reader'
  | 'safe_space'
  | 'messages';

export const SECTION_EVENT_TYPES: Record<SectionId, readonly string[]> = {
  homework: ['homework_set'],
  vibe_sliders: ['slider_set', 'slider_define', 'slider_delete'],
  love_tank: ['love_tank_set'],
  wishlist: ['wishlist_add', 'wishlist_claim', 'wishlist_delete'],
  gratitude: ['gratitude_send'],
  dates: [
    'date_idea_add',
    'date_idea_vote',
    'date_idea_unvote',
    'date_idea_schedule',
    'date_idea_complete',
    'date_idea_delete',
  ],
  mind_reader: ['mind_reader_post', 'mind_reader_solve', 'mind_reader_delete'],
  safe_space: [
    'icebreaker_post',
    'icebreaker_unlock',
    'icebreaker_ready_to_talk',
    'icebreaker_ack',
    'icebreaker_resolve',
    'icebreaker_delete',
    'time_out_start',
    'time_out_end',
  ],
  messages: ['message'],
};

const REVERSE: Record<string, SectionId> = (() => {
  const out: Record<string, SectionId> = {};
  for (const [section, types] of Object.entries(SECTION_EVENT_TYPES)) {
    for (const t of types) out[t] = section as SectionId;
  }
  return out;
})();

export function sectionForEventType(type: string): SectionId | null {
  return REVERSE[type] ?? null;
}

// ---------------------------------------------------------------------------
// localStorage-backed last-viewed timestamps, per room.
// ---------------------------------------------------------------------------

type LastViewed = Partial<Record<SectionId, number>>;

const storageKey = (roomId: string) => `vibecheck-2:last-viewed:${roomId}`;

function loadLastViewed(roomId: string): LastViewed {
  if (typeof window === 'undefined') return {};
  try {
    const raw = localStorage.getItem(storageKey(roomId));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return {};
    const out: LastViewed = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v !== 'number') continue;
      if (!(k in SECTION_EVENT_TYPES)) continue;
      out[k as SectionId] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function saveLastViewed(roomId: string, map: LastViewed): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(storageKey(roomId), JSON.stringify(map));
  } catch {
    // quota or security — unread is a UX nicety, drop silently.
  }
}

export function useLastViewed(roomId: string | undefined) {
  const [lastViewed, setMap] = useState<LastViewed>({});

  useEffect(() => {
    if (!roomId) {
      setMap({});
      return;
    }
    setMap(loadLastViewed(roomId));
    function onStorage(e: StorageEvent) {
      if (roomId && e.key === storageKey(roomId)) {
        setMap(loadLastViewed(roomId));
      }
    }
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [roomId]);

  const markViewed = useCallback(
    (section: SectionId, ts: number = Date.now()) => {
      if (!roomId) return;
      setMap((prev) => {
        const prior = prev[section] ?? 0;
        if (ts <= prior) return prev;
        const next: LastViewed = { ...prev, [section]: ts };
        saveLastViewed(roomId, next);
        return next;
      });
    },
    [roomId],
  );

  const markAllViewed = useCallback(
    (ts: number = Date.now()) => {
      if (!roomId) return;
      setMap((prev) => {
        const next: LastViewed = { ...prev };
        for (const section of Object.keys(SECTION_EVENT_TYPES) as SectionId[]) {
          if ((next[section] ?? 0) < ts) next[section] = ts;
        }
        saveLastViewed(roomId, next);
        return next;
      });
    },
    [roomId],
  );

  return { lastViewed, markViewed, markAllViewed };
}

// ---------------------------------------------------------------------------
// Unread projection over the room's event stream.
// ---------------------------------------------------------------------------

export type UnreadMap = Partial<Record<SectionId, boolean>>;

export function useUnreadBySection() {
  const { events, myUserId, room } = useRoom();
  const { lastViewed, markViewed, markAllViewed } = useLastViewed(room?.id);

  const unread = useMemo<UnreadMap>(() => {
    if (!myUserId) return {};
    const out: UnreadMap = {};
    for (const rec of events) {
      if (rec.senderId === myUserId) continue;
      const section = sectionForEventType(rec.event.type);
      if (!section) continue;
      if (out[section]) continue; // already flagged
      const evTs = new Date(rec.createdAt).getTime();
      if (evTs > (lastViewed[section] ?? 0)) out[section] = true;
    }
    return out;
  }, [events, myUserId, lastViewed]);

  return { unread, markViewed, markAllViewed, lastViewed };
}

// ---------------------------------------------------------------------------
// Recent partner activity for the notification center.
// ---------------------------------------------------------------------------

export function useRecentPartnerEvents(limit = 30): RoomEventRecord[] {
  const { events, myUserId } = useRoom();
  return useMemo(() => {
    const filtered = events.filter(
      (rec) => rec.senderId !== myUserId && !!sectionForEventType(rec.event.type),
    );
    // events are already sorted ascending; reverse to get newest first.
    const reversed = [...filtered].reverse();
    return reversed.slice(0, limit);
  }, [events, myUserId, limit]);
}
