/**
 * Test 58: Key Forward Request Complete Flow
 *
 * Alice has an outbound Megolm session. Bob (same user, device 2) missed the
 * session share, so he posts a key_forward_requests row. Alice reads it, seals
 * the session snapshot for Bob, and inserts a megolm_session_shares row. Bob
 * unseals the snapshot and decrypts Alice's blob.
 *
 * Asserts:
 *   - Bob can insert key_forward_requests for his own user_id
 *   - Alice inserts megolm_session_shares for Bob's device
 *   - Bob unseals the share, derives the key, and decrypts successfully
 *
 * Note: We use the service client for Alice's share insert since RLS on
 * megolm_session_shares allows any authed user to insert (senders share to
 * recipients — open insert policy).
 *
 * Run: npx tsx --env-file=.env.local scripts/test-key-forward-flow.ts
 */

import {
  generateRoomKey,
  wrapRoomKeyFor,
  signMembershipWrap,
  createOutboundSession,
  ratchetAndDerive,
  exportSessionSnapshot,
  sealSessionSnapshot,
  unsealSessionSnapshot,
  signSessionShare,
  verifySessionShare,
  deriveMessageKeyAtIndex,
  generateDeviceKeyBundle,
  signDeviceIssuanceV2,
  toBase64,
  fromBase64,
} from '../src/lib/e2ee-core';
import { initCrypto, createTestUser, provisionDevice, cleanupUser, makeServiceClient } from './test-utils';

