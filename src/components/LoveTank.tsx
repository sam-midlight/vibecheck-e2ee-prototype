'use client';

/**
 * Love Tank — actionable edition.
 *
 * Each member publishes:
 *   - `level` (0–100): how full their tank feels
 *   - `needs` (optional, per-love-language 0–100): how much of the *empty*
 *     portion is attributable to each specific need
 *   - `note` (optional): a short "why is it where it is?" whisper
 *
 * Invariant: `level + Σ(needs) ≤ 100`. The slider UI enforces this by
 * dynamically capping each need slider's max to whatever free space is left.
 * The projection reducer clamps on read as a belt-and-braces safety net.
 *
 * Visualization: a single horizontal stacked bar per member —
 *   [ filled: level% | need1 | need2 | … | remaining (unallocated empty) ]
 * so a partner sees both "how full" and "what specifically is missing"
 * in one glance.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { displayName } from '@/lib/domain/displayName';
import { LOVE_LANGUAGES, type LoveLanguage } from '@/lib/domain/events';
import { uniqueMembers } from '@/lib/domain/members';
import { useRoom, useRoomProjection } from './RoomProvider';

// ---- Domain types ---------------------------------------------------------

type NeedsMap = Partial<Record<LoveLanguage, number>>;

interface LoveTankEntry {
  level: number;
  needs: NeedsMap;
  note?: string;
  ts: number;
}

type LevelMap = Record<string, LoveTankEntry>;

// ---- Need metadata --------------------------------------------------------

const NEED_META: Record<
  LoveLanguage,
  { label: string; emoji: string; barClass: string; chipClass: string }
> = {
  quality_time: {
    label: 'Quality time',
    emoji: '⏰',
    barClass: 'bg-sky-400 dark:bg-sky-500',
    chipClass:
      'border-sky-300 bg-sky-50 text-sky-900 dark:border-sky-700 dark:bg-sky-950/60 dark:text-sky-200',
  },
  physical_affection: {
    label: 'Physical affection',
    emoji: '🤗',
    barClass: 'bg-rose-400 dark:bg-rose-500',
    chipClass:
      'border-rose-300 bg-rose-50 text-rose-900 dark:border-rose-700 dark:bg-rose-950/60 dark:text-rose-200',
  },
  words_of_affirmation: {
    label: 'Words of affirmation',
    emoji: '💬',
    barClass: 'bg-amber-400 dark:bg-amber-500',
    chipClass:
      'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-700 dark:bg-amber-950/60 dark:text-amber-200',
  },
  acts_of_service: {
    label: 'Acts of service',
    emoji: '🛠️',
    barClass: 'bg-emerald-400 dark:bg-emerald-500',
    chipClass:
      'border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-200',
  },
  gifts: {
    label: 'Gifts',
    emoji: '🎁',
    barClass: 'bg-violet-400 dark:bg-violet-500',
    chipClass:
      'border-violet-300 bg-violet-50 text-violet-900 dark:border-violet-700 dark:bg-violet-950/60 dark:text-violet-200',
  },
};

// ---- Helpers --------------------------------------------------------------

function sumNeeds(needs: NeedsMap): number {
  let s = 0;
  for (const k of LOVE_LANGUAGES) s += needs[k] ?? 0;
  return s;
}

/** Clamp a needs map so level + Σ(needs) ≤ 100. Shrinks proportionally. */
function clampNeeds(level: number, needs: NeedsMap): NeedsMap {
  const budget = Math.max(0, 100 - level);
  const total = sumNeeds(needs);
  if (total <= budget) return needs;
  if (total === 0) return needs;
  const scale = budget / total;
  const out: NeedsMap = {};
  for (const k of LOVE_LANGUAGES) {
    const v = needs[k];
    if (!v) continue;
    const scaled = Math.floor(v * scale);
    if (scaled > 0) out[k] = scaled;
  }
  return out;
}

function needsEqual(a: NeedsMap, b: NeedsMap): boolean {
  for (const k of LOVE_LANGUAGES) {
    if ((a[k] ?? 0) !== (b[k] ?? 0)) return false;
  }
  return true;
}

// ---- Component ------------------------------------------------------------

