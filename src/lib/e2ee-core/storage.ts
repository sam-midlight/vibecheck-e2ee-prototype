/**
 * IndexedDB storage for device-local secrets (v2, per-device).
 *
 * Browser-only. Holds:
 *   - `deviceBundle`   — one row per userId: this device's key bundle
 *                        (ed25519 + x25519, both privs + pubs) plus its
 *                        deviceId. Generated once per browser/profile.
 *   - `userMasterKey`  — one row per userId: UMK priv+pub. Present only on
 *                        the device that created the account (or a recovery-
 *                        restored device). NOT present on approval-linked
 *                        secondary devices.
 *   - `device`         — registration metadata (deviceId + displayName). The
 *                        deviceId also appears in the deviceBundle; this row
 *                        is the canonical source for display_name.
 *   - `knownContacts`  — TOFU cache of contact UMK pubs.
 *   - `wrappedIdentity`— optional: passphrase-wrapped blob carrying the
 *                        deviceBundle + optional UMK. Present when lock is on.
 *
 * Nothing persisted here ever leaves the device under normal operation.
 */

import { openDB, type IDBPDatabase } from 'idb';
import type {
  DeviceKeyBundle,
  KnownContact,
  SelfSigningKey,
  UserMasterKey,
  UserSigningKey,
} from './types';
import type { OutboundMegolmSession, InboundSessionSnapshot } from './megolm';
import type { PinWrappedIdentity } from './pin-lock';

const DB_NAME = 'e2ee-core';
// v6: adds outboundSessions + inboundSessions stores (Megolm).
const DB_VERSION = 6;

const STORE_DEVICE_BUNDLE = 'deviceBundle';
const STORE_USER_MASTER_KEY = 'userMasterKey';
const STORE_DEVICE = 'device';
const STORE_KNOWN_CONTACTS = 'knownContacts';
const STORE_WRAPPED_IDENTITY = 'wrappedIdentity';
const STORE_BACKUP_KEY = 'backupKey';
const STORE_SELF_SIGNING_KEY = 'selfSigningKey';
const STORE_USER_SIGNING_KEY = 'userSigningKey';
const STORE_OUTBOUND_SESSIONS = 'outboundSessions';
const STORE_INBOUND_SESSIONS = 'inboundSessions';
// Legacy (v1/v2) store name, still recognized so we can delete it on upgrade.
const LEGACY_STORE_IDENTITY = 'identity';

interface SelfSigningKeyRow {
  userId: string;
  ssk: SelfSigningKey;
  createdAt: number;
}

interface UserSigningKeyRow {
  userId: string;
  usk: UserSigningKey;
  createdAt: number;
}

/** Keyed by `${roomId}:${deviceId}` — one outbound session per room per device. */
interface OutboundSessionRow {
  key: string; // `${roomId}:${deviceId}`
  session: OutboundMegolmSession;
}

/** Keyed by `${sessionId_base64}:${senderDeviceId}` — inbound session per sender. */
interface InboundSessionRow {
  key: string;
  snapshot: InboundSessionSnapshot;
}

interface BackupKeyRow {
  userId: string;
  key: Uint8Array;
  createdAt: number;
}

interface DeviceBundleRow {
  userId: string;
  bundle: DeviceKeyBundle;
  createdAt: number;
}

interface UserMasterKeyRow {
  userId: string;
  umk: UserMasterKey;
  createdAt: number;
}

interface DeviceRow {
  userId: string;
  deviceId: string;
  displayName: string;
}

interface WrappedIdentityRow {
  userId: string;
  blob: PinWrappedIdentity;
  createdAt: number;
}

let dbPromise: Promise<IDBPDatabase> | null = null;

