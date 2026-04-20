'use client';

/**
 * OrbActionMenu — claymorphic action arc that fans above a member orb when
 * you long-press it. Three actions:
 *
 *   ⭐ Send a star    (gratitude_send 1♥, message "⭐")
 *   👀 View vibe       (opens MemberVibePopover sheet)
 *   🛡️ Safe space      (navigates to /rooms/{id}/safe-space?compose=1)
 *
 * Self-press collapses to just the View action — sending yourself a star or
 * opening Safe Space "to yourself" doesn't make sense.
 *
 * Anchored to its parent (each orb wraps this in a `relative` div), so the
 * pills lay out around the orb naturally.
 */

import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useRouter } from 'next/navigation';
import { describeError } from '@/lib/domain/errors';
import type { MemberMood } from '@/lib/domain/memberMood';
import { Dates } from './Dates';
import { FeatureSheet } from './FeatureSheet';
import { MemberVibePopover, type MemberVibeTarget } from './MemberVibePopover';
import { MindReader } from './MindReader';
import { TimeCapsules } from './TimeCapsules';
import { useRoom } from './RoomProvider';
import { Wishlist } from './Wishlist';
import { toast } from 'sonner';

interface Action {
  id: string;
  emoji: string;
  label: string;
  /** Hex hue for the coloured frosted-glass treatment. */
  hue: string;
  run: () => void | Promise<void>;
}

const RADIUS = 78;
const PILL = 52;

/** Convert #rrggbb → rgba(r,g,b,a). Mirrors VibeOrb's helper so the
 *  sun-orb planets and these member-orb action pills speak the same
 *  coloured-frosted-glass language. */
