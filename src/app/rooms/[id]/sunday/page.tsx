'use client';

/**
 * Sunday Vibe Report — full-screen celebratory summary of the last 7 days.
 *
 * Route: /rooms/[id]/sunday. Mounted inside AppShell + RoomProvider so the
 * report has access to the decrypted event stream via `useRoom()`. All
 * aggregation runs on the client in `generateWeekReport()`; the server
 * never sees plaintext of anything being counted here.
 */

import { use, useMemo } from 'react';
import Link from 'next/link';
import { AppShell } from '@/components/AppShell';
import { Loading } from '@/components/OrganicLoader';
import {
  RoomProvider,
  useRoom,
  type RoomEventRecord,
} from '@/components/RoomProvider';
import { displayName } from '@/lib/domain/displayName';
import {
  NEED_EMOJI,
  NEED_LABEL,
} from '@/lib/domain/loveTank';
import {
  formatReportDate,
  generateWeekReport,
  type WeekReport,
} from '@/lib/domain/weekReport';

export default function SundayReportPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: roomId } = use(params);
  return (
    <AppShell requireAuth>
      <RoomProvider roomId={roomId}>
        <ReportInner />
      </RoomProvider>
    </AppShell>
  );
}

function ReportInner() {
  const { room, members, events, myUserId, displayNames, loading, error } =
    useRoom();

  const currentMemberIds = useMemo(
    () =>
      room
        ? members
            .filter((m) => m.generation === room.current_generation)
            .map((m) => m.user_id)
        : [],
    [room, members],
  );

  const report = useMemo<WeekReport | null>(() => {
    if (!room) return null;
    return generateWeekReport({
      events,
      memberIds: currentMemberIds,
      roomKind: room.kind,
    });
  }, [events, currentMemberIds, room]);

  if (loading) return <div className="p-8"><Loading /></div>;
  if (error) {
    return (
      <div className="mx-auto mt-8 max-w-xl rounded-2xl border border-red-300/60 bg-red-50/70 p-5 text-sm text-red-900 shadow-lg backdrop-blur-md">
        {error}
      </div>
    );
  }
  if (!room || !myUserId || !report) return null;

  const isPair = report.roomKind === 'pair';
  const voice = isPair ? 'you & your partner' : 'the crew';
  const empty = report.eventCount === 0;

  return (
    <div className="mx-auto max-w-4xl space-y-6 pb-20 pt-6">
      <Header
        subject={voice}
        weekEnd={report.weekEnd}
        roomId={room.id}
      />

      {empty ? (
        <EmptyState />
      ) : (
        <>
          <MoodTimelineCard
            events={events}
            memberIds={currentMemberIds}
            myUserId={myUserId}
            displayNames={displayNames}
          />
          <HeartFlowCard
            report={report}
            myUserId={myUserId}
            displayNames={displayNames}
          />
          <div className="grid gap-4 md:grid-cols-2">
            <SocialBatteryCard report={report} />
            <HighestVibeDayCard report={report} />
            <GratitudeCard
              report={report}
              myUserId={myUserId}
              displayNames={displayNames}
            />
            <LoveTankCard
              report={report}
              myUserId={myUserId}
              displayNames={displayNames}
            />
            <SafeSpaceCard report={report} />
            <DatesCard report={report} />
            <TopNeedCard report={report} />
            <EngagementCard report={report} />
          </div>
        </>
      )}

      <Footer roomId={room.id} />
    </div>
  );
}

// --------------------------------------------------------------------------
// Layout pieces
// --------------------------------------------------------------------------

