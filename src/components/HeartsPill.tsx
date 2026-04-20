'use client';

/**
 * HeartsPill — a small clickable pill showing your current ♥ balance.
 * Tapping it opens the Gratitude feature in a FeatureSheet popover so the
 * full send-form + feed are reachable from the at-a-glance widget area.
 *
 * Balance source: useHeartBalances() (gratitude received + bribes received
 * − bribes sent). Same source the inline Gratitude card uses, so the count
 * here always matches.
 */

import { useState } from 'react';
import { AnimatePresence } from 'framer-motion';
import { FeatureSheet } from './FeatureSheet';
import { Gratitude } from './Gratitude';
import { HelpIcon } from './HelpIcon';
import { useMyHeartBalance } from '@/lib/domain/hearts';

export function HeartsPill() {
  const [open, setOpen] = useState(false);
  const balance = useMyHeartBalance();

  return (
    <>
      <div className="flex w-full items-center gap-2">
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label={`open gratitude — ${balance} hearts`}
          className="group flex flex-1 items-center justify-between gap-2 rounded-full border border-rose-200/70 bg-gradient-to-br from-rose-50/90 to-pink-50/80 px-4 py-2 text-sm shadow-sm backdrop-blur-md transition-all hover:scale-[1.03] hover:shadow-md active:scale-[1.05] dark:border-rose-800/40 dark:from-rose-950/50 dark:to-pink-950/40"
        >
          <span className="flex items-center gap-2">
            <span className="text-lg leading-none transition-transform group-hover:scale-110" aria-hidden>
              ♥
            </span>
            <span className="font-display italic text-sm text-rose-900/85 dark:text-rose-200/85">
              Gratitude
            </span>
          </span>
          <span className="rounded-full bg-rose-900 px-2 py-0.5 text-xs font-semibold tabular-nums text-white shadow-sm dark:bg-rose-200 dark:text-rose-950">
            {balance}
          </span>
        </button>
        <HelpIcon
          label="Gratitude"
          text="Send 1–5 hearts with a short note to a partner. Append-only — no edits, no deletes. Received hearts add to your balance; spend them to boost a date idea or reveal a Mind Reader thought. Tap the pill to send or read the feed."
        />
      </div>

      <AnimatePresence>
        {open && (
          <FeatureSheet
            key="gratitude-sheet"
            title="Gratitude"
            emoji="🙏"
            onClose={() => setOpen(false)}
          >
            <Gratitude />
          </FeatureSheet>
        )}
      </AnimatePresence>
    </>
  );
}
