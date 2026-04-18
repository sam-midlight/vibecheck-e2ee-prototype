/**
 * SAS (Short Authentication String) verification protocol.
 *
 * Interactive emoji-based identity verification between two users. Adapted
 * from Matrix's SAS spec (MSC1267) to VibeCheck's primitives.
 *
 * Protocol:
 *   1. Alice generates ephemeral X25519 keypair, commits SHA256(ea_pub || alice_device_ed_pub)
 *   2. Bob generates ephemeral X25519 keypair, sends eb_pub
 *   3. Alice reveals ea_pub. Bob verifies commitment.
 *   4. Both compute shared_secret = X25519(own_priv, other_pub)
 *   5. Both derive 7 emoji from HKDF(shared, info || msk_pubs || ephemerals, 6)
 *   6. Users compare emoji (voice/in-person)
 *   7. Both exchange HMAC MACs over their own identity
 *   8. On success: USK signs other user's MSK pub → cross_user_signatures table
 */

import { CryptoError, type Bytes } from './types';
import {
  concatBytes,
  getSodium,
  stringToBytes,
} from './sodium';
import { signMessage, verifyMessageOrThrow } from './identity';

// ---------------------------------------------------------------------------
// Emoji set — 64 symbols, 6 bits each → 7 emoji from 42 bits
// ---------------------------------------------------------------------------

export const SAS_EMOJI: readonly string[] = [
  '🐶', '🐱', '🐭', '🐹', '🐰', '🦊', '🐻', '🐼',
  '🐨', '🐯', '🦁', '🐮', '🐷', '🐸', '🐵', '🐔',
  '🐧', '🐦', '🦆', '🦅', '🦉', '🦇', '🐺', '🐗',
  '🐴', '🦄', '🐝', '🐛', '🦋', '🐌', '🐞', '🐜',
  '🌻', '🌹', '🌺', '🌸', '🌼', '🌷', '🍄', '🌰',
  '🎄', '🌲', '🌳', '🌴', '🌵', '🍁', '🍀', '☘️',
  '🔥', '⭐', '🌙', '☀️', '🌈', '☁️', '⚡', '❄️',
  '🎈', '🎉', '🎀', '🎁', '🔔', '🎵', '🎶', '💎',
] as const;

// ---------------------------------------------------------------------------
// Domain tags
// ---------------------------------------------------------------------------

const SAS_INFO_DOMAIN = stringToBytes('vibecheck:sas:v1');
const SAS_MAC_DOMAIN = stringToBytes('vibecheck:sas:mac:v1');
const USER_SIG_DOMAIN = stringToBytes('vibecheck:usersig:v1');

// ---------------------------------------------------------------------------
// Step 1: Commitment
// ---------------------------------------------------------------------------

export interface SasCommitment {
  ephemeralPub: Bytes;
  ephemeralPriv: Bytes;
  commitment: Bytes;  // SHA256(ea_pub || device_ed_pub)
}

/** Generate ephemeral X25519 keypair + commitment. */
export async function generateSasCommitment(
  deviceEdPub: Bytes,
): Promise<SasCommitment> {
  const sodium = await getSodium();
  const kp = sodium.crypto_box_keypair();
  const preimage = concatBytes(kp.publicKey, deviceEdPub);
  const commitment = sodium.crypto_hash_sha256(preimage);
  return {
    ephemeralPub: kp.publicKey,
    ephemeralPriv: kp.privateKey,
    commitment,
  };
}

/** Verify a commitment against a revealed ephemeral pub. */
export async function verifySasCommitment(
  commitment: Bytes,
  ephemeralPub: Bytes,
  deviceEdPub: Bytes,
): Promise<boolean> {
  const sodium = await getSodium();
  const expected = sodium.crypto_hash_sha256(
    concatBytes(ephemeralPub, deviceEdPub),
  );
  return sodium.memcmp(commitment, expected);
}

// ---------------------------------------------------------------------------
// Step 3–4: Shared secret + emoji derivation
// ---------------------------------------------------------------------------

/** Compute the X25519 shared secret. */
export async function computeSasSharedSecret(
  ownEphemeralPriv: Bytes,
  otherEphemeralPub: Bytes,
): Promise<Bytes> {
  const sodium = await getSodium();
  return sodium.crypto_scalarmult(ownEphemeralPriv, otherEphemeralPub);
}

/**
 * Derive 7 emoji from the shared secret + identity binding.
 * Uses HKDF-SHA256 to extract 6 bytes (48 bits → 7 × 6-bit indices + 6 spare).
 */
