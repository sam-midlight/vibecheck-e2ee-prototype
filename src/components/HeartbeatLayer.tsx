'use client';

/**
 * HeartbeatLayer — ephemeral heartbeat broadcast between members in the
 * same room.
 *
 * Sender ticks a "pulse" message over a Supabase realtime broadcast
 * channel every ~1.6s addressed to a specific recipient. Recipient
 * receives those ticks and renders a soft pulsing border + a small
 * floating heart at the screen edge for 1.4s after each tick.
 *
 * Stops when the sender stops ticking (toggled off, navigated away,
 * disconnected). Nothing is persisted — heartbeats are alive-only,
 * matching the meatspace metaphor.
 *
 * Privacy: the broadcast carries `from`, `to`, `roomId` over the
 * realtime channel — metadata only, no content.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { getSupabase } from '@/lib/supabase/client';
import { useRoom } from './RoomProvider';

const TICK_MS = 1600;
const FADE_MS = 1400;

interface HeartbeatTick {
  id: string;
  ts: number;
}

interface HeartbeatContextValue {
  /** UID currently being pulsed by us, or null. */
  activeFor: string | null;
  start: (recipientUid: string) => void;
  stop: () => void;
  /** Latest received-tick from someone else (drives the pulse render). */
  incoming: HeartbeatTick | null;
}

const HeartbeatContext = createContext<HeartbeatContextValue | null>(null);

export function useHeartbeat(): HeartbeatContextValue {
  const ctx = useContext(HeartbeatContext);
  if (!ctx) throw new Error('useHeartbeat must be inside HeartbeatLayer');
  return ctx;
}

export function HeartbeatLayer({ children }: { children: React.ReactNode }) {
  const { room, myUserId } = useRoom();
  const [activeFor, setActiveFor] = useState<string | null>(null);
  const [incoming, setIncoming] = useState<HeartbeatTick | null>(null);
  const channelRef = useRef<ReturnType<ReturnType<typeof getSupabase>['channel']> | null>(null);
  const senderTickRef = useRef<number | null>(null);

  // Subscribe to the broadcast channel for this room. Listens for
  // 'heartbeat' events targeted at me; ignores everything else.
  useEffect(() => {
    if (!room || !myUserId) return;
    const supabase = getSupabase();
    const ch = supabase.channel(`room-heartbeat:${room.id}:${crypto.randomUUID()}`, {
      config: { broadcast: { self: false } },
    });
    ch.on('broadcast', { event: 'heartbeat' }, ({ payload }) => {
      if (!payload || typeof payload !== 'object') return;
      const { to, from } = payload as { to?: string; from?: string };
      if (to !== myUserId) return;
      if (!from) return;
      setIncoming({ id: crypto.randomUUID(), ts: Date.now() });
    });
    void ch.subscribe();
    channelRef.current = ch;
    return () => {
      channelRef.current = null;
      void supabase.removeChannel(ch);
    };
  }, [room, myUserId]);

  // When activeFor flips on, start ticking via the channel.
  useEffect(() => {
    if (!activeFor || !myUserId || !room) return;
    function tick() {
      const ch = channelRef.current;
      if (!ch) return;
      void ch.send({
        type: 'broadcast',
        event: 'heartbeat',
        payload: { from: myUserId, to: activeFor, roomId: room?.id },
      });
    }
    tick(); // immediate first beat
    senderTickRef.current = window.setInterval(tick, TICK_MS);
    return () => {
      if (senderTickRef.current != null) {
        window.clearInterval(senderTickRef.current);
        senderTickRef.current = null;
      }
    };
  }, [activeFor, myUserId, room]);

  // Auto-clear stale incoming after FADE_MS so the pulse fades cleanly.
  useEffect(() => {
    if (!incoming) return;
    const h = window.setTimeout(() => setIncoming(null), FADE_MS);
    return () => window.clearTimeout(h);
  }, [incoming]);

  const start = useCallback((uid: string) => setActiveFor(uid), []);
  const stop = useCallback(() => setActiveFor(null), []);

  return (
    <HeartbeatContext.Provider value={{ activeFor, start, stop, incoming }}>
      {children}
      <HeartbeatVisual incoming={incoming} />
    </HeartbeatContext.Provider>
  );
}

function HeartbeatVisual({ incoming }: { incoming: HeartbeatTick | null }) {
  return (
    <AnimatePresence>
      {incoming && (
        <motion.div
          key={incoming.id}
          aria-hidden
          className="pointer-events-none fixed inset-0 z-30"
          initial={{ opacity: 0 }}
          animate={{ opacity: [0, 1, 0] }}
          exit={{ opacity: 0 }}
          transition={{ duration: FADE_MS / 1000, times: [0, 0.2, 1], ease: 'easeOut' }}
        >
          {/* Edge vignette pulse */}
          <div
            className="absolute inset-0"
            style={{
              boxShadow:
                'inset 0 0 80px 6px rgba(244, 63, 94, 0.55), inset 0 0 220px 30px rgba(244, 63, 94, 0.15)',
            }}
          />
          {/* Small floating heart at corner */}
          <motion.span
            className="absolute right-6 top-6 text-3xl"
            initial={{ scale: 0.7, opacity: 0.4 }}
            animate={{ scale: [0.9, 1.25, 1], opacity: [0.6, 1, 0.4] }}
            transition={{ duration: FADE_MS / 1000, ease: 'easeOut' }}
            style={{ filter: 'drop-shadow(0 0 14px rgba(244,63,94,0.85))' }}
          >
            ♥
          </motion.span>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
