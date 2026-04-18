/**
 * Typed Supabase queries + realtime subscription helpers.
 *
 * Every key/signature/ciphertext in the DB is URL-safe base64. Helpers here
 * translate at the boundary so callers work in Uint8Array end to end.
 */

import type { RealtimeChannel } from '@supabase/supabase-js';
import { errorMessage } from '@/lib/errors';
import {
  attachmentStorageKey,
  fromBase64,
  toBase64,
  type Bytes,
  type EncryptedBlob,
  type PublicDevice,
  type PublicUserMasterKey,
} from '@/lib/e2ee-core';
import { getSupabase } from './client';

/** Bucket holding encrypted image attachments. Path convention: `{roomId}/{blobId}.bin`. */
const ATTACHMENTS_BUCKET = 'room-attachments';

// ---------------------------------------------------------------------------
// Row shapes (matching supabase/migrations/0001_init.sql)
// ---------------------------------------------------------------------------

export interface IdentityRow {
  user_id: string;
  /** Master Signing Key (MSK) Ed25519 pub. Root of trust / TOFU anchor. */
  ed25519_pub: string;
  /** LEGACY (pre-0015). Null going forward. */
  x25519_pub: string | null;
  /** LEGACY (pre-0015). Null going forward. */
  self_signature: string | null;
  identity_epoch: number;
  created_at: string;
  /** Self-Signing Key pub (0025+). Signs device certs. Cross-signed by MSK. */
  ssk_pub: string | null;
  /** MSK signature over (domain || msk_pub || ssk_pub). */
  ssk_cross_signature: string | null;
  /** User-Signing Key pub (0025+). Signs other users' MSK pubs. Cross-signed by MSK. */
  usk_pub: string | null;
  /** MSK signature over (domain || msk_pub || usk_pub). */
  usk_cross_signature: string | null;
}

export interface DeviceRow {
  id: string;
  user_id: string;
  /** LEGACY pre-0016 plaintext label. Null on new inserts. */
  display_name: string | null;
  /** crypto_box_seal of display_name to the device's own X25519 pub. */
  display_name_ciphertext: string | null;
  device_ed25519_pub: string;
  device_x25519_pub: string;
  issuance_created_at_ms: number;
  issuance_signature: string;
  revoked_at_ms: number | null;
  revocation_signature: string | null;
  /** Sealed backup key for this device, written by the approving device. */
  backup_key_wrap: string | null;
  /** Sealed SSK+USK privs for this device, written by the approving device (0026+). */
  signing_key_wrap: string | null;
  created_at: string;
  last_seen_at: string;
}

export interface KeyBackupRow {
  user_id: string;
  room_id: string;
  generation: number;
  ciphertext: string;
  nonce: string;
  created_at: string;
  /** Megolm session_id (base64). Null for flat-key backup rows. */
  session_id: string | null;
  /** Megolm start_index. Null for flat-key backup rows. */
  start_index: number | null;
}

export interface DeviceLinkHandoffRow {
  link_nonce: string;
  inviting_user_id: string;
  sealed_payload: string;
  expires_at: string;
}

export interface RoomRow {
  id: string;
  kind: 'pair' | 'group';
  parent_room_id: string | null;
  current_generation: number;
  created_by: string;
  created_at: string;
  last_rotated_at: string | null;
  name_ciphertext: string | null;
  name_nonce: string | null;
}

export interface RoomMemberRow {
  room_id: string;
  user_id: string;
  /** The device this wrap is addressed to. */
  device_id: string;
  generation: number;
  wrapped_room_key: string;
  joined_at: string;
  /** The device that wrote this row (signed wrap_signature). Null when signing
   *  device was deleted (ON DELETE SET NULL, migration 0037). */
  signer_device_id: string | null;
  wrap_signature: string;
}

export interface RoomInviteRow {
  id: string;
  room_id: string;
  invited_user_id: string;
  invited_device_id: string;
  invited_x25519_pub: string;
  /** NOT NULL since 0016. */
  invited_ed25519_pub: string;
  generation: number;
  wrapped_room_key: string;
  created_by: string;
  inviter_device_id: string;
  created_at: string;
  expires_at: string | null;
  /** NOT NULL since 0016. */
  expires_at_ms: number;
  /** NOT NULL since 0016. */
  inviter_signature: string;
}

export interface BlobRow {
  id: string;
  room_id: string;
  sender_id: string;
  /** Device that signed the blob (v3 only). */
  sender_device_id: string | null;
  generation: number;
  nonce: string;
  ciphertext: string;
  signature: string | null;
  created_at: string;
  /** v4 (Megolm): base64 session_id. Null for v3/v2/v1 flat-key blobs. */
  session_id: string | null;
  /** v4 (Megolm): message index within the session. Null for v3/v2/v1. */
  message_index: number | null;
}

// ---------------------------------------------------------------------------
// identities
// ---------------------------------------------------------------------------

/** Publish this user's identity keys (upsert). SSK/USK fields are optional for backward compat. */
export async function publishUserMasterKey(
  userId: string,
  umkPub: PublicUserMasterKey,
  crossSigning?: {
    sskPub: Bytes;
    sskCrossSignature: Bytes;
    uskPub: Bytes;
    uskCrossSignature: Bytes;
  },
): Promise<void> {
  const supabase = getSupabase();
  const row: Record<string, unknown> = {
    user_id: userId,
    ed25519_pub: await toBase64(umkPub.ed25519PublicKey),
    x25519_pub: null,
    self_signature: null,
  };
  if (crossSigning) {
    row.ssk_pub = await toBase64(crossSigning.sskPub);
    row.ssk_cross_signature = await toBase64(crossSigning.sskCrossSignature);
    row.usk_pub = await toBase64(crossSigning.uskPub);
    row.usk_cross_signature = await toBase64(crossSigning.uskCrossSignature);
  }
  const { error } = await supabase.from('identities').upsert(row);
  if (error) throw error;
}

/** Published identity keys — MSK pub + optional SSK/USK pubs with cross-sigs. */
export interface PublicIdentityKeys extends PublicUserMasterKey {
  sskPub?: Bytes;
  sskCrossSignature?: Bytes;
  uskPub?: Bytes;
  uskCrossSignature?: Bytes;
}

/** Fetch a user's published identity keys. Returns null if no identity row. */
export async function fetchUserMasterKeyPub(
  userId: string,
): Promise<PublicIdentityKeys | null> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('identities')
    .select('ed25519_pub, ssk_pub, ssk_cross_signature, usk_pub, usk_cross_signature')
    .eq('user_id', userId)
    .maybeSingle<Pick<IdentityRow, 'ed25519_pub' | 'ssk_pub' | 'ssk_cross_signature' | 'usk_pub' | 'usk_cross_signature'>>();
  if (error) throw error;
  if (!data) return null;
  const result: PublicIdentityKeys = {
    ed25519PublicKey: await fromBase64(data.ed25519_pub),
  };
  if (data.ssk_pub) result.sskPub = await fromBase64(data.ssk_pub);
  if (data.ssk_cross_signature) result.sskCrossSignature = await fromBase64(data.ssk_cross_signature);
  if (data.usk_pub) result.uskPub = await fromBase64(data.usk_pub);
  if (data.usk_cross_signature) result.uskCrossSignature = await fromBase64(data.usk_cross_signature);
  return result;
}

// ---------------------------------------------------------------------------
// devices
// ---------------------------------------------------------------------------

/**
 * Register a device row. Callers generate the device id client-side so the
 * issuance cert (which binds device_id) can be signed before the row is
 * inserted. The display name is stored as a sealed-to-self ciphertext
 * when the writer holds the target device's x25519 priv (the owning
 * device's bootstrap path). When the primary (A) signs a cert for a
 * secondary (B) during approval, A cannot seal B's display name — B
 * updates the row itself via `setDeviceDisplayNameCiphertext` after enrollment.
 */
