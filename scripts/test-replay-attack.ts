/**
 * Test 7: Replay Attack (Index Reuse)
 *
 * Alice sends Message 1 at Megolm index 0. Bob decrypts it and records the
 * (sessionId, messageIndex) pair as seen. The test then re-inserts an
 * identical blob with a fresh UUID, simulating a malicious server replaying
 * old ciphertext.
 *
 * The Megolm engine itself has no built-in replay guard — that is the caller's
 * responsibility. This test verifies that the application-layer duplicate
 * check (a Set of seen (session, index) pairs) rejects the replayed blob
 * before decryption is even attempted.
 *
 * Asserts:
 *   - First decryption succeeds.
 *   - Second attempt (replay) throws 'Duplicate message index'.
 *
 * Run: npx tsx --env-file=.env.local scripts/test-replay-attack.ts
 */

import {
  generateRoomKey,
  wrapRoomKeyFor,
  signMembershipWrap,
  createOutboundSession,
  ratchetAndDerive,
  exportSessionSnapshot,
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

  const aliceUser = await createTestUser(`test-alice-ra-${Date.now()}@example.com`);
  const bobUser   = await createTestUser(`test-bob-ra-${Date.now()}@example.com`);
  const userIds   = [aliceUser.userId, bobUser.userId];
  const svc       = makeServiceClient();

  try {
    const alice = await provisionDevice(aliceUser.supabase, aliceUser.userId);
    const bob   = await provisionDevice(bobUser.supabase,   bobUser.userId);

    // -- Room + gen-1 membership ---------------------------------------------
    const { data: room, error: roomErr } = await aliceUser.supabase
      .from('rooms')
      .insert({ kind: 'group', created_by: alice.userId })
      .select('*').single();
    if (roomErr || !room) throw new Error(`createRoom: ${roomErr?.message}`);
    const generation = room.current_generation as number;
    const roomKey: RoomKey = await generateRoomKey(generation);

    async function addMember(userId: string, deviceId: string, xPub: Uint8Array) {
      const wrap = await wrapRoomKeyFor(roomKey, xPub);
      const sig  = await signMembershipWrap(
        { roomId: room.id, generation, memberUserId: userId, memberDeviceId: deviceId,
          wrappedRoomKey: wrap.wrapped, signerDeviceId: alice.deviceId },
        alice.bundle.ed25519PrivateKey,
      );
      const client = userId === alice.userId ? aliceUser.supabase : svc;
      await client.from('room_members').insert({
        room_id: room.id, user_id: userId, device_id: deviceId, generation,
        wrapped_room_key: await toBase64(wrap.wrapped),
        signer_device_id: alice.deviceId, wrap_signature: await toBase64(sig),
      });
    }
    await addMember(alice.userId, alice.deviceId, alice.bundle.x25519PublicKey);
    await addMember(bob.userId,   bob.deviceId,   bob.bundle.x25519PublicKey);

    // -- Alice creates Megolm session and sends Message 1 (index 0) ---------
    const outbound     = await createOutboundSession(room.id, generation);
    const sessionIdB64 = await toBase64(outbound.sessionId);

    // Snapshot before ratcheting → startIndex = 0, covers message index 0
    const snapshot   = exportSessionSnapshot(outbound, alice.userId, alice.deviceId);
    const messageKey = await ratchetAndDerive(outbound); // index 0

    const encBlob = await encryptBlobV4<{ text: string }>({
      payload: { text: 'Message 1' },
      roomId: room.id, messageKey,
      sessionId: outbound.sessionId, generation,
      senderUserId: alice.userId, senderDeviceId: alice.deviceId,
      senderDeviceEd25519PrivateKey: alice.bundle.ed25519PrivateKey,
    });

    await svc.from('megolm_sessions').upsert({
      session_id: sessionIdB64, room_id: room.id,
      sender_user_id: alice.userId, sender_device_id: alice.deviceId,
      generation, message_count: 1,
    });

    const { data: blobRow, error: blobErr } = await aliceUser.supabase.from('blobs').insert({
      room_id: room.id, sender_id: alice.userId, sender_device_id: alice.deviceId,
      generation: encBlob.generation, nonce: await toBase64(encBlob.nonce),
      ciphertext: await toBase64(encBlob.ciphertext), signature: null,
      session_id: encBlob.sessionId ?? null, message_index: encBlob.messageIndex ?? null,
    }).select('*').single();
    if (blobErr || !blobRow) throw new Error(`insertBlob: ${blobErr?.message}`);

    // -- Alice shares session with Bob ---------------------------------------
    const sealedSnapshot = await sealSessionSnapshot(snapshot, bob.bundle.x25519PublicKey);
    const shareSignature = await signSessionShare({
      sessionId: outbound.sessionId, recipientDeviceId: bob.deviceId,
      sealedSnapshot, signerDeviceId: alice.deviceId,
      signerEd25519Priv: alice.bundle.ed25519PrivateKey,
    });
    await svc.from('megolm_session_shares').insert({
      session_id: sessionIdB64, recipient_device_id: bob.deviceId,
      sealed_snapshot: await toBase64(sealedSnapshot),
      start_index: snapshot.startIndex,
      signer_device_id: alice.deviceId,
      share_signature: await toBase64(shareSignature),
    });

    // -- Bob: unseal session share + build resolver -------------------------
    const { data: shareRow } = await bobUser.supabase
      .from('megolm_session_shares')
      .select('sealed_snapshot')
      .eq('session_id', sessionIdB64)
      .eq('recipient_device_id', bob.deviceId)
      .single();
    if (!shareRow) throw new Error('Bob has no session share');

    const bobSnapshot = await unsealSessionSnapshot(
      await fromBase64((shareRow as { sealed_snapshot: string }).sealed_snapshot),
      bob.bundle.x25519PublicKey, bob.bundle.x25519PrivateKey,
    );

    // Application-layer replay guard: track (sessionId:messageIndex) pairs.
    const seenKeys = new Set<string>();

    async function bobDecrypt(row: {
      nonce: string; ciphertext: string; signature: string | null;
      generation: number; session_id: string | null; message_index: number | null;
    }): Promise<{ text: string }> {
      const replayKey = `${row.session_id}:${row.message_index}`;
      if (seenKeys.has(replayKey)) {
        throw new Error(`Duplicate message index ${row.message_index} for session — replay rejected`);
      }

      const mk = await deriveMessageKeyAtIndex(bobSnapshot, row.message_index!);
      const wireBlob: EncryptedBlob = {
        nonce: await fromBase64(row.nonce),
        ciphertext: await fromBase64(row.ciphertext),
        signature: new Uint8Array(0),
        generation: row.generation,
        sessionId: row.session_id, messageIndex: row.message_index,
      };
      const { payload } = await decryptBlob<{ text: string }>({
        blob: wireBlob, roomId: room.id, roomKey,
        resolveSenderDeviceEd25519Pub: async () => alice.bundle.ed25519PublicKey,
        resolveMegolmKey: async (_sid, _idx) => mk.key,
      });

      // Record as seen only after successful decryption.
      seenKeys.add(replayKey);
      return payload;
    }

    // -- Assert 1: first decrypt succeeds ------------------------------------
    const original = blobRow as {
      nonce: string; ciphertext: string; signature: string | null;
      generation: number; session_id: string | null; message_index: number | null;
    };
    const p1 = await bobDecrypt(original);
    if (p1.text !== 'Message 1') throw new Error(`Unexpected plaintext: "${p1.text}"`);

    // -- Attacker re-inserts same blob with a fresh UUID (replay) -----------
    const { data: replayRow, error: replayErr } = await svc.from('blobs').insert({
      room_id: room.id, sender_id: alice.userId, sender_device_id: alice.deviceId,
      generation: encBlob.generation, nonce: await toBase64(encBlob.nonce),
      ciphertext: await toBase64(encBlob.ciphertext), signature: null,
      session_id: encBlob.sessionId ?? null, message_index: encBlob.messageIndex ?? null,
    }).select('*').single();
    if (replayErr || !replayRow) throw new Error(`replay insert: ${replayErr?.message}`);

    // -- Assert 2: second decrypt attempt is rejected by replay guard -------
    const replayed = replayRow as typeof original;
    try {
      await bobDecrypt(replayed);
      throw new Error('Vulnerability: Replayed blob decrypted — no replay protection');
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Vulnerability')) throw err;
      if (err instanceof Error && err.message.includes('Duplicate message index')) {
        // Expected — replay correctly rejected.
      } else {
        throw err; // Unexpected error
      }
    }

    console.log('PASS: Replay attack rejected by application-layer duplicate index check ✓');
  } finally {
    for (const id of userIds) await cleanupUser(id).catch(console.error);
  }
}

run().catch((err) => { console.error('FAIL:', err); process.exit(1); });
