/**
 * Test: Megolm outbound session must rotate across a generation bump.
 *
 * Scenario: Alice and Bob are in a room at gen-1. Alice creates Megolm
 * outbound session A at gen-1, shares it with Bob, and sends a v4 blob.
 * Alice then kicks Bob via `kick_and_rotate` → gen-2. She must emit her
 * next message under a FRESH outbound session B — not reuse A at gen-2.
 *
 * This defends the forward-secrecy property of Megolm in the presence of
 * a kicked device: a device that retained session A (from its local IDB
 * before eviction) must not be able to decrypt anything produced after
 * rotation. If Alice reused session A at gen-2, Bob's retained snapshot
 * would ratchet forward and decrypt the gen-2 message — full FS leak.
 *
 * Asserts:
 *   1. createOutboundSession yields distinct session_ids per call (primitive).
 *   2. megolm_sessions UNIQUE(room,device,generation) allows a second row at
 *      gen-2 — i.e., the DB is NOT the layer that enforces rotation; the
 *      client must. Documents the responsibility boundary.
 *   3. The v4 blob Alice emits at gen-2 carries the NEW session_id (not A).
 *   4. Bob (kicked, still holding session A) cannot look up session B, so
 *      resolveMegolmKey returns null and decryptBlob throws DECRYPT_FAILED.
 *   5. Bob's session-A snapshot CAN still derive keys for historical gen-1
 *      messages he already has — confirms the FS boundary is on new output,
 *      not retroactive key loss.
 *
 * Non-coverage: this test does NOT exercise `ensureFreshSession` directly
 * (IDB-only; Node harness limitation). A dedicated unit test of that
 * function should complement this one.
 *
 * Run: npx tsx --env-file=.env.local scripts/test-megolm-rotation-on-gen-bump.ts
 */

import {
  generateRoomKey,
  wrapRoomKeyFor,
  unwrapRoomKey,
  signMembershipWrap,
  signInviteEnvelope,
  createOutboundSession,
  ratchetAndDerive,
  exportSessionSnapshot,
  sealSessionSnapshot,
  unsealSessionSnapshot,
  signSessionShare,
  deriveMessageKeyAtIndex,
  encryptBlobV4,
  decryptBlob,
  fromBase64,
  toBase64,
  CryptoError,
  type EncryptedBlob,
  type InboundSessionSnapshot,
} from '../src/lib/e2ee-core';
import { initCrypto, createTestUser, provisionDevice, cleanupUser, makeServiceClient } from './test-utils';

