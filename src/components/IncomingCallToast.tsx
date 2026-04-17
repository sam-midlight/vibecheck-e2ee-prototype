'use client';

/**
 * Global incoming-call toast. Mounted once inside AppShell (when auth is
 * satisfied) and listens to realtime INSERT/UPDATE on `calls` for every
 * room this user is in. A new call in any room pops a dismissible toast
 * with a Join button; the toast auto-dismisses when the call ends or the
 * user navigates into the call page for that room.
 *
 * Realtime scoping: we subscribe without a room filter — Supabase realtime
 * honours the `calls_read` RLS SELECT policy, so only rooms this user is a
 * member of deliver rows. No manual membership filtering needed.
 */

import { useEffect, useMemo, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { subscribeAllCalls, type CallRow } from '@/lib/supabase/queries';

interface Props {
  userId: string;
}

interface PendingCall {
  callId: string;
  roomId: string;
  receivedAt: number;
}

// After this long we auto-dismiss even if the call is still alive on the
// server. Keeps the UI from pinning a stale notification when the user
// walked away. Tuned to match "a reasonable ring duration."
const AUTO_DISMISS_MS = 90_000;

export function IncomingCallToast({ userId }: Props) {
  const [pending, setPending] = useState<Map<string, PendingCall>>(new Map());
  // Per-session memory: calls the user explicitly dismissed shouldn't re-pop
  // if realtime re-delivers the INSERT (e.g. on reconnect after a transient
  // drop). Not persisted — a page reload is a fine reset.
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const pathname = usePathname();
  const router = useRouter();

  // If we're already on the call page for a given room, any pending toast
  // for that room should be suppressed. Extract the roomId from the path.
  const currentCallRoomId = useMemo(() => {
    if (!pathname) return null;
    const m = pathname.match(/^\/rooms\/([^/]+)\/call\b/);
    return m ? m[1] : null;
  }, [pathname]);

  useEffect(() => {
    const handle = (row: CallRow, event: 'INSERT' | 'UPDATE') => {
      if (event === 'INSERT') {
        // Skip our own calls — we started it, no notification needed.
        if (row.initiator_user_id === userId) return;
        // Defensive: INSERTs should always carry ended_at = null, but guard.
        if (row.ended_at) return;
        if (dismissed.has(row.id)) return;
        setPending((prev) => {
          if (prev.has(row.id)) return prev;
          const next = new Map(prev);
          next.set(row.id, {
            callId: row.id,
            roomId: row.room_id,
            receivedAt: Date.now(),
          });
          return next;
        });
      } else if (event === 'UPDATE') {
        // Call ended → drop any toast for it.
        if (row.ended_at) {
          setPending((prev) => {
            if (!prev.has(row.id)) return prev;
            const next = new Map(prev);
            next.delete(row.id);
            return next;
          });
        }
      }
    };
    const unsub = subscribeAllCalls(handle);
    return unsub;
  }, [userId, dismissed]);

  // Auto-dismiss sweep — runs while there's anything pending. Not useEffect
  // per-entry because adding/removing timers on map mutations is fiddly.
  useEffect(() => {
    if (pending.size === 0) return;
    const i = setInterval(() => {
      setPending((prev) => {
        let changed = false;
        const next = new Map(prev);
        const now = Date.now();
        for (const [id, p] of prev) {
          if (now - p.receivedAt > AUTO_DISMISS_MS) {
            next.delete(id);
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    }, 5_000);
    return () => clearInterval(i);
  }, [pending.size]);

  function dismiss(callId: string) {
    setDismissed((prev) => {
      const next = new Set(prev);
      next.add(callId);
      return next;
    });
    setPending((prev) => {
      if (!prev.has(callId)) return prev;
      const next = new Map(prev);
      next.delete(callId);
      return next;
    });
  }

  function join(callId: string, roomId: string) {
    dismiss(callId);
    router.push(`/rooms/${roomId}/call`);
  }

  // Visible entries: drop any pending toast whose room is the one we're
  // already on the call page for.
  const visible = Array.from(pending.values()).filter(
    (p) => p.roomId !== currentCallRoomId,
  );
  if (visible.length === 0) return null;

  return (
    <div className="pointer-events-none fixed right-4 top-4 z-50 flex flex-col gap-2">
      {visible.map((p) => (
        <div
          key={p.callId}
          className="pointer-events-auto w-80 rounded-lg border border-emerald-300 bg-white p-3 shadow-lg dark:border-emerald-700 dark:bg-neutral-900"
        >
          <div className="flex items-start justify-between gap-2">
            <div>
              <div className="text-sm font-semibold">Incoming call</div>
              <div className="text-xs text-neutral-500">
                room {p.roomId.slice(0, 8)}…
              </div>
            </div>
            <button
              onClick={() => dismiss(p.callId)}
              aria-label="dismiss"
              className="-mr-1 -mt-1 rounded px-2 py-1 text-xs text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
            >
              ✕
            </button>
          </div>
          <div className="mt-2 flex gap-2">
            <button
              onClick={() => join(p.callId, p.roomId)}
              className="rounded bg-emerald-700 px-3 py-1.5 text-xs text-white dark:bg-emerald-600"
            >
              Join
            </button>
            <button
              onClick={() => dismiss(p.callId)}
              className="rounded border border-neutral-300 px-3 py-1.5 text-xs dark:border-neutral-700"
            >
              Ignore
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
