'use client';

/**
 * ConfettiBurst — motion-based emoji particle burst. Drop one absolutely
 * positioned inside any container. Re-keying it (caller bumps `burstId` or
 * uses `<AnimatePresence>` with a unique key) restarts the animation.
 *
 * Deterministic per-particle angle/distance/duration from the index, so the
 * cloud looks consistent and we don't pay for runtime randomness.
 */

import { motion } from 'framer-motion';

const COUNT = 16;

export function ConfettiBurst({
  emoji,
  /** Pixel size of each particle. */
  size = 18,
  /** How far the outer particles travel, in px. */
  spread = 90,
  /** Total animation duration in seconds. */
  duration = 1.4,
}: {
  emoji: string;
  size?: number;
  spread?: number;
  duration?: number;
}) {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"
      style={{ width: 0, height: 0 }}
    >
      {Array.from({ length: COUNT }).map((_, i) => {
        // Spread particles around a full 360° arc, biased upward by 25° so
        // the bulk drifts up + out (gravity-feeling without real physics).
        const angle = (i / COUNT) * Math.PI * 2 + 0.18 + (i % 3) * 0.07;
        const distance = spread * (0.55 + ((i * 13) % 100) / 220);
        const x = Math.cos(angle) * distance;
        const y = Math.sin(angle) * distance - spread * 0.35;
        const rotate = ((i * 47) % 360) - 180;
        const localDuration = duration * (0.85 + ((i * 7) % 30) / 100);
        return (
          <motion.span
            key={i}
            className="absolute left-0 top-0 leading-none"
            style={{
              fontSize: size,
              marginLeft: -size / 2,
              marginTop: -size / 2,
            }}
            initial={{ x: 0, y: 0, opacity: 0, scale: 0.4, rotate: 0 }}
            animate={{
              x,
              y,
              opacity: [0, 1, 1, 0],
              scale: [0.4, 1.1, 1, 0.7],
              rotate,
            }}
            transition={{
              duration: localDuration,
              ease: [0.2, 0.7, 0.3, 1],
              times: [0, 0.18, 0.65, 1],
            }}
          >
            {emoji}
          </motion.span>
        );
      })}
    </div>
  );
}
