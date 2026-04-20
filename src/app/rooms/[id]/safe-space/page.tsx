'use client';

/**
 * Safe Space — a focused "room within a room". Reuses RoomProvider so the
 * existing SafeSpace component (OTP-gated entries, time-out workflow) renders
 * verbatim; only the wrapping shell changes.
 *
 * Visual layers (back → front):
 *   1. Dark obsidian gradient canvas
 *   2. SafeSpaceStarfield (twinkling pinpoints + faint grain)
 *   3. Soft inner glows (top warm, bottom cool)
 *   4. SafeSpaceLantern (corner-pinned, summons whispered vibe lines)
 *   5. Page content (tabs, header, SafeSpace component)
 *
 * Mount transition: a focus-shimmer fade-in driven by Framer Motion so the
 * jump from the bright Home view to this protected void feels like
 * "cooling down" rather than a hard cut. Honors prefers-reduced-motion via
 * a 0.01s fallback duration.
 *
 * `?compose=1` (passed by the orb action menu's "Safe space" action) opens
 * the post form on mount.
 */

import { use, useEffect } from 'react';
import { motion } from 'framer-motion';
import { useSearchParams } from 'next/navigation';
import { uniqueMembers } from '@/lib/domain/members';
import { AppShell } from '@/components/AppShell';
import { KeyChangeBanner } from '@/components/KeyChangeBanner';
import { Loading } from '@/components/OrganicLoader';
import { RoomProvider, useRoom } from '@/components/RoomProvider';
import { RoomTabs } from '@/components/RoomTabs';
import { SafeSpace } from '@/components/SafeSpace';
import { SafeSpaceLantern } from '@/components/SafeSpaceLantern';

export default function SafeSpaceTabPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: roomId } = use(params);
  return (
    <AppShell requireAuth>
      <RoomProvider roomId={roomId}>
        <SafeSpaceInner />
      </RoomProvider>
    </AppShell>
  );
}

function SafeSpaceInner() {
  const { loading, error, room, members, myUserId, myDevice, roomKey } =
    useRoom();
  const searchParams = useSearchParams();
  const autoCompose = searchParams.get('compose') === '1';

  // Safe Space owns the obsidian (dusk/night) mode of the design system.
  // Flipping html[data-theme] here cascades through every surface that
  // reads tokens via useDesignMode — LavaLamp's palette alpha dials down,
  // Clay cards deepen, the VibeOrb swaps sun → moon.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const prior = document.documentElement.dataset.theme;
    document.documentElement.dataset.theme = 'obsidian';
    return () => {
      if (prior) document.documentElement.dataset.theme = prior;
      else delete document.documentElement.dataset.theme;
    };
  }, []);

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
    <motion.div
      // Focus-shimmer fade-in, no dark chrome: the Safe Space page lets
      // the obsidian-dimmed lava-lamp background show through directly.
      // The theme flip (html[data-theme="obsidian"]) already dims the
      // lava alpha and flips the design tokens — that's the whole
      // atmosphere change the user wanted.
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.55, ease: 'easeOut' }}
      className="relative px-3 pb-[calc(env(safe-area-inset-bottom,0px)+32px)] pt-4 sm:px-6 sm:pt-6"
      style={{ minHeight: 'min(100dvh, 900px)', color: 'var(--foreground)' }}
    >
      {/* Subtle atmospheric layer only — lantern adds a corner glow that
          reads on any background; the deep-cosmic mosaic + starfield
          from the prior dark-chrome era were removed so nothing occludes
          the warm lava wash. */}
      <SafeSpaceLantern />

      <div className="relative mx-auto w-full max-w-3xl space-y-4">
        <KeyChangeBanner />
        <RoomTabs
          active="safe-space"
          roomId={room.id}
          myUserId={myUserId}
          isSoleMember={currentGenMembers.length === 1}
        />
        <header className="pt-2">
          <p className="text-[10px] uppercase tracking-[0.25em] text-slate-400">
            A room within a room
          </p>
          <h1 className="mt-1 font-display italic text-2xl tracking-tight text-slate-50">
            Safe space 🛡️
          </h1>
          <p className="mt-1 max-w-xl text-sm text-slate-400">
            For the conversations that need a little more care. Post behind a
            code, open together when you&apos;re both ready, and sit with it
            until you both feel resolved.
          </p>
        </header>

        <SafeSpace autoOpenPostForm={autoCompose} />
      </div>
    </motion.div>
  );
}
