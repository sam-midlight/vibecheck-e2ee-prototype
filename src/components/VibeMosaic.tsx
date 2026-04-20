'use client';

/**
 * VibeMosaic — slow-drifting "lava lamp" background. Six large soft-edge
 * blobs float across the viewport behind the room content; their colours,
 * intensity, AND speed are derived from the room's average mood:
 *
 *   Low avg score  → dull, dark, sleepy palette; slowest drift
 *   High avg score → saturated, bright, vibrant palette; slightly faster
 *
 * Sits fixed behind everything (pointer-events-none) so the existing
 * aurora-mesh body background still bleeds through; the mosaic just adds
 * a moving hue cast. Blurred 80px so neighbouring blobs melt into each
 * other instead of looking like flat circles.
 *
 * Pure presentation — reads useMemberMoods, writes nothing.
 */

import { useMemo } from 'react';
import { motion } from 'framer-motion';
import { hueForTier, tierFromScore, useMemberMoods } from '@/lib/domain/memberMood';
import { useReducedMotionPref } from '@/lib/motionPrefs';

interface BlobSpec {
  seed: number;
  size: number;        // vmax
  startX: number;      // vw
  startY: number;      // vh
  driftX: number;      // px
  driftY: number;      // px
  duration: number;    // s — base; scaled by mood speed factor
  hueOffset: number;   // degrees added to baseHue
  /** Base alpha — multiplied by the mood-driven alpha scale at runtime. */
  alpha: number;
}

const BLOBS: BlobSpec[] = [
  { seed: 0, size: 55, startX: 12, startY: 14, driftX:  90, driftY:  60, duration: 26, hueOffset:   0, alpha: 0.32 },
  { seed: 1, size: 64, startX: 70, startY: 58, driftX: -110, driftY:  70, duration: 33, hueOffset:  35, alpha: 0.30 },
  { seed: 2, size: 48, startX: 38, startY: 78, driftX:  80, driftY: -60, duration: 29, hueOffset: -28, alpha: 0.28 },
  { seed: 3, size: 60, startX: 84, startY: 12, driftX: -70, driftY: 110, duration: 35, hueOffset:  65, alpha: 0.30 },
  { seed: 4, size: 52, startX:  8, startY: 70, driftX: 120, driftY: -50, duration: 30, hueOffset: -55, alpha: 0.28 },
  { seed: 5, size: 46, startX: 56, startY: 30, driftX: -80, driftY:  90, duration: 38, hueOffset: 110, alpha: 0.22 },
];

export function VibeMosaic() {
  const moods = useMemberMoods();
  const reduced = useReducedMotionPref();

  // Continuous mood-driven palette + motion params. All four scale linearly
  // with normalized avg score so dragging a slider visibly tunes the room.
  const { baseHue, saturation, lightness, alphaScale, speedScale } = useMemo(() => {
    const withData = moods.filter((m) => m.hasData);
    const hasData = withData.length > 0;
    const avgScore = hasData
      ? withData.reduce((s, m) => s + m.score, 0) / withData.length
      : 50;
    const baseHue = hasData
      ? hueForTier(tierFromScore(avgScore, true))
      : 275; // neutral lavender when no readings yet
    // No-data state sits at ~50 so the palette is muted/calm rather than
    // either extreme — avoids implying drained vs lifted with zero signal.
    const norm = (hasData ? avgScore : 50) / 100;
    return {
      baseHue,
      saturation: 35 + norm * 60,    // 35% (dull)   → 95% (vivid)
      lightness:  46 + norm * 28,    // 46% (dark)   → 74% (bright)
      alphaScale: 0.55 + norm * 0.95, // 0.55× alpha → 1.5× alpha
      speedScale: 1.45 - norm * 0.65, // 1.45× slower → 0.8× duration (faster)
    };
  }, [moods]);

  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-0 -z-10 overflow-hidden"
      style={{ filter: 'blur(80px)' }}
    >
      {BLOBS.map((b) => {
        const hue = (baseHue + b.hueOffset + 360) % 360;
        const innerAlpha = b.alpha * alphaScale;
        const outerAlpha = innerAlpha * 0.6;
        const duration = b.duration * speedScale;
        return (
          <motion.div
            key={b.seed}
            className="absolute rounded-full"
            style={{
              width: `${b.size}vmax`,
              height: `${b.size}vmax`,
              left: `${b.startX}vw`,
              top: `${b.startY}vh`,
              translateX: '-50%',
              translateY: '-50%',
              background: `radial-gradient(circle at 35% 35%, hsla(${hue}, ${saturation}%, ${lightness}%, ${innerAlpha}) 0%, hsla(${hue}, ${Math.max(0, saturation - 10)}%, ${Math.max(0, lightness - 12)}%, ${outerAlpha}) 45%, transparent 75%)`,
              willChange: 'transform',
            }}
            // Reduced-motion: pin the blob at its start position so the
            // colour cast stays but nothing moves. Users still get the
            // mood-coloured ambience without the lava-lamp swimming.
            animate={
              reduced
                ? { x: 0, y: 0, scale: 1 }
                : {
                    x: [0, b.driftX, 0, -b.driftX * 0.5, 0],
                    y: [0, b.driftY, b.driftY * 0.4, -b.driftY * 0.3, 0],
                    scale: [1, 1.08, 0.95, 1.05, 1],
                  }
            }
            transition={
              reduced
                ? { duration: 0 }
                : { duration, repeat: Infinity, ease: 'easeInOut' }
            }
          />
        );
      })}
    </div>
  );
}
