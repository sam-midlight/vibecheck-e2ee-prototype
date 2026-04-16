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

import type { MegolmMessageKey } from './megolm';

const NONCE_BYTES = 24;
const BLOB_DOMAIN_V2 = stringToBytes('vibecheck:blob:v2');
const BLOB_DOMAIN_V3 = stringToBytes('vibecheck:blob:v3');
const BLOB_DOMAIN_V4 = stringToBytes('vibecheck:blob:v4');

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

/** v4: Megolm ratchet — includes session_id + message_index. */
interface V4Envelope {
  v: 4;
  s: string;
  sd: string;
  /** base64 session_id (32 bytes). */
  sid: string;
  /** Message index within the Megolm session. */
  mi: number;
  sig: string;
  p: unknown;
}

function isV4Envelope(x: unknown): x is V4Envelope {
  return (
    typeof x === 'object' &&
    x !== null &&
    (x as { v?: unknown }).v === 4 &&
    typeof (x as { sid?: unknown }).sid === 'string' &&
    typeof (x as { mi?: unknown }).mi === 'number' &&
    typeof (x as { s?: unknown }).s === 'string' &&
    typeof (x as { sd?: unknown }).sd === 'string' &&
    typeof (x as { sig?: unknown }).sig === 'string'
  );
}

/** Build the AD for v4 blobs: room_id(16) || session_id(32) || message_index(4 BE). */
async function buildAdV4(roomId: string, sessionId: Bytes, messageIndex: number): Promise<Bytes> {
  const uuidB = await fromHex(roomId.replaceAll('-', ''));
  const miBuf = new Uint8Array(4);
  new DataView(miBuf.buffer).setUint32(0, messageIndex, false);
  return concatBytes(uuidB, sessionId, miBuf);
}

