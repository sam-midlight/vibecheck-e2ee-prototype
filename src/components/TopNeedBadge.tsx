'use client';

/**
 * Glanceable "what does my partner need most?" badge.
 *
 * Two entry points:
 *   - <TopNeedBadge needs={…} level={…} /> — pure/props form, portable to
 *     any surface (native widget wrapper, export preview, etc).
 *   - <MyTopNeedBadge /> — reads the current user's love-tank projection
 *     from RoomProvider. Drop-in for dashboards.
 *
 * Visual: a small glass card with a coloured dot per need, the emoji + label,
 * the percentage, and a status line. On a tie it lists every tied need so
 * the UI never quietly hides one. On "all zero" (tank full or unassigned)
 * it renders a friendly "balanced" state.
 */

import { useMemo, useState } from 'react';
import { FeatureSheet } from './FeatureSheet';
import { MemberVibePopover } from './MemberVibePopover';
import {
  LOVE_LANGUAGES,
  type LoveLanguage,
} from '@/lib/domain/events';
import {
  getTopNeed,
  NEED_EMOJI,
  NEED_LABEL,
  type NeedsMap,
  type TopNeedResult,
} from '@/lib/domain/loveTank';
import { HelpIcon } from './HelpIcon';
import { useRoom, useRoomProjection } from './RoomProvider';

// ---- Visuals --------------------------------------------------------------

const NEED_TONE: Record<
  LoveLanguage,
  { bar: string; chip: string; dot: string }
> = {
  quality_time: {
    bar: 'from-sky-400/80 to-sky-500/80',
    chip: 'border-sky-300 bg-sky-50 text-sky-900 dark:border-sky-700 dark:bg-sky-950/60 dark:text-sky-200',
    dot: 'bg-sky-500 dark:bg-sky-400',
  },
  physical_affection: {
    bar: 'from-rose-400/80 to-rose-500/80',
    chip: 'border-rose-300 bg-rose-50 text-rose-900 dark:border-rose-700 dark:bg-rose-950/60 dark:text-rose-200',
    dot: 'bg-rose-500 dark:bg-rose-400',
  },
  words_of_affirmation: {
    bar: 'from-amber-400/80 to-amber-500/80',
    chip: 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-700 dark:bg-amber-950/60 dark:text-amber-200',
    dot: 'bg-amber-500 dark:bg-amber-400',
  },
  acts_of_service: {
    bar: 'from-emerald-400/80 to-emerald-500/80',
    chip: 'border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-200',
    dot: 'bg-emerald-500 dark:bg-emerald-400',
  },
  gifts: {
    bar: 'from-violet-400/80 to-violet-500/80',
    chip: 'border-violet-300 bg-violet-50 text-violet-900 dark:border-violet-700 dark:bg-violet-950/60 dark:text-violet-200',
    dot: 'bg-violet-500 dark:bg-violet-400',
  },
};

// ---- Pure/props form ------------------------------------------------------

export function TopNeedBadge({
  needs,
  level,
  subjectLabel = 'Top need',
  balancedCopy,
  onClick,
}: {
  /** The decrypted needs map for whoever we're summarizing. */
  needs: NeedsMap;
  /** Tank level (0–100). Used only to tailor the balanced-state message. */
  level?: number;
  /** Header label above the result, e.g. "Top need", "Sam's top need". */
  subjectLabel?: string;
  /** Custom balanced-state copy. Omit for sensible defaults. */
  balancedCopy?: string;
  /** Optional click handler — renders the badge as a button. */
  onClick?: () => void;
}) {
  const top = useMemo(() => getTopNeed(needs), [needs]);
  const balancedText =
    balancedCopy ??
    (level === 100
      ? 'Tank is full ✨'
      : level != null && level > 0
        ? 'Tank is balanced ✨'
        : 'Nothing allocated yet');

  const Wrapper: React.ElementType = onClick ? 'button' : 'section';
  const wrapperProps = onClick
    ? {
        type: 'button' as const,
        onClick,
        'aria-label': `Open ${subjectLabel}`,
      }
    : {};

  return (
    <Wrapper
      {...wrapperProps}
      className={`block w-full text-left rounded-2xl border border-white/60 bg-white/70 p-5 text-sm shadow-lg backdrop-blur-md transition-transform duration-200 ease-out dark:border-white/10 dark:bg-neutral-900/60 ${
        onClick ? 'cursor-pointer hover:scale-[1.02] active:scale-[0.99]' : 'hover:scale-[1.02]'
      }`}
    >
      <header className="flex items-center justify-between text-[11px] font-medium uppercase tracking-[0.1em] text-neutral-500">
        <span className="flex items-center gap-1.5">
          <span>{subjectLabel}</span>
          {!onClick && (
            <HelpIcon
              label="Top need"
              text="This reads from your Love Tank. When your tank isn't full, you can tell us what would help fill it (quality time, words of affirmation, physical affection, acts of service, gifts) — this widget surfaces whichever one is showing up loudest right now so your partner has a clear cue."
            />
          )}
        </span>
        {level != null && <LoveTankHeart level={level} />}
      </header>

      {top ? <TopFillBody result={top} /> : <BalancedBody copy={balancedText} />}
    </Wrapper>
  );
}

