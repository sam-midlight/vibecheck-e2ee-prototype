'use client';

/**
 * Vibe Sliders — room-shared slider definitions + per-member values.
 *
 * Event model:
 *   slider_define { sliderId, title, leftLabel, rightLabel, emoji, ts }
 *     Any member may define/edit a slider. Latest-ts per sliderId wins.
 *     Re-emitting with the same sliderId is how we rename/edit (and also how
 *     we "undelete" — if a define arrives later than a delete, the slider
 *     comes back).
 *   slider_set { sliderId, value, ts }
 *     Per-member value 0–100. Latest-ts per (sliderId, senderId) wins.
 *   slider_delete { sliderId, ts }
 *     Marks the slider as deleted. UI filters it out. Values for that
 *     sliderId stay in the event log but become unreachable.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { displayName as fmtDisplayName } from '@/lib/domain/displayName';
import { describeError } from '@/lib/domain/errors';
import { uniqueMembers } from '@/lib/domain/members';
import {
  resolveDimension,
  resolvePolarity,
} from '@/lib/domain/vibeState';
import { hueForUser } from '@/lib/domain/userTheme';
import { SLIDER_DIMENSIONS, type SliderDimension, type SliderPolarity } from '@/lib/domain/events';
import { ConfettiBurst } from './ConfettiBurst';
import { avatarFallback } from './EmojiPicker';
import { ReactionBar } from './Reactions';
import { useRoom, useRoomProjection } from './RoomProvider';

/**
 * Per-slider celebration rules. Triggered when a member's own published
 * value crosses INTO the celebrated zone. Self-only — bursting on partner
 * realtime events would be jarring at scale.
 */
interface CelebrationRule {
  /** Returns true iff this value is in the "celebrate" zone. */
  inZone: (value: number) => boolean;
  emoji: string;
}

const CELEBRATIONS: Record<string, CelebrationRule> = {
  affection:          { inZone: (v) => v >= 80, emoji: '💖' },
  energy:             { inZone: (v) => v >= 80, emoji: '⚡' },
  mood:               { inZone: (v) => v >= 80, emoji: '☀️' },
  'mental bandwidth': { inZone: (v) => v >= 80, emoji: '🌿' },
  'social battery':   { inZone: (v) => v >= 80, emoji: '🥳' },
  // Hunger is inverted in the seed (0 = full, 100 = hangry). Crossing INTO
  // "well fed" is the celebrated state.
  hunger:             { inZone: (v) => v <= 15, emoji: '😌' },
};

function celebrationFor(title: string): CelebrationRule | null {
  return CELEBRATIONS[title.trim().toLowerCase()] ?? null;
}

interface Definition {
  sliderId: string;
  title: string;
  leftLabel: string;
  rightLabel: string;
  emoji: string;
  dimension?: 'physical' | 'emotional' | 'social';
  polarity?: 'normal' | 'inverted';
  /** First-ever ts this sliderId was defined at. Immutable across edits.
   *  Sort by this so editing a slider doesn't drop it to the bottom. */
  firstDefinedTs: number;
  definedTs: number;
  deletedTs: number;        // 0 if never deleted
}

interface Value {
  value: number;
  note?: string;
  ts: number;
  /**
   * Blob row id of the slider_set record that produced this value. Used as
   * the reaction target so partner notes become reactable. Empty for
   * optimistic temp records (skip reactions on those).
   */
  recordId: string;
}

interface ProjectionState {
  defs: Record<string, Definition>;
  values: Record<string, Record<string, Value>>;
}

/** Ten "Gold Standard" presets, each pre-tagged with dimension +
 *  polarity so the vector oracle can read them without auto-detection. */
const DEFAULT_SLIDERS: Array<{
  title: string;
  leftLabel: string;
  rightLabel: string;
  emoji: string;
  dimension: 'physical' | 'emotional' | 'social';
  polarity: 'normal' | 'inverted';
}> = [
  { title: 'Energy',           leftLabel: 'low',       rightLabel: 'high',      emoji: '⚡',  dimension: 'physical',  polarity: 'normal' },
  { title: 'Social Battery',   leftLabel: 'drained',   rightLabel: 'full',      emoji: '🔋', dimension: 'social',    polarity: 'normal' },
  { title: 'Mood',             leftLabel: 'low',       rightLabel: 'high',      emoji: '🌤️', dimension: 'emotional', polarity: 'normal' },
  { title: 'Focus',            leftLabel: 'scattered', rightLabel: 'sharp',     emoji: '🎯', dimension: 'physical',  polarity: 'normal' },
  { title: 'Anxiety',          leftLabel: 'calm',      rightLabel: 'frantic',   emoji: '🌀', dimension: 'emotional', polarity: 'inverted' },
  { title: 'Hunger',           leftLabel: 'full',      rightLabel: 'hangry',    emoji: '🍔', dimension: 'physical',  polarity: 'inverted' },
  { title: 'Rest',             leftLabel: 'tired',     rightLabel: 'rested',    emoji: '🛏️', dimension: 'physical',  polarity: 'normal' },
  { title: 'Affection',        leftLabel: 'distant',   rightLabel: 'close',     emoji: '💕', dimension: 'emotional', polarity: 'normal' },
  { title: 'Mental Bandwidth', leftLabel: 'saturated', rightLabel: 'spacious',  emoji: '🧠', dimension: 'physical',  polarity: 'normal' },
  { title: 'Connection',       leftLabel: 'isolated',  rightLabel: 'connected', emoji: '🤝', dimension: 'social',    polarity: 'normal' },
];

