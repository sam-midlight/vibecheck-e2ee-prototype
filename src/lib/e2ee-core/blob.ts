/**
 * Encrypt/decrypt the individual events ("blobs") that populate the `blobs`
 * table. Every blob is an AEAD-sealed, Ed25519-signed payload.
 *
 * Wire format v3 (per-device identities):
 *   The signature comes from the sender's DEVICE Ed25519 key (not the
 *   user's root). The envelope carries both the sender user_id and
 *   device_id so the verifier can look up the right device's pubkey and
 *   verify the device's issuance cert chains to the user's UMK.
 *
 * Wire format v2 (Sealed-Sender-lite, pre-per-device):
 *   Signature lived inside the AEAD, signed by the user's root
 *   ed25519_priv. Still decryptable for back-compat; caller passes a
 *   user-root pubkey for verification.
 *
 * Wire format v1 (legacy, read-only):
 *   Outer `signature` column on the row. Still decryptable.
 *
 * - Cipher: XChaCha20-Poly1305 (IETF variant), 24-byte random nonce.
 * - AD: room_id bytes || generation-as-4-BE-bytes. Binds ciphertext to
 *   (room, generation) so replay across rooms or generations fails AEAD.
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
  fromBase64,
  fromHex,
  getSodium,
  randomBytes,
  stringToBytes,
  toBase64,
} from './sodium';
import { signMessage, verifyMessage } from './identity';

const NONCE_BYTES = 24;
const BLOB_DOMAIN_V2 = stringToBytes('vibecheck:blob:v2');
const BLOB_DOMAIN_V3 = stringToBytes('vibecheck:blob:v3');

/** Build the AD (additional data) blob that binds ciphertext to (room, generation). */
async function buildAd(roomId: string, generation: number): Promise<Bytes> {
  const uuidBytes = await fromHex(roomId.replaceAll('-', ''));
  const gen = new Uint8Array(4);
  new DataView(gen.buffer).setUint32(0, generation, false);
  return concatBytes(uuidBytes, gen);
}

/**
 * v2/v3 signature message: domain || room_id || generation || nonce || payload_bytes.
 * Binding the nonce means cut-and-paste to a different blob row is detected
 * even though the ciphertext alone doesn't cover the nonce.
 */
async function buildInnerSigMessage(
  domain: Bytes,
  roomId: string,
  generation: number,
  nonce: Bytes,
  payloadBytes: Bytes,
): Promise<Bytes> {
  const uuidBytes = await fromHex(roomId.replaceAll('-', ''));
  const gen = new Uint8Array(4);
  new DataView(gen.buffer).setUint32(0, generation, false);
  return concatBytes(domain, uuidBytes, gen, nonce, payloadBytes);
}

interface V2Envelope {
  v: 2;
  sig: string;
  p: unknown;
}

interface V3Envelope {
  v: 3;
  /** Sender user_id — for RLS-independent attribution and verifier lookup. */
  s: string;
  /** Sender device_id — verifier fetches this device's ed pub + cert. */
  sd: string;
  /** base64 Ed25519 signature over (v3-domain || room || gen || nonce || payloadBytes). */
  sig: string;
  /** Application payload. Opaque JSON. */
  p: unknown;
}

function isV2Envelope(x: unknown): x is V2Envelope {
  return (
    typeof x === 'object' &&
    x !== null &&
    (x as { v?: unknown }).v === 2 &&
    typeof (x as { sig?: unknown }).sig === 'string'
  );
}

function isV3Envelope(x: unknown): x is V3Envelope {
  return (
    typeof x === 'object' &&
    x !== null &&
    (x as { v?: unknown }).v === 3 &&
    typeof (x as { s?: unknown }).s === 'string' &&
    typeof (x as { sd?: unknown }).sd === 'string' &&
    typeof (x as { sig?: unknown }).sig === 'string'
  );
}

/** Encrypt + sign a JSON payload for a room (v3: signed by device key). */
export async function encryptBlob<T>(params: {
  payload: T;
  roomId: string;
  roomKey: RoomKey;
  senderUserId: string;
  senderDeviceId: string;
  senderDeviceEd25519PrivateKey: Bytes;
}): Promise<EncryptedBlob> {
  const {
    payload,
    roomId,
    roomKey,
    senderUserId,
    senderDeviceId,
    senderDeviceEd25519PrivateKey,
  } = params;
  const sodium = await getSodium();
  const nonce = await randomBytes(NONCE_BYTES);

  const payloadBytes = stringToBytes(JSON.stringify(payload));
  const sigBytes = await signMessage(
    await buildInnerSigMessage(
      BLOB_DOMAIN_V3,
      roomId,
      roomKey.generation,
      nonce,
      payloadBytes,
    ),
    senderDeviceEd25519PrivateKey,
  );
  const envelope: V3Envelope = {
    v: 3,
    s: senderUserId,
    sd: senderDeviceId,
    sig: await toBase64(sigBytes),
    p: payload,
  };
  const plaintext = stringToBytes(JSON.stringify(envelope));
  sodium.memzero(payloadBytes);

  const ad = await buildAd(roomId, roomKey.generation);
  const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    plaintext,
    ad,
    null,
    nonce,
    roomKey.key,
  );
  sodium.memzero(plaintext);

  return {
    nonce,
    ciphertext,
    signature: new Uint8Array(0),
    generation: roomKey.generation,
  };
}

