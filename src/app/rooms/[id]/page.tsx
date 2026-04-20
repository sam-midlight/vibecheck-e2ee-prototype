'use client';

import { use, useState } from 'react';
import { uniqueMembers } from '@/lib/domain/members';
import { AppShell } from '@/components/AppShell';
import { DailyCheckIn } from '@/components/DailyCheckIn';
import { FeatureLauncher } from '@/components/FeatureLauncher';
import { MemoryJar } from '@/components/MemoryJar';
import { KeyChangeBanner } from '@/components/KeyChangeBanner';
import { Loading } from '@/components/OrganicLoader';
import { MemberMoodOrbs } from '@/components/MemberMoodOrbs';
import { Messages } from '@/components/Messages';
import { RoomHeader } from '@/components/RoomHeader';
import { RoomProvider, useRoom } from '@/components/RoomProvider';
import { RoomRoster } from '@/components/RoomRoster';
import { RoomTabs } from '@/components/RoomTabs';
import { VibeMosaic } from '@/components/VibeMosaic';
import { VibeOracleBanner } from '@/components/VibeOracleBanner';
import { VibeOrb } from '@/components/VibeOrb';
import { VibeSliders } from '@/components/VibeSliders';
import { WidgetsSidebar } from '@/components/WidgetsSidebar';

export default function RoomDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: roomId } = use(params);
  return (
    <AppShell requireAuth>
      <RoomProvider roomId={roomId}>
        <RoomInner />
      </RoomProvider>
    </AppShell>
  );
}

function RoomInner() {
  const { loading, error, room, members, myUserId, myDevice, roomKey } =
    useRoom();

  if (loading) return <Loading />;
  if (error) {
    return (
      <div className="mx-auto mt-8 max-w-md rounded-2xl border border-red-300/60 bg-red-50/70 p-5 text-sm text-red-900 shadow-lg backdrop-blur-md dark:border-red-800/40 dark:bg-red-950/40 dark:text-red-200">
        {error}
      </div>
    );
  }
  if (!room || !myDevice || !myUserId || !roomKey) return null;

  const currentGenMembers = uniqueMembers(members, room.current_generation);

  return (
    <>
      <VibeMosaic />

      {/* Extra bottom padding so the fixed VibeOrb never covers content.
          Smaller on mobile where the orb itself is 132px instead of 176px. */}
      <div className="mx-auto w-full max-w-7xl space-y-4 px-2 pb-[180px] sm:px-4 sm:pb-[230px]">
        <KeyChangeBanner />

        <RoomTabs
          active="home"
          roomId={room.id}
          myUserId={myUserId}
          isSoleMember={currentGenMembers.length === 1}
        />

        <div className="min-w-0 space-y-2">
          <RoomHeader />
          <div className="flex flex-wrap items-center gap-2">
            <RoomRoster />
            <RealtimeBadge />
            <RoomDetailsButton />
          </div>
        </div>

        {/* Two-column grid: left rail stacks all the ambient widgets
            (WidgetsSidebar's at-a-glance widgets + the Private-to-you
            Zero-Knowledge card from the Warm Obsidian mock), main
            column is the reading column. Collapses to single-column
            on narrow viewports. */}
        <div className="grid gap-4 lg:grid-cols-[240px_minmax(0,1fr)]">
          <aside className="order-2 flex min-w-0 flex-col gap-3 lg:order-1">
            <RailLabel>At a glance</RailLabel>
            <WidgetsSidebar />
          </aside>
          <main className="order-1 min-w-0 space-y-4 lg:order-2">
            <MemberMoodOrbs />
            <VibeOracleBanner />
            <VibeSliders defaultCollapsed />
            <DailyCheckIn />
            <MemoryJar />
            <Messages />
          </main>
        </div>
      </div>

      {/* Footer hint — bottom-left, clear of the bottom-center sun. */}
      <FooterHint />

      <VibeOrb />
      <FeatureLauncher />
    </>
  );
}

function RailLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-1 font-mono text-[10px] font-medium uppercase tracking-[0.12em] text-neutral-500 dark:text-neutral-400">
      {children}
    </div>
  );
}

function FooterHint() {
  return (
    <div
      aria-hidden
      className="pointer-events-none fixed bottom-5 left-8 z-40 hidden font-mono text-[10px] uppercase tracking-[0.12em] text-neutral-500 sm:block dark:text-neutral-500"
    >
      Tap the sun to orbit the room
    </div>
  );
}

function RealtimeBadge() {
  const { realtimeStatus } = useRoom();
  const live = realtimeStatus === 'SUBSCRIBED';
  const color = live
    ? 'text-emerald-700 dark:text-emerald-400'
    : 'text-amber-700 dark:text-amber-400';
  const label = live ? 'live' : realtimeStatus.toLowerCase();
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border border-white/60 bg-white/70 px-2.5 py-1 text-[10px] font-medium uppercase tracking-wide shadow-sm backdrop-blur-md dark:border-white/10 dark:bg-neutral-900/60 ${color}`}
      title={`realtime channel: ${realtimeStatus}`}
    >
      {live ? '●' : '○'} {label}
    </span>
  );
}

/**
 * The room id / kind / generation / member-count metadata used to live
 * directly under the room name. It's mostly debug detail — useful but
 * cluttering. Now hidden behind a tiny ⓘ button that pops a small disclosure
 * card right where the metadata used to be.
 */
function RoomDetailsButton() {
  const { room, members } = useRoom();
  const [open, setOpen] = useState(false);
  if (!room) return null;
  const currentMemberCount = uniqueMembers(
    members,
    room.current_generation,
  ).length;
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="room details"
        aria-expanded={open}
        className="flex h-7 w-7 items-center justify-center rounded-full border border-white/60 bg-white/70 text-xs text-neutral-600 shadow-sm backdrop-blur-md transition-all hover:bg-white/90 hover:shadow-md active:scale-[0.96] dark:border-white/10 dark:bg-neutral-900/60 dark:text-neutral-300"
      >
        ⓘ
      </button>
      {open && (
        <>
          <button
            type="button"
            aria-label="close room details"
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-30 cursor-default"
          />
          <div
            role="dialog"
            aria-label="Room details"
            className="absolute left-0 top-full z-40 mt-2 w-64 rounded-2xl border border-white/60 bg-white/90 p-3 text-xs text-neutral-700 shadow-xl backdrop-blur-md dark:border-white/10 dark:bg-neutral-900/80 dark:text-neutral-300"
          >
            <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-neutral-500">
              Room details
            </p>
            <dl className="mt-2 space-y-1.5">
              <Row label="id">
                <code className="font-mono">{room.id.slice(0, 8)}</code>
              </Row>
              <Row label="kind">{room.kind}</Row>
              <Row label="generation">{room.current_generation}</Row>
              <Row label="members">{currentMemberCount}</Row>
            </dl>
          </div>
        </>
      )}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-[10px] uppercase tracking-wide text-neutral-500">
        {label}
      </dt>
      <dd className="font-medium text-neutral-800 dark:text-neutral-200">
        {children}
      </dd>
    </div>
  );
}
