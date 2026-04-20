'use client';

/**
 * Date Night — minimalist portal. Single ambient anchor banner that
 * tells you whether anything's queued; tap a matched date to enter
 * its private "Vault" sub-room. The Memory Bank sits below the fold
 * for past dates, but the page deliberately drops the home-page
 * clutter (mood orbs, oracle banner, shared chat, room-level
 * roulette) so the matched date is THE thing.
 *
 * The room-level Date Night Roulette has been retired here in
 * favour of per-date roulettes inside each Vault — that's where the
 * "who picks the snacks" friction actually belongs.
 */

import { use } from 'react';
import { motion } from 'framer-motion';
import { uniqueMembers } from '@/lib/domain/members';
import { AppShell } from '@/components/AppShell';
import { DateNightPortal } from '@/components/DateNightPortal';
import { KeyChangeBanner } from '@/components/KeyChangeBanner';
import { Loading } from '@/components/OrganicLoader';
import { MemoryBank } from '@/components/MemoryBank';
import { RoomHeader } from '@/components/RoomHeader';
import { RoomProvider, useRoom } from '@/components/RoomProvider';
import { RoomTabs } from '@/components/RoomTabs';
import { VibeMosaic } from '@/components/VibeMosaic';
import { VibeOrb } from '@/components/VibeOrb';

export default function DateNightPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: roomId } = use(params);
  return (
    <AppShell requireAuth>
      <RoomProvider roomId={roomId}>
        <DateNightInner />
      </RoomProvider>
    </AppShell>
  );
}

function DateNightInner() {
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

      <motion.div
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.45, ease: 'easeOut' }}
        className="mx-auto w-full max-w-3xl space-y-5 px-2 pb-[180px] sm:px-4 sm:pb-[230px]"
      >
        <KeyChangeBanner />

        <RoomTabs
          active="date-night"
          roomId={room.id}
          myUserId={myUserId}
          isSoleMember={currentGenMembers.length === 1}
        />

        <div className="min-w-0 space-y-2">
          <RoomHeader />
        </div>

        {/* The portal — conditional anchor banner: empty state OR
            celebratory match-list with vault entry pills. */}
        <DateNightPortal />

        {/* Past dates. Sits below the anchor; doesn't compete with it. */}
        <MemoryBank />
      </motion.div>

      <VibeOrb />
    </>
  );
}
