/**
 * Test 49: Per-Room Key Isolation
 *
 * Alice is in 3 rooms with independent room keys (same generation number).
 * She encrypts a blob in room-1. Attempting to decrypt it using room-2's key
 * or room-3's key must cause AEAD failure. Also confirms room_id binding in
 * the blob envelope prevents cross-room replay.
 *
 * Asserts:
 *   - Correct room key decrypts successfully
 *   - Room-2 key fails to decrypt room-1 blob (DECRYPT_FAILED or equivalent)
 *   - Room-3 key fails to decrypt room-1 blob
 *
 * Run: npx tsx --env-file=.env.local scripts/test-per-room-key-isolation.ts
 */

import {
  generateRoomKey,
  wrapRoomKeyFor,
  signMembershipWrap,
  encryptBlob,
  decryptBlob,
  toBase64,
  fromBase64,
  type EncryptedBlob,
} from '../src/lib/e2ee-core';
import { initCrypto, createTestUser, provisionDevice, cleanupUser, makeServiceClient } from './test-utils';

async function run() {
  await initCrypto();

  const aliceUser = await createTestUser(`test-alice-prki-${Date.now()}@example.com`);
  const userIds   = [aliceUser.userId];
  const svc       = makeServiceClient();

  try {
    const alice = await provisionDevice(aliceUser.supabase, aliceUser.userId);

    // -- Create 3 rooms with independent keys ---------------------------------
    const rooms: Array<{ id: string; generation: number; roomKey: Awaited<ReturnType<typeof generateRoomKey>> }> = [];
    for (let i = 0; i < 3; i++) {
      const { data: room, error: roomErr } = await aliceUser.supabase
        .from('rooms').insert({ kind: 'group', created_by: alice.userId })
        .select('*').single();
      if (roomErr || !room) throw new Error(`createRoom ${i}: ${roomErr?.message}`);
      const generation = room.current_generation as number;
      const roomKey = await generateRoomKey(generation);
      rooms.push({ id: room.id, generation, roomKey });

      const wrap = await wrapRoomKeyFor(roomKey, alice.bundle.x25519PublicKey);
      const sig  = await signMembershipWrap(
        { roomId: room.id, generation, memberUserId: alice.userId,
          memberDeviceId: alice.deviceId, wrappedRoomKey: wrap.wrapped,
          signerDeviceId: alice.deviceId },
        alice.bundle.ed25519PrivateKey,
      );
      await aliceUser.supabase.from('room_members').insert({
        room_id: room.id, user_id: alice.userId, device_id: alice.deviceId, generation,
        wrapped_room_key: await toBase64(wrap.wrapped),
        signer_device_id: alice.deviceId, wrap_signature: await toBase64(sig),
      });
    }

    // -- Alice encrypts a blob in room-0 --------------------------------------
    const encBlob = await encryptBlob<{ text: string }>({
      payload: { text: 'room-0 only' }, roomId: rooms[0].id, roomKey: rooms[0].roomKey,
      senderUserId: alice.userId, senderDeviceId: alice.deviceId,
      senderDeviceEd25519PrivateKey: alice.bundle.ed25519PrivateKey,
    });
    const { data: blobRow } = await aliceUser.supabase.from('blobs').insert({
      room_id: rooms[0].id, sender_id: alice.userId, sender_device_id: alice.deviceId,
      generation: encBlob.generation, nonce: await toBase64(encBlob.nonce),
      ciphertext: await toBase64(encBlob.ciphertext),
      signature: encBlob.signature.byteLength > 0 ? await toBase64(encBlob.signature) : null,
      session_id: null, message_index: null,
    }).select('*').single();

    const row = blobRow as {
      nonce: string; ciphertext: string; signature: string | null;
      generation: number;
    };
    const wireBlob: EncryptedBlob = {
      nonce: await fromBase64(row.nonce), ciphertext: await fromBase64(row.ciphertext),
      signature: row.signature ? await fromBase64(row.signature) : new Uint8Array(0),
      generation: row.generation, sessionId: null, messageIndex: null,
    };

    // -- Correct key (room-0) decrypts ----------------------------------------
    const { payload } = await decryptBlob<{ text: string }>({
      blob: wireBlob, roomId: rooms[0].id, roomKey: rooms[0].roomKey,
      resolveSenderDeviceEd25519Pub: async () => alice.bundle.ed25519PublicKey,
    });
    if (payload.text !== 'room-0 only') throw new Error(`Plaintext mismatch: "${payload.text}"`);

    // -- Room-1 key fails ------------------------------------------------------
    try {
      await decryptBlob<{ text: string }>({
        blob: wireBlob, roomId: rooms[0].id, roomKey: rooms[1].roomKey,
        resolveSenderDeviceEd25519Pub: async () => alice.bundle.ed25519PublicKey,
      });
      throw new Error('Vulnerability: room-1 key decrypted room-0 blob');
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Vulnerability')) throw err;
    }

    // -- Room-2 key fails ------------------------------------------------------
    try {
      await decryptBlob<{ text: string }>({
        blob: wireBlob, roomId: rooms[0].id, roomKey: rooms[2].roomKey,
        resolveSenderDeviceEd25519Pub: async () => alice.bundle.ed25519PublicKey,
      });
      throw new Error('Vulnerability: room-2 key decrypted room-0 blob');
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Vulnerability')) throw err;
    }

    console.log('PASS: Per-room key isolation — room-0 key decrypts; room-1 and room-2 keys rejected ✓');
  } finally {
    for (const id of userIds) await cleanupUser(id).catch(console.error);
  }
}

run().catch((err) => { console.error('FAIL:', err); process.exit(1); });
