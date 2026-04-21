'use client';

/**
 * AffectionLayer — full-screen overlay that renders every active affection
 * (kiss / hug / high-five) at its sender-chosen viewport coordinates.
 *
 *   - Persistent: backed by the encrypted event ledger so a refresh
 *     restores them.
 *   - Sender can retract by tapping their own gesture.
 *   - Receiver can "receive" by tapping the gesture; goes to their bank.
 *
 * Mounted once in the room layout (RoomProvider children). The widget
 * UI for sending lives separately in AffectionWidget.
 */

import { useEffect, useMemo, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import type { AffectionKind } from '@/lib/domain/events';
import { useRoom, useRoomProjection } from './RoomProvider';

interface ActiveAffection {
  affectionId: string;
  senderId: string;
  to: string;
  kind: AffectionKind;
  x: number;
  y: number;
  ts: number;
}

const KIND_EMOJI: Record<AffectionKind, string> = {
  kiss: '💋',
  hug: '🤗',
  high_five: '🙌',
};

export function AffectionLayer() {
  const { myUserId, appendEvent } = useRoom();
  const active = useRoomProjection<Record<string, ActiveAffection>>(
    (acc, rec) => {
      const ev = rec.event;
      if (ev.type === 'affection_send') {
        return {
          ...acc,
          [ev.affectionId]: {
            affectionId: ev.affectionId,
            senderId: rec.senderId,
            to: ev.to,
            kind: ev.kind,
            x: ev.x,
            y: ev.y,
            ts: ev.ts,
          },
        };
      }
      if (ev.type === 'affection_receive' || ev.type === 'affection_retract') {
        if (!acc[ev.affectionId]) return acc;
        const next = { ...acc };
        delete next[ev.affectionId];
        return next;
      }
      return acc;
    },
    {} as Record<string, ActiveAffection>,
    [],
  );

  const list = useMemo(() => Object.values(active), [active]);
  if (!myUserId || list.length === 0) return null;

  return (
    <div
      aria-hidden={false}
      className="pointer-events-none fixed inset-0 z-40"
    >
      <AnimatePresence>
        {list.map((a) => (
          <AffectionMark
            key={a.affectionId}
            affection={a}
            myUserId={myUserId}
            onTap={async () => {
              const isReceiver = a.to === myUserId;
              const isSender = a.senderId === myUserId;
              if (!isReceiver && !isSender) return;
              await appendEvent({
                type: isReceiver ? 'affection_receive' : 'affection_retract',
                affectionId: a.affectionId,
                ts: Date.now(),
              });
            }}
          />
        ))}
      </AnimatePresence>
    </div>
  );
}

function AffectionMark({
  affection,
  myUserId,
  onTap,
}: {
  affection: ActiveAffection;
  myUserId: string;
  onTap: () => void;
}) {
  const isReceiver = affection.to === myUserId;
  const isSender = affection.senderId === myUserId;
  const interactive = isReceiver || isSender;
  const ariaLabel = isReceiver
    ? `tap to receive a ${affection.kind.replace('_', ' ')}`
    : isSender
      ? `tap to retract your ${affection.kind.replace('_', ' ')}`
      : `${affection.kind.replace('_', ' ')} between others`;

  // Stop the parent's pointer-events:none so the emoji itself is tappable.
  return (
    <motion.button
      type="button"
      onClick={interactive ? onTap : undefined}
      aria-label={ariaLabel}
      title={ariaLabel}
      className={`absolute select-none ${interactive ? 'pointer-events-auto cursor-pointer' : ''}`}
      style={{
        left: `${affection.x * 100}%`,
        top: `${affection.y * 100}%`,
        transform: 'translate(-50%, -50%)',
        fontSize: 44,
        lineHeight: 1,
        filter: `drop-shadow(0 6px 14px rgba(0,0,0,0.35))${
          isSender && !isReceiver ? ' opacity(0.7)' : ''
        }`,
      }}
      initial={{ scale: 0, opacity: 0 }}
      animate={{
        scale: 1,
        opacity: isSender && !isReceiver ? 0.7 : 1,
        rotate: [0, -6, 6, 0],
      }}
      exit={{ scale: 0.4, opacity: 0, y: -20 }}
      transition={{
        scale:   { type: 'spring', stiffness: 240, damping: 14 },
        rotate:  { duration: 2.4, repeat: Infinity, ease: 'easeInOut' },
        opacity: { duration: 0.4 },
      }}
    >
      <span aria-hidden>{KIND_EMOJI[affection.kind]}</span>
    </motion.button>
  );
}

// ---------------------------------------------------------------------------
// Send-mode overlay — when a user taps "Send a kiss" in the widget, this
// catches their next click and emits the affection_send event with the
// click position. Active until they click or hit Escape.
// ---------------------------------------------------------------------------

export function AffectionSendOverlay({
  recipient,
  kind,
  onPlaced,
  onCancel,
}: {
  recipient: string;
  kind: AffectionKind;
  onPlaced: () => void;
  onCancel: () => void;
}) {
  const { appendEvent } = useRoom();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onCancel();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  async function place(e: React.MouseEvent) {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return;
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    try {
      await appendEvent({
        type: 'affection_send',
        affectionId: crypto.randomUUID(),
        to: recipient,
        kind,
        x: Math.max(0, Math.min(1, x)),
        y: Math.max(0, Math.min(1, y)),
        ts: Date.now(),
      });
      onPlaced();
    } catch {
      onCancel();
    }
  }

  return (
    <div
      ref={ref}
      onClick={(e) => void place(e)}
      className="fixed inset-0 z-50 cursor-crosshair bg-black/30 backdrop-blur-[2px]"
      style={{ touchAction: 'manipulation' }}
    >
      <div className="pointer-events-none absolute inset-x-0 top-12 flex justify-center px-6">
        <div className="rounded-full border border-white/60 bg-white/90 px-5 py-2 text-sm font-display italic text-neutral-900 shadow-lg backdrop-blur-md dark:border-white/10 dark:bg-neutral-900/90 dark:text-neutral-50">
          {KIND_EMOJI[kind]} tap anywhere to leave a{' '}
          {kind === 'high_five' ? 'high five' : kind} — esc to cancel
        </div>
      </div>
    </div>
  );
}

export { KIND_EMOJI };
