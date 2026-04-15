/**
 * Typed Supabase queries + realtime subscription helpers.
 *
 * Every key/signature/ciphertext in the DB is URL-safe base64. Helpers here
 * translate at the boundary so callers work in Uint8Array end to end.
 */

import type { RealtimeChannel } from '@supabase/supabase-js';
import { errorMessage } from '@/lib/errors';
import {
  fromBase64,
  toBase64,
  type Bytes,
  type EncryptedBlob,
  type PublicIdentity,
} from '@/lib/e2ee-core';
import { getSupabase } from './client';

// ---------------------------------------------------------------------------
// Row shapes (matching supabase/migrations/0001_init.sql)
// ---------------------------------------------------------------------------

export interface IdentityRow {
  user_id: string;
  ed25519_pub: string;
  x25519_pub: string;
  self_signature: string;
  created_at: string;
}

export interface DeviceRow {
  id: string;
  user_id: string;
  device_pub: string;
  display_name: string;
  created_at: string;
  last_seen_at: string;
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
  name_ciphertext: string | null;
  name_nonce: string | null;
}

export interface RoomMemberRow {
  room_id: string;
  user_id: string;
  generation: number;
  wrapped_room_key: string;
  joined_at: string;
}

export interface RoomInviteRow {
  id: string;
  room_id: string;
  invited_user_id: string;
  invited_x25519_pub: string;
  generation: number;
  wrapped_room_key: string;
  created_by: string;
  created_at: string;
  expires_at: string | null;
}

export interface BlobRow {
  id: string;
  room_id: string;
  sender_id: string;
  generation: number;
  nonce: string;
  ciphertext: string;
  signature: string;
  created_at: string;
}

// ---------------------------------------------------------------------------
// identities
// ---------------------------------------------------------------------------

/** Publish this user's own identity (upsert). */
export async function publishIdentity(
  userId: string,
  pub: PublicIdentity,
): Promise<void> {
  const supabase = getSupabase();
  const row = {
    user_id: userId,
    ed25519_pub: await toBase64(pub.ed25519PublicKey),
    x25519_pub: await toBase64(pub.x25519PublicKey),
    self_signature: await toBase64(pub.selfSignature),
  };
  const { error } = await supabase.from('identities').upsert(row);
  if (error) throw error;
}

/** Fetch a user's published identity. Returns null if not found. */
export async function fetchIdentity(userId: string): Promise<PublicIdentity | null> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('identities')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle<IdentityRow>();
  if (error) throw error;
  if (!data) return null;
  return {
    ed25519PublicKey: await fromBase64(data.ed25519_pub),
    x25519PublicKey: await fromBase64(data.x25519_pub),
    selfSignature: await fromBase64(data.self_signature),
  };
}

// ---------------------------------------------------------------------------
// devices
// ---------------------------------------------------------------------------

export async function registerDevice(params: {
  userId: string;
  devicePublicKey: Bytes;
  displayName: string;
}): Promise<string> {
  const supabase = getSupabase();
  const row = {
    user_id: params.userId,
    device_pub: await toBase64(params.devicePublicKey),
    display_name: params.displayName,
  };
  const { data, error } = await supabase
    .from('devices')
    .insert(row)
    .select('id')
    .single<{ id: string }>();
  if (error) throw error;
  return data.id;
}

export async function listDevices(userId: string): Promise<DeviceRow[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('devices')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data ?? []) as DeviceRow[];
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
  generation: number;
  wrappedRoomKey: Bytes;
}): Promise<void> {
  const supabase = getSupabase();
  const row = {
    room_id: params.roomId,
    user_id: params.userId,
    generation: params.generation,
    wrapped_room_key: await toBase64(params.wrappedRoomKey),
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
  return (data ?? []) as RoomRow[];
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

export async function getMyWrappedRoomKey(params: {
  roomId: string;
  userId: string;
  generation: number;
}): Promise<Bytes | null> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('room_members')
    .select('wrapped_room_key')
    .eq('room_id', params.roomId)
    .eq('user_id', params.userId)
    .eq('generation', params.generation)
    .maybeSingle<{ wrapped_room_key: string }>();
  if (error) throw error;
  if (!data) return null;
  return await fromBase64(data.wrapped_room_key);
}

export async function createInvite(params: {
  roomId: string;
  invitedUserId: string;
  invitedX25519Pub: Bytes;
  generation: number;
  wrappedRoomKey: Bytes;
  createdBy: string;
  ttlSeconds?: number;
}): Promise<string> {
  const supabase = getSupabase();
  const ttl = params.ttlSeconds ?? 60 * 60 * 24 * 7;
  const row = {
    room_id: params.roomId,
    invited_user_id: params.invitedUserId,
    invited_x25519_pub: await toBase64(params.invitedX25519Pub),
    generation: params.generation,
    wrapped_room_key: await toBase64(params.wrappedRoomKey),
    created_by: params.createdBy,
    expires_at: new Date(Date.now() + ttl * 1000).toISOString(),
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

// ---------------------------------------------------------------------------
// blobs
// ---------------------------------------------------------------------------

export async function insertBlob(params: {
  roomId: string;
  senderId: string;
  blob: EncryptedBlob;
}): Promise<BlobRow> {
  const supabase = getSupabase();
  const row = {
    room_id: params.roomId,
    sender_id: params.senderId,
    generation: params.blob.generation,
    nonce: await toBase64(params.blob.nonce),
    ciphertext: await toBase64(params.blob.ciphertext),
    signature: await toBase64(params.blob.signature),
  };
  const { data, error } = await supabase
    .from('blobs')
    .insert(row)
    .select('*')
    .single<BlobRow>();
  if (error) throw error;
  return data;
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
    signature: await fromBase64(row.signature),
    generation: row.generation,
  };
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
  linking_pubkey: string;
  code_hash: string;
  code_salt: string;
  link_nonce: string;
  created_at: string;
  expires_at: string;
}

export async function createApprovalRequest(params: {
  userId: string;
  linkingPubkey: Bytes;
  codeHash: string;
  codeSalt: string;
  linkNonce: Bytes;
}): Promise<DeviceApprovalRequestRow> {
  const supabase = getSupabase();
  const row = {
    user_id: params.userId,
    linking_pubkey: await toBase64(params.linkingPubkey),
    code_hash: params.codeHash,
    code_salt: params.codeSalt,
    link_nonce: await toBase64(params.linkNonce),
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
export async function nukeIdentityServer(userId: string): Promise<void> {
  const supabase = getSupabase();

  const steps: Array<[label: string, column: string, table: string]> = [
    ['room_members', 'user_id', 'room_members'],
    ['room_invites', 'invited_user_id', 'room_invites'],
    ['device_approval_requests', 'user_id', 'device_approval_requests'],
    ['devices', 'user_id', 'devices'],
    ['recovery_blobs', 'user_id', 'recovery_blobs'],
  ];

  for (const [label, column, table] of steps) {
    const { error } = await supabase.from(table).delete().eq(column, userId);
    if (error) {
      throw new Error(
        `nuclear reset failed at ${label}: ${errorMessage(error)}`,
      );
    }
  }
}
