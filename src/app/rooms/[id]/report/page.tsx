'use client';

/**
 * 14-day room report.
 *
 * Zero-knowledge constraint: the server can't aggregate, so everything
 * happens client-side. We wrap in <RoomProvider>, which decrypts every blob
 * it can see, and then reduce the events list into the metrics below.
 *
 * Note: RoomProvider's listBlobs currently fetches up to 200 rows. For very
 * active rooms over 14 days we may need to bump that or switch to a windowed
 * query — noted but not load-bearing yet.
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

const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;

export default function ReportPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: roomId } = use(params);
  return (
    <AppShell requireAuth>
      <RoomProvider roomId={roomId}>
        <ReportInner roomId={roomId} />
      </RoomProvider>
    </AppShell>
  );
}

function ReportInner({ roomId }: { roomId: string }) {
  const { loading, error, events, members, room, myUserId, displayNames } = useRoom();

  const memberIds = useMemo(
    () =>
      room
        ? members
            .filter((m) => m.generation === room.current_generation)
            .map((m) => m.user_id)
        : [],
    [members, room],
  );

  const agg = useMemo(() => aggregate(events), [events]);

  if (loading) {
    return <div className="p-8"><Loading /></div>;
  }
  if (error) {
    return (
      <div className="m-8 rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
        {error}
      </div>
    );
  }
  if (!room || !myUserId) return null;

  return (
    <div className="mx-auto max-w-3xl space-y-14 pb-16">
      <Hero roomIdShort={room.id.slice(0, 8)} />
      <SummaryNumbers agg={agg} />
      <SlidersSection
        agg={agg}
        memberIds={memberIds}
        myUserId={myUserId}
        displayNames={displayNames}
      />
      <LoveTankSection
        agg={agg}
        memberIds={memberIds}
        myUserId={myUserId}
        displayNames={displayNames}
      />
      <HomeworkSection agg={agg} />
      <Footer roomId={roomId} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Hero + footer
// ---------------------------------------------------------------------------

function Hero({ roomIdShort }: { roomIdShort: string }) {
  return (
    <section className="pt-8 text-center">
      <p className="text-xs uppercase tracking-[0.2em] text-neutral-500">
        Your last 14 days
      </p>
      <h1 className="mt-4 font-display italic text-4xl tracking-tight sm:text-5xl">
        A little reflection.
      </h1>
      <p className="mx-auto mt-5 max-w-xl text-base text-neutral-600 dark:text-neutral-400">
        Everything on this page was computed on your device from your
        room&apos;s encrypted events. No copy of this summary exists on any
        server.
      </p>
      <p className="mt-3 text-xs text-neutral-500">
        Room <code className="font-mono">{roomIdShort}</code>
      </p>
    </section>
  );
}

function Footer({ roomId }: { roomId: string }) {
  return (
    <section className="flex justify-center gap-4 text-center text-xs text-neutral-500">
      <Link
        href={`/rooms/${roomId}`}
        className="underline hover:text-neutral-700 dark:hover:text-neutral-300"
      >
        back to the room
      </Link>
      <button
        type="button"
        onClick={() => window.print()}
        className="underline hover:text-neutral-700 dark:hover:text-neutral-300"
      >
        print / save as PDF
      </button>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Summary numbers
// ---------------------------------------------------------------------------

function SummaryNumbers({ agg }: { agg: Aggregate }) {
  const stats: { label: string; value: number }[] = [
    { label: 'Messages sent', value: agg.counts.messages },
    { label: 'Gratitude given', value: agg.counts.gratitude },
    { label: 'Date ideas added', value: agg.counts.dateIdeasAdded },
    { label: 'Reflections written', value: agg.counts.dateReflections },
    { label: 'Safe-space entries', value: agg.counts.safeSpaceEntries },
    { label: 'Mind reader solves', value: agg.counts.mindReaderSolves },
  ];
  return (
    <section>
      <h2 className="text-xs uppercase tracking-[0.2em] text-neutral-500">
        By the numbers
      </h2>
      <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3">
        {stats.map((s) => (
          <div
            key={s.label}
            className="rounded-2xl border border-white/50 bg-white/60 p-5 shadow-lg backdrop-blur-md dark:border-white/10 dark:bg-neutral-900/50"
          >
            <p className="font-display italic text-4xl tabular-nums">{s.value}</p>
            <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.14em] text-neutral-500">{s.label}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Sliders section
// ---------------------------------------------------------------------------

function SlidersSection({
  agg,
  memberIds,
  myUserId,
  displayNames,
}: {
  agg: Aggregate;
  memberIds: string[];
  myUserId: string;
  displayNames: Record<string, string>;
}) {
  const sliders = Object.values(agg.sliderDefs).filter((d) =>
    Object.keys(agg.sliderPoints[d.sliderId] ?? {}).length > 0,
  );
  if (sliders.length === 0) {
    return (
      <section>
        <h2 className="text-xs uppercase tracking-[0.2em] text-neutral-500">
          Vibe sliders
        </h2>
        <p className="mt-3 text-sm text-neutral-500">
          No slider activity in the last 14 days.
        </p>
      </section>
    );
  }
  return (
    <section>
      <h2 className="text-xs uppercase tracking-[0.2em] text-neutral-500">
        Vibe sliders
      </h2>
      <p className="mt-1 text-sm text-neutral-500">
        Each line is one person&apos;s value over the window. Higher = closer
        to the right label.
      </p>
      <div className="mt-4 space-y-4">
        {sliders.map((d) => {
          const perUser = agg.sliderPoints[d.sliderId] ?? {};
          const avgLine = memberIds
            .map((uid) => {
              const pts = perUser[uid] ?? [];
              if (pts.length === 0) return null;
              const sum = pts.reduce((a, p) => a + p.value, 0);
              return { uid, avg: Math.round(sum / pts.length), count: pts.length };
            })
            .filter(<T,>(x: T | null): x is T => x !== null);
          return (
            <div
              key={d.sliderId}
              className="rounded-2xl border border-white/50 bg-white/60 p-5 shadow-lg backdrop-blur-md dark:border-white/10 dark:bg-neutral-900/50"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span>{d.emoji}</span>
                  <span className="font-medium">{d.title}</span>
                </div>
                <div className="flex gap-4 text-xs">
                  {avgLine.map((a) => (
                    <span key={a.uid} className="inline-flex items-center gap-1">
                      <span
                        aria-hidden
                        className="inline-block h-2 w-3 rounded-sm"
                        style={{ background: colorFor(a.uid, myUserId) }}
                      />
                      <span className="text-neutral-500">
                        {displayName(a.uid, displayNames, myUserId)}
                      </span>
                      <span className="tabular-nums">avg {a.avg}</span>
                    </span>
                  ))}
                </div>
              </div>
              <div className="mt-1 flex justify-between text-[10px] uppercase text-neutral-500">
                <span>{d.leftLabel}</span>
                <span>{d.rightLabel}</span>
              </div>
              <TrendChart
                lines={memberIds
                  .map((uid) => ({
                    userId: uid,
                    points: (perUser[uid] ?? []).map((p) => ({ ts: p.ts, value: p.value })),
                    color: colorFor(uid, myUserId),
                  }))
                  .filter((l) => l.points.length > 0)}
              />
            </div>
          );
        })}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Love tank section
// ---------------------------------------------------------------------------

function LoveTankSection({
  agg,
  memberIds,
  myUserId,
  displayNames,
}: {
  agg: Aggregate;
  memberIds: string[];
  myUserId: string;
  displayNames: Record<string, string>;
}) {
  const lines = memberIds
    .map((uid) => ({
      userId: uid,
      points: (agg.loveTankPoints[uid] ?? []).map((p) => ({ ts: p.ts, value: p.value })),
      color: colorFor(uid, myUserId),
    }))
    .filter((l) => l.points.length > 0);

  if (lines.length === 0) {
    return (
      <section>
        <h2 className="text-xs uppercase tracking-[0.2em] text-neutral-500">
          Love tank
        </h2>
        <p className="mt-3 text-sm text-neutral-500">
          No love-tank activity in the last 14 days.
        </p>
      </section>
    );
  }

  return (
    <section>
      <h2 className="text-xs uppercase tracking-[0.2em] text-neutral-500">
        Love tank
      </h2>
      <div className="mt-4 rounded-2xl border border-white/50 bg-white/60 p-5 shadow-lg backdrop-blur-md dark:border-white/10 dark:bg-neutral-900/50">
        <div className="flex flex-wrap gap-4 text-xs">
          {lines.map((l) => {
            const sum = l.points.reduce((a, p) => a + p.value, 0);
            const avg = Math.round(sum / l.points.length);
            const last = l.points[l.points.length - 1].value;
            return (
              <span key={l.userId} className="inline-flex items-center gap-1">
                <span
                  aria-hidden
                  className="inline-block h-2 w-3 rounded-sm"
                  style={{ background: l.color }}
                />
                <span className="text-neutral-500">
                  {displayName(l.userId, displayNames, myUserId)}
                </span>
                <span className="tabular-nums">
                  avg {avg} · now {last}
                </span>
              </span>
            );
          })}
        </div>
        <TrendChart lines={lines} />
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Homework section
// ---------------------------------------------------------------------------

function HomeworkSection({ agg }: { agg: Aggregate }) {
  const current = agg.latestHomework;
  const changes = agg.counts.homeworkChanges;
  return (
    <section>
      <h2 className="text-xs uppercase tracking-[0.2em] text-neutral-500">
        Intentions
      </h2>
      <div className="mt-4 rounded-2xl border border-white/50 bg-white/60 p-5 shadow-lg backdrop-blur-md dark:border-white/10 dark:bg-neutral-900/50">
        {current && current.trim().length > 0 ? (
          <>
            <p className="text-[10px] uppercase tracking-wide text-neutral-500">
              Current assignment
            </p>
            <p className="mt-1 whitespace-pre-wrap break-words text-sm">
              {current}
            </p>
          </>
        ) : (
          <p className="text-sm text-neutral-500">
            No active homework at the moment.
          </p>
        )}
        <p className="mt-3 text-xs text-neutral-500">
          {changes} change{changes === 1 ? '' : 's'} in this window.
        </p>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Trend chart (inline SVG; no external charting dep)
// ---------------------------------------------------------------------------

interface Line {
  userId: string;
  points: { ts: number; value: number }[];
  color: string;
}

function TrendChart({ lines }: { lines: Line[] }) {
  const width = 600;
  const height = 80;
  const padX = 2;
  const padY = 4;
  const now = Date.now();
  const cutoff = now - FOURTEEN_DAYS_MS;
  const xFor = (ts: number) =>
    padX +
    ((Math.min(now, Math.max(cutoff, ts)) - cutoff) / (now - cutoff)) *
      (width - padX * 2);
  const yFor = (v: number) => padY + (1 - v / 100) * (height - padY * 2);

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className="mt-2 block h-20 w-full rounded bg-neutral-50 dark:bg-neutral-900"
      role="img"
      aria-label="trend chart"
    >
      {/* horizontal guides at 25/50/75 */}
      {[25, 50, 75].map((v) => (
        <line
          key={v}
          x1={padX}
          x2={width - padX}
          y1={yFor(v)}
          y2={yFor(v)}
          stroke="currentColor"
          strokeOpacity={0.08}
          strokeDasharray="2 3"
        />
      ))}

      {lines.map((l) => {
        if (l.points.length === 0) return null;
        const d = l.points
          .map((p, i) => `${i === 0 ? 'M' : 'L'}${xFor(p.ts)},${yFor(p.value)}`)
          .join(' ');
        return (
          <g key={l.userId}>
            <path d={d} fill="none" stroke={l.color} strokeWidth={1.5} />
            {l.points.map((p, i) => (
              <circle
                key={i}
                cx={xFor(p.ts)}
                cy={yFor(p.value)}
                r={2.5}
                fill={l.color}
              />
            ))}
          </g>
        );
      })}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

