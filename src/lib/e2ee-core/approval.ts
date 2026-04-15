/**
 * Device-approval helpers.
 *
 * When a new device (B) signs in via magic link and has no local identity, it
 * creates a `device_approval_requests` row carrying:
 *   - its ephemeral X25519 linking pubkey
 *   - a salted transcript-bound hash of a short 6-digit code (plaintext lives
 *     only on B's screen)
 *   - a 32-byte link_nonce that will key the eventual handoff row
 *
 * An already-signed-in device (A) sees the row via realtime, prompts the user
 * for the code, re-hashes it with the stored salt AND the row's current
 * linking_pubkey + link_nonce, and on match fulfils the request by sealing the
 * identity to the linking pubkey and writing the handoff row.
 *
 * Why bind the linking_pubkey and link_nonce into the hash:
 *   - An attacker who can mutate the `device_approval_requests` row would
 *     otherwise swap the linking pubkey for their own; A would still match the
 *     code hash and seal the identity to the attacker. Binding both into the
 *     hash means any row mutation invalidates the comparison.
 *
 * Why hash the code in the DB at all:
 *   - Defense in depth against DB snapshot leaks.
 *   - The code itself is 6 digits (~20 bits) so the hash's anti-brute-force
 *     value is modest; TTL + single-use + server-side attempt caps are the
 *     real defenses against brute-forcing.
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
 * Hash SHA-256(domain || salt || code || linkingPubkey || linkNonce).
 * Returned as hex. The same inputs always yield the same hash, so A can
 * verify by re-hashing what the user typed — plus the row's current
 * linking_pubkey and link_nonce — and comparing to the stored row hash.
 *
 * Binding linking_pubkey and link_nonce into the hash prevents an active
 * attacker who can mutate the row from substituting their own linking key:
 * any such mutation changes the expected hash and the verify step fails.
 *
 * SHA-256 rather than a password-hashing KDF: 20-bit code entropy is the
 * bottleneck; no KDF parameter makes 10^6 materially harder. TTL +
 * single-use + server-side attempt caps are the real defenses.
 */
const APPROVAL_DOMAIN = 'vibecheck:approval:v2';

export async function hashApprovalCode(
  code: string,
  saltHex: string,
  linkingPubkey: Uint8Array,
  linkNonce: Uint8Array,
): Promise<string> {
  const sodium = await getSodium();
  if (!/^[0-9]{6}$/.test(code)) {
    throw new CryptoError('approval code must be 6 digits', 'BAD_KEY_LENGTH');
  }
  const domainBytes = stringToBytes(APPROVAL_DOMAIN);
  const codeBytes = stringToBytes(code);
  const saltBytes = sodium.from_hex(saltHex);
  const input = concatBytes(domainBytes, saltBytes, codeBytes, linkingPubkey, linkNonce);
  const out = sodium.crypto_hash_sha256(input);
  return sodium.to_hex(out);
}