export async function registerDevice(params: {
  userId: string;
  deviceId: string;
  deviceEd25519Pub: Bytes;
  deviceX25519Pub: Bytes;
  issuanceCreatedAtMs: number;
  issuanceSignature: Bytes;
  displayNameCiphertext?: Bytes | null;
}): Promise<string> {
  const supabase = getSupabase();
  const row: Record<string, unknown> = {
    id: params.deviceId,
    user_id: params.userId,
    device_ed25519_pub: await toBase64(params.deviceEd25519Pub),
    device_x25519_pub: await toBase64(params.deviceX25519Pub),
    issuance_created_at_ms: params.issuanceCreatedAtMs,
    issuance_signature: await toBase64(params.issuanceSignature),
    display_name: null,
    display_name_ciphertext: params.displayNameCiphertext
      ? await toBase64(params.displayNameCiphertext)
      : null,
  };
  const { data, error } = await supabase
    .from('devices')
    .insert(row)
    .select('id')
    .single<{ id: string }>();
  if (error) throw error;
  return data.id;
}

/**
 * Update a device row's display-name ciphertext. The owning device calls
 * this after its bundle is enrolled, so other co-devices see only the
 * encrypted label in the DB and only this device can decrypt.
 */
export async function setDeviceDisplayNameCiphertext(params: {
  deviceId: string;
  displayNameCiphertext: Bytes;
}): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase
    .from('devices')
    .update({
      display_name_ciphertext: await toBase64(params.displayNameCiphertext),
      display_name: null,
    })
    .eq('id', params.deviceId);
  if (error) throw error;
}

export async function listDeviceRows(userId: string): Promise<DeviceRow[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('devices')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data ?? []) as DeviceRow[];
}

/** Back-compat shim — older callers used this name + shape. */
export const listDevices = listDeviceRows;

/** Fetch + decode a user's device list into PublicDevice records. */
export async function fetchPublicDevices(userId: string): Promise<PublicDevice[]> {
  const rows = await listDeviceRows(userId);
  return Promise.all(
    rows.map(async (r): Promise<PublicDevice> => ({
      deviceId: r.id,
      userId: r.user_id,
      ed25519PublicKey: await fromBase64(r.device_ed25519_pub),
      x25519PublicKey: await fromBase64(r.device_x25519_pub),
      createdAtMs: r.issuance_created_at_ms,
      issuanceSignature: await fromBase64(r.issuance_signature),
      revocation:
        r.revoked_at_ms != null && r.revocation_signature != null
          ? {
              revokedAtMs: r.revoked_at_ms,
              signature: await fromBase64(r.revocation_signature),
            }
          : null,
    })),
  );
}

/** Write a UMK-signed revocation to an existing device row. */
export async function revokeDevice(params: {
  deviceId: string;
  revokedAtMs: number;
  revocationSignature: Bytes;
}): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase
    .from('devices')
    .update({
      revoked_at_ms: params.revokedAtMs,
      revocation_signature: await toBase64(params.revocationSignature),
    })
    .eq('id', params.deviceId);
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// device_link_handoffs
// ---------------------------------------------------------------------------

export async function postLinkHandoff(params: {
  linkNonce: Bytes;
  invitingUserId: string;
  sealedPayload: Bytes;
  ttlSeconds?: number;
}): Promise<void> {
  const supabase = getSupabase();
  const ttl = params.ttlSeconds ?? 300;
  const row = {
    link_nonce: await toBase64(params.linkNonce),
    inviting_user_id: params.invitingUserId,
    sealed_payload: await toBase64(params.sealedPayload),
    expires_at: new Date(Date.now() + ttl * 1000).toISOString(),
  };
  const { error } = await supabase.from('device_link_handoffs').insert(row);
  if (error) throw error;
}

export async function fetchLinkHandoff(
  linkNonce: Bytes,
): Promise<{ sealedPayload: Bytes; invitingUserId: string } | null> {
  const supabase = getSupabase();
  const nonceB64 = await toBase64(linkNonce);
  const { data, error } = await supabase
    .from('device_link_handoffs')
    .select('*')
    .eq('link_nonce', nonceB64)
    .maybeSingle<DeviceLinkHandoffRow>();
  if (error) throw error;
  if (!data) return null;
  if (new Date(data.expires_at).getTime() < Date.now()) return null;
  return {
    sealedPayload: await fromBase64(data.sealed_payload),
    invitingUserId: data.inviting_user_id,
  };
}

export async function deleteLinkHandoff(linkNonce: Bytes): Promise<void> {
  const supabase = getSupabase();
  const nonceB64 = await toBase64(linkNonce);
  const { error } = await supabase
    .from('device_link_handoffs')
    .delete()
    .eq('link_nonce', nonceB64);
  if (error) throw error;
}

/** Realtime: wait for a handoff row to appear with this link_nonce. */
export function subscribeLinkHandoff(
  linkNonce: Bytes,
  onRow: (row: DeviceLinkHandoffRow) => void,
): () => void {
  const supabase = getSupabase();
  let channel: RealtimeChannel | null = null;
  let cancelled = false;
  toBase64(linkNonce)
    .then((nonceB64) => {
      // If unsubscribe ran before the nonce finished encoding, don't open a channel
      // we'll never tear down.
      if (cancelled) return;
      channel = supabase
        .channel(`handoff:${nonceB64}`)
        .on(
          'postgres_changes',
          {
            event: 'INSERT',
            schema: 'public',
            table: 'device_link_handoffs',
            filter: `link_nonce=eq.${nonceB64}`,
          },
          (payload) => onRow(payload.new as DeviceLinkHandoffRow),
        )
        .subscribe();
    })
    .catch((err) => {
      console.error('subscribeLinkHandoff: failed to encode link nonce', errorMessage(err));
    });
  return () => {
    cancelled = true;
    if (channel) void supabase.removeChannel(channel);
  };
}

// ---------------------------------------------------------------------------
// rooms + room_members + room_invites
// ---------------------------------------------------------------------------

export async function createRoom(params: {
  kind: 'pair' | 'group';
  parentRoomId?: string | null;
  createdBy: string;
  nameCiphertext?: Bytes | null;
  nameNonce?: Bytes | null;
}): Promise<RoomRow> {
  const supabase = getSupabase();
  const row: Record<string, unknown> = {
    kind: params.kind,
    parent_room_id: params.parentRoomId ?? null,
    created_by: params.createdBy,
  };
  if (params.nameCiphertext && params.nameNonce) {
    row.name_ciphertext = await toBase64(params.nameCiphertext);
    row.name_nonce = await toBase64(params.nameNonce);
  }
  const { data, error } = await supabase
    .from('rooms')
    .insert(row)
    .select('*')
    .single<RoomRow>();
  if (error) throw error;
  return data;
}

/** Replace a room's encrypted display name. Pass nulls to clear the name. */
export async function renameRoom(params: {
  roomId: string;
  nameCiphertext: Bytes | null;
  nameNonce: Bytes | null;
}): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase
    .from('rooms')
    .update({
      name_ciphertext:
        params.nameCiphertext ? await toBase64(params.nameCiphertext) : null,
      name_nonce:
        params.nameNonce ? await toBase64(params.nameNonce) : null,
    })
    .eq('id', params.roomId);
  if (error) throw error;
}

export async function addRoomMember(params: {
  roomId: string;
  userId: string;
  deviceId: string;
  generation: number;
  wrappedRoomKey: Bytes;
  signerDeviceId: string;
  wrapSignature: Bytes;
}): Promise<void> {
  const supabase = getSupabase();
  const row = {
    room_id: params.roomId,
    user_id: params.userId,
    device_id: params.deviceId,
    generation: params.generation,
    wrapped_room_key: await toBase64(params.wrappedRoomKey),
    signer_device_id: params.signerDeviceId,
    wrap_signature: await toBase64(params.wrapSignature),
  };
  const { error } = await supabase.from('room_members').insert(row);
  if (error) throw error;
}

