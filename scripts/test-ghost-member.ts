/**
 * Test 3: Ghost Member Injection (Security)
 *
 * Alice creates a room. Alice then calls kick_and_rotate with a malicious
 * `wraps` entry where Bob's user_id is paired with Alice's device_id — a
 * device that does NOT belong to Bob. Migration 0040 added a constraint to
 * the kick_and_rotate RPC that must catch this.
 *
 * Asserts: the RPC call throws a database error. If it succeeds, the test
 * fails with 'Vulnerability: Ghost member injection succeeded'.
 *
 * Run: npx tsx --env-file=.env.local scripts/test-ghost-member.ts
 */

import {
  generateRoomKey,
  wrapRoomKeyFor,
  unwrapRoomKey,
  signMembershipWrap,
  fromBase64,
  toBase64,
} from '../src/lib/e2ee-core';
import { initCrypto, createTestUser, provisionDevice, cleanupUser } from './test-utils';

async function run() {
  await initCrypto();

  const aliceUser = await createTestUser(`test-alice-gm-${Date.now()}@example.com`);
  // Bob only needs a userId in auth.users; no device required for this test.
  const bobUser   = await createTestUser(`test-bob-gm-${Date.now()}@example.com`);
  const userIds   = [aliceUser.userId, bobUser.userId];

  try {
    const alice = await provisionDevice(aliceUser.supabase, aliceUser.userId);

    // -- Alice creates a room and adds herself as the sole member ------------
    const { data: room, error: roomErr } = await aliceUser.supabase
      .from('rooms')
      .insert({ kind: 'group', created_by: alice.userId })
      .select('*')
      .single();
    if (roomErr || !room) throw new Error(`createRoom: ${roomErr?.message}`);

    const generation = room.current_generation as number; // 1
    const roomKey    = await generateRoomKey(generation);

    const aliceWrap = await wrapRoomKeyFor(roomKey, alice.bundle.x25519PublicKey);
    const aliceSig  = await signMembershipWrap(
      { roomId: room.id, generation, memberUserId: alice.userId, memberDeviceId: alice.deviceId,
        wrappedRoomKey: aliceWrap.wrapped, signerDeviceId: alice.deviceId },
      alice.bundle.ed25519PrivateKey,
    );
    const { error: memberErr } = await aliceUser.supabase.from('room_members').insert({
      room_id: room.id,
      user_id: alice.userId,
      device_id: alice.deviceId,
      generation,
      wrapped_room_key: await toBase64(aliceWrap.wrapped),
      signer_device_id: alice.deviceId,
      wrap_signature: await toBase64(aliceSig),
    });
    if (memberErr) throw new Error(`addAliceMember: ${memberErr.message}`);

    // -- Craft the malicious rotation payload --------------------------------
    // Alice signs a wrap for alice.deviceId but claims it belongs to bob.userId.
    // The RPC must reject (device doesn't belong to claimed user).
    const newGen    = generation + 1;
    const newKey    = await generateRoomKey(newGen);

    // Legitimate self-wrap so the rotation has at least one valid entry.
    const selfWrap = await wrapRoomKeyFor(newKey, alice.bundle.x25519PublicKey);
    const selfSig  = await signMembershipWrap(
      { roomId: room.id, generation: newGen, memberUserId: alice.userId,
        memberDeviceId: alice.deviceId, wrappedRoomKey: selfWrap.wrapped,
        signerDeviceId: alice.deviceId },
      alice.bundle.ed25519PrivateKey,
    );

    // Ghost: claim alice.deviceId belongs to bob.userId.
    const ghostWrap = await wrapRoomKeyFor(newKey, alice.bundle.x25519PublicKey);
    const ghostSig  = await signMembershipWrap(
      { roomId: room.id, generation: newGen, memberUserId: bobUser.userId,
        memberDeviceId: alice.deviceId,   // ← alice's device claimed under bob's user
        wrappedRoomKey: ghostWrap.wrapped, signerDeviceId: alice.deviceId },
      alice.bundle.ed25519PrivateKey,
    );

    // -- Attempt the injected kick_and_rotate --------------------------------
    const { error: rpcErr } = await aliceUser.supabase.rpc('kick_and_rotate', {
      p_room_id: room.id,
      p_evictee_user_ids: [],
      p_old_gen: generation,
      p_new_gen: newGen,
      p_wraps: [
        { user_id: alice.userId, device_id: alice.deviceId,
          wrapped_room_key: await toBase64(selfWrap.wrapped),
          wrap_signature: await toBase64(selfSig) },
        { user_id: bobUser.userId, device_id: alice.deviceId, // ghost entry
          wrapped_room_key: await toBase64(ghostWrap.wrapped),
          wrap_signature: await toBase64(ghostSig) },
      ],
      p_signer_device_id: alice.deviceId,
      p_name_ciphertext: null,
      p_name_nonce: null,
    });

    if (!rpcErr) {
      throw new Error('Vulnerability: Ghost member injection succeeded — constraint missing');
    }

    // RPC correctly rejected the injection.
    console.log(`PASS: Ghost member injection blocked by DB (${rpcErr.message}) ✓`);
  } finally {
    for (const id of userIds) await cleanupUser(id).catch(console.error);
  }
}

run().catch((err) => { console.error('FAIL:', err); process.exit(1); });
