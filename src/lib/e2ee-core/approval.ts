/**
 * Device-approval helpers.
 *
 * When a new device (B) signs in via magic link and has no local identity, it
 * creates a `device_approval_requests` row carrying:
 *   - its ephemeral X25519 linking pubkey
 *   - a salted hash of a short 6-digit code (plaintext lives only on B's screen)
 *   - a 32-byte link_nonce that will key the eventual handoff row
 *
 * An already-signed-in device (A) sees the row via realtime, prompts the user
 * for the code, re-hashes it with the stored salt, and on match fulfils the
 * request by sealing the identity to the linking pubkey and writing the
 * handoff row (via the existing `sealIdentityForLink` path).
 *
 * Why hash the code in the DB:
 *   - Defense in depth against DB snapshot leaks.
 *   - The code itself is 6 digits (~20 bits) so the hash's anti-brute-force
 *     value is modest, but we salt each request independently so there's no
 *     rainbow-table speedup.
 */

import { CryptoError } from './types';
import { concatBytes, getSodium, randomBytes, stringToBytes, toHex } from './sodium';

const CODE_DIGITS = 6;
const CODE_SALT_BYTES = 16;

/**
 * Generate a user-facing 6-digit approval code (zero-padded). Uniformly
 * distributed — rejection-sampled to avoid modulo bias.
 */
export async function generateApprovalCode(): Promise<string> {
  const sodium = await getSodium();
  // 10^6 = 1,000,000 possible codes. Largest multiple of 10^6 under 2^24
  // (16_777_216) is 16_000_000. Reject anything above for uniformity.
  const MAX = 16_000_000;
  while (true) {
    const buf = sodium.randombytes_buf(3);
    const n = (buf[0] << 16) | (buf[1] << 8) | buf[2];
    if (n < MAX) {
      return String(n % 1_000_000).padStart(CODE_DIGITS, '0');
    }
  }
}

/** Fresh per-request salt. Returned as hex for storage. */
export async function generateApprovalSalt(): Promise<string> {
  return toHex(await randomBytes(CODE_SALT_BYTES));
}

/**
 * Hash (salt || code) with SHA-256. Returned as hex.
 * The same (code, salt) always yields the same hash, so A can verify by
 * re-hashing what the user typed and comparing to the row.
 *
 * SHA-256 is used here rather than a password-hashing KDF because the code's
 * 20-bit entropy is the true bottleneck; no KDF parameter choice makes a
 * 6-digit brute-force materially harder. TTL + single-use are the real
 * defenses. The hash is about DB-dump hygiene, not slowing down attackers.
 */
export async function hashApprovalCode(code: string, saltHex: string): Promise<string> {
  const sodium = await getSodium();
  if (!/^[0-9]{6}$/.test(code)) {
    throw new CryptoError('approval code must be 6 digits', 'BAD_KEY_LENGTH');
  }
  const codeBytes = stringToBytes(code);
  const saltBytes = sodium.from_hex(saltHex);
  const input = concatBytes(saltBytes, codeBytes);
  const out = sodium.crypto_hash_sha256(input);
  return sodium.to_hex(out);
}
