'use client';

/**
 * MemberVibePopover — read-only "check in on them" view shown inside a
 * FeatureSheet from the long-press orb action menu.
 *
 * Renders, for the chosen member:
 *   - their love-tank top need (reuses TopNeedBadge in pure-props mode)
 *   - their current value on every live slider
 *   - their love-tank level
 *   - wishlist items they've added
 *   - dates they've voted on
 *   - mind readers they've posted
 *   - time capsules they've left
 *
 * Each of the last four sections is clickable — tapping a row calls the
 * supplied onNavigate() so OrbActionMenu can close this sheet and open
 * the matching feature in a fresh sheet.
 *
 * Pure projection — no events written.
 */

import { useMemo } from 'react';
import { displayName as fmtDisplayName } from '@/lib/domain/displayName';
import { type NeedsMap } from '@/lib/domain/loveTank';
import { TopNeedBadge } from './TopNeedBadge';
import { useRoom } from './RoomProvider';

/** Features the popover can shortcut into. */
export type MemberVibeTarget =
  | 'wishlist'
  | 'dates'
  | 'mind_reader'
  | 'time_capsules';

interface SliderRow {
  sliderId: string;
  title: string;
  emoji: string;
  leftLabel: string;
  rightLabel: string;
  value: number | null;
}

interface VibeState {
  sliders: SliderRow[];
  loveTank: { level: number; needs: NeedsMap } | null;
  wishlist: { itemId: string; title: string; category: string }[];
  datesVoted: { ideaId: string; title: string }[];
  mindReaders: { gameId: string; hint: string }[];
  capsules: { capsuleId: string; unlockAt: number; hasMessage: boolean }[];
}

