/**
 * Test 19: Concurrent Rotation Race
 *
 * Alice and Bob both attempt to call kick_and_rotate on the same room at the
 * same time (same old_gen → same new_gen). The DB should reject one of them.
 *
 * How: kick_and_rotate atomically bumps current_generation and inserts
 * room_members rows. The second caller's p_old_gen will no longer match
 * current_generation after the first call commits, causing the RPC to fail
 * with an error (either a constraint violation, stale-generation check, or
 * serialization failure).
 *
 * Asserts:
 *   - Exactly one call succeeds
 *   - The other call returns an error
 *   - current_generation is bumped exactly once (from gen1 to gen2, not gen3)
 *
 * Run: npx tsx --env-file=.env.local scripts/test-concurrent-rotation.ts
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

  const aliceUser = await createTestUser(`test-alice-cr-${Date.now()}@example.com`);
  const bobUser   = await createTestUser(`test-bob-cr-${Date.now()}@example.com`);
  const userIds   = [aliceUser.userId, bobUser.userId];
  const svc       = makeServiceClient();

  try {
    const alice = await provisionDevice(aliceUser.supabase, aliceUser.userId);
    const bob   = await provisionDevice(bobUser.supabase,   bobUser.userId);

    // -- Create room at gen-1 (Alice is creator) --------------------------------
    const { data: room, error: roomErr } = await aliceUser.supabase
      .from('rooms')
      .insert({ kind: 'group', created_by: alice.userId })
      .select('*').single();
    if (roomErr || !room) throw new Error(`createRoom: ${roomErr?.message}`);
    const gen1 = room.current_generation as number;
    const key1 = await generateRoomKey(gen1);

    // Add both members at gen-1
    for (const m of [
      { userId: alice.userId, deviceId: alice.deviceId, xPub: alice.bundle.x25519PublicKey, client: aliceUser.supabase },
      { userId: bob.userId,   deviceId: bob.deviceId,   xPub: bob.bundle.x25519PublicKey,   client: svc },
    ]) {
      const wrap = await wrapRoomKeyFor(key1, m.xPub);
      const sig  = await signMembershipWrap(
        { roomId: room.id, generation: gen1, memberUserId: m.userId, memberDeviceId: m.deviceId,
          wrappedRoomKey: wrap.wrapped, signerDeviceId: alice.deviceId },
        alice.bundle.ed25519PrivateKey,
      );
      await m.client.from('room_members').insert({
        room_id: room.id, user_id: m.userId, device_id: m.deviceId, generation: gen1,
        wrapped_room_key: await toBase64(wrap.wrapped),
        signer_device_id: alice.deviceId, wrap_signature: await toBase64(sig),
      });
    }

    // -- Prepare two concurrent rotation calls (both targeting gen1 → gen2) ---
    const gen2 = gen1 + 1;

    async function buildRotationCall(rotationKey: Awaited<ReturnType<typeof generateRoomKey>>) {
      const wraps = await Promise.all([
        (async () => {
          const wrap = await wrapRoomKeyFor(rotationKey, alice.bundle.x25519PublicKey);
          const sig  = await signMembershipWrap(
            { roomId: room.id, generation: gen2, memberUserId: alice.userId, memberDeviceId: alice.deviceId,
              wrappedRoomKey: wrap.wrapped, signerDeviceId: alice.deviceId },
            alice.bundle.ed25519PrivateKey,
          );
          return { user_id: alice.userId, device_id: alice.deviceId,
            wrapped_room_key: await toBase64(wrap.wrapped), wrap_signature: await toBase64(sig) };
        })(),
        (async () => {
          const wrap = await wrapRoomKeyFor(rotationKey, bob.bundle.x25519PublicKey);
          const sig  = await signMembershipWrap(
            { roomId: room.id, generation: gen2, memberUserId: bob.userId, memberDeviceId: bob.deviceId,
              wrappedRoomKey: wrap.wrapped, signerDeviceId: alice.deviceId },
            alice.bundle.ed25519PrivateKey,
          );
          return { user_id: bob.userId, device_id: bob.deviceId,
            wrapped_room_key: await toBase64(wrap.wrapped), wrap_signature: await toBase64(sig) };
        })(),
      ]);
      return wraps;
    }

    const key2a = await generateRoomKey(gen2);
    const key2b = await generateRoomKey(gen2);
    const wraps2a = await buildRotationCall(key2a);
    const wraps2b = await buildRotationCall(key2b);

    // -- Fire both concurrently -----------------------------------------------
    const [result1, result2] = await Promise.allSettled([
      aliceUser.supabase.rpc('kick_and_rotate', {
        p_room_id: room.id,
        p_evictee_user_ids: [],
        p_old_gen: gen1, p_new_gen: gen2,
        p_wraps: wraps2a,
        p_signer_device_id: alice.deviceId,
        p_name_ciphertext: null, p_name_nonce: null,
      }),
      aliceUser.supabase.rpc('kick_and_rotate', {
        p_room_id: room.id,
        p_evictee_user_ids: [],
        p_old_gen: gen1, p_new_gen: gen2,
        p_wraps: wraps2b,
        p_signer_device_id: alice.deviceId,
        p_name_ciphertext: null, p_name_nonce: null,
      }),
    ]);

    // The Supabase rpc() calls return {data, error} not throw — check .value.error
    const errors = [result1, result2].map((r) => {
      if (r.status === 'rejected') return r.reason;
      return r.value.error ?? null;
    });

    const successCount = errors.filter((e) => !e).length;
    const failCount    = errors.filter((e) => !!e).length;

    if (successCount !== 1 || failCount !== 1) {
      console.error('result1 error:', errors[0]);
      console.error('result2 error:', errors[1]);
      throw new Error(`Expected exactly 1 success and 1 failure, got ${successCount} successes and ${failCount} failures`);
    }

    // current_generation must be exactly gen2 (not gen3)
    const { data: finalRoom } = await svc.from('rooms').select('current_generation').eq('id', room.id).single();
    const finalGen = (finalRoom as { current_generation: number }).current_generation;
    if (finalGen !== gen2) {
      throw new Error(`Expected current_generation=${gen2}, got ${finalGen} — double-rotation may have occurred`);
    }

    console.log('PASS: Concurrent rotation — exactly one call succeeded; current_generation bumped once ✓');
  } finally {
    for (const id of userIds) await cleanupUser(id).catch(console.error);
  }
}

run().catch((err) => { console.error('FAIL:', err); process.exit(1); });
