/**
 * User identity: generation, self-signature, message signing/verification.
 *
 * Each user owns two long-term keypairs:
 *   - Ed25519: for signing (identity, write authenticity, self-signature)
 *   - X25519:  for DH / receiving sealed room keys
 *
 * The `self_signature` binds the X25519 pubkey to the Ed25519 identity, so
 * anyone fetching the identity from the server can verify the pair wasn't
 * tampered with.
 */

import { CryptoError, type Bytes, type Identity, type PublicIdentity } from './types';
import { concatBytes, getSodium } from './sodium';

/**
 * Derive the public halves from an Identity's private halves. Used after a
 * recovery-phrase unwrap, to sanity-check that the reconstructed privkeys
 * produce the pubkeys the server has on file. If they don't, something's
 * wrong — either the recovery blob is corrupt or bound to a different account.
 */
export async function derivePublicIdentity(identity: Identity): Promise<{
  ed25519PublicKey: Bytes;
  x25519PublicKey: Bytes;
}> {
  const sodium = await getSodium();
  return {
    ed25519PublicKey: sodium.crypto_sign_ed25519_sk_to_pk(identity.ed25519PrivateKey),
    x25519PublicKey: sodium.crypto_scalarmult_base(identity.x25519PrivateKey),
  };
}

/** Generate a fresh identity (both keypairs + the self-signature). */
export async function generateIdentity(): Promise<Identity> {
  const sodium = await getSodium();
  const sign = sodium.crypto_sign_keypair();
  const box = sodium.crypto_box_keypair();
  return {
    ed25519PublicKey: sign.publicKey,
    ed25519PrivateKey: sign.privateKey,
    x25519PublicKey: box.publicKey,
    x25519PrivateKey: box.privateKey,
  };
}

/** Produce the self-signature the server stores: sign(ed||x) with ed25519 priv. */
export async function selfSign(identity: Identity): Promise<Bytes> {
  const sodium = await getSodium();
  const msg = concatBytes(identity.ed25519PublicKey, identity.x25519PublicKey);
  return sodium.crypto_sign_detached(msg, identity.ed25519PrivateKey);
}

/** Assemble a PublicIdentity ready to publish to the server. */
export async function toPublicIdentity(identity: Identity): Promise<PublicIdentity> {
  return {
    ed25519PublicKey: identity.ed25519PublicKey,
    x25519PublicKey: identity.x25519PublicKey,
    selfSignature: await selfSign(identity),
  };
}

/** Verify a published PublicIdentity's self-signature is internally consistent. */
export async function verifySelfSignature(pub: PublicIdentity): Promise<boolean> {
  const sodium = await getSodium();
  const msg = concatBytes(pub.ed25519PublicKey, pub.x25519PublicKey);
  return sodium.crypto_sign_verify_detached(
    pub.selfSignature,
    msg,
    pub.ed25519PublicKey,
  );
}

/** Detached Ed25519 signature over an arbitrary message. */
export async function signMessage(
  message: Bytes,
  ed25519PrivateKey: Bytes,
): Promise<Bytes> {
  const sodium = await getSodium();
  return sodium.crypto_sign_detached(message, ed25519PrivateKey);
}

/** Verify a detached Ed25519 signature. Returns boolean, does NOT throw. */
export async function verifyMessage(
  message: Bytes,
  signature: Bytes,
  ed25519PublicKey: Bytes,
): Promise<boolean> {
  const sodium = await getSodium();
  try {
    return sodium.crypto_sign_verify_detached(signature, message, ed25519PublicKey);
  } catch {
    return false;
  }
}

/**
 * Verify a signature, throwing a CryptoError on failure. Useful at trust
 * boundaries where "invalid" means "reject this row."
 */
export async function verifyMessageOrThrow(
  message: Bytes,
  signature: Bytes,
  ed25519PublicKey: Bytes,
): Promise<void> {
  const ok = await verifyMessage(message, signature, ed25519PublicKey);
  if (!ok) {
    throw new CryptoError('signature verification failed', 'SIGNATURE_INVALID');
  }
}

/**
 * A short, human-comparable fingerprint of a public identity. Not required
 * for the TOFU flow, but handy for /status dumps and future "safety number"
 * UI if you ever add one. Format: 5 groups of 5 digits from blake2b(ed||x).
 */
export async function publicIdentityFingerprint(pub: PublicIdentity): Promise<string> {
  const sodium = await getSodium();
  const digest = sodium.crypto_generichash(
    16,
    concatBytes(pub.ed25519PublicKey, pub.x25519PublicKey),
    null,
    'uint8array',
  );
  // Take 25 bits at a time to form 5-digit decimal groups.
  const bits: number[] = [];
  for (const byte of digest) {
    for (let i = 7; i >= 0; i--) bits.push((byte >> i) & 1);
  }
  const groups: string[] = [];
  for (let g = 0; g < 5; g++) {
    let n = 0;
    for (let i = 0; i < 25; i++) n = (n << 1) | bits[g * 25 + i];
    groups.push(n.toString().padStart(8, '0').slice(-5));
  }
  return groups.join(' ');
}