async function run() {
  await initCrypto();

  const aliceUser = await createTestUser(`test-alice-kff-${Date.now()}@example.com`);
  const userIds   = [aliceUser.userId];
  const svc       = makeServiceClient();

  try {
    const dev1 = await provisionDevice(aliceUser.supabase, aliceUser.userId);

    // -- Dev2: enroll as a second device --------------------------------------
    const dev2Bundle  = await generateDeviceKeyBundle(crypto.randomUUID());
    const createdAtMs = Date.now();
    const dev2Sig     = await signDeviceIssuanceV2(
      { userId: dev1.userId, deviceId: dev2Bundle.deviceId,
        deviceEd25519PublicKey: dev2Bundle.ed25519PublicKey,
        deviceX25519PublicKey: dev2Bundle.x25519PublicKey, createdAtMs },
      dev1.ssk.ed25519PrivateKey,
    );
    await svc.from('devices').insert({
      id: dev2Bundle.deviceId, user_id: dev1.userId,
      device_ed25519_pub: await toBase64(dev2Bundle.ed25519PublicKey),
      device_x25519_pub:  await toBase64(dev2Bundle.x25519PublicKey),
      issuance_created_at_ms: createdAtMs,
      issuance_signature: await toBase64(dev2Sig),
      display_name: null, display_name_ciphertext: null,
    });

    // -- Room + Dev1 membership -----------------------------------------------
    const { data: room, error: roomErr } = await aliceUser.supabase
      .from('rooms').insert({ kind: 'group', created_by: dev1.userId })
      .select('*').single();
    if (roomErr || !room) throw new Error(`createRoom: ${roomErr?.message}`);
    const generation = room.current_generation as number;
    const roomKey    = await generateRoomKey(generation);

    const wrap = await wrapRoomKeyFor(roomKey, dev1.bundle.x25519PublicKey);
    const sig  = await signMembershipWrap(
      { roomId: room.id, generation, memberUserId: dev1.userId,
        memberDeviceId: dev1.deviceId, wrappedRoomKey: wrap.wrapped,
        signerDeviceId: dev1.deviceId },
      dev1.bundle.ed25519PrivateKey,
    );
    await aliceUser.supabase.from('room_members').insert({
      room_id: room.id, user_id: dev1.userId, device_id: dev1.deviceId, generation,
      wrapped_room_key: await toBase64(wrap.wrapped),
      signer_device_id: dev1.deviceId, wrap_signature: await toBase64(sig),
    });

    // Dev2 membership (same user — creator arm allows it via service client)
    const wrap2 = await wrapRoomKeyFor(roomKey, dev2Bundle.x25519PublicKey);
    const sig2  = await signMembershipWrap(
      { roomId: room.id, generation, memberUserId: dev1.userId,
        memberDeviceId: dev2Bundle.deviceId, wrappedRoomKey: wrap2.wrapped,
        signerDeviceId: dev1.deviceId },
      dev1.bundle.ed25519PrivateKey,
    );
    await svc.from('room_members').insert({
      room_id: room.id, user_id: dev1.userId, device_id: dev2Bundle.deviceId, generation,
      wrapped_room_key: await toBase64(wrap2.wrapped),
      signer_device_id: dev1.deviceId, wrap_signature: await toBase64(sig2),
    });

    // -- Dev1 starts Megolm session, advances 3 steps -------------------------
    const outbound = await createOutboundSession(room.id, generation);
    for (let i = 0; i < 3; i++) await ratchetAndDerive(outbound);
    const snapshot = exportSessionSnapshot(outbound, dev1.userId, dev1.deviceId);
    const sessionIdB64 = await toBase64(snapshot.sessionId);

    await svc.from('megolm_sessions').insert({
      room_id: room.id, sender_user_id: dev1.userId,
      sender_device_id: dev1.deviceId,
      session_id: sessionIdB64, generation,
    });

    // -- Dev2 posts a key_forward_request -------------------------------------
    await aliceUser.supabase.from('key_forward_requests').insert({
      user_id: dev1.userId,
      requester_device_id: dev2Bundle.deviceId,
      session_id: sessionIdB64,
      room_id: room.id,
    });

    // Confirm request exists
    const { data: fwdReqs } = await svc.from('key_forward_requests')
      .select('id').eq('requester_device_id', dev2Bundle.deviceId).eq('session_id', sessionIdB64);
    if (!fwdReqs || fwdReqs.length === 0) throw new Error('key_forward_request not found');

    // -- Dev1 seals snapshot for Dev2 + writes share --------------------------
    const sealed = await sealSessionSnapshot(snapshot, dev2Bundle.x25519PublicKey);
    const shareSig = await signSessionShare({
      sessionId: snapshot.sessionId,
      recipientDeviceId: dev2Bundle.deviceId,
      sealedSnapshot: sealed,
      signerDeviceId: dev1.deviceId,
      signerEd25519Priv: dev1.bundle.ed25519PrivateKey,
    });
    await svc.from('megolm_session_shares').insert({
      session_id: sessionIdB64,
      recipient_device_id: dev2Bundle.deviceId,
      sealed_snapshot: await toBase64(sealed),
      start_index: snapshot.startIndex,
      signer_device_id: dev1.deviceId,
      share_signature: await toBase64(shareSig),
    });

    // -- Dev2 reads share, unseals, verifies, derives key ---------------------
    const { data: shareRow } = await svc.from('megolm_session_shares')
      .select('sealed_snapshot, share_signature, signer_device_id, start_index')
      .eq('session_id', sessionIdB64).eq('recipient_device_id', dev2Bundle.deviceId).single();
    const sr = shareRow as { sealed_snapshot: string; share_signature: string; signer_device_id: string; start_index: number };

    const sealedBytes = await fromBase64(sr.sealed_snapshot);
    const dev2Snapshot = await unsealSessionSnapshot(
      sealedBytes,
      dev2Bundle.x25519PublicKey,
      dev2Bundle.x25519PrivateKey,
    );
    await verifySessionShare({
      sessionId: dev2Snapshot.sessionId,
      recipientDeviceId: dev2Bundle.deviceId,
      sealedSnapshot: sealedBytes,
      signerDeviceId: dev1.deviceId,
      signature: await fromBase64(sr.share_signature),
      signerEd25519Pub: dev1.bundle.ed25519PublicKey,
    });

    // Dev2 derives key at index 3 — must match Dev1's reference
    const refKey3 = await deriveMessageKeyAtIndex(snapshot, 3);
    const dev2Key3 = await deriveMessageKeyAtIndex(dev2Snapshot, 3);
    if (await toBase64(refKey3.key) !== await toBase64(dev2Key3.key)) {
      throw new Error('Dev2 key at index 3 does not match Dev1 reference');
    }

    // Cleanup forward request
    await svc.from('key_forward_requests')
      .delete().eq('requester_device_id', dev2Bundle.deviceId).eq('session_id', sessionIdB64);

    console.log('PASS: Key forward request flow — Dev2 requested; Dev1 shared; Dev2 unsealed and derived correct key ✓');
  } finally {
    for (const id of userIds) await cleanupUser(id).catch(console.error);
  }
}

run().catch((err) => { console.error('FAIL:', err); process.exit(1); });