export async function deriveSasEmoji(params: {
  sharedSecret: Bytes;
  aliceMskPub: Bytes;
  bobMskPub: Bytes;
  aliceEphemeralPub: Bytes;
  bobEphemeralPub: Bytes;
}): Promise<string[]> {
  const sodium = await getSodium();
  const info = concatBytes(
    SAS_INFO_DOMAIN,
    params.aliceMskPub,
    params.bobMskPub,
    params.aliceEphemeralPub,
    params.bobEphemeralPub,
  );
  // HKDF-extract then expand to get 6 bytes.
  // libsodium-wrappers signature is (message, key) — sharedSecret is the
  // 32-byte key; info is the variable-length message. Swapping them trips
  // libsodium's 32-byte key-length check (info is 148 bytes) → "invalid
  // key length". Keep message first, key second.
  const prk = sodium.crypto_auth_hmacsha256(info, params.sharedSecret);
  // Take first 6 bytes → 48 bits → 7 × 6-bit emoji indices.
  const raw = prk.slice(0, 6);
  sodium.memzero(prk);
  // Extract 6-bit chunks by shifting within byte boundaries.
  // 48 bits = bits[47..0]. Emoji i uses bits[(47 - 6*i)..(42 - 6*i)].
  // We build a bit string via a simple array approach.
  const bitStr: number[] = [];
  for (let i = 0; i < 6; i++) {
    for (let b = 7; b >= 0; b--) {
      bitStr.push((raw[i] >> b) & 1);
    }
  }
  const emoji: string[] = [];
  for (let i = 0; i < 7; i++) {
    let idx = 0;
    for (let b = 0; b < 6; b++) {
      idx = (idx << 1) | bitStr[i * 6 + b];
    }
    emoji.push(SAS_EMOJI[idx]);
  }
  return emoji;
}

// ---------------------------------------------------------------------------
// Step 5: MAC exchange
// ---------------------------------------------------------------------------

/** Compute the MAC binding this user's identity to the shared secret. */
export async function computeSasMac(params: {
  sharedSecret: Bytes;
  ownMskPub: Bytes;
  ownDeviceEdPub: Bytes;
}): Promise<Bytes> {
  const sodium = await getSodium();
  const input = concatBytes(
    SAS_MAC_DOMAIN,
    params.ownMskPub,
    params.ownDeviceEdPub,
  );
  return sodium.crypto_auth_hmacsha256(input, params.sharedSecret);
}

/** Verify the other side's MAC. */
export async function verifySasMac(params: {
  sharedSecret: Bytes;
  otherMskPub: Bytes;
  otherDeviceEdPub: Bytes;
  mac: Bytes;
}): Promise<boolean> {
  const expected = await computeSasMac({
    sharedSecret: params.sharedSecret,
    ownMskPub: params.otherMskPub,
    ownDeviceEdPub: params.otherDeviceEdPub,
  });
  const sodium = await getSodium();
  return sodium.memcmp(expected, params.mac);
}

// ---------------------------------------------------------------------------
// Step 6: Cross-user signing (USK signs other user's MSK pub)
// ---------------------------------------------------------------------------

function u64BE(n: number): Bytes {
  const buf = new Uint8Array(8);
  new DataView(buf.buffer).setBigUint64(0, BigInt.asUintN(64, BigInt(Math.trunc(n))), false);
  return buf;
}

/**
 * Canonical user-sig message (72 bytes):
 *   "vibecheck:usersig:v1"(20) || signer_msk_pub(32) || signed_msk_pub(32) || timestamp(8 BE)
 */
async function canonicalUserSigMessage(
  signerMskPub: Bytes,
  signedMskPub: Bytes,
  timestamp: number,
): Promise<Bytes> {
  return concatBytes(USER_SIG_DOMAIN, signerMskPub, signedMskPub, u64BE(timestamp));
}

/** Sign another user's MSK pub with this user's USK priv. */
export async function signUserMsk(params: {
  signerMskPub: Bytes;
  signedMskPub: Bytes;
  uskPriv: Bytes;
  timestamp: number;
}): Promise<Bytes> {
  return signMessage(
    await canonicalUserSigMessage(
      params.signerMskPub,
      params.signedMskPub,
      params.timestamp,
    ),
    params.uskPriv,
  );
}

/** Verify a cross-user signature. */
export async function verifyUserMskSignature(params: {
  signerMskPub: Bytes;
  signedMskPub: Bytes;
  uskPub: Bytes;
  signature: Bytes;
  timestamp: number;
}): Promise<void> {
  try {
    await verifyMessageOrThrow(
      await canonicalUserSigMessage(
        params.signerMskPub,
        params.signedMskPub,
        params.timestamp,
      ),
      params.signature,
      params.uskPub,
    );
  } catch (err) {
    if (err instanceof CryptoError && err.code === 'SIGNATURE_INVALID') {
      throw new CryptoError(
        'cross-user signature did not verify',
        'CERT_INVALID',
      );
    }
    throw err;
  }
}
