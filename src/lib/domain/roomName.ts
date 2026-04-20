/**
 * Resolve a room's custom display name.
 *
 * Two sources, tried in order:
 *   1. The encrypted `name_ciphertext` / `name_nonce` columns on `rooms`.
 *      Cheap — one AEAD decrypt, no event-stream scan. Preferred path for
 *      any room renamed since migration 0006 landed.
 *   2. The `room_rename` event stream (legacy path). Used for rooms that
 *      haven't been renamed since the encrypted-column feature shipped, so
 *      their old event-based names still resolve correctly.
 *
 * Blank / missing name returns null (caller falls back to "Room {id8}").
 */

import {
  decryptBlob,
  decryptRoomName,
  fromBase64,
  unwrapRoomKey,
} from '@/lib/e2ee-core';
import type { EnrolledDevice } from '@/lib/bootstrap';
import {
  decodeBlobRow,
  fetchPublicDevices,
  getMyWrappedRoomKey,
  listBlobs,
  type RoomRow,
} from '@/lib/supabase/queries';
import { getSupabase } from '@/lib/supabase/client';
import { parseRoomEvent } from './events';

export async function resolveRoomName(params: {
  roomId: string;
  userId: string;
  device: EnrolledDevice;
  currentGeneration: number;
}): Promise<string | null> {
  const { roomId, device, currentGeneration } = params;
  const { deviceBundle } = device;

  const wrapped = await getMyWrappedRoomKey({
    roomId,
    deviceId: deviceBundle.deviceId,
    generation: currentGeneration,
  });
  if (!wrapped) return null;

  // Defensive: an unwrap failure here means the wrapped key on the server
  // wasn't sealed for our current X25519 pub key. Not actionable from this
  // path — fall back to "Room {id8}" rendering.
  let roomKey;
  try {
    roomKey = await unwrapRoomKey(
      { wrapped, generation: currentGeneration },
      deviceBundle.x25519PublicKey,
      deviceBundle.x25519PrivateKey,
    );
  } catch {
    return null;
  }

  // Path 1: encrypted column on the rooms row. Fast and preferred.
  try {
    const supabase = getSupabase();
    const { data: roomRow } = await supabase
      .from('rooms')
      .select('name_ciphertext, name_nonce')
      .eq('id', roomId)
      .maybeSingle<Pick<RoomRow, 'name_ciphertext' | 'name_nonce'>>();
    if (roomRow?.name_ciphertext && roomRow.name_nonce) {
      const ct = await fromBase64(roomRow.name_ciphertext);
      const nonce = await fromBase64(roomRow.name_nonce);
      const decrypted = await decryptRoomName({
        ciphertext: ct,
        nonce,
        roomId,
        roomKey,
      });
      if (decrypted && decrypted.trim().length > 0) return decrypted.trim();
    }
  } catch {
    // Column decrypt failed (likely encrypted under an older generation we
    // don't have). Fall through to the event-stream scan.
  }

  // Path 2: legacy event-stream scan. Per-device sender key resolver.
  // We cache (userId, deviceId) → ed pub by fetching the sender's published
  // device list once per sender we encounter.
  const rows = await listBlobs(roomId);
  const devicePubCache = new Map<string, Uint8Array>();
  async function resolveSenderDeviceEd25519Pub(
    senderUserId: string,
    senderDeviceId: string,
  ): Promise<Uint8Array | null> {
    const cacheKey = `${senderUserId}:${senderDeviceId}`;
    const hit = devicePubCache.get(cacheKey);
    if (hit) return hit;
    try {
      const devices = await fetchPublicDevices(senderUserId);
      for (const d of devices) {
        devicePubCache.set(`${senderUserId}:${d.deviceId}`, d.ed25519PublicKey);
      }
      return devicePubCache.get(cacheKey) ?? null;
    } catch {
      return null;
    }
  }

  // Iterate newest to oldest (listBlobs returns ascending).
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (row.generation !== roomKey.generation) continue;
    try {
      const blob = await decodeBlobRow(row);
      const decrypted = await decryptBlob<unknown>({
        blob,
        roomId,
        roomKey,
        resolveSenderDeviceEd25519Pub,
      });
      const event = parseRoomEvent(decrypted.payload);
      if (!event || event.type !== 'room_rename') continue;
      const trimmed = event.name.trim();
      return trimmed.length > 0 ? trimmed : null;
    } catch {
      // Decrypt/verify failure for this blob — skip and keep looking.
    }
  }
  return null;
}
