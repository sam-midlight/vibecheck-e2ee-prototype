/**
 * Test 72: Megolm Session Share — Snapshot Identity Mismatch
 *
 * Exercises the client-side cross-check added alongside migration 0048:
 * after unsealing a share's snapshot, the receiver must verify that
 * `snapshot.senderDeviceId === megolm_sessions.sender_device_id` (and
 * `toBase64(snapshot.sessionId) === expected session_id`).
 *
 * Attack model: a malicious co-device forwarder. Alice-device1 legitimately
 * holds a session where she is the sender. As a co-device forwarder, she
 * crafts a share for Alice-device2 whose sealed snapshot claims Bob as the
 * sender — via `exportSessionSnapshot(session, alice.userId, bob.deviceId)`.
 * The share signature is valid (Alice-device1 really did sign over the
 * sealed bytes), RLS Branch B accepts it (signer + recipient are co-devices),
 * and the sealed-box AEAD unseals cleanly (recipient X25519 key is correct).
 * The ONLY defense is the snapshot-identity cross-check.
 *
 * Without the cross-check, Alice-device2 would cache a session under the key
 * `(session_id, bob.deviceId)` with chain-key material actually belonging to
 * Alice's session — a decrypt-mislead bug that makes future messages from
 * Bob's real session undecodable (IDB holds the wrong snapshot for that key).
 *
 * Assertions:
 *   1. The forged share is accepted by RLS + signature verify + unseal.
 *   2. `snapshot.senderDeviceId !== megolm_sessions.sender_device_id` — i.e.
 *      the cross-check condition fires, so a receiver that performs the
 *      check would reject.
 *
 * Run: npx tsx --env-file=.env.local scripts/test-megolm-share-snapshot-mismatch.ts
 */

import {
  generateRoomKey,
  wrapRoomKeyFor,
  signMembershipWrap,
  createOutboundSession,
  exportSessionSnapshot,
  sealSessionSnapshot,
  signSessionShare,
  verifySessionShare,
  unsealSessionSnapshot,
  fromBase64,
  toBase64,
} from '../src/lib/e2ee-core';
import {
  initCrypto,
  createTestUser,
  provisionDevice,
  provisionSecondDevice,
  cleanupUser,
  makeServiceClient,
} from './test-utils';

