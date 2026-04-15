/**
 * IndexedDB storage for device-local secrets.
 *
 * Browser-only. Holds three stores:
 *   - `identity`   — a single row keyed by userId, holding this device's copy
 *                    of the user's identity keypairs.
 *   - `device`     — a single row keyed by userId, holding this device's id +
 *                    display name as recorded in the `devices` table.
 *   - `knownContacts` — TOFU cache: for each contact userId, the last-seen
 *                    pubkeys. Used to detect key changes.
 *
 * Anything stored here is device-local and survives reload, but not clearing
 * site data. Since we explicitly chose a no-recovery design, that's the
 * expected behavior.
 */

import { openDB, type IDBPDatabase } from 'idb';
import type { Identity, KnownContact } from './types';

const DB_NAME = 'e2ee-core';
const DB_VERSION = 1;

const STORE_IDENTITY = 'identity';
const STORE_DEVICE = 'device';
const STORE_KNOWN_CONTACTS = 'knownContacts';

interface IdentityRow {
  userId: string;
  identity: Identity;
  createdAt: number;
}

interface DeviceRow {
  userId: string;
  deviceId: string;
  displayName: string;
}

let dbPromise: Promise<IDBPDatabase> | null = null;

function getDb(): Promise<IDBPDatabase> {
  if (typeof indexedDB === 'undefined') {
    throw new Error('IndexedDB is not available in this environment');
  }
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE_IDENTITY)) {
          db.createObjectStore(STORE_IDENTITY, { keyPath: 'userId' });
        }
        if (!db.objectStoreNames.contains(STORE_DEVICE)) {
          db.createObjectStore(STORE_DEVICE, { keyPath: 'userId' });
        }
        if (!db.objectStoreNames.contains(STORE_KNOWN_CONTACTS)) {
          db.createObjectStore(STORE_KNOWN_CONTACTS, { keyPath: 'userId' });
        }
      },
    });
  }
  return dbPromise;
}

/** Save this device's copy of the user's identity. Overwrites any prior row. */
export async function putIdentity(userId: string, identity: Identity): Promise<void> {
  const db = await getDb();
  const row: IdentityRow = { userId, identity, createdAt: Date.now() };
  await db.put(STORE_IDENTITY, row);
}

/** Load the stored identity for a given user, or null if none exists here. */
export async function getIdentity(userId: string): Promise<Identity | null> {
  const db = await getDb();
  const row = (await db.get(STORE_IDENTITY, userId)) as IdentityRow | undefined;
  return row?.identity ?? null;
}

/** Remove a user's identity from this device (logout / account reset). */
export async function clearIdentity(userId: string): Promise<void> {
  const db = await getDb();
  await db.delete(STORE_IDENTITY, userId);
}

/** Save this device's registration record. */
export async function putDeviceRecord(
  userId: string,
  deviceId: string,
  displayName: string,
): Promise<void> {
  const db = await getDb();
  const row: DeviceRow = { userId, deviceId, displayName };
  await db.put(STORE_DEVICE, row);
}

/** Load this device's registration record. */
export async function getDeviceRecord(
  userId: string,
): Promise<{ deviceId: string; displayName: string } | null> {
  const db = await getDb();
  const row = (await db.get(STORE_DEVICE, userId)) as DeviceRow | undefined;
  return row ? { deviceId: row.deviceId, displayName: row.displayName } : null;
}

/** Store or update the known-pubkeys cache for a contact. */
export async function putKnownContact(contact: KnownContact): Promise<void> {
  const db = await getDb();
  await db.put(STORE_KNOWN_CONTACTS, contact);
}

/** Look up the TOFU cache for a given contact. */
export async function getKnownContact(userId: string): Promise<KnownContact | null> {
  const db = await getDb();
  const row = (await db.get(STORE_KNOWN_CONTACTS, userId)) as
    | KnownContact
    | undefined;
  return row ?? null;
}

/** List every known contact. Useful for debug / /status / audit UIs. */
export async function listKnownContacts(): Promise<KnownContact[]> {
  const db = await getDb();
  return (await db.getAll(STORE_KNOWN_CONTACTS)) as KnownContact[];
}

/** Fully wipe everything (for "reset this device" UX or tests). */
export async function wipeAll(): Promise<void> {
  const db = await getDb();
  await Promise.all([
    db.clear(STORE_IDENTITY),
    db.clear(STORE_DEVICE),
    db.clear(STORE_KNOWN_CONTACTS),
  ]);
}
