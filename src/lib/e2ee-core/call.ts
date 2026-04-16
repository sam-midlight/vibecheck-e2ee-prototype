/**
 * Call-scoped symmetric key primitives (v3).
 *
 * A `CallKey` is 32 random bytes, one generation at a time, used as the E2EE
 * root for SFrame media encryption inside a LiveKit room. It is NOT derived
 * from any room key — calls are their own scope, with their own membership
 * subset and their own rotation lifecycle.
 *
 * Distribution pattern mirrors room keys exactly: seal the CallKey with
 * `crypto_box_seal` to each recipient device's X25519 pub, and sign the
 * envelope with the sender's device Ed25519 priv. Verifiers chain the
 * sender's device cert back to the user's UMK.
 *
 * Envelope signature binds:
 *   - call_id
 *   - generation
 *   - target device_id
 *   - sha256(ciphertext)   (binds the specific sealed bytes being delivered)
 *   - sender device_id     (for verifier lookup — matches the row column)
 *
 * Canonical signed-message layout (domain-tagged, fixed-width):
 *   "vibecheck:callkey:v1" ||
 *   call_id (16 bytes)      ||
 *   generation (4 bytes BE) ||
 *   target_device_id (16 bytes) ||
 *   sha256(ciphertext) (32 bytes) ||
 *   sender_device_id (16 bytes)
 *
 * See `docs/video-call-design.md` §3 and §6 for the higher-level flow.
 */

import { CryptoError, type Bytes } from './types';
import {
  assertLength,
  concatBytes,
  fromHex,
  getSodium,
  randomBytes,
  stringToBytes,
} from './sodium';
import { signMessage, verifyMessageOrThrow } from './identity';

const CALL_KEY_BYTES = 32;
const CALL_KEY_DOMAIN = stringToBytes('vibecheck:callkey:v1');

/** 32-byte symmetric key for a (call_id, generation). Handed to LiveKit as-is. */
export interface CallKey {
  key: Bytes;
  generation: number;
}

/** The opaque sealed output + signature a sender hands to the server. */
export interface CallKeyEnvelope {
  /** crypto_box_seal(CallKey.key, target.x25519Pub) */
  ciphertext: Bytes;
  /** ed25519 sig over the canonical tuple below. */
  signature: Bytes;
}

/** Fields bound by a CallKeyEnvelope signature. */
export interface CallKeyEnvelopeFields {
  callId: string;
  generation: number;
  targetDeviceId: string;
  senderDeviceId: string;
  /** The sealed bytes being delivered; sha256'd into the signed message. */
  ciphertext: Bytes;
}

async function uuidBytes(id: string): Promise<Bytes> {
  return fromHex(id.replaceAll('-', ''));
}

function u32BE(n: number): Bytes {
  const buf = new Uint8Array(4);
  new DataView(buf.buffer).setUint32(0, n, false);
  return buf;
}

async function sha256(bytes: Bytes): Promise<Bytes> {
  const sodium = await getSodium();
  return sodium.crypto_hash_sha256(bytes);
}

async function canonicalEnvelopeMessage(
  f: CallKeyEnvelopeFields,
): Promise<Bytes> {
  if (f.generation < 1) {
    throw new CryptoError('generation must be >= 1', 'BAD_GENERATION');
  }
  return concatBytes(
    CALL_KEY_DOMAIN,
    await uuidBytes(f.callId),
    u32BE(f.generation),
    await uuidBytes(f.targetDeviceId),
    await sha256(f.ciphertext),
    await uuidBytes(f.senderDeviceId),
  );
}

// ---------------------------------------------------------------------------
// Key generation + wrap/unwrap
// ---------------------------------------------------------------------------

/** Generate a fresh 32-byte CallKey for the given generation (defaults to 1). */
export async function generateCallKey(generation = 1): Promise<CallKey> {
  if (generation < 1) {
    throw new CryptoError('generation must be >= 1', 'BAD_GENERATION');
  }
  return {
    key: await randomBytes(CALL_KEY_BYTES),
    generation,
  };
}