function hexToRgba(hex: string, alpha: number): string {
  const h = hex.startsWith('#') ? hex.slice(1) : hex;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function OrbActionMenu({
  member,
  onClose,
}: {
  member: MemberMood;
  onClose: () => void;
}) {
  const router = useRouter();
  const { appendEvent, room, myUserId } = useRoom();
  const [showVibe, setShowVibe] = useState(false);
  const [subSheet, setSubSheet] = useState<MemberVibeTarget | null>(null);
  const [busy, setBusy] = useState(false);
  const isSelf = member.uid === myUserId;

  async function sendHeart() {
    if (!room || busy) return;
    setBusy(true);
    try {
      // A one-tap ♥ — feeds the existing Gratitude tally (amount: 1, no
      // message needed). Recipient's heart balance goes up by one, surfaced
      // in the HeartsPill widget + Gratitude card. No separate tally system.
      await appendEvent({
        type: 'gratitude_send',
        to: member.uid,
        amount: 1,
        message: '',
        ts: Date.now(),
      });
      if ('vibrate' in navigator) {
        try { navigator.vibrate(12); } catch { /* noop */ }
      }
      toast.success(`♥ sent to ${member.name}`);
      onClose();
    } catch (e) {
      toast.error(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  function viewVibe() {
    setShowVibe(true);
  }

  function openSafeSpaceMessage() {
    if (!room) return;
    router.push(`/rooms/${room.id}/safe-space?compose=1`);
    onClose();
  }

  const actions: Action[] = isSelf
    ? [
        { id: 'view',  emoji: '👀', label: 'View',  hue: '#8A7FC9', run: viewVibe },
      ]
    : [
        { id: 'heart', emoji: '♥',  label: 'Heart', hue: '#FF8FA3', run: () => void sendHeart() },
        { id: 'view',  emoji: '👀', label: 'View',  hue: '#8A7FC9', run: viewVibe },
        { id: 'space', emoji: '🛡️', label: 'Safe',  hue: '#7FA8C9', run: openSafeSpaceMessage },
      ];

  // Spread evenly across the upper semicircle [135°, 45°]. With one action
  // we just plant it at 90° (directly above).
  function angleFor(i: number): number {
    if (actions.length === 1) return 90;
    return 135 - (i * 90) / (actions.length - 1);
  }

  return (
    <>
      {/* Backdrop catcher — close on tap-outside. */}
      <button
        type="button"
        aria-label="close action menu"
        onClick={onClose}
        className="fixed inset-0 z-30 cursor-default bg-neutral-950/15 backdrop-blur-[1px]"
      />

      {/* Pills, anchored at the centre of the parent orb. The pills sit on a
          radius above; each spring-animates outward from the orb. */}
      <div className="pointer-events-none absolute left-1/2 top-1/2 z-40 -translate-x-1/2 -translate-y-1/2">
        {actions.map((a, i) => {
          const theta = (angleFor(i) * Math.PI) / 180;
          const x = Math.cos(theta) * RADIUS;
          const y = -Math.sin(theta) * RADIUS;
          return (
            <motion.button
              key={a.id}
              type="button"
              onClick={() => void a.run()}
              disabled={busy && a.id === 'heart'}
              aria-label={a.label}
              className="pointer-events-auto absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center justify-center rounded-full disabled:opacity-60"
              style={{
                width: PILL,
                height: PILL,
                border: `1px solid ${hexToRgba(a.hue, 0.45)}`,
                background: `radial-gradient(circle at 32% 28%, ${hexToRgba('#FFFFFF', 0.45)} 0%, ${hexToRgba(a.hue, 0.55)} 50%, ${hexToRgba(a.hue, 0.45)} 100%)`,
                backdropFilter: 'blur(20px) saturate(1.5)',
                WebkitBackdropFilter: 'blur(20px) saturate(1.5)',
                boxShadow: `inset 0 1px 0 rgba(255,255,255,0.55), inset 0 -1px 0 rgba(0,0,0,0.06), 0 8px 22px -6px ${hexToRgba(a.hue, 0.6)}, 0 2px 5px rgba(31,26,22,0.12)`,
              }}
              initial={{ x: 0, y: 0, scale: 0, opacity: 0 }}
              animate={{ x, y, scale: 1, opacity: 1 }}
              exit={{ x: 0, y: 0, scale: 0, opacity: 0 }}
              whileHover={{ scale: 1.45 }}
              whileTap={{ scale: 1.55 }}
              transition={{
                type: 'spring',
                stiffness: 320,
                damping: 22,
                delay: i * 0.04,
              }}
            >
              <span className="text-lg leading-none" aria-hidden>
                {a.emoji}
              </span>
              <span
                className="mt-0.5"
                style={{
                  fontFamily: 'var(--font-mono), JetBrains Mono, monospace',
                  fontSize: 7.5,
                  letterSpacing: '0.06em',
                  textTransform: 'uppercase',
                  fontWeight: 500,
                  opacity: 0.95,
                }}
              >
                {a.label}
              </span>
            </motion.button>
          );
        })}
      </div>

      <AnimatePresence>
        {showVibe && (
          <FeatureSheet
            key={`vibe-${member.uid}`}
            title={`${member.name}'s vibe`}
            emoji={member.emoji || '✨'}
            onClose={() => {
              setShowVibe(false);
              onClose();
            }}
          >
            <MemberVibePopover
              uid={member.uid}
              onNavigate={(target) => {
                // Close the View sheet + orb menu, then open the feature
                // shortcut as a fresh sheet. Parent (MemberMoodOrbs) is out
                // of the loop — we own this chain so the back button story
                // stays simple.
                setShowVibe(false);
                setSubSheet(target);
              }}
            />
          </FeatureSheet>
        )}
        {subSheet && (
          <FeatureSheet
            key={`member-sub-${subSheet}-${member.uid}`}
            title={SUB_TITLES[subSheet]}
            emoji={SUB_EMOJIS[subSheet]}
            onClose={() => {
              setSubSheet(null);
              onClose();
            }}
          >
            <SubFeature target={subSheet} />
          </FeatureSheet>
        )}
      </AnimatePresence>
    </>
  );
}

// ---------------------------------------------------------------------------
// Sub-sheet routing
// ---------------------------------------------------------------------------

const SUB_TITLES: Record<MemberVibeTarget, string> = {
  wishlist:       'Wishlist',
  dates:          'Dates',
  mind_reader:    'Mind reader',
  time_capsules:  'Time capsules',
};

const SUB_EMOJIS: Record<MemberVibeTarget, string> = {
  wishlist:       '🎁',
  dates:          '💕',
  mind_reader:    '🔮',
  time_capsules:  '⏳',
};

function SubFeature({ target }: { target: MemberVibeTarget }) {
  switch (target) {
    case 'wishlist':      return <Wishlist />;
    case 'dates':         return <Dates />;
    case 'mind_reader':   return <MindReader />;
    case 'time_capsules': return <TimeCapsules />;
  }
}