export async function listMyRooms(userId: string): Promise<RoomRow[]> {
  const supabase = getSupabase();
  const { data: memberRows, error: memberErr } = await supabase
    .from('room_members')
    .select('room_id')
    .eq('user_id', userId);
  if (memberErr) throw memberErr;
  const roomIds = Array.from(new Set((memberRows ?? []).map((r) => r.room_id)));
  if (roomIds.length === 0) return [];
  const { data, error } = await supabase
    .from('rooms')
    .select('*')
    .in('id', roomIds)
    .order('created_at', { ascending: false });
  if (error) throw error;
  // Hide status-probe rooms (marked by `parent_room_id = id` self-reference)
  // from the user-facing feed. See `findOrCreateTestRoom` in /status for
  // where the marker is set.
  return ((data ?? []) as RoomRow[]).filter((r) => r.parent_room_id !== r.id);
}

export async function listRoomMembers(roomId: string): Promise<RoomMemberRow[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('room_members')
    .select('*')
    .eq('room_id', roomId);
  if (error) throw error;
  return (data ?? []) as RoomMemberRow[];
}

/** Fetch THIS device's wrapped room key for a specific generation. */
export async function getMyWrappedRoomKey(params: {
  roomId: string;
  deviceId: string;
  generation: number;
}): Promise<Bytes | null> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('room_members')
    .select('wrapped_room_key')
    .eq('room_id', params.roomId)
    .eq('device_id', params.deviceId)
    .eq('generation', params.generation)
    .maybeSingle<{ wrapped_room_key: string }>();
  if (error) throw error;
  if (!data) return null;
  return await fromBase64(data.wrapped_room_key);
}

/**
 * Like getMyWrappedRoomKey but also returns the fields needed to verify the
 * wrap_signature before trusting the key material.
 */
export async function getMyRoomKeyRow(params: {
  roomId: string;
  deviceId: string;
  generation: number;
}): Promise<{
  wrapped_room_key: string;
  /** Null when the signing device was deleted (ON DELETE SET NULL). */
  signer_device_id: string | null;
  wrap_signature: string;
  user_id: string;
} | null> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('room_members')
    .select('wrapped_room_key, signer_device_id, wrap_signature, user_id')
    .eq('room_id', params.roomId)
    .eq('device_id', params.deviceId)
    .eq('generation', params.generation)
    .maybeSingle<{
      wrapped_room_key: string;
      signer_device_id: string | null;
      wrap_signature: string;
      user_id: string;
    }>();
  if (error) throw error;
  return data;
}

/**
 * All wrapped room keys THIS DEVICE holds for a room — one per generation.
 * Includes the signer fields needed to verify wrap_signature at load time.
 */
export async function listMyRoomKeyRows(
  roomId: string,
  deviceId: string,
): Promise<Array<{
  generation: number;
  user_id: string;
  wrapped_room_key: string;
  signer_device_id: string;
  wrap_signature: string;
}>> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('room_members')
    .select('generation, user_id, wrapped_room_key, signer_device_id, wrap_signature')
    .eq('room_id', roomId)
    .eq('device_id', deviceId);
  if (error) throw error;
  return (data ?? []) as typeof data extends null ? never[] : NonNullable<typeof data>;
}

/**
 * Fetch the Ed25519 public keys for a set of device IDs in one query.
 * Used to batch-resolve signer pubkeys before verifying wrap_signatures.
 */
export async function fetchDeviceEd25519PubsByIds(
  deviceIds: string[],
): Promise<Map<string, Bytes>> {
  if (deviceIds.length === 0) return new Map();
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('devices')
    .select('id, device_ed25519_pub')
    .in('id', deviceIds);
  if (error) throw error;
  const out = new Map<string, Bytes>();
  await Promise.all(
    (data ?? []).map(async (r: { id: string; device_ed25519_pub: string }) => {
      out.set(r.id, await fromBase64(r.device_ed25519_pub));
    }),
  );
  return out;
}

export async function createInvite(params: {
  roomId: string;
  invitedUserId: string;
  invitedDeviceId: string;
  invitedEd25519Pub: Bytes;
  invitedX25519Pub: Bytes;
  generation: number;
  wrappedRoomKey: Bytes;
  createdBy: string;
  inviterDeviceId: string;
  inviterSignature: Bytes;
  expiresAtMs: number;
}): Promise<string> {
  const supabase = getSupabase();
  const row = {
    room_id: params.roomId,
    invited_user_id: params.invitedUserId,
    invited_device_id: params.invitedDeviceId,
    invited_x25519_pub: await toBase64(params.invitedX25519Pub),
    invited_ed25519_pub: await toBase64(params.invitedEd25519Pub),
    generation: params.generation,
    wrapped_room_key: await toBase64(params.wrappedRoomKey),
    created_by: params.createdBy,
    inviter_device_id: params.inviterDeviceId,
    expires_at: new Date(params.expiresAtMs).toISOString(),
    expires_at_ms: params.expiresAtMs,
    inviter_signature: await toBase64(params.inviterSignature),
  };
  const { data, error } = await supabase
    .from('room_invites')
    .insert(row)
    .select('id')
    .single<{ id: string }>();
  if (error) throw error;
  return data.id;
}

export async function listMyInvites(userId: string): Promise<RoomInviteRow[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('room_invites')
    .select('*')
    .eq('invited_user_id', userId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as RoomInviteRow[];
}

export async function deleteInvite(inviteId: string): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase.from('room_invites').delete().eq('id', inviteId);
  if (error) throw error;
}

/**
 * Delete all invite rows for a given user in a given room. Used after
 * accepting a per-device invite: the accepting device claims one row and
 * the sibling rows (addressed to the user's other devices) are now stale.
 */
export async function deleteInvitesForUserInRoom(
  roomId: string,
  userId: string,
): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase
    .from('room_invites')
    .delete()
    .eq('room_id', roomId)
    .eq('invited_user_id', userId);
  if (error) throw error;
}

/** Realtime: new invites addressed to this user. */
export function subscribeInvites(
  userId: string,
  onRow: (row: RoomInviteRow) => void,
  onStatus?: (status: string) => void,
): () => void {
  const supabase = getSupabase();
  const channel = supabase
    .channel(`invites:${userId}`)
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'room_invites',
        filter: `invited_user_id=eq.${userId}`,
      },
      (payload) => onRow(payload.new as RoomInviteRow),
    )
    .subscribe((status) => onStatus?.(status));
  return () => {
    void supabase.removeChannel(channel);
  };
}

/**
 * Delete a room and everything in it. Only the creator can do this
 * (enforced by the `rooms_creator_delete` RLS policy). Child rows in
 * room_members, room_invites, and blobs cascade automatically.
 *
 * Storage objects (encrypted image attachments) are NOT cascaded by the DB
 * — Postgres has no FK into Supabase Storage. We best-effort delete them
 * before dropping the rooms row. Any failure is swallowed; the DB cascade
 * is the authoritative delete.
 */
export async function deleteRoom(roomId: string): Promise<void> {
  const supabase = getSupabase();
  await deleteAttachmentsForRoom(roomId).catch((err) => {
    console.warn('deleteRoom: attachment cleanup failed', errorMessage(err));
  });
  const { error } = await supabase.from('rooms').delete().eq('id', roomId);
  if (error) throw error;
}

export async function bumpRoomGeneration(
  roomId: string,
  newGeneration: number,
): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase
    .from('rooms')
    .update({ current_generation: newGeneration })
    .eq('id', roomId);
  if (error) throw error;
}

