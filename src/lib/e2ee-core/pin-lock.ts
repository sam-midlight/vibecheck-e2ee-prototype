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
  type UserMasterKey,
} from './types';
import { concatBytes, getSodium, randomBytes, stringToBytes } from './sodium';

const PIN_NONCE_BYTES = 24;
const PIN_SALT_BYTES = 16;
const DEFAULT_OPSLIMIT = 3;
const DEFAULT_MEMLIMIT = 256 * 1024 * 1024;

/**
 * Opaque wrapped-identity payload. Safe to persist in IndexedDB.
 *
 * Packed plaintext (v2): `[has_umk_byte (1)] [deviceId_utf8 (36)] [dev_ed_priv (64)]
 * [dev_x_priv (32)] [dev_ed_pub (32)] [dev_x_pub (32)] [umk_ed_priv (64, only if has_umk=1)]`.
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
 * Wrap this device's DeviceKeyBundle (and optionally the UMK priv, if this
 * device holds it) under a passphrase. Stored in IndexedDB; server never
 * sees any part.
 */
export async function wrapDeviceStateWithPin(
  deviceBundle: DeviceKeyBundle,
  umk: UserMasterKey | null,
  passphrase: string,
  userId: string,
  opts?: { opslimit?: number; memlimit?: number },
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
    const hasUmkByte = new Uint8Array([umk ? 1 : 0]);
    const deviceIdBytes = stringToBytes(deviceBundle.deviceId);
    const parts: Bytes[] = [
      hasUmkByte,
      deviceIdBytes,
      deviceBundle.ed25519PrivateKey,
      deviceBundle.x25519PrivateKey,
      deviceBundle.ed25519PublicKey,
      deviceBundle.x25519PublicKey,
    ];
    if (umk) parts.push(umk.ed25519PrivateKey);
    const packed = concatBytes(...parts);
    const ad = stringToBytes(`vibecheck:pinlock:v2:${userId}`);
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
  /** Present iff this device was the UMK-holder at wrap time. */
  umk: UserMasterKey | null;
}

/**
 * Unlock a pin-wrapped device bundle (+ optional UMK). Throws
 * `DECRYPT_FAILED` on wrong passphrase or any tamper.
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
  try {
    const ad = stringToBytes(`vibecheck:pinlock:v2:${userId}`);
    try {
      packed = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
        null,
        blob.ciphertext,
        ad,
        blob.nonce,
        key,
      );
    } catch {
      throw new CryptoError('passphrase did not match', 'DECRYPT_FAILED');
    }
  } finally {
    sodium.memzero(key);
  }

  // Header = has_umk(1) + deviceId_utf8(36) + ed_priv(64) + x_priv(32) + ed_pub(32) + x_pub(32)
  const WITHOUT_UMK_LEN = 1 + 36 + 64 + 32 + 32 + 32;
  const WITH_UMK_LEN = WITHOUT_UMK_LEN + 64;
  if (packed.byteLength !== WITHOUT_UMK_LEN && packed.byteLength !== WITH_UMK_LEN) {
    sodium.memzero(packed);
    throw new CryptoError('wrapped device state has unexpected length', 'BAD_KEY_LENGTH');
  }
  const hasUmk = packed[0] === 1;
  const decoder = new TextDecoder();
  const deviceId = decoder.decode(packed.slice(1, 37));
  const deviceBundle: DeviceKeyBundle = {
    deviceId,
    ed25519PrivateKey: packed.slice(37, 37 + 64),
    x25519PrivateKey: packed.slice(101, 101 + 32),
    ed25519PublicKey: packed.slice(133, 133 + 32),
    x25519PublicKey: packed.slice(165, 165 + 32),
  };
  const umk: UserMasterKey | null = hasUmk
    ? {
        ed25519PublicKey: sodium.crypto_sign_ed25519_sk_to_pk(packed.slice(197, 197 + 64)),
        ed25519PrivateKey: packed.slice(197, 197 + 64),
      }
    : null;
  sodium.memzero(packed);
  return { deviceBundle, umk };
}