export function MemberVibePopover({
  uid,
  onNavigate,
}: {
  uid: string;
  onNavigate?: (target: MemberVibeTarget) => void;
}) {
  const { events, myUserId, displayNames } = useRoom();
  const isSelf = uid === myUserId;
  const subjectName = isSelf
    ? 'You'
    : fmtDisplayName(uid, displayNames, myUserId, null);

  const state = useMemo<VibeState>(() => {
    interface SliderDef {
      title: string;
      emoji: string;
      leftLabel: string;
      rightLabel: string;
      definedTs: number;
      deletedTs: number;
    }
    const defs: Record<string, SliderDef> = {};
    const vals: Record<string, { value: number; ts: number }> = {};
    let tank: { level: number; needs: NeedsMap; ts: number } | null = null;

    // Wishlist — add vs delete, authored by uid only.
    const wishlistItems: Record<string, { title: string; category: string; addedTs: number; deleted: boolean }> = {};
    // Dates — all idea titles, then filter for ones uid has voted on.
    const ideaTitles: Record<string, string> = {};
    const votedByUid = new Set<string>();
    // Mind readers — authored by uid.
    const mrGames: Record<string, { hint: string; ts: number }> = {};
    // Time capsules — authored by uid, add vs delete.
    const capsules: Record<string, { unlockAt: number; hasMessage: boolean; ts: number; deleted: boolean }> = {};

    for (const rec of events) {
      const ev = rec.event;
      if (ev.type === 'slider_define') {
        const prev = defs[ev.sliderId];
        if (!prev || ev.ts > prev.definedTs) {
          defs[ev.sliderId] = {
            title: ev.title,
            emoji: ev.emoji,
            leftLabel: ev.leftLabel,
            rightLabel: ev.rightLabel,
            definedTs: ev.ts,
            deletedTs: prev?.deletedTs ?? 0,
          };
        }
      } else if (ev.type === 'slider_delete') {
        const prev = defs[ev.sliderId];
        if (prev && ev.ts > prev.deletedTs) {
          defs[ev.sliderId] = { ...prev, deletedTs: ev.ts };
        }
      } else if (ev.type === 'slider_set' && rec.senderId === uid) {
        const prior = vals[ev.sliderId];
        if (!prior || ev.ts > prior.ts) {
          vals[ev.sliderId] = { value: ev.value, ts: ev.ts };
        }
      } else if (ev.type === 'love_tank_set' && rec.senderId === uid) {
        if (!tank || ev.ts > tank.ts) {
          tank = {
            level: ev.level,
            needs: (ev.needs as NeedsMap | undefined) ?? {},
            ts: ev.ts,
          };
        }
      } else if (ev.type === 'wishlist_add' && rec.senderId === uid) {
        if (!wishlistItems[ev.itemId]) {
          wishlistItems[ev.itemId] = {
            title: ev.title,
            category: ev.category,
            addedTs: ev.ts,
            deleted: false,
          };
        }
      } else if (ev.type === 'wishlist_delete') {
        const item = wishlistItems[ev.itemId];
        if (item) item.deleted = true;
      } else if (ev.type === 'date_idea_add') {
        ideaTitles[ev.ideaId] = ev.title;
      } else if (ev.type === 'date_idea_vote' && rec.senderId === uid) {
        votedByUid.add(ev.ideaId);
      } else if (ev.type === 'mind_reader_post' && rec.senderId === uid) {
        mrGames[ev.gameId] = { hint: ev.hint, ts: ev.ts };
      } else if (ev.type === 'time_capsule_post' && rec.senderId === uid) {
        if (!capsules[ev.capsuleId]) {
          capsules[ev.capsuleId] = {
            unlockAt: ev.unlockAt,
            hasMessage: !!ev.message && ev.message.trim().length > 0,
            ts: ev.ts,
            deleted: false,
          };
        }
      } else if (ev.type === 'time_capsule_delete') {
        const c = capsules[ev.capsuleId];
        if (c) c.deleted = true;
      }
    }

    const sliders: SliderRow[] = Object.entries(defs)
      .filter(([, d]) => d.definedTs > d.deletedTs)
      .sort((a, b) => a[1].definedTs - b[1].definedTs)
      .map(([sliderId, d]) => ({
        sliderId,
        title: d.title,
        emoji: d.emoji,
        leftLabel: d.leftLabel,
        rightLabel: d.rightLabel,
        value: vals[sliderId]?.value ?? null,
      }));

    const wishlist = Object.entries(wishlistItems)
      .filter(([, it]) => !it.deleted)
      .sort((a, b) => b[1].addedTs - a[1].addedTs)
      .map(([itemId, it]) => ({ itemId, title: it.title, category: it.category }));

    const datesVoted = [...votedByUid]
      .map((ideaId) => ({ ideaId, title: ideaTitles[ideaId] ?? '(idea no longer exists)' }))
      .slice(0, 20);

    const mindReaders = Object.entries(mrGames)
      .sort((a, b) => b[1].ts - a[1].ts)
      .slice(0, 10)
      .map(([gameId, g]) => ({ gameId, hint: g.hint }));

    const capsuleList = Object.entries(capsules)
      .filter(([, c]) => !c.deleted)
      .sort((a, b) => a[1].unlockAt - b[1].unlockAt)
      .map(([capsuleId, c]) => ({
        capsuleId,
        unlockAt: c.unlockAt,
        hasMessage: c.hasMessage,
      }));

    return {
      sliders,
      loveTank: tank
        ? { level: tank.level, needs: tank.needs }
        : null,
      wishlist,
      datesVoted,
      mindReaders,
      capsules: capsuleList,
    };
  }, [events, uid]);

  return (
    <div className="space-y-4 pb-2">
      <TopNeedBadge
        needs={state.loveTank?.needs ?? {}}
        level={state.loveTank?.level}
        subjectLabel={isSelf ? 'Your top need' : `${subjectName}'s top need`}
        balancedCopy={
          state.loveTank?.level === 100
            ? 'Tank is full ✨'
            : state.loveTank
              ? 'Tank is balanced ✨'
              : `${isSelf ? 'You haven\u2019t' : subjectName + ' hasn\u2019t'} set a love-tank level yet`
        }
      />

      <SectionCard emoji="🎚️" title="Sliders" accent="rose">
        {state.sliders.length === 0 ? (
          <p className="text-sm text-neutral-500">No sliders defined yet.</p>
        ) : (
          <ul className="space-y-3">
            {state.sliders.map((s) => (
              <li key={s.sliderId}>
                <div className="flex items-center justify-between text-xs">
                  <span className="flex items-center gap-1.5 text-neutral-800 dark:text-neutral-200">
                    <span aria-hidden>{s.emoji}</span>
                    <span className="font-medium">{s.title}</span>
                  </span>
                  <span className="tabular-nums text-neutral-600 dark:text-neutral-400">
                    {s.value == null ? '—' : `${s.value}`}
                  </span>
                </div>
                <div className="mt-1 flex justify-between text-[10px] uppercase text-neutral-400">
                  <span>{s.leftLabel}</span>
                  <span>{s.rightLabel}</span>
                </div>
                <div className="relative mt-1 h-1.5 w-full overflow-hidden rounded-full bg-neutral-200/70 dark:bg-neutral-800/70">
                  {s.value != null && (
                    <div
                      className="h-full rounded-full bg-gradient-to-r from-violet-400 to-pink-400"
                      style={{ width: `${s.value}%` }}
                    />
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <SectionCard
        emoji="🎁"
        title="Wishlist"
        count={state.wishlist.length}
        accent="amber"
        onOpenAll={onNavigate ? () => onNavigate('wishlist') : undefined}
      >
        {state.wishlist.length === 0 ? (
          <p className="text-sm text-neutral-500">
            {isSelf ? 'You haven\u2019t' : subjectName + ' hasn\u2019t'} added anything yet.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {state.wishlist.slice(0, 6).map((w) => (
              <ShortcutRow
                key={w.itemId}
                label={w.title}
                hint={w.category}
                onClick={onNavigate ? () => onNavigate('wishlist') : undefined}
              />
            ))}
            {state.wishlist.length > 6 && (
              <p className="pt-1 text-[11px] text-neutral-500">
                +{state.wishlist.length - 6} more in their wishlist
              </p>
            )}
          </ul>
        )}
      </SectionCard>

      <SectionCard
        emoji="💕"
        title="Dates they voted on"
        count={state.datesVoted.length}
        accent="pink"
        onOpenAll={onNavigate ? () => onNavigate('dates') : undefined}
      >
        {state.datesVoted.length === 0 ? (
          <p className="text-sm text-neutral-500">No votes yet.</p>
        ) : (
          <ul className="space-y-1.5">
            {state.datesVoted.slice(0, 6).map((d) => (
              <ShortcutRow
                key={d.ideaId}
                label={d.title}
                onClick={onNavigate ? () => onNavigate('dates') : undefined}
              />
            ))}
            {state.datesVoted.length > 6 && (
              <p className="pt-1 text-[11px] text-neutral-500">
                +{state.datesVoted.length - 6} more
              </p>
            )}
          </ul>
        )}
      </SectionCard>

      <SectionCard
        emoji="🔮"
        title="Mind readers"
        count={state.mindReaders.length}
        accent="indigo"
        onOpenAll={onNavigate ? () => onNavigate('mind_reader') : undefined}
      >
        {state.mindReaders.length === 0 ? (
          <p className="text-sm text-neutral-500">
            {isSelf ? 'You haven\u2019t' : subjectName + ' hasn\u2019t'} posted one yet.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {state.mindReaders.map((g) => (
              <ShortcutRow
                key={g.gameId}
                label={`"${g.hint}"`}
                italic
                onClick={onNavigate ? () => onNavigate('mind_reader') : undefined}
              />
            ))}
          </ul>
        )}
      </SectionCard>

      <SectionCard
        emoji="⏳"
        title="Time capsules"
        count={state.capsules.length}
        accent="sky"
        onOpenAll={onNavigate ? () => onNavigate('time_capsules') : undefined}
      >
        {state.capsules.length === 0 ? (
          <p className="text-sm text-neutral-500">
            {isSelf ? 'You haven\u2019t' : subjectName + ' hasn\u2019t'} sealed any capsules.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {state.capsules.map((c) => (
              <ShortcutRow
                key={c.capsuleId}
                label={`Unlocks ${formatFutureDate(c.unlockAt)}`}
                hint={c.hasMessage ? 'with a message' : 'sealed'}
                onClick={onNavigate ? () => onNavigate('time_capsules') : undefined}
              />
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Visual helpers
// ---------------------------------------------------------------------------

type Accent = 'rose' | 'amber' | 'pink' | 'indigo' | 'sky';

function SectionCard({
  emoji,
  title,
  count,
  accent: _accent,
  onOpenAll,
  children,
}: {
  emoji: string;
  title: string;
  count?: number;
  accent: Accent;
  onOpenAll?: () => void;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-white/60 bg-white/75 p-4 shadow-sm backdrop-blur-md dark:border-white/10 dark:bg-neutral-900/55">
      <header className="flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.18em] text-neutral-500">
          <span aria-hidden className="text-sm">{emoji}</span>
          <span>{title}</span>
          {count != null && count > 0 && (
            <span className="tabular-nums text-neutral-400">· {count}</span>
          )}
        </h3>
        {onOpenAll && (
          <button
            type="button"
            onClick={onOpenAll}
            className="rounded-full border border-neutral-200 bg-white/70 px-3 py-1 font-display italic text-[11px] text-neutral-700 transition-all hover:scale-[1.04] hover:bg-white active:scale-[1.02] dark:border-neutral-700 dark:bg-neutral-800/60 dark:text-neutral-300"
          >
            Open →
          </button>
        )}
      </header>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function ShortcutRow({
  label,
  hint,
  italic,
  onClick,
}: {
  label: string;
  hint?: string;
  italic?: boolean;
  onClick?: () => void;
}) {
  const body = (
    <>
      <span className={`min-w-0 flex-1 truncate text-sm ${italic ? 'italic' : ''} text-neutral-800 dark:text-neutral-200`}>
        {label}
      </span>
      {hint && (
        <span className="flex-shrink-0 text-[11px] font-medium uppercase tracking-[0.18em] text-neutral-400">
          {hint}
        </span>
      )}
      {onClick && (
        <span aria-hidden className="flex-shrink-0 text-neutral-400">→</span>
      )}
    </>
  );
  if (!onClick) {
    return (
      <li className="flex items-center gap-2 rounded-xl border border-neutral-200/60 bg-white/50 px-3 py-2 dark:border-neutral-700/60 dark:bg-neutral-900/40">
        {body}
      </li>
    );
  }
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className="group flex w-full items-center gap-2 rounded-xl border border-neutral-200/60 bg-white/60 px-3 py-2 text-left transition-all hover:scale-[1.02] hover:border-neutral-300 hover:bg-white/90 active:scale-[1.01] dark:border-neutral-700/60 dark:bg-neutral-900/40 dark:hover:bg-neutral-900/70"
      >
        {body}
      </button>
    </li>
  );
}

function formatFutureDate(ts: number): string {
  const d = new Date(ts);
  const now = Date.now();
  const diffDays = Math.round((ts - now) / (1000 * 60 * 60 * 24));
  if (diffDays > 0 && diffDays <= 30) {
    return `in ${diffDays}d (${d.toLocaleDateString()})`;
  }
  if (diffDays < 0) {
    return `${d.toLocaleDateString()} (ready)`;
  }
  return d.toLocaleDateString();
}