// ---- Room-context form ----------------------------------------------------

/**
 * Dashboard convenience: reads the current viewer's latest love-tank state
 * straight from the room projection and renders a TopNeedBadge for it.
 * Perfect for the widgets sidebar or a mobile summary.
 */
export function MyTopNeedBadge() {
  // Renamed semantically: this widget shows the OTHER members' top
  // needs, not the viewer's own. The "what does my partner need from
  // me right now" framing is more useful than self-reflection. Kept
  // the export name so call sites don't need updating.
  const { myUserId, members, room, displayNames, memberEmojis } = useRoom();
  const [target, setTarget] = useState<string | null>(null);
  const state = useRoomProjection<
    Record<string, { level: number; needs: NeedsMap; ts: number }>
  >((acc, rec) => {
    if (rec.event.type !== 'love_tank_set') return acc;
    const prev = acc[rec.senderId];
    if (prev && prev.ts > rec.event.ts) return acc;
    return {
      ...acc,
      [rec.senderId]: {
        level: rec.event.level,
        needs: (rec.event.needs as NeedsMap | undefined) ?? {},
        ts: rec.event.ts,
      },
    };
  }, {});

  if (!myUserId || !room) return null;

  const others = members
    .filter((m) => m.generation === room.current_generation)
    .filter((m) => m.user_id !== myUserId)
    // Dedupe by user_id (multi-device users have multiple member rows).
    .filter(
      (m, i, arr) => arr.findIndex((x) => x.user_id === m.user_id) === i,
    );

  if (others.length === 0) {
    return (
      <section className="rounded-2xl border border-white/60 bg-white/70 p-5 text-sm shadow-lg backdrop-blur-md dark:border-white/10 dark:bg-neutral-900/60">
        <header className="text-[11px] font-medium uppercase tracking-[0.1em] text-neutral-500">
          Their top need
        </header>
        <p className="mt-3 text-sm leading-relaxed text-neutral-500">
          Invite someone into this room to see what they need from you.
        </p>
      </section>
    );
  }

  // 3+ rooms (me + 2 others) collapse the per-member cards under a
  // single "Group needs" section to keep the sidebar from growing
  // proportionally with party size. Default open so the data stays
  // glanceable; toggle to hide.
  const isGroup = others.length >= 2;
  const cards = others.map((m) => {
    const entry = state[m.user_id];
    const needs = entry?.needs ?? {};
    const level = entry?.level;
    const name =
      displayNames[m.user_id]?.trim() || m.user_id.slice(0, 6);
    const emoji = memberEmojis[m.user_id];
    const possessive = name.endsWith('s') ? `${name}'` : `${name}'s`;
    const label = emoji
      ? `${emoji} ${possessive} top need`
      : `${possessive} top need`;
    return (
      <TopNeedBadge
        key={m.user_id}
        needs={needs}
        level={level}
        subjectLabel={label}
        onClick={() => setTarget(m.user_id)}
      />
    );
  });

  return (
    <>
      {isGroup ? (
        <GroupNeedsSection count={others.length}>
          <div className="space-y-2">{cards}</div>
        </GroupNeedsSection>
      ) : (
        <div className="space-y-2">{cards}</div>
      )}
      {target && (
        <FeatureSheet
          title={`${displayNames[target]?.trim() || target.slice(0, 6)}\u2019s vibe`}
          emoji="✨"
          onClose={() => setTarget(null)}
        >
          <MemberVibePopover uid={target} />
        </FeatureSheet>
      )}
    </>
  );
}

