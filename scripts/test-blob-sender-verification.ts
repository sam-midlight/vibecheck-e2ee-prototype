/**
 * Test 56: Blob Sender Signature Verification
 *
 * Alice sends a signed blob. decryptBlob with Alice's correct ed25519 pub
 * succeeds. Re-calling with an impostor's ed25519 pub must throw
 * SIGNATURE_INVALID (or equivalent). Ensures the signature check in
 * decryptBlob is actually enforced, not silently skipped on wrong pubkey.
 *
 * Asserts:
 *   - Correct sender pub decrypts without error
 *   - Impostor sender pub causes decryptBlob to throw
 *
 * Run: npx tsx --env-file=.env.local scripts/test-blob-sender-verification.ts
 */

import {
  generateRoomKey,
  wrapRoomKeyFor,
  signMembershipWrap,
  encryptBlob,
  decryptBlob,
  generateDeviceKeyBundle,
  toBase64,
  fromBase64,
  type EncryptedBlob,
} from '../src/lib/e2ee-core';
import { initCrypto, createTestUser, provisionDevice, cleanupUser, makeServiceClient } from './test-utils';

async function run() {
  await initCrypto();

  const aliceUser = await createTestUser(`test-alice-bsv-${Date.now()}@example.com`);
  const userIds   = [aliceUser.userId];
  const svc       = makeServiceClient();

  try {
    const alice = await provisionDevice(aliceUser.supabase, aliceUser.userId);

    // -- Room + membership ----------------------------------------------------
    const { data: room, error: roomErr } = await aliceUser.supabase
      .from('rooms').insert({ kind: 'group', created_by: alice.userId })
      .select('*').single();
    if (roomErr || !room) throw new Error(`createRoom: ${roomErr?.message}`);
    const generation = room.current_generation as number;
    const roomKey    = await generateRoomKey(generation);

    const wrap = await wrapRoomKeyFor(roomKey, alice.bundle.x25519PublicKey);
    const sig  = await signMembershipWrap(
      { roomId: room.id, generation, memberUserId: alice.userId,
        memberDeviceId: alice.deviceId, wrappedRoomKey: wrap.wrapped,
        signerDeviceId: alice.deviceId },
      alice.bundle.ed25519PrivateKey,
    );
    await aliceUser.supabase.from('room_members').insert({
      room_id: room.id, user_id: alice.userId, device_id: alice.deviceId, generation,
      wrapped_room_key: await toBase64(wrap.wrapped),
      signer_device_id: alice.deviceId, wrap_signature: await toBase64(sig),
    });

    // -- Alice sends a signed blob --------------------------------------------
    const encBlob = await encryptBlob<{ text: string }>({
      payload: { text: 'signed message' }, roomId: room.id, roomKey,
      senderUserId: alice.userId, senderDeviceId: alice.deviceId,
      senderDeviceEd25519PrivateKey: alice.bundle.ed25519PrivateKey,
    });
    const { data: blobRow } = await aliceUser.supabase.from('blobs').insert({
      room_id: room.id, sender_id: alice.userId, sender_device_id: alice.deviceId,
      generation: encBlob.generation, nonce: await toBase64(encBlob.nonce),
      ciphertext: await toBase64(encBlob.ciphertext),
      signature: encBlob.signature.byteLength > 0 ? await toBase64(encBlob.signature) : null,
      session_id: null, message_index: null,
    }).select('*').single();

    const row = blobRow as { nonce: string; ciphertext: string; signature: string | null; generation: number };
    const wireBlob: EncryptedBlob = {
      nonce: await fromBase64(row.nonce), ciphertext: await fromBase64(row.ciphertext),
      signature: row.signature ? await fromBase64(row.signature) : new Uint8Array(0),
      generation: row.generation, sessionId: null, messageIndex: null,
    };

    // v3 blobs: outer signature field is empty, but the inner envelope contains
    // a device sig. decryptBlob verifies it via resolveSenderDeviceEd25519Pub.

    // -- Correct sender pub succeeds ------------------------------------------
    const { payload } = await decryptBlob<{ text: string }>({
      blob: wireBlob, roomId: room.id, roomKey,
      resolveSenderDeviceEd25519Pub: async () => alice.bundle.ed25519PublicKey,
    });
    if (payload.text !== 'signed message') throw new Error(`Plaintext mismatch: "${payload.text}"`);

    // -- Impostor sender pub throws -------------------------------------------
    const impostorBundle = await generateDeviceKeyBundle(crypto.randomUUID());
    try {
      await decryptBlob<{ text: string }>({
        blob: wireBlob, roomId: room.id, roomKey,
        resolveSenderDeviceEd25519Pub: async () => impostorBundle.ed25519PublicKey,
      });
      throw new Error('Vulnerability: decryptBlob accepted impostor sender pub');
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Vulnerability')) throw err;
      // Expected: SIGNATURE_INVALID or similar
    }

    console.log('PASS: Blob sender verification — correct pub decrypts; impostor pub rejected ✓');
  } finally {
    for (const id of userIds) await cleanupUser(id).catch(console.error);
  }
}

run().catch((err) => { console.error('FAIL:', err); process.exit(1); });
