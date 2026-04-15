/**
 * Device linking: QR-driven handoff that copies an identity from an existing
 * device (A) to a new one (B).
 *
 * Flow:
 *   1. B calls `buildLinkPayload()` → shows QR with { linkNonce, linkingPub }
 *   2. A scans QR → calls `sealIdentityForLink()` with A's identity + B's pub
 *      → inserts `device_link_handoffs` row keyed by linkNonce
 *   3. B reads its own row (via realtime) → `openSealedIdentity()` with B's
 *      priv key → now has the identity keys. Deletes the row.
 *
 * The QR carries a 32-byte `linkNonce` which doubles as the DB primary key.
 * Because it's a 256-bit secret, anyone not holding the QR cannot guess it,
 * even though the DB row is publicly readable (see RLS policy).
 */

import { CryptoError, type Bytes, type DeviceLinkingKeys, type Identity } from './types';
import { concatBytes, getSodium, randomBytes } from './sodium';

const LINK_NONCE_BYTES = 32;

/** Called on the new device B: build an ephemeral keypair + link nonce for the QR. */
export async function buildLinkPayload(): Promise<DeviceLinkingKeys> {
  const sodium = await getSodium();
  const box = sodium.crypto_box_keypair();
  const linkNonce = await randomBytes(LINK_NONCE_BYTES);
  return {
    x25519PublicKey: box.publicKey,
    x25519PrivateKey: box.privateKey,
    linkNonce,
  };
}

/**
 * Called on existing device A: seal the identity privkeys (both ed25519 and
 * x25519) into a single payload openable only with the linking pubkey.
 *
 * Wire format: [32 bytes ed pub][32 bytes x pub][64 bytes ed priv][32 bytes x priv]
 * All fixed-width so the receiver can slice without TLV parsing.
 */
export async function sealIdentityForLink(
  identity: Identity,
  recipientLinkingPublicKey: Bytes,
): Promise<Bytes> {
  const sodium = await getSodium();
  const packed = concatBytes(
    identity.ed25519PublicKey,
    identity.x25519PublicKey,
    identity.ed25519PrivateKey,
    identity.x25519PrivateKey,
  );
  return sodium.crypto_box_seal(packed, recipientLinkingPublicKey);
}

/**
 * Called on the new device B: open the sealed payload with B's linking priv,
 * return the reconstructed Identity.
 */
export async function openSealedIdentity(
  sealedPayload: Bytes,
  linkingKeys: DeviceLinkingKeys,
): Promise<Identity> {
  const sodium = await getSodium();
  let opened: Bytes;
  try {
    opened = sodium.crypto_box_seal_open(
      sealedPayload,
      linkingKeys.x25519PublicKey,
      linkingKeys.x25519PrivateKey,
    );
  } catch {
    throw new CryptoError('failed to open sealed identity payload', 'DECRYPT_FAILED');
  }
  if (opened.byteLength !== 32 + 32 + 64 + 32) {
    sodium.memzero(opened);
    throw new CryptoError(
      `sealed identity payload has unexpected length ${opened.byteLength}`,
      'BAD_KEY_LENGTH',
    );
  }
  // .slice() returns copies, so we can wipe the combined buffer once the
  // per-key copies are extracted. Those copies are the long-lived Identity.
  const identity: Identity = {
    ed25519PublicKey: opened.slice(0, 32),
    x25519PublicKey: opened.slice(32, 64),
    ed25519PrivateKey: opened.slice(64, 128),
    x25519PrivateKey: opened.slice(128, 160),
  };
  sodium.memzero(opened);
  return identity;
}