function Header({
  subject,
  weekEnd,
  roomId,
}: {
  subject: string;
  weekEnd: string;
  roomId: string;
}) {
  const today = formatReportDate(weekEnd);
  return (
    <section className="relative overflow-hidden rounded-3xl border border-white/60 bg-gradient-to-br from-pink-100/80 via-amber-50/80 to-sky-100/80 p-8 shadow-xl backdrop-blur-md dark:border-white/10 dark:from-pink-950/40 dark:via-amber-950/40 dark:to-sky-950/40">
      <p className="text-xs uppercase tracking-[0.25em] text-neutral-500">
        Sunday vibe report
      </p>
      <h1 className="mt-3 font-display italic text-4xl tracking-tight sm:text-5xl">
        How {subject} <span className="whitespace-nowrap">showed up.</span>
      </h1>
      <p className="mt-3 text-sm text-neutral-600 dark:text-neutral-300">
        The last seven days, in numbers only you can see. {today}.
      </p>
      <div className="mt-5 flex flex-wrap gap-2">
        <Link
          href={`/rooms/${roomId}`}
          className="rounded-full border border-white/60 bg-white/70 px-3 py-1.5 text-xs text-neutral-700 shadow-sm backdrop-blur-md transition-all hover:bg-white/90 active:scale-[0.98] dark:border-white/10 dark:bg-neutral-900/60 dark:text-neutral-300"
        >
          ← back to room
        </Link>
      </div>
    </section>
  );
}

function EmptyState() {
  return (
    <section className="rounded-3xl border border-white/50 bg-white/60 p-8 text-center shadow-lg backdrop-blur-md dark:border-white/10 dark:bg-neutral-900/50">
      <p className="text-4xl" aria-hidden>
        🌿
      </p>
      <h2 className="mt-3 text-lg font-semibold">A quiet week.</h2>
      <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
        No activity in the last seven days to summarize. Come back next Sunday —
        or drop a slider, a gratitude, or a safe-space note and watch this page
        light up.
      </p>
    </section>
  );
}

function Footer({ roomId }: { roomId: string }) {
  return (
    <section className="rounded-2xl border border-white/50 bg-white/60 p-5 text-center text-xs text-neutral-500 shadow-lg backdrop-blur-md dark:border-white/10 dark:bg-neutral-900/50">
      <p>
        Every number on this page was computed on your device from your
        encrypted room state. Our server saw none of it.{' '}
        <Link
          href={`/rooms/${roomId}/report`}
          className="underline hover:text-neutral-700 dark:hover:text-neutral-300"
        >
          See the 14-day report →
        </Link>
      </p>
    </section>
  );
}

// --------------------------------------------------------------------------
// Stat cards
// --------------------------------------------------------------------------

function StatCard({
  tone,
  label,
  value,
  detail,
  emoji,
}: {
  tone: 'pink' | 'sky' | 'amber' | 'emerald' | 'rose' | 'violet';
  label: string;
  value: React.ReactNode;
  detail?: React.ReactNode;
  emoji?: string;
}) {
  const toneBg: Record<typeof tone, string> = {
    pink: 'from-pink-50/80 to-pink-100/60 dark:from-pink-950/40 dark:to-pink-900/30',
    sky: 'from-sky-50/80 to-sky-100/60 dark:from-sky-950/40 dark:to-sky-900/30',
    amber:
      'from-amber-50/80 to-amber-100/60 dark:from-amber-950/40 dark:to-amber-900/30',
    emerald:
      'from-emerald-50/80 to-emerald-100/60 dark:from-emerald-950/40 dark:to-emerald-900/30',
    rose: 'from-rose-50/80 to-rose-100/60 dark:from-rose-950/40 dark:to-rose-900/30',
    violet:
      'from-violet-50/80 to-violet-100/60 dark:from-violet-950/40 dark:to-violet-900/30',
  } as const;
  return (
    <section
      className={`rounded-3xl border border-white/60 bg-gradient-to-br ${toneBg[tone]} p-6 shadow-lg backdrop-blur-md dark:border-white/10`}
    >
      <div className="flex items-start justify-between gap-3">
        <p className="text-[10px] uppercase tracking-[0.2em] text-neutral-500">
          {label}
        </p>
        {emoji && (
          <span aria-hidden className="text-2xl leading-none">
            {emoji}
          </span>
        )}
      </div>
      <div className="mt-3 font-display italic text-3xl tracking-tight text-neutral-900 dark:text-neutral-100 sm:text-4xl">
        {value}
      </div>
      {detail && (
        <p className="mt-2 text-xs text-neutral-600 dark:text-neutral-400">
          {detail}
        </p>
      )}
    </section>
  );
}

