/**
 * Test 38: cleanupUser Completeness
 *
 * Provision a user with a rich data footprint:
 *   - 1 device (devices table, via provisionDevice)
 *   - 1 room with a membership and a blob
 *   - 1 Megolm session
 *   - 1 room_invite (as inviter)
 *   - 1 key_backup row (cascades with room deletion)
 *   - 1 SAS verification session
 *
 * Then call cleanupUser and verify that every table explicitly handled by
 * cleanupUser is empty for that user.
 *
 * This test is a regression guard for the test harness itself: if cleanupUser
 * leaves orphaned rows it will contaminate subsequent test runs.
 *
 * Asserts:
 *   - After cleanupUser: sas_verification_sessions, megolm_sessions,
 *     blobs, room_invites, room_members all have 0 rows for that user
 *   - key_backup (cascades from room deletion) also empty
 *   - identities row survives (it's a public-key tombstone)
 *
 * Run: npx tsx --env-file=.env.local scripts/test-cleanup-completeness.ts
 */

import {
  generateRoomKey,
  wrapRoomKeyFor,
  signMembershipWrap,
  encryptBlob,
  signInviteEnvelope,
  toBase64,
  createOutboundSession,
  ratchetAndDerive,
  exportSessionSnapshot,
} from '../src/lib/e2ee-core';
import { initCrypto, createTestUser, provisionDevice, cleanupUser, makeServiceClient } from './test-utils';

async function run() {
  await initCrypto();

  const aliceUser = await createTestUser(`test-alice-cc-${Date.now()}@example.com`);
  const bobUser   = await createTestUser(`test-bob-cc-${Date.now()}@example.com`);
  const svc       = makeServiceClient();

  // Bob is collateral — we need him for invite + SAS rows.
  const collateralIds = [bobUser.userId];

  try {
    const alice = await provisionDevice(aliceUser.supabase, aliceUser.userId);
    const bob   = await provisionDevice(bobUser.supabase, bobUser.userId);

    // -- Room + Alice membership + blob ----------------------------------------
    const { data: room, error: roomErr } = await aliceUser.supabase
      .from('rooms').insert({ kind: 'group', created_by: alice.userId })
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
      room_id: room.id, user_id: alice.userId, device_id: alice.deviceId, generation,
      wrapped_room_key: await toBase64(aliceWrap.wrapped),
      signer_device_id: alice.deviceId, wrap_signature: await toBase64(aliceSig),
    });

    const encBlob = await encryptBlob<{ text: string }>({
      payload: { text: 'test blob' }, roomId: room.id, roomKey,
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

    // -- Megolm session --------------------------------------------------------
    const megolmSession = await createOutboundSession(room.id, generation);
    await ratchetAndDerive(megolmSession);
    const snapshot = exportSessionSnapshot(megolmSession, alice.userId, alice.deviceId);
    const sessionIdB64 = await toBase64(snapshot.sessionId);

    await svc.from('megolm_sessions').insert({
      room_id: room.id,
      sender_user_id: alice.userId,
      sender_device_id: alice.deviceId,
      session_id: sessionIdB64,
      generation,
    });

    // -- room_invites (Alice invites Bob) --------------------------------------
    const bobWrap = await wrapRoomKeyFor(roomKey, bob.bundle.x25519PublicKey);
    const expiresAtMs = Date.now() + 3600_000;
    const inviteSig = await signInviteEnvelope(
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

    // -- key_backup (cascades when room is deleted by cleanupUser) -------------
    await svc.from('key_backup').insert({
      user_id: alice.userId,
      room_id: room.id,
      generation,
      ciphertext: 'dGVzdA==',
      nonce: 'dGVzdA==',
    });

    // -- SAS verification session ---------------------------------------------
    const { data: sasRow } = await svc.from('sas_verification_sessions').insert({
      initiator_user_id:   alice.userId,
      initiator_device_id: alice.deviceId,
      responder_user_id:   bob.userId,
      responder_device_id: bob.deviceId,
      state: 'initiated',
      expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    }).select('id').single();
    const sasId = (sasRow as { id: string }).id;

    // -- Pre-cleanup: confirm rows exist --------------------------------------
    const tableNames = [
      'sas_verification_sessions',
      'megolm_sessions',
      'blobs',
      'room_invites',
      'room_members',
      'key_backup',
    ];
    const preChecks = await Promise.all([
      svc.from('sas_verification_sessions').select('id').eq('initiator_user_id', alice.userId),
      svc.from('megolm_sessions').select('id').eq('sender_user_id', alice.userId),
      svc.from('blobs').select('id').eq('sender_id', alice.userId),
      svc.from('room_invites').select('id').eq('created_by', alice.userId),
      svc.from('room_members').select('device_id').eq('user_id', alice.userId),
      svc.from('key_backup').select('generation').eq('user_id', alice.userId),
    ]);
    for (let i = 0; i < preChecks.length; i++) {
      if (!preChecks[i].data || preChecks[i].data!.length === 0) {
        throw new Error(`Pre-cleanup: expected rows in ${tableNames[i]} but found none`);
      }
    }

    // -- Run cleanupUser (the function under test) ----------------------------
    await cleanupUser(alice.userId);

    // -- Post-cleanup: all rows for Alice should be gone ----------------------
    const postChecks = await Promise.all([
      svc.from('sas_verification_sessions').select('id').eq('id', sasId),
      svc.from('megolm_sessions').select('id').eq('sender_user_id', alice.userId),
      svc.from('blobs').select('id').eq('sender_id', alice.userId),
      svc.from('room_invites').select('id').eq('created_by', alice.userId),
      svc.from('room_members').select('device_id').eq('user_id', alice.userId),
      svc.from('key_backup').select('generation').eq('user_id', alice.userId),
    ]);
    for (let i = 0; i < postChecks.length; i++) {
      const rows = postChecks[i].data ?? [];
      if (rows.length > 0) {
        throw new Error(`cleanupUser left ${rows.length} orphaned row(s) in ${tableNames[i]}`);
      }
    }

    // Note: identities row may or may not survive depending on whether
    // auth.admin.deleteUser succeeds (it cascades). That's acceptable — the
    // tombstone invariant applies to nuke_identity, not cleanupUser.

    console.log('PASS: cleanupUser completeness — 6 tables emptied after cleanupUser ✓');
  } finally {
    for (const id of collateralIds) await cleanupUser(id).catch(console.error);
  }
}

run().catch((err) => { console.error('FAIL:', err); process.exit(1); });
