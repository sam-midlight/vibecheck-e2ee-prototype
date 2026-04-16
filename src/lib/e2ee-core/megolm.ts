/**
 * Megolm-style sender ratchet (Matrix-aligned).
 *
 * Each sender maintains one outbound session per room. The session has a
 * 32-byte chain key that ratchets forward on every message:
 *
 *   chain_key[0]   = ratchet_seed (random at session creation)
 *   chain_key[i+1] = HMAC-SHA256(chain_key[i], 0x02)
 *   message_key[i] = HMAC-SHA256(chain_key[i], 0x01)  (truncated to 32 bytes)
 *
 * Recipients receive an inbound snapshot = (session_id, chain_key_at_index,
 * start_index). They can advance forward but not backward — compromising
 * message_key[N] does not reveal message_key[<N].
 *
 * No 4-level LFSR fast-forward (Matrix optimization). With 100-message
 * auto-rotation, max forward is small; simple HMAC chain suffices.
 */

import { CryptoError, type Bytes } from './types';
import {
  concatBytes,
  fromHex,
  getSodium,
  randomBytes,
  stringToBytes,
} from './sodium';
import { signMessage, verifyMessageOrThrow } from './identity';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Outbound session — held by the sender device, mutated on each message. */
export interface OutboundMegolmSession {
  sessionId: Bytes;       // 32 random bytes
  chainKey: Bytes;        // 32 bytes — current ratchet state
  messageIndex: number;   // u32, starts at 0
  roomId: string;
  generation: number;     // room generation this session belongs to
  createdAt: number;      // Date.now() at creation
}

/** Snapshot shared with recipients so they can decrypt from startIndex forward. */
export interface InboundSessionSnapshot {
  sessionId: Bytes;            // 32 bytes
  chainKeyAtIndex: Bytes;      // 32 bytes — chain key at startIndex
  startIndex: number;          // u32
  senderUserId: string;
  senderDeviceId: string;
}

/** Per-message derived key. */
export interface MegolmMessageKey {
  key: Bytes;    // 32 bytes — XChaCha20-Poly1305 symmetric key
  index: number; // which message this key is for
}

/** Auto-rotation configuration. */
export interface AutoRotationConfig {
  maxMessages: number;  // default 100
  maxAgeMs: number;     // default 7 days
}

export const DEFAULT_AUTO_ROTATION: AutoRotationConfig = {
  maxMessages: 100,
  maxAgeMs: 7 * 24 * 60 * 60 * 1000,
};

// ---------------------------------------------------------------------------
// Ratchet primitives
// ---------------------------------------------------------------------------

const CHAIN_ADVANCE_BYTE = new Uint8Array([0x02]);
const MESSAGE_KEY_BYTE = new Uint8Array([0x01]);

/** Derive message key from current chain key (does NOT advance). */
async function deriveMessageKey(chainKey: Bytes): Promise<Bytes> {
  const sodium = await getSodium();
  return sodium.crypto_auth_hmacsha256(MESSAGE_KEY_BYTE, chainKey);
}

