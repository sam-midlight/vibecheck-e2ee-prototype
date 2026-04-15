/**
 * Encrypt/decrypt the individual events ("blobs") that populate the `blobs`
 * table. Every blob is an AEAD-sealed, Ed25519-signed payload.
 *
 * - Cipher: XChaCha20-Poly1305 (IETF variant), 24-byte random nonce.
 * - AD (additional data): room_id bytes || generation-as-4-BE-bytes. Binding
 *   the ciphertext to the room + generation prevents cross-room replay.
 * - Signature: Ed25519 over nonce || ciphertext. Lets recipients verify the
 *   sender even if Supabase row-level security were bypassed.
 *
 * The payload is arbitrary JSON — the caller decides the schema.
 */

import {
  CryptoError,
  type Bytes,
  type EncryptedBlob,
  type RoomKey,
} from './types';
import {
  bytesToString,
  concatBytes,
  fromHex,
  getSodium,
  randomBytes,
  stringToBytes,
} from './sodium';
import { signMessage, verifyMessage } from './identity';

const NONCE_BYTES = 24;

/** Build the AD (additional data) blob that binds ciphertext to (room, generation). */
async function buildAd(roomId: string, generation: number): Promise<Bytes> {
  // room IDs are UUIDs; strip hyphens and hex-decode for a compact 16-byte AD prefix.
  const uuidBytes = await fromHex(roomId.replaceAll('-', ''));
  const gen = new Uint8Array(4);
  new DataView(gen.buffer).setUint32(0, generation, false);
  return concatBytes(uuidBytes, gen);
}

/** Encrypt + sign a JSON payload for a room. */
export async function encryptBlob<T>(params: {
  payload: T;
  roomId: string;
  roomKey: RoomKey;
  senderEd25519PrivateKey: Bytes;
}): Promise<EncryptedBlob> {
  const { payload, roomId, roomKey, senderEd25519PrivateKey } = params;
  const sodium = await getSodium();
  const plaintext = stringToBytes(JSON.stringify(payload));
  const nonce = await randomBytes(NONCE_BYTES);
  const ad = await buildAd(roomId, roomKey.generation);
  const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    plaintext,
    ad,
    null,
    nonce,
    roomKey.key,
  );
  sodium.memzero(plaintext);
  const signature = await signMessage(
    concatBytes(nonce, ciphertext),
    senderEd25519PrivateKey,
  );
  return { nonce, ciphertext, signature, generation: roomKey.generation };
}

/**
 * Verify signature + decrypt. Throws CryptoError on any failure; callers can
 * use the `.code` field to distinguish auth-tag mismatch from sig mismatch.
 */
export async function decryptBlob<T>(params: {
  blob: EncryptedBlob;
  roomId: string;
  roomKey: RoomKey;
  senderEd25519PublicKey: Bytes;
}): Promise<T> {
  const { blob, roomId, roomKey, senderEd25519PublicKey } = params;
  if (blob.generation !== roomKey.generation) {
    throw new CryptoError(
      `blob generation ${blob.generation} does not match provided room key generation ${roomKey.generation}`,
      'BAD_GENERATION',
    );
  }
  const sigOk = await verifyMessage(
    concatBytes(blob.nonce, blob.ciphertext),
    blob.signature,
    senderEd25519PublicKey,
  );
  if (!sigOk) {
    throw new CryptoError('sender signature invalid', 'SIGNATURE_INVALID');
  }
  const sodium = await getSodium();
  const ad = await buildAd(roomId, blob.generation);
  let plaintext: Bytes;
  try {
    plaintext = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      blob.ciphertext,
      ad,
      blob.nonce,
      roomKey.key,
    );
  } catch {
    throw new CryptoError('AEAD decryption failed (tampered or wrong key)', 'DECRYPT_FAILED');
  }
  try {
    return JSON.parse(bytesToString(plaintext)) as T;
  } finally {
    sodium.memzero(plaintext);
  }
}