async function run() {
  await initCrypto();

  const aliceUser = await createTestUser(`test-alice-smm-${Date.now()}@example.com`);
  const bobUser   = await createTestUser(`test-bob-smm-${Date.now()}@example.com`);
  const userIds   = [aliceUser.userId, bobUser.userId];
  const svc       = makeServiceClient();

  try {
    const alice  = await provisionDevice(aliceUser.supabase, aliceUser.userId);
    const alice2 = await provisionSecondDevice(aliceUser.supabase, aliceUser.userId, alice.ssk);
    const bob    = await provisionDevice(bobUser.supabase, bobUser.userId);

    // -- Room: Alice (both devices) + Bob -------------------------------------
    const { data: room, error: roomErr } = await aliceUser.supabase
      .from('rooms').insert({ kind: 'group', created_by: alice.userId })
      .select('*').single();
    if (roomErr || !room) throw new Error(`createRoom: ${roomErr?.message}`);
    const generation = room.current_generation as number;
    const roomKey = await generateRoomKey(generation);

    for (const m of [
      { userId: alice.userId, deviceId: alice.deviceId,  xpub: alice.bundle.x25519PublicKey,  client: aliceUser.supabase },
      { userId: alice.userId, deviceId: alice2.deviceId, xpub: alice2.bundle.x25519PublicKey, client: aliceUser.supabase },
      { userId: bob.userId,   deviceId: bob.deviceId,    xpub: bob.bundle.x25519PublicKey,    client: svc },
    ]) {
      const wrap = await wrapRoomKeyFor(roomKey, m.xpub);
      const sig  = await signMembershipWrap(
        { roomId: room.id, generation, memberUserId: m.userId, memberDeviceId: m.deviceId,
          wrappedRoomKey: wrap.wrapped, signerDeviceId: alice.deviceId },
        alice.bundle.ed25519PrivateKey,
      );
      const { error } = await m.client.from('room_members').insert({
        room_id: room.id, user_id: m.userId, device_id: m.deviceId, generation,
        wrapped_room_key: await toBase64(wrap.wrapped),
        signer_device_id: alice.deviceId, wrap_signature: await toBase64(sig),
      });
      if (error) throw new Error(`room_members insert for ${m.deviceId}: ${error.message}`);
    }

    // -- Alice-device1 creates an outbound session (she is the sender) --------
    const session       = await createOutboundSession(room.id, generation);
    const sessionIdB64  = await toBase64(session.sessionId);

    // Insert megolm_sessions row — authoritative sender_device_id = alice.deviceId.
    const { error: sessErr } = await aliceUser.supabase.from('megolm_sessions').insert({
      room_id: room.id,
      sender_user_id: alice.userId,
      sender_device_id: alice.deviceId,
      session_id: sessionIdB64,
      generation,
      message_count: 0,
    });
    if (sessErr) throw new Error(`megolm_sessions insert: ${sessErr.message}`);

    // -- Forge a snapshot lying about senderDeviceId --------------------------
    // Alice-device1 exports the snapshot but passes BOB'S deviceId as the
    // senderDeviceId field. This is a malicious co-device forwarder constructing
    // a forgery that would, without the cross-check, mislead Alice-device2 into
    // caching chain-key material under the wrong (session_id, senderDeviceId) key.
    const forgedSnapshot = exportSessionSnapshot(session, alice.userId, bob.deviceId);

    const sealed = await sealSessionSnapshot(forgedSnapshot, alice2.bundle.x25519PublicKey);
    const shareSig = await signSessionShare({
      sessionId: session.sessionId,
      recipientDeviceId: alice2.deviceId,
      sealedSnapshot: sealed,
      signerDeviceId: alice.deviceId,
      signerEd25519Priv: alice.bundle.ed25519PrivateKey,
    });

    // -- Insert as authenticated Alice-device1 (Branch B: co-device forward) --
    const { error: insertErr } = await aliceUser.supabase.from('megolm_session_shares').insert({
      session_id: sessionIdB64,
      recipient_device_id: alice2.deviceId,
      sealed_snapshot: await toBase64(sealed),
      start_index: forgedSnapshot.startIndex,
      signer_device_id: alice.deviceId,
      share_signature: await toBase64(shareSig),
    });
    if (insertErr) {
      throw new Error(`RLS unexpectedly rejected legitimate co-device forward: ${insertErr.message}`);
    }

    // -- Simulate the receiver's verification pipeline on Alice-device2 -------
    // This mirrors the fixed code in bootstrap.ts responder fallback,
    // CallChatPanel resolveMegolm, and initial hydration.
    const { data: shareRow, error: readErr } = await aliceUser.supabase
      .from('megolm_session_shares').select('*')
      .eq('session_id', sessionIdB64)
      .eq('recipient_device_id', alice2.deviceId).single();
    if (readErr || !shareRow) throw new Error(`read share: ${readErr?.message ?? 'no row'}`);
    const sr = shareRow as {
      session_id: string; recipient_device_id: string; sealed_snapshot: string;
      signer_device_id: string; share_signature: string;
    };

    // Step 1: signature verification succeeds (Alice-device1 really did sign).
    await verifySessionShare({
      sessionId: await fromBase64(sr.session_id),
      recipientDeviceId: sr.recipient_device_id,
      sealedSnapshot: await fromBase64(sr.sealed_snapshot),
      signerDeviceId: sr.signer_device_id,
      signature: await fromBase64(sr.share_signature),
      signerEd25519Pub: alice.bundle.ed25519PublicKey,
    });

    // Step 2: unseal succeeds (sealed to Alice-device2's X25519 pub).
    const snap = await unsealSessionSnapshot(
      await fromBase64(sr.sealed_snapshot),
      alice2.bundle.x25519PublicKey,
      alice2.bundle.x25519PrivateKey,
    );

    // Step 3: cross-check against authoritative megolm_sessions.sender_device_id.
    const { data: sessRow } = await aliceUser.supabase.from('megolm_sessions')
      .select('sender_device_id').eq('session_id', sessionIdB64).single();
    if (!sessRow) throw new Error('megolm_sessions row missing');
    const authoritativeSender = (sessRow as { sender_device_id: string }).sender_device_id;

    const snapSidMatches = (await toBase64(snap.sessionId)) === sr.session_id;
    const senderMatches = snap.senderDeviceId === authoritativeSender;

    if (!snapSidMatches) {
      // Shouldn't happen in this test (we only forged senderDeviceId, not sessionId).
      throw new Error('unexpected: sessionId also mismatched');
    }
    if (senderMatches) {
      throw new Error(
        'Vulnerability: snapshot.senderDeviceId matches authoritative sender — ' +
        'cross-check would not fire on this forgery',
      );
    }

    // Cross-check FIRES: snap.senderDeviceId (= bob.deviceId, forged) !==
    // authoritativeSender (= alice.deviceId). Receiver code at this point
    // does `continue` / skips putInboundSession — forgery rejected.
    console.log(
      `PASS: snapshot sender mismatch detected — ` +
      `snap.senderDeviceId=${snap.senderDeviceId.slice(0, 8)}… ` +
      `vs authoritative=${authoritativeSender.slice(0, 8)}… ✓`,
    );
  } finally {
    for (const id of userIds) await cleanupUser(id).catch(console.error);
  }
}

run().catch((err) => { console.error('FAIL:', err); process.exit(1); });
