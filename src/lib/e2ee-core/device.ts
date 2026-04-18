/**
 * Per-device identity primitives.
 *
 * Cert versions:
 *   v1 (domain "vibecheck:devcert:v1") — signed by UMK/MSK. Pre-cross-signing.
 *   v2 (domain "vibecheck:devcert:v2") — signed by SSK. Requires MSK→SSK
 *       cross-sig chain for verification. Same byte layout as v1 modulo domain.
 *
 * Revocation versions:
 *   v1 (domain "vibecheck:devrev:v1") — signed by UMK/MSK.
 *   v2 (domain "vibecheck:devrev:v2") — signed by SSK.
 *
 * verifyPublicDevice accepts optional sskPub: if present, tries v2 cert
 * domain first; falls back to v1 (MSK-signed) for backward compat.
 */

import {
  CryptoError,
  type Bytes,
  type DeviceKeyBundle,
  type DeviceRevocation,
  type PublicDevice,
  type UserMasterKey,
} from './types';
import {
  bytesToString,
  concatBytes,
  fromHex,
  getSodium,
  stringToBytes,
} from './sodium';
import { signMessage, verifyMessageOrThrow } from './identity';

const DEVICE_NAME_MAX_BYTES = 128;

const CERT_DOMAIN_V1 = stringToBytes('vibecheck:devcert:v1');
const CERT_DOMAIN_V2 = stringToBytes('vibecheck:devcert:v2');
const REVOCATION_DOMAIN_V1 = stringToBytes('vibecheck:devrev:v1');
const REVOCATION_DOMAIN_V2 = stringToBytes('vibecheck:devrev:v2');

async function uuidBytes(id: string): Promise<Bytes> {
  return fromHex(id.replaceAll('-', ''));
}

function u64BE(n: number): Bytes {
  const buf = new Uint8Array(8);
  new DataView(buf.buffer).setBigUint64(0, BigInt.asUintN(64, BigInt(Math.trunc(n))), false);
  return buf;
}

// ---------------------------------------------------------------------------
// UMK generation
// ---------------------------------------------------------------------------

/**
 * Generate a fresh User Master Key. Output should be treated as irreplaceable
 * long-term material: wrap it in the recovery phrase, the passphrase lock,
 * or both, before persisting.
 */
export async function generateUserMasterKey(): Promise<UserMasterKey> {
  const sodium = await getSodium();
  const sign = sodium.crypto_sign_keypair();
  return {
    ed25519PublicKey: sign.publicKey,
    ed25519PrivateKey: sign.privateKey,
  };
}

// ---------------------------------------------------------------------------
// Device bundle generation
// ---------------------------------------------------------------------------

/**
 * Generate a fresh Device Key Bundle. Each device calls this ONCE at
 * registration time. The private halves never leave this device.
 * `deviceId` is a UUID (typically generated server-side when the row is
 * inserted, or client-side via `crypto.randomUUID()`); callers choose.
 */
export async function generateDeviceKeyBundle(
  deviceId: string,
): Promise<DeviceKeyBundle> {
  if (!/^[0-9a-f-]{32,36}$/i.test(deviceId)) {
    throw new CryptoError('deviceId must be a UUID-shaped hex string', 'BAD_INPUT');
  }
  const sodium = await getSodium();
  const sign = sodium.crypto_sign_keypair();
  const box = sodium.crypto_box_keypair();
  return {
    deviceId,
    ed25519PublicKey: sign.publicKey,
    ed25519PrivateKey: sign.privateKey,
    x25519PublicKey: box.publicKey,
    x25519PrivateKey: box.privateKey,
  };
}

// ---------------------------------------------------------------------------
// Issuance certificates
// ---------------------------------------------------------------------------

export interface IssuanceFields {
  userId: string;
  deviceId: string;
  deviceEd25519PublicKey: Bytes;
  deviceX25519PublicKey: Bytes;
  createdAtMs: number;
}

async function canonicalIssuanceMessage(
  f: IssuanceFields,
  domain: Bytes,
): Promise<Bytes> {
  return concatBytes(
    domain,
    await uuidBytes(f.userId),
    await uuidBytes(f.deviceId),
    f.deviceEd25519PublicKey,
    f.deviceX25519PublicKey,
    u64BE(f.createdAtMs),
  );
}

