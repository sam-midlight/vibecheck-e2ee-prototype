/**
 * Test 23: Session Share Signature Tamper
 *
 * Alice shares a Megolm session with Bob. Before Bob fetches it, we modify
 * one byte in the sealed_snapshot stored in the DB. Bob unseals the snapshot
 * successfully (the sealed_snapshot is still validly sealed to Bob's X25519 —
 * we only changed the DB column after sealing), but verifySessionShare must
 * detect the modification because the signature was computed over the original
 * sealed bytes.
 *
 * Asserts: verifySessionShare throws with CERT_INVALID / signature error.
 *
 * Run: npx tsx --env-file=.env.local scripts/test-share-sig-tamper.ts
 */

import {
  generateRoomKey,
  wrapRoomKeyFor,
  signMembershipWrap,
  createOutboundSession,
  exportSessionSnapshot,
  ratchetAndDerive,
  sealSessionSnapshot,
  signSessionShare,
  verifySessionShare,
  fromBase64,
  toBase64,
} from '../src/lib/e2ee-core';
import { initCrypto, createTestUser, provisionDevice, cleanupUser, makeServiceClient } from './test-utils';

async function run() {
  await initCrypto();

  const aliceUser = await createTestUser(`test-alice-sst-${Date.now()}@example.com`);
  const bobUser   = await createTestUser(`test-bob-sst-${Date.now()}@example.com`);
  const userIds   = [aliceUser.userId, bobUser.userId];
  const svc       = makeServiceClient();

  try {
    const alice = await provisionDevice(aliceUser.supabase, aliceUser.userId);
    const bob   = await provisionDevice(bobUser.supabase,   bobUser.userId);

    // -- Room + memberships ---------------------------------------------------
    const { data: room, error: roomErr } = await aliceUser.supabase
      .from('rooms').insert({ kind: 'group', created_by: alice.userId })
      .select('*').single();
    if (roomErr || !room) throw new Error(`createRoom: ${roomErr?.message}`);
    const generation = room.current_generation as number;
    const roomKey = await generateRoomKey(generation);

    for (const m of [
      { m: alice, client: aliceUser.supabase },
      { m: bob,   client: svc },
    ]) {
      const wrap = await wrapRoomKeyFor(roomKey, m.m.bundle.x25519PublicKey);
      const sig  = await signMembershipWrap(
        { roomId: room.id, generation, memberUserId: m.m.userId, memberDeviceId: m.m.deviceId,
          wrappedRoomKey: wrap.wrapped, signerDeviceId: alice.deviceId },
        alice.bundle.ed25519PrivateKey,
      );
      await m.client.from('room_members').insert({
        room_id: room.id, user_id: m.m.userId, device_id: m.m.deviceId, generation,
        wrapped_room_key: await toBase64(wrap.wrapped),
        signer_device_id: alice.deviceId, wrap_signature: await toBase64(sig),
      });
    }

    // -- Alice creates outbound session, seals snapshot for Bob ---------------
    const session     = await createOutboundSession(room.id, generation);
    const snapshot    = exportSessionSnapshot(session, alice.userId, alice.deviceId);
    const sessionIdB64 = await toBase64(session.sessionId);
    await ratchetAndDerive(session);

    const sealedSnapshot = await sealSessionSnapshot(snapshot, bob.bundle.x25519PublicKey);
    const shareSignature = await signSessionShare({
      sessionId: session.sessionId, recipientDeviceId: bob.deviceId,
      sealedSnapshot, signerDeviceId: alice.deviceId,
      signerEd25519Priv: alice.bundle.ed25519PrivateKey,
    });

    // Upload share row
    await svc.from('megolm_session_shares').insert({
      session_id: sessionIdB64, recipient_device_id: bob.deviceId,
      sealed_snapshot: await toBase64(sealedSnapshot),
      start_index: snapshot.startIndex,
      signer_device_id: alice.deviceId,
      share_signature: await toBase64(shareSignature),
    });

    // -- TAMPER: fetch the share row and flip a byte in sealed_snapshot -------
    const { data: shareRow } = await svc.from('megolm_session_shares')
      .select('*').eq('session_id', sessionIdB64).eq('recipient_device_id', bob.deviceId).single();
    if (!shareRow) throw new Error('Share row not found');

    const sr = shareRow as { sealed_snapshot: string; share_signature: string; signer_device_id: string };
    const tamperedSealed = await fromBase64(sr.sealed_snapshot);
    tamperedSealed[20] ^= 0xff;

    await svc.from('megolm_session_shares')
      .update({ sealed_snapshot: await toBase64(tamperedSealed) })
      .eq('session_id', sessionIdB64).eq('recipient_device_id', bob.deviceId);

    // -- Bob fetches and tries to verify the tampered share -------------------
    const { data: fetchedShare } = await bobUser.supabase
      .from('megolm_session_shares').select('*')
      .eq('session_id', sessionIdB64).eq('recipient_device_id', bob.deviceId).single();
    if (!fetchedShare) throw new Error('Bob could not fetch share');

    const fs = fetchedShare as { sealed_snapshot: string; share_signature: string; signer_device_id: string };

    try {
      await verifySessionShare({
        sessionId: session.sessionId,
        recipientDeviceId: bob.deviceId,
        sealedSnapshot: await fromBase64(fs.sealed_snapshot),
        signerDeviceId: fs.signer_device_id,
        signature: await fromBase64(fs.share_signature),
        signerEd25519Pub: alice.bundle.ed25519PublicKey,
      });
      throw new Error('Vulnerability: verifySessionShare passed on tampered sealed_snapshot');
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Vulnerability')) throw err;
      // Expected: CERT_INVALID or SIGNATURE_INVALID
    }

    console.log('PASS: Session share signature tamper detected by verifySessionShare ✓');
  } finally {
    for (const id of userIds) await cleanupUser(id).catch(console.error);
  }
}

run().catch((err) => { console.error('FAIL:', err); process.exit(1); });