function SocialBatteryCard({ report }: { report: WeekReport }) {
  return (
    <StatCard
      tone="sky"
      emoji="🔋"
      label="Average social battery"
      value={
        report.avgSocialBattery != null ? `${report.avgSocialBattery}%` : '—'
      }
      detail={
        report.avgSocialBattery == null
          ? 'No "social battery" slider recorded this week.'
          : report.avgSocialBattery >= 70
            ? 'Running high — plenty of capacity for the people you love.'
            : report.avgSocialBattery >= 40
              ? 'Middle of the dial. Some days on, some days off.'
              : 'A quieter week. Honor the rest.'
      }
    />
  );
}

function HighestVibeDayCard({ report }: { report: WeekReport }) {
  const day = report.highestVibeDay;
  return (
    <StatCard
      tone="amber"
      emoji="☀️"
      label="Highest-vibe day"
      value={day ? formatReportDate(day.date) : '—'}
      detail={
        day
          ? `Slider avg of ${day.avg}% across everyone, everything.`
          : 'No slider activity logged yet.'
      }
    />
  );
}

function GratitudeCard({
  report,
  myUserId,
  displayNames,
}: {
  report: WeekReport;
  myUserId: string;
  displayNames: Record<string, string>;
}) {
  const total = report.totalHeartsSent;
  const generous = report.mostGenerousUserId;
  return (
    <StatCard
      tone="rose"
      emoji="❤️"
      label="Total gratitude exchanged"
      value={`${total} ♥`}
      detail={
        generous && total > 0 ? (
          <>
            Most generous this week:{' '}
            <span className="font-medium text-neutral-800 dark:text-neutral-200">
              {displayName(generous, displayNames, myUserId)}
            </span>{' '}
            with {report.heartsSentByMember[generous]} sent.
          </>
        ) : (
          'No hearts sent this week — a gentle nudge?'
        )
      }
    />
  );
}

function LoveTankCard({
  report,
  myUserId,
  displayNames,
}: {
  report: WeekReport;
  myUserId: string;
  displayNames: Record<string, string>;
}) {
  const entries = Object.entries(report.daysAtFullTank).sort(
    (a, b) => b[1] - a[1],
  );
  const avg = report.avgTankLevel;
  return (
    <StatCard
      tone="pink"
      emoji="💖"
      label="Days at 100% love tank"
      value={
        entries.length === 0
          ? '—'
          : entries.map(([, n]) => n).reduce((a, b) => a + b, 0)
      }
      detail={
        entries.length === 0 ? (
          avg != null ? (
            `Tank averaged ${avg}% across the week, but no one hit 100 yet.`
          ) : (
            'No tank readings this week.'
          )
        ) : (
          <>
            {entries.slice(0, 3).map(([uid, n], i) => (
              <span key={uid}>
                {i > 0 && ' · '}
                <span className="font-medium text-neutral-800 dark:text-neutral-200">
                  {displayName(uid, displayNames, myUserId)}
                </span>{' '}
                {n} day{n === 1 ? '' : 's'}
              </span>
            ))}
          </>
        )
      }
    />
  );
}

function SafeSpaceCard({ report }: { report: WeekReport }) {
  const resolved = report.safeSpaceResolutions;
  const posted = report.safeSpacePosts;
  return (
    <StatCard
      tone="amber"
      emoji="🛡️"
      label="Safe-space reconciliations"
      value={`${resolved} resolved`}
      detail={
        posted === 0 && resolved === 0
          ? 'A week with no heavy things to set down.'
          : `${posted} entr${posted === 1 ? 'y' : 'ies'} posted, ${resolved} worked through fully.`
      }
    />
  );
}

