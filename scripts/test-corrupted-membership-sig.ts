/**
 * Test 35: Corrupted Membership Signature
 *
 * A room_members row is inserted with a valid wrap_signature. We then
 * fetch the row and attempt to verify it client-side with a mutated
 * wrap_signature (one byte flipped). verifyMembershipWrap must throw.
 *
 * Also tests the positive case: the original signature verifies correctly.
 *
 * Asserts:
 *   - Original wrap_signature verifies
 *   - Flipped wrap_signature throws SIGNATURE_INVALID
 *   - A completely wrong signer pubkey causes verification to fail
 *
 * Run: npx tsx --env-file=.env.local scripts/test-corrupted-membership-sig.ts
 */

import {
  generateRoomKey,
  wrapRoomKeyFor,
  signMembershipWrap,
  verifyMembershipWrap,
  generateDeviceKeyBundle,
  fromBase64,
  toBase64,
} from '../src/lib/e2ee-core';
import { initCrypto, createTestUser, provisionDevice, cleanupUser, makeServiceClient } from './test-utils';

async function run() {
  await initCrypto();

  const aliceUser = await createTestUser(`test-alice-cms-${Date.now()}@example.com`);
  const userIds   = [aliceUser.userId];
  const svc       = makeServiceClient();

  try {
    const alice = await provisionDevice(aliceUser.supabase, aliceUser.userId);

    // -- Alice creates room and inserts her membership ------------------------
    const { data: room, error: roomErr } = await aliceUser.supabase
      .from('rooms').insert({ kind: 'group', created_by: alice.userId })
      .select('*').single();
    if (roomErr || !room) throw new Error(`createRoom: ${roomErr?.message}`);
    const generation = room.current_generation as number;
    const roomKey = await generateRoomKey(generation);

    const wrap = await wrapRoomKeyFor(roomKey, alice.bundle.x25519PublicKey);
    const goodSig = await signMembershipWrap(
      { roomId: room.id, generation, memberUserId: alice.userId,
        memberDeviceId: alice.deviceId, wrappedRoomKey: wrap.wrapped,
        signerDeviceId: alice.deviceId },
      alice.bundle.ed25519PrivateKey,
    );
    await aliceUser.supabase.from('room_members').insert({
      room_id: room.id, user_id: alice.userId, device_id: alice.deviceId, generation,
      wrapped_room_key: await toBase64(wrap.wrapped),
      signer_device_id: alice.deviceId, wrap_signature: await toBase64(goodSig),
    });

    // -- Fetch the row and verify the original signature ----------------------
    const { data: memberRow } = await svc.from('room_members').select('*')
      .eq('room_id', room.id).eq('device_id', alice.deviceId).single();
    if (!memberRow) throw new Error('room_members row not found');

    const mr = memberRow as {
      wrapped_room_key: string; wrap_signature: string; signer_device_id: string;
    };

    // Positive case: original sig verifies
    await verifyMembershipWrap(
      { roomId: room.id, generation, memberUserId: alice.userId,
        memberDeviceId: alice.deviceId, wrappedRoomKey: await fromBase64(mr.wrapped_room_key),
        signerDeviceId: mr.signer_device_id },
      await fromBase64(mr.wrap_signature),
      alice.bundle.ed25519PublicKey,
    );

    // -- Flip a byte in the wrap_signature and verify must fail ---------------
    const corruptedSig = await fromBase64(mr.wrap_signature);
    corruptedSig[10] ^= 0xff;

    try {
      await verifyMembershipWrap(
        { roomId: room.id, generation, memberUserId: alice.userId,
          memberDeviceId: alice.deviceId, wrappedRoomKey: await fromBase64(mr.wrapped_room_key),
          signerDeviceId: mr.signer_device_id },
        corruptedSig,
        alice.bundle.ed25519PublicKey,
      );
      throw new Error('Vulnerability: Corrupted wrap_signature passed verifyMembershipWrap');
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Vulnerability')) throw err;
      // Expected: SIGNATURE_INVALID
    }

    // -- Wrong signer pubkey must also fail -----------------------------------
    const impostorBundle = await generateDeviceKeyBundle(crypto.randomUUID());
    try {
      await verifyMembershipWrap(
        { roomId: room.id, generation, memberUserId: alice.userId,
          memberDeviceId: alice.deviceId, wrappedRoomKey: await fromBase64(mr.wrapped_room_key),
          signerDeviceId: mr.signer_device_id },
        await fromBase64(mr.wrap_signature),
        impostorBundle.ed25519PublicKey,
      );
      throw new Error('Vulnerability: Wrong signer pubkey passed verifyMembershipWrap');
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Vulnerability')) throw err;
      // Expected: SIGNATURE_INVALID
    }

    // -- Mutated wrapped_room_key invalidates the signature -------------------
    const mutatedWrap = await fromBase64(mr.wrapped_room_key);
    mutatedWrap[5] ^= 0xff;

    try {
      await verifyMembershipWrap(
        { roomId: room.id, generation, memberUserId: alice.userId,
          memberDeviceId: alice.deviceId, wrappedRoomKey: mutatedWrap,
          signerDeviceId: mr.signer_device_id },
        await fromBase64(mr.wrap_signature),
        alice.bundle.ed25519PublicKey,
      );
      throw new Error('Vulnerability: Mutated wrappedRoomKey passed verifyMembershipWrap — sha256 binding broken');
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Vulnerability')) throw err;
      // Expected: SIGNATURE_INVALID (hash mismatch)
    }

    console.log('PASS: Membership signature — original verifies; corrupted sig / wrong pubkey / mutated key all throw ✓');
  } finally {
    for (const id of userIds) await cleanupUser(id).catch(console.error);
  }
}

run().catch((err) => { console.error('FAIL:', err); process.exit(1); });
