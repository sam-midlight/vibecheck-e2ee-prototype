'use client';

/**
 * App-level local cache for room blobs.
 *
 * Stores raw BlobRows (ciphertext — plaintext never touches disk) in a
 * separate IndexedDB database so the e2ee-core store stays pure crypto.
 *
 * Security posture: same as Element Web — ciphertext stored at rest, keys
 * held in the PIN-protected e2ee-core store, plaintext only ever in memory.
 */

import { openDB, type IDBPDatabase } from 'idb';
import type { BlobRow } from '@/lib/supabase/queries';

export const MAX_CACHE_ROWS_PER_ROOM = 500;

const DB_NAME = 'vibecheck-cache';
const DB_VERSION = 1;

const STORE_BLOB_CACHE = 'blobCache';
const STORE_ROOM_SYNC_CURSOR = 'roomSyncCursor';

interface BlobCacheEntry {
  key: string;       // `${roomId}:${blobId}` — primary key
  roomId: string;    // for byRoom index
  createdAt: string; // ISO timestamp — for byRoomTime compound index
  row: BlobRow;
}

interface RoomSyncCursorEntry {
  roomId: string;
  lastCreatedAt: string; // `gte` anchor for next delta fetch
}

let dbPromise: Promise<IDBPDatabase> | null = null;

function getCacheDb(): Promise<IDBPDatabase> {
  if (typeof indexedDB === 'undefined') throw new Error('IndexedDB not available');
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        const blobStore = db.createObjectStore(STORE_BLOB_CACHE, { keyPath: 'key' });
        blobStore.createIndex('byRoom', 'roomId');
        // Compound index: supports range query [roomId, ''] → [roomId, '\uffff']
        // giving all entries for a room sorted by createdAt ASC.
        blobStore.createIndex('byRoomTime', ['roomId', 'createdAt']);
        db.createObjectStore(STORE_ROOM_SYNC_CURSOR, { keyPath: 'roomId' });
      },
    });
  }
  return dbPromise;
}

// ---------------------------------------------------------------------------
// Blob cache
// ---------------------------------------------------------------------------

/** Upsert rows into cache. Safe to call with already-cached rows. */
export async function putBlobRows(roomId: string, rows: BlobRow[]): Promise<void> {
  if (rows.length === 0) return;
  const db = await getCacheDb();
  const tx = db.transaction(STORE_BLOB_CACHE, 'readwrite');
  for (const row of rows) {
    const entry: BlobCacheEntry = {
      key: `${roomId}:${row.id}`,
      roomId,
      createdAt: row.created_at,
      row,
    };
    await tx.store.put(entry);
  }
  await tx.done;
}

/** Returns all cached rows for a room, sorted oldest → newest. */
export async function getBlobCacheForRoom(roomId: string): Promise<BlobRow[]> {
  const db = await getCacheDb();
  const range = IDBKeyRange.bound([roomId, ''], [roomId, '\uffff']);
  const entries = (await db.getAllFromIndex(
    STORE_BLOB_CACHE,
    'byRoomTime',
    range,
  )) as BlobCacheEntry[];
  return entries.map((e) => e.row);
}

/**
 * Trim to MAX_CACHE_ROWS_PER_ROOM, keeping the newest rows.
 * Returns the IDs of deleted rows so the caller can update React state.
 */
export async function trimBlobCache(roomId: string): Promise<string[]> {
  const db = await getCacheDb();
  const range = IDBKeyRange.bound([roomId, ''], [roomId, '\uffff']);
  const entries = (await db.getAllFromIndex(
    STORE_BLOB_CACHE,
    'byRoomTime',
    range,
  )) as BlobCacheEntry[];
  if (entries.length <= MAX_CACHE_ROWS_PER_ROOM) return [];
  const toDelete = entries.slice(0, entries.length - MAX_CACHE_ROWS_PER_ROOM);
  const tx = db.transaction(STORE_BLOB_CACHE, 'readwrite');
  for (const e of toDelete) await tx.store.delete(e.key);
  await tx.done;
  return toDelete.map((e) => e.row.id);
}

export async function removeBlobFromCache(roomId: string, blobId: string): Promise<void> {
  const db = await getCacheDb();
  await db.delete(STORE_BLOB_CACHE, `${roomId}:${blobId}`);
}

/** Purge all cached rows for a room and reset its sync cursor. */
export async function clearBlobCacheForRoom(roomId: string): Promise<void> {
  const db = await getCacheDb();
  const keys = (await db.getAllKeysFromIndex(
    STORE_BLOB_CACHE,
    'byRoom',
    IDBKeyRange.only(roomId),
  )) as string[];
  if (keys.length > 0) {
    const tx = db.transaction(STORE_BLOB_CACHE, 'readwrite');
    for (const key of keys) await tx.store.delete(key);
    await tx.done;
  }
  await db.delete(STORE_ROOM_SYNC_CURSOR, roomId);
}

// ---------------------------------------------------------------------------
// Sync cursor
// ---------------------------------------------------------------------------

export async function getRoomSyncCursor(roomId: string): Promise<string | null> {
  const db = await getCacheDb();
  const entry = (await db.get(
    STORE_ROOM_SYNC_CURSOR,
    roomId,
  )) as RoomSyncCursorEntry | undefined;
  return entry?.lastCreatedAt ?? null;
}

export async function putRoomSyncCursor(
  roomId: string,
  lastCreatedAt: string,
): Promise<void> {
  const db = await getCacheDb();
  await db.put(STORE_ROOM_SYNC_CURSOR, { roomId, lastCreatedAt });
}

// ---------------------------------------------------------------------------
// Full wipe — call alongside identity nuke
// ---------------------------------------------------------------------------

export async function wipeAppCache(): Promise<void> {
  const db = await getCacheDb();
  await Promise.all([
    db.clear(STORE_BLOB_CACHE),
    db.clear(STORE_ROOM_SYNC_CURSOR),
  ]);
}
