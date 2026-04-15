/**
 * Public types for the e2ee-core module.
 *
 * All byte sequences are Uint8Array in runtime code. Types that cross the
 * Supabase boundary are encoded to/from base64 at the edges (see `sodium.ts`).
 *
 * Identity model (v2, per-device):
 *   - UserMasterKey (UMK): a single Ed25519 keypair per user. Signs device
 *     certificates and revocations. Never signs messages or wraps keys
 *     directly. Private half lives on whichever device holds it (typically
 *     the account-creation device) and is transferable via recovery phrase.
 *   - DeviceKeyBundle: per-device Ed25519 (signing) + X25519 (DH) keypair.
 *     Generated locally on each device; private halves never leave the
 *     device. Signs blobs, wraps room keys, signs membership ops.
 *   - DeviceCertificate: UMK signature binding a device_id to its pubkeys.
 *     Required for any device to participate.
 */

export type Bytes = Uint8Array;

// ---------------------------------------------------------------------------
// Identity v2 — per-device
// ---------------------------------------------------------------------------

/**
 * A user's root signing authority. The private half is rare and precious —
 * it lives on one device (the UMK-holder, typically the account creator)
 * plus any recovery-phrase-wrapped copy. Linked devices do NOT receive it.
 */
export interface UserMasterKey {
  ed25519PublicKey: Bytes;
  ed25519PrivateKey: Bytes;
}

/** The public half of a UMK — canonical identity of a user on the server. */
export interface PublicUserMasterKey {
  ed25519PublicKey: Bytes;
}

/** A single device's long-term key bundle. Never copied between devices. */
export interface DeviceKeyBundle {
  deviceId: string;
  ed25519PublicKey: Bytes;
  ed25519PrivateKey: Bytes;
  x25519PublicKey: Bytes;
  x25519PrivateKey: Bytes;
}

/** Public halves of a device bundle + its UMK-issued certificate. */
export interface PublicDevice {
  deviceId: string;
  userId: string;
  ed25519PublicKey: Bytes;
  x25519PublicKey: Bytes;
  createdAtMs: number;
  /** Ed25519 signature by UMK over canonical cert tuple. */
  issuanceSignature: Bytes;
  /** Present iff the device has been revoked. */
  revocation: DeviceRevocation | null;
}

/** UMK-signed revocation of a previously-issued device certificate. */
export interface DeviceRevocation {
  revokedAtMs: number;
  /** Ed25519 signature by UMK over canonical revocation tuple. */
  signature: Bytes;
}

// ---------------------------------------------------------------------------
// Legacy v1 types (kept for back-compat reads only — do not produce new ones)
// ---------------------------------------------------------------------------

/**
 * @deprecated Pre-v2 combined-root-identity shape. Kept so existing callers
 * compile; new code should use UserMasterKey + DeviceKeyBundle. The
 * ed25519 fields now correspond to the UMK; the x25519 fields are no
 * longer user-scoped — they're per-device and live in a DeviceKeyBundle.
 */
export interface Identity {
  ed25519PublicKey: Bytes;
  ed25519PrivateKey: Bytes;
  x25519PublicKey: Bytes;
  x25519PrivateKey: Bytes;
}

/** @deprecated Use PublicUserMasterKey + PublicDevice list. */
export interface PublicIdentity {
  ed25519PublicKey: Bytes;
  x25519PublicKey: Bytes;
  selfSignature: Bytes;
}

// ---------------------------------------------------------------------------
// Device linking / approval transport
// ---------------------------------------------------------------------------

/**
 * Ephemeral X25519 keypair carried by the new device through the device-link
 * handoff. In v2 this is OPTIONAL — the approval flow no longer seals a root
 * identity, so there's nothing to encrypt to. Retained for back-compat and
 * for flows that still use the sealed-payload transport.
 */
export interface DeviceLinkingKeys {
  x25519PublicKey: Bytes;
  x25519PrivateKey: Bytes;
  linkNonce: Bytes;
}

// ---------------------------------------------------------------------------
// Rooms, blobs, TOFU
// ---------------------------------------------------------------------------

/** A room's per-generation symmetric key. */
export interface RoomKey {
  key: Bytes;
  generation: number;
}

/** A wrapped room key to be sent through the server to a recipient device. */
export interface WrappedRoomKey {
  wrapped: Bytes;
  generation: number;
}

/** One encrypted event to be inserted into the `blobs` table. */
export interface EncryptedBlob {
  nonce: Bytes;
  ciphertext: Bytes;
  signature: Bytes;
  generation: number;
}

/**
 * TOFU record. In v2, TOFU tracks per-user UMK continuity (UMK pub is the
 * stable anchor); the device-ed/x fields track the device currently being
 * observed. A change in UMK pub is the "safety number changed" signal; a
 * new device appearing under an unchanged UMK is routine.
 */
export interface KnownContact {
  userId: string;
  ed25519PublicKey: Bytes;
  x25519PublicKey: Bytes;
  firstSeenAt: number;
  lastSeenAt: number;
}

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

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class CryptoError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'SODIUM_NOT_READY'
      | 'DECRYPT_FAILED'
      | 'SIGNATURE_INVALID'
      | 'SELF_SIG_INVALID'
      | 'CERT_INVALID'
      | 'DEVICE_REVOKED'
      | 'BAD_KEY_LENGTH'
      | 'BAD_GENERATION'
      | 'BAD_INPUT',
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