function DatesCard({ report }: { report: WeekReport }) {
  return (
    <StatCard
      tone="violet"
      emoji="💕"
      label="Dates"
      value={`${report.datesCompleted} completed`}
      detail={
        report.newMatches > 0
          ? `${report.newMatches} new match${report.newMatches === 1 ? '' : 'es'} waiting to be scheduled.`
          : report.datesCompleted === 0
            ? 'Idea bank has time to breathe.'
            : 'No new matches this week — last one was a keeper.'
      }
    />
  );
}

function TopNeedCard({ report }: { report: WeekReport }) {
  const top = report.mostRequestedNeed;
  return (
    <StatCard
      tone="emerald"
      emoji={top ? NEED_EMOJI[top.need] : '✨'}
      label="Most-requested need"
      value={top ? NEED_LABEL[top.need] : 'Balanced'}
      detail={
        top
          ? `Came up ${top.occurrences} time${top.occurrences === 1 ? '' : 's'} across love-tank check-ins.`
          : 'No one called out a specific need this week.'
      }
    />
  );
}

function EngagementCard({ report }: { report: WeekReport }) {
  const { messageCount, reactionsGiven, mindReaderSolves } = report;
  return (
    <StatCard
      tone="sky"
      emoji="💬"
      label="Conversation"
      value={`${messageCount} messages`}
      detail={
        <>
          {reactionsGiven} reaction{reactionsGiven === 1 ? '' : 's'} ·{' '}
          {mindReaderSolves} mind-reader guess
          {mindReaderSolves === 1 ? '' : 'es'} landed.
        </>
      }
    />
  );
}

// ---------------------------------------------------------------------------
// Mood timeline — per-member daily average across the hero sliders. Overlaid
// sparklines make the week's emotional arc obvious at a glance without
// needing a charting library.
// ---------------------------------------------------------------------------

const HERO_TITLES = new Set(['hunger', 'energy', 'affection']);
const WEEK_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

