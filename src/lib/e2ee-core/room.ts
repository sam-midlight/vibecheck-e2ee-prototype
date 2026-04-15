/**
 * Room vault keys: generate, wrap for a recipient, unwrap on receipt, rotate.
 *
 * A room key is 32 random bytes, used as the XChaCha20-Poly1305 key for every
 * blob in that room at a given generation. It is wrapped per member with
 * libsodium's `crypto_box_seal` — an anonymous sealed box keyed by the member's
 * X25519 public key. Only the holder of the matching X25519 private key can
 * open it.
 *
 * Key rotation: when membership changes, generate a new RoomKey with a bumped
 * generation, re-wrap it for each current member, and insert new room_members
 * rows. Old blobs remain decryptable by whoever has the old key.
 */

import { CryptoError, type Bytes, type RoomKey, type WrappedRoomKey } from './types';
import { getSodium, randomBytes, assertLength } from './sodium';

const ROOM_KEY_BYTES = 32;

/** Generate a fresh 32-byte room key at the given generation (defaults to 1). */
export async function generateRoomKey(generation = 1): Promise<RoomKey> {
  return {
    key: await randomBytes(ROOM_KEY_BYTES),
    generation,
  };
}

/** Wrap (seal) a room key so only the holder of the recipient's X25519 priv can open it. */
export async function wrapRoomKeyFor(
  roomKey: RoomKey,
  recipientX25519PublicKey: Bytes,
): Promise<WrappedRoomKey> {
  const sodium = await getSodium();
  assertLength(roomKey.key, ROOM_KEY_BYTES, 'roomKey.key');
  const wrapped = sodium.crypto_box_seal(roomKey.key, recipientX25519PublicKey);
  return { wrapped, generation: roomKey.generation };
}

/** Unwrap a sealed room key using the recipient's X25519 keypair. */
export async function unwrapRoomKey(
  wrapped: WrappedRoomKey,
  recipientX25519PublicKey: Bytes,
  recipientX25519PrivateKey: Bytes,
): Promise<RoomKey> {
  const sodium = await getSodium();
  let key: Bytes;
  try {
    key = sodium.crypto_box_seal_open(
      wrapped.wrapped,
      recipientX25519PublicKey,
      recipientX25519PrivateKey,
    );
  } catch {
    throw new CryptoError('failed to open sealed room key', 'DECRYPT_FAILED');
  }
  assertLength(key, ROOM_KEY_BYTES, 'unwrapped roomKey');
  return { key, generation: wrapped.generation };
}

/**
 * Rotate a room key. Returns the new RoomKey (bumped generation) plus a map of
 * pubkey-hex -> wrapped-key for each recipient. Caller is responsible for
 * inserting the resulting room_members rows and bumping rooms.current_generation.
 */
export async function rotateRoomKey(
  previousGeneration: number,
  recipientX25519PublicKeys: Bytes[],
): Promise<{ next: RoomKey; wraps: WrappedRoomKey[] }> {
  if (previousGeneration < 1) {
    throw new CryptoError('previousGeneration must be >= 1', 'BAD_GENERATION');
  }
  const next = await generateRoomKey(previousGeneration + 1);
  const wraps = await Promise.all(
    recipientX25519PublicKeys.map((pub) => wrapRoomKeyFor(next, pub)),
  );
  return { next, wraps };
}

/** Zero out a room key in memory once you're done with it. Best-effort; JS is leaky. */
export async function zeroRoomKey(roomKey: RoomKey): Promise<void> {
  const sodium = await getSodium();
  sodium.memzero(roomKey.key);
}
