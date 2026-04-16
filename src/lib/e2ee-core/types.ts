/**
 * Public types for the e2ee-core module.
 *
 * All byte sequences are Uint8Array in runtime code. Types that cross the
 * Supabase boundary are encoded to/from base64 at the edges (see `sodium.ts`).
 *
 * Identity model (v3, cross-signing — Matrix-aligned):
 *   - MasterSigningKey (MSK): Ed25519. Signs SSK and USK cross-signatures
 *     only. Stays cold on the original primary device + recovery blob.
 *     Conceptually the same key as v2's UMK; the column stays.
 *   - SelfSigningKey (SSK): Ed25519. Signs device issuance + revocation
 *     certs. Present on every co-primary device (shared via sealed box
 *     during device approval). Replaces UMK's day-to-day role.
 *   - UserSigningKey (USK): Ed25519. Signs other users' MSK pubs after
 *     SAS verification. Present on co-primaries alongside SSK.
 *   - DeviceKeyBundle: per-device Ed25519 (signing) + X25519 (DH) keypair.
 *     Generated locally on each device; private halves never leave the
 *     device. Signs blobs, wraps room keys, signs membership ops.
 *   - DeviceCertificate: SSK signature (v2 certs) or UMK/MSK signature
 *     (v1 certs) binding a device_id to its pubkeys.
 *
 * Backward compat: UserMasterKey is a type alias for MasterSigningKey.
 *   v1 device certs (signed by UMK/MSK) still verify. v2 certs (signed
 *   by SSK) verify via the MSK→SSK cross-sig chain.
 */

export type Bytes = Uint8Array;

// ---------------------------------------------------------------------------
// Cross-signing key hierarchy (Matrix-aligned)
// ---------------------------------------------------------------------------

/** Master Signing Key — root of user identity. Signs SSK and USK only. */
export interface MasterSigningKey {
  ed25519PublicKey: Bytes;
  ed25519PrivateKey: Bytes;
}

/** Public half of MSK — the canonical TOFU anchor (= identities.ed25519_pub). */
export interface PublicMasterSigningKey {
  ed25519PublicKey: Bytes;
}

/** Self-Signing Key — signs own device issuance + revocation certs. */
export interface SelfSigningKey {
  ed25519PublicKey: Bytes;
  ed25519PrivateKey: Bytes;
}

/** User-Signing Key — signs other users' MSK pubs (cross-user verification). */
export interface UserSigningKey {
  ed25519PublicKey: Bytes;
  ed25519PrivateKey: Bytes;
}

/** SSK + USK bundle, present on co-primary devices. */
export interface SigningKeySet {
  ssk: SelfSigningKey;
  usk: UserSigningKey;
}

// Backward-compat aliases — existing code uses these names everywhere.
/** @alias MasterSigningKey */
export type UserMasterKey = MasterSigningKey;
/** @alias PublicMasterSigningKey */
export type PublicUserMasterKey = PublicMasterSigningKey;

/** A single device's long-term key bundle. Never copied between devices. */
export interface DeviceKeyBundle {
  deviceId: string;
  ed25519PublicKey: Bytes;
  ed25519PrivateKey: Bytes;
  x25519PublicKey: Bytes;
  x25519PrivateKey: Bytes;
}

/** Public halves of a device bundle + its SSK/UMK-issued certificate. */
export interface PublicDevice {
  deviceId: string;
  userId: string;
  ed25519PublicKey: Bytes;
  x25519PublicKey: Bytes;
  createdAtMs: number;
  /** Ed25519 signature over canonical cert tuple (v1: by MSK, v2: by SSK). */
  issuanceSignature: Bytes;
  /** Present iff the device has been revoked. */
  revocation: DeviceRevocation | null;
}

/** Revocation of a previously-issued device certificate (v1: MSK-signed, v2: SSK-signed). */
export interface DeviceRevocation {
  revokedAtMs: number;
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
  /** v4 (Megolm) — session_id as base64. Null for v3/v2/v1 flat-key blobs. */
  sessionId?: string | null;
  /** v4 (Megolm) — message index within the session. Null for v3/v2/v1. */
  messageIndex?: number | null;
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
  /** True if we hold a valid cross-user-signature for this contact's MSK. */
  verified?: boolean;
  /** Timestamp of last successful SAS verification. */
  verifiedAt?: number;
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
