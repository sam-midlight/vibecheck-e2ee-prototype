'use client';

/**
 * Reduced-motion helpers shared across Framer-heavy components. The
 * @media (prefers-reduced-motion: reduce) block in globals.css handles
 * pure-CSS animations; framer-motion ignores CSS animation-duration
 * overrides, so we need this JS-side escape hatch too.
 *
 * Usage:
 *   const reduced = useReducedMotionPref();
 *   <motion.div animate={reduced ? {} : fancyKeyframes} />
 *
 * If motion is reduced, callers should fall back to a static state or a
 * single gentle cycle. Don't strip visuals entirely — users who want
 * reduced motion still want the UI to read; they just want it still.
 */

import { useReducedMotion } from 'framer-motion';

/** True when the OS/browser requests reduced motion. Stable within a
 *  render, re-evaluated automatically on OS setting changes. */
export function useReducedMotionPref(): boolean {
  return useReducedMotion() ?? false;
}
