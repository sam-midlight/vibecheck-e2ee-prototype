/**
 * Per-room snapshot cache.
 *
 * Stores decrypted + signature-verified event records in IndexedDB keyed by
 * `${userId}:${roomId}`, so subsequent loads hydrate the UI instantly and
 * only need to delta-fetch blobs newer than the cursor.
 *
 * Trust model: the cache lives in the same browser storage layer as the
 * identity private keys (IndexedDB), so persisting plaintext events here
 * does not broaden the attack surface — anyone who can read this store can
 * already read the identity keys and decrypt the ciphertext from Supabase.
 *
 * Invalidation: on room generation change (key rotation via bump) the
 * cached events may have been encrypted with a prior key; cache is ignored
 * (full re-decode) when `cache.generation !== room.current_generation`. Also
 * cleared wholesale as part of the identity-nuke flow.
 */

import { openDB, type IDBPDatabase } from 'idb';
import type {
  RoomBlobFailure,
  RoomEventRecord,
} from '@/components/RoomProvider';

const DB_NAME = 'vibecheck-room-cache';
const STORE = 'rooms';
const DB_VERSION = 1;

export interface RoomCacheEntry {
  userId: string;
  roomId: string;
  generation: number;
  events: RoomEventRecord[];
  failures: RoomBlobFailure[];
  /** ISO created_at of the newest server-confirmed blob in `events`/`failures`. */
  lastBlobCreatedAt: string | null;
  /** Schema version for forward-compat. Bump + clear on breaking changes. */
  cacheVersion: number;
}

// Bump to invalidate stored caches on every client. v2 (2026-04-16): drops
// stale "unrecognized event shape" failure rows that were captured by older
// builds before forward-compat blobs started returning kind: 'skip'.
const CURRENT_CACHE_VERSION = 2;

let dbPromise: Promise<IDBPDatabase> | null = null;

function getDB(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE);
        }
      },
    });
  }
  return dbPromise;
}

function cacheKey(userId: string, roomId: string): string {
  return `${userId}:${roomId}`;
}

export async function readRoomCache(
  userId: string,
  roomId: string,
): Promise<RoomCacheEntry | null> {
  try {
    const db = await getDB();
    const entry = (await db.get(STORE, cacheKey(userId, roomId))) as
      | RoomCacheEntry
      | undefined;
    if (!entry) return null;
    if (entry.cacheVersion !== CURRENT_CACHE_VERSION) return null;
    return entry;
  } catch {
    return null;
  }
}

export async function writeRoomCache(
  entry: Omit<RoomCacheEntry, 'cacheVersion'>,
): Promise<void> {
  try {
    const db = await getDB();
    await db.put(
      STORE,
      { ...entry, cacheVersion: CURRENT_CACHE_VERSION },
      cacheKey(entry.userId, entry.roomId),
    );
  } catch {
    // Cache writes are best-effort. A full quota-exceeded or transient IDB
    // failure here should NOT break the room experience — the user just
    // loses snapshot acceleration until the next successful write.
  }
}

export async function clearRoomCache(
  userId: string,
  roomId?: string,
): Promise<void> {
  try {
    const db = await getDB();
    if (roomId) {
      await db.delete(STORE, cacheKey(userId, roomId));
      return;
    }
    // Clear every cache entry scoped to this user (all rooms).
    const prefix = `${userId}:`;
    const tx = db.transaction(STORE, 'readwrite');
    let cursor = await tx.store.openCursor();
    while (cursor) {
      if (typeof cursor.key === 'string' && cursor.key.startsWith(prefix)) {
        await cursor.delete();
      }
      cursor = await cursor.continue();
    }
    await tx.done;
  } catch {
    /* ignore */
  }
}

/** Newest server-confirmed createdAt from a record list; null if empty. */
export function maxServerCreatedAt(
  events: RoomEventRecord[],
  failures: RoomBlobFailure[],
): string | null {
  let max: string | null = null;
  for (const e of events) {
    if (e.id.startsWith('temp-')) continue;
    if (!max || e.createdAt > max) max = e.createdAt;
  }
  for (const f of failures) {
    if (!max || f.createdAt > max) max = f.createdAt;
  }
  return max;
}