async function run() {
  await initCrypto();

  const aliceUser = await createTestUser(`test-alice-mrb-${Date.now()}@example.com`);
  const bobUser   = await createTestUser(`test-bob-mrb-${Date.now()}@example.com`);
  const userIds = [aliceUser.userId, bobUser.userId];
  const svc = makeServiceClient();

  try {
    const alice = await provisionDevice(aliceUser.supabase, aliceUser.userId);
    const bob   = await provisionDevice(bobUser.supabase,   bobUser.userId);

    // -- Gen-1 room + both members --------------------------------------------
    const { data: room, error: roomErr } = await aliceUser.supabase
      .from('rooms').insert({ kind: 'group', created_by: alice.userId })
      .select('*').single();
    if (roomErr || !room) throw new Error(`createRoom: ${roomErr?.message}`);
    const gen1 = room.current_generation as number;
    const roomKey1 = await generateRoomKey(gen1);

    // Alice inserts her own membership
    {
      const wrap = await wrapRoomKeyFor(roomKey1, alice.bundle.x25519PublicKey);
      const sig = await signMembershipWrap(
        { roomId: room.id, generation: gen1, memberUserId: alice.userId,
          memberDeviceId: alice.deviceId, wrappedRoomKey: wrap.wrapped,
          signerDeviceId: alice.deviceId },
        alice.bundle.ed25519PrivateKey,
      );
      await aliceUser.supabase.from('room_members').insert({
        room_id: room.id, user_id: alice.userId, device_id: alice.deviceId, generation: gen1,
        wrapped_room_key: await toBase64(wrap.wrapped),
        signer_device_id: alice.deviceId, wrap_signature: await toBase64(sig),
      });
    }

    // Alice invites + Bob accepts (covered by test-invite-accept-flow; inlined)
    const bobWrap = await wrapRoomKeyFor(roomKey1, bob.bundle.x25519PublicKey);
    const expiresAtMs = Date.now() + 60 * 60 * 1000;
    const inviteSig = await signInviteEnvelope(
      {
        roomId: room.id, generation: gen1,
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
      invited_x25519_pub: await toBase64(bob.bundle.x25519PublicKey),
      invited_ed25519_pub: await toBase64(bob.bundle.ed25519PublicKey),
      generation: gen1, wrapped_room_key: await toBase64(bobWrap.wrapped),
      created_by: alice.userId, inviter_device_id: alice.deviceId,
      inviter_signature: await toBase64(inviteSig),
      expires_at_ms: expiresAtMs,
    });
    {
      const memberSig = await signMembershipWrap(
        { roomId: room.id, generation: gen1, memberUserId: bob.userId,
          memberDeviceId: bob.deviceId, wrappedRoomKey: bobWrap.wrapped,
          signerDeviceId: alice.deviceId },
        alice.bundle.ed25519PrivateKey,
      );
      const { error } = await bobUser.supabase.from('room_members').insert({
        room_id: room.id, user_id: bob.userId, device_id: bob.deviceId, generation: gen1,
        wrapped_room_key: await toBase64(bobWrap.wrapped),
        signer_device_id: alice.deviceId, wrap_signature: await toBase64(memberSig),
      });
      if (error) throw new Error(`bob accept: ${error.message}`);
    }

    // -- Alice creates outbound Megolm session A at gen-1 ---------------------
    const sessionA = await createOutboundSession(room.id, gen1);
    const sessionAIdB64 = await toBase64(sessionA.sessionId);

    await aliceUser.supabase.from('megolm_sessions').insert({
      room_id: room.id, sender_user_id: alice.userId, sender_device_id: alice.deviceId,
      session_id: sessionAIdB64, generation: gen1, message_count: 0,
    });

    // Share A with Bob
    const snapshotForBob = exportSessionSnapshot(sessionA, alice.userId, alice.deviceId);
    const sealedForBob = await sealSessionSnapshot(snapshotForBob, bob.bundle.x25519PublicKey);
    const shareSig = await signSessionShare({
      sessionId: sessionA.sessionId,
      recipientDeviceId: bob.deviceId,
      sealedSnapshot: sealedForBob,
      signerDeviceId: alice.deviceId,
      signerEd25519Priv: alice.bundle.ed25519PrivateKey,
    });
    await aliceUser.supabase.from('megolm_session_shares').insert({
      session_id: sessionAIdB64, recipient_device_id: bob.deviceId,
      sealed_snapshot: await toBase64(sealedForBob),
      start_index: snapshotForBob.startIndex,
      signer_device_id: alice.deviceId, share_signature: await toBase64(shareSig),
    });

    // Alice sends a v4 blob at gen-1 under session A
    const msgKey1 = await ratchetAndDerive(sessionA);
    const blob1 = await encryptBlobV4<{ text: string }>({
      payload: { text: 'gen-1 under A' }, roomId: room.id,
      messageKey: msgKey1, sessionId: sessionA.sessionId, generation: gen1,
      senderUserId: alice.userId, senderDeviceId: alice.deviceId,
      senderDeviceEd25519PrivateKey: alice.bundle.ed25519PrivateKey,
    });
    await aliceUser.supabase.from('blobs').insert({
      room_id: room.id, sender_id: alice.userId, sender_device_id: alice.deviceId,
      generation: blob1.generation, nonce: await toBase64(blob1.nonce),
      ciphertext: await toBase64(blob1.ciphertext), signature: null,
      session_id: blob1.sessionId, message_index: blob1.messageIndex,
    });

    // Bob opens his share and proves he can decrypt the gen-1 blob
    const bobSnapshotA: InboundSessionSnapshot = await unsealSessionSnapshot(
      sealedForBob, bob.bundle.x25519PublicKey, bob.bundle.x25519PrivateKey,
    );
    const bobRoomKey1 = await unwrapRoomKey(
      { wrapped: bobWrap.wrapped, generation: gen1 },
      bob.bundle.x25519PublicKey, bob.bundle.x25519PrivateKey,
    );
    {
      const wire: EncryptedBlob = { ...blob1 };
      const { payload } = await decryptBlob<{ text: string }>({
        blob: wire, roomId: room.id, roomKey: bobRoomKey1,
        resolveSenderDeviceEd25519Pub: async () => alice.bundle.ed25519PublicKey,
        resolveMegolmKey: async (sid, idx) => {
          if (sid !== sessionAIdB64) return null;
          const k = await deriveMessageKeyAtIndex(bobSnapshotA, idx);
          return k.key;
        },
      });
      if (payload.text !== 'gen-1 under A') {
        throw new Error(`gen-1 decrypt mismatch: "${payload.text}"`);
      }
    }

    // -- Kick Bob → gen-2; Alice alone ----------------------------------------
    const gen2 = gen1 + 1;
    const roomKey2 = await generateRoomKey(gen2);
    const aliceWrap2 = await wrapRoomKeyFor(roomKey2, alice.bundle.x25519PublicKey);
    const aliceWrapSig2 = await signMembershipWrap(
      { roomId: room.id, generation: gen2, memberUserId: alice.userId,
        memberDeviceId: alice.deviceId, wrappedRoomKey: aliceWrap2.wrapped,
        signerDeviceId: alice.deviceId },
      alice.bundle.ed25519PrivateKey,
    );
    const { error: rotErr } = await aliceUser.supabase.rpc('kick_and_rotate', {
      p_room_id: room.id, p_evictee_user_ids: [bob.userId],
      p_old_gen: gen1, p_new_gen: gen2,
      p_wraps: [{
        user_id: alice.userId, device_id: alice.deviceId,
        wrapped_room_key: await toBase64(aliceWrap2.wrapped),
        wrap_signature: await toBase64(aliceWrapSig2),
      }],
      p_signer_device_id: alice.deviceId,
      p_name_ciphertext: null, p_name_nonce: null,
    });
    if (rotErr) throw new Error(`kick_and_rotate: ${rotErr.message}`);

    // -- Alice creates outbound Megolm session B at gen-2 ---------------------
    const sessionB = await createOutboundSession(room.id, gen2);
    const sessionBIdB64 = await toBase64(sessionB.sessionId);

    // Assertion 1 (primitive): fresh session has a distinct session_id.
    if (sessionAIdB64 === sessionBIdB64) {
      throw new Error('Vulnerability: createOutboundSession yielded same session_id twice');
    }
    if (sessionB.generation !== gen2) {
      throw new Error(`session.generation mismatch: got ${sessionB.generation}, expected ${gen2}`);
    }

    // Assertion 2: the UNIQUE(room,device,generation) index admits a new row
    // at gen-2 — proving the DB does NOT enforce "session must differ from
    // gen-1's". The primitive discipline is the enforcement.
    const { error: regBErr } = await aliceUser.supabase.from('megolm_sessions').insert({
      room_id: room.id, sender_user_id: alice.userId, sender_device_id: alice.deviceId,
      session_id: sessionBIdB64, generation: gen2, message_count: 0,
    });
    if (regBErr) throw new Error(`session B register failed: ${regBErr.message}`);

    // Sanity: inserting a SECOND row for (room,device,gen-2) is blocked.
    const { error: dupeErr } = await aliceUser.supabase.from('megolm_sessions').insert({
      room_id: room.id, sender_user_id: alice.userId, sender_device_id: alice.deviceId,
      session_id: sessionAIdB64, generation: gen2, message_count: 0,
    });
    if (!dupeErr) {
      throw new Error(
        'Unexpected: DB allowed two megolm_sessions rows at the same (room,device,generation). ' +
        'UNIQUE index is not holding.',
      );
    }

    // Assertion 3: gen-2 blob carries session_id = B, not A.
    const msgKey2 = await ratchetAndDerive(sessionB);
    const blob2 = await encryptBlobV4<{ text: string }>({
      payload: { text: 'gen-2 under B' }, roomId: room.id,
      messageKey: msgKey2, sessionId: sessionB.sessionId, generation: gen2,
      senderUserId: alice.userId, senderDeviceId: alice.deviceId,
      senderDeviceEd25519PrivateKey: alice.bundle.ed25519PrivateKey,
    });
    if (blob2.sessionId !== sessionBIdB64) {
      throw new Error(`gen-2 blob must carry session B's id, got ${blob2.sessionId}`);
    }
    if (blob2.sessionId === sessionAIdB64) {
      throw new Error('Vulnerability: gen-2 blob was stamped with gen-1 session_id');
    }
    await aliceUser.supabase.from('blobs').insert({
      room_id: room.id, sender_id: alice.userId, sender_device_id: alice.deviceId,
      generation: blob2.generation, nonce: await toBase64(blob2.nonce),
      ciphertext: await toBase64(blob2.ciphertext), signature: null,
      session_id: blob2.sessionId, message_index: blob2.messageIndex,
    });

    // Assertion 4: Bob (kicked) cannot decrypt the gen-2 blob.
    // - He is not in room_members at gen-2, so RLS hides the blob on select.
    // - Even if he exfiltrated the ciphertext, he has no snapshot of B.
    const { data: bobCanSeeGen2 } = await bobUser.supabase
      .from('blobs').select('id')
      .eq('room_id', room.id).eq('session_id', sessionBIdB64);
    if (bobCanSeeGen2 && bobCanSeeGen2.length !== 0) {
      throw new Error(
        'Vulnerability: RLS let a kicked member read a post-rotation blob ' +
        `(saw ${bobCanSeeGen2.length} rows).`,
      );
    }

    // Simulate exfiltration + decrypt attempt using ONLY Bob's retained A snapshot.
    const { data: exfil } = await svc
      .from('blobs').select('*')
      .eq('room_id', room.id).eq('session_id', sessionBIdB64).single();
    const exfilRow = exfil as {
      nonce: string; ciphertext: string; generation: number;
      session_id: string; message_index: number;
    };
    const wire2: EncryptedBlob = {
      nonce: await fromBase64(exfilRow.nonce),
      ciphertext: await fromBase64(exfilRow.ciphertext),
      signature: new Uint8Array(0), generation: exfilRow.generation,
      sessionId: exfilRow.session_id, messageIndex: exfilRow.message_index,
    };
    let decryptedUnderA = false;
    try {
      await decryptBlob<{ text: string }>({
        blob: wire2, roomId: room.id, roomKey: bobRoomKey1, // Bob's gen-1 room key
        resolveSenderDeviceEd25519Pub: async () => alice.bundle.ed25519PublicKey,
        resolveMegolmKey: async (sid, idx) => {
          // Bob tries to pass off session A's key for session B's id. Should
          // return null because his store doesn't have session B.
          if (sid === sessionBIdB64) return null;
          if (sid === sessionAIdB64) {
            const k = await deriveMessageKeyAtIndex(bobSnapshotA, idx);
            return k.key;
          }
          return null;
        },
      });
      decryptedUnderA = true;
    } catch (err) {
      if (!(err instanceof CryptoError)) throw err;
      // Expected: DECRYPT_FAILED or no-key error.
    }
    if (decryptedUnderA) {
      throw new Error('Vulnerability: Bob decrypted a gen-2 blob using his retained session A.');
    }

    // Assertion 5: Bob can STILL decrypt historical gen-1 blobs with A — FS
    // is about post-rotation output only, not retroactive key loss.
    const { data: histRow } = await svc
      .from('blobs').select('*')
      .eq('room_id', room.id).eq('session_id', sessionAIdB64).single();
    const hist = histRow as {
      nonce: string; ciphertext: string; generation: number;
      session_id: string; message_index: number;
    };
    const wire1: EncryptedBlob = {
      nonce: await fromBase64(hist.nonce),
      ciphertext: await fromBase64(hist.ciphertext),
      signature: new Uint8Array(0), generation: hist.generation,
      sessionId: hist.session_id, messageIndex: hist.message_index,
    };
    const { payload: histPayload } = await decryptBlob<{ text: string }>({
      blob: wire1, roomId: room.id, roomKey: bobRoomKey1,
      resolveSenderDeviceEd25519Pub: async () => alice.bundle.ed25519PublicKey,
      resolveMegolmKey: async (sid, idx) => {
        if (sid !== sessionAIdB64) return null;
        const k = await deriveMessageKeyAtIndex(bobSnapshotA, idx);
        return k.key;
      },
    });
    if (histPayload.text !== 'gen-1 under A') {
      throw new Error(`Historical gen-1 decrypt broke: "${histPayload.text}"`);
    }

    console.log(
      'PASS: Megolm gen-bump rotation — fresh session_id; DB admits both rows; ' +
      'kicked-device cannot decrypt gen-2; historical gen-1 still reachable ✓',
    );
  } finally {
    for (const id of userIds) await cleanupUser(id).catch(console.error);
  }
}

run().catch((err) => { console.error('FAIL:', err); process.exit(1); });
