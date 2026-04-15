/**
 * Per-device identity primitives (v2).
 *
 * A user has:
 *   - exactly one UserMasterKey (UMK): an Ed25519 keypair whose private half
 *     lives on the primary device (and, via recovery, can be re-materialised
 *     on a new device). The UMK signs ONLY device certificates + revocations.
 *   - N DeviceKeyBundles, one per device: Ed25519 for operational signing
 *     (blobs, membership ops) + X25519 for receiving sealed room keys. Each
 *     device generates its own bundle locally; the private halves never
 *     leave the device.
 *
 * A device is "trusted" iff its issuance certificate verifies against the
 * user's published UMK pub, AND there is no valid revocation cert against it.
 *
 * Canonical byte layouts (domain-tagged, fixed-width fields):
 *
 *   Issuance:
 *     "vibecheck:devcert:v1" ||
 *     user_id (16 bytes) || device_id (16 bytes) ||
 *     device_ed_pub (32 bytes) || device_x_pub (32 bytes) ||
 *     created_at_ms (8 bytes BE u64)
 *
 *   Revocation:
 *     "vibecheck:devrev:v1"  ||
 *     user_id (16 bytes) || device_id (16 bytes) ||
 *     revoked_at_ms (8 bytes BE u64)
 *
 * Verifiers must reject malformed input (wrong lengths, unparsable UUIDs)
 * before attempting signature verification.
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

const CERT_DOMAIN = stringToBytes('vibecheck:devcert:v1');
const REVOCATION_DOMAIN = stringToBytes('vibecheck:devrev:v1');

async function uuidBytes(id: string): Promise<Bytes> {
  return fromHex(id.replaceAll('-', ''));
}

function u64BE(n: number): Bytes {
  const buf = new Uint8Array(8);
  new DataView(buf.buffer).setBigUint64(0, BigInt(n | 0), false);
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

async function canonicalIssuanceMessage(f: IssuanceFields): Promise<Bytes> {
  return concatBytes(
    CERT_DOMAIN,
    await uuidBytes(f.userId),
    await uuidBytes(f.deviceId),
    f.deviceEd25519PublicKey,
    f.deviceX25519PublicKey,
    u64BE(f.createdAtMs),
  );
}

/** Sign an issuance certificate with the UMK priv. */
export async function signDeviceIssuance(
  fields: IssuanceFields,
  umkPrivateKey: Bytes,
): Promise<Bytes> {
  return signMessage(await canonicalIssuanceMessage(fields), umkPrivateKey);
}

/**
 * Verify an issuance certificate against a user's UMK pub. Throws
 * `CERT_INVALID` on mismatch — caller refuses to trust the device.
 */
export async function verifyDeviceIssuance(
  fields: IssuanceFields,
  signature: Bytes,
  umkPublicKey: Bytes,
): Promise<void> {
  try {
    await verifyMessageOrThrow(
      await canonicalIssuanceMessage(fields),
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

async function canonicalRevocationMessage(f: RevocationFields): Promise<Bytes> {
  return concatBytes(
    REVOCATION_DOMAIN,
    await uuidBytes(f.userId),
    await uuidBytes(f.deviceId),
    u64BE(f.revokedAtMs),
  );
}

/** Sign a revocation certificate with UMK priv. */
export async function signDeviceRevocation(
  fields: RevocationFields,
  umkPrivateKey: Bytes,
): Promise<Bytes> {
  return signMessage(await canonicalRevocationMessage(fields), umkPrivateKey);
}

/**
 * Verify a revocation certificate against UMK pub. Throws on mismatch.
 * Callers that find a revocation signature present but failing verification
 * should treat it as "revocation not proven" — they do NOT get to fall back
 * to trusting the device, because that would let an attacker present a bogus
 * revocation to re-activate a device. Instead: treat any unverifiable
 * revocation as a server-tampering signal and abort.
 */
export async function verifyDeviceRevocation(
  fields: RevocationFields,
  signature: Bytes,
  umkPublicKey: Bytes,
): Promise<void> {
  try {
    await verifyMessageOrThrow(
      await canonicalRevocationMessage(fields),
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
 * Verify a PublicDevice end-to-end against a UMK pub. Returns normally iff
 * the device is currently trustworthy (valid issuance + no revocation).
 * Throws `CERT_INVALID` on any signature failure or `DEVICE_REVOKED` if the
 * revocation cert is present and verifies.
 */
export async function verifyPublicDevice(
  device: PublicDevice,
  umkPublicKey: Bytes,
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
): Promise<PublicDevice[]> {
  const out: PublicDevice[] = [];
  for (const d of devices) {
    try {
      await verifyPublicDevice(d, umkPublicKey);
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