/** Sign an issuance certificate with the UMK/MSK priv (v1 cert). */
export async function signDeviceIssuance(
  fields: IssuanceFields,
  umkPrivateKey: Bytes,
): Promise<Bytes> {
  return signMessage(
    await canonicalIssuanceMessage(fields, CERT_DOMAIN_V1),
    umkPrivateKey,
  );
}

/** Sign an issuance certificate with the SSK priv (v2 cert). */
export async function signDeviceIssuanceV2(
  fields: IssuanceFields,
  sskPrivateKey: Bytes,
): Promise<Bytes> {
  return signMessage(
    await canonicalIssuanceMessage(fields, CERT_DOMAIN_V2),
    sskPrivateKey,
  );
}

/**
 * Verify an issuance certificate. Tries v2 (SSK-signed) first if sskPub
 * is provided; falls back to v1 (MSK-signed). Throws CERT_INVALID on
 * mismatch.
 */
export async function verifyDeviceIssuance(
  fields: IssuanceFields,
  signature: Bytes,
  umkPublicKey: Bytes,
  sskPublicKey?: Bytes,
): Promise<void> {
  if (sskPublicKey) {
    try {
      await verifyMessageOrThrow(
        await canonicalIssuanceMessage(fields, CERT_DOMAIN_V2),
        signature,
        sskPublicKey,
      );
      return;
    } catch {
      // v2 failed — fall through to v1
    }
  }
  try {
    await verifyMessageOrThrow(
      await canonicalIssuanceMessage(fields, CERT_DOMAIN_V1),
      signature,
      umkPublicKey,
    );
  } catch (err) {
    if (err instanceof CryptoError && err.code === 'SIGNATURE_INVALID') {
      throw new CryptoError('device issuance cert did not verify', 'CERT_INVALID');
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Revocation certificates
// ---------------------------------------------------------------------------

export interface RevocationFields {
  userId: string;
  deviceId: string;
  revokedAtMs: number;
}

async function canonicalRevocationMessage(
  f: RevocationFields,
  domain: Bytes,
): Promise<Bytes> {
  return concatBytes(
    domain,
    await uuidBytes(f.userId),
    await uuidBytes(f.deviceId),
    u64BE(f.revokedAtMs),
  );
}

/** Sign a revocation certificate with UMK/MSK priv (v1). */
export async function signDeviceRevocation(
  fields: RevocationFields,
  umkPrivateKey: Bytes,
): Promise<Bytes> {
  return signMessage(
    await canonicalRevocationMessage(fields, REVOCATION_DOMAIN_V1),
    umkPrivateKey,
  );
}

/** Sign a revocation certificate with SSK priv (v2). */
export async function signDeviceRevocationV2(
  fields: RevocationFields,
  sskPrivateKey: Bytes,
): Promise<Bytes> {
  return signMessage(
    await canonicalRevocationMessage(fields, REVOCATION_DOMAIN_V2),
    sskPrivateKey,
  );
}

/**
 * Verify a revocation certificate. Tries v2 (SSK-signed) first if sskPub
 * is provided; falls back to v1 (MSK-signed).
 */
export async function verifyDeviceRevocation(
  fields: RevocationFields,
  signature: Bytes,
  umkPublicKey: Bytes,
  sskPublicKey?: Bytes,
): Promise<void> {
  if (sskPublicKey) {
    try {
      await verifyMessageOrThrow(
        await canonicalRevocationMessage(fields, REVOCATION_DOMAIN_V2),
        signature,
        sskPublicKey,
      );
      return;
    } catch {
      // v2 failed — fall through to v1
    }
  }
  try {
    await verifyMessageOrThrow(
      await canonicalRevocationMessage(fields, REVOCATION_DOMAIN_V1),
      signature,
      umkPublicKey,
    );
  } catch (err) {
    if (err instanceof CryptoError && err.code === 'SIGNATURE_INVALID') {
      throw new CryptoError('device revocation cert did not verify', 'CERT_INVALID');
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Full-device trust check
// ---------------------------------------------------------------------------

/**
 * Verify a PublicDevice end-to-end. Returns normally iff the device is
 * currently trustworthy (valid issuance + no revocation). Throws
 * CERT_INVALID on any signature failure or DEVICE_REVOKED if the
 * revocation cert is present and verifies.
 *
 * If `sskPublicKey` is provided, v2 certs (SSK-signed) are tried first,
 * falling back to v1 (MSK-signed). This keeps backward compat with
 * pre-cross-signing devices.
 */
export async function verifyPublicDevice(
  device: PublicDevice,
  umkPublicKey: Bytes,
  sskPublicKey?: Bytes,
): Promise<void> {
  await verifyDeviceIssuance(
    {
      userId: device.userId,
      deviceId: device.deviceId,
      deviceEd25519PublicKey: device.ed25519PublicKey,
      deviceX25519PublicKey: device.x25519PublicKey,
      createdAtMs: device.createdAtMs,
    },
    device.issuanceSignature,
    umkPublicKey,
    sskPublicKey,
  );
  if (device.revocation) {
    await verifyDeviceRevocation(
      {
        userId: device.userId,
        deviceId: device.deviceId,
        revokedAtMs: device.revocation.revokedAtMs,
      },
      device.revocation.signature,
      umkPublicKey,
      sskPublicKey,
    );
    throw new CryptoError(
      `device ${device.deviceId} is revoked (since ${new Date(device.revocation.revokedAtMs).toISOString()})`,
      'DEVICE_REVOKED',
    );
  }
}

/** Convenience: filter a device list to the ones currently trustworthy. */
export async function filterActiveDevices(
  devices: PublicDevice[],
  umkPublicKey: Bytes,
  sskPublicKey?: Bytes,
): Promise<PublicDevice[]> {
  const out: PublicDevice[] = [];
  for (const d of devices) {
    try {
      await verifyPublicDevice(d, umkPublicKey, sskPublicKey);
      out.push(d);
    } catch (err) {
      if (
        err instanceof CryptoError &&
        (err.code === 'DEVICE_REVOKED' || err.code === 'CERT_INVALID')
      ) {
        continue;
      }
      throw err;
    }
  }
  return out;
}

/** Re-export for DeviceRevocation consumers outside this module. */
export type { DeviceRevocation };

// ---------------------------------------------------------------------------
// Display-name encryption (sealed-box-to-self)
//
// Each device encrypts its own `display_name` with `crypto_box_seal` to its
// own X25519 pub. Only the holder of the matching X25519 priv (i.e. the
// device itself) can decrypt. Other co-devices of the same user see the row
// but can't read the label — they fall back to device_id + createdAt in UI.
//
// Why not a user-level symmetric key: distributing it to every device is
// equivalent complexity to the full-device-list encryption story, and
// display_name is low-value enough that a per-device ciphertext is fine.
// The Supabase operator no longer sees "Sam's iPhone".
// ---------------------------------------------------------------------------

export async function encryptDeviceDisplayName(
  displayName: string,
  ownX25519PublicKey: Bytes,
): Promise<Bytes> {
  const trimmed = displayName.trim();
  if (!trimmed) {
    throw new CryptoError('device display name cannot be empty', 'BAD_INPUT');
  }
  const plaintext = stringToBytes(trimmed);
  if (plaintext.length > DEVICE_NAME_MAX_BYTES) {
    throw new CryptoError(
      `display name too long (${plaintext.length} > ${DEVICE_NAME_MAX_BYTES} bytes)`,
      'BAD_INPUT',
    );
  }
  const sodium = await getSodium();
  const ciphertext = sodium.crypto_box_seal(plaintext, ownX25519PublicKey);
  sodium.memzero(plaintext);
  return ciphertext;
}

/**
 * Decrypt a device's own display name. Returns null if the ciphertext can't
 * be opened — either because the viewing device is not the one that wrote it
 * (different x25519 priv) or the bytes are tampered.
 */
export async function decryptDeviceDisplayName(
  ciphertext: Bytes,
  ownX25519PublicKey: Bytes,
  ownX25519PrivateKey: Bytes,
): Promise<string | null> {
  const sodium = await getSodium();
  let plaintext: Bytes;
  try {
    plaintext = sodium.crypto_box_seal_open(
      ciphertext,
      ownX25519PublicKey,
      ownX25519PrivateKey,
    );
  } catch {
    return null;
  }
  try {
    return bytesToString(plaintext);
  } finally {
    sodium.memzero(plaintext);
  }
}
