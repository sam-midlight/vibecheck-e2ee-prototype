/**
 * Test 22: Per-Sender Megolm Session Isolation
 *
 * Alice and Bob both have active outbound Megolm sessions in the same room.
 * Carol is a member and receives both session shares.
 *
 * Asserts:
 *   - Carol can decrypt Alice's message using Alice's session
 *   - Carol can decrypt Bob's message using Bob's session
 *   - Alice's chain key does NOT produce Bob's message key (key isolation):
 *     attempting to decrypt Bob's blob using Alice's derived key fails AEAD.
 *   - The two sessionIds are different (independent sessions)
 *
 * Run: npx tsx --env-file=.env.local scripts/test-per-sender-isolation.ts
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
  unsealSessionSnapshot,
  deriveMessageKeyAtIndex,
  encryptBlobV4,
  decryptBlob,
  fromBase64,
  toBase64,
  type EncryptedBlob,
  type RoomKey,
} from '../src/lib/e2ee-core';
import { initCrypto, createTestUser, provisionDevice, cleanupUser, makeServiceClient } from './test-utils';

async function run() {
  await initCrypto();

  const aliceUser = await createTestUser(`test-alice-psi-${Date.now()}@example.com`);
  const bobUser   = await createTestUser(`test-bob-psi-${Date.now()}@example.com`);
  const carolUser = await createTestUser(`test-carol-psi-${Date.now()}@example.com`);
  const userIds   = [aliceUser.userId, bobUser.userId, carolUser.userId];
  const svc       = makeServiceClient();

  try {
    const alice = await provisionDevice(aliceUser.supabase, aliceUser.userId);
    const bob   = await provisionDevice(bobUser.supabase,   bobUser.userId);
    const carol = await provisionDevice(carolUser.supabase, carolUser.userId);

    // -- Room + memberships ---------------------------------------------------
    const { data: room, error: roomErr } = await aliceUser.supabase
      .from('rooms').insert({ kind: 'group', created_by: alice.userId })
      .select('*').single();
    if (roomErr || !room) throw new Error(`createRoom: ${roomErr?.message}`);
    const generation = room.current_generation as number;
    const roomKey: RoomKey = await generateRoomKey(generation);

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

    // -- Alice sends a message via her own outbound session -------------------
    const aliceSession  = await createOutboundSession(room.id, generation);
    const aliceSnap     = exportSessionSnapshot(aliceSession, alice.userId, alice.deviceId);
    const aliceMsgKey   = await ratchetAndDerive(aliceSession);
    const aliceSessionB64 = await toBase64(aliceSession.sessionId);

    const aliceBlob = await encryptBlobV4<{ text: string }>({
      payload: { text: 'From Alice' }, roomId: room.id, messageKey: aliceMsgKey,
      sessionId: aliceSession.sessionId, generation,
      senderUserId: alice.userId, senderDeviceId: alice.deviceId,
      senderDeviceEd25519PrivateKey: alice.bundle.ed25519PrivateKey,
    });
    await svc.from('megolm_sessions').upsert({
      session_id: aliceSessionB64, room_id: room.id,
      sender_user_id: alice.userId, sender_device_id: alice.deviceId,
      generation, message_count: 1,
    });
    const { data: aliceBlobRow } = await aliceUser.supabase.from('blobs').insert({
      room_id: room.id, sender_id: alice.userId, sender_device_id: alice.deviceId,
      generation: aliceBlob.generation, nonce: await toBase64(aliceBlob.nonce),
      ciphertext: await toBase64(aliceBlob.ciphertext), signature: null,
      session_id: aliceBlob.sessionId, message_index: aliceBlob.messageIndex,
    }).select('*').single();

    // -- Bob sends a message via his own outbound session ---------------------
    const bobSession    = await createOutboundSession(room.id, generation);
    const bobSnap       = exportSessionSnapshot(bobSession, bob.userId, bob.deviceId);
    const bobMsgKey     = await ratchetAndDerive(bobSession);
    const bobSessionB64 = await toBase64(bobSession.sessionId);

    const bobBlob = await encryptBlobV4<{ text: string }>({
      payload: { text: 'From Bob' }, roomId: room.id, messageKey: bobMsgKey,
      sessionId: bobSession.sessionId, generation,
      senderUserId: bob.userId, senderDeviceId: bob.deviceId,
      senderDeviceEd25519PrivateKey: bob.bundle.ed25519PrivateKey,
    });
    await svc.from('megolm_sessions').upsert({
      session_id: bobSessionB64, room_id: room.id,
      sender_user_id: bob.userId, sender_device_id: bob.deviceId,
      generation, message_count: 1,
    });
    const { data: bobBlobRow } = await bobUser.supabase.from('blobs').insert({
      room_id: room.id, sender_id: bob.userId, sender_device_id: bob.deviceId,
      generation: bobBlob.generation, nonce: await toBase64(bobBlob.nonce),
      ciphertext: await toBase64(bobBlob.ciphertext), signature: null,
      session_id: bobBlob.sessionId, message_index: bobBlob.messageIndex,
    }).select('*').single();

    // -- Share both sessions with Carol ---------------------------------------
    async function shareSession(
      snapshot: ReturnType<typeof exportSessionSnapshot>,
      senderDeviceId: string, senderEdPriv: Uint8Array, sessionIdB64: string,
    ) {
      const sealed = await sealSessionSnapshot(snapshot, carol.bundle.x25519PublicKey);
      const sig    = await signSessionShare({
        sessionId: snapshot.sessionId, recipientDeviceId: carol.deviceId,
        sealedSnapshot: sealed, signerDeviceId: senderDeviceId,
        signerEd25519Priv: senderEdPriv,
      });
      await svc.from('megolm_session_shares').insert({
        session_id: sessionIdB64, recipient_device_id: carol.deviceId,
        sealed_snapshot: await toBase64(sealed), start_index: snapshot.startIndex,
        signer_device_id: senderDeviceId, share_signature: await toBase64(sig),
      });
    }
    await shareSession(aliceSnap, alice.deviceId, alice.bundle.ed25519PrivateKey, aliceSessionB64);
    await shareSession(bobSnap,   bob.deviceId,   bob.bundle.ed25519PrivateKey,   bobSessionB64);

    // -- Carol decrypts Alice's message ---------------------------------------
    async function carolDecrypt(
      blobRow: Record<string, unknown>, sessionIdB64: string, senderEdPub: Uint8Array,
    ): Promise<string> {
      const { data: shareRow } = await carolUser.supabase
        .from('megolm_session_shares').select('sealed_snapshot')
        .eq('session_id', sessionIdB64).eq('recipient_device_id', carol.deviceId).single();
      if (!shareRow) throw new Error(`Carol has no share for session ${sessionIdB64.slice(0,8)}…`);
      const snap = await unsealSessionSnapshot(
        await fromBase64((shareRow as { sealed_snapshot: string }).sealed_snapshot),
        carol.bundle.x25519PublicKey, carol.bundle.x25519PrivateKey,
      );
      const row = blobRow as {
        nonce: string; ciphertext: string; generation: number;
        session_id: string | null; message_index: number | null;
      };
      const mk = await deriveMessageKeyAtIndex(snap, row.message_index!);
      const wireBlob: EncryptedBlob = {
        nonce: await fromBase64(row.nonce), ciphertext: await fromBase64(row.ciphertext),
        signature: new Uint8Array(0), generation: row.generation,
        sessionId: row.session_id, messageIndex: row.message_index,
      };
      const { payload } = await decryptBlob<{ text: string }>({
        blob: wireBlob, roomId: room.id, roomKey,
        resolveSenderDeviceEd25519Pub: async () => senderEdPub,
        resolveMegolmKey: async () => mk.key,
      });
      return payload.text;
    }

    const aliceText = await carolDecrypt(aliceBlobRow as any, aliceSessionB64, alice.bundle.ed25519PublicKey);
    if (aliceText !== 'From Alice') throw new Error(`Alice text mismatch: "${aliceText}"`);

    const bobText = await carolDecrypt(bobBlobRow as any, bobSessionB64, bob.bundle.ed25519PublicKey);
    if (bobText !== 'From Bob') throw new Error(`Bob text mismatch: "${bobText}"`);

    // -- Verify sessions are independent (different IDs) ----------------------
    if (aliceSessionB64 === bobSessionB64) {
      throw new Error('Alice and Bob have the same session ID — sessions are not independent');
    }

    // -- Key isolation: Alice's msg key does NOT decrypt Bob's blob -----------
    const aliceKeyForIndex0 = await deriveMessageKeyAtIndex(aliceSnap, 0);
    const bRow = bobBlobRow as {
      nonce: string; ciphertext: string; generation: number;
      session_id: string | null; message_index: number | null;
    };
    const bobWireBlob: EncryptedBlob = {
      nonce: await fromBase64(bRow.nonce), ciphertext: await fromBase64(bRow.ciphertext),
      signature: new Uint8Array(0), generation: bRow.generation,
      sessionId: bRow.session_id, messageIndex: bRow.message_index,
    };
    try {
      await decryptBlob<{ text: string }>({
        blob: bobWireBlob, roomId: room.id, roomKey,
        resolveSenderDeviceEd25519Pub: async () => bob.bundle.ed25519PublicKey,
        resolveMegolmKey: async () => aliceKeyForIndex0.key,
      });
      throw new Error('Vulnerability: Alice\'s session key decrypted Bob\'s message — per-sender isolation broken');
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Vulnerability')) throw err;
      // Expected: AEAD failure
    }

    console.log('PASS: Per-sender isolation — Carol decrypts both; Alice key cannot decrypt Bob\'s message ✓');
  } finally {
    for (const id of userIds) await cleanupUser(id).catch(console.error);
  }
}

run().catch((err) => { console.error('FAIL:', err); process.exit(1); });
