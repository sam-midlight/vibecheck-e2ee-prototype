/**
 * Test 54: Concurrent Invite Accept Race
 *
 * Two Bob devices attempt to accept the same room invite simultaneously
 * (Promise.all). The room_members PK (room_id, device_id, generation) means
 * the same device can't insert twice. We use two *different* device IDs for
 * Bob here to test that both can accept the invite (which is tied to Bob's
 * user_id, not a specific device_id in this scenario — the invite targets a
 * specific device_id per the RLS policy). Instead we test the idempotency
 * constraint: two concurrent inserts for the same (room_id, device_id, gen)
 * must produce exactly one success and one constraint error.
 *
 * Asserts:
 *   - 2 concurrent inserts for the same PK: exactly 1 succeeds, 1 fails
 *   - Only 1 row exists in room_members after the race
 *
 * Run: npx tsx --env-file=.env.local scripts/test-concurrent-invite-accept.ts
 */

import {
  generateRoomKey,
  wrapRoomKeyFor,
  signMembershipWrap,
  signInviteEnvelope,
  toBase64,
} from '../src/lib/e2ee-core';
import { initCrypto, createTestUser, provisionDevice, cleanupUser, makeServiceClient } from './test-utils';

async function run() {
  await initCrypto();

  const aliceUser = await createTestUser(`test-alice-cia-${Date.now()}@example.com`);
  const bobUser   = await createTestUser(`test-bob-cia-${Date.now()}@example.com`);
  const userIds   = [aliceUser.userId, bobUser.userId];
  const svc       = makeServiceClient();

  try {
    const alice = await provisionDevice(aliceUser.supabase, aliceUser.userId);
    const bob   = await provisionDevice(bobUser.supabase,   bobUser.userId);

    // -- Alice creates room + membership + invite for Bob --------------------
    const { data: room, error: roomErr } = await aliceUser.supabase
      .from('rooms').insert({ kind: 'group', created_by: alice.userId })
      .select('*').single();
    if (roomErr || !room) throw new Error(`createRoom: ${roomErr?.message}`);
    const generation = room.current_generation as number;
    const roomKey    = await generateRoomKey(generation);

    const aliceWrap = await wrapRoomKeyFor(roomKey, alice.bundle.x25519PublicKey);
    const aliceSig  = await signMembershipWrap(
      { roomId: room.id, generation, memberUserId: alice.userId,
        memberDeviceId: alice.deviceId, wrappedRoomKey: aliceWrap.wrapped,
        signerDeviceId: alice.deviceId },
      alice.bundle.ed25519PrivateKey,
    );
    await aliceUser.supabase.from('room_members').insert({
      room_id: room.id, user_id: alice.userId, device_id: alice.deviceId, generation,
      wrapped_room_key: await toBase64(aliceWrap.wrapped),
      signer_device_id: alice.deviceId, wrap_signature: await toBase64(aliceSig),
    });

    const bobWrap    = await wrapRoomKeyFor(roomKey, bob.bundle.x25519PublicKey);
    const expiresAtMs = Date.now() + 3600_000;
    const inviteSig  = await signInviteEnvelope(
      {
        roomId: room.id, generation,
        invitedUserId: bob.userId, invitedDeviceId: bob.deviceId,
        invitedDeviceEd25519PublicKey: bob.bundle.ed25519PublicKey,
        invitedDeviceX25519PublicKey:  bob.bundle.x25519PublicKey,
        wrappedRoomKey: bobWrap.wrapped,
        inviterUserId: alice.userId, inviterDeviceId: alice.deviceId,
        expiresAtMs,
      },
      alice.bundle.ed25519PrivateKey,
    );
    await aliceUser.supabase.from('room_invites').insert({
      room_id: room.id, invited_user_id: bob.userId, invited_device_id: bob.deviceId,
      invited_x25519_pub:  await toBase64(bob.bundle.x25519PublicKey),
      invited_ed25519_pub: await toBase64(bob.bundle.ed25519PublicKey),
      generation, wrapped_room_key: await toBase64(bobWrap.wrapped),
      created_by: alice.userId, inviter_device_id: alice.deviceId,
      inviter_signature: await toBase64(inviteSig),
      expires_at_ms: expiresAtMs,
    });

    // -- Membership payload for Bob -------------------------------------------
    const memberSig = await signMembershipWrap(
      { roomId: room.id, generation, memberUserId: bob.userId,
        memberDeviceId: bob.deviceId, wrappedRoomKey: bobWrap.wrapped,
        signerDeviceId: alice.deviceId },
      alice.bundle.ed25519PrivateKey,
    );
    const memberPayload = {
      room_id: room.id, user_id: bob.userId, device_id: bob.deviceId, generation,
      wrapped_room_key: await toBase64(bobWrap.wrapped),
      signer_device_id: alice.deviceId, wrap_signature: await toBase64(memberSig),
    };

    // -- Two concurrent inserts of the identical row --------------------------
    const results = await Promise.allSettled([
      bobUser.supabase.from('room_members').insert(memberPayload),
      bobUser.supabase.from('room_members').insert(memberPayload),
    ]);

    const successes = results.filter(
      (r) => r.status === 'fulfilled' && !(r.value as { error: unknown }).error,
    );
    const failures = results.filter(
      (r) => r.status === 'rejected' ||
        (r.status === 'fulfilled' && !!(r.value as { error: unknown }).error),
    );

    if (successes.length !== 1) {
      throw new Error(`Expected exactly 1 insert success, got ${successes.length}`);
    }
    if (failures.length !== 1) {
      throw new Error(`Expected exactly 1 insert failure, got ${failures.length}`);
    }

    // Only 1 row should exist
    const { data: rows } = await svc.from('room_members').select('device_id')
      .eq('room_id', room.id).eq('device_id', bob.deviceId);
    if (!rows || rows.length !== 1) {
      throw new Error(`Expected 1 room_members row for Bob, found ${rows?.length ?? 0}`);
    }

    console.log('PASS: Concurrent invite accept race — exactly 1 of 2 concurrent inserts succeeded; PK constraint enforced ✓');
  } finally {
    for (const id of userIds) await cleanupUser(id).catch(console.error);
  }
}

run().catch((err) => { console.error('FAIL:', err); process.exit(1); });
