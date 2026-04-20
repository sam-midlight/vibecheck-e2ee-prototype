'use client';

/**
 * VibeOracleHistory — the rolling-six-readings list shown when you tap the
 * Vibe Oracle banner. Each row is a button: clicking it tells the parent
 * which line was selected so it can route to the matching feature sheet
 * (slider with highlight, love tank, etc).
 *
 * "Live feed" — new vibe lines appear at the top as members cross
 * thresholds; older entries roll off after 6.
 */

import { motion } from 'framer-motion';
import type { VibeLine } from '@/lib/domain/vibeLines';

export function VibeOracleHistory({
  history,
  onSelect,
}: {
  history: VibeLine[];
  onSelect: (line: VibeLine) => void;
}) {
  if (history.length === 0) {
    return (
      <div className="px-2 py-6 text-center">
        <p className="text-sm leading-relaxed text-neutral-600 dark:text-neutral-300">
          ✨ Nothing strong on the radar yet. As soon as someone&apos;s vibe
          shifts, it&apos;ll show up here.
        </p>
      </div>
    );
  }

  return (
    <div className="px-1 pb-2">
      <p className="px-3 pt-1 text-[11px] font-medium uppercase tracking-[0.1em] text-neutral-500">
        Recent readings · live
      </p>
      <ul className="mt-2 space-y-2">
        {history.map((line, idx) => (
          <li key={line.id}>
            <motion.button
              type="button"
              onClick={() => onSelect(line)}
              className="group flex w-full items-center gap-3 rounded-2xl border border-white/60 bg-white/70 p-3 text-left shadow-sm backdrop-blur-md transition-all dark:border-white/10 dark:bg-neutral-900/60"
              style={{
                borderLeft: `3px solid hsl(${line.hue}, 75%, 60%)`,
              }}
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 1.01 }}
              initial={{ opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.35, ease: 'easeOut', delay: idx * 0.04 }}
            >
              <span
                aria-hidden
                className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full text-lg"
                style={{
                  background: `radial-gradient(circle at 30% 25%, hsla(${line.hue}, 95%, 92%, 0.95), hsla(${line.hue}, 75%, 68%, 1) 70%)`,
                  boxShadow: `0 0 12px hsla(${line.hue}, 80%, 65%, 0.45)`,
                }}
              >
                {line.emoji}
              </span>
              <div className="min-w-0 flex-1">
                <p className="font-display italic text-base leading-snug text-neutral-900 dark:text-neutral-50">
                  {line.text}
                </p>
                <p className="mt-0.5 text-[11px] uppercase tracking-wide text-neutral-500">
                  {line.target.kind === 'slider'
                    ? `tap → ${line.target.title} slider`
                    : 'tap → love tank'}
                </p>
              </div>
              <span
                aria-hidden
                className="text-neutral-400 transition-transform group-hover:translate-x-0.5"
              >
                →
              </span>
            </motion.button>
          </li>
        ))}
      </ul>
    </div>
  );
}
