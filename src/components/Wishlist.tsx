'use client';

/**
 * Wishlist.
 *
 * Event-sourced:
 *   wishlist_add    → create an item (author = sender of the event)
 *   wishlist_claim  → mark as claimed by sender; first claim wins
 *   wishlist_delete → remove from the list; only the item's author is
 *                     permitted by UI (the reducer honours it regardless)
 *
 * Projection builds a Map<itemId, WishlistItem> and the UI renders the
 * non-deleted ones.
 */

import { useMemo, useState } from 'react';
import {
  WISHLIST_CATEGORIES,
  type RoomEventSchema,
} from '@/lib/domain/events';
import { z } from 'zod';
import { displayName } from '@/lib/domain/displayName';
import { describeError } from '@/lib/domain/errors';
import { useRoom, useRoomProjection } from './RoomProvider';

type Category = (typeof WISHLIST_CATEGORIES)[number];

type RoomEvent = z.infer<typeof RoomEventSchema>;

interface WishlistItem {
  itemId: string;
  title: string;
  notes?: string;
  category: Category;
  authorId: string;
  createdTs: number;
  claimedBy?: string;
  claimedTs?: number;
  deleted: boolean;
}

type WishlistState = Record<string, WishlistItem>;

export function Wishlist() {
  const { appendEvent, myUserId, displayNames } = useRoom();

  const state = useRoomProjection<WishlistState>((acc, rec) => {
    return reduceWishlist(acc, rec.event, rec.senderId);
  }, {});

  const items = useMemo(
    () =>
      Object.values(state)
        .filter((i) => !i.deleted)
        .sort((a, b) => b.createdTs - a.createdTs),
    [state],
  );

  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function claim(itemId: string) {
    setBusy(true);
    setError(null);
    try {
      await appendEvent({ type: 'wishlist_claim', itemId, ts: Date.now() });
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove(itemId: string) {
    if (!confirm('Remove this item from the wishlist?')) return;
    setBusy(true);
    setError(null);
    try {
      await appendEvent({ type: 'wishlist_delete', itemId, ts: Date.now() });
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-2xl border border-white/50 bg-violet-50/70 p-6 text-sm shadow-xl backdrop-blur-md dark:border-white/10 dark:bg-violet-950/40">
      <div className="flex items-center justify-between">
        <div className="text-[11px] font-medium uppercase tracking-[0.18em] text-violet-800 dark:text-violet-300">
          Wishlist 🎁
        </div>
        {!adding && (
          <button
            onClick={() => setAdding(true)}
            className="rounded-full bg-gradient-to-br from-violet-300 via-violet-400 to-purple-500 px-4 py-1.5 font-display italic text-xs text-white shadow-[0_6px_16px_-4px_rgba(124,58,237,0.45),inset_0_2px_3px_rgba(255,255,255,0.45),inset_0_-2px_4px_rgba(67,56,202,0.3)] ring-1 ring-violet-200/60 transition-all hover:scale-[1.04] active:scale-[1.02]"
          >
            + add
          </button>
        )}
      </div>

      {adding && (
        <AddForm
          onCancel={() => setAdding(false)}
          onDone={() => setAdding(false)}
        />
      )}

      {items.length === 0 && !adding && (
        <p className="mt-2 text-violet-800/70 dark:text-violet-200">
          Nothing on the wishlist yet. First thought wins 🎁
        </p>
      )}

      <ul className="mt-2 space-y-2">
        {items.map((item) => {
          const mine = item.authorId === myUserId;
          const claimedByMe = item.claimedBy === myUserId;
          return (
            <li
              key={item.itemId}
              className="rounded-xl border border-violet-200/60 bg-white/70 p-3 shadow-sm backdrop-blur-md dark:border-violet-800/40 dark:bg-neutral-900/60"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="rounded-full bg-violet-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-violet-800 dark:bg-violet-900 dark:text-violet-200">
                      {item.category}
                    </span>
                    <span className="font-medium break-words">{item.title}</span>
                  </div>
                  {item.notes && (
                    <p className="mt-1 whitespace-pre-wrap break-words text-xs text-neutral-600 dark:text-neutral-400">
                      {item.notes}
                    </p>
                  )}
                  <p className="mt-1 text-[10px] text-neutral-500">
                    added by {displayName(item.authorId, displayNames, myUserId)}
                    {item.claimedBy && (
                      <>
                        {' · '}
                        claimed by {displayName(item.claimedBy, displayNames, myUserId)}
                      </>
                    )}
                  </p>
                </div>
                <div className="flex flex-shrink-0 flex-col gap-1.5">
                  {!item.claimedBy && !mine && (
                    <button
                      onClick={() => void claim(item.itemId)}
                      disabled={busy}
                      className="rounded-full bg-gradient-to-br from-violet-300 via-violet-400 to-purple-500 px-3 py-1.5 font-display italic text-xs text-white shadow-sm transition-all hover:scale-[1.04] active:scale-[1.02] disabled:opacity-50"
                    >
                      Claim
                    </button>
                  )}
                  {mine && (
                    <button
                      onClick={() => void remove(item.itemId)}
                      disabled={busy}
                      className="rounded-full border border-red-300 bg-white/70 px-3 py-1.5 font-display italic text-xs text-red-700 transition-all hover:scale-[1.04] hover:bg-white active:scale-[1.02] disabled:opacity-50 dark:border-red-800 dark:bg-neutral-900/60 dark:text-red-400"
                    >
                      Remove
                    </button>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ul>

      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
    </section>
  );
}

function AddForm({
  onCancel,
  onDone,
}: {
  onCancel: () => void;
  onDone: () => void;
}) {
  const { appendEvent } = useRoom();
  const [title, setTitle] = useState('');
  const [notes, setNotes] = useState('');
  const [category, setCategory] = useState<Category>('gift');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await appendEvent({
        type: 'wishlist_add',
        itemId: crypto.randomUUID(),
        title: title.trim(),
        notes: notes.trim() || undefined,
        category,
        ts: Date.now(),
      });
      setTitle('');
      setNotes('');
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
      className="mt-3 space-y-3 rounded-2xl border border-white/60 bg-white/80 p-4 shadow-sm backdrop-blur-md dark:border-white/10 dark:bg-neutral-900/60"
    >
      <input
        type="text"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="what do you want?"
        required
        maxLength={200}
        className="block w-full rounded-xl border border-violet-200 bg-white/90 px-3 py-2 text-sm text-neutral-900 placeholder:italic placeholder:text-violet-300 outline-none transition-colors focus:border-violet-300 focus:ring-2 focus:ring-violet-300/40 dark:border-violet-800 dark:bg-neutral-950 dark:text-neutral-100"
      />
      <textarea
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        placeholder="notes (optional)"
        rows={2}
        maxLength={1000}
        className="block w-full rounded-2xl border border-violet-200 bg-white/90 p-3 text-sm leading-relaxed text-neutral-900 placeholder:italic placeholder:text-violet-300 outline-none transition-colors focus:border-violet-300 focus:ring-2 focus:ring-violet-300/40 dark:border-violet-800 dark:bg-neutral-950 dark:text-neutral-100"
      />
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value as Category)}
          className="rounded-xl border border-violet-200 bg-white/90 px-3 py-2 text-sm text-violet-900 outline-none focus:border-violet-300 focus:ring-2 focus:ring-violet-300/40 dark:border-violet-800 dark:bg-neutral-950 dark:text-violet-200"
        >
          {WISHLIST_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <button
          type="submit"
          disabled={busy || !title.trim()}
          className="rounded-full bg-gradient-to-br from-violet-300 via-violet-400 to-purple-500 px-5 py-2 font-display italic text-sm text-white shadow-[0_8px_20px_-4px_rgba(124,58,237,0.5),inset_0_2px_3px_rgba(255,255,255,0.45),inset_0_-3px_6px_rgba(67,56,202,0.3)] ring-1 ring-violet-200/60 transition-all hover:scale-[1.04] active:scale-[1.06] disabled:opacity-50"
        >
          {busy ? 'adding…' : 'Add'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="rounded-full border border-violet-200 bg-white/80 px-4 py-2 font-display italic text-sm text-violet-900 transition-all hover:scale-[1.04] hover:bg-white active:scale-[1.02] disabled:opacity-50 dark:border-violet-800 dark:bg-neutral-900/60 dark:text-violet-200"
        >
          Cancel
        </button>
      </div>
      {error && <p className="text-xs text-red-600">{error}</p>}
    </form>
  );
}

// ---------------------------------------------------------------------------

function reduceWishlist(
  state: WishlistState,
  event: RoomEvent,
  senderId: string,
): WishlistState {
  switch (event.type) {
    case 'wishlist_add': {
      if (state[event.itemId]) return state;       // idempotent
      return {
        ...state,
        [event.itemId]: {
          itemId: event.itemId,
          title: event.title,
          notes: event.notes,
          category: event.category,
          authorId: senderId,
          createdTs: event.ts,
          deleted: false,
        },
      };
    }
    case 'wishlist_claim': {
      const item = state[event.itemId];
      if (!item || item.claimedBy) return state;   // first claim wins
      return {
        ...state,
        [event.itemId]: { ...item, claimedBy: senderId, claimedTs: event.ts },
      };
    }
    case 'wishlist_delete': {
      const item = state[event.itemId];
      if (!item) return state;
      if (item.authorId !== senderId) return state; // only author can delete
      return { ...state, [event.itemId]: { ...item, deleted: true } };
    }
    default:
      return state;
  }
}
