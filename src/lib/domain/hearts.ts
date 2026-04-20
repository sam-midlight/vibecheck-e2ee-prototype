/**
 * Heart balances across the room.
 *
 * One balance per user: Σ gratitude received + Σ bribes received − Σ bribes sent.
 * A bribe's "receiver" is the target's author (the person who posted the
 * mind_reader game or added the date idea). Self-bribes and bribes against
 * unknown targets are ignored (they can't produce a valid author lookup).
 *
 * Must be a single pass that also tracks target authors, because bribes
 * reference `targetId` not `authorId` directly.
 */

'use client';

import { useMemo } from 'react';
import { useRoom } from '@/components/RoomProvider';

export function useHeartBalances(): Record<string, number> {
  const { events } = useRoom();
  return useMemo<Record<string, number>>(() => {
    const gameAuthors: Record<string, string> = {};
    const ideaAuthors: Record<string, string> = {};
    const balances: Record<string, number> = {};
    for (const rec of events) {
      const ev = rec.event;
      switch (ev.type) {
        case 'mind_reader_post':
          if (!gameAuthors[ev.gameId]) gameAuthors[ev.gameId] = rec.senderId;
          break;
        case 'date_idea_add':
          if (!ideaAuthors[ev.ideaId]) ideaAuthors[ev.ideaId] = rec.senderId;
          break;
        case 'gratitude_send':
          balances[ev.to] = (balances[ev.to] ?? 0) + ev.amount;
          break;
        case 'bribe': {
          const author =
            ev.targetType === 'mind_reader'
              ? gameAuthors[ev.targetId]
              : ev.targetType === 'date_idea'
                ? ideaAuthors[ev.targetId]
                : undefined;
          if (!author || author === rec.senderId) break;
          balances[rec.senderId] = (balances[rec.senderId] ?? 0) - ev.amount;
          balances[author] = (balances[author] ?? 0) + ev.amount;
          break;
        }
        default:
          break;
      }
    }
    return balances;
  }, [events]);
}

export function useMyHeartBalance(): number {
  const balances = useHeartBalances();
  const { myUserId } = useRoom();
  return myUserId ? (balances[myUserId] ?? 0) : 0;
}
