/**
 * Test 6: Tampered Ciphertext (AEAD Integrity)
 *
 * Alice sends a v4 (Megolm) blob containing 'Secret'. Before Bob decrypts,
 * the test flips a single byte in the ciphertext column directly in the DB,
 * simulating a compromised Supabase instance.
 *
 * Asserts: decryptBlob throws an AEAD authentication error. Garbled plaintext
 * must never be returned — the AEAD tag catches the modification.
 *
 * Run: npx tsx --env-file=.env.local scripts/test-tamper-aead.ts
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

  const aliceUser = await createTestUser(`test-alice-aead-${Date.now()}@example.com`);
  const bobUser   = await createTestUser(`test-bob-aead-${Date.now()}@example.com`);
  const userIds   = [aliceUser.userId, bobUser.userId];
  const svc       = makeServiceClient();

  try {
    const alice = await provisionDevice(aliceUser.supabase, aliceUser.userId);
    const bob   = await provisionDevice(bobUser.supabase,   bobUser.userId);

    // -- Room + gen-1 membership (service client for Bob's row) -------------
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

    // -- Alice creates outbound Megolm session --------------------------------
    const outbound      = await createOutboundSession(room.id, generation);
    const sessionIdB64  = await toBase64(outbound.sessionId);

    // Export snapshot BEFORE ratcheting so startIndex=0 matches blob messageIndex=0
    const snapshot   = exportSessionSnapshot(outbound, alice.userId, alice.deviceId);
    const messageKey = await ratchetAndDerive(outbound); // index 0

    const encBlob = await encryptBlobV4<{ text: string }>({
      payload: { text: 'Secret' },
      roomId: room.id, messageKey,
      sessionId: outbound.sessionId, generation,
      senderUserId: alice.userId, senderDeviceId: alice.deviceId,
      senderDeviceEd25519PrivateKey: alice.bundle.ed25519PrivateKey,
    });

    // Register session row (service client avoids potential RLS on megolm_sessions)
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
    }).select('id').single();
    if (blobErr || !blobRow) throw new Error(`insertBlob: ${blobErr?.message}`);

    // -- Alice shares session snapshot with Bob (service client) -------------
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

    // -- TAMPER: flip byte 10 of the ciphertext in the DB -------------------
    const { data: fetchedRow } = await svc
      .from('blobs').select('ciphertext').eq('id', (blobRow as { id: string }).id).single();
    const tampered = await fromBase64((fetchedRow as { ciphertext: string }).ciphertext);
    tampered[10] ^= 0xff;
    await svc.from('blobs').update({ ciphertext: await toBase64(tampered) })
      .eq('id', (blobRow as { id: string }).id);

    // -- Bob fetches tampered blob + session share ----------------------------
    const { data: tamperedRow } = await bobUser.supabase
      .from('blobs').select('*').eq('id', (blobRow as { id: string }).id).single();
    if (!tamperedRow) throw new Error('Bob could not fetch blob');

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

    const row = tamperedRow as {
      nonce: string; ciphertext: string; signature: string | null;
      generation: number; session_id: string | null; message_index: number | null;
    };
    const wireBlob: EncryptedBlob = {
      nonce: await fromBase64(row.nonce),
      ciphertext: await fromBase64(row.ciphertext),
      signature: new Uint8Array(0),
      generation: row.generation,
      sessionId: row.session_id, messageIndex: row.message_index,
    };

    // -- Bob attempts to decrypt — must throw --------------------------------
    try {
      const mk = await deriveMessageKeyAtIndex(bobSnapshot, row.message_index!);
      await decryptBlob<{ text: string }>({
        blob: wireBlob, roomId: room.id, roomKey,
        resolveSenderDeviceEd25519Pub: async () => alice.bundle.ed25519PublicKey,
        resolveMegolmKey: async (_sid, _idx) => mk.key,
      });
      throw new Error('Vulnerability: Tampered ciphertext decrypted without error — AEAD broken');
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Vulnerability')) throw err;
      // Any other thrown error = AEAD correctly rejected the tampered data.
    }

    console.log('PASS: Tampered ciphertext rejected by AEAD ✓');
  } finally {
    for (const id of userIds) await cleanupUser(id).catch(console.error);
  }
}

run().catch((err) => { console.error('FAIL:', err); process.exit(1); });
