/**
 * Test 36: Membership Row Replay Attack
 *
 * Alice creates a room at gen-1 and inserts her membership with a valid
 * wrap_signature. We then rotate to gen-2 (Alice evicts herself and re-adds,
 * or more precisely: we kick_and_rotate with no evictees just to bump the
 * generation). Then we attempt to re-insert Alice's gen-1 membership row
 * as if it were gen-2 — the DB unique constraint (room_id, device_id, generation)
 * or RLS must block the replay.
 *
 * Asserts:
 *   - Gen-1 membership insert succeeds
 *   - After rotation to gen-2, replaying the gen-1 row with generation=2 fails
 *     (signature covers the generation; verifyMembershipWrap would catch this,
 *     but we test the DB layer blocks duplicate (room_id, device_id, generation))
 *   - Replaying the exact gen-1 row (same generation=1) fails (duplicate PK)
 *
 * Run: npx tsx --env-file=.env.local scripts/test-membership-row-replay.ts
 */

import {
  generateRoomKey,
  wrapRoomKeyFor,
  signMembershipWrap,
  toBase64,
} from '../src/lib/e2ee-core';
import { initCrypto, createTestUser, provisionDevice, cleanupUser, makeServiceClient } from './test-utils';

async function run() {
  await initCrypto();

  const aliceUser = await createTestUser(`test-alice-mrr-${Date.now()}@example.com`);
  const userIds   = [aliceUser.userId];
  const svc       = makeServiceClient();

  try {
    const alice = await provisionDevice(aliceUser.supabase, aliceUser.userId);

    // -- Gen-1: Alice creates room and inserts membership ----------------------
    const { data: room, error: roomErr } = await aliceUser.supabase
      .from('rooms').insert({ kind: 'group', created_by: alice.userId })
      .select('*').single();
    if (roomErr || !room) throw new Error(`createRoom: ${roomErr?.message}`);
    const gen1 = room.current_generation as number;
    const key1 = await generateRoomKey(gen1);

    const wrap1 = await wrapRoomKeyFor(key1, alice.bundle.x25519PublicKey);
    const sig1  = await signMembershipWrap(
      { roomId: room.id, generation: gen1, memberUserId: alice.userId,
        memberDeviceId: alice.deviceId, wrappedRoomKey: wrap1.wrapped,
        signerDeviceId: alice.deviceId },
      alice.bundle.ed25519PrivateKey,
    );
    const wrappedB64 = await toBase64(wrap1.wrapped);
    const sigB64     = await toBase64(sig1);

    const { error: ins1Err } = await aliceUser.supabase.from('room_members').insert({
      room_id: room.id, user_id: alice.userId, device_id: alice.deviceId, generation: gen1,
      wrapped_room_key: wrappedB64,
      signer_device_id: alice.deviceId, wrap_signature: sigB64,
    });
    if (ins1Err) throw new Error(`gen-1 insert failed: ${ins1Err.message}`);

    // -- Rotate to gen-2 (no evictees — just bump generation) -----------------
    const gen2 = gen1 + 1;
    const key2 = await generateRoomKey(gen2);
    const wrap2 = await wrapRoomKeyFor(key2, alice.bundle.x25519PublicKey);
    const sig2  = await signMembershipWrap(
      { roomId: room.id, generation: gen2, memberUserId: alice.userId,
        memberDeviceId: alice.deviceId, wrappedRoomKey: wrap2.wrapped,
        signerDeviceId: alice.deviceId },
      alice.bundle.ed25519PrivateKey,
    );
    const { error: rotErr } = await aliceUser.supabase.rpc('kick_and_rotate', {
      p_room_id: room.id, p_evictee_user_ids: [],
      p_old_gen: gen1, p_new_gen: gen2,
      p_wraps: [{ user_id: alice.userId, device_id: alice.deviceId,
        wrapped_room_key: await toBase64(wrap2.wrapped), wrap_signature: await toBase64(sig2) }],
      p_signer_device_id: alice.deviceId,
      p_name_ciphertext: null, p_name_nonce: null,
    });
    if (rotErr) throw new Error(`kick_and_rotate: ${rotErr.message}`);

    // -- Replay 1: attempt to insert gen-1 row again (duplicate PK) -----------
    const { error: replayExact } = await svc.from('room_members').insert({
      room_id: room.id, user_id: alice.userId, device_id: alice.deviceId, generation: gen1,
      wrapped_room_key: wrappedB64,
      signer_device_id: alice.deviceId, wrap_signature: sigB64,
    });
    if (!replayExact) {
      throw new Error('Vulnerability: Exact gen-1 row replay succeeded — duplicate PK not enforced');
    }

    // -- Replay 2: take gen-1 sig+wrap, claim generation=2 -------------------
    // The signature is over the gen-1 payload; a verifier would reject it.
    // At the DB layer it should fail because generation=2 row already exists.
    const { error: replayGen2 } = await svc.from('room_members').insert({
      room_id: room.id, user_id: alice.userId, device_id: alice.deviceId, generation: gen2,
      wrapped_room_key: wrappedB64,       // gen-1 wrapped key
      signer_device_id: alice.deviceId, wrap_signature: sigB64,  // gen-1 sig
    });
    if (!replayGen2) {
      throw new Error('Vulnerability: Gen-1 sig replayed as gen-2 row — (room_id,device_id,generation) collision not caught');
    }

    console.log('PASS: Membership row replay — duplicate PK blocked; gen-1 sig cannot be replayed as gen-2 row ✓');
  } finally {
    for (const id of userIds) await cleanupUser(id).catch(console.error);
  }
}

run().catch((err) => { console.error('FAIL:', err); process.exit(1); });
