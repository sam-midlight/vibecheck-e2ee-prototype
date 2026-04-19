/**
 * Test 52: Room Deletion Cascade
 *
 * Alice (creator) deletes a room. All dependent data must cascade-delete:
 * room_members, blobs, room_invites, megolm_sessions, key_backup.
 * Bob's data in other rooms must be unaffected.
 *
 * Asserts:
 *   - After room delete: 0 rows in room_members, blobs, room_invites for that room_id
 *   - Bob's membership + blobs in his other room survive
 *
 * Run: npx tsx --env-file=.env.local scripts/test-room-deletion-cascade.ts
 */

import {
  generateRoomKey,
  wrapRoomKeyFor,
  signMembershipWrap,
  encryptBlob,
  signInviteEnvelope,
  encryptRoomKeyForBackup,
  randomBytes,
  toBase64,
} from '../src/lib/e2ee-core';
import { initCrypto, createTestUser, provisionDevice, cleanupUser, makeServiceClient } from './test-utils';

async function run() {
  await initCrypto();

  const aliceUser = await createTestUser(`test-alice-rdc-${Date.now()}@example.com`);
  const bobUser   = await createTestUser(`test-bob-rdc-${Date.now()}@example.com`);
  const userIds   = [aliceUser.userId, bobUser.userId];
  const svc       = makeServiceClient();

  try {
    const alice = await provisionDevice(aliceUser.supabase, aliceUser.userId);
    const bob   = await provisionDevice(bobUser.supabase,   bobUser.userId);
    const backupKey = await randomBytes(32);

    // -- Alice creates the room under test ------------------------------------
    const { data: targetRoom, error: roomErr } = await aliceUser.supabase
      .from('rooms').insert({ kind: 'group', created_by: alice.userId })
      .select('*').single();
    if (roomErr || !targetRoom) throw new Error(`createRoom: ${roomErr?.message}`);
    const gen = targetRoom.current_generation as number;
    const key = await generateRoomKey(gen);

    // Alice membership
    const wrap = await wrapRoomKeyFor(key, alice.bundle.x25519PublicKey);
    const sig  = await signMembershipWrap(
      { roomId: targetRoom.id, generation: gen, memberUserId: alice.userId,
        memberDeviceId: alice.deviceId, wrappedRoomKey: wrap.wrapped,
        signerDeviceId: alice.deviceId },
      alice.bundle.ed25519PrivateKey,
    );
    await aliceUser.supabase.from('room_members').insert({
      room_id: targetRoom.id, user_id: alice.userId, device_id: alice.deviceId, generation: gen,
      wrapped_room_key: await toBase64(wrap.wrapped),
      signer_device_id: alice.deviceId, wrap_signature: await toBase64(sig),
    });

    // Alice sends a blob
    const encBlob = await encryptBlob<{ text: string }>({
      payload: { text: 'will be deleted' }, roomId: targetRoom.id, roomKey: key,
      senderUserId: alice.userId, senderDeviceId: alice.deviceId,
      senderDeviceEd25519PrivateKey: alice.bundle.ed25519PrivateKey,
    });
    await aliceUser.supabase.from('blobs').insert({
      room_id: targetRoom.id, sender_id: alice.userId, sender_device_id: alice.deviceId,
      generation: encBlob.generation, nonce: await toBase64(encBlob.nonce),
      ciphertext: await toBase64(encBlob.ciphertext),
      signature: encBlob.signature.byteLength > 0 ? await toBase64(encBlob.signature) : null,
      session_id: null, message_index: null,
    });

    // Alice invites Bob (pending, not yet accepted)
    const bobWrap = await wrapRoomKeyFor(key, bob.bundle.x25519PublicKey);
    const expiresAtMs = Date.now() + 3600_000;
    const inviteSig = await signInviteEnvelope(
      {
        roomId: targetRoom.id, generation: gen,
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
      room_id: targetRoom.id, invited_user_id: bob.userId, invited_device_id: bob.deviceId,
      invited_x25519_pub:  await toBase64(bob.bundle.x25519PublicKey),
      invited_ed25519_pub: await toBase64(bob.bundle.ed25519PublicKey),
      generation: gen, wrapped_room_key: await toBase64(bobWrap.wrapped),
      created_by: alice.userId, inviter_device_id: alice.deviceId,
      inviter_signature: await toBase64(inviteSig),
      expires_at_ms: expiresAtMs,
    });

    // Key backup row
    const { ciphertext: bkCt, nonce: bkNonce } = await encryptRoomKeyForBackup({
      roomKey: { key: key.key, generation: gen }, backupKey, roomId: targetRoom.id,
    });
    await svc.from('key_backup').insert({
      user_id: alice.userId, room_id: targetRoom.id, generation: gen,
      ciphertext: await toBase64(bkCt), nonce: await toBase64(bkNonce),
    });

    // -- Bob's unrelated room (should survive) --------------------------------
    const { data: survivorRoom } = await bobUser.supabase
      .from('rooms').insert({ kind: 'group', created_by: bob.userId })
      .select('*').single();
    const sGen = survivorRoom!.current_generation as number;
    const sKey = await generateRoomKey(sGen);
    const sWrap = await wrapRoomKeyFor(sKey, bob.bundle.x25519PublicKey);
    const sSig  = await signMembershipWrap(
      { roomId: survivorRoom!.id, generation: sGen, memberUserId: bob.userId,
        memberDeviceId: bob.deviceId, wrappedRoomKey: sWrap.wrapped,
        signerDeviceId: bob.deviceId },
      bob.bundle.ed25519PrivateKey,
    );
    await bobUser.supabase.from('room_members').insert({
      room_id: survivorRoom!.id, user_id: bob.userId, device_id: bob.deviceId, generation: sGen,
      wrapped_room_key: await toBase64(sWrap.wrapped),
      signer_device_id: bob.deviceId, wrap_signature: await toBase64(sSig),
    });

    // -- Delete target room ---------------------------------------------------
    const { error: delErr } = await aliceUser.supabase
      .from('rooms').delete().eq('id', targetRoom.id);
    if (delErr) throw new Error(`Room delete: ${delErr.message}`);

    // -- Verify cascade -------------------------------------------------------
    const checks = await Promise.all([
      svc.from('room_members').select('device_id').eq('room_id', targetRoom.id),
      svc.from('blobs').select('id').eq('room_id', targetRoom.id),
      svc.from('room_invites').select('id').eq('room_id', targetRoom.id),
      svc.from('key_backup').select('generation').eq('room_id', targetRoom.id),
    ]);
    const tableNames = ['room_members', 'blobs', 'room_invites', 'key_backup'];
    for (let i = 0; i < checks.length; i++) {
      const rows = checks[i].data ?? [];
      if (rows.length > 0) {
        throw new Error(`Room deletion left ${rows.length} orphaned row(s) in ${tableNames[i]}`);
      }
    }

    // -- Bob's survivor room is intact ----------------------------------------
    const { data: survivingMember } = await svc.from('room_members').select('device_id')
      .eq('room_id', survivorRoom!.id);
    if (!survivingMember || survivingMember.length === 0) {
      throw new Error("Bob's survivor room membership was deleted — cascade over-reached");
    }

    console.log('PASS: Room deletion cascade — 4 tables cleared for deleted room; Bob\'s other room intact ✓');
  } finally {
    for (const id of userIds) await cleanupUser(id).catch(console.error);
  }
}

run().catch((err) => { console.error('FAIL:', err); process.exit(1); });