/**
 * Wrap (seal) a CallKey for a recipient device. Produces only the ciphertext —
 * the caller provides the sender identity and calls `signCallEnvelope` to
 * build the full envelope.
 */
export async function wrapCallKeyForDevice(
  callKey: CallKey,
  recipientX25519PublicKey: Bytes,
): Promise<Bytes> {
  const sodium = await getSodium();
  assertLength(callKey.key, CALL_KEY_BYTES, 'callKey.key');
  return sodium.crypto_box_seal(callKey.key, recipientX25519PublicKey);
}

/**
 * Unwrap a sealed CallKey using the recipient's X25519 keypair.
 * Signature verification is the caller's responsibility (call
 * `verifyCallEnvelope` first — otherwise any bystander could plant a key).
 */
export async function unwrapCallKey(
  ciphertext: Bytes,
  generation: number,
  recipientX25519PublicKey: Bytes,
  recipientX25519PrivateKey: Bytes,
): Promise<CallKey> {
  const sodium = await getSodium();
  let key: Bytes;
  try {
    key = sodium.crypto_box_seal_open(
      ciphertext,
      recipientX25519PublicKey,
      recipientX25519PrivateKey,
    );
  } catch {
    throw new CryptoError('failed to open sealed call key', 'DECRYPT_FAILED');
  }
  assertLength(key, CALL_KEY_BYTES, 'unwrapped callKey');
  return { key, generation };
}

/** Zero out a CallKey once the call / generation is done with it. */
export async function zeroCallKey(callKey: CallKey): Promise<void> {
  const sodium = await getSodium();
  sodium.memzero(callKey.key);
}

// ---------------------------------------------------------------------------
// Envelope signing / verification
// ---------------------------------------------------------------------------

/**
 * Sign a CallKeyEnvelope with the sender device's Ed25519 private key. Call
 * once per target device per generation.
 */
export async function signCallEnvelope(
  fields: CallKeyEnvelopeFields,
  senderDeviceEd25519PrivateKey: Bytes,
): Promise<Bytes> {
  const msg = await canonicalEnvelopeMessage(fields);
  return signMessage(msg, senderDeviceEd25519PrivateKey);
}

/**
 * Verify a CallKeyEnvelope signature. Throws `SIGNATURE_INVALID` on mismatch.
 *
 * The caller is separately responsible for verifying the sender device's
 * issuance certificate against the sender user's UMK before trusting the
 * pubkey passed in here — otherwise a rogue server could present an
 * uncertified device pubkey and this check would pass.
 */
export async function verifyCallEnvelope(
  fields: CallKeyEnvelopeFields,
  signature: Bytes,
  senderDeviceEd25519PublicKey: Bytes,
): Promise<void> {
  const msg = await canonicalEnvelopeMessage(fields);
  await verifyMessageOrThrow(msg, signature, senderDeviceEd25519PublicKey);
}

// ---------------------------------------------------------------------------
// Convenience: produce a full envelope (ciphertext + signature) in one call.
// ---------------------------------------------------------------------------

/**
 * One-shot wrap + sign. Returned envelope is ready to upload via
 * start_call / rotate_call_key after base64-encoding the two byte fields.
 */
export async function wrapAndSignCallEnvelope(params: {
  callKey: CallKey;
  callId: string;
  targetDeviceId: string;
  targetX25519PublicKey: Bytes;
  senderDeviceId: string;
  senderDeviceEd25519PrivateKey: Bytes;
}): Promise<CallKeyEnvelope> {
  const ciphertext = await wrapCallKeyForDevice(
    params.callKey,
    params.targetX25519PublicKey,
  );
  const signature = await signCallEnvelope(
    {
      callId: params.callId,
      generation: params.callKey.generation,
      targetDeviceId: params.targetDeviceId,
      senderDeviceId: params.senderDeviceId,
      ciphertext,
    },
    params.senderDeviceEd25519PrivateKey,
  );
  return { ciphertext, signature };
}
