/**
 * PIN/passphrase-based lock for the device-local identity in IndexedDB.
 *
 * Without this, `Identity` private keys sit in IndexedDB as plaintext —
 * readable by any browser-extension-with-storage-permission, any forensic
 * read of an unencrypted disk, or any subsequent user of the same browser
 * profile. With this: the identity is wrapped under an Argon2id-derived key
 * and can only be unlocked by typing the passphrase that created it.
 *
 * Threat model:
 *   - Attacker who has raw IDB bytes (disk forensics, extension, malware):
 *     must brute-force the PIN against Argon2id. For a ≥8-char random
 *     passphrase that's infeasible; for a 6-digit PIN it's feasible but
 *     slow enough to detect and rotate from. The user chooses.
 *   - Attacker who has code execution on the unlocked session: they can
 *     simply read the in-memory unwrapped identity. This module does not
 *     defend against that — no web app can.
 *
 * Parameters match `recovery.ts` (opslimit=3, memlimit=256 MiB) so a user's
 * CPU/memory budget is the same. Params are stored alongside each blob so
 * they can be raised for new enrollments without breaking old ones.
 */

import {
  CryptoError,
  type Bytes,
  type DeviceKeyBundle,
  type SelfSigningKey,
  type UserMasterKey,
  type UserSigningKey,
} from './types';
import { concatBytes, getSodium, randomBytes, stringToBytes } from './sodium';

const PIN_NONCE_BYTES = 24;
const PIN_SALT_BYTES = 16;
const DEFAULT_OPSLIMIT = 3;
const DEFAULT_MEMLIMIT = 256 * 1024 * 1024;

/**
 * Opaque wrapped-identity payload. Safe to persist in IndexedDB.
 *
 * v2 plaintext: `[has_umk(1)] [deviceId(36)] [dev_ed_priv(64)]
 *   [dev_x_priv(32)] [dev_ed_pub(32)] [dev_x_pub(32)] [umk_ed_priv(64)?]`
 *
 * v3 plaintext (cross-signing): `[has_msk(1)] [has_ssk(1)] [has_usk(1)]
 *   [deviceId(36)] [dev_ed_priv(64)] [dev_x_priv(32)] [dev_ed_pub(32)] [dev_x_pub(32)]
 *   [msk_ed_priv(64)?] [ssk_ed_priv(64)?] [usk_ed_priv(64)?]`
 */
export interface PinWrappedIdentity {
  ciphertext: Bytes;
  nonce: Bytes;
  kdfSalt: Bytes;
  kdfOpslimit: number;
  kdfMemlimit: number;
}

async function deriveKey(
  passphrase: string,
  salt: Bytes,
  opslimit: number,
  memlimit: number,
): Promise<Bytes> {
  const sodium = await getSodium();
  const bytes = stringToBytes(passphrase.normalize('NFC'));
  try {
    return sodium.crypto_pwhash(
      32,
      bytes,
      salt,
      opslimit,
      memlimit,
      sodium.crypto_pwhash_ALG_ARGON2ID13,
    );
  } finally {
    sodium.memzero(bytes);
  }
}

/**
 * Wrap this device's state under a passphrase. Produces v3 format when
 * SSK/USK are provided; falls back to v2 for backward compat.
 */