/**
 * Atomic kick + rotate. Calls the `kick_and_rotate` SECURITY DEFINER RPC,
 * which:
 *   - authorizes the caller (room creator, or self-leave)
 *   - row-locks `rooms` and rejects if `oldGeneration` doesn't match
 *   - deletes non-self evictees FIRST (closes RLS window)
 *   - inserts all new-generation wraps
 *   - bumps current_generation + updates room name ciphertext
 *   - deletes self last if this was a self-leave
 *
 * Replaces the old client-orchestrated 6-step sequence. Wraps shape is a plain
 * array of `{user_id, wrapped_room_key}`; we base64-encode the wrapped key
 * here so callers keep dealing in `Bytes`.
 */
export async function kickAndRotate(params: {
  roomId: string;
  /** user_ids to evict. Empty array for a pure rotate. */
  evicteeUserIds: string[];
  oldGeneration: number;
  newGeneration: number;
  /** One entry per recipient DEVICE. */
  wraps: Array<{
    userId: string;
    deviceId: string;
    wrappedRoomKey: Bytes;
    wrapSignature: Bytes;
  }>;
  /** The caller's device id (whose Ed25519 key signed each wrap_signature). */
  signerDeviceId: string;
  nameCiphertext: Bytes | null;
  nameNonce: Bytes | null;
}): Promise<void> {
  const supabase = getSupabase();
  const p_wraps = await Promise.all(
    params.wraps.map(async (w) => ({
      user_id: w.userId,
      device_id: w.deviceId,
      wrapped_room_key: await toBase64(w.wrappedRoomKey),
      wrap_signature: await toBase64(w.wrapSignature),
    })),
  );
  const { error } = await supabase.rpc('kick_and_rotate', {
    p_room_id: params.roomId,
    p_evictee_user_ids: params.evicteeUserIds,
    p_old_gen: params.oldGeneration,
    p_new_gen: params.newGeneration,
    p_wraps,
    p_signer_device_id: params.signerDeviceId,
    p_name_ciphertext: params.nameCiphertext ? await toBase64(params.nameCiphertext) : null,
    p_name_nonce: params.nameNonce ? await toBase64(params.nameNonce) : null,
  });
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// blobs
// ---------------------------------------------------------------------------

export async function insertBlob(params: {
  roomId: string;
  senderId: string;
  /** Sender device id. New (v3) blobs always carry this; legacy readers tolerate null. */
  senderDeviceId: string;
  blob: EncryptedBlob;
  id?: string;
}): Promise<BlobRow> {
  const supabase = getSupabase();
  const row: Record<string, unknown> = {
    room_id: params.roomId,
    sender_id: params.senderId,
    sender_device_id: params.senderDeviceId,
    generation: params.blob.generation,
    nonce: await toBase64(params.blob.nonce),
    ciphertext: await toBase64(params.blob.ciphertext),
    signature:
      params.blob.signature && params.blob.signature.byteLength > 0
        ? await toBase64(params.blob.signature)
        : null,
    session_id: params.blob.sessionId ?? null,
    message_index: params.blob.messageIndex ?? null,
  };
  if (params.id) row.id = params.id;
  const { data, error } = await supabase
    .from('blobs')
    .insert(row)
    .select('*')
    .single<BlobRow>();
  if (error) throw error;
  return data;
}

/** Delete a blob row. Only the sender can do this (RLS: sender_id = auth.uid()). */
export async function deleteBlob(blobId: string): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase.from('blobs').delete().eq('id', blobId);
  if (error) throw error;
}

export async function listBlobs(
  roomId: string,
  limit = 200,
): Promise<BlobRow[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('blobs')
    .select('*')
    .eq('room_id', roomId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return ((data ?? []) as BlobRow[]).reverse();
}

/** Fetch blobs created at or after `fromCreatedAt` (gte — handles same-ms duplicates safely). */
export async function listBlobsAfter(
  roomId: string,
  fromCreatedAt: string,
): Promise<BlobRow[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('blobs')
    .select('*')
    .eq('room_id', roomId)
    .gte('created_at', fromCreatedAt)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data ?? []) as BlobRow[];
}

/** Fetch blobs created before `beforeCreatedAt`, newest-first, limited to `limit`. Returns oldest → newest. */
export async function listBlobsBefore(
  roomId: string,
  beforeCreatedAt: string,
  limit = 100,
): Promise<BlobRow[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('blobs')
    .select('*')
    .eq('room_id', roomId)
    .lt('created_at', beforeCreatedAt)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return ((data ?? []) as BlobRow[]).reverse();
}

export function subscribeBlobs(
  roomId: string,
  onBlob: (row: BlobRow) => void,
  onStatus?: (status: string) => void,
): () => void {
  const supabase = getSupabase();
  const channel = supabase
    .channel(`blobs:${roomId}`)
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'blobs',
        filter: `room_id=eq.${roomId}`,
      },
      (payload) => onBlob(payload.new as BlobRow),
    )
    .subscribe((status) => onStatus?.(status));
  return () => {
    void supabase.removeChannel(channel);
  };
}

/** Convenience: decode a BlobRow's base64 columns into an EncryptedBlob. */
export async function decodeBlobRow(row: BlobRow): Promise<EncryptedBlob> {
  return {
    nonce: await fromBase64(row.nonce),
    ciphertext: await fromBase64(row.ciphertext),
    signature: row.signature ? await fromBase64(row.signature) : new Uint8Array(0),
    generation: row.generation,
    sessionId: row.session_id ?? null,
    messageIndex: row.message_index ?? null,
  };
}

// ---------------------------------------------------------------------------
// Megolm sessions + shares
// ---------------------------------------------------------------------------

export async function insertMegolmSession(params: {
  roomId: string;
  senderUserId: string;
  senderDeviceId: string;
  sessionId: string;
  generation: number;
}): Promise<void> {
  const supabase = getSupabase();
  // Upsert on (room_id, sender_device_id, generation) so a partial prior run
  // (server row inserted, share distribution threw, local IDB never saved)
  // can be retried without 23505. Resets message_count so the server's 200-cap
  // tracks the fresh session that's actually being distributed.
  const { error } = await supabase.from('megolm_sessions').upsert(
    {
      room_id: params.roomId,
      sender_user_id: params.senderUserId,
      sender_device_id: params.senderDeviceId,
      session_id: params.sessionId,
      generation: params.generation,
      message_count: 0,
    },
    { onConflict: 'room_id,sender_device_id,generation' },
  );
  if (error) throw error;
}

export async function insertMegolmSessionShare(params: {
  sessionId: string;
  recipientDeviceId: string;
  sealedSnapshot: string;
  startIndex: number;
  signerDeviceId: string;
  shareSignature: string;
}): Promise<void> {
  const supabase = getSupabase();
  // Plain INSERT + client-side 23505 swallow. We cannot use any form of
  // `ON CONFLICT` here: Postgres evaluates the table's SELECT policy USING
  // clause against the NEW row whenever ON CONFLICT is present, regardless
  // of whether a conflict actually exists. The SELECT policy restricts
  // visibility to `recipient_device_id` owned by `auth.uid()` — so every
  // cross-user share (i.e. most shares) would fail 42501. On real duplicate
  // key, Postgres returns 23505 which we treat as idempotent success; the
  // earliest snapshot wins, which covers more history than a later one.
  const { error } = await supabase.from('megolm_session_shares').insert({
    session_id: params.sessionId,
    recipient_device_id: params.recipientDeviceId,
    sealed_snapshot: params.sealedSnapshot,
    start_index: params.startIndex,
    signer_device_id: params.signerDeviceId,
    share_signature: params.shareSignature,
  });
  if (error && error.code !== '23505') throw error;
}

export interface MegolmSessionShareRow {
  session_id: string;
  recipient_device_id: string;
  sealed_snapshot: string;
  start_index: number;
  signer_device_id: string;
  share_signature: string;
  created_at: string;
}

/** Fetch a single Megolm session share by session_id + recipient device. */
export async function fetchMegolmShareForSession(params: {
  sessionId: string;
  recipientDeviceId: string;
}): Promise<MegolmSessionShareRow | null> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('megolm_session_shares')
    .select('*')
    .eq('session_id', params.sessionId)
    .eq('recipient_device_id', params.recipientDeviceId)
    .maybeSingle();
  if (error) throw error;
  return (data as MegolmSessionShareRow | null) ?? null;
}