interface Aggregate {
  sliderDefs: Record<
    string,
    {
      sliderId: string;
      title: string;
      emoji: string;
      leftLabel: string;
      rightLabel: string;
      definedTs: number;
      deletedTs: number;
    }
  >;
  sliderPoints: Record<string, Record<string, { ts: number; value: number }[]>>;
  loveTankPoints: Record<string, { ts: number; value: number }[]>;
  latestHomework: string | null;
  counts: {
    messages: number;
    gratitude: number;
    dateIdeasAdded: number;
    dateReflections: number;
    safeSpaceEntries: number;
    mindReaderSolves: number;
    homeworkChanges: number;
  };
}

function aggregate(events: RoomEventRecord[]): Aggregate {
  const cutoff = Date.now() - FOURTEEN_DAYS_MS;
  const out: Aggregate = {
    sliderDefs: {},
    sliderPoints: {},
    loveTankPoints: {},
    latestHomework: null,
    counts: {
      messages: 0,
      gratitude: 0,
      dateIdeasAdded: 0,
      dateReflections: 0,
      safeSpaceEntries: 0,
      mindReaderSolves: 0,
      homeworkChanges: 0,
    },
  };
  let latestHomeworkTs = 0;

  // We need slider defs even if they were created before the window, so that
  // we can show trends for sliders defined earlier. Walk the full stream for
  // definitions; only count "activity" (set events / message sends / etc.)
  // inside the 14-day window.
  for (const rec of events) {
    const ev = rec.event;
    if (ev.type === 'slider_define') {
      const prev = out.sliderDefs[ev.sliderId];
      if (!prev || prev.definedTs < ev.ts) {
        out.sliderDefs[ev.sliderId] = {
          sliderId: ev.sliderId,
          title: ev.title,
          emoji: ev.emoji,
          leftLabel: ev.leftLabel,
          rightLabel: ev.rightLabel,
          definedTs: ev.ts,
          deletedTs: prev?.deletedTs ?? 0,
        };
      }
    } else if (ev.type === 'slider_delete') {
      const prev = out.sliderDefs[ev.sliderId];
      if (prev && prev.deletedTs < ev.ts) {
        out.sliderDefs[ev.sliderId] = { ...prev, deletedTs: ev.ts };
      }
    }
  }

  // Drop deleted sliders (those whose deletedTs > definedTs).
  for (const id of Object.keys(out.sliderDefs)) {
    const d = out.sliderDefs[id];
    if (d.deletedTs > d.definedTs) delete out.sliderDefs[id];
  }

  for (const rec of events) {
    const createdMs = new Date(rec.createdAt).getTime();
    if (createdMs < cutoff) continue;
    const ev = rec.event;
    const uid = rec.senderId;
    switch (ev.type) {
      case 'message':
        out.counts.messages++;
        break;
      case 'gratitude_send':
        out.counts.gratitude++;
        break;
      case 'date_idea_add':
        out.counts.dateIdeasAdded++;
        break;
      case 'date_idea_complete':
        out.counts.dateReflections++;
        break;
      case 'icebreaker_post':
        out.counts.safeSpaceEntries++;
        break;
      case 'mind_reader_solve':
        out.counts.mindReaderSolves++;
        break;
      case 'homework_set':
        out.counts.homeworkChanges++;
        if (ev.ts > latestHomeworkTs) {
          latestHomeworkTs = ev.ts;
          out.latestHomework = ev.text;
        }
        break;
      case 'slider_set': {
        if (!out.sliderDefs[ev.sliderId]) break;  // ignore deleted/unknown sliders
        if (!out.sliderPoints[ev.sliderId]) out.sliderPoints[ev.sliderId] = {};
        if (!out.sliderPoints[ev.sliderId][uid])
          out.sliderPoints[ev.sliderId][uid] = [];
        out.sliderPoints[ev.sliderId][uid].push({ ts: ev.ts, value: ev.value });
        break;
      }
      case 'love_tank_set':
        if (!out.loveTankPoints[uid]) out.loveTankPoints[uid] = [];
        out.loveTankPoints[uid].push({ ts: ev.ts, value: ev.level });
        break;
      default:
        break;
    }
  }

  // Sort point arrays chronologically for chart rendering.
  for (const sid in out.sliderPoints) {
    for (const uid in out.sliderPoints[sid]) {
      out.sliderPoints[sid][uid].sort((a, b) => a.ts - b.ts);
    }
  }
  for (const uid in out.loveTankPoints) {
    out.loveTankPoints[uid].sort((a, b) => a.ts - b.ts);
  }

  return out;
}

// Stable per-user color. "you" always sky blue; others hashed to a
// pleasant rose-family hue so the chart pairs read cleanly.
function colorFor(userId: string, myUserId: string): string {
  if (userId === myUserId) return '#0284c7'; // sky-600
  let h = 0;
  for (let i = 0; i < userId.length; i++) h = (h * 31 + userId.charCodeAt(i)) >>> 0;
  return `hsl(${(h % 120) + 320}, 60%, 50%)`; // rose-ish wheel (320–440 -> 320–60)
}