export async function wrapDeviceStateWithPin(
  deviceBundle: DeviceKeyBundle,
  umk: UserMasterKey | null,
  passphrase: string,
  userId: string,
  opts?: {
    opslimit?: number;
    memlimit?: number;
    ssk?: SelfSigningKey | null;
    usk?: UserSigningKey | null;
  },
): Promise<PinWrappedIdentity> {
  if (!passphrase || passphrase.length < 4) {
    throw new CryptoError('passphrase must be at least 4 characters', 'BAD_INPUT');
  }
  if (deviceBundle.deviceId.length !== 36) {
    throw new CryptoError(
      'deviceId must be a 36-char UUID string',
      'BAD_INPUT',
    );
  }
  const sodium = await getSodium();
  const opslimit = opts?.opslimit ?? DEFAULT_OPSLIMIT;
  const memlimit = opts?.memlimit ?? DEFAULT_MEMLIMIT;
  const kdfSalt = await randomBytes(PIN_SALT_BYTES);
  const key = await deriveKey(passphrase, kdfSalt, opslimit, memlimit);
  try {
    const nonce = await randomBytes(PIN_NONCE_BYTES);
    const deviceIdBytes = stringToBytes(deviceBundle.deviceId);
    const useCrossSigning = !!(opts?.ssk || opts?.usk);
    let packed: Bytes;
    let adTag: string;

    if (useCrossSigning) {
      // v3: 3 flag bytes + device bundle + optional MSK/SSK/USK privs
      const parts: Bytes[] = [
        new Uint8Array([umk ? 1 : 0, opts?.ssk ? 1 : 0, opts?.usk ? 1 : 0]),
        deviceIdBytes,
        deviceBundle.ed25519PrivateKey,
        deviceBundle.x25519PrivateKey,
        deviceBundle.ed25519PublicKey,
        deviceBundle.x25519PublicKey,
      ];
      if (umk) parts.push(umk.ed25519PrivateKey);
      if (opts?.ssk) parts.push(opts.ssk.ed25519PrivateKey);
      if (opts?.usk) parts.push(opts.usk.ed25519PrivateKey);
      packed = concatBytes(...parts);
      adTag = `vibecheck:pinlock:v3:${userId}`;
    } else {
      // v2: 1 flag byte + device bundle + optional UMK priv
      const parts: Bytes[] = [
        new Uint8Array([umk ? 1 : 0]),
        deviceIdBytes,
        deviceBundle.ed25519PrivateKey,
        deviceBundle.x25519PrivateKey,
        deviceBundle.ed25519PublicKey,
        deviceBundle.x25519PublicKey,
      ];
      if (umk) parts.push(umk.ed25519PrivateKey);
      packed = concatBytes(...parts);
      adTag = `vibecheck:pinlock:v2:${userId}`;
    }

    const ad = stringToBytes(adTag);
    const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
      packed,
      ad,
      null,
      nonce,
      key,
    );
    sodium.memzero(packed);
    return { ciphertext, nonce, kdfSalt, kdfOpslimit: opslimit, kdfMemlimit: memlimit };
  } finally {
    sodium.memzero(key);
  }
}

export interface UnlockedDeviceState {
  deviceBundle: DeviceKeyBundle;
  /** Present iff this device was the MSK/UMK-holder at wrap time. */
  umk: UserMasterKey | null;
  /** Present iff this device held SSK at wrap time (v3 format). */
  ssk: SelfSigningKey | null;
  /** Present iff this device held USK at wrap time (v3 format). */
  usk: UserSigningKey | null;
}

/**
 * Unlock a pin-wrapped device state. Tries v3 AD first (cross-signing),
 * falls back to v2. Throws DECRYPT_FAILED on wrong passphrase.
 */
export async function unwrapDeviceStateWithPin(
  blob: PinWrappedIdentity,
  passphrase: string,
  userId: string,
): Promise<UnlockedDeviceState> {
  const sodium = await getSodium();
  const key = await deriveKey(
    passphrase,
    blob.kdfSalt,
    blob.kdfOpslimit,
    blob.kdfMemlimit,
  );
  let packed: Bytes;
  let isV3 = false;
  try {
    const adV3 = stringToBytes(`vibecheck:pinlock:v3:${userId}`);
    const adV2 = stringToBytes(`vibecheck:pinlock:v2:${userId}`);
    try {
      packed = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
        null, blob.ciphertext, adV3, blob.nonce, key,
      );
      isV3 = true;
    } catch {
      try {
        packed = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
          null, blob.ciphertext, adV2, blob.nonce, key,
        );
      } catch {
        throw new CryptoError('passphrase did not match', 'DECRYPT_FAILED');
      }
    }
  } finally {
    sodium.memzero(key);
  }

  try {
    if (isV3) {
      return unwrapV3(packed, sodium);
    }
    return unwrapV2(packed, sodium);
  } finally {
    sodium.memzero(packed);
  }
}