/** Fetch all Megolm session shares addressed to a specific device for a room. */
export async function listMegolmSharesForDevice(params: {
  roomId: string;
  recipientDeviceId: string;
}): Promise<MegolmSessionShareRow[]> {
  const supabase = getSupabase();
  // We need to join through megolm_sessions to filter by room_id,
  // but session_shares doesn't carry room_id directly. Query sessions
  // for this room first, then fetch shares for those session_ids.
  const { data: sessions, error: sessErr } = await supabase
    .from('megolm_sessions')
    .select('session_id')
    .eq('room_id', params.roomId);
  if (sessErr) throw sessErr;
  if (!sessions || sessions.length === 0) return [];
  const sessionIds = sessions.map((s) => s.session_id);
  const { data, error } = await supabase
    .from('megolm_session_shares')
    .select('*')
    .in('session_id', sessionIds)
    .eq('recipient_device_id', params.recipientDeviceId);
  if (error) throw error;
  return (data ?? []) as MegolmSessionShareRow[];
}

// ---------------------------------------------------------------------------
// SAS verification sessions + cross-user signatures
// ---------------------------------------------------------------------------

export interface SasVerificationSessionRow {
  id: string;
  initiator_user_id: string;
  responder_user_id: string;
  initiator_device_id: string;
  responder_device_id: string | null;
  state: 'initiated' | 'key_exchanged' | 'sas_compared' | 'completed' | 'cancelled';
  initiator_commitment: string | null;
  initiator_ephemeral_pub: string | null;
  responder_ephemeral_pub: string | null;
  initiator_mac: string | null;
  responder_mac: string | null;
  created_at: string;
  expires_at: string;
}

export async function createSasSession(params: {
  initiatorUserId: string;
  responderUserId: string;
  initiatorDeviceId: string;
  commitment: string;
}): Promise<SasVerificationSessionRow> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('sas_verification_sessions')
    .insert({
      initiator_user_id: params.initiatorUserId,
      responder_user_id: params.responderUserId,
      initiator_device_id: params.initiatorDeviceId,
      initiator_commitment: params.commitment,
      state: 'initiated',
    })
    .select()
    .single<SasVerificationSessionRow>();
  if (error) throw error;
  return data;
}

export async function updateSasSession(
  id: string,
  updates: Partial<Pick<SasVerificationSessionRow,
    'state' | 'responder_device_id' | 'responder_ephemeral_pub' |
    'initiator_ephemeral_pub' | 'initiator_mac' | 'responder_mac'
  >>,
): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase
    .from('sas_verification_sessions')
    .update(updates)
    .eq('id', id);
  if (error) throw error;
}

export async function getSasSession(
  id: string,
): Promise<SasVerificationSessionRow | null> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('sas_verification_sessions')
    .select('*')
    .eq('id', id)
    .maybeSingle<SasVerificationSessionRow>();
  if (error) throw error;
  return data;
}

export async function listPendingSasSessions(
  userId: string,
): Promise<SasVerificationSessionRow[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('sas_verification_sessions')
    .select('*')
    .eq('responder_user_id', userId)
    .eq('state', 'initiated')
    .gt('expires_at', new Date().toISOString());
  if (error) throw error;
  return (data ?? []) as SasVerificationSessionRow[];
}

export function subscribeSasSessions(
  userId: string,
  onRow: (row: SasVerificationSessionRow) => void,
): () => void {
  const supabase = getSupabase();
  // Channel name is unique per call. Supabase reuses channels by name, and if
  // two subscribers share a name, the second one's .on() runs after the first
  // has already .subscribe()'d → "cannot add postgres_changes callbacks after
  // subscribe". The rooms page + initiator modal + responder modal all
  // subscribe concurrently, so per-call uniqueness is required.
  const channel = supabase
    .channel(`sas:${userId}:${crypto.randomUUID()}`)
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'sas_verification_sessions',
        filter: `responder_user_id=eq.${userId}`,
      },
      (payload) => onRow(payload.new as SasVerificationSessionRow),
    )
    .on(
      'postgres_changes',
      {
        event: 'UPDATE',
        schema: 'public',
        table: 'sas_verification_sessions',
        filter: `initiator_user_id=eq.${userId}`,
      },
      (payload) => onRow(payload.new as SasVerificationSessionRow),
    )
    .subscribe();
  return () => {
    void supabase.removeChannel(channel);
  };
}

export interface CrossUserSignatureRow {
  signer_user_id: string;
  signed_user_id: string;
  signature: string;
  signed_at: string;
}

export async function insertCrossUserSignature(params: {
  signerUserId: string;
  signedUserId: string;
  signature: string;
}): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase.from('cross_user_signatures').upsert({
    signer_user_id: params.signerUserId,
    signed_user_id: params.signedUserId,
    signature: params.signature,
  });
  if (error) throw error;
}

export async function getCrossUserSignature(
  signerUserId: string,
  signedUserId: string,
): Promise<CrossUserSignatureRow | null> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('cross_user_signatures')
    .select('*')
    .eq('signer_user_id', signerUserId)
    .eq('signed_user_id', signedUserId)
    .maybeSingle<CrossUserSignatureRow>();
  if (error) throw error;
  return data;
}

// ---------------------------------------------------------------------------
// image attachments (Supabase Storage)
//
// Objects are uploaded/downloaded as `nonce || ciphertext` raw bytes, with
// no content-type hint — the server sees opaque bytes. Path convention is
// `{roomId}/{blobId}.bin`; RLS on the bucket gates by the first segment
// (see migration 0006_attachments_bucket.sql).
// ---------------------------------------------------------------------------

/** Upload an attachment's encrypted bytes to Storage. */
export async function uploadAttachment(params: {
  roomId: string;
  blobId: string;
  encryptedBytes: Bytes;
}): Promise<void> {
  const supabase = getSupabase();
  const path = attachmentStorageKey(params.roomId, params.blobId);
  const { error } = await supabase.storage
    .from(ATTACHMENTS_BUCKET)
    .upload(path, params.encryptedBytes, {
      contentType: 'application/octet-stream',
      cacheControl: '3600',
      upsert: false,
    });
  if (error) throw error;
}

/** Download an attachment's encrypted bytes. Caller then decrypts via e2ee-core. */
export async function downloadAttachment(params: {
  roomId: string;
  blobId: string;
}): Promise<Bytes> {
  const supabase = getSupabase();
  const path = attachmentStorageKey(params.roomId, params.blobId);
  const { data, error } = await supabase.storage.from(ATTACHMENTS_BUCKET).download(path);
  if (error) throw error;
  return new Uint8Array(await data.arrayBuffer());
}

/** Remove a single attachment (used to roll back a failed send). */
export async function deleteAttachment(params: {
  roomId: string;
  blobId: string;
}): Promise<void> {
  const supabase = getSupabase();
  const path = attachmentStorageKey(params.roomId, params.blobId);
  const { error } = await supabase.storage.from(ATTACHMENTS_BUCKET).remove([path]);
  if (error) throw error;
}

/**
 * Enumerate all attachment object paths under a room (recursive=false since
 * we use a flat single-level prefix `{roomId}/`).
 */
async function listAttachmentsForRoom(roomId: string): Promise<string[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase.storage
    .from(ATTACHMENTS_BUCKET)
    .list(roomId, { limit: 1000 });
  if (error) throw error;
  return (data ?? []).map((entry) => `${roomId}/${entry.name}`);
}

