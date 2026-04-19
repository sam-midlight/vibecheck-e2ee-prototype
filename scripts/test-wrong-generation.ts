/**
 * Test 9: Wrong-Generation Key Attempt
 *
 * Alice sends a v3 blob at gen-1. Then the room rotates to gen-2.
 * Alice tries to decrypt the gen-2 blob using her gen-1 room key.
 *
 * Asserts: decryptBlob throws (AEAD authentication failure — wrong key).
 *
 * Run: npx tsx --env-file=.env.local scripts/test-wrong-generation.ts
 */

import {
  generateRoomKey,
  wrapRoomKeyFor,
  signMembershipWrap,
  encryptBlob,
  decryptBlob,
  fromBase64,
  toBase64,
  type EncryptedBlob,
  type RoomKey,
} from '../src/lib/e2ee-core';
import { initCrypto, createTestUser, provisionDevice, cleanupUser, makeServiceClient } from './test-utils';

async function run() {
  await initCrypto();

  const aliceUser = await createTestUser(`test-alice-wg-${Date.now()}@example.com`);
  const userIds   = [aliceUser.userId];
  const svc       = makeServiceClient();

  try {
    const alice = await provisionDevice(aliceUser.supabase, aliceUser.userId);

    // -- Create room at gen-1 --------------------------------------------------
    const { data: room, error: roomErr } = await aliceUser.supabase
      .from('rooms')
      .insert({ kind: 'group', created_by: alice.userId })
      .select('*').single();
    if (roomErr || !room) throw new Error(`createRoom: ${roomErr?.message}`);

    const gen1 = room.current_generation as number;
    const key1: RoomKey = await generateRoomKey(gen1);

    const wrap1 = await wrapRoomKeyFor(key1, alice.bundle.x25519PublicKey);
    const sig1  = await signMembershipWrap(
      { roomId: room.id, generation: gen1, memberUserId: alice.userId,
        memberDeviceId: alice.deviceId, wrappedRoomKey: wrap1.wrapped,
        signerDeviceId: alice.deviceId },
      alice.bundle.ed25519PrivateKey,
    );
    await aliceUser.supabase.from('room_members').insert({
      room_id: room.id, user_id: alice.userId, device_id: alice.deviceId,
      generation: gen1, wrapped_room_key: await toBase64(wrap1.wrapped),
      signer_device_id: alice.deviceId, wrap_signature: await toBase64(sig1),
    });

    // -- Alice sends a message at gen-2 (simulated: create gen-2, skip sharing gen-1 key)
    const gen2 = gen1 + 1;
    const key2: RoomKey = await generateRoomKey(gen2);

    // Rotate the room to gen-2 (no new members — just bump)
    const wrap2 = await wrapRoomKeyFor(key2, alice.bundle.x25519PublicKey);
    const sig2  = await signMembershipWrap(
      { roomId: room.id, generation: gen2, memberUserId: alice.userId,
        memberDeviceId: alice.deviceId, wrappedRoomKey: wrap2.wrapped,
        signerDeviceId: alice.deviceId },
      alice.bundle.ed25519PrivateKey,
    );
    const { error: rotErr } = await aliceUser.supabase.rpc('kick_and_rotate', {
      p_room_id: room.id,
      p_evictee_user_ids: [],
      p_old_gen: gen1,
      p_new_gen: gen2,
      p_wraps: [{
        user_id: alice.userId,
        device_id: alice.deviceId,
        wrapped_room_key: await toBase64(wrap2.wrapped),
        wrap_signature: await toBase64(sig2),
      }],
      p_signer_device_id: alice.deviceId,
      p_name_ciphertext: null,
      p_name_nonce: null,
    });
    if (rotErr) throw new Error(`kick_and_rotate: ${rotErr.message}`);

    // -- Alice sends a gen-2 blob ---------------------------------------------
    const encBlob = await encryptBlob<{ text: string }>({
      payload: { text: 'Gen-2 message' },
      roomId: room.id, roomKey: key2,
      senderUserId: alice.userId, senderDeviceId: alice.deviceId,
      senderDeviceEd25519PrivateKey: alice.bundle.ed25519PrivateKey,
    });
    const { data: blobRow, error: blobErr } = await aliceUser.supabase.from('blobs').insert({
      room_id: room.id, sender_id: alice.userId, sender_device_id: alice.deviceId,
      generation: encBlob.generation, nonce: await toBase64(encBlob.nonce),
      ciphertext: await toBase64(encBlob.ciphertext),
      signature: encBlob.signature.byteLength > 0 ? await toBase64(encBlob.signature) : null,
      session_id: null, message_index: null,
    }).select('*').single();
    if (blobErr || !blobRow) throw new Error(`insertBlob: ${blobErr?.message}`);

    const row = blobRow as {
      nonce: string; ciphertext: string; signature: string | null;
      generation: number; session_id: string | null; message_index: number | null;
    };
    const wireBlob: EncryptedBlob = {
      nonce: await fromBase64(row.nonce),
      ciphertext: await fromBase64(row.ciphertext),
      signature: row.signature ? await fromBase64(row.signature) : new Uint8Array(0),
      generation: row.generation, sessionId: null, messageIndex: null,
    };

    // -- Attempt to decrypt gen-2 blob with gen-1 key — must fail -------------
    try {
      await decryptBlob<{ text: string }>({
        blob: wireBlob, roomId: room.id, roomKey: key1,
        resolveSenderDeviceEd25519Pub: async () => alice.bundle.ed25519PublicKey,
      });
      throw new Error('Vulnerability: Wrong-generation key decrypted — AEAD not enforcing generation binding');
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Vulnerability')) throw err;
      // Any other error = AEAD correctly rejected the wrong-generation key.
    }

    console.log('PASS: Wrong-generation key rejected by AEAD ✓');
  } finally {
    for (const id of userIds) await cleanupUser(id).catch(console.error);
  }
}

run().catch((err) => { console.error('FAIL:', err); process.exit(1); });