function unwrapV2(
  packed: Bytes,
  sodium: Awaited<ReturnType<typeof getSodium>>,
): UnlockedDeviceState {
  // v2: has_umk(1) + deviceId(36) + ed_priv(64) + x_priv(32) + ed_pub(32) + x_pub(32) [+ umk(64)]
  const BASE = 1 + 36 + 64 + 32 + 32 + 32; // 197
  if (packed.byteLength !== BASE && packed.byteLength !== BASE + 64) {
    throw new CryptoError('wrapped device state has unexpected length', 'BAD_KEY_LENGTH');
  }
  const hasUmk = packed[0] === 1;
  const deviceId = new TextDecoder().decode(packed.slice(1, 37));
  const deviceBundle: DeviceKeyBundle = {
    deviceId,
    ed25519PrivateKey: packed.slice(37, 101),
    x25519PrivateKey: packed.slice(101, 133),
    ed25519PublicKey: packed.slice(133, 165),
    x25519PublicKey: packed.slice(165, 197),
  };
  const umk: UserMasterKey | null = hasUmk
    ? {
        ed25519PublicKey: sodium.crypto_sign_ed25519_sk_to_pk(packed.slice(197, 261)),
        ed25519PrivateKey: packed.slice(197, 261),
      }
    : null;
  return { deviceBundle, umk, ssk: null, usk: null };
}

function unwrapV3(
  packed: Bytes,
  sodium: Awaited<ReturnType<typeof getSodium>>,
): UnlockedDeviceState {
  // v3: has_msk(1) + has_ssk(1) + has_usk(1) + deviceId(36) +
  //     ed_priv(64) + x_priv(32) + ed_pub(32) + x_pub(32)
  //     [+ msk(64)] [+ ssk(64)] [+ usk(64)]
  const FLAGS = 3;
  const BUNDLE = 36 + 64 + 32 + 32 + 32; // 196
  const hasMsk = packed[0] === 1;
  const hasSsk = packed[1] === 1;
  const hasUsk = packed[2] === 1;
  const expectedLen = FLAGS + BUNDLE
    + (hasMsk ? 64 : 0)
    + (hasSsk ? 64 : 0)
    + (hasUsk ? 64 : 0);
  if (packed.byteLength !== expectedLen) {
    throw new CryptoError('wrapped device state v3 has unexpected length', 'BAD_KEY_LENGTH');
  }
  let offset = FLAGS;
  const deviceId = new TextDecoder().decode(packed.slice(offset, offset + 36));
  offset += 36;
  const deviceBundle: DeviceKeyBundle = {
    deviceId,
    ed25519PrivateKey: packed.slice(offset, offset + 64),
    x25519PrivateKey: packed.slice(offset + 64, offset + 96),
    ed25519PublicKey: packed.slice(offset + 96, offset + 128),
    x25519PublicKey: packed.slice(offset + 128, offset + 160),
  };
  offset += 160;

  let umk: UserMasterKey | null = null;
  if (hasMsk) {
    const priv = packed.slice(offset, offset + 64);
    umk = {
      ed25519PublicKey: sodium.crypto_sign_ed25519_sk_to_pk(priv),
      ed25519PrivateKey: priv,
    };
    offset += 64;
  }
  let ssk: SelfSigningKey | null = null;
  if (hasSsk) {
    const priv = packed.slice(offset, offset + 64);
    ssk = {
      ed25519PublicKey: sodium.crypto_sign_ed25519_sk_to_pk(priv),
      ed25519PrivateKey: priv,
    };
    offset += 64;
  }
  let usk: UserSigningKey | null = null;
  if (hasUsk) {
    const priv = packed.slice(offset, offset + 64);
    usk = {
      ed25519PublicKey: sodium.crypto_sign_ed25519_sk_to_pk(priv),
      ed25519PrivateKey: priv,
    };
    offset += 64;
  }
  return { deviceBundle, umk, ssk, usk };
}