/** Bulk-delete every attachment under a room. Called by `deleteRoom`. */
export async function deleteAttachmentsForRoom(roomId: string): Promise<void> {
  const paths = await listAttachmentsForRoom(roomId);
  if (paths.length === 0) return;
  const supabase = getSupabase();
  const { error } = await supabase.storage.from(ATTACHMENTS_BUCKET).remove(paths);
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// device_approval_requests
//
// Short-lived rows: a new device B creates one with its linking pubkey + a
// hashed short code, an already-signed-in device A sees it via realtime,
// verifies the code, and fulfils it by writing a device_link_handoffs row.
// ---------------------------------------------------------------------------

export interface DeviceApprovalRequestRow {
  id: string;
  user_id: string;
  code_hash: string;
  code_salt: string;
  /** LEGACY pre-0015 — kept for back-compat column shape. */
  linking_pubkey: string | null;
  link_nonce: string;
  /** v3: the new device's own bundle, so primary can sign its cert. */
  device_id: string | null;
  device_ed25519_pub: string | null;
  device_x25519_pub: string | null;
  created_at_ms: number | null;
  identity_epoch: number | null;
  failed_attempts: number;
  created_at: string;
  expires_at: string;
}

export async function createApprovalRequest(params: {
  userId: string;
  /** New device's generated bundle pubkeys + id. */
  deviceId: string;
  deviceEd25519Pub: Bytes;
  deviceX25519Pub: Bytes;
  createdAtMs: number;
  codeHash: string;
  codeSalt: string;
  linkNonce: Bytes;
}): Promise<DeviceApprovalRequestRow> {
  const supabase = getSupabase();
  // Snapshot the current identity_epoch so a master-key rotation mid-flight
  // invalidates this row server-side (verify_approval_code rejects mismatch).
  const { data: idRow, error: idErr } = await supabase
    .from('identities')
    .select('identity_epoch')
    .eq('user_id', params.userId)
    .maybeSingle<{ identity_epoch: number }>();
  if (idErr) throw idErr;
  const row = {
    user_id: params.userId,
    device_id: params.deviceId,
    device_ed25519_pub: await toBase64(params.deviceEd25519Pub),
    device_x25519_pub: await toBase64(params.deviceX25519Pub),
    created_at_ms: params.createdAtMs,
    code_hash: params.codeHash,
    code_salt: params.codeSalt,
    link_nonce: await toBase64(params.linkNonce),
    identity_epoch: idRow?.identity_epoch ?? null,
  };
  const { data, error } = await supabase
    .from('device_approval_requests')
    .insert(row)
    .select()
    .single<DeviceApprovalRequestRow>();
  if (error) throw error;
  return data;
}

export async function listPendingApprovalRequests(
  userId: string,
): Promise<DeviceApprovalRequestRow[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('device_approval_requests')
    .select('*')
    .eq('user_id', userId)
    .gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data ?? [];
}

export async function deleteApprovalRequest(id: string): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase
    .from('device_approval_requests')
    .delete()
    .eq('id', id);
  if (error) throw error;
}

/**
 * Atomically verify a candidate code hash against a pending approval row.
 * Server-side: increments failed_attempts on miss and deletes the row on the
 * 5th miss, so a compromised A-session cannot brute-force the 20-bit code
 * client-side. Returns true on match.
 */
export async function verifyApprovalCode(
  requestId: string,
  candidateHash: string,
): Promise<boolean> {
  const supabase = getSupabase();
  const { data, error } = await supabase.rpc('verify_approval_code', {
    p_request_id: requestId,
    p_candidate_hash: candidateHash,
  });
  if (error) throw error;
  return Boolean(data);
}

/** Realtime: A-side listener for any new approval requests for this user. */
export function subscribeApprovalRequests(
  userId: string,
  onRow: (row: DeviceApprovalRequestRow) => void,
  onStatus?: (status: string) => void,
): () => void {
  const supabase = getSupabase();
  const channel = supabase
    .channel(`approval:${userId}`)
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'device_approval_requests',
        filter: `user_id=eq.${userId}`,
      },
      (payload) => onRow(payload.new as DeviceApprovalRequestRow),
    )
    .subscribe((status) => onStatus?.(status));
  return () => {
    void supabase.removeChannel(channel);
  };
}

// ---------------------------------------------------------------------------
// recovery_blobs
// ---------------------------------------------------------------------------

export interface RecoveryBlobRow {
  user_id: string;
  ciphertext: string;
  nonce: string;
  kdf_salt: string;
  kdf_opslimit: number;
  kdf_memlimit: number;
  created_at: string;
  updated_at: string;
}

export async function putRecoveryBlob(params: {
  userId: string;
  ciphertext: string;
  nonce: string;
  kdf_salt: string;
  kdf_opslimit: number;
  kdf_memlimit: number;
}): Promise<void> {
  const supabase = getSupabase();
  const row = {
    user_id: params.userId,
    ciphertext: params.ciphertext,
    nonce: params.nonce,
    kdf_salt: params.kdf_salt,
    kdf_opslimit: params.kdf_opslimit,
    kdf_memlimit: params.kdf_memlimit,
    updated_at: new Date().toISOString(),
  };
  const { error } = await supabase
    .from('recovery_blobs')
    .upsert(row, { onConflict: 'user_id' });
  if (error) throw error;
}

export async function getRecoveryBlob(userId: string): Promise<RecoveryBlobRow | null> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('recovery_blobs')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle<RecoveryBlobRow>();
  if (error) throw error;
  return data;
}

export async function hasRecoveryBlob(userId: string): Promise<boolean> {
  const supabase = getSupabase();
  const { count, error } = await supabase
    .from('recovery_blobs')
    .select('user_id', { count: 'exact', head: true })
    .eq('user_id', userId);
  if (error) throw error;
  return (count ?? 0) > 0;
}

export async function deleteRecoveryBlob(userId: string): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase
    .from('recovery_blobs')
    .delete()
    .eq('user_id', userId);
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// nuclear reset
// ---------------------------------------------------------------------------

/**
 * Destroy everything linking the current E2EE identity to this user account,
 * so a brand-new identity can take its place.
 *
 * Irreversible. Leaves the `auth.users` row and the `identities` row alone —
 * the caller overwrites `identities` by upserting fresh keys right after.
 * Blobs in rooms we were in stay in the DB as ciphertext nobody on the client
 * can decrypt anymore; they are append-only and there's no policy to delete
 * them, which is the intended trust model.
 */
// ---------------------------------------------------------------------------
// key_backup (server-side room-key backup)
// ---------------------------------------------------------------------------

export async function upsertKeyBackup(params: {
  userId: string;
  roomId: string;
  generation: number;
  ciphertext: Bytes | string;
  nonce: Bytes | string;
  /** Megolm session_id (base64). Null for flat-key backups. */
  sessionId?: string | null;
  /** Megolm start_index. Null for flat-key backups. */
  startIndex?: number | null;
}): Promise<void> {
  const supabase = getSupabase();
  const ct = typeof params.ciphertext === 'string'
    ? params.ciphertext
    : await toBase64(params.ciphertext);
  const nc = typeof params.nonce === 'string'
    ? params.nonce
    : await toBase64(params.nonce);
  const row: Record<string, unknown> = {
    user_id: params.userId,
    room_id: params.roomId,
    generation: params.generation,
    ciphertext: ct,
    nonce: nc,
  };
  if (params.sessionId != null) row.session_id = params.sessionId;
  if (params.startIndex != null) row.start_index = params.startIndex;
  // Matrix-aligned: for Megolm session backups, store the EARLIEST known index
  // (written once at session creation) and never overwrite with a later index.
  // ignoreDuplicates maps to ON CONFLICT DO NOTHING so the initial index-0
  // snapshot is preserved. Flat room-key backups also benefit: the room key is
  // fixed per generation so overwriting is redundant and can only hurt.
  const { error } = await supabase.from('key_backup').upsert(row, { ignoreDuplicates: true });
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// key_forward_requests (migration 0035)
// ---------------------------------------------------------------------------

export interface KeyForwardRequestRow {
  id: string;
  user_id: string;
  requester_device_id: string;
  session_id: string;
  room_id: string;
  created_at: string;
  expires_at: string;
}

/** Post a request asking sibling devices to forward a missing Megolm session. */
export async function insertKeyForwardRequest(params: {
  userId: string;
  requesterDeviceId: string;
  sessionId: string;
  roomId: string;
}): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase.from('key_forward_requests').upsert(
    {
      user_id: params.userId,
      requester_device_id: params.requesterDeviceId,
      session_id: params.sessionId,
      room_id: params.roomId,
    },
    { onConflict: 'requester_device_id,session_id', ignoreDuplicates: true },
  );
  if (error) throw error;
}