function getDb(): Promise<IDBPDatabase> {
  if (typeof indexedDB === 'undefined') {
    throw new Error('IndexedDB is not available in this environment');
  }
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion) {
        if (oldVersion < 1) {
          // fresh install; create everything below
        }
        // Delete legacy v1/v2 `identity` store on upgrade to v3. The old shape
        // (combined root identity) is incompatible with per-device identities.
        if (db.objectStoreNames.contains(LEGACY_STORE_IDENTITY)) {
          db.deleteObjectStore(LEGACY_STORE_IDENTITY);
        }
        if (!db.objectStoreNames.contains(STORE_DEVICE_BUNDLE)) {
          db.createObjectStore(STORE_DEVICE_BUNDLE, { keyPath: 'userId' });
        }
        if (!db.objectStoreNames.contains(STORE_USER_MASTER_KEY)) {
          db.createObjectStore(STORE_USER_MASTER_KEY, { keyPath: 'userId' });
        }
        if (!db.objectStoreNames.contains(STORE_DEVICE)) {
          db.createObjectStore(STORE_DEVICE, { keyPath: 'userId' });
        }
        if (!db.objectStoreNames.contains(STORE_KNOWN_CONTACTS)) {
          db.createObjectStore(STORE_KNOWN_CONTACTS, { keyPath: 'userId' });
        }
        if (!db.objectStoreNames.contains(STORE_WRAPPED_IDENTITY)) {
          db.createObjectStore(STORE_WRAPPED_IDENTITY, { keyPath: 'userId' });
        }
        if (!db.objectStoreNames.contains(STORE_BACKUP_KEY)) {
          db.createObjectStore(STORE_BACKUP_KEY, { keyPath: 'userId' });
        }
        if (!db.objectStoreNames.contains(STORE_SELF_SIGNING_KEY)) {
          db.createObjectStore(STORE_SELF_SIGNING_KEY, { keyPath: 'userId' });
        }
        if (!db.objectStoreNames.contains(STORE_USER_SIGNING_KEY)) {
          db.createObjectStore(STORE_USER_SIGNING_KEY, { keyPath: 'userId' });
        }
        if (!db.objectStoreNames.contains(STORE_OUTBOUND_SESSIONS)) {
          db.createObjectStore(STORE_OUTBOUND_SESSIONS, { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains(STORE_INBOUND_SESSIONS)) {
          db.createObjectStore(STORE_INBOUND_SESSIONS, { keyPath: 'key' });
        }
      },
    });
  }
  return dbPromise;
}

// ---------------------------------------------------------------------------
// Device bundle (per-device ed+x keypair)
// ---------------------------------------------------------------------------

export async function putDeviceBundle(
  userId: string,
  bundle: DeviceKeyBundle,
): Promise<void> {
  const db = await getDb();
  const row: DeviceBundleRow = { userId, bundle, createdAt: Date.now() };
  await db.put(STORE_DEVICE_BUNDLE, row);
}

export async function getDeviceBundle(
  userId: string,
): Promise<DeviceKeyBundle | null> {
  const db = await getDb();
  const row = (await db.get(STORE_DEVICE_BUNDLE, userId)) as
    | DeviceBundleRow
    | undefined;
  return row?.bundle ?? null;
}

export async function clearDeviceBundle(userId: string): Promise<void> {
  const db = await getDb();
  await db.delete(STORE_DEVICE_BUNDLE, userId);
}

// ---------------------------------------------------------------------------
// User Master Key (optional per device; present on primary / recovery-holder)
// ---------------------------------------------------------------------------

export async function putUserMasterKey(
  userId: string,
  umk: UserMasterKey,
): Promise<void> {
  const db = await getDb();
  const row: UserMasterKeyRow = { userId, umk, createdAt: Date.now() };
  await db.put(STORE_USER_MASTER_KEY, row);
}

export async function getUserMasterKey(
  userId: string,
): Promise<UserMasterKey | null> {
  const db = await getDb();
  const row = (await db.get(STORE_USER_MASTER_KEY, userId)) as
    | UserMasterKeyRow
    | undefined;
  return row?.umk ?? null;
}

export async function clearUserMasterKey(userId: string): Promise<void> {
  const db = await getDb();
  await db.delete(STORE_USER_MASTER_KEY, userId);
}

// ---------------------------------------------------------------------------
// Device registration metadata
// ---------------------------------------------------------------------------

export async function putDeviceRecord(
  userId: string,
  deviceId: string,
  displayName: string,
): Promise<void> {
  const db = await getDb();
  const row: DeviceRow = { userId, deviceId, displayName };
  await db.put(STORE_DEVICE, row);
}

export async function getDeviceRecord(
  userId: string,
): Promise<{ deviceId: string; displayName: string } | null> {
  const db = await getDb();
  const row = (await db.get(STORE_DEVICE, userId)) as DeviceRow | undefined;
  return row ? { deviceId: row.deviceId, displayName: row.displayName } : null;
}

// ---------------------------------------------------------------------------
// Back-compat shim: `getIdentity` / `clearIdentity` / `putIdentity`
//
// Several app-layer call sites still use the legacy name. In v2, "identity"
// used to mean the combined root-identity. In v3 it has no canonical
// equivalent — callers need EITHER the device bundle OR the UMK depending
// on what they're doing. These shims return the device bundle shape when
// possible (most callers want device keys), so legacy code that only needs
// to detect "do we have keys on this device" keeps working.
// ---------------------------------------------------------------------------

/**
 * @deprecated Use `getDeviceBundle` or `getUserMasterKey`. This shim returns
 * a deprecated Identity-shaped object (device ed + device x) for back-compat
 * with code that still reads `identity.ed25519PrivateKey` / `.x25519PublicKey`.
 */
