/**
 * Signed membership primitives (v2, per-device).
 *
 * The ghost-user defense is preserved but the signer is now a DEVICE, not a
 * user. Every membership-state-change row (invite, member insert during
 * join or rotation) carries an Ed25519 signature over a canonical,
 * domain-tagged tuple. Signatures verify against the signer device's
 * Ed25519 pubkey, whose authenticity chains to the user's UMK via the
 * device's issuance certificate (see device.ts).
 *
 * Invite envelope binds:
 *   - the room + generation being invited to
 *   - the invitee's specific device (user_id, device_id, device_ed_pub,
 *     device_x_pub) so a bait-and-switch of the recipient invalidates it
 *   - a hash of the wrapped room key
 *   - the inviter's user_id + device_id (for verifier lookup)
 *   - the invite's expiry (milliseconds)
 *
 * Member-wrap signature binds:
 *   - the room + generation + member (user_id, device_id)
 *   - a hash of the wrapped room key
 *   - the signer's device_id (= whoever wrote the row)
 */

import { CryptoError, type Bytes } from './types';
import {
  concatBytes,
  fromHex,
  getSodium,
  stringToBytes,
} from './sodium';
import { signMessage, verifyMessageOrThrow } from './identity';

const INVITE_DOMAIN = stringToBytes('vibecheck:invite:v2');
const MEMBER_DOMAIN = stringToBytes('vibecheck:member:v2');

async function uuidBytes(id: string): Promise<Bytes> {
  return fromHex(id.replaceAll('-', ''));
}

function u32BE(n: number): Bytes {
  const buf = new Uint8Array(4);
  new DataView(buf.buffer).setUint32(0, n, false);
  return buf;
}

function u64BE(n: number): Bytes {
  const buf = new Uint8Array(8);
  new DataView(buf.buffer).setBigUint64(0, BigInt.asUintN(64, BigInt(Math.trunc(n))), false);
  return buf;
}

async function sha256(bytes: Bytes): Promise<Bytes> {
  const sodium = await getSodium();
  return sodium.crypto_hash_sha256(bytes);
}

/** Fields bound by an invite envelope signature (v2). */
export interface InviteEnvelopeFields {
  roomId: string;
  generation: number;
  invitedUserId: string;
  invitedDeviceId: string;
  invitedDeviceEd25519PublicKey: Bytes;
  invitedDeviceX25519PublicKey: Bytes;
  wrappedRoomKey: Bytes;
  inviterUserId: string;
  inviterDeviceId: string;
  expiresAtMs: number;
}

async function canonicalInviteMessage(f: InviteEnvelopeFields): Promise<Bytes> {
  return concatBytes(
    INVITE_DOMAIN,
    await uuidBytes(f.roomId),
    u32BE(f.generation),
    await uuidBytes(f.invitedUserId),
    await uuidBytes(f.invitedDeviceId),
    f.invitedDeviceEd25519PublicKey,
    f.invitedDeviceX25519PublicKey,
    await sha256(f.wrappedRoomKey),
    await uuidBytes(f.inviterUserId),
    await uuidBytes(f.inviterDeviceId),
    u64BE(f.expiresAtMs),
  );
}

/** Sign an invite envelope with the inviter device's Ed25519 private key. */
export async function signInviteEnvelope(
  fields: InviteEnvelopeFields,
  inviterDeviceEd25519PrivateKey: Bytes,
): Promise<Bytes> {
  const msg = await canonicalInviteMessage(fields);
  return signMessage(msg, inviterDeviceEd25519PrivateKey);
}

/**
 * Verify an invite envelope against the inviter device's Ed25519 pubkey. The
 * caller is responsible for separately verifying that device's issuance cert
 * against the inviter user's UMK. Throws `SIGNATURE_INVALID` on mismatch.
 */
export async function verifyInviteEnvelope(
  fields: InviteEnvelopeFields,
  signature: Bytes,
  inviterDeviceEd25519PublicKey: Bytes,
): Promise<void> {
  const msg = await canonicalInviteMessage(fields);
  await verifyMessageOrThrow(msg, signature, inviterDeviceEd25519PublicKey);
}

/** Fields bound by a room_members row's wrap signature (v2). */
export interface MembershipWrapFields {
  roomId: string;
  generation: number;
  memberUserId: string;
  memberDeviceId: string;
  wrappedRoomKey: Bytes;
  signerDeviceId: string;
}

async function canonicalMembershipMessage(
  f: MembershipWrapFields,
): Promise<Bytes> {
  return concatBytes(
    MEMBER_DOMAIN,
    await uuidBytes(f.roomId),
    u32BE(f.generation),
    await uuidBytes(f.memberUserId),
    await uuidBytes(f.memberDeviceId),
    await sha256(f.wrappedRoomKey),
    await uuidBytes(f.signerDeviceId),
  );
}

/** Sign a room_members wrap row with the signer device's Ed25519 priv. */
export async function signMembershipWrap(
  fields: MembershipWrapFields,
  signerDeviceEd25519PrivateKey: Bytes,
): Promise<Bytes> {
  const msg = await canonicalMembershipMessage(fields);
  return signMessage(msg, signerDeviceEd25519PrivateKey);
}

/** Verify a room_members wrap signature. Throws on mismatch. */
export async function verifyMembershipWrap(
  fields: MembershipWrapFields,
  signature: Bytes,
  signerDeviceEd25519PublicKey: Bytes,
): Promise<void> {
  const msg = await canonicalMembershipMessage(fields);
  await verifyMessageOrThrow(msg, signature, signerDeviceEd25519PublicKey);
}

export async function hashWrappedKey(wrappedRoomKey: Bytes): Promise<Bytes> {
  if (!wrappedRoomKey || wrappedRoomKey.byteLength === 0) {
    throw new CryptoError('wrappedRoomKey must not be empty', 'BAD_INPUT');
  }
  return sha256(wrappedRoomKey);
}