export function VibeSliders({
  highlightTitle,
  defaultCollapsed = false,
}: {
  /** Title (case-insensitive) of a slider to scroll into view + briefly grow
   *  on mount. Used by the Vibe Oracle history shortcut so tapping a line
   *  drops you straight onto the relevant slider. */
  highlightTitle?: string;
  /** Start collapsed to a chip-row preview. The home grid passes true to
   *  reduce clutter; sheet contexts leave it false so the full controls
   *  show immediately. */
  defaultCollapsed?: boolean;
} = {}) {
  const { appendEvent, myUserId, members, room } = useRoom();

  const state = useRoomProjection<ProjectionState>((acc, rec) => {
    const ev = rec.event;
    if (ev.type === 'slider_define') {
      const prev = acc.defs[ev.sliderId];
      // ignore if strictly older than what we have
      if (prev && prev.definedTs >= ev.ts) return acc;
      // Preserve the FIRST definedTs across edits so sort order stays
      // stable. Without this, editing a slider bumped its definedTs
      // and dropped it to the bottom of the list.
      const firstTs = prev ? prev.firstDefinedTs : ev.ts;
      return {
        ...acc,
        defs: {
          ...acc.defs,
          [ev.sliderId]: {
            sliderId: ev.sliderId,
            title: ev.title,
            leftLabel: ev.leftLabel,
            rightLabel: ev.rightLabel,
            emoji: ev.emoji,
            dimension: ev.dimension,
            polarity: ev.polarity,
            firstDefinedTs: firstTs,
            definedTs: ev.ts,
            deletedTs: prev?.deletedTs ?? 0,
          },
        },
      };
    }
    if (ev.type === 'slider_delete') {
      const prev = acc.defs[ev.sliderId];
      if (!prev) return acc;
      if (prev.deletedTs >= ev.ts) return acc;
      return {
        ...acc,
        defs: {
          ...acc.defs,
          [ev.sliderId]: { ...prev, deletedTs: ev.ts },
        },
      };
    }
    if (ev.type === 'slider_set') {
      const prior = acc.values[ev.sliderId]?.[rec.senderId];
      if (prior && prior.ts >= ev.ts) return acc;
      return {
        ...acc,
        values: {
          ...acc.values,
          [ev.sliderId]: {
            ...(acc.values[ev.sliderId] ?? {}),
            [rec.senderId]: {
              value: ev.value,
              note: ev.note?.trim() || undefined,
              ts: ev.ts,
              recordId: rec.id,
            },
          },
        },
      };
    }
    return acc;
  }, { defs: {}, values: {} });

  // A slider is "live" if its latest define is newer than its latest
  // delete. Sort by FIRST definedTs (immutable) — editing keeps order.
  const liveSliders = useMemo(
    () =>
      Object.values(state.defs)
        .filter((d) => d.definedTs > d.deletedTs)
        .sort((a, b) => a.firstDefinedTs - b.firstDefinedTs),
    [state.defs],
  );

  const currentMembers = useMemo(
    () => (room ? uniqueMembers(members, room.current_generation) : []),
    [members, room],
  );

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  // Sam wanted the home grid less crowded. The chip preview gives a
  // glanceable read of "where I am" without the full clutter of every
  // slider's controls. Sheet contexts override this to false.
  const [collapsed, setCollapsed] = useState(defaultCollapsed);

  async function seedDefaults() {
    setBusy(true);
    setError(null);
    try {
      // Stagger ts so the firstDefinedTs sort preserves the curated
      // ordering instead of collapsing all 10 into a tied initial sort.
      const base = Date.now();
      let i = 0;
      for (const def of DEFAULT_SLIDERS) {
        await appendEvent({
          type: 'slider_define',
          sliderId: crypto.randomUUID(),
          title: def.title,
          leftLabel: def.leftLabel,
          rightLabel: def.rightLabel,
          emoji: def.emoji,
          dimension: def.dimension,
          polarity: def.polarity,
          ts: base + i++,
        });
      }
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  async function resetToDefaults() {
    if (
      !confirm(
        'Reset to defaults? This deletes every slider in the room (custom + renamed) and reinstates the 10 presets.',
      )
    )
      return;
    setBusy(true);
    setError(null);
    try {
      const now = Date.now();
      // Tombstone every currently-live slider.
      for (const def of liveSliders) {
        await appendEvent({
          type: 'slider_delete',
          sliderId: def.sliderId,
          ts: now,
        });
      }
      // Emit fresh defaults, staggered for stable sort.
      let i = 0;
      for (const def of DEFAULT_SLIDERS) {
        await appendEvent({
          type: 'slider_define',
          sliderId: crypto.randomUUID(),
          title: def.title,
          leftLabel: def.leftLabel,
          rightLabel: def.rightLabel,
          emoji: def.emoji,
          dimension: def.dimension,
          polarity: def.polarity,
          ts: now + i++,
        });
      }
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  if (!myUserId) return null;

  return (
    <section className="rounded-2xl border border-white/50 bg-sky-50/70 p-6 text-sm shadow-xl backdrop-blur-md dark:border-white/10 dark:bg-sky-950/40">
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          aria-expanded={!collapsed}
          aria-label={collapsed ? 'expand vibe sliders' : 'collapse vibe sliders'}
          className="flex flex-1 items-center gap-2 text-left"
        >
          <span className="text-[11px] font-medium uppercase tracking-[0.18em] text-sky-800 dark:text-sky-300">
            Vibe sliders 🎚️
          </span>
          <span
            aria-hidden
            className="text-sky-600 transition-transform dark:text-sky-300"
            style={{ transform: collapsed ? 'rotate(0deg)' : 'rotate(180deg)' }}
          >
            ▾
          </span>
        </button>
        <div className="flex gap-1">
          {liveSliders.length > 0 && !adding && !collapsed && (
            <>
              <button
                onClick={() => setAdding(true)}
                disabled={busy}
                className="rounded bg-sky-900 px-2 py-1 text-xs text-white disabled:opacity-50 dark:bg-sky-200 dark:text-sky-950"
              >
                + add custom
              </button>
              <button
                onClick={() => void resetToDefaults()}
                disabled={busy}
                className="rounded border border-sky-300 px-2 py-1 text-xs text-sky-900 disabled:opacity-50 dark:border-sky-800 dark:text-sky-200"
              >
                reset to defaults
              </button>
            </>
          )}
        </div>
      </div>

      {/* Collapsed preview — chip-row of every live slider with your
          current value. Tap a chip to expand AND scroll/highlight that
          slider; tapping the empty area in the heading also expands. */}
      {collapsed && liveSliders.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {liveSliders.map((def) => {
            const myVal = state.values[def.sliderId]?.[myUserId]?.value;
            return (
              <button
                key={def.sliderId}
                type="button"
                onClick={() => setCollapsed(false)}
                className="inline-flex items-center gap-1.5 rounded-full border border-sky-200 bg-white/80 px-2.5 py-1 text-[11px] text-sky-900 shadow-sm transition-all hover:scale-[1.04] active:scale-[1.02] dark:border-sky-800 dark:bg-neutral-900/60 dark:text-sky-200"
              >
                <span aria-hidden>{def.emoji}</span>
                <span className="font-medium">{def.title}</span>
                <span className="tabular-nums opacity-70">
                  {myVal == null ? '—' : myVal}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {collapsed && liveSliders.length === 0 && (
        <p className="mt-2 text-xs text-sky-800/70 dark:text-sky-200">
          No sliders yet — expand to seed the six classics or roll your own.
        </p>
      )}

      {!collapsed && liveSliders.length === 0 && !adding && (
        <div className="mt-2 space-y-2">
          <p className="text-sky-800/80 dark:text-sky-200">
            No sliders defined yet. Seed the six classics, or roll your own ✨
          </p>
          <div className="flex gap-2">
            <button
              onClick={() => void seedDefaults()}
              disabled={busy}
              className="rounded bg-sky-900 px-3 py-1 text-xs text-white disabled:opacity-50 dark:bg-sky-200 dark:text-sky-950"
            >
              {busy ? 'seeding…' : 'seed 6 default sliders'}
            </button>
            <button
              onClick={() => setAdding(true)}
              disabled={busy}
              className="rounded border border-sky-300 px-3 py-1 text-xs text-sky-900 disabled:opacity-50 dark:border-sky-800 dark:text-sky-200"
            >
              + add custom
            </button>
          </div>
        </div>
      )}

      {!collapsed && adding && (
        <DefineForm
          mode="create"
          onCancel={() => setAdding(false)}
          onDone={() => setAdding(false)}
        />
      )}

      {!collapsed && (
        <ul className="mt-3 space-y-3">
          {liveSliders.map((def) => (
            <SliderRow
              key={def.sliderId}
              def={def}
              values={state.values[def.sliderId] ?? {}}
              myUserId={myUserId}
              memberIds={currentMembers.map((m) => m.user_id)}
              highlight={
                !!highlightTitle &&
                def.title.trim().toLowerCase() === highlightTitle.trim().toLowerCase()
              }
            />
          ))}
        </ul>
      )}

      {!collapsed && error && <p className="mt-2 text-xs text-red-600">{error}</p>}
    </section>
  );
}

// ---------------------------------------------------------------------------

function SliderRow({
  def,
  values,
  myUserId,
  memberIds,
  highlight = false,
}: {
  def: Definition;
  values: Record<string, Value>;
  myUserId: string;
  memberIds: string[];
  /** When true on mount/change, scroll into view + briefly grow once. */
  highlight?: boolean;
}) {
  const { appendEvent, displayNames, memberEmojis } = useRoom();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const liRef = useRef<HTMLLIElement>(null);
  const [pulsing, setPulsing] = useState(false);

  // One-shot highlight sequence: scroll into view, then trigger a 1.6s
  // grow-pulse via the `pulsing` class. Re-fires if `highlight` flips
  // false→true again (sheet reopened with a new target).
  useEffect(() => {
    if (!highlight) return;
    const el = liRef.current;
    if (el) {
      try {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      } catch { /* older browsers — noop */ }
    }
    setPulsing(true);
    const h = window.setTimeout(() => setPulsing(false), 1600);
    return () => window.clearTimeout(h);
  }, [highlight]);

  const myHue = hueForUser(myUserId);
  const myCurrent = values[myUserId]?.value ?? 50;
  const myCurrentNote = values[myUserId]?.note ?? '';
  const polarity: SliderPolarity = resolvePolarity(def.polarity, def.title);
  const [draft, setDraft] = useState<number>(myCurrent);
  // Polarity-adjusted score (0–100, higher is always "better"). Drives
  // the warning state that surfaces the support menu — Hunger at 90
  // counts as warning even though raw value is high.
  const adjusted = polarity === 'inverted' ? 100 - draft : draft;
  const inWarningZone = adjusted <= 25;
  // Draft starts empty — the committed note is rendered as a bubble above
  // the input, and typing here composes a REPLACEMENT that fires on Enter/blur.
  const [noteDraft, setNoteDraft] = useState<string>('');
  const [justSent, setJustSent] = useState(false);
  const publishedRef = useRef<{ value: number; note: string }>({
    value: myCurrent,
    note: myCurrentNote,
  });

  // Confetti queue — append a bust id per celebration; renders absolute
  // overlays that self-clean after their animation duration. Threshold
  // crossings only, watched against the previous *committed* value.
  const [bursts, setBursts] = useState<{ id: string; emoji: string }[]>([]);
  const prevCommittedValueRef = useRef<number>(myCurrent);
  // First mount: skip — we only want to celebrate transitions, not the
  // initial render with a value that's already in zone.
  const skippedFirstRef = useRef(false);

  useEffect(() => {
    setDraft(myCurrent);
    publishedRef.current = { ...publishedRef.current, value: myCurrent };

    if (!skippedFirstRef.current) {
      skippedFirstRef.current = true;
      prevCommittedValueRef.current = myCurrent;
      return;
    }
    const prev = prevCommittedValueRef.current;
    const cur = myCurrent;
    prevCommittedValueRef.current = cur;
    if (prev === cur) return;
    const rule = celebrationFor(def.title);
    if (!rule) return;
    if (rule.inZone(cur) && !rule.inZone(prev)) {
      const id = crypto.randomUUID();
      setBursts((b) => [...b, { id, emoji: rule.emoji }]);
      window.setTimeout(() => {
        setBursts((b) => b.filter((x) => x.id !== id));
      }, 1600);
    }
  }, [myCurrent, def.title]);

  useEffect(() => {
    publishedRef.current = { ...publishedRef.current, note: myCurrentNote };
  }, [myCurrentNote]);

  // Auto-publish value changes only (dragging slider → fires slider_set).
  // Notes are now explicit via Enter/blur — no timer.
  useEffect(() => {
    if (draft === publishedRef.current.value) return;
    const handle = setTimeout(() => {
      const value = draft;
      publishedRef.current = { ...publishedRef.current, value };
      void appendEvent({
        type: 'slider_set',
        sliderId: def.sliderId,
        value,
        note: publishedRef.current.note || undefined,
        ts: Date.now(),
      });
    }, 400);
    return () => clearTimeout(handle);
  }, [draft, def.sliderId, appendEvent]);

  async function commitNote(rawNote: string) {
    const note = rawNote.trim().slice(0, 140);
    publishedRef.current = { ...publishedRef.current, note };
    await appendEvent({
      type: 'slider_set',
      sliderId: def.sliderId,
      value: publishedRef.current.value,
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
      if (trimmed.length === 0 && !myCurrentNote) return;
      void commitNote(noteDraft);
    }
  }

  function onNoteBlur() {
    // Safety net: if they typed something and wandered off without Enter,
    // commit it anyway so they don't lose the thought.
    const trimmed = noteDraft.trim();
    if (trimmed.length > 0 && trimmed !== myCurrentNote) {
      void commitNote(noteDraft);
    }
  }

  async function remove() {
    if (!confirm(`Delete the "${def.title}" slider? Its values will disappear from the UI.`)) return;
    setBusy(true);
    setError(null);
    try {
      await appendEvent({ type: 'slider_delete', sliderId: def.sliderId, ts: Date.now() });
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  if (editing) {
    return (
      <li className="rounded border border-sky-300 bg-white p-2 dark:border-sky-700 dark:bg-neutral-950">
        <DefineForm
          mode="edit"
          existing={def}
          onCancel={() => setEditing(false)}
          onDone={() => setEditing(false)}
        />
      </li>
    );
  }

  return (
    <li
      ref={liRef}
      className={`relative overflow-visible rounded-2xl border bg-white/40 p-3 shadow-sm backdrop-blur-md transition-all duration-500 dark:bg-neutral-900/45 ${
        pulsing
          ? 'scale-[1.04] border-violet-400 shadow-[0_0_22px_rgba(139,92,246,0.45)] ring-2 ring-violet-300/70 dark:border-violet-500'
          : inWarningZone
            ? 'border-rose-300/70 dark:border-rose-700/60'
            : 'border-white/50 dark:border-white/10'
      }`}
      style={
        // Per-user CSS var: the slider thumb in globals.css reads
        // `var(--slider-hue, default)` so my track + thumb adopt my
        // theme colour. Other members' positions on the same slider
        // get their own coloured dot below.
        { '--slider-hue': myHue } as React.CSSProperties
      }
    >
      {bursts.map((b) => (
        <ConfettiBurst key={b.id} emoji={b.emoji} />
      ))}
      <div className="flex items-center justify-between text-xs">
        <span className="flex items-center gap-1">
          <span>{def.emoji}</span>
          <span className="font-medium">{def.title}</span>
        </span>
        <span className="flex items-center gap-2">
          <span className="tabular-nums text-sky-900 dark:text-sky-200">
            you · {draft}
          </span>
          <button
            onClick={() => setEditing(true)}
            disabled={busy}
            className="rounded border border-sky-300 px-1.5 py-0.5 text-[10px] disabled:opacity-50 dark:border-sky-800"
            aria-label="edit slider"
          >
            edit
          </button>
          <button
            onClick={() => void remove()}
            disabled={busy}
            className="rounded border border-red-300 px-1.5 py-0.5 text-[10px] text-red-700 disabled:opacity-50 dark:border-red-800 dark:text-red-400"
            aria-label="delete slider"
          >
            delete
          </button>
        </span>
      </div>

      <div className="mt-1 flex justify-between text-[10px] uppercase text-neutral-500">
        <span>{def.leftLabel}</span>
        <span>{def.rightLabel}</span>
      </div>

      <div className="relative mt-1 h-8 w-full">
        <div className="absolute inset-x-0 top-1/2 h-2 -translate-y-1/2 rounded bg-neutral-200/70 dark:bg-neutral-800/70" />
        {memberIds.map((uid) => {
          const v = values[uid]?.value;
          if (v == null) return null;
          const isMe = uid === myUserId;
          const emoji = memberEmojis[uid];
          const name = fmtDisplayName(uid, displayNames, myUserId, null);
          const userHue = hueForUser(uid);
          return (
            <span
              key={uid}
              className="absolute top-1/2 flex h-6 w-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-2 bg-white text-sm leading-none shadow-md backdrop-blur-md dark:bg-neutral-900"
              style={{
                left: `${v}%`,
                borderColor: userHue,
                boxShadow: isMe
                  ? `0 0 0 3px ${userHue}55, 0 4px 10px -2px ${userHue}99`
                  : `0 4px 10px -2px ${userHue}77`,
              }}
              title={`${isMe ? 'you' : name} · ${v}`}
              aria-label={`${isMe ? 'you' : name} at ${v}`}
            >
              {emoji ? (
                emoji
              ) : (
                <span className="text-[10px] font-semibold text-neutral-700 dark:text-neutral-200">
                  {avatarFallback(name)}
                </span>
              )}
            </span>
          );
        })}
      </div>

      <input
        type="range"
        min={0}
        max={100}
        value={draft}
        onChange={(e) => setDraft(Number(e.target.value))}
        className="vibe-slider mt-2 block w-full"
        aria-label={`set ${def.title}`}
      />

      {/* Support menu — surfaces only when MY current value (after
          polarity adjustment) is in the warning band. Reuses the
          existing affection_send events; no new event types. */}
      {inWarningZone && memberIds.some((u) => u !== myUserId) && (
        <SupportMenu
          sliderTitle={def.title}
          memberIds={memberIds.filter((u) => u !== myUserId)}
        />
      )}

      {myCurrentNote && (
        <div className="mt-2 flex items-start justify-between gap-2 rounded-xl border border-sky-200/70 bg-white/80 px-2 py-1 text-xs shadow-sm backdrop-blur-md dark:border-sky-800/50 dark:bg-neutral-900/70">
          <span className="italic text-sky-900/80 dark:text-sky-100">
            &ldquo;{myCurrentNote}&rdquo;
          </span>
          <button
            type="button"
            onClick={() => void commitNote('')}
            className="flex-shrink-0 rounded-full border border-sky-200 px-2 py-0.5 text-[10px] text-sky-900/70 transition-all hover:bg-sky-50 hover:text-sky-900 active:scale-[0.97] dark:border-sky-800 dark:text-sky-100 dark:hover:bg-sky-950/60"
            aria-label="clear your note"
          >
            clear
          </button>
        </div>
      )}
      <div className="mt-2 flex items-center gap-2">
        <input
          type="text"
          value={noteDraft}
          onChange={(e) => setNoteDraft(e.target.value.slice(0, 140))}
          onKeyDown={onNoteKeyDown}
          onBlur={onNoteBlur}
          placeholder={
            myCurrentNote
              ? 'write a new note — enter to replace…'
              : 'whisper a note — enter to send…'
          }
          maxLength={140}
          className="flex-1 rounded-xl border border-sky-200 bg-white/85 px-3 py-1.5 text-sm text-neutral-900 placeholder:italic placeholder:text-sky-400 outline-none transition-colors focus:border-sky-300 focus:ring-2 focus:ring-sky-300/40 dark:border-sky-800 dark:bg-neutral-950 dark:text-neutral-100"
          aria-label={`note for ${def.title}`}
        />
        {justSent && (
          <span className="flex-shrink-0 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] text-emerald-800 dark:bg-emerald-900/60 dark:text-emerald-200">
            ✓ sent
          </span>
        )}
      </div>

      {/* Partner notes: show each other member's note below the slider,
          with reactions so you can 🫂 their "running on fumes today" without
          typing. Also surfaces a Support menu pointed at THIS partner if
          their slider is in the warning band. */}
      {memberIds
        .filter((uid) => uid !== myUserId)
        .map((uid) => {
          const v = values[uid];
          if (!v) return null;
          const partnerAdjusted =
            polarity === 'inverted' ? 100 - v.value : v.value;
          const partnerInWarning = partnerAdjusted <= 25;
          if (!v.note && !partnerInWarning) return null;
          return (
            <div key={`partner-${uid}`} className="mt-1 space-y-1">
              {v.note && (
                <>
                  <p className="text-xs italic text-sky-900/70 dark:text-sky-100">
                    &ldquo;{v.note}&rdquo;
                  </p>
                  {v.recordId && !v.recordId.startsWith('temp-') && (
                    <ReactionBar targetId={v.recordId} />
                  )}
                </>
              )}
              {partnerInWarning && (
                <SupportMenu
                  sliderTitle={def.title}
                  memberIds={[uid]}
                  hint={`${fmtDisplayName(uid, displayNames, myUserId, null).split(' ')[0]} is low`}
                />
              )}
            </div>
          );
        })}

      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </li>
  );
}

// ---------------------------------------------------------------------------

/**
 * SupportMenu — surfaces under a slider that's in a polarity-adjusted
 * warning state. Reuses the affection_send events (kind=hug/high_five)
 * positioned mid-screen so the floating mark lands somewhere visible.
 * "I'm here" routes to Safe Space — that's exactly what it's for.
 */
function SupportMenu({
  sliderTitle,
  memberIds,
  hint,
}: {
  sliderTitle: string;
  memberIds: string[];
  hint?: string;
}) {
  const { appendEvent, room } = useRoom();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  // Used to compute the on-screen position of THIS slider so the
  // affection mark pins to it instead of dropping in the middle of
  // the page. Viewport-relative (0–1) so it survives different
  // screen sizes between sender and receiver.
  const containerRef = useRef<HTMLDivElement>(null);
  const recipient = memberIds[0]; // single-recipient room or first listed
  if (!recipient || !room) return null;

  function pinPosition(): { x: number; y: number } {
    const el = containerRef.current;
    if (!el) return { x: 0.5, y: 0.45 };
    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const x = window.innerWidth > 0 ? cx / window.innerWidth : 0.5;
    const y = window.innerHeight > 0 ? cy / window.innerHeight : 0.45;
    // Clamp so the mark doesn't land off-screen if the slider is
    // partly scrolled out.
    return {
      x: Math.max(0.04, Math.min(0.96, x)),
      y: Math.max(0.04, Math.min(0.96, y)),
    };
  }

  async function send(kind: 'hug' | 'high_five') {
    setBusy(true);
    try {
      const { x, y } = pinPosition();
      await appendEvent({
        type: 'affection_send',
        affectionId: crypto.randomUUID(),
        to: recipient,
        kind,
        x,
        y,
        ts: Date.now(),
      });
    } finally {
      setBusy(false);
    }
  }

  function openSafeSpace() {
    router?.push(`/rooms/${room?.id}/safe-space?compose=1`);
  }

  return (
    <div
      ref={containerRef}
      className="mt-2 flex flex-wrap items-center gap-1.5 rounded-xl border border-rose-200/70 bg-rose-50/70 px-2.5 py-1.5 text-[11px] dark:border-rose-800/60 dark:bg-rose-950/50"
    >
      <span className="font-display italic text-rose-900 dark:text-rose-100">
        {hint ?? `Your ${sliderTitle.toLowerCase()} is low`} —
      </span>
      <button
        type="button"
        onClick={() => void send('hug')}
        disabled={busy}
        className="rounded-full border border-rose-300 bg-white/80 px-2.5 py-0.5 transition-all hover:scale-[1.04] active:scale-[1.02] disabled:opacity-50 dark:border-rose-700 dark:bg-neutral-900/60"
      >
        🤗 send a hug
      </button>
      <button
        type="button"
        onClick={() => void send('high_five')}
        disabled={busy}
        className="rounded-full border border-rose-300 bg-white/80 px-2.5 py-0.5 transition-all hover:scale-[1.04] active:scale-[1.02] disabled:opacity-50 dark:border-rose-700 dark:bg-neutral-900/60"
      >
        🙌 high five
      </button>
      <button
        type="button"
        onClick={openSafeSpace}
        className="rounded-full border border-rose-300 bg-white/80 px-2.5 py-0.5 transition-all hover:scale-[1.04] active:scale-[1.02] dark:border-rose-700 dark:bg-neutral-900/60"
      >
        🛡️ I&apos;m here
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------

function DefineForm({
  mode,
  existing,
  onCancel,
  onDone,
}: {
  mode: 'create' | 'edit';
  existing?: Definition;
  onCancel: () => void;
  onDone: () => void;
}) {
  const { appendEvent } = useRoom();
  const [title, setTitle] = useState(existing?.title ?? '');
  const [leftLabel, setLeftLabel] = useState(existing?.leftLabel ?? '');
  const [rightLabel, setRightLabel] = useState(existing?.rightLabel ?? '');
  const [emoji, setEmoji] = useState(existing?.emoji ?? '✨');
  // Dimension and polarity are saved-explicit. When creating a new
  // slider we suggest defaults via the title heuristic (resolveDimension
  // / resolvePolarity); user can override before saving.
  const [dimension, setDimension] = useState<SliderDimension>(
    existing?.dimension ?? resolveDimension(undefined, existing?.title ?? ''),
  );
  const [polarity, setPolarity] = useState<SliderPolarity>(
    existing?.polarity ?? resolvePolarity(undefined, existing?.title ?? ''),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-suggest as the user types the title (only in create mode and
  // only until they manually pick).
  const [autoDim, setAutoDim] = useState(true);
  const [autoPol, setAutoPol] = useState(true);
  useEffect(() => {
    if (mode === 'edit') return;
    if (autoDim) setDimension(resolveDimension(undefined, title));
    if (autoPol) setPolarity(resolvePolarity(undefined, title));
  }, [title, mode, autoDim, autoPol]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await appendEvent({
        type: 'slider_define',
        sliderId: existing?.sliderId ?? crypto.randomUUID(),
        title: title.trim(),
        leftLabel: leftLabel.trim().slice(0, 30),
        rightLabel: rightLabel.trim().slice(0, 30),
        emoji: emoji.trim().slice(0, 8) || '✨',
        dimension,
        polarity,
        ts: Date.now(),
      });
      onDone();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      className="space-y-3 rounded-2xl border border-white/60 bg-white/80 p-4 shadow-sm backdrop-blur-md dark:border-white/10 dark:bg-neutral-900/60"
    >
      <div className="text-[11px] font-medium uppercase tracking-[0.18em] text-sky-700 dark:text-sky-300">
        {mode === 'create' ? 'New slider' : `Edit "${existing?.title}"`}
      </div>
      <div className="flex gap-2">
        <input
          type="text"
          value={emoji}
          onChange={(e) => setEmoji(e.target.value)}
          placeholder="✨"
          maxLength={8}
          className="w-16 rounded-xl border border-sky-200 bg-white/85 px-2 py-2 text-center text-base outline-none focus:border-sky-300 focus:ring-2 focus:ring-sky-300/40 dark:border-sky-800 dark:bg-neutral-950 dark:text-neutral-100"
        />
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="title (e.g. Patience)"
          required
          maxLength={60}
          className="flex-1 rounded-xl border border-sky-200 bg-white/85 px-3 py-2 text-sm text-neutral-900 placeholder:italic placeholder:text-sky-300 outline-none focus:border-sky-300 focus:ring-2 focus:ring-sky-300/40 dark:border-sky-800 dark:bg-neutral-950 dark:text-neutral-100"
        />
      </div>
      <div className="flex gap-2">
        <input
          type="text"
          value={leftLabel}
          onChange={(e) => setLeftLabel(e.target.value)}
          placeholder="left label"
          maxLength={30}
          className="flex-1 rounded-xl border border-sky-200 bg-white/85 px-3 py-2 text-sm text-neutral-900 placeholder:italic placeholder:text-sky-300 outline-none focus:border-sky-300 focus:ring-2 focus:ring-sky-300/40 dark:border-sky-800 dark:bg-neutral-950 dark:text-neutral-100"
        />
        <input
          type="text"
          value={rightLabel}
          onChange={(e) => setRightLabel(e.target.value)}
          placeholder="right label"
          maxLength={30}
          className="flex-1 rounded-xl border border-sky-200 bg-white/85 px-3 py-2 text-sm text-neutral-900 placeholder:italic placeholder:text-sky-300 outline-none focus:border-sky-300 focus:ring-2 focus:ring-sky-300/40 dark:border-sky-800 dark:bg-neutral-950 dark:text-neutral-100"
        />
      </div>
      {/* Dimension picker — drives which axis this slider feeds in the
          vibe vector. Auto-suggested from title, manually overridable. */}
      <div>
        <p className="mb-1 text-[10px] font-medium uppercase tracking-[0.14em] text-sky-700 dark:text-sky-200">
          Dimension
        </p>
        <div className="flex gap-1.5">
          {SLIDER_DIMENSIONS.map((d) => {
            const selected = dimension === d;
            return (
              <button
                key={d}
                type="button"
                onClick={() => {
                  setDimension(d);
                  setAutoDim(false);
                }}
                className={`flex-1 rounded-xl border px-2 py-1.5 text-[11px] capitalize transition-all ${
                  selected
                    ? 'border-sky-500 bg-white/95 font-medium shadow-sm dark:border-sky-400 dark:bg-neutral-900/85'
                    : 'border-sky-200 bg-white/60 hover:bg-white/80 dark:border-sky-800/60 dark:bg-neutral-900/40'
                }`}
              >
                {d.replace('_', ' ')}
              </button>
            );
          })}
        </div>
      </div>

      {/* Polarity picker — only matters for the vibe vector math. */}
      <div>
        <p className="mb-1 text-[10px] font-medium uppercase tracking-[0.14em] text-sky-700 dark:text-sky-200">
          High value means
        </p>
        <div className="flex gap-1.5">
          <button
            type="button"
            onClick={() => {
              setPolarity('normal');
              setAutoPol(false);
            }}
            className={`flex-1 rounded-xl border px-2 py-1.5 text-[11px] transition-all ${
              polarity === 'normal'
                ? 'border-emerald-500 bg-emerald-50 font-medium shadow-sm dark:border-emerald-500 dark:bg-emerald-950/60'
                : 'border-sky-200 bg-white/60 hover:bg-white/80 dark:border-sky-800/60 dark:bg-neutral-900/40'
            }`}
          >
            Good (energy, mood)
          </button>
          <button
            type="button"
            onClick={() => {
              setPolarity('inverted');
              setAutoPol(false);
            }}
            className={`flex-1 rounded-xl border px-2 py-1.5 text-[11px] transition-all ${
              polarity === 'inverted'
                ? 'border-rose-500 bg-rose-50 font-medium shadow-sm dark:border-rose-500 dark:bg-rose-950/60'
                : 'border-sky-200 bg-white/60 hover:bg-white/80 dark:border-sky-800/60 dark:bg-neutral-900/40'
            }`}
          >
            Bad (anxiety, hunger)
          </button>
        </div>
      </div>

      <div className="flex gap-2 pt-1">
        <button
          type="submit"
          disabled={busy || !title.trim()}
          className="rounded-full bg-gradient-to-br from-sky-300 via-sky-400 to-blue-500 px-5 py-2 font-display italic text-sm text-white shadow-[0_8px_20px_-4px_rgba(2,132,199,0.5),inset_0_2px_3px_rgba(255,255,255,0.45),inset_0_-3px_6px_rgba(30,64,175,0.3)] ring-1 ring-sky-200/60 transition-all hover:scale-[1.04] active:scale-[1.06] disabled:opacity-50"
        >
          {busy ? 'saving…' : mode === 'create' ? 'Add slider' : 'Save'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="rounded-full border border-sky-200 bg-white/80 px-4 py-2 font-display italic text-sm text-sky-900 transition-all hover:scale-[1.04] hover:bg-white active:scale-[1.02] disabled:opacity-50 dark:border-sky-800 dark:bg-neutral-900/60 dark:text-sky-200"
        >
          Cancel
        </button>
      </div>
      {error && <p className="text-xs text-red-600">{error}</p>}
    </form>
  );
}