// ---- Group wrapper (3+ members) -------------------------------------------

function GroupNeedsSection({
  count,
  children,
}: {
  count: number;
  children: React.ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <section className="rounded-2xl border border-white/60 bg-white/65 p-3 shadow-lg backdrop-blur-md dark:border-white/10 dark:bg-neutral-900/60">
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        aria-expanded={!collapsed}
        aria-label={collapsed ? 'expand group needs' : 'collapse group needs'}
        className="flex w-full items-center justify-between gap-2 text-left"
      >
        <span className="flex items-center gap-2">
          <span className="text-[11px] font-medium uppercase tracking-[0.18em] text-neutral-700 dark:text-neutral-300">
            Group needs
          </span>
          <span className="rounded-full bg-neutral-900/10 px-2 py-0.5 font-mono text-[10px] tabular-nums text-neutral-700 dark:bg-white/15 dark:text-neutral-200">
            {count}
          </span>
        </span>
        <span
          aria-hidden
          className="text-neutral-500 transition-transform dark:text-neutral-400"
          style={{ transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)' }}
        >
          ▾
        </span>
      </button>
      {!collapsed && <div className="mt-3">{children}</div>}
    </section>
  );
}

// ---- Internal renderers ---------------------------------------------------

function TopFillBody({ result }: { result: TopNeedResult }) {
  const { needs, value } = result;
  const isTie = needs.length > 1;
  return (
    <div className="mt-3 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {needs.map((k) => (
          <span
            key={k}
            className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 ${NEED_TONE[k].chip}`}
          >
            <span aria-hidden className="text-base">{NEED_EMOJI[k]}</span>
            <span className="font-display italic text-base">{NEED_LABEL[k]}</span>
          </span>
        ))}
      </div>
      <p className="text-sm leading-relaxed text-neutral-600 dark:text-neutral-400">
        {isTie ? (
          <>
            {needs.length} needs tied at{' '}
            <span className="font-medium tabular-nums text-neutral-800 dark:text-neutral-200">
              {value}%
            </span>{' '}
            each — a little of any would land.
          </>
        ) : (
          <>
            Showing up here most right now. A little{' '}
            <span className="font-medium text-neutral-800 dark:text-neutral-200">
              {NEED_LABEL[needs[0]].toLowerCase()}
            </span>{' '}
            would go far.
          </>
        )}
      </p>
    </div>
  );
}

/**
 * LoveTankHeart — small filled heart with the tank level (%) overlaid in
 * white. Lets the widget header carry your tank fullness at a glance,
 * matched to the Love Tank feature's visual language.
 */
function LoveTankHeart({ level }: { level: number }) {
  return (
    <span
      className="relative inline-flex items-center justify-center"
      title={`Love tank · ${level}%`}
      aria-label={`love tank ${level} percent`}
    >
      <svg
        viewBox="0 0 24 22"
        className="h-7 w-7 drop-shadow-sm"
        fill="currentColor"
        aria-hidden
        style={{ color: `hsl(${340 + Math.min(20, level / 5)}, 75%, 60%)` }}
      >
        <path d="M12 21s-7-4.35-7-11a4 4 0 0 1 7-2.65A4 4 0 0 1 19 10c0 6.65-7 11-7 11z" />
      </svg>
      <span className="pointer-events-none absolute inset-0 flex items-center justify-center pt-0.5 text-[9px] font-bold tabular-nums text-white">
        {level}
      </span>
    </span>
  );
}

function BalancedBody({ copy }: { copy: string }) {
  return (
    <div className="mt-2 flex items-center gap-2">
      <span
        aria-hidden
        className="inline-flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300"
      >
        ✨
      </span>
      <p className="text-sm font-medium text-neutral-800 dark:text-neutral-200">
        {copy}
      </p>
    </div>
  );
}

// ---- Type re-exports (for callers that want them alongside the component)

export { LOVE_LANGUAGES };