/** v4 signature message: domain || room_id || session_id || message_index || nonce || payload. */
async function buildV4SigMessage(
  roomId: string,
  sessionId: Bytes,
  messageIndex: number,
  nonce: Bytes,
  payloadBytes: Bytes,
): Promise<Bytes> {
  const uuidB = await fromHex(roomId.replaceAll('-', ''));
  const miBuf = new Uint8Array(4);
  new DataView(miBuf.buffer).setUint32(0, messageIndex, false);
  return concatBytes(BLOB_DOMAIN_V4, uuidB, sessionId, miBuf, nonce, payloadBytes);
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
 * Encrypt + sign a JSON payload using a Megolm message key (v4 envelope).
 * The caller is responsible for ratcheting the outbound session and
 * deriving the message key via `ratchetAndDerive()` before calling this.
 */
export async function encryptBlobV4<T>(params: {
  payload: T;
  roomId: string;
  messageKey: MegolmMessageKey;
  sessionId: Bytes;
  generation: number;
  senderUserId: string;
  senderDeviceId: string;
  senderDeviceEd25519PrivateKey: Bytes;
}): Promise<EncryptedBlob> {
  const {
    payload,
    roomId,
    messageKey,
    sessionId,
    generation,
    senderUserId,
    senderDeviceId,
    senderDeviceEd25519PrivateKey,
  } = params;
  const sodium = await getSodium();
  const nonce = await randomBytes(NONCE_BYTES);

  const payloadBytes = stringToBytes(JSON.stringify(payload));
  const sigBytes = await signMessage(
    await buildV4SigMessage(roomId, sessionId, messageKey.index, nonce, payloadBytes),
    senderDeviceEd25519PrivateKey,
  );
  const envelope: V4Envelope = {
    v: 4,
    s: senderUserId,
    sd: senderDeviceId,
    sid: await toBase64(sessionId),
    mi: messageKey.index,
    sig: await toBase64(sigBytes),
    p: payload,
  };
  const plaintext = stringToBytes(JSON.stringify(envelope));
  sodium.memzero(payloadBytes);

  const ad = await buildAdV4(roomId, sessionId, messageKey.index);
  const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    plaintext,
    ad,
    null,
    nonce,
    messageKey.key,
  );
  sodium.memzero(plaintext);

  return {
    nonce,
    ciphertext,
    signature: new Uint8Array(0),
    generation,
    sessionId: await toBase64(sessionId),
    messageIndex: messageKey.index,
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
 * Resolver for Megolm message keys. Given a session_id + message_index,
 * returns the derived 32-byte XChaCha20-Poly1305 key. The caller manages
 * inbound session snapshots and chain-key advancement.
 */
export type MegolmKeyResolver = (
  sessionId: string,
  messageIndex: number,
) => Promise<Bytes | null>;

/**
 * Verify signature + decrypt. Handles v4 (Megolm), v3 (per-device flat key),
 * v2 (user-key in AEAD), and v1 (outer signature on the row). Throws
 * CryptoError on any verification failure.
 */
export async function decryptBlob<T>(params: {
  blob: EncryptedBlob;
  roomId: string;
  /** Used for v3/v2/v1 flat-key blobs. Ignored for v4 (Megolm). */
  roomKey: RoomKey;
  /** Legacy fallback for v1/v2 blobs — the sender user's root ed25519 pub. */
  senderEd25519PublicKey?: Bytes | null;
  /** Required for v3/v4 blobs. Look up device ed pub by (userId, deviceId). */
  resolveSenderDeviceEd25519Pub?: SenderKeyResolver | null;
  /** Required for v4 (Megolm) blobs. Resolve message key from inbound session. */
  resolveMegolmKey?: MegolmKeyResolver | null;
}): Promise<DecryptedBlob<T>> {
  const {
    blob,
    roomId,
    roomKey,
    senderEd25519PublicKey,
    resolveSenderDeviceEd25519Pub,
    resolveMegolmKey,
  } = params;

  // --- v4 (Megolm) path: session_id + message_index on the blob row ---
  if (blob.sessionId && blob.messageIndex != null) {
    if (!resolveMegolmKey) {
      throw new CryptoError('v4 blob requires a Megolm key resolver', 'DECRYPT_FAILED');
    }
    const msgKey = await resolveMegolmKey(blob.sessionId, blob.messageIndex);
    if (!msgKey) {
      throw new CryptoError(
        `no Megolm key for session ${blob.sessionId.slice(0, 8)}… index ${blob.messageIndex}`,
        'DECRYPT_FAILED',
      );
    }
    const sessionIdBytes = await fromBase64(blob.sessionId);
    const ad = await buildAdV4(roomId, sessionIdBytes, blob.messageIndex);
    const sodium = await getSodium();
    let plaintext: Bytes;
    try {
      plaintext = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
        null, blob.ciphertext, ad, blob.nonce, msgKey,
      );
    } catch {
      throw new CryptoError('Megolm AEAD decryption failed', 'DECRYPT_FAILED');
    }
    try {
      const parsed: unknown = JSON.parse(bytesToString(plaintext));
      if (!isV4Envelope(parsed)) {
        throw new CryptoError('expected v4 envelope inside Megolm blob', 'DECRYPT_FAILED');
      }
      if (!resolveSenderDeviceEd25519Pub) {
        throw new CryptoError('v4 blob requires a sender-device resolver', 'SIGNATURE_INVALID');
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
          await buildV4SigMessage(roomId, sessionIdBytes, parsed.mi, blob.nonce, innerPayloadBytes),
          await fromBase64(parsed.sig),
          devicePub,
        );
        if (!sigOk) {
          throw new CryptoError('v4 sender device signature invalid', 'SIGNATURE_INVALID');
        }
      } finally {
        sodium.memzero(innerPayloadBytes);
      }
      return { payload: parsed.p as T, senderUserId: parsed.s, senderDeviceId: parsed.sd };
    } finally {
      sodium.memzero(plaintext);
    }
  }

  // --- v3/v2/v1 flat-key path (unchanged) ---
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
