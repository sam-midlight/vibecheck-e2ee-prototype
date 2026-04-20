'use client';

/**
 * MemoryJar — surfaces lovely moments from the existing ledger back into
 * the present. Pure projection: pulls a few candidate memories (a
 * gratitude note from months ago, a solved Mind Reader game, a completed
 * date, a Safe Space entry that got resolved) and rotates through them
 * gently on the home page.
 *
 * Zero new events. No server calls. Just re-reading history with
 * empathy. Candidates are scored by how much "standing still" feels like
 * they carry — long-ago gratitudes beat recent ones; resolved safe-space
 * entries lead with how long it took to unlock; completed dates lead with
 * "you did {title}".
 */

import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { displayName as fmtDisplayName } from '@/lib/domain/displayName';
import { useReducedMotionPref } from '@/lib/motionPrefs';
import { useRoom } from './RoomProvider';

const ROTATE_MS = 9000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_MEMORIES = 6;

type Memory = {
  id: string;
  emoji: string;
  headline: string;
  body: string;
  /** ms of when the referenced event happened — used for "3 months ago" copy. */
  whenTs: number;
};

function relativeWhen(ms: number, now: number): string {
  const diff = Math.max(0, now - ms);
  const days = Math.round(diff / DAY_MS);
  if (days <= 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  const weeks = Math.round(days / 7);
  if (weeks < 5) return `${weeks} week${weeks === 1 ? '' : 's'} ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months} month${months === 1 ? '' : 's'} ago`;
  const years = Math.round(days / 365);
  return `${years} year${years === 1 ? '' : 's'} ago`;
}

function isAnniversary(ts: number, now: number): boolean {
  const a = new Date(ts);
  const b = new Date(now);
  return a.getDate() === b.getDate() && a.getMonth() === b.getMonth() && a.getFullYear() !== b.getFullYear();
}

export function MemoryJar() {
  const { events, myUserId, displayNames } = useRoom();
  const reduced = useReducedMotionPref();

  const memories = useMemo<Memory[]>(() => {
    if (!myUserId) return [];
    const now = Date.now();
    const out: Memory[] = [];

    // Track date idea titles so we can label completions by name.
    const ideaTitles: Record<string, string> = {};
    // Track Safe Space entry open → resolve pairing for "it took X days".
    const safeSpacePostedTs: Record<string, number> = {};
    const safeSpaceResolveTs: Record<string, number> = {};

    const firstName = (uid: string) =>
      fmtDisplayName(uid, displayNames, myUserId, null).split(/\s/)[0];

    for (const rec of events) {
      const ev = rec.event;
      if (ev.type === 'date_idea_add') {
        ideaTitles[ev.ideaId] = ev.title;
      } else if (ev.type === 'icebreaker_post') {
        safeSpacePostedTs[ev.entryId] = ev.ts;
      } else if (ev.type === 'icebreaker_resolve') {
        const prior = safeSpaceResolveTs[ev.entryId] ?? 0;
        if (ev.ts > prior) safeSpaceResolveTs[ev.entryId] = ev.ts;
      }
    }

    for (const rec of events) {
      const ev = rec.event;
      const senderName = firstName(rec.senderId);

      if (ev.type === 'gratitude_send' && ev.message && ev.message.trim().length > 0) {
        // Old + deliberate gratitude notes are the lovliest — skip ones
        // from the last 3 days so the jar feels like it reaches back.
        if (now - ev.ts < 3 * DAY_MS) continue;
        const recipientName =
          ev.to === myUserId
            ? 'you'
            : fmtDisplayName(ev.to, displayNames, myUserId, null).split(/\s/)[0];
        const hearts = '♥'.repeat(Math.min(3, ev.amount));
        out.push({
          id: `grat-${rec.id}`,
          emoji: '🙏',
          headline: isAnniversary(ev.ts, now)
            ? `On this day, ${senderName} told ${recipientName}: ${hearts}`
            : `${senderName} told ${recipientName} ${relativeWhen(ev.ts, now)}:`,
          body: `"${ev.message.trim()}"`,
          whenTs: ev.ts,
        });
      } else if (ev.type === 'date_idea_complete' && ev.feedback && ev.feedback.trim().length > 0) {
        if (now - ev.ts < 7 * DAY_MS) continue;
        const title = ideaTitles[ev.ideaId] ?? 'that date';
        out.push({
          id: `date-${rec.id}`,
          emoji: '💕',
          headline: `Remember ${title}? ${senderName} wrote afterwards:`,
          body: `"${ev.feedback.trim()}"`,
          whenTs: ev.ts,
        });
      } else if (ev.type === 'mind_reader_solve') {
        if (now - ev.ts < 14 * DAY_MS) continue;
        out.push({
          id: `mr-${rec.id}`,
          emoji: '🔮',
          headline: `${senderName} guessed you ${relativeWhen(ev.ts, now)}.`,
          body: `The word was "${ev.guess}". They read you right.`,
          whenTs: ev.ts,
        });
      } else if (ev.type === 'icebreaker_resolve') {
        // Only surface the FIRST resolve per entry (latest wins for the
        // resolvedTs but we use the whole arc — post → resolve).
        const postedTs = safeSpacePostedTs[ev.entryId];
        if (!postedTs) continue;
        if (now - ev.ts < 14 * DAY_MS) continue;
        const span = Math.max(1, Math.round((ev.ts - postedTs) / DAY_MS));
        out.push({
          id: `ss-${ev.entryId}-${rec.id}`,
          emoji: '🛡️',
          headline: `You worked through something hard together ${relativeWhen(ev.ts, now)}.`,
          body:
            span <= 1
              ? 'Opened, unlocked, resolved — same day. You showed up.'
              : `It took ${span} day${span === 1 ? '' : 's'} from opening to resolving. You got there.`,
          whenTs: ev.ts,
        });
      }
    }

    // Sort: anniversary (today-of-year matches) first, then oldest first
    // so the "forgotten moments" bubble up.
    out.sort((a, b) => {
      const aAnniv = isAnniversary(a.whenTs, now) ? 1 : 0;
      const bAnniv = isAnniversary(b.whenTs, now) ? 1 : 0;
      if (aAnniv !== bAnniv) return bAnniv - aAnniv;
      return a.whenTs - b.whenTs;
    });

    return out.slice(0, MAX_MEMORIES);
  }, [events, myUserId, displayNames]);

  const [idx, setIdx] = useState(0);

  useEffect(() => {
    if (reduced) return;
    if (memories.length < 2) return;
    const h = window.setInterval(() => setIdx((i) => i + 1), ROTATE_MS);
    return () => window.clearInterval(h);
  }, [reduced, memories.length]);

  if (memories.length === 0) return null;

  const safeIdx = memories.length > 0 ? idx % memories.length : 0;
  const active = memories[safeIdx];

  return (
    <section
      aria-label="Memory jar"
      className="relative overflow-hidden rounded-3xl border border-amber-200/70 bg-gradient-to-br from-amber-50/90 via-orange-50/80 to-rose-50/70 p-5 shadow-lg backdrop-blur-md transition-transform duration-200 ease-out hover:scale-[1.008] dark:border-amber-800/50 dark:from-amber-950/50 dark:via-orange-950/40 dark:to-rose-950/30"
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-60"
        style={{
          background:
            'radial-gradient(ellipse at 20% 0%, rgba(255,255,255,0.55), transparent 55%)',
        }}
      />
      <header className="relative flex items-center gap-2">
        <span className="text-[11px] font-medium uppercase tracking-[0.2em] text-amber-700 dark:text-amber-100">
          Memory jar
        </span>
        <span aria-hidden className="text-sm">🫙</span>
      </header>

      <div className="relative mt-3 min-h-[4.25rem]">
        <AnimatePresence mode="wait">
          <motion.div
            key={active.id}
            initial={reduced ? { opacity: 1 } : { opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, y: -6 }}
            transition={{ duration: reduced ? 0.12 : 0.6, ease: 'easeOut' }}
            className="flex items-start gap-3"
          >
            <span className="mt-0.5 text-2xl leading-none" aria-hidden>
              {active.emoji}
            </span>
            <div className="min-w-0 flex-1">
              <p className="font-display italic text-base leading-snug text-amber-950 dark:text-amber-100">
                {active.headline}
              </p>
              <p className="mt-1 text-sm leading-relaxed text-amber-900/80 dark:text-amber-100">
                {active.body}
              </p>
            </div>
          </motion.div>
        </AnimatePresence>
      </div>

      {memories.length > 1 && (
        <div className="relative mt-3 flex items-center gap-1.5">
          {memories.map((m, i) => (
            <button
              key={m.id}
              type="button"
              aria-label={`show memory ${i + 1} of ${memories.length}`}
              onClick={() => setIdx(i)}
              className="h-1.5 rounded-full transition-all"
              style={{
                width: i === safeIdx ? 18 : 6,
                backgroundColor: i === safeIdx ? 'rgb(180 83 9)' : 'rgba(120,53,15,0.25)',
              }}
            />
          ))}
        </div>
      )}
    </section>
  );
}