export async function getIdentity(userId: string): Promise<{
  ed25519PublicKey: Uint8Array;
  ed25519PrivateKey: Uint8Array;
  x25519PublicKey: Uint8Array;
  x25519PrivateKey: Uint8Array;
} | null> {
  const bundle = await getDeviceBundle(userId);
  if (!bundle) return null;
  return {
    ed25519PublicKey: bundle.ed25519PublicKey,
    ed25519PrivateKey: bundle.ed25519PrivateKey,
    x25519PublicKey: bundle.x25519PublicKey,
    x25519PrivateKey: bundle.x25519PrivateKey,
  };
}

/** @deprecated Clears the device bundle. UMK (if any) is NOT cleared. */
export async function clearIdentity(userId: string): Promise<void> {
  await clearDeviceBundle(userId);
}

/**
 * @deprecated Back-compat: extract the device halves from an Identity shape
 * and store them in the device-bundle slot. Caller is responsible for
 * having generated a deviceId UUID for this bundle.
 */
export async function putIdentity(
  userId: string,
  identity: {
    ed25519PublicKey: Uint8Array;
    ed25519PrivateKey: Uint8Array;
    x25519PublicKey: Uint8Array;
    x25519PrivateKey: Uint8Array;
  },
  deviceId?: string,
): Promise<void> {
  const existing = await getDeviceBundle(userId);
  const id = deviceId ?? existing?.deviceId;
  if (!id) {
    throw new Error(
      'putIdentity (legacy): deviceId required when no device bundle exists yet',
    );
  }
  await putDeviceBundle(userId, {
    deviceId: id,
    ed25519PublicKey: identity.ed25519PublicKey,
    ed25519PrivateKey: identity.ed25519PrivateKey,
    x25519PublicKey: identity.x25519PublicKey,
    x25519PrivateKey: identity.x25519PrivateKey,
  });
}

// ---------------------------------------------------------------------------
// TOFU cache (unchanged shape; tracks UMK pub for users in v3)
// ---------------------------------------------------------------------------

export async function putKnownContact(contact: KnownContact): Promise<void> {
  const db = await getDb();
  await db.put(STORE_KNOWN_CONTACTS, contact);
}

export async function getKnownContact(userId: string): Promise<KnownContact | null> {
  const db = await getDb();
  const row = (await db.get(STORE_KNOWN_CONTACTS, userId)) as
    | KnownContact
    | undefined;
  return row ?? null;
}

export async function listKnownContacts(): Promise<KnownContact[]> {
  const db = await getDb();
  return (await db.getAll(STORE_KNOWN_CONTACTS)) as KnownContact[];
}

// ---------------------------------------------------------------------------
// Wipe everything (device reset)
// ---------------------------------------------------------------------------

export async function wipeAll(): Promise<void> {
  const db = await getDb();
  await Promise.all([
    db.clear(STORE_DEVICE_BUNDLE),
    db.clear(STORE_USER_MASTER_KEY),
    db.clear(STORE_DEVICE),
    db.clear(STORE_KNOWN_CONTACTS),
    db.clear(STORE_WRAPPED_IDENTITY),
    db.clear(STORE_BACKUP_KEY),
    db.clear(STORE_SELF_SIGNING_KEY),
    db.clear(STORE_USER_SIGNING_KEY),
    db.clear(STORE_OUTBOUND_SESSIONS),
    db.clear(STORE_INBOUND_SESSIONS),
  ]);
}

// ---------------------------------------------------------------------------
// Backup key (server-side room-key backup)
// ---------------------------------------------------------------------------

export async function putBackupKey(
  userId: string,
  key: Uint8Array,
): Promise<void> {
  const db = await getDb();
  const row: BackupKeyRow = { userId, key, createdAt: Date.now() };
  await db.put(STORE_BACKUP_KEY, row);
}

export async function getBackupKey(
  userId: string,
): Promise<Uint8Array | null> {
  const db = await getDb();
  const row = (await db.get(STORE_BACKUP_KEY, userId)) as
    | BackupKeyRow
    | undefined;
  return row?.key ?? null;
}

export async function clearBackupKey(userId: string): Promise<void> {
  const db = await getDb();
  await db.delete(STORE_BACKUP_KEY, userId);
}

// ---------------------------------------------------------------------------
// Self-Signing Key (co-primary devices; signs device certs)
// ---------------------------------------------------------------------------

export async function putSelfSigningKey(
  userId: string,
  ssk: SelfSigningKey,
): Promise<void> {
  const db = await getDb();
  const row: SelfSigningKeyRow = { userId, ssk, createdAt: Date.now() };
  await db.put(STORE_SELF_SIGNING_KEY, row);
}

