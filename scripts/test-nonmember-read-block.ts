/**
 * Test 11: Non-Member Read Block (RLS)
 *
 * Alice creates a room and sends a message. Carol (a totally separate user)
 * attempts to query the blobs table for that room.
 *
 * Asserts: Carol sees zero rows — RLS blocks her from reading messages in
 * rooms she is not a member of.
 *
 * Run: npx tsx --env-file=.env.local scripts/test-nonmember-read-block.ts
 */

import {
  generateRoomKey,
  wrapRoomKeyFor,
  signMembershipWrap,
  encryptBlob,
  toBase64,
} from '../src/lib/e2ee-core';
import { initCrypto, createTestUser, provisionDevice, cleanupUser } from './test-utils';

async function run() {
  await initCrypto();

  const aliceUser = await createTestUser(`test-alice-nmr-${Date.now()}@example.com`);
  const carolUser = await createTestUser(`test-carol-nmr-${Date.now()}@example.com`);
  const userIds   = [aliceUser.userId, carolUser.userId];

  try {
    const alice = await provisionDevice(aliceUser.supabase, aliceUser.userId);

    // -- Alice creates a room and sends a message ----------------------------
    const { data: room, error: roomErr } = await aliceUser.supabase
      .from('rooms')
      .insert({ kind: 'group', created_by: alice.userId })
      .select('*').single();
    if (roomErr || !room) throw new Error(`createRoom: ${roomErr?.message}`);
    const generation = room.current_generation as number;
    const roomKey = await generateRoomKey(generation);

    const wrap = await wrapRoomKeyFor(roomKey, alice.bundle.x25519PublicKey);
    const sig  = await signMembershipWrap(
      { roomId: room.id, generation, memberUserId: alice.userId,
        memberDeviceId: alice.deviceId, wrappedRoomKey: wrap.wrapped,
        signerDeviceId: alice.deviceId },
      alice.bundle.ed25519PrivateKey,
    );
    await aliceUser.supabase.from('room_members').insert({
      room_id: room.id, user_id: alice.userId, device_id: alice.deviceId,
      generation, wrapped_room_key: await toBase64(wrap.wrapped),
      signer_device_id: alice.deviceId, wrap_signature: await toBase64(sig),
    });

    const encBlob = await encryptBlob<{ text: string }>({
      payload: { text: 'Private message' },
      roomId: room.id, roomKey,
      senderUserId: alice.userId, senderDeviceId: alice.deviceId,
      senderDeviceEd25519PrivateKey: alice.bundle.ed25519PrivateKey,
    });
    const { error: blobErr } = await aliceUser.supabase.from('blobs').insert({
      room_id: room.id, sender_id: alice.userId, sender_device_id: alice.deviceId,
      generation: encBlob.generation, nonce: await toBase64(encBlob.nonce),
      ciphertext: await toBase64(encBlob.ciphertext),
      signature: encBlob.signature.byteLength > 0 ? await toBase64(encBlob.signature) : null,
      session_id: null, message_index: null,
    });
    if (blobErr) throw new Error(`insertBlob: ${blobErr.message}`);

    // -- Carol (non-member) attempts to read blobs in Alice's room ------------
    const { data: carolBlobs, error: carolErr } = await carolUser.supabase
      .from('blobs')
      .select('id')
      .eq('room_id', room.id);
    if (carolErr) throw new Error(`carolQuery: ${carolErr.message}`);

    if (carolBlobs && carolBlobs.length > 0) {
      throw new Error(`Vulnerability: Carol can see ${carolBlobs.length} blob(s) in a room she is not a member of`);
    }

    // -- Carol also attempts to read room_members -----------------------------
    const { data: carolMembers } = await carolUser.supabase
      .from('room_members')
      .select('device_id')
      .eq('room_id', room.id);

    if (carolMembers && carolMembers.length > 0) {
      throw new Error(`Vulnerability: Carol can see ${carolMembers.length} room_members row(s)`);
    }

    console.log('PASS: Non-member Carol blocked from blobs and room_members ✓');
  } finally {
    for (const id of userIds) await cleanupUser(id).catch(console.error);
  }
}

run().catch((err) => { console.error('FAIL:', err); process.exit(1); });