/**
 * Decrypted blob result — includes sender attribution from the v3 envelope.
 * v2/v1 callers get the senderUserId/senderDeviceId as nulls (they weren't
 * part of the older wire format).
 */
export interface DecryptedBlob<T> {
  payload: T;
  /** v3 only — sender user_id from inside the envelope. */
  senderUserId: string | null;
  /** v3 only — sender device_id from inside the envelope. */
  senderDeviceId: string | null;
}

/**
 * Resolver the caller provides so decryptBlob can look up a signer's pubkey
 * given (userId, deviceId). Returns null for unknown device. Typically backed
 * by a cache of `PublicDevice` records fetched from the server.
 */
export type SenderKeyResolver = (
  userId: string,
  deviceId: string,
) => Promise<Bytes | null>;

/**
 * Verify signature + decrypt. Handles v3 (per-device), v2 (user-key in AEAD),
 * and v1 (outer signature on the row). Throws CryptoError on any verification
 * failure.
 *
 * For v3, the caller must supply `resolveSenderDeviceEd25519Pub` to look up
 * the claimed sender device's ed25519 pubkey. The caller is also responsible
 * for verifying the device's issuance certificate against the sender user's
 * UMK before trusting any pubkey returned by the resolver.
 *
 * For v2/v1, the caller supplies a single `senderEd25519PublicKey` (legacy
 * user root pubkey). If `resolveSenderDeviceEd25519Pub` is also supplied,
 * it takes precedence when the envelope is v3.
 */
export async function decryptBlob<T>(params: {
  blob: EncryptedBlob;
  roomId: string;
  roomKey: RoomKey;
  /** Legacy fallback for v1/v2 blobs — the sender user's root ed25519 pub. */
  senderEd25519PublicKey?: Bytes | null;
  /** Required for v3 blobs. Look up device ed pub by (userId, deviceId). */
  resolveSenderDeviceEd25519Pub?: SenderKeyResolver | null;
}): Promise<DecryptedBlob<T>> {
  const {
    blob,
    roomId,
    roomKey,
    senderEd25519PublicKey,
    resolveSenderDeviceEd25519Pub,
  } = params;
  if (blob.generation !== roomKey.generation) {
    throw new CryptoError(
      `blob generation ${blob.generation} does not match provided room key generation ${roomKey.generation}`,
      'BAD_GENERATION',
    );
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
    const parsed: unknown = JSON.parse(bytesToString(plaintext));

    if (isV3Envelope(parsed)) {
      if (!resolveSenderDeviceEd25519Pub) {
        throw new CryptoError(
          'v3 blob requires a sender-device resolver',
          'SIGNATURE_INVALID',
        );
      }
      const devicePub = await resolveSenderDeviceEd25519Pub(parsed.s, parsed.sd);
      if (!devicePub) {
        throw new CryptoError(
          `sender device ${parsed.sd} not found (or not trusted)`,
          'SIGNATURE_INVALID',
        );
      }
      const innerPayloadBytes = stringToBytes(JSON.stringify(parsed.p));
      try {
        const sigOk = await verifyMessage(
          await buildInnerSigMessage(
            BLOB_DOMAIN_V3,
            roomId,
            blob.generation,
            blob.nonce,
            innerPayloadBytes,
          ),
          await fromBase64(parsed.sig),
          devicePub,
        );
        if (!sigOk) {
          throw new CryptoError('sender device signature invalid', 'SIGNATURE_INVALID');
        }
      } finally {
        sodium.memzero(innerPayloadBytes);
      }
      return {
        payload: parsed.p as T,
        senderUserId: parsed.s,
        senderDeviceId: parsed.sd,
      };
    }

    if (isV2Envelope(parsed)) {
      if (!senderEd25519PublicKey) {
        throw new CryptoError(
          'v2 blob requires sender user ed25519 pubkey',
          'SIGNATURE_INVALID',
        );
      }
      const innerPayloadBytes = stringToBytes(JSON.stringify(parsed.p));
      try {
        const sigOk = await verifyMessage(
          await buildInnerSigMessage(
            BLOB_DOMAIN_V2,
            roomId,
            blob.generation,
            blob.nonce,
            innerPayloadBytes,
          ),
          await fromBase64(parsed.sig),
          senderEd25519PublicKey,
        );
        if (!sigOk) {
          throw new CryptoError('sender signature invalid', 'SIGNATURE_INVALID');
        }
      } finally {
        sodium.memzero(innerPayloadBytes);
      }
      return {
        payload: parsed.p as T,
        senderUserId: null,
        senderDeviceId: null,
      };
    }

    // v1 legacy: outer signature covers (nonce || ciphertext).
    if (!senderEd25519PublicKey) {
      throw new CryptoError(
        'v1 blob requires sender user ed25519 pubkey',
        'SIGNATURE_INVALID',
      );
    }
    if (!blob.signature || blob.signature.byteLength === 0) {
      throw new CryptoError(
        'blob has no v3/v2 envelope and no outer signature',
        'SIGNATURE_INVALID',
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
    return {
      payload: parsed as T,
      senderUserId: null,
      senderDeviceId: null,
    };
  } finally {
    sodium.memzero(plaintext);
  }
}