export async function getSelfSigningKey(
  userId: string,
): Promise<SelfSigningKey | null> {
  const db = await getDb();
  const row = (await db.get(STORE_SELF_SIGNING_KEY, userId)) as
    | SelfSigningKeyRow
    | undefined;
  return row?.ssk ?? null;
}

export async function clearSelfSigningKey(userId: string): Promise<void> {
  const db = await getDb();
  await db.delete(STORE_SELF_SIGNING_KEY, userId);
}

// ---------------------------------------------------------------------------
// User-Signing Key (co-primary devices; signs other users' MSK pubs)
// ---------------------------------------------------------------------------

export async function putUserSigningKey(
  userId: string,
  usk: UserSigningKey,
): Promise<void> {
  const db = await getDb();
  const row: UserSigningKeyRow = { userId, usk, createdAt: Date.now() };
  await db.put(STORE_USER_SIGNING_KEY, row);
}

export async function getUserSigningKey(
  userId: string,
): Promise<UserSigningKey | null> {
  const db = await getDb();
  const row = (await db.get(STORE_USER_SIGNING_KEY, userId)) as
    | UserSigningKeyRow
    | undefined;
  return row?.usk ?? null;
}

export async function clearUserSigningKey(userId: string): Promise<void> {
  const db = await getDb();
  await db.delete(STORE_USER_SIGNING_KEY, userId);
}

// ---------------------------------------------------------------------------
// Megolm outbound sessions (one per room per device)
// ---------------------------------------------------------------------------

function outboundKey(roomId: string, deviceId: string): string {
  return `${roomId}:${deviceId}`;
}

export async function putOutboundSession(
  roomId: string,
  deviceId: string,
  session: OutboundMegolmSession,
): Promise<void> {
  const db = await getDb();
  const row: OutboundSessionRow = { key: outboundKey(roomId, deviceId), session };
  await db.put(STORE_OUTBOUND_SESSIONS, row);
}

export async function getOutboundSession(
  roomId: string,
  deviceId: string,
): Promise<OutboundMegolmSession | null> {
  const db = await getDb();
  const row = (await db.get(STORE_OUTBOUND_SESSIONS, outboundKey(roomId, deviceId))) as
    | OutboundSessionRow
    | undefined;
  return row?.session ?? null;
}

export async function clearOutboundSession(
  roomId: string,
  deviceId: string,
): Promise<void> {
  const db = await getDb();
  await db.delete(STORE_OUTBOUND_SESSIONS, outboundKey(roomId, deviceId));
}

// ---------------------------------------------------------------------------
// Megolm inbound sessions (one per sender-device per session)
// ---------------------------------------------------------------------------

function inboundKey(sessionIdBase64: string, senderDeviceId: string): string {
  return `${sessionIdBase64}:${senderDeviceId}`;
}

export async function putInboundSession(
  sessionIdBase64: string,
  senderDeviceId: string,
  snapshot: InboundSessionSnapshot,
): Promise<void> {
  const db = await getDb();
  const row: InboundSessionRow = {
    key: inboundKey(sessionIdBase64, senderDeviceId),
    snapshot,
  };
  await db.put(STORE_INBOUND_SESSIONS, row);
}

export async function getInboundSession(
  sessionIdBase64: string,
  senderDeviceId: string,
): Promise<InboundSessionSnapshot | null> {
  const db = await getDb();
  const row = (await db.get(
    STORE_INBOUND_SESSIONS,
    inboundKey(sessionIdBase64, senderDeviceId),
  )) as InboundSessionRow | undefined;
  return row?.snapshot ?? null;
}

// ---------------------------------------------------------------------------
// Passphrase-wrapped state (opt-in)
// ---------------------------------------------------------------------------

export async function putWrappedIdentity(
  userId: string,
  blob: PinWrappedIdentity,
): Promise<void> {
  const db = await getDb();
  const row: WrappedIdentityRow = { userId, blob, createdAt: Date.now() };
  await db.put(STORE_WRAPPED_IDENTITY, row);
}

export async function getWrappedIdentity(
  userId: string,
): Promise<PinWrappedIdentity | null> {
  const db = await getDb();
  const row = (await db.get(STORE_WRAPPED_IDENTITY, userId)) as
    | WrappedIdentityRow
    | undefined;
  return row?.blob ?? null;
}

export async function hasWrappedIdentity(userId: string): Promise<boolean> {
  return (await getWrappedIdentity(userId)) != null;
}

export async function clearWrappedIdentity(userId: string): Promise<void> {
  const db = await getDb();
  await db.delete(STORE_WRAPPED_IDENTITY, userId);
}