/** Fetch all unexpired key forward requests for a user (read by sibling devices). */
export async function listKeyForwardRequestsForUser(
  userId: string,
): Promise<KeyForwardRequestRow[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('key_forward_requests')
    .select('*')
    .eq('user_id', userId)
    .gt('expires_at', new Date().toISOString());
  if (error) throw error;
  return (data ?? []) as KeyForwardRequestRow[];
}

/** Fetch unexpired key forward requests posted BY this device (to check if they've been answered). */
export async function listMyPendingKeyForwardRequests(
  deviceId: string,
): Promise<KeyForwardRequestRow[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('key_forward_requests')
    .select('*')
    .eq('requester_device_id', deviceId)
    .gt('expires_at', new Date().toISOString());
  if (error) throw error;
  return (data ?? []) as KeyForwardRequestRow[];
}

/** Delete a fulfilled key forward request. */
export async function deleteKeyForwardRequest(id: string): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase.from('key_forward_requests').delete().eq('id', id);
  if (error) throw error;
}

/** Realtime: notify this device when new key forward requests arrive for its user. */
export function subscribeKeyForwardRequests(
  userId: string,
  onRow: (row: KeyForwardRequestRow) => void,
): () => void {
  const supabase = getSupabase();
  const channel = supabase
    .channel(`key-fwd-req:${userId}`)
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'key_forward_requests', filter: `user_id=eq.${userId}` },
      (payload) => onRow(payload.new as KeyForwardRequestRow),
    )
    .subscribe();
  return () => { void supabase.removeChannel(channel); };
}

// ---------------------------------------------------------------------------
// megolm_sessions — metadata lookup for key forwarding
// ---------------------------------------------------------------------------

export interface MegolmSessionInfoRow {
  session_id: string;
  room_id: string;
  sender_user_id: string;
  sender_device_id: string;
  generation: number;
}

/** Fetch session metadata needed to forward a session (room_id, sender_device_id). */
export async function fetchMegolmSessionInfo(
  sessionId: string,
): Promise<MegolmSessionInfoRow | null> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('megolm_sessions')
    .select('session_id, room_id, sender_user_id, sender_device_id, generation')
    .eq('session_id', sessionId)
    .maybeSingle<MegolmSessionInfoRow>();
  if (error) throw error;
  return data;
}

/**
 * Fallback for sessions predating migration 0027: derive sender_device_id and
 * generation from a blob row that used this session_id. The blob row always has
 * these fields; megolm_sessions may not exist for old sessions.
 */
export async function fetchSessionInfoFromBlobs(
  sessionId: string,
): Promise<Pick<MegolmSessionInfoRow, 'sender_device_id' | 'generation'> | null> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('blobs')
    .select('sender_device_id, generation')
    .eq('session_id', sessionId)
    .not('sender_device_id', 'is', null)
    .limit(1)
    .maybeSingle<{ sender_device_id: string; generation: number }>();
  if (error) throw error;
  return data;
}

/** Realtime: notify this device when a new megolm_session_share addressed to it arrives. */
export function subscribeMegolmShares(
  deviceId: string,
  onRow: (row: MegolmSessionShareRow) => void,
): () => void {
  const supabase = getSupabase();
  const channel = supabase
    .channel(`megolm-shares:${deviceId}`)
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'megolm_session_shares', filter: `recipient_device_id=eq.${deviceId}` },
      (payload) => onRow(payload.new as MegolmSessionShareRow),
    )
    .subscribe();
  return () => { void supabase.removeChannel(channel); };
}

export async function listKeyBackups(
  userId: string,
): Promise<KeyBackupRow[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('key_backup')
    .select('*')
    .eq('user_id', userId);
  if (error) throw error;
  return (data ?? []) as KeyBackupRow[];
}

// ---------------------------------------------------------------------------
// calls + call_members + call_key_envelopes (migration 0023)
// ---------------------------------------------------------------------------

export interface CallRow {
  id: string;
  room_id: string;
  initiator_user_id: string;
  initiator_device_id: string;
  started_at: string;
  ended_at: string | null;
  current_generation: number;
}

export interface CallMemberRow {
  call_id: string;
  device_id: string;
  user_id: string;
  joined_at: string;
  left_at: string | null;
  last_seen_at: string;
}

export interface CallKeyEnvelopeRow {
  call_id: string;
  generation: number;
  target_device_id: string;
  sender_device_id: string;
  ciphertext: string;
  signature: string;
  created_at: string;
}

/** Envelope input shape accepted by start_call / rotate_call_key RPCs. */
export interface CallEnvelopeInput {
  targetDeviceId: string;
  targetUserId: string;
  ciphertext: Bytes;
  signature: Bytes;
}

async function encodeEnvelopes(envelopes: CallEnvelopeInput[]): Promise<unknown[]> {
  return Promise.all(
    envelopes.map(async (e) => ({
      target_device_id: e.targetDeviceId,
      target_user_id: e.targetUserId,
      ciphertext: await toBase64(e.ciphertext),
      signature: await toBase64(e.signature),
    })),
  );
}

/**
 * Start a new call. Caller pre-generates the UUID (ideally UUIDv7) and wraps
 * the CallKey for every target device before calling. The RPC inserts the
 * call row, call_members for every envelope target, and all gen=1 envelopes
 * atomically.
 */
export async function startCall(params: {
  callId: string;
  roomId: string;
  signerDeviceId: string;
  envelopes: CallEnvelopeInput[];
}): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase.rpc('start_call', {
    p_call_id: params.callId,
    p_room_id: params.roomId,
    p_signer_device_id: params.signerDeviceId,
    p_envelopes: await encodeEnvelopes(params.envelopes),
  });
  if (error) throw error;
}

/**
 * Announce this device's presence in an existing call. Returns the call's
 * current generation — if no envelope yet exists for this device at that
 * gen, the caller waits for the next rotation to pick them up.
 */
export async function joinCall(params: {
  callId: string;
  deviceId: string;
}): Promise<{ currentGeneration: number }> {
  const supabase = getSupabase();
  const { data, error } = await supabase.rpc('join_call', {
    p_call_id: params.callId,
    p_device_id: params.deviceId,
  });
  if (error) throw error;
  return { currentGeneration: data as number };
}

/** Graceful leave. Does not bump generation — rotator election handles that. */
export async function leaveCall(params: {
  callId: string;
  deviceId: string;
}): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase.rpc('leave_call', {
    p_call_id: params.callId,
    p_device_id: params.deviceId,
  });
  if (error) throw error;
}

/**
 * Rotator-only. Bumps current_generation by 1 and replaces envelopes with
 * fresh wraps of the new CallKey. Concurrent rotators lose on the
 * `p_new_gen = current + 1` check and should re-read state.
 */
export async function rotateCallKey(params: {
  callId: string;
  signerDeviceId: string;
  oldGeneration: number;
  newGeneration: number;
  envelopes: CallEnvelopeInput[];
}): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase.rpc('rotate_call_key', {
    p_call_id: params.callId,
    p_signer_device_id: params.signerDeviceId,
    p_old_gen: params.oldGeneration,
    p_new_gen: params.newGeneration,
    p_envelopes: await encodeEnvelopes(params.envelopes),
  });
  if (error) throw error;
}

