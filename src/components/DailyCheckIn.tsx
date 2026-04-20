'use client';

/**
 * DailyCheckIn — a single, soft invitation that sits on the home page at
 * the top of the main column once per day. Dismisses in two ways:
 *   1. You move any slider / love-tank / send a heart today → auto-dismiss
 *   2. You tap "not today" → store today's date in localStorage, skip until tomorrow
 *
 * Never guilts; the empty-state copy makes "not today" an equal choice.
 * Completely local — no events written for dismissal.
 */

import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useReducedMotionPref } from '@/lib/motionPrefs';
import { FeatureSheet } from './FeatureSheet';
import { LoveTank } from './LoveTank';
import { useRoom } from './RoomProvider';
import { VibeSliders } from './VibeSliders';

const KEY_PREFIX = 'vibecheck-2:daily-check-in-skipped:';

function todayKey(userId: string): string {
  const d = new Date();
  const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return `${KEY_PREFIX}${userId}:${iso}`;
}

// Prompts rotate over the week so it doesn't feel robotic. Deterministic
// by day-of-year so both partners see the same prompt on the same day.
const PROMPTS: { emoji: string; headline: string; body: string }[] = [
  { emoji: '🌅', headline: 'Morning, gentle one.', body: 'Take a second — how\u2019s your body feeling today? A quick slider move is enough.' },
  { emoji: '☕', headline: 'How are you really?', body: 'Not the "fine" answer. What would a true one-word check-in sound like right now?' },
  { emoji: '🌿', headline: 'A tiny pulse.', body: 'Move one slider to roughly where you are. Your partner will notice.' },
  { emoji: '💭', headline: 'What moved you today?', body: 'Big or small — a text, a walk, a song. Send a gratitude even a single heart big.' },
  { emoji: '🫧', headline: 'Share one thing.', body: 'No performance required. One word on how you\u2019re doing lands softly.' },
  { emoji: '🌙', headline: 'Before the day closes.', body: 'Where did you land? A single slider tells a richer story than you\u2019d think.' },
  { emoji: '✨', headline: 'Marking you here.', body: 'A tiny hello from your body to theirs. Drag one slider a few pixels and you\u2019re done.' },
];

function promptForToday(): (typeof PROMPTS)[number] {
  const d = new Date();
  const start = new Date(d.getFullYear(), 0, 0);
  const dayOfYear = Math.floor((d.getTime() - start.getTime()) / 86400000);
  return PROMPTS[dayOfYear % PROMPTS.length];
}

function isSameLocalDay(ts: number): boolean {
  const now = new Date();
  const then = new Date(ts);
  return (
    now.getFullYear() === then.getFullYear() &&
    now.getMonth() === then.getMonth() &&
    now.getDate() === then.getDate()
  );
}

export function DailyCheckIn() {
  const { events, myUserId } = useRoom();
  const reduced = useReducedMotionPref();
  const [skipped, setSkipped] = useState(false);
  const [openSheet, setOpenSheet] = useState<'sliders' | 'love_tank' | null>(null);

  // Rehydrate dismissed-today flag on mount / user change.
  useEffect(() => {
    if (!myUserId) return;
    try {
      const raw = localStorage.getItem(todayKey(myUserId));
      setSkipped(raw === '1');
    } catch {
      /* storage blocked — stay visible, no harm */
    }
  }, [myUserId]);

  // Auto-dismiss when you've done ANYTHING meaningful today: moved a
  // slider, set love-tank, or sent a heart. Read from the already-
  // decrypted event stream so this is just a derived boolean.
  const didSomethingToday = useMemo(() => {
    if (!myUserId) return false;
    for (const rec of events) {
      if (rec.senderId !== myUserId) continue;
      if (!isSameLocalDay(rec.event.ts)) continue;
      switch (rec.event.type) {
        case 'slider_set':
        case 'love_tank_set':
        case 'gratitude_send':
        case 'message':
        case 'homework_set':
          return true;
      }
    }
    return false;
  }, [events, myUserId]);

  if (!myUserId || skipped || didSomethingToday) return null;

  const prompt = promptForToday();

  function skip() {
    if (!myUserId) return;
    try {
      localStorage.setItem(todayKey(myUserId), '1');
    } catch {
      /* noop */
    }
    setSkipped(true);
  }

  return (
    <>
      <motion.section
        role="region"
        aria-label="Daily check-in"
        initial={reduced ? { opacity: 1 } : { opacity: 0, y: -6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: reduced ? 0 : 0.45, ease: 'easeOut' }}
        className="relative overflow-hidden rounded-3xl border border-white/60 bg-gradient-to-br from-rose-50/80 via-amber-50/75 to-pink-50/70 p-5 shadow-lg backdrop-blur-md transition-transform duration-200 ease-out hover:scale-[1.008] dark:border-white/10 dark:from-rose-950/40 dark:via-amber-950/30 dark:to-pink-950/30"
      >
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-70"
          style={{
            background:
              'radial-gradient(ellipse at 15% 0%, rgba(255,255,255,0.6), transparent 55%)',
          }}
        />
        <div className="relative flex items-start gap-4">
          <motion.span
            aria-hidden
            className="text-3xl leading-none"
            animate={reduced ? { scale: 1 } : { scale: [1, 1.08, 1] }}
            transition={
              reduced
                ? { duration: 0 }
                : { duration: 3.4, repeat: Infinity, ease: 'easeInOut' }
            }
          >
            {prompt.emoji}
          </motion.span>
          <div className="min-w-0 flex-1">
            <p className="font-display italic text-lg leading-snug text-neutral-900 dark:text-neutral-50">
              {prompt.headline}
            </p>
            <p className="mt-1 text-sm leading-relaxed text-neutral-700 dark:text-neutral-300">
              {prompt.body}
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => setOpenSheet('sliders')}
                className="rounded-full bg-gradient-to-br from-rose-300 via-rose-400 to-pink-500 px-4 py-1.5 font-display italic text-xs text-white shadow-[0_6px_16px_-4px_rgba(244,63,94,0.45),inset_0_2px_3px_rgba(255,255,255,0.45),inset_0_-2px_4px_rgba(159,18,57,0.3)] ring-1 ring-rose-200/60 transition-all hover:scale-[1.04] active:scale-[1.02]"
              >
                🎚️ Move a slider
              </button>
              <button
                type="button"
                onClick={() => setOpenSheet('love_tank')}
                className="rounded-full border border-rose-200 bg-white/80 px-4 py-1.5 font-display italic text-xs text-rose-900 transition-all hover:scale-[1.04] hover:bg-white active:scale-[1.02] dark:border-rose-800 dark:bg-neutral-900/60 dark:text-rose-200"
              >
                💖 Top up love tank
              </button>
              <button
                type="button"
                onClick={skip}
                className="rounded-full px-3 py-1.5 text-xs text-neutral-500 transition-colors hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-100"
              >
                not today
              </button>
            </div>
          </div>
        </div>
      </motion.section>

      <AnimatePresence>
        {openSheet === 'sliders' && (
          <FeatureSheet
            key="check-in-sliders"
            title="Vibe sliders"
            emoji="🎚️"
            onClose={() => setOpenSheet(null)}
          >
            <VibeSliders />
          </FeatureSheet>
        )}
        {openSheet === 'love_tank' && (
          <FeatureSheet
            key="check-in-love-tank"
            title="Love tank"
            emoji="💖"
            onClose={() => setOpenSheet(null)}
          >
            <LoveTank />
          </FeatureSheet>
        )}
      </AnimatePresence>
    </>
  );
}
