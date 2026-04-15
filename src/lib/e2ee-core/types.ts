/**
 * Public types for the e2ee-core module.
 *
 * All byte sequences are Uint8Array in runtime code. Types that cross the
 * Supabase boundary are encoded to/from base64 at the edges (see `sodium.ts`).
 */

export type Bytes = Uint8Array;

/** A user's long-term identity. Private keys live ONLY in IndexedDB. */
export interface Identity {
  ed25519PublicKey: Bytes;
  ed25519PrivateKey: Bytes;
  x25519PublicKey: Bytes;
  x25519PrivateKey: Bytes;
}

/** Just the public half of an identity (what we publish or fetch from server). */
export interface PublicIdentity {
  ed25519PublicKey: Bytes;
  x25519PublicKey: Bytes;
  selfSignature: Bytes;
}

/** Per-device ephemeral keypair used only for QR device-linking handoff. */
export interface DeviceLinkingKeys {
  x25519PublicKey: Bytes;
  x25519PrivateKey: Bytes;
  linkNonce: Bytes; // 32 random bytes; also shown in QR
}

/** A room's per-generation symmetric key. */
export interface RoomKey {
  key: Bytes; // 32 bytes
  generation: number;
}

/** A wrapped room key to be sent through the server to a recipient. */
export interface WrappedRoomKey {
  wrapped: Bytes; // crypto_box_seal output
  generation: number;
}

/** One encrypted event to be inserted into the `blobs` table. */
export interface EncryptedBlob {
  nonce: Bytes; // 24 bytes
  ciphertext: Bytes;
  signature: Bytes;
  generation: number;
}

/** TOFU record: the last-seen pubkey for a given contact, used to detect changes. */
export interface KnownContact {
  userId: string;
  ed25519PublicKey: Bytes;
  x25519PublicKey: Bytes;
  firstSeenAt: number;
  lastSeenAt: number;
}

/** Emitted when a contact's published pubkey doesn't match what we cached. */
export interface KeyChangeEvent {
  userId: string;
  previous: {
    ed25519PublicKey: Bytes;
    x25519PublicKey: Bytes;
    firstSeenAt: number;
  };
  current: {
    ed25519PublicKey: Bytes;
    x25519PublicKey: Bytes;
  };
  detectedAt: number;
}

export class CryptoError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'SODIUM_NOT_READY'
      | 'DECRYPT_FAILED'
      | 'SIGNATURE_INVALID'
      | 'SELF_SIG_INVALID'
      | 'BAD_KEY_LENGTH'
      | 'BAD_GENERATION',
  ) {
    super(message);
    this.name = 'CryptoError';
  }
}

export class TrustError extends Error {
  constructor(
    message: string,
    readonly code: 'KEY_CHANGED' | 'UNKNOWN_CONTACT',
    readonly event?: KeyChangeEvent,
  ) {
    super(message);
    this.name = 'TrustError';
  }
}
