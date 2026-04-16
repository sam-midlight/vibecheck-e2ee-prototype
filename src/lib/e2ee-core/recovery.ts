/**
 * Recovery-phrase escrow.
 *
 * Optional feature: the user can opt into a 24-word BIP-39 phrase that wraps
 * their identity private keys. The phrase never leaves the client; only the
 * ciphertext plus KDF params are uploaded to `recovery_blobs`. On a new device
 * with no local identity, entering the phrase unwraps the ciphertext and
 * restores the identity.
 *
 * Threat model:
 *   - 24 BIP-39 words = 264 bits of entropy. Offline brute-force is infeasible.
 *   - Argon2id over the phrase with a per-user salt produces the wrapping key;
 *     recovered ciphertext without the phrase is opaque.
 *   - The phrase is equivalent in power to "all your devices". Anyone who has
 *     both the user's mailbox access AND the phrase owns the account. That's
 *     the intentional escape-hatch property — the device-approval flow is the
 *     adversary-resistant path; the phrase is the "lost everything" path.
 */

import { generateMnemonic, mnemonicToEntropy, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { CryptoError, type Bytes, type UserMasterKey } from './types';
import {
  fromBase64,
  getSodium,
  randomBytes,
  toBase64,
} from './sodium';

const MNEMONIC_STRENGTH_BITS = 256; // 24 words
const RECOVERY_NONCE_BYTES = 24;
const RECOVERY_SALT_BYTES = 16;
// Argon2id parameters — tuned for ~1s on a mid-range laptop. These are stored
// server-side so we can lift them later without breaking old blobs.
const DEFAULT_OPSLIMIT = 3; // INTERACTIVE is 2, MODERATE is 3
const DEFAULT_MEMLIMIT = 256 * 1024 * 1024; // 256 MiB

/** Wire format for a recovery blob, suitable for storing in `recovery_blobs`. */
export interface RecoveryBlob {
  ciphertext: Bytes;
  nonce: Bytes;
  kdfSalt: Bytes;
  kdfOpslimit: number;
  kdfMemlimit: number;
}

/** Generate a fresh 24-word BIP-39 English phrase. */
export function generateRecoveryPhrase(): string {
  return generateMnemonic(wordlist, MNEMONIC_STRENGTH_BITS);
}

/**
 * Return a phrase, normalized (trimmed, lowercased, single-spaced).
 *
 * Also strips common list decorations so users can paste straight from a
 * numbered grid: `1. foo`, `1) foo`, `(1) foo`, `1: foo` all reduce to `foo`.
 */
export function normalizePhrase(phrase: string): string {
  return phrase
    .replace(/[\u2018\u2019\u201C\u201D]/g, '')
    .split(/\s+/)
    .map((tok) => tok.replace(/^\(?\d+[.):]?$/, '').replace(/^\(?\d+[.):]/, ''))
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .trim();
}

export function splitPhrase(phrase: string): string[] {
  const n = normalizePhrase(phrase);
  return n ? n.split(' ') : [];
}

/** Validate a phrase's checksum (catches typos) before attempting Argon2. */
export function isPhraseValid(phrase: string): boolean {
  return validateMnemonic(normalizePhrase(phrase), wordlist);
}

async function deriveWrappingKey(
  phrase: string,
  salt: Bytes,
  opslimit: number,
  memlimit: number,
): Promise<Bytes> {
  const sodium = await getSodium();
  const phraseBytes = await mnemonicToEntropyBytes(phrase); // fixed-width input to Argon2
  try {
    return sodium.crypto_pwhash(
      32, // output length = XChaCha20-Poly1305 key size
      phraseBytes,
      salt,
      opslimit,
      memlimit,
      sodium.crypto_pwhash_ALG_ARGON2ID13,
    );
  } finally {
    sodium.memzero(phraseBytes);
  }
}

/**
 * Use the raw BIP-39 entropy (32 bytes for 24 words) as the KDF input rather
 * than the mnemonic string. The entropy is canonical and the checksum has
 * already been validated; this avoids Argon2 churn on small typos.
 */
async function mnemonicToEntropyBytes(phrase: string): Promise<Bytes> {
  const normalized = normalizePhrase(phrase);
  if (!validateMnemonic(normalized, wordlist)) {
    throw new CryptoError('recovery phrase checksum invalid', 'SIGNATURE_INVALID');
  }
  return mnemonicToEntropy(normalized, wordlist);
}

/**
 * Wrap keys under the given phrase. Produces the highest format the inputs
 * support:
 *
 *   v4 (cross-signing): mskPriv(64) || sskPriv(64) || uskPriv(64) || backupKey(32) = 224 bytes
 *   v3 (per-device):    mskPriv(64) || backupKey(32) = 96 bytes
 *   v2 (legacy):        mskPriv(64) = 64 bytes
 */
export async function wrapUserMasterKeyWithPhrase(
  umk: UserMasterKey,
  phrase: string,
  userId: string,
  opts?: {
    opslimit?: number;
    memlimit?: number;
    backupKey?: Bytes;
    sskPriv?: Bytes;
    uskPriv?: Bytes;
  },
): Promise<RecoveryBlob> {
  const sodium = await getSodium();
  const opslimit = opts?.opslimit ?? DEFAULT_OPSLIMIT;
  const memlimit = opts?.memlimit ?? DEFAULT_MEMLIMIT;
  const kdfSalt = await randomBytes(RECOVERY_SALT_BYTES);
  const wrappingKey = await deriveWrappingKey(phrase, kdfSalt, opslimit, memlimit);
  try {
    const nonce = await randomBytes(RECOVERY_NONCE_BYTES);
    let packed: Bytes;
    let adTag: string;
    if (opts?.sskPriv && opts?.uskPriv && opts?.backupKey) {
      // v4: MSK priv + SSK priv + USK priv + backup key
      packed = new Uint8Array(64 + 64 + 64 + 32);
      packed.set(umk.ed25519PrivateKey, 0);
      packed.set(opts.sskPriv, 64);
      packed.set(opts.uskPriv, 128);
      packed.set(opts.backupKey, 192);
      adTag = `vibecheck:recovery:v4:${userId}`;
    } else if (opts?.backupKey) {
      // v3: MSK priv + backup key
      packed = new Uint8Array(64 + 32);
      packed.set(umk.ed25519PrivateKey, 0);
      packed.set(opts.backupKey, 64);
      adTag = `vibecheck:recovery:v3:${userId}`;
    } else {
      // v2: MSK priv only
      packed = new Uint8Array(umk.ed25519PrivateKey);
      adTag = `vibecheck:recovery:v2:${userId}`;
    }
    const ad = new TextEncoder().encode(adTag);
    const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
      packed,
      ad,
      null,
      nonce,
      wrappingKey,
    );
    sodium.memzero(packed);
    return { ciphertext, nonce, kdfSalt, kdfOpslimit: opslimit, kdfMemlimit: memlimit };
  } finally {
    sodium.memzero(wrappingKey);
  }
}

