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
 * Wrap the caller's UMK priv under the given phrase. Returns an opaque blob
 * safe to upload to `recovery_blobs`.
 *
 * v2 (per-device) note: recovery now targets the user master key, not a full
 * combined identity. Device key bundles are per-device and regenerated on
 * recovery. The restored UMK lets the new device sign its own device cert.
 */
export async function wrapUserMasterKeyWithPhrase(
  umk: UserMasterKey,
  phrase: string,
  userId: string,
  opts?: { opslimit?: number; memlimit?: number },
): Promise<RecoveryBlob> {
  const sodium = await getSodium();
  const opslimit = opts?.opslimit ?? DEFAULT_OPSLIMIT;
  const memlimit = opts?.memlimit ?? DEFAULT_MEMLIMIT;
  const kdfSalt = await randomBytes(RECOVERY_SALT_BYTES);
  const wrappingKey = await deriveWrappingKey(phrase, kdfSalt, opslimit, memlimit);
  try {
    const nonce = await randomBytes(RECOVERY_NONCE_BYTES);
    // 64 bytes: the full Ed25519 secret key. Pub can be re-derived from it.
    const packed = new Uint8Array(umk.ed25519PrivateKey);
    const ad = new TextEncoder().encode(`vibecheck:recovery:v2:${userId}`);
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
 * Open a recovery blob with the given phrase. Returns the UMK priv bytes;
 * caller derives the pub via `crypto_sign_ed25519_sk_to_pk` and confirms it
 * matches the server's published UMK pub before installing.
 */
export async function unwrapUserMasterKeyWithPhrase(
  blob: RecoveryBlob,
  phrase: string,
  userId: string,
): Promise<{ ed25519PrivateKey: Bytes }> {
  const sodium = await getSodium();
  const wrappingKey = await deriveWrappingKey(
    phrase,
    blob.kdfSalt,
    blob.kdfOpslimit,
    blob.kdfMemlimit,
  );
  let packed: Bytes;
  try {
    const ad = new TextEncoder().encode(`vibecheck:recovery:v2:${userId}`);
    try {
      packed = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
        null,
        blob.ciphertext,
        ad,
        blob.nonce,
        wrappingKey,
      );
    } catch {
      throw new CryptoError(
        'recovery phrase did not match (or blob was tampered)',
        'DECRYPT_FAILED',
      );
    }
  } finally {
    sodium.memzero(wrappingKey);
  }
  if (packed.byteLength !== 64) {
    sodium.memzero(packed);
    throw new CryptoError(
      `recovery blob has unexpected length ${packed.byteLength} (expected 64)`,
      'BAD_KEY_LENGTH',
    );
  }
  const result = { ed25519PrivateKey: packed.slice(0, 64) };
  sodium.memzero(packed);
  return result;
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