/** Keepalive — clients call every ~10s to drive the 30s reconnection grace. */
export async function heartbeatCall(params: {
  callId: string;
  deviceId: string;
}): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase.rpc('heartbeat_call', {
    p_call_id: params.callId,
    p_device_id: params.deviceId,
  });
  if (error) throw error;
}

/** Any active member can end the call. Marks ended_at + all members' left_at. */
export async function endCall(callId: string): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase.rpc('end_call', { p_call_id: callId });
  if (error) throw error;
}

/** Fetch a call row, or null if not found. */
export async function fetchCall(callId: string): Promise<CallRow | null> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('calls')
    .select('*')
    .eq('id', callId)
    .maybeSingle<CallRow>();
  if (error) throw error;
  return data;
}

/** Return the currently-active (ended_at IS NULL) call for a room, if any. */
export async function fetchActiveCallForRoom(roomId: string): Promise<CallRow | null> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('calls')
    .select('*')
    .eq('room_id', roomId)
    .is('ended_at', null)
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle<CallRow>();
  if (error) throw error;
  return data;
}

/** List call_members rows for a call (RLS-limited to room members). */
export async function listCallMembers(callId: string): Promise<CallMemberRow[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('call_members')
    .select('*')
    .eq('call_id', callId);
  if (error) throw error;
  return (data ?? []) as CallMemberRow[];
}

/** Fetch the envelope addressed to a specific device at a specific generation. */
export async function fetchCallKeyEnvelope(params: {
  callId: string;
  generation: number;
  targetDeviceId: string;
}): Promise<CallKeyEnvelopeRow | null> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('call_key_envelopes')
    .select('*')
    .eq('call_id', params.callId)
    .eq('generation', params.generation)
    .eq('target_device_id', params.targetDeviceId)
    .maybeSingle<CallKeyEnvelopeRow>();
  if (error) throw error;
  return data;
}

/**
 * Lightweight broadcast for per-call coordination events (member_joined,
 * member_left). Lives on a realtime broadcast channel — not postgres_changes —
 * because call_members would be far too chatty for the publication
 * (heartbeat UPDATEs every 10s). The DB remains the source of truth;
 * broadcast just wakes existing participants up so they read it.
 */
export type CallSignalingEvent =
  | { type: 'member_joined'; deviceId: string }
  | { type: 'member_left'; deviceId: string };

export function subscribeCallSignaling(
  callId: string,
  onEvent: (ev: CallSignalingEvent) => void,
): () => void {
  const supabase = getSupabase();
  const channel = supabase
    .channel(`call:${callId}`, { config: { broadcast: { self: false } } })
    .on('broadcast', { event: 'member_joined' }, (msg) => {
      const p = msg.payload as { deviceId?: unknown };
      if (typeof p?.deviceId === 'string') {
        onEvent({ type: 'member_joined', deviceId: p.deviceId });
      }
    })
    .on('broadcast', { event: 'member_left' }, (msg) => {
      const p = msg.payload as { deviceId?: unknown };
      if (typeof p?.deviceId === 'string') {
        onEvent({ type: 'member_left', deviceId: p.deviceId });
      }
    })
    .subscribe();
  return () => {
    void supabase.removeChannel(channel);
  };
}

/** Fire-and-forget broadcast a call signaling event. */
export async function broadcastCallSignaling(
  callId: string,
  ev: CallSignalingEvent,
): Promise<void> {
  const supabase = getSupabase();
  const channel = supabase.channel(`call:${callId}`);
  await new Promise<void>((resolve) => {
    channel.subscribe((status) => {
      if (status === 'SUBSCRIBED') resolve();
    });
  });
  await channel.send({
    type: 'broadcast',
    event: ev.type,
    payload: { deviceId: ev.deviceId },
  });
  void supabase.removeChannel(channel);
}

/**
 * Realtime: INSERT/UPDATE on ANY `calls` row the user can SELECT. Supabase
 * realtime honours the table's RLS SELECT policy, so this channel only
 * delivers rows for rooms `auth.uid()` is a member of — we don't have to
 * maintain per-room subscriptions. Used by the IncomingCallToast to pop a
 * notification when a call starts in any room you're in.
 */
export function subscribeAllCalls(
  onChange: (row: CallRow, event: 'INSERT' | 'UPDATE') => void,
  onStatus?: (status: string) => void,
): () => void {
  const supabase = getSupabase();
  const channel = supabase
    .channel('calls:all')
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'calls' },
      (payload) => onChange(payload.new as CallRow, 'INSERT'),
    )
    .on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'calls' },
      (payload) => onChange(payload.new as CallRow, 'UPDATE'),
    )
    .subscribe((status) => onStatus?.(status));
  return () => {
    void supabase.removeChannel(channel);
  };
}

/**
 * Realtime: INSERT/UPDATE on `calls` rows in this room. Subscribers learn
 * about call_started (INSERT), key_rotated (UPDATE current_generation),
 * and call_ended (UPDATE ended_at) through this single channel.
 */
export function subscribeRoomCalls(
  roomId: string,
  onChange: (row: CallRow, event: 'INSERT' | 'UPDATE') => void,
  onStatus?: (status: string) => void,
): () => void {
  const supabase = getSupabase();
  const channel = supabase
    .channel(`calls:${roomId}`)
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'calls',
        filter: `room_id=eq.${roomId}`,
      },
      (payload) => onChange(payload.new as CallRow, 'INSERT'),
    )
    .on(
      'postgres_changes',
      {
        event: 'UPDATE',
        schema: 'public',
        table: 'calls',
        filter: `room_id=eq.${roomId}`,
      },
      (payload) => onChange(payload.new as CallRow, 'UPDATE'),
    )
    .subscribe((status) => onStatus?.(status));
  return () => {
    void supabase.removeChannel(channel);
  };
}

/**
 * Realtime: room metadata changes (generation bumps, renames). Migration
 * 0032 publishes `rooms`; prior to that, clients polled every 10s and
 * missed the window between "User 2 accepts invite" and "User A sends",
 * causing User A to reuse a stale outbound Megolm session that had no
 * share for User 2. `room_members` is deliberately NOT in the realtime
 * publication (0009 dropped it to close a metadata-leak surface), but
 * every membership change goes through `kick_and_rotate` which UPDATEs
 * `rooms.current_generation` in the same transaction — so this single
 * subscription catches them all.
 */
export function subscribeRoomMetadata(
  roomId: string,
  onChange: () => void,
): () => void {
  const supabase = getSupabase();
  const channel = supabase
    .channel(`room-meta:${roomId}:${crypto.randomUUID()}`)
    .on(
      'postgres_changes',
      {
        event: 'UPDATE',
        schema: 'public',
        table: 'rooms',
        filter: `id=eq.${roomId}`,
      },
      () => onChange(),
    )
    .subscribe();
  return () => {
    void supabase.removeChannel(channel);
  };
}

// ---------------------------------------------------------------------------
// ToS acceptances
// ---------------------------------------------------------------------------

export async function hasTosAccepted(userId: string, version: string): Promise<boolean> {
  const supabase = getSupabase();
  const { data } = await supabase
    .from('tos_acceptances')
    .select('version')
    .eq('user_id', userId)
    .maybeSingle<{ version: string }>();
  return data?.version === version;
}

export async function acceptTos(userId: string, version: string): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase
    .from('tos_acceptances')
    .upsert({ user_id: userId, version, accepted_at: new Date().toISOString() });
  if (error) throw error;
}

export async function nukeIdentityServer(userId: string): Promise<void> {
  const supabase = getSupabase();
  // Single SECURITY DEFINER RPC that handles all FK-ordered deletes
  // server-side, bypassing RLS (call tables have no DELETE policies).
  const { error } = await supabase.rpc('nuke_identity', {
    p_user_id: userId,
  });
  if (error) {
    throw new Error(`nuclear reset failed: ${errorMessage(error)}`);
  }
}