/**
 * Open a recovery blob with the given phrase. Tries AD tags in order:
 *   v4 (224 bytes): mskPriv + sskPriv + uskPriv + backupKey
 *   v3 (96 bytes):  mskPriv + backupKey
 *   v2 (64 bytes):  mskPriv only
 */
export interface RecoveryUnwrapResult {
  ed25519PrivateKey: Bytes;
  sskPriv?: Bytes;
  uskPriv?: Bytes;
  backupKey?: Bytes;
}

export async function unwrapUserMasterKeyWithPhrase(
  blob: RecoveryBlob,
  phrase: string,
  userId: string,
): Promise<RecoveryUnwrapResult> {
  const sodium = await getSodium();
  const wrappingKey = await deriveWrappingKey(
    phrase,
    blob.kdfSalt,
    blob.kdfOpslimit,
    blob.kdfMemlimit,
  );
  let packed: Bytes;
  try {
    // Try v4 → v3 → v2. The ciphertext itself doesn't carry a version
    // field; we rely on the AD mismatch to distinguish.
    const adV4 = new TextEncoder().encode(`vibecheck:recovery:v4:${userId}`);
    const adV3 = new TextEncoder().encode(`vibecheck:recovery:v3:${userId}`);
    const adV2 = new TextEncoder().encode(`vibecheck:recovery:v2:${userId}`);

    const tryDecrypt = (ad: Uint8Array): Bytes | null => {
      try {
        return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
          null, blob.ciphertext, ad, blob.nonce, wrappingKey,
        );
      } catch {
        return null;
      }
    };

    packed = tryDecrypt(adV4) ?? tryDecrypt(adV3) ?? tryDecrypt(adV2) ?? null!;
    if (!packed) {
      throw new CryptoError(
        'recovery phrase did not match (or blob was tampered)',
        'DECRYPT_FAILED',
      );
    }
  } finally {
    sodium.memzero(wrappingKey);
  }
  try {
    if (packed.byteLength === 224) {
      // v4: MSK priv (64) + SSK priv (64) + USK priv (64) + backup key (32)
      return {
        ed25519PrivateKey: packed.slice(0, 64),
        sskPriv: packed.slice(64, 128),
        uskPriv: packed.slice(128, 192),
        backupKey: packed.slice(192, 224),
      };
    }
    if (packed.byteLength === 96) {
      // v3: MSK priv (64) + backup key (32)
      return {
        ed25519PrivateKey: packed.slice(0, 64),
        backupKey: packed.slice(64, 96),
      };
    }
    if (packed.byteLength === 64) {
      // v2: MSK priv only
      return { ed25519PrivateKey: packed.slice(0, 64) };
    }
    throw new CryptoError(
      `recovery blob has unexpected length ${packed.byteLength} (expected 64, 96, or 224)`,
      'BAD_KEY_LENGTH',
    );
  } finally {
    sodium.memzero(packed);
  }
}

