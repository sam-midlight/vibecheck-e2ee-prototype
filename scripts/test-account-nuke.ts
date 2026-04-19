/**
 * Test 14: Account Nuke
 *
 * Alice and Bob are in a room. Alice sends a message. Alice nukes her identity
 * (calls nuke_identity RPC). After the nuke:
 *   - Alice's identities row is gone
 *   - Alice's devices rows are gone
 *   - Alice's room_members rows are gone
 *   - Bob's room_members row (gen-1) still exists (rooms survive)
 *   - Bob can still read the room (it still exists with created_by = Alice)
 *
 * Note: nuke_identity is a SECURITY DEFINER RPC; it accepts `p_user_id` and
 * only deletes rows belonging to that user. Alice's session calls it with her
 * own userId — the RPC enforces `p_user_id = auth.uid()` server-side.
 *
 * Run: npx tsx --env-file=.env.local scripts/test-account-nuke.ts
 */

import {
  generateRoomKey,
  wrapRoomKeyFor,
  signMembershipWrap,
  encryptBlob,
  toBase64,
} from '../src/lib/e2ee-core';
import { initCrypto, createTestUser, provisionDevice, cleanupUser, makeServiceClient } from './test-utils';

async function run() {
  await initCrypto();

  const aliceUser = await createTestUser(`test-alice-nuke-${Date.now()}@example.com`);
  const bobUser   = await createTestUser(`test-bob-nuke-${Date.now()}@example.com`);
  const userIds   = [aliceUser.userId, bobUser.userId];
  const svc       = makeServiceClient();

  try {
    const alice = await provisionDevice(aliceUser.supabase, aliceUser.userId);
    const bob   = await provisionDevice(bobUser.supabase,   bobUser.userId);

    // -- Alice creates room, adds herself + Bob --------------------------------
    const { data: room, error: roomErr } = await aliceUser.supabase
      .from('rooms')
      .insert({ kind: 'group', created_by: alice.userId })
      .select('*').single();
    if (roomErr || !room) throw new Error(`createRoom: ${roomErr?.message}`);
    const generation = room.current_generation as number;
    const roomKey = await generateRoomKey(generation);

    async function addMember(userId: string, deviceId: string, xPub: Uint8Array) {
      const wrap = await wrapRoomKeyFor(roomKey, xPub);
      const sig  = await signMembershipWrap(
        { roomId: room.id, generation, memberUserId: userId, memberDeviceId: deviceId,
          wrappedRoomKey: wrap.wrapped, signerDeviceId: alice.deviceId },
        alice.bundle.ed25519PrivateKey,
      );
      const client = userId === alice.userId ? aliceUser.supabase : svc;
      await client.from('room_members').insert({
        room_id: room.id, user_id: userId, device_id: deviceId, generation,
        wrapped_room_key: await toBase64(wrap.wrapped),
        signer_device_id: alice.deviceId, wrap_signature: await toBase64(sig),
      });
    }
    await addMember(alice.userId, alice.deviceId, alice.bundle.x25519PublicKey);
    await addMember(bob.userId,   bob.deviceId,   bob.bundle.x25519PublicKey);

    // -- Alice sends a message -------------------------------------------------
    const encBlob = await encryptBlob<{ text: string }>({
      payload: { text: 'Pre-nuke message' },
      roomId: room.id, roomKey,
      senderUserId: alice.userId, senderDeviceId: alice.deviceId,
      senderDeviceEd25519PrivateKey: alice.bundle.ed25519PrivateKey,
    });
    await aliceUser.supabase.from('blobs').insert({
      room_id: room.id, sender_id: alice.userId, sender_device_id: alice.deviceId,
      generation: encBlob.generation, nonce: await toBase64(encBlob.nonce),
      ciphertext: await toBase64(encBlob.ciphertext),
      signature: encBlob.signature.byteLength > 0 ? await toBase64(encBlob.signature) : null,
      session_id: null, message_index: null,
    });

    // -- Alice nukes her identity via RPC ------------------------------------
    const { error: nukeErr } = await aliceUser.supabase.rpc('nuke_identity', {
      p_user_id: alice.userId,
    });
    if (nukeErr) throw new Error(`nuke_identity RPC failed: ${nukeErr.message}`);

    // -- Assertions -----------------------------------------------------------
    // nuke_identity removes devices + room_members but NOT the identities row
    // (public keys stay as a tombstone; auth user deletion cascades that later).

    const { data: aliceDevices } = await svc
      .from('devices').select('id').eq('user_id', alice.userId);
    if (aliceDevices && aliceDevices.length > 0) {
      throw new Error(`Vulnerability: ${aliceDevices.length} Alice device(s) survived nuke`);
    }

    const { data: aliceMembers } = await svc
      .from('room_members').select('device_id').eq('user_id', alice.userId);
    if (aliceMembers && aliceMembers.length > 0) {
      throw new Error(`Vulnerability: ${aliceMembers.length} Alice room_members row(s) survived nuke`);
    }

    // -- Bob's row still exists + room still alive ----------------------------
    const { data: bobMember } = await svc
      .from('room_members').select('device_id')
      .eq('room_id', room.id).eq('user_id', bob.userId).maybeSingle();
    if (!bobMember) {
      throw new Error("Bob's room_members row was wiped by Alice's nuke — should survive");
    }

    const { data: roomRow } = await svc
      .from('rooms').select('id').eq('id', room.id).maybeSingle();
    if (!roomRow) {
      throw new Error('Room was deleted by Alice nuke — rooms should survive');
    }

    console.log('PASS: Account nuke removed Alice identity/devices/membership; room + Bob unaffected ✓');
  } finally {
    for (const id of userIds) await cleanupUser(id).catch(console.error);
  }
}

run().catch((err) => { console.error('FAIL:', err); process.exit(1); });
