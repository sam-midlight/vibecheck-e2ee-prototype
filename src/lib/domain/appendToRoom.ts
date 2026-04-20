/**
 * One-off "send an encrypted event to a room I'm not currently inside."
 *
 * Used by the /rooms list page (and any other context outside RoomProvider)
 * to perform lightweight actions like renaming a room or emitting a status
 * event without mounting the full room context. Per-device crypto:
 *   fetch my device's wrap → unwrap → encrypt payload signed by my device →
 *   insert blob with sender_device_id
 *
 * Not optimistic — caller is expected to refresh their projection (or wait
 * for the realtime listener inside RoomProvider if the target user opens
 * the room later).
 */

import { encryptBlob, encryptRoomName, unwrapRoomKey } from '@/lib/e2ee-core';
import type { EnrolledDevice } from '@/lib/bootstrap';
import type { RoomEvent } from '@/lib/domain/events';
import {
  getMyWrappedRoomKey,
  insertBlob,
  updateRoomName,
} from '@/lib/supabase/queries';

export async function appendEventToRoom(params: {
  roomId: string;
  generation: number;
  userId: string;
  device: EnrolledDevice;
  event: RoomEvent;
}): Promise<void> {
  const { roomId, generation, userId, device, event } = params;
  const { deviceBundle } = device;

  const wrapped = await getMyWrappedRoomKey({
    roomId,
    deviceId: deviceBundle.deviceId,
    generation,
  });
  if (!wrapped) {
    throw new Error('this device is not a current-generation member of this room');
  }

  const roomKey = await unwrapRoomKey(
    { wrapped, generation },
    deviceBundle.x25519PublicKey,
    deviceBundle.x25519PrivateKey,
  );

  const blob = await encryptBlob({
    payload: event,
    roomId,
    roomKey,
    senderUserId: userId,
    senderDeviceId: deviceBundle.deviceId,
    senderDeviceEd25519PrivateKey: deviceBundle.ed25519PrivateKey,
  });

  await insertBlob({
    roomId,
    senderId: userId,
    senderDeviceId: deviceBundle.deviceId,
    blob,
  });
}

/**
 * Rename a room from outside its RoomProvider (e.g., the /rooms list).
 * Writes both the encrypted `name_ciphertext`/`name_nonce` columns (fast
 * read path) and a `room_rename` blob event (back-compat with older
 * clients / legacy rooms). Empty name clears both.
 */
export async function renameRoom(params: {
  roomId: string;
  generation: number;
  userId: string;
  device: EnrolledDevice;
  name: string;
}): Promise<void> {
  const { roomId, generation, userId, device, name } = params;
  const { deviceBundle } = device;
  const trimmed = name.trim();

  const wrapped = await getMyWrappedRoomKey({
    roomId,
    deviceId: deviceBundle.deviceId,
    generation,
  });
  if (!wrapped) {
    throw new Error('this device is not a current-generation member of this room');
  }
  const roomKey = await unwrapRoomKey(
    { wrapped, generation },
    deviceBundle.x25519PublicKey,
    deviceBundle.x25519PrivateKey,
  );

  try {
    if (trimmed.length > 0) {
      const { ciphertext, nonce } = await encryptRoomName({
        name: trimmed,
        roomId,
        roomKey,
      });
      await updateRoomName({
        roomId,
        nameCiphertext: ciphertext,
        nameNonce: nonce,
      });
    } else {
      await updateRoomName({ roomId, nameCiphertext: null, nameNonce: null });
    }
  } catch (err) {
    console.warn(
      'room-name column update failed; falling back to event-only rename',
      err,
    );
  }

  const blob = await encryptBlob({
    payload: { type: 'room_rename', name: trimmed, ts: Date.now() },
    roomId,
    roomKey,
    senderUserId: userId,
    senderDeviceId: deviceBundle.deviceId,
    senderDeviceEd25519PrivateKey: deviceBundle.ed25519PrivateKey,
  });
  await insertBlob({
    roomId,
    senderId: userId,
    senderDeviceId: deviceBundle.deviceId,
    blob,
  });
}
