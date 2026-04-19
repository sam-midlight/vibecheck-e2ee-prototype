/**
 * Test 26: Evicted User Self-Re-Insert Blocked
 *
 * Alice evicts Carol from the room via kick_and_rotate (gen1 → gen2).
 * Carol then attempts to insert her own room_members row at gen2 using her
 * own authenticated client. She has no valid invite and is not a current-gen
 * member, so all three arms of the RLS policy should fail.
 *
 * Asserts: Carol's self-insert attempt is rejected by RLS.
 *
 * Run: npx tsx --env-file=.env.local scripts/test-evicted-reinsert-block.ts
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

  const aliceUser = await createTestUser(`test-alice-erb-${Date.now()}@example.com`);
  const carolUser = await createTestUser(`test-carol-erb-${Date.now()}@example.com`);
  const userIds   = [aliceUser.userId, carolUser.userId];
  const svc       = makeServiceClient();

  try {
    const alice = await provisionDevice(aliceUser.supabase, aliceUser.userId);
    const carol = await provisionDevice(carolUser.supabase, carolUser.userId);

    // -- Gen-1: Alice + Carol -------------------------------------------------
    const { data: room, error: roomErr } = await aliceUser.supabase
      .from('rooms').insert({ kind: 'group', created_by: alice.userId })
      .select('*').single();
    if (roomErr || !room) throw new Error(`createRoom: ${roomErr?.message}`);
    const gen1 = room.current_generation as number;
    const key1 = await generateRoomKey(gen1);

    for (const m of [
      { userId: alice.userId, deviceId: alice.deviceId, xPub: alice.bundle.x25519PublicKey, client: aliceUser.supabase },
      { userId: carol.userId, deviceId: carol.deviceId, xPub: carol.bundle.x25519PublicKey, client: svc },
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

    // -- Gen-2: Alice evicts Carol via kick_and_rotate ------------------------
    const gen2 = gen1 + 1;
    const key2 = await generateRoomKey(gen2);
    const wrap2 = await wrapRoomKeyFor(key2, alice.bundle.x25519PublicKey);
    const sig2  = await signMembershipWrap(
      { roomId: room.id, generation: gen2, memberUserId: alice.userId, memberDeviceId: alice.deviceId,
        wrappedRoomKey: wrap2.wrapped, signerDeviceId: alice.deviceId },
      alice.bundle.ed25519PrivateKey,
    );
    const { error: rotErr } = await aliceUser.supabase.rpc('kick_and_rotate', {
      p_room_id: room.id,
      p_evictee_user_ids: [carol.userId],
      p_old_gen: gen1, p_new_gen: gen2,
      p_wraps: [{
        user_id: alice.userId, device_id: alice.deviceId,
        wrapped_room_key: await toBase64(wrap2.wrapped), wrap_signature: await toBase64(sig2),
      }],
      p_signer_device_id: alice.deviceId,
      p_name_ciphertext: null, p_name_nonce: null,
    });
    if (rotErr) throw new Error(`kick_and_rotate: ${rotErr.message}`);

    // -- Carol tries to self-insert at gen-2 (no invite, not current member) --
    // Carol uses a fake wrapped key (she doesn't have key2 — she was evicted)
    const carolFakeKey = await generateRoomKey(gen2);
    const carolFakeWrap = await wrapRoomKeyFor(carolFakeKey, carol.bundle.x25519PublicKey);
    const carolFakeSig  = await signMembershipWrap(
      { roomId: room.id, generation: gen2, memberUserId: carol.userId, memberDeviceId: carol.deviceId,
        wrappedRoomKey: carolFakeWrap.wrapped, signerDeviceId: carol.deviceId },
      carol.bundle.ed25519PrivateKey,
    );

    const { error: selfInsertErr } = await carolUser.supabase.from('room_members').insert({
      room_id: room.id, user_id: carol.userId, device_id: carol.deviceId, generation: gen2,
      wrapped_room_key: await toBase64(carolFakeWrap.wrapped),
      signer_device_id: carol.deviceId, wrap_signature: await toBase64(carolFakeSig),
    });

    if (!selfInsertErr) {
      throw new Error('Vulnerability: Evicted Carol self-inserted a room_members row at gen-2');
    }
    // Expected: RLS violation (no valid invite, not current-gen member, not creator)

    console.log('PASS: Evicted user self-re-insert correctly blocked by RLS ✓');
  } finally {
    for (const id of userIds) await cleanupUser(id).catch(console.error);
  }
}

run().catch((err) => { console.error('FAIL:', err); process.exit(1); });
