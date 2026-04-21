'use client';

/**
 * VibeOracleBanner — wide pulsing/glowing banner that crossfades through
 * empathic single-sentence reads of each member's current vibe (see
 * lib/domain/vibeLines.ts).
 *
 * Each line carries its own hue so the banner gradient + glow shift to
 * match the vibe of the line currently on screen. Purely presentational —
 * reads only from the already-decrypted projection.
 */

import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useVibeLines, type VibeLine } from '@/lib/domain/vibeLines';
import { FeatureSheet } from './FeatureSheet';
import { HomeworkBanner } from './HomeworkBanner';
import { LoveTank } from './LoveTank';
import { useRoomProjection } from './RoomProvider';
import { VibeOracleHistory } from './VibeOracleHistory';
import { VibeSliders } from './VibeSliders';
import { SectionHeader } from './design/SectionHeader';

const ROTATE_MS = 3500;
const HISTORY_SIZE = 6;

interface IntentionState {
  text: string;
  ts: number;
}

export function VibeOracleBanner() {
  const lines = useVibeLines();
  const [idx, setIdx] = useState(0);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [intentionOpen, setIntentionOpen] = useState(false);
  const [history, setHistory] = useState<VibeLine[]>([]);
  // Open downstream sheet for a clicked history item. Closing returns to
  // the home view (history sheet was already closed when this opened).
  const [openTarget, setOpenTarget] = useState<
    { kind: 'slider'; highlight: string } | { kind: 'love_tank' } | null
  >(null);

  // Read the latest homework_set so the banner can carry the active
  // intention as its quieter footer line. Mirrors HomeworkBanner's reducer.
  const intention = useRoomProjection<IntentionState | null>((acc, rec) => {
    if (rec.event.type !== 'homework_set') return acc;
    if (acc && acc.ts > rec.event.ts) return acc;
    return { text: rec.event.text, ts: rec.event.ts };
  }, null, []);
  const intentionText = intention?.text.trim() ?? '';

  useEffect(() => {
    if (lines.length < 2) return;
    const h = setInterval(() => {
      setIdx((i) => i + 1);
    }, ROTATE_MS);
    return () => clearInterval(h);
  }, [lines.length]);

  // Rolling 6-line history: prepend any line ids we haven't seen yet,
  // cap at HISTORY_SIZE. Removed lines stay in history until pushed off
  // — we want a recent-activity log, not a "what's currently extreme" set.
  // Effect-driven setState is intentional: history is a derived rolling
  // buffer over a stream input (lines), which the standard rule against
  // setState-in-effect doesn't model well.
  useEffect(() => {
    if (lines.length === 0) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHistory((prev) => {
      const seen = new Set(prev.map((l) => l.id));
      const fresh = lines.filter((l) => !seen.has(l.id));
      if (fresh.length === 0) return prev;
      return [...fresh.slice().reverse(), ...prev].slice(0, HISTORY_SIZE);
    });
  }, [lines]);

  // Wrap rather than reset: lets idx grow forever, modulo handles the
  // "lines just changed" case without a setState-in-effect resync.
  const safeIdx = lines.length > 0 ? idx % lines.length : 0;
  const active = lines[safeIdx] ?? null;

  function handleSelectHistoryLine(line: VibeLine) {
    setHistoryOpen(false);
    if (line.target.kind === 'love_tank') {
      setOpenTarget({ kind: 'love_tank' });
    } else {
      setOpenTarget({ kind: 'slider', highlight: line.target.title });
    }
  }
  const hue = active?.hue ?? 275;
  const high = active?.intensity === 'high';

  const bg = `linear-gradient(110deg, hsla(${hue}, 90%, 96%, 0.95) 0%, hsla(${(hue + 25) % 360}, 85%, 90%, 0.85) 100%)`;
  const bgDark = `linear-gradient(110deg, hsla(${hue}, 60%, 18%, 0.85) 0%, hsla(${(hue + 25) % 360}, 55%, 22%, 0.8) 100%)`;
  const glowDim = `0 0 36px 2px hsla(${hue}, 80%, 70%, ${high ? 0.45 : 0.3})`;
  const glowBright = `0 0 56px 6px hsla(${hue}, 90%, 72%, ${high ? 0.65 : 0.45})`;

  return (
    <>
    {/* Banner uses role="button" on a div instead of a real <button> so the
        nested pager-dot buttons inside don't violate "<button> cannot be a
        descendant of <button>". Keyboard parity preserved via onKeyDown
        (Enter / Space → open history). */}
    <motion.div
      role="button"
      tabIndex={0}
      onClick={() => setHistoryOpen(true)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          setHistoryOpen(true);
        }
      }}
      aria-label="open vibe oracle history"
      className="relative w-full cursor-pointer overflow-hidden rounded-3xl border border-white/60 px-5 py-4 text-left backdrop-blur-md focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-400 dark:border-white/10"
      style={{ background: bg }}
      animate={{
        scale: [1, 1.012, 1],
        boxShadow: [glowDim, glowBright, glowDim],
      }}
      transition={{
        scale: { duration: 4.2, repeat: Infinity, ease: 'easeInOut' },
        boxShadow: { duration: 4.2, repeat: Infinity, ease: 'easeInOut' },
      }}
      // Hover bump on top of the breathing — whileHover overrides the
      // animate keyframes only while hovered, then snaps back to breathing.
      whileHover={{ scale: 1.018 }}
      whileTap={{ scale: 1.005 }}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 hidden dark:block"
        style={{ background: bgDark }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-60"
        style={{
          background:
            'radial-gradient(ellipse at 18% 0%, rgba(255,255,255,0.6), transparent 55%)',
        }}
      />

      <div className="relative">
        <SectionHeader
          label="Vibe oracle"
          trailing={
            <span
              aria-hidden
              className="inline-flex h-2 w-2 animate-pulse rounded-full"
              style={{ backgroundColor: `hsl(${hue}, 80%, 55%)` }}
            />
          }
        />
      </div>

      <div className="relative mt-3 min-h-[2.5rem]">
        <AnimatePresence mode="wait">
          {active ? (
            <motion.p
              key={active.id}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.55, ease: 'easeOut' }}
              className="flex items-center gap-3 pl-1 font-display italic text-lg leading-snug text-neutral-900 dark:text-neutral-50"
            >
              <span className="text-2xl leading-none" aria-hidden>
                {active.emoji}
              </span>
              <span>{active.text}</span>
            </motion.p>
          ) : (
            <motion.p
              key="balanced"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.4 }}
              className="flex items-center gap-3 pl-1 font-display text-lg leading-snug text-neutral-700 dark:text-neutral-300"
            >
              <span className="text-2xl leading-none" aria-hidden>
                ✨
              </span>
              <span>Vibes are balanced today.</span>
            </motion.p>
          )}
        </AnimatePresence>
      </div>

      {lines.length > 1 && (
        <div className="relative mt-3 flex items-center gap-1.5">
          {lines.map((l, i) => (
            <button
              key={l.id}
              type="button"
              aria-label={`show vibe ${i + 1} of ${lines.length}`}
              onClick={(e) => {
                // Stop propagation so the dot click doesn't bubble to the
                // outer banner-button and open the history sheet.
                e.stopPropagation();
                setIdx(i);
              }}
              className="h-1.5 rounded-full transition-all"
              style={{
                width: i === safeIdx ? 18 : 6,
                backgroundColor:
                  i === safeIdx
                    ? `hsl(${l.hue}, 70%, 50%)`
                    : 'rgba(0,0,0,0.18)',
              }}
            />
          ))}
        </div>
      )}

      {/* Intention footer — loud sibling to the oracle line, sharing
          the same banner so the daily read and this week's intention live
          as a single thought. Warm amber gradient + breathing pulse so
          it reads as a sticky-note reminder, not a quiet caption. Stops
          propagation so it opens its own edit sheet. */}
      <motion.div
        role="button"
        tabIndex={0}
        onClick={(e) => {
          e.stopPropagation();
          setIntentionOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            e.stopPropagation();
            setIntentionOpen(true);
          }
        }}
        aria-label={intentionText ? `edit intention: ${intentionText}` : 'set this week\u2019s intention'}
        className="relative mt-4 flex items-start gap-3 overflow-hidden rounded-2xl border-2 border-amber-300/70 bg-gradient-to-br from-amber-100/95 via-amber-50/90 to-orange-100/85 px-4 py-3 text-left shadow-md transition-transform hover:scale-[1.01] dark:border-amber-600/50 dark:from-amber-900/50 dark:via-amber-950/40 dark:to-orange-950/40"
        animate={{
          boxShadow: [
            '0 4px 16px -4px rgba(217,119,6,0.30), inset 0 1px 0 rgba(255,255,255,0.6)',
            '0 8px 28px -4px rgba(217,119,6,0.55), inset 0 1px 0 rgba(255,255,255,0.7)',
            '0 4px 16px -4px rgba(217,119,6,0.30), inset 0 1px 0 rgba(255,255,255,0.6)',
          ],
        }}
        transition={{ boxShadow: { duration: 3.6, repeat: Infinity, ease: 'easeInOut' } }}
      >
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-60"
          style={{
            background:
              'radial-gradient(ellipse at 12% 0%, rgba(255,255,255,0.7), transparent 55%)',
          }}
        />
        <motion.span
          aria-hidden
          className="relative text-2xl leading-none"
          animate={{ rotate: [0, -6, 6, -3, 0] }}
          transition={{ duration: 4.2, repeat: Infinity, ease: 'easeInOut' }}
        >
          🌱
        </motion.span>
        <div className="relative min-w-0 flex-1">
          <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-amber-700 dark:text-amber-300">
            This week&rsquo;s intention
          </p>
          <p
            className={`mt-1 font-display italic leading-snug ${
              intentionText
                ? 'text-xl text-amber-950 dark:text-amber-50'
                : 'text-base text-amber-800/80 dark:text-amber-200/80'
            }`}
          >
            {intentionText || 'Tap to set one…'}
          </p>
        </div>
      </motion.div>
    </motion.div>

    <AnimatePresence>
      {historyOpen && (
        <FeatureSheet
          key="vibe-oracle-history"
          title="Vibe oracle"
          emoji="🪞"
          onClose={() => setHistoryOpen(false)}
        >
          <VibeOracleHistory history={history} onSelect={handleSelectHistoryLine} />
        </FeatureSheet>
      )}
      {openTarget?.kind === 'slider' && (
        <FeatureSheet
          key="vibe-sliders-from-history"
          title="Vibe sliders"
          emoji="🎚️"
          onClose={() => setOpenTarget(null)}
        >
          <VibeSliders highlightTitle={openTarget.highlight} />
        </FeatureSheet>
      )}
      {openTarget?.kind === 'love_tank' && (
        <FeatureSheet
          key="love-tank-from-history"
          title="Love tank"
          emoji="💖"
          onClose={() => setOpenTarget(null)}
        >
          <LoveTank />
        </FeatureSheet>
      )}
      {intentionOpen && (
        <FeatureSheet
          key="intention-from-oracle"
          title="Intention"
          emoji="🌱"
          onClose={() => setIntentionOpen(false)}
        >
          <HomeworkBanner />
        </FeatureSheet>
      )}
    </AnimatePresence>
    </>
  );
}
