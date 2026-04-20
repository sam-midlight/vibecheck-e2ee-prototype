'use client';

/**
 * SafeSpaceLantern — small glowing lantern in the corner of the Safe Space
 * page. Tap it and the active vibe-line (from useVibeLines, same source as
 * the home oracle banner) materialises as an italicised whisper at the top
 * of the page, then fades on its own. The lantern itself breathes a quiet
 * amber glow regardless.
 *
 * Behaviour:
 *   - Tap → whisper appears (matched hue), auto-fades after WHISPER_MS.
 *   - Tap again while visible → cycles to the next line.
 *   - No lines available → shows a tender fallback whisper.
 */

import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useVibeLines, type VibeLine } from '@/lib/domain/vibeLines';

const WHISPER_MS = 6000;

const FALLBACK: VibeLine = {
  id: 'fallback',
  text: 'You\u2019re both here. That\u2019s enough for now.',
  emoji: '✨',
  hue: 275,
  intensity: 'mid',
  // Fallback isn't tied to a real subject or feature — the lantern only
  // ever uses the line for display, never routes from it.
  subjectUid: '',
  target: { kind: 'love_tank' },
};

export function SafeSpaceLantern() {
  const lines = useVibeLines();
  const [visibleIdx, setVisibleIdx] = useState(0);
  const [showing, setShowing] = useState(false);

  // Auto-hide the whisper after WHISPER_MS.
  useEffect(() => {
    if (!showing) return;
    const h = window.setTimeout(() => setShowing(false), WHISPER_MS);
    return () => window.clearTimeout(h);
  }, [showing, visibleIdx]);

  function summon() {
    if (showing) {
      setVisibleIdx((i) => i + 1);
    } else {
      setShowing(true);
    }
  }

  const safeIdx = lines.length > 0 ? visibleIdx % lines.length : 0;
  const active = lines[safeIdx] ?? FALLBACK;

  return (
    <>
      {/* Whisper — italicized line at the top of the page, hue-matched */}
      <AnimatePresence mode="wait">
        {showing && (
          <motion.div
            key={`whisper-${active.id}-${visibleIdx}`}
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.7, ease: 'easeOut' }}
            className="pointer-events-none absolute left-1/2 top-3 z-30 -translate-x-1/2 px-4"
            aria-live="polite"
          >
            <p
              className="text-center text-sm italic sm:text-base"
              style={{
                color: `hsl(${active.hue}, 70%, 82%)`,
                textShadow: `0 0 18px hsla(${active.hue}, 80%, 60%, 0.5)`,
              }}
            >
              <span aria-hidden className="mr-1 not-italic">{active.emoji}</span>
              {active.text}
            </p>
          </motion.div>
        )}
      </AnimatePresence>

      {/* The lantern itself — corner-pinned, breathing amber glow */}
      <motion.button
        type="button"
        onClick={summon}
        aria-label="whisper a vibe"
        className="absolute right-3 top-3 z-30 flex h-11 w-11 items-center justify-center rounded-full ring-1 ring-amber-200/40"
        style={{
          background:
            'radial-gradient(circle at 35% 25%, hsla(45, 95%, 88%, 0.95), hsla(35, 80%, 56%, 1) 70%)',
        }}
        animate={{
          scale: [1, 1.05, 1],
          boxShadow: [
            '0 0 14px 1px hsla(40, 90%, 60%, 0.45)',
            '0 0 28px 3px hsla(40, 95%, 65%, 0.7)',
            '0 0 14px 1px hsla(40, 90%, 60%, 0.45)',
          ],
        }}
        transition={{
          scale:    { duration: 4, repeat: Infinity, ease: 'easeInOut' },
          boxShadow:{ duration: 4, repeat: Infinity, ease: 'easeInOut' },
        }}
        whileHover={{ scale: 1.1 }}
        whileTap={{ scale: 1.18 }}
      >
        <span
          aria-hidden
          className="pointer-events-none absolute inset-1.5 rounded-full opacity-70"
          style={{
            background:
              'radial-gradient(circle at 35% 28%, rgba(255,255,255,0.85), rgba(255,255,255,0) 60%)',
          }}
        />
        <span className="relative text-xl leading-none" aria-hidden>
          🏮
        </span>
      </motion.button>
    </>
  );
}
