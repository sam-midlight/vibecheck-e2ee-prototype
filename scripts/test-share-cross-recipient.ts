/**
 * Test 28: Session Share Cross-Recipient RLS Block
 *
 * Alice shares a Megolm session specifically with Bob (recipient_device_id = Bob).
 * Carol (a member of the room) queries megolm_session_shares for her own device ID.
 *
 * Asserts: Carol sees 0 rows — RLS only returns shares addressed to her device.
 *
 * Run: npx tsx --env-file=.env.local scripts/test-share-cross-recipient.ts
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
  toBase64,
} from '../src/lib/e2ee-core';
import { initCrypto, createTestUser, provisionDevice, cleanupUser, makeServiceClient } from './test-utils';

async function run() {
  await initCrypto();

  const aliceUser = await createTestUser(`test-alice-scr-${Date.now()}@example.com`);
  const bobUser   = await createTestUser(`test-bob-scr-${Date.now()}@example.com`);
  const carolUser = await createTestUser(`test-carol-scr-${Date.now()}@example.com`);
  const userIds   = [aliceUser.userId, bobUser.userId, carolUser.userId];
  const svc       = makeServiceClient();

  try {
    const alice = await provisionDevice(aliceUser.supabase, aliceUser.userId);
    const bob   = await provisionDevice(bobUser.supabase,   bobUser.userId);
    const carol = await provisionDevice(carolUser.supabase, carolUser.userId);

    // -- Room with Alice + Bob + Carol ----------------------------------------
    const { data: room, error: roomErr } = await aliceUser.supabase
      .from('rooms').insert({ kind: 'group', created_by: alice.userId })
      .select('*').single();
    if (roomErr || !room) throw new Error(`createRoom: ${roomErr?.message}`);
    const generation = room.current_generation as number;
    const roomKey = await generateRoomKey(generation);

    for (const m of [alice, bob, carol]) {
      const wrap = await wrapRoomKeyFor(roomKey, m.bundle.x25519PublicKey);
      const sig  = await signMembershipWrap(
        { roomId: room.id, generation, memberUserId: m.userId, memberDeviceId: m.deviceId,
          wrappedRoomKey: wrap.wrapped, signerDeviceId: alice.deviceId },
        alice.bundle.ed25519PrivateKey,
      );
      const client = m.userId === alice.userId ? aliceUser.supabase : svc;
      await client.from('room_members').insert({
        room_id: room.id, user_id: m.userId, device_id: m.deviceId, generation,
        wrapped_room_key: await toBase64(wrap.wrapped),
        signer_device_id: alice.deviceId, wrap_signature: await toBase64(sig),
      });
    }

    // -- Alice seals a session share FOR BOB ONLY -----------------------------
    const session = await createOutboundSession(room.id, generation);
    const snapshot = exportSessionSnapshot(session, alice.userId, alice.deviceId);
    const sessionIdB64 = await toBase64(session.sessionId);
    await ratchetAndDerive(session);

    const sealedForBob = await sealSessionSnapshot(snapshot, bob.bundle.x25519PublicKey);
    const bobShareSig  = await signSessionShare({
      sessionId: session.sessionId, recipientDeviceId: bob.deviceId,
      sealedSnapshot: sealedForBob, signerDeviceId: alice.deviceId,
      signerEd25519Priv: alice.bundle.ed25519PrivateKey,
    });
    await svc.from('megolm_session_shares').insert({
      session_id: sessionIdB64,
      recipient_device_id: bob.deviceId,
      sealed_snapshot: await toBase64(sealedForBob),
      start_index: snapshot.startIndex,
      signer_device_id: alice.deviceId,
      share_signature: await toBase64(bobShareSig),
    });

    // -- Carol queries for shares addressed to HER device --------------------
    const { data: carolShares, error: carolErr } = await carolUser.supabase
      .from('megolm_session_shares')
      .select('session_id')
      .eq('session_id', sessionIdB64)
      .eq('recipient_device_id', carol.deviceId);

    if (carolErr) throw new Error(`carolQuery: ${carolErr.message}`);
    if (carolShares && carolShares.length > 0) {
      throw new Error(`Vulnerability: Carol sees ${carolShares.length} share(s) addressed to Bob's device`);
    }

    // -- Bob confirms he can see his own share --------------------------------
    const { data: bobShares } = await bobUser.supabase
      .from('megolm_session_shares')
      .select('session_id')
      .eq('session_id', sessionIdB64)
      .eq('recipient_device_id', bob.deviceId);
    if (!bobShares || bobShares.length === 0) {
      throw new Error('Bob cannot see his own session share — RLS over-blocked');
    }

    console.log('PASS: Session share RLS — Carol sees 0 shares addressed to Bob; Bob sees his own ✓');
  } finally {
    for (const id of userIds) await cleanupUser(id).catch(console.error);
  }
}

run().catch((err) => { console.error('FAIL:', err); process.exit(1); });
