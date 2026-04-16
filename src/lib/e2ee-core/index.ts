/**
 * e2ee-core — app-agnostic zero-knowledge encryption primitives.
 *
 * Public surface grouped by layer:
 *
 *   Primitives (runtime + codec):
 *     getSodium, randomBytes, toBase64, fromBase64, toHex, fromHex,
 *     stringToBytes, bytesToString, concatBytes, bytesEqual
 *
 *   Identity (long-term signing + DH keypairs):
 *     generateIdentity, toPublicIdentity, verifySelfSignature,
 *     signMessage, verifyMessage, verifyMessageOrThrow,
 *     publicIdentityFingerprint
 *
 *   Room keys (per-room symmetric keys, wrapped per member):
 *     generateRoomKey, wrapRoomKeyFor, unwrapRoomKey, rotateRoomKey,
 *     zeroRoomKey
 *
 *   Blobs (encrypt/decrypt + sign):
 *     encryptBlob, decryptBlob
 *
 *   Device linking (QR handoff):
 *     buildLinkPayload, sealIdentityForLink, openSealedIdentity
 *
 *   Storage (IndexedDB):
 *     putIdentity, getIdentity, clearIdentity,
 *     putDeviceRecord, getDeviceRecord,
 *     putKnownContact, getKnownContact, listKnownContacts,
 *     wipeAll
 *
 *   Trust (TOFU + key-change detection):
 *     observeContact, acceptKeyChange, onKeyChange
 *
 *   Call keys (per-call symmetric keys for SFrame E2EE):
 *     generateCallKey, wrapCallKeyForDevice, unwrapCallKey,
 *     signCallEnvelope, verifyCallEnvelope, wrapAndSignCallEnvelope,
 *     zeroCallKey
 *
 *   Types + errors:
 *     Bytes, Identity, PublicIdentity, DeviceLinkingKeys, RoomKey,
 *     WrappedRoomKey, EncryptedBlob, KnownContact, KeyChangeEvent,
 *     CallKey, CallKeyEnvelope, CallKeyEnvelopeFields,
 *     CryptoError, TrustError
 */

export * from './types';
export * from './sodium';
export * from './identity';
export * from './room';
export * from './blob';
export * from './linking';
export * from './approval';
export * from './recovery';
export * from './storage';
export * from './tofu';
export * from './attachment';
export * from './membership';
export * from './pin-lock';
export * from './device';
export * from './cross-signing';
export * from './megolm';
export * from './sas';
export * from './call';
