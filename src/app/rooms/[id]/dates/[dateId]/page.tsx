'use client';

import { use } from 'react';
import { AppShell } from '@/components/AppShell';
import { DateVault } from '@/components/DateVault';
import { Loading } from '@/components/OrganicLoader';
import { RoomProvider, useRoom } from '@/components/RoomProvider';

export default function DateVaultPage({
  params,
}: {
  params: Promise<{ id: string; dateId: string }>;
}) {
  const { id: roomId, dateId } = use(params);
  return (
    <AppShell requireAuth>
      <RoomProvider roomId={roomId}>
        <Inner dateId={dateId} />
      </RoomProvider>
    </AppShell>
  );
}

function Inner({ dateId }: { dateId: string }) {
  const { loading, error, room, myDevice, myUserId, roomKey } = useRoom();
  if (loading) return <Loading />;
  if (error) {
    return (
      <div className="mx-auto mt-8 max-w-md rounded-2xl border border-red-300/60 bg-red-50/70 p-5 text-sm text-red-900 shadow-lg backdrop-blur-md dark:border-red-800/40 dark:bg-red-950/40 dark:text-red-200">
        {error}
      </div>
    );
  }
  if (!room || !myDevice || !myUserId || !roomKey) return null;
  return <DateVault dateId={dateId} />;
}
