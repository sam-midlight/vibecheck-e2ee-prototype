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
import { CryptoError, type Bytes, type Identity } from './types';
import {
  concatBytes,
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

/** Pack an Identity's two private halves (ed25519 + x25519) for wrapping. */
function packIdentityPrivate(identity: Identity): Bytes {
  // Format: [64 bytes ed priv][32 bytes x priv]. Public halves are not stored
  // here — they can be re-derived from the privs, or re-fetched from `identities`.
  return concatBytes(identity.ed25519PrivateKey, identity.x25519PrivateKey);
}

/**
 * Wrap the caller's identity privkeys under the given phrase. Returns an
 * opaque blob safe to upload to `recovery_blobs`.
 */
export async function wrapIdentityWithPhrase(
  identity: Identity,
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
    const packed = packIdentityPrivate(identity);
    // AD binds the ciphertext to the user_id to prevent cross-account blob swap.
    const ad = new TextEncoder().encode(userId);
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
 * Open a recovery blob with the given phrase. Returns the identity's private
 * halves; callers combine those with the published public halves (ed/x pubs
 * + selfSignature from `identities`) to reconstruct the full Identity.
 */
export async function unwrapIdentityWithPhrase(
  blob: RecoveryBlob,
  phrase: string,
  userId: string,
): Promise<{ ed25519PrivateKey: Bytes; x25519PrivateKey: Bytes }> {
  const sodium = await getSodium();
  const wrappingKey = await deriveWrappingKey(
    phrase,
    blob.kdfSalt,
    blob.kdfOpslimit,
    blob.kdfMemlimit,
  );
  let packed: Bytes;
  try {
    const ad = new TextEncoder().encode(userId);
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
  if (packed.byteLength !== 64 + 32) {
    sodium.memzero(packed);
    throw new CryptoError(
      `recovery blob has unexpected length ${packed.byteLength}`,
      'BAD_KEY_LENGTH',
    );
  }
  // .slice() returns copies; the per-key copies are the long-lived result.
  const result = {
    ed25519PrivateKey: packed.slice(0, 64),
    x25519PrivateKey: packed.slice(64, 96),
  };
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
 * Deterministic given `rngBytes` so tests can pin the positions.
 */
export function pickVerificationIndices(
  phraseLength: number,
  count: number,
  rngBytes: Bytes,
): number[] {
  // Fisher-Yates shuffle of [1..phraseLength] using rngBytes as the RNG source.
  const indices = Array.from({ length: phraseLength }, (_, i) => i);
  for (let i = phraseLength - 1; i > 0; i--) {
    const j = rngBytes[i % rngBytes.length] % (i + 1);
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }
  return indices.slice(0, count).sort((a, b) => a - b).map((i) => i + 1);
}