function MoodTimelineCard({
  events,
  memberIds,
  myUserId,
  displayNames,
}: {
  events: RoomEventRecord[];
  memberIds: string[];
  myUserId: string;
  displayNames: Record<string, string>;
}) {
  const timeline = useMemo(() => {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const days: { label: string; ts: number }[] = [];
    for (let i = WEEK_DAYS - 1; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      days.push({
        label: d.toLocaleDateString(undefined, { weekday: 'short' }).slice(0, 3),
        ts: d.getTime(),
      });
    }
    interface Def {
      title: string;
      definedTs: number;
      deletedTs: number;
    }
    const defs: Record<string, Def> = {};
    for (const rec of events) {
      const ev = rec.event;
      if (ev.type === 'slider_define') {
        const prev = defs[ev.sliderId];
        if (!prev || ev.ts > prev.definedTs)
          defs[ev.sliderId] = {
            title: ev.title,
            definedTs: ev.ts,
            deletedTs: prev?.deletedTs ?? 0,
          };
      } else if (ev.type === 'slider_delete') {
        const prev = defs[ev.sliderId];
        if (prev && ev.ts > prev.deletedTs)
          defs[ev.sliderId] = { ...prev, deletedTs: ev.ts };
      }
    }
    const heroBySliderId: Record<string, { inverted: boolean }> = {};
    for (const [sliderId, d] of Object.entries(defs)) {
      if (d.definedTs <= d.deletedTs) continue;
      const key = d.title.trim().toLowerCase();
      if (!HERO_TITLES.has(key)) continue;
      heroBySliderId[sliderId] = { inverted: key === 'hunger' };
    }
    const heroEntries = Object.entries(heroBySliderId);

    const byMember: Record<string, { day: number; score: number | null }[]> = {};
    for (const uid of memberIds) {
      byMember[uid] = days.map((_, i) => ({ day: i, score: null }));
    }
    if (heroEntries.length === 0) return { days, byMember };

    for (const uid of memberIds) {
      const dayValues: Array<Record<string, number>> = days.map(() => ({}));
      let carry: Record<string, number> = {};
      let dayIdx = 0;
      for (const rec of events) {
        if (rec.senderId !== uid) continue;
        if (rec.event.type !== 'slider_set') continue;
        const ev = rec.event;
        while (dayIdx < days.length && ev.ts >= days[dayIdx].ts + DAY_MS) {
          dayValues[dayIdx] = { ...carry };
          dayIdx++;
        }
        carry = { ...carry, [ev.sliderId]: ev.value };
      }
      while (dayIdx < days.length) {
        dayValues[dayIdx] = { ...carry };
        dayIdx++;
      }
      for (let i = 0; i < days.length; i++) {
        const vals: number[] = [];
        for (const [sliderId, { inverted }] of heroEntries) {
          const v = dayValues[i][sliderId];
          if (v == null) continue;
          vals.push(inverted ? 100 - v : v);
        }
        if (vals.length === 0) continue;
        const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
        byMember[uid][i] = { day: i, score: avg };
      }
    }
    return { days, byMember };
  }, [events, memberIds]);

  const hasAnyData = Object.values(timeline.byMember).some((row) =>
    row.some((d) => d.score != null),
  );
  if (!hasAnyData) return null;

  const width = 560;
  const height = 140;
  const padX = 28;
  const padY = 18;
  const innerW = width - padX * 2;
  const innerH = height - padY * 2;
  const step = innerW / (WEEK_DAYS - 1);
  const toX = (i: number) => padX + i * step;
  const toY = (v: number) => padY + innerH - (v / 100) * innerH;

  const PALETTE = ['#db2777', '#6366f1', '#10b981', '#f59e0b'];

  return (
    <section className="rounded-3xl border border-white/60 bg-white/70 p-6 shadow-xl backdrop-blur-md dark:border-white/10 dark:bg-neutral-900/55">
      <h2 className="text-[11px] font-medium uppercase tracking-[0.18em] text-neutral-500">
        Mood over the week
      </h2>
      <p className="mt-1 text-sm leading-relaxed text-neutral-600 dark:text-neutral-300">
        The three hero sliders — Hunger (inverted), Energy, Affection —
        averaged per day. One line per person.
      </p>
      <div className="mt-4 overflow-x-auto">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label="Mood over the week"
          className="w-full max-w-2xl"
        >
          {[25, 50, 75].map((v) => (
            <line
              key={v}
              x1={padX}
              x2={width - padX}
              y1={toY(v)}
              y2={toY(v)}
              stroke="rgba(0,0,0,0.08)"
              strokeDasharray="3 4"
            />
          ))}
          {timeline.days.map((d, i) => (
            <text
              key={d.ts}
              x={toX(i)}
              y={height - 4}
              textAnchor="middle"
              className="fill-neutral-500"
              style={{ fontSize: 10 }}
            >
              {d.label}
            </text>
          ))}
          {memberIds.map((uid, mi) => {
            const row = timeline.byMember[uid] ?? [];
            const color = PALETTE[mi % PALETTE.length];
            let d = '';
            for (let i = 0; i < row.length; i++) {
              const p = row[i];
              if (p.score == null) continue;
              const cmd = i === 0 || row[i - 1].score == null ? 'M' : 'L';
              d += `${cmd}${toX(i).toFixed(1)},${toY(p.score).toFixed(1)} `;
            }
            return (
              <g key={uid}>
                <path
                  d={d}
                  fill="none"
                  stroke={color}
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  opacity="0.85"
                />
                {row.map((p, i) =>
                  p.score == null ? null : (
                    <circle
                      key={i}
                      cx={toX(i)}
                      cy={toY(p.score)}
                      r="3.5"
                      fill={color}
                      opacity="0.9"
                    />
                  ),
                )}
              </g>
            );
          })}
        </svg>
      </div>
      <div className="mt-3 flex flex-wrap gap-3">
        {memberIds.map((uid, mi) => {
          const color = PALETTE[mi % PALETTE.length];
          const self = uid === myUserId;
          const name = self
            ? 'you'
            : displayNames[uid]?.trim() || uid.slice(0, 8);
          return (
            <span
              key={uid}
              className="flex items-center gap-1.5 text-xs text-neutral-700 dark:text-neutral-300"
            >
              <span
                aria-hidden
                className="inline-block h-2.5 w-2.5 rounded-full"
                style={{ background: color }}
              />
              {name}
            </span>
          );
        })}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Heart flow — directional visual of hearts moved this week. Pair rooms only.
// ---------------------------------------------------------------------------

function HeartFlowCard({
  report,
  myUserId,
  displayNames,
}: {
  report: WeekReport;
  myUserId: string;
  displayNames: Record<string, string>;
}) {
  if (report.roomKind !== 'pair') return null;
  const partners = Object.keys({
    ...report.heartsSentByMember,
    ...report.heartsReceivedByMember,
  });
  const partnerId = partners.find((uid) => uid !== myUserId);
  if (!partnerId) return null;

  const iSent = report.heartsSentByMember[myUserId] ?? 0;
  const theySent = report.heartsSentByMember[partnerId] ?? 0;
  const iReceived = report.heartsReceivedByMember[myUserId] ?? 0;
  const theyReceived = report.heartsReceivedByMember[partnerId] ?? 0;
  const total = iSent + theySent;
  if (total === 0) return null;

  const myShare = total === 0 ? 0.5 : iSent / total;
  const theirShare = 1 - myShare;
  const partnerName =
    displayNames[partnerId]?.trim() || partnerId.slice(0, 8);

  return (
    <section className="rounded-3xl border border-rose-200/70 bg-gradient-to-br from-rose-50/90 via-pink-50/80 to-amber-50/70 p-6 shadow-lg backdrop-blur-md dark:border-rose-800/50 dark:from-rose-950/50 dark:via-pink-950/40 dark:to-amber-950/30">
      <h2 className="text-[11px] font-medium uppercase tracking-[0.18em] text-rose-700 dark:text-rose-300">
        Heart flow
      </h2>
      <p className="mt-1 text-sm leading-relaxed text-neutral-700 dark:text-neutral-300">
        Who sent hearts to whom this week. {total} total hearts moved.
      </p>
      <div className="mt-4 flex items-stretch gap-4">
        <div className="flex-1 text-center">
          <p className="font-display italic text-3xl text-rose-900 dark:text-rose-100">
            {iSent}
          </p>
          <p className="mt-0.5 text-xs text-neutral-600 dark:text-neutral-400">
            you sent → {partnerName}
          </p>
        </div>
        <div aria-hidden className="w-px bg-rose-300/60 dark:bg-rose-800/50" />
        <div className="flex-1 text-center">
          <p className="font-display italic text-3xl text-pink-900 dark:text-pink-100">
            {theySent}
          </p>
          <p className="mt-0.5 text-xs text-neutral-600 dark:text-neutral-400">
            {partnerName} sent → you
          </p>
        </div>
      </div>
      <div className="mt-4 h-2 w-full overflow-hidden rounded-full bg-rose-100/70 dark:bg-rose-950/40">
        <div
          className="h-full bg-gradient-to-r from-rose-400 to-pink-500"
          style={{ width: `${Math.round(myShare * 100)}%` }}
        />
      </div>
      <div className="mt-1.5 flex justify-between text-[10px] uppercase tracking-wide text-rose-700/80 dark:text-rose-300/70">
        <span>you {Math.round(myShare * 100)}%</span>
        <span>
          {Math.round(theirShare * 100)}% {partnerName}
        </span>
      </div>
      <p className="mt-3 text-xs leading-relaxed text-neutral-500">
        Received: you caught {iReceived}, {partnerName} caught {theyReceived}.
      </p>
    </section>
  );
}
