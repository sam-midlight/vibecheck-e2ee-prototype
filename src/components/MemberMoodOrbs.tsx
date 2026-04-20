'use client';

/**
 * User Orbs — a row of small claymorphic orbs, one per current-gen member,
 * sitting above the VibeOracleBanner. Hue tier comes from the shared
 * useMemberMoods() projection (see lib/domain/memberMood.ts), so the orb
 * colour, the popover header, and the SafeSpace ghost bubbles always
 * agree on what mood each member is in.
 *
 * Each orb subtly pulses (scale) and slow-cycles its hue. On hover it
 * grows large and wobbles — a deliberate "unbalanced" animation that
 * signals aliveness. A small green dot above the orb lights up when that
 * member is currently connected to the room's presence channel.
 *
 * Tap a partner orb → OrbActionMenu (star / view their vibe / safe
 * space message). Tapping your own orb → Love Tank shortcut.
 */

import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  tierLabel,
  tierStyle,
  useMemberMoods,
  type MemberMood,
} from '@/lib/domain/memberMood';
import { FeatureSheet } from './FeatureSheet';
import { LoveTank } from './LoveTank';
import { OrbActionMenu } from './OrbActionMenu';
import { useRoom } from './RoomProvider';

const ORB_PX = 40;

export function MemberMoodOrbs() {
  const moods = useMemberMoods();
  const { myUserId, onlineUserIds } = useRoom();
  const [activeUid, setActiveUid] = useState<string | null>(null);
  // Self-tap shortcut: tapping your own breathing mood orb opens Love Tank.
  // Tapping a partner orb pops their action planets immediately — Sam
  // wanted instant access without a hold gesture.
  const [tankOpen, setTankOpen] = useState(false);
  if (moods.length === 0) return null;

  return (
    <div className="flex items-center justify-center gap-5 py-4">
      {moods.map((m, i) => {
        const isMe = m.uid === myUserId;
        const isOnline = onlineUserIds.has(m.uid);
        return (
          // `relative` wrapper anchors the action menu's absolute pills to
          // the orb's centre AND the presence dot above it. Extra vertical
          // padding on the row (py-4) leaves room for the wobble + dot.
          <div key={m.uid} className="relative">
            <MoodOrb
              mood={m}
              indexOffset={i}
              onTap={isMe ? () => setTankOpen(true) : () => setActiveUid(m.uid)}
              isActive={m.uid === activeUid}
              isOnline={isOnline}
            />
            <AnimatePresence>
              {m.uid === activeUid && (
                <OrbActionMenu
                  member={m}
                  onClose={() => setActiveUid(null)}
                />
              )}
            </AnimatePresence>
          </div>
        );
      })}

      <AnimatePresence>
        {tankOpen && (
          <FeatureSheet
            key="love-tank-from-mood-orb"
            title="Love tank"
            emoji="💖"
            onClose={() => setTankOpen(false)}
          >
            <LoveTank />
          </FeatureSheet>
        )}
      </AnimatePresence>
    </div>
  );
}

function MoodOrb({
  mood,
  indexOffset,
  onTap,
  isActive,
  isOnline,
}: {
  mood: MemberMood;
  indexOffset: number;
  /** Tap handler — opens Love Tank for self, action planets for partners. */
  onTap: () => void;
  isActive: boolean;
  /** True when this member is currently present in the room's realtime
   *  presence channel — drives the green "in the room" dot. */
  isOnline: boolean;
}) {
  const style = tierStyle(mood.tier);
  const presencePart = isOnline ? ' · in the room' : '';
  const tooltip = mood.hasData
    ? `${mood.name} · ${tierLabel(mood.tier)} · ${Math.round(mood.score)}%${presencePart}`
    : `${mood.name} · no readings yet${presencePart}`;

  return (
    <>
      <motion.button
        type="button"
        title={tooltip}
        aria-label={tooltip}
        onClick={onTap}
        className="relative flex items-center justify-center rounded-full ring-1 ring-white/70 dark:ring-white/15"
        style={{
          width: ORB_PX,
          height: ORB_PX,
          background: style.gradient,
          boxShadow: style.glow,
        }}
        animate={{
          scale: isActive ? 1.18 : [1, 1.06, 1],
          filter: style.filterCycle,
        }}
        transition={{
          scale: isActive
            ? { type: 'spring', stiffness: 300, damping: 20 }
            : { duration: 3.4 + indexOffset * 0.3, repeat: Infinity, ease: 'easeInOut' },
          filter: { duration: 9 + indexOffset * 0.7, repeat: Infinity, ease: 'easeInOut' },
        }}
        // Hover: grow large + wobble around "unbalanced" in space. The
        // keyframe arrays on x/y/rotate compose into a soft figure-eight
        // drift so it feels alive rather than strictly orbital. Per-state
        // transition nested in whileHover lets the wobble loop forever
        // while the pointer hovers.
        whileHover={{
          scale: 1.45,
          x: [0, 6, -5, 4, -6, 2, 0],
          y: [0, -4, 5, -3, 2, -5, 0],
          rotate: [0, 7, -6, 4, -8, 3, 0],
          transition: {
            scale:   { type: 'spring', stiffness: 260, damping: 18 },
            x:       { duration: 2.2, repeat: Infinity, ease: 'easeInOut' },
            y:       { duration: 2.6, repeat: Infinity, ease: 'easeInOut' },
            rotate:  { duration: 2.4, repeat: Infinity, ease: 'easeInOut' },
          },
        }}
        whileTap={{ scale: 1.4 }}
      >
        <span
          aria-hidden
          className="pointer-events-none absolute inset-1 rounded-full opacity-70"
          style={{
            background:
              'radial-gradient(circle at 35% 28%, rgba(255,255,255,0.85), rgba(255,255,255,0) 60%)',
          }}
        />
        <span className="relative text-base leading-none" aria-hidden>
          {mood.emoji || initial(mood.name)}
        </span>
      </motion.button>

      {/* Presence dot — above the orb, breathing green when the member is
          in the room right now. Sits outside the motion.button so the
          hover wobble doesn't drag it around. */}
      <AnimatePresence>
        {isOnline && (
          <motion.span
            aria-label={`${mood.name} is in the room`}
            title={`${mood.name} is in the room`}
            className="pointer-events-none absolute left-1/2 -top-2 h-2.5 w-2.5 -translate-x-1/2 rounded-full bg-emerald-400 ring-2 ring-white/90 dark:ring-neutral-950/80"
            initial={{ opacity: 0, scale: 0.6, y: 2 }}
            animate={{
              opacity: 1,
              scale: [1, 1.25, 1],
              y: 0,
              boxShadow: [
                '0 0 0 0 rgba(52, 211, 153, 0.55)',
                '0 0 0 6px rgba(52, 211, 153, 0)',
                '0 0 0 0 rgba(52, 211, 153, 0)',
              ],
            }}
            exit={{ opacity: 0, scale: 0.5 }}
            transition={{
              opacity:   { duration: 0.25 },
              scale:     { duration: 2.2, repeat: Infinity, ease: 'easeInOut' },
              boxShadow: { duration: 2.2, repeat: Infinity, ease: 'easeInOut' },
            }}
          />
        )}
      </AnimatePresence>
    </>
  );
}

function initial(name: string): string {
  return name.trim().slice(0, 1).toUpperCase() || '·';
}