const BACKUP_NONCE_BYTES = 24;

/** Generate a fresh 32-byte backup key. */
export async function generateBackupKey(): Promise<Bytes> {
  return randomBytes(32);
}

/** Encrypt a room key for server-side backup under the backup key. */
export async function encryptRoomKeyForBackup(params: {
  roomKey: { key: Bytes; generation: number };
  backupKey: Bytes;
  roomId: string;
}): Promise<{ ciphertext: Bytes; nonce: Bytes }> {
  const sodium = await getSodium();
  const nonce = await randomBytes(BACKUP_NONCE_BYTES);
  const ad = new TextEncoder().encode(
    `vibecheck:key-backup:v1:${params.roomId}:${params.roomKey.generation}`,
  );
  const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    params.roomKey.key,
    ad,
    null,
    nonce,
    params.backupKey,
  );
  return { ciphertext, nonce };
}

/** Decrypt a room key from a server-side backup row. */
export async function decryptRoomKeyFromBackup(params: {
  ciphertext: Bytes;
  nonce: Bytes;
  generation: number;
  backupKey: Bytes;
  roomId: string;
}): Promise<{ key: Bytes; generation: number }> {
  const sodium = await getSodium();
  const ad = new TextEncoder().encode(
    `vibecheck:key-backup:v1:${params.roomId}:${params.generation}`,
  );
  let key: Bytes;
  try {
    key = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      params.ciphertext,
      ad,
      params.nonce,
      params.backupKey,
    );
  } catch {
    throw new CryptoError(
      'key backup decryption failed (wrong backup key or tampered)',
      'DECRYPT_FAILED',
    );
  }
  return { key, generation: params.generation };
}

/**
 * Encrypt a Megolm session snapshot for server-side backup. The snapshot's
 * chain key + metadata are sealed under the backup key so the server never
 * sees them. AD binds the ciphertext to (roomId, sessionId, startIndex).
 */