export function LoveTank() {
  const { appendEvent, myUserId, members, room, displayNames } = useRoom();

  const levels = useRoomProjection<LevelMap>(
    (state, rec) => {
      if (rec.event.type !== 'love_tank_set') return state;
      const prev = state[rec.senderId];
      if (prev && prev.ts > rec.event.ts) return state;
      // Clamp on read: legacy or future payloads may violate the invariant.
      const level = Math.max(0, Math.min(100, rec.event.level));
      const rawNeeds: NeedsMap = (rec.event.needs as NeedsMap | undefined) ?? {};
      const needs = clampNeeds(level, rawNeeds);
      return {
        ...state,
        [rec.senderId]: {
          level,
          needs,
          note: rec.event.note?.trim() || undefined,
          ts: rec.event.ts,
        },
      };
    },
    {},
  );

  const currentGenMembers = useMemo(
    () => (room ? uniqueMembers(members, room.current_generation) : []),
    [members, room],
  );

  const myLevel = myUserId ? (levels[myUserId]?.level ?? 50) : 50;
  const myNeeds = myUserId ? (levels[myUserId]?.needs ?? {}) : {};
  const myNote = (myUserId && levels[myUserId]?.note) ?? '';

  // Draft state (slider + needs live here while the user is dragging).
  const [draftLevel, setDraftLevel] = useState<number>(myLevel);
  const [draftNeeds, setDraftNeeds] = useState<NeedsMap>(myNeeds);
  const [noteDraft, setNoteDraft] = useState<string>('');
  const [justSent, setJustSent] = useState(false);
  const [needsExpanded, setNeedsExpanded] = useState<boolean>(
    sumNeeds(myNeeds) > 0,
  );

  const publishedRef = useRef<{
    level: number;
    needs: NeedsMap;
    note: string;
  }>({ level: myLevel, needs: myNeeds, note: myNote });

  // Re-sync draft → projection when the server-side state changes (e.g., this
  // user edited from another tab). Don't overwrite live dragging: we only
  // re-sync when the projection's ts is strictly newer than what we published.
  useEffect(() => {
    setDraftLevel(myLevel);
    publishedRef.current = { ...publishedRef.current, level: myLevel };
  }, [myLevel]);

  useEffect(() => {
    setDraftNeeds(myNeeds);
    publishedRef.current = { ...publishedRef.current, needs: myNeeds };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(myNeeds)]);

  useEffect(() => {
    publishedRef.current = { ...publishedRef.current, note: myNote };
  }, [myNote]);

  // Debounced publish when level or needs change.
  useEffect(() => {
    const pub = publishedRef.current;
    const same =
      draftLevel === pub.level && needsEqual(draftNeeds, pub.needs);
    if (same) return;
    const handle = setTimeout(() => {
      const clamped = clampNeeds(draftLevel, draftNeeds);
      publishedRef.current = {
        ...publishedRef.current,
        level: draftLevel,
        needs: clamped,
      };
      void appendEvent({
        type: 'love_tank_set',
        level: draftLevel,
        // Cast: zod's `z.record(z.enum(...), number)` infers a strict
        // full-Record shape, but we use a Partial at rest (missing key ⇔ 0).
        // Absent keys are semantically zero, so this cast is sound.
        needs:
          sumNeeds(clamped) > 0
            ? (clamped as Record<LoveLanguage, number>)
            : undefined,
        note: publishedRef.current.note || undefined,
        ts: Date.now(),
      });
    }, 400);
    return () => clearTimeout(handle);
  }, [draftLevel, draftNeeds, appendEvent]);

  async function commitNote(rawNote: string) {
    const note = rawNote.trim().slice(0, 140);
    publishedRef.current = { ...publishedRef.current, note };
    await appendEvent({
      type: 'love_tank_set',
      level: publishedRef.current.level,
      needs:
        sumNeeds(publishedRef.current.needs) > 0
          ? (publishedRef.current.needs as Record<LoveLanguage, number>)
          : undefined,
      note: note.length > 0 ? note : undefined,
      ts: Date.now(),
    });
    setNoteDraft('');
    setJustSent(true);
    setTimeout(() => setJustSent(false), 1400);
  }

  function onNoteKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const trimmed = noteDraft.trim();
      if (trimmed.length === 0 && !myNote) return;
      void commitNote(noteDraft);
    }
  }

  function onNoteBlur() {
    const trimmed = noteDraft.trim();
    if (trimmed.length > 0 && trimmed !== myNote) {
      void commitNote(noteDraft);
    }
  }

  function handleLevelChange(next: number) {
    setDraftLevel(next);
    // If level rose into space already claimed by needs, shrink needs.
    const budget = 100 - next;
    if (sumNeeds(draftNeeds) > budget) {
      setDraftNeeds((prev) => clampNeeds(next, prev));
    }
  }

  function handleNeedChange(key: LoveLanguage, next: number) {
    setDraftNeeds((prev) => {
      const others = { ...prev, [key]: 0 };
      const othersSum = sumNeeds(others);
      const roomForThis = Math.max(0, 100 - draftLevel - othersSum);
      const clamped = Math.max(0, Math.min(roomForThis, Math.round(next)));
      const out = { ...prev };
      if (clamped === 0) delete out[key];
      else out[key] = clamped;
      return out;
    });
  }

  if (!myUserId || !room) return null;

  const myUnallocated = Math.max(0, 100 - draftLevel - sumNeeds(draftNeeds));

  return (
    <section className="rounded-2xl border border-white/50 bg-pink-50/70 p-6 text-sm shadow-xl backdrop-blur-md dark:border-white/10 dark:bg-pink-950/40">
      <div className="text-[11px] font-medium uppercase tracking-[0.18em] text-pink-800 dark:text-pink-300">
        Love tank 💖
      </div>

      {/* ---- Per-member stacked bars --------------------------------- */}
      <ul className="mt-2 space-y-3">
        {currentGenMembers.map((m) => {
          const entry = levels[m.user_id];
          const level = entry?.level ?? null;
          const needs = entry?.needs ?? {};
          const note = entry?.note;
          const isMe = m.user_id === myUserId;
          return (
            <li key={m.user_id} className="space-y-1.5">
              <div className="flex items-center justify-between text-xs">
                <span className="text-pink-900/80 dark:text-pink-100">
                  {displayName(m.user_id, displayNames, myUserId)}
                </span>
                <span className="tabular-nums text-pink-900 dark:text-pink-200">
                  {level == null ? '—' : `${level}%`}
                </span>
              </div>
              <StackedBar level={level} needs={needs} />
              {sumNeeds(needs) > 0 && (
                <div className="flex flex-wrap gap-1">
                  {LOVE_LANGUAGES.filter((k) => (needs[k] ?? 0) > 0).map((k) => (
                    <span
                      key={k}
                      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] ${NEED_META[k].chipClass}`}
                    >
                      <span>{NEED_META[k].emoji}</span>
                      <span>{NEED_META[k].label}</span>
                      <span className="tabular-nums opacity-70">
                        {needs[k]}%
                      </span>
                    </span>
                  ))}
                </div>
              )}
              {note && !isMe && (
                <p className="text-xs italic text-pink-900/70 dark:text-pink-100">
                  &ldquo;{note}&rdquo;
                </p>
              )}
            </li>
          );
        })}
      </ul>

      {/* ---- My controls --------------------------------------------- */}
      <div className="mt-4 space-y-3 border-t border-pink-200/60 pt-4 dark:border-pink-800/50">
        <div>
          <label className="text-[11px] font-medium uppercase tracking-[0.18em] text-pink-800 dark:text-pink-300">
            set your level
          </label>
          <div className="mt-1 flex items-center gap-3">
            <input
              type="range"
              min={0}
              max={100}
              value={draftLevel}
              onChange={(e) => handleLevelChange(Number(e.target.value))}
              className="flex-1 accent-pink-600"
              aria-label="love tank level"
            />
            <span className="w-10 text-right font-medium tabular-nums text-pink-900 dark:text-pink-200">
              {draftLevel}%
            </span>
          </div>
        </div>

        {/* Needs breakdown --------------------------------------------- */}
        <div>
          <button
            type="button"
            onClick={() => setNeedsExpanded((e) => !e)}
            className="flex w-full items-center justify-between rounded-xl border border-pink-200/60 bg-white/60 px-3 py-1.5 text-[11px] font-medium text-pink-900 transition-all hover:scale-[1.01] hover:bg-white/80 dark:border-pink-800/50 dark:bg-neutral-900/50 dark:text-pink-200"
            aria-expanded={needsExpanded}
          >
            <span className="font-medium">
              {draftLevel === 100
                ? 'Fully topped up ✨'
                : `${100 - draftLevel}% unassigned — break it down?`}
            </span>
            <span aria-hidden className="text-pink-700 dark:text-pink-300">
              {needsExpanded ? '▾' : '▸'}
            </span>
          </button>

          {needsExpanded && draftLevel < 100 && (
            <div className="mt-2 space-y-2 rounded-xl border border-pink-200/60 bg-white/60 p-3 shadow-sm backdrop-blur-md dark:border-pink-800/40 dark:bg-neutral-900/50">
              <p className="text-[11px] text-pink-900/70 dark:text-pink-100">
                What would fill you up? Each slider caps at the unassigned
                space remaining.
                {myUnallocated > 0 && (
                  <>
                    {' '}
                    <span className="font-medium text-pink-900 dark:text-pink-200">
                      {myUnallocated}% left
                    </span>{' '}
                    to allocate.
                  </>
                )}
              </p>
              {LOVE_LANGUAGES.map((k) => (
                <NeedSlider
                  key={k}
                  need={k}
                  value={draftNeeds[k] ?? 0}
                  level={draftLevel}
                  otherNeeds={Object.fromEntries(
                    LOVE_LANGUAGES.filter((o) => o !== k).map((o) => [
                      o,
                      draftNeeds[o] ?? 0,
                    ]),
                  )}
                  onChange={(v) => handleNeedChange(k, v)}
                />
              ))}
            </div>
          )}
        </div>

        {/* Note --------------------------------------------------------- */}
        {myNote && (
          <div className="flex items-start justify-between gap-2 rounded-xl border border-pink-200/70 bg-white/80 px-2 py-1 text-xs shadow-sm backdrop-blur-md dark:border-pink-800/50 dark:bg-neutral-900/70">
            <span className="italic text-pink-900/80 dark:text-pink-100">
              &ldquo;{myNote}&rdquo;
            </span>
            <button
              type="button"
              onClick={() => void commitNote('')}
              className="flex-shrink-0 rounded-full border border-pink-200 px-2 py-0.5 text-[10px] text-pink-900/70 transition-all hover:bg-pink-50 hover:text-pink-900 active:scale-[0.97] dark:border-pink-800 dark:text-pink-100 dark:hover:bg-pink-950/60"
              aria-label="clear your note"
            >
              clear
            </button>
          </div>
        )}
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={noteDraft}
            onChange={(e) => setNoteDraft(e.target.value.slice(0, 140))}
            onKeyDown={onNoteKeyDown}
            onBlur={onNoteBlur}
            placeholder={
              myNote
                ? 'write a new note — enter to replace…'
                : 'whisper a note — enter to send…'
            }
            maxLength={140}
            className="flex-1 rounded-xl border border-pink-200 bg-white/85 px-3 py-1.5 text-sm text-neutral-900 placeholder:italic placeholder:text-pink-300 outline-none transition-colors focus:border-pink-300 focus:ring-2 focus:ring-pink-300/40 dark:border-pink-800 dark:bg-neutral-950 dark:text-neutral-100"
            aria-label="love tank note"
          />
          {justSent && (
            <span className="flex-shrink-0 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] text-emerald-800 dark:bg-emerald-900/60 dark:text-emerald-200">
              ✓ sent
            </span>
          )}
        </div>
      </div>
    </section>
  );
}

// ---- Sub-components -------------------------------------------------------

function StackedBar({
  level,
  needs,
}: {
  level: number | null;
  needs: NeedsMap;
}) {
  const filled = Math.max(0, Math.min(100, level ?? 0));
  return (
    <div
      className="flex h-3 w-full overflow-hidden rounded-full bg-pink-100/80 dark:bg-pink-950/60"
      role="img"
      aria-label={
        level == null
          ? 'no level set'
          : `tank ${level}%, with ${sumNeeds(needs)}% allocated to specific needs`
      }
    >
      {filled > 0 && (
        <div
          className="h-full bg-pink-500 transition-[width] duration-200 dark:bg-pink-400"
          style={{ width: `${filled}%` }}
        />
      )}
      {LOVE_LANGUAGES.map((k) => {
        const v = needs[k] ?? 0;
        if (v <= 0) return null;
        return (
          <div
            key={k}
            className={`h-full transition-[width] duration-200 ${NEED_META[k].barClass}`}
            style={{ width: `${v}%` }}
            title={`${NEED_META[k].label}: ${v}%`}
          />
        );
      })}
    </div>
  );
}

function NeedSlider({
  need,
  value,
  level,
  otherNeeds,
  onChange,
}: {
  need: LoveLanguage;
  value: number;
  level: number;
  otherNeeds: Partial<Record<LoveLanguage, number>>;
  onChange: (v: number) => void;
}) {
  const meta = NEED_META[need];
  const othersSum = Object.values(otherNeeds).reduce(
    (a, b) => a + (b ?? 0),
    0,
  );
  // Max = whatever's left after level + the OTHER needs. Gives this slider
  // the full remaining empty space as its headroom.
  const max = Math.max(value, 100 - level - othersSum);

  return (
    <div>
      <div className="flex items-center justify-between text-[11px]">
        <span className="flex items-center gap-1.5">
          <span aria-hidden>{meta.emoji}</span>
          <span className="text-neutral-700 dark:text-neutral-300">
            {meta.label}
          </span>
        </span>
        <span className="tabular-nums text-neutral-600 dark:text-neutral-400">
          {value}%
          {max < 100 && (
            <span className="ml-1 text-[10px] text-neutral-400">
              / {max} max
            </span>
          )}
        </span>
      </div>
      <input
        type="range"
        min={0}
        max={100}
        value={value}
        onChange={(e) => {
          const raw = Number(e.target.value);
          // If the user drags past their allotted max, clamp quietly — nicer
          // than a stuck thumb. handleNeedChange applies the real cap.
          onChange(Math.min(raw, max));
        }}
        className="block w-full accent-pink-600"
        aria-label={`${meta.label} — ${value}% of your tank`}
      />
    </div>
  );
}
