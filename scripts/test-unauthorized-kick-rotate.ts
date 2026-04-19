/**
 * Test 27: Unauthorized kick_and_rotate Rejected
 *
 * Alice creates a room. Bob is a member. Bob attempts to call kick_and_rotate
 * to evict Alice (or rotate the room himself). The RPC must reject Bob because
 * only the room creator (Alice) is authorized to call it.
 *
 * Asserts: Bob's kick_and_rotate call returns an error.
 *
 * Run: npx tsx --env-file=.env.local scripts/test-unauthorized-kick-rotate.ts
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

  const aliceUser = await createTestUser(`test-alice-ukr-${Date.now()}@example.com`);
  const bobUser   = await createTestUser(`test-bob-ukr-${Date.now()}@example.com`);
  const userIds   = [aliceUser.userId, bobUser.userId];
  const svc       = makeServiceClient();

  try {
    const alice = await provisionDevice(aliceUser.supabase, aliceUser.userId);
    const bob   = await provisionDevice(bobUser.supabase,   bobUser.userId);

    // -- Alice creates room with Alice + Bob ----------------------------------
    const { data: room, error: roomErr } = await aliceUser.supabase
      .from('rooms').insert({ kind: 'group', created_by: alice.userId })
      .select('*').single();
    if (roomErr || !room) throw new Error(`createRoom: ${roomErr?.message}`);
    const gen1 = room.current_generation as number;
    const key1 = await generateRoomKey(gen1);

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

    // -- Bob attempts kick_and_rotate (he is NOT the creator) -----------------
    const gen2 = gen1 + 1;
    const bobKey2 = await generateRoomKey(gen2);

    // Bob builds a self-serving wrap (just for himself)
    const bobWrap = await wrapRoomKeyFor(bobKey2, bob.bundle.x25519PublicKey);
    const bobSig  = await signMembershipWrap(
      { roomId: room.id, generation: gen2, memberUserId: bob.userId, memberDeviceId: bob.deviceId,
        wrappedRoomKey: bobWrap.wrapped, signerDeviceId: bob.deviceId },
      bob.bundle.ed25519PrivateKey,
    );

    const { error: kickErr } = await bobUser.supabase.rpc('kick_and_rotate', {
      p_room_id: room.id,
      p_evictee_user_ids: [alice.userId],
      p_old_gen: gen1, p_new_gen: gen2,
      p_wraps: [{
        user_id: bob.userId, device_id: bob.deviceId,
        wrapped_room_key: await toBase64(bobWrap.wrapped), wrap_signature: await toBase64(bobSig),
      }],
      p_signer_device_id: bob.deviceId,
      p_name_ciphertext: null, p_name_nonce: null,
    });

    if (!kickErr) {
      throw new Error('Vulnerability: Bob (non-creator) successfully called kick_and_rotate — authorization not enforced');
    }
    // Expected: RPC error (only room creator or self-leave is authorized)

    // Verify current_generation is unchanged
    const { data: roomRow } = await svc.from('rooms').select('current_generation').eq('id', room.id).single();
    const currentGen = (roomRow as { current_generation: number }).current_generation;
    if (currentGen !== gen1) {
      throw new Error(`Room generation was bumped by unauthorized caller: expected ${gen1}, got ${currentGen}`);
    }

    console.log('PASS: Unauthorized kick_and_rotate rejected by RPC ✓');
  } finally {
    for (const id of userIds) await cleanupUser(id).catch(console.error);
  }
}

run().catch((err) => { console.error('FAIL:', err); process.exit(1); });