/** Advance chain key by one step (irreversible). */
async function advanceChainKey(chainKey: Bytes): Promise<Bytes> {
  const sodium = await getSodium();
  return sodium.crypto_auth_hmacsha256(CHAIN_ADVANCE_BYTE, chainKey);
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

/** Create a fresh outbound session for a room. */
export async function createOutboundSession(
  roomId: string,
  generation: number,
): Promise<OutboundMegolmSession> {
  const sessionId = await randomBytes(32);
  const chainKey = await randomBytes(32);
  return {
    sessionId,
    chainKey,
    messageIndex: 0,
    roomId,
    generation,
    createdAt: Date.now(),
  };
}

/**
 * Ratchet the outbound session and derive the next message key.
 * MUTATES the session in place (advances chainKey + increments messageIndex).
 */
export async function ratchetAndDerive(
  session: OutboundMegolmSession,
): Promise<MegolmMessageKey> {
  const key = await deriveMessageKey(session.chainKey);
  const index = session.messageIndex;
  const sodium = await getSodium();
  // Advance chain key — old chain key is no longer recoverable.
  const nextChain = await advanceChainKey(session.chainKey);
  sodium.memzero(session.chainKey);
  session.chainKey = nextChain;
  session.messageIndex = index + 1;
  return { key, index };
}

/**
 * Export a snapshot of the current session state for sharing with a
 * recipient. The snapshot allows decrypting from the current messageIndex
 * forward — not before.
 */
export function exportSessionSnapshot(
  session: OutboundMegolmSession,
  senderUserId: string,
  senderDeviceId: string,
): InboundSessionSnapshot {
  return {
    sessionId: new Uint8Array(session.sessionId),
    chainKeyAtIndex: new Uint8Array(session.chainKey),
    startIndex: session.messageIndex,
    senderUserId,
    senderDeviceId,
  };
}

/**
 * Given an inbound snapshot, derive the message key at a target index.
 * The snapshot must have startIndex <= targetIndex. Returns a new
 * MegolmMessageKey.
 */
export async function deriveMessageKeyAtIndex(
  snapshot: InboundSessionSnapshot,
  targetIndex: number,
): Promise<MegolmMessageKey> {
  if (targetIndex < snapshot.startIndex) {
    throw new CryptoError(
      `cannot derive key at index ${targetIndex} — snapshot starts at ${snapshot.startIndex}`,
      'BAD_GENERATION',
    );
  }
  const sodium = await getSodium();
  // Advance chain key from startIndex to targetIndex
  let chain: Uint8Array = new Uint8Array(snapshot.chainKeyAtIndex);
  for (let i = snapshot.startIndex; i < targetIndex; i++) {
    const next = new Uint8Array(await advanceChainKey(chain));
    sodium.memzero(chain);
    chain = next;
  }
  const key = await deriveMessageKey(chain);
  sodium.memzero(chain);
  return { key, index: targetIndex };
}

/** Check whether an outbound session should be rotated (Phase 4 trigger). */
export function shouldRotateSession(
  session: OutboundMegolmSession,
  config: AutoRotationConfig = DEFAULT_AUTO_ROTATION,
): boolean {
  if (session.messageIndex >= config.maxMessages) return true;
  if (Date.now() - session.createdAt >= config.maxAgeMs) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Session share sealing / unsealing
// ---------------------------------------------------------------------------

/** Seal a session snapshot to a recipient device's X25519 pub. */
export async function sealSessionSnapshot(
  snapshot: InboundSessionSnapshot,
  recipientX25519Pub: Bytes,
): Promise<Bytes> {
  const sodium = await getSodium();
  // Pack: sessionId(32) || chainKeyAtIndex(32) || startIndex(4 BE) ||
  //        senderUserId UTF-8 || '\0' || senderDeviceId UTF-8
  const startIndexBuf = new Uint8Array(4);
  new DataView(startIndexBuf.buffer).setUint32(0, snapshot.startIndex, false);
  const senderUserIdBytes = stringToBytes(snapshot.senderUserId);
  const sep = new Uint8Array([0]);
  const senderDeviceIdBytes = stringToBytes(snapshot.senderDeviceId);
  const packed = concatBytes(
    snapshot.sessionId,
    snapshot.chainKeyAtIndex,
    startIndexBuf,
    senderUserIdBytes,
    sep,
    senderDeviceIdBytes,
  );
  const sealed = sodium.crypto_box_seal(packed, recipientX25519Pub);
  sodium.memzero(packed);
  return sealed;
}

/** Unseal a session snapshot with this device's X25519 keypair. */
export async function unsealSessionSnapshot(
  sealed: Bytes,
  x25519Pub: Bytes,
  x25519Priv: Bytes,
): Promise<InboundSessionSnapshot> {
  const sodium = await getSodium();
  let packed: Bytes;
  try {
    packed = sodium.crypto_box_seal_open(sealed, x25519Pub, x25519Priv);
  } catch {
    throw new CryptoError('failed to unseal session snapshot', 'DECRYPT_FAILED');
  }
  try {
    // Unpack: sessionId(32) || chainKey(32) || startIndex(4 BE) || senderUserId || \0 || senderDeviceId
    const sessionId = packed.slice(0, 32);
    const chainKeyAtIndex = packed.slice(32, 64);
    const siBuf = packed.slice(64, 68);
    const startIndex = new DataView(siBuf.buffer, siBuf.byteOffset, 4).getUint32(0, false);
    const rest = packed.slice(68);
    const sepIdx = rest.indexOf(0);
    if (sepIdx === -1) throw new CryptoError('malformed snapshot', 'BAD_INPUT');
    const decoder = new TextDecoder();
    const senderUserId = decoder.decode(rest.slice(0, sepIdx));
    const senderDeviceId = decoder.decode(rest.slice(sepIdx + 1));
    return { sessionId, chainKeyAtIndex, startIndex, senderUserId, senderDeviceId };
  } finally {
    sodium.memzero(packed);
  }
}

// ---------------------------------------------------------------------------
// Session share signature
// ---------------------------------------------------------------------------

const SHARE_DOMAIN = stringToBytes('vibecheck:megolm-share:v1');

async function uuidBytes(id: string): Promise<Bytes> {
  return fromHex(id.replaceAll('-', ''));
}

/** Sign a session share (binds snapshot to recipient + signer). */
export async function signSessionShare(params: {
  sessionId: Bytes;
  recipientDeviceId: string;
  sealedSnapshot: Bytes;
  signerDeviceId: string;
  signerEd25519Priv: Bytes;
}): Promise<Bytes> {
  const sodium = await getSodium();
  const hash = sodium.crypto_hash_sha256(params.sealedSnapshot);
  const msg = concatBytes(
    SHARE_DOMAIN,
    params.sessionId,
    await uuidBytes(params.recipientDeviceId),
    hash,
    await uuidBytes(params.signerDeviceId),
  );
  return signMessage(msg, params.signerEd25519Priv);
}

/** Verify a session share signature. */
export async function verifySessionShare(params: {
  sessionId: Bytes;
  recipientDeviceId: string;
  sealedSnapshot: Bytes;
  signerDeviceId: string;
  signature: Bytes;
  signerEd25519Pub: Bytes;
}): Promise<void> {
  const sodium = await getSodium();
  const hash = sodium.crypto_hash_sha256(params.sealedSnapshot);
  const msg = concatBytes(
    SHARE_DOMAIN,
    params.sessionId,
    await uuidBytes(params.recipientDeviceId),
    hash,
    await uuidBytes(params.signerDeviceId),
  );
  try {
    await verifyMessageOrThrow(msg, params.signature, params.signerEd25519Pub);
  } catch (err) {
    if (err instanceof CryptoError && err.code === 'SIGNATURE_INVALID') {
      throw new CryptoError('session share signature invalid', 'CERT_INVALID');
    }
    throw err;
  }
}
