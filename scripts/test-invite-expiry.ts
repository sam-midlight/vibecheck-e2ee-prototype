/**
 * Test 10: Invite Expiry Enforcement
 *
 * Alice creates a room. Alice creates an invite for Bob's device with
 * expires_at_ms set to 1 ms in the past.
 *
 * Bob tries to insert a room_members row using that expired invite. The
 * RLS policy arm (a) checks `expires_at_ms > now_ms` and should reject it.
 *
 * Asserts: the room_members insert fails (RLS violation).
 *
 * Run: npx tsx --env-file=.env.local scripts/test-invite-expiry.ts
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

  const aliceUser = await createTestUser(`test-alice-ie-${Date.now()}@example.com`);
  const bobUser   = await createTestUser(`test-bob-ie-${Date.now()}@example.com`);
  const userIds   = [aliceUser.userId, bobUser.userId];
  const svc       = makeServiceClient();

  try {
    const alice = await provisionDevice(aliceUser.supabase, aliceUser.userId);
    const bob   = await provisionDevice(bobUser.supabase,   bobUser.userId);

    // -- Alice creates a room and adds herself --------------------------------
    const { data: room, error: roomErr } = await aliceUser.supabase
      .from('rooms')
      .insert({ kind: 'group', created_by: alice.userId })
      .select('*').single();
    if (roomErr || !room) throw new Error(`createRoom: ${roomErr?.message}`);
    const generation = room.current_generation as number;
    const roomKey = await generateRoomKey(generation);

    const aliceWrap = await wrapRoomKeyFor(roomKey, alice.bundle.x25519PublicKey);
    const aliceSig  = await signMembershipWrap(
      { roomId: room.id, generation, memberUserId: alice.userId,
        memberDeviceId: alice.deviceId, wrappedRoomKey: aliceWrap.wrapped,
        signerDeviceId: alice.deviceId },
      alice.bundle.ed25519PrivateKey,
    );
    await aliceUser.supabase.from('room_members').insert({
      room_id: room.id, user_id: alice.userId, device_id: alice.deviceId,
      generation, wrapped_room_key: await toBase64(aliceWrap.wrapped),
      signer_device_id: alice.deviceId, wrap_signature: await toBase64(aliceSig),
    });

    // -- Alice creates an EXPIRED invite for Bob's device ---------------------
    const bobWrap = await wrapRoomKeyFor(roomKey, bob.bundle.x25519PublicKey);
    const expiredAtMs = Date.now() - 60_000; // 1 minute in the past
    const inviteSig = await signInviteEnvelope(
      {
        roomId: room.id, generation,
        invitedUserId: bob.userId, invitedDeviceId: bob.deviceId,
        invitedDeviceEd25519PublicKey: bob.bundle.ed25519PublicKey,
        invitedDeviceX25519PublicKey: bob.bundle.x25519PublicKey,
        wrappedRoomKey: bobWrap.wrapped,
        inviterUserId: alice.userId, inviterDeviceId: alice.deviceId,
        expiresAtMs: expiredAtMs,
      },
      alice.bundle.ed25519PrivateKey,
    );

    // Insert the invite row via service client (bypasses RLS on room_invites insert)
    const { error: inviteErr } = await svc.from('room_invites').insert({
      room_id: room.id, invited_user_id: bob.userId, invited_device_id: bob.deviceId,
      invited_x25519_pub: await toBase64(bob.bundle.x25519PublicKey),
      invited_ed25519_pub: await toBase64(bob.bundle.ed25519PublicKey),
      generation, wrapped_room_key: await toBase64(bobWrap.wrapped),
      created_by: alice.userId,
      inviter_device_id: alice.deviceId,
      inviter_signature: await toBase64(inviteSig),
      expires_at_ms: expiredAtMs,
    });
    if (inviteErr) throw new Error(`insertExpiredInvite: ${inviteErr.message}`);

    // -- Bob tries to accept the expired invite → must fail -------------------
    const memberSig = await signMembershipWrap(
      { roomId: room.id, generation, memberUserId: bob.userId,
        memberDeviceId: bob.deviceId, wrappedRoomKey: bobWrap.wrapped,
        signerDeviceId: alice.deviceId },
      alice.bundle.ed25519PrivateKey,
    );
    const { error: memberErr } = await bobUser.supabase.from('room_members').insert({
      room_id: room.id, user_id: bob.userId, device_id: bob.deviceId,
      generation, wrapped_room_key: await toBase64(bobWrap.wrapped),
      signer_device_id: alice.deviceId, wrap_signature: await toBase64(memberSig),
    });

    if (!memberErr) {
      throw new Error('Vulnerability: Expired invite was accepted — expiry not enforced');
    }
    // Expected: RLS violation (violates row-level security)
    console.log('PASS: Expired invite correctly rejected by RLS ✓');
  } finally {
    for (const id of userIds) await cleanupUser(id).catch(console.error);
  }
}

run().catch((err) => { console.error('FAIL:', err); process.exit(1); });