export async function encryptSessionSnapshotForBackup(params: {
  snapshot: { chainKeyAtIndex: Bytes; startIndex: number; senderUserId: string; senderDeviceId: string };
  sessionId: string;
  backupKey: Bytes;
  roomId: string;
}): Promise<{ ciphertext: Bytes; nonce: Bytes }> {
  const sodium = await getSodium();
  const nonce = await randomBytes(BACKUP_NONCE_BYTES);
  const ad = new TextEncoder().encode(
    `vibecheck:session-backup:v1:${params.roomId}:${params.sessionId}:${params.snapshot.startIndex}`,
  );
  // Pack: chainKey(32) || senderUserId(UTF8) || \0 || senderDeviceId(UTF8)
  const enc = new TextEncoder();
  const suBytes = enc.encode(params.snapshot.senderUserId);
  const sdBytes = enc.encode(params.snapshot.senderDeviceId);
  const packed = new Uint8Array(32 + suBytes.length + 1 + sdBytes.length);
  packed.set(params.snapshot.chainKeyAtIndex, 0);
  packed.set(suBytes, 32);
  packed[32 + suBytes.length] = 0;
  packed.set(sdBytes, 32 + suBytes.length + 1);
  const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    packed,
    ad,
    null,
    nonce,
    params.backupKey,
  );
  sodium.memzero(packed);
  return { ciphertext, nonce };
}

/** Serialize a blob for transport (base64 strings). */
export async function encodeRecoveryBlob(blob: RecoveryBlob): Promise<{
  ciphertext: string;
  nonce: string;
  kdf_salt: string;
  kdf_opslimit: number;
  kdf_memlimit: number;
}> {
  return {
    ciphertext: await toBase64(blob.ciphertext),
    nonce: await toBase64(blob.nonce),
    kdf_salt: await toBase64(blob.kdfSalt),
    kdf_opslimit: blob.kdfOpslimit,
    kdf_memlimit: blob.kdfMemlimit,
  };
}

/** Inverse of encodeRecoveryBlob. */
export async function decodeRecoveryBlob(row: {
  ciphertext: string;
  nonce: string;
  kdf_salt: string;
  kdf_opslimit: number;
  kdf_memlimit: number;
}): Promise<RecoveryBlob> {
  return {
    ciphertext: await fromBase64(row.ciphertext),
    nonce: await fromBase64(row.nonce),
    kdfSalt: await fromBase64(row.kdf_salt),
    kdfOpslimit: row.kdf_opslimit,
    kdfMemlimit: row.kdf_memlimit,
  };
}

/**
 * Pick N random 1-based positions from a phrase for a verification step.
 * Deterministic given `rngBytes` so tests can pin the positions. Uses
 * rejection sampling from 16-bit windows of `rngBytes` to get a uniform
 * index in `[0, i+1)` — avoids the modulo bias of `byte % (i+1)` when
 * `i+1` doesn't divide 256.
 */
export function pickVerificationIndices(
  phraseLength: number,
  count: number,
  rngBytes: Bytes,
): number[] {
  const indices = Array.from({ length: phraseLength }, (_, i) => i);
  let cursor = 0;
  const nextUniform = (ceiling: number): number => {
    // Read 16 bits at a time from rngBytes (wrapping). Rejection-sample to
    // eliminate bias: only accept values < floor(65536 / ceiling) * ceiling.
    const limit = Math.floor(65536 / ceiling) * ceiling;
    // Budget loops to avoid runaway if rngBytes is adversarial/too short.
    for (let attempts = 0; attempts < 256; attempts++) {
      const hi = rngBytes[cursor % rngBytes.length];
      const lo = rngBytes[(cursor + 1) % rngBytes.length];
      cursor += 2;
      const r = (hi << 8) | lo;
      if (r < limit) return r % ceiling;
    }
    // Last resort (should be unreachable for ceiling <= phraseLength <= 256):
    // fall back to plain modulo to guarantee termination.
    return rngBytes[cursor++ % rngBytes.length] % ceiling;
  };
  for (let i = phraseLength - 1; i > 0; i--) {
    const j = nextUniform(i + 1);
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }
  return indices.slice(0, count).sort((a, b) => a - b).map((i) => i + 1);
}
