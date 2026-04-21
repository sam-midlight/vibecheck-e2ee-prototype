'use client';

/**
 * Bell icon + glass dropdown listing recent partner activity.
 *
 * Counts badge = number of sections currently flagged unread (not raw
 * event count — one nudge per section is enough). Clicking an entry
 * routes to the matching feature (via `?open=<feature>` on the room
 * page, or the dedicated sub-route for safe_space) and marks that
 * section read. A "mark all as read" action clears every section's
 * red dot.
 */

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { describeEventForToast } from '@/lib/domain/notifications';
import { displayName } from '@/lib/domain/displayName';
import {
  sectionForEventType,
  useRecentPartnerEvents,
  useUnreadBySection,
  type SectionId,
} from '@/lib/domain/unread';
import { useRoom } from './RoomProvider';

function hrefForSection(section: SectionId, roomId: string): string {
  switch (section) {
    case 'safe_space':
      return `/rooms/${roomId}/safe-space`;
    case 'messages':
      return `/rooms/${roomId}`;
    default:
      return `/rooms/${roomId}?open=${section}`;
  }
}

export function NotificationCenter() {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const { unread, markViewed, markAllViewed, lastViewed } = useUnreadBySection();
  const recent = useRecentPartnerEvents(30);
  const { displayNames, myUserId, room } = useRoom();
  const router = useRouter();

  useEffect(() => {
    if (!open) return;
    function onPointer(e: PointerEvent) {
      const el = containerRef.current;
      if (el && !el.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const unreadCount = Object.values(unread).filter(Boolean).length;

  function jumpTo(section: SectionId) {
    markViewed(section);
    setOpen(false);
    if (!room) return;
    router.push(hrefForSection(section, room.id));
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="notifications"
        aria-expanded={open}
        className="relative flex h-9 w-9 items-center justify-center rounded-full border border-white/50 bg-white/60 text-neutral-700 shadow-sm backdrop-blur-md transition-all hover:bg-white/80 hover:shadow-md active:scale-[0.96] dark:border-white/10 dark:bg-neutral-900/60 dark:text-neutral-300"
      >
        <span aria-hidden>🔔</span>
        {unreadCount > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-rose-500 px-1 text-[10px] font-semibold leading-none text-white shadow-sm">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute left-0 right-auto top-full z-40 mt-2 w-80 max-w-[calc(100vw-1rem)] rounded-2xl border border-white/60 bg-white/80 p-3 shadow-xl backdrop-blur-md sm:left-auto sm:right-0 dark:border-white/10 dark:bg-neutral-900/80">
          <div className="flex items-center justify-between">
            <h3 className="text-[10px] uppercase tracking-[0.2em] text-neutral-500">
              Activity
            </h3>
            {unreadCount > 0 && (
              <button
                type="button"
                onClick={() => markAllViewed()}
                className="rounded-full px-2 py-0.5 text-[10px] text-neutral-500 hover:bg-white/60 hover:text-neutral-900 dark:hover:bg-white/10 dark:hover:text-neutral-100"
              >
                mark all read
              </button>
            )}
          </div>

          {recent.length === 0 ? (
            <p className="mt-3 text-xs text-neutral-500">
              Nothing from your partner yet. Quiet for now ☁️
            </p>
          ) : (
            <ul className="mt-2 max-h-96 space-y-1 overflow-y-auto pr-1">
              {recent.map((rec) => {
                const section = sectionForEventType(rec.event.type);
                const partnerName = displayName(
                  rec.senderId,
                  displayNames,
                  myUserId,
                  null,
                );
                const desc = describeEventForToast(
                  rec.event,
                  partnerName,
                  myUserId ?? '',
                );
                if (!desc) return null;
                const evTs = new Date(rec.createdAt).getTime();
                const sectionViewedTs = section
                  ? (lastViewed[section] ?? 0)
                  : 0;
                const isUnread = evTs > sectionViewedTs;
                return (
                  <li key={rec.id}>
                    <button
                      type="button"
                      onClick={() => section && jumpTo(section)}
                      className={`flex w-full items-start gap-2 rounded-lg p-2 text-left transition-colors hover:bg-white/70 dark:hover:bg-white/5 ${
                        isUnread ? 'bg-white/50 dark:bg-white/[0.04]' : ''
                      }`}
                    >
                      <span aria-hidden className="mt-0.5 text-base leading-none">
                        {desc.emoji}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="text-xs text-neutral-800 dark:text-neutral-200">
                          {desc.text}
                        </p>
                        <p className="mt-0.5 text-[10px] text-neutral-500">
                          {formatTimeAgo(evTs)}
                        </p>
                      </div>
                      {isUnread && (
                        <span
                          aria-label="unread"
                          className="mt-1 inline-flex h-1.5 w-1.5 flex-shrink-0 rounded-full bg-rose-500"
                        />
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function formatTimeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const s = Math.round(diff / 1000);
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(ts).toLocaleDateString();
}
