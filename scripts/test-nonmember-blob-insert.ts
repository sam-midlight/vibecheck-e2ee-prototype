/**
 * Test 25: Non-Member Blob Insert Blocked
 *
 * Bob is authenticated but has no room_members row for Alice's room.
 * Bob attempts to INSERT a blob into that room.
 *
 * Asserts: the insert is rejected by RLS (not a member of the room at
 * any generation → blobs_insert policy rejects).
 *
 * Run: npx tsx --env-file=.env.local scripts/test-nonmember-blob-insert.ts
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

  const aliceUser = await createTestUser(`test-alice-nmbi-${Date.now()}@example.com`);
  const bobUser   = await createTestUser(`test-bob-nmbi-${Date.now()}@example.com`);
  const userIds   = [aliceUser.userId, bobUser.userId];

  try {
    const alice = await provisionDevice(aliceUser.supabase, aliceUser.userId);
    const bob   = await provisionDevice(bobUser.supabase,   bobUser.userId);

    // -- Alice creates room (Bob is NOT added) --------------------------------
    const { data: room, error: roomErr } = await aliceUser.supabase
      .from('rooms').insert({ kind: 'group', created_by: alice.userId })
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

    // -- Bob encrypts something (with his own key — he doesn't have the real one)
    const bobFakeKey = await generateRoomKey(generation);
    const bobBlob = await encryptBlob<{ text: string }>({
      payload: { text: 'Injected message' },
      roomId: room.id, roomKey: bobFakeKey,
      senderUserId: bob.userId, senderDeviceId: bob.deviceId,
      senderDeviceEd25519PrivateKey: bob.bundle.ed25519PrivateKey,
    });

    // -- Bob tries to insert the blob as himself (not a room member) ----------
    const { error: blobErr } = await bobUser.supabase.from('blobs').insert({
      room_id: room.id, sender_id: bob.userId, sender_device_id: bob.deviceId,
      generation: bobBlob.generation, nonce: await toBase64(bobBlob.nonce),
      ciphertext: await toBase64(bobBlob.ciphertext),
      signature: bobBlob.signature.byteLength > 0 ? await toBase64(bobBlob.signature) : null,
      session_id: null, message_index: null,
    });

    if (!blobErr) {
      throw new Error('Vulnerability: Bob inserted a blob into a room he is not a member of');
    }
    // Expected: RLS violation

    console.log('PASS: Non-member blob insert blocked by RLS ✓');
  } finally {
    for (const id of userIds) await cleanupUser(id).catch(console.error);
  }
}

run().catch((err) => { console.error('FAIL:', err); process.exit(1); });
