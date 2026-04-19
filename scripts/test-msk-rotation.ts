/**
 * Test 15: MSK Rotation
 *
 * Alice has one device. We simulate an MSK rotation by:
 *   1. Generating a new MSK + SSK + USK + cross-sigs
 *   2. Re-signing Alice's existing device cert with the new SSK
 *   3. Publishing the new identity row (upsert)
 *   4. Updating the device row with the new issuance_signature
 *
 * Asserts:
 *   - The new cross-sig chain verifies (MSK → SSK, MSK → USK)
 *   - The re-signed device cert verifies against the new SSK
 *   - The old MSK pub is no longer in the identities row
 *   - Alice can still decrypt a message encrypted before rotation
 *     (backward compat: old blobs used the room key, not the MSK)
 *
 * Run: npx tsx --env-file=.env.local scripts/test-msk-rotation.ts
 */

import {
  generateUserMasterKey,
  generateSigningKeys,
  signDeviceIssuanceV2,
  verifyCrossSigningChain,
  verifyDeviceIssuance,
  generateRoomKey,
  wrapRoomKeyFor,
  signMembershipWrap,
  encryptBlob,
  decryptBlob,
  unwrapRoomKey,
  toBase64,
  fromBase64,
  type EncryptedBlob,
} from '../src/lib/e2ee-core';
import { initCrypto, createTestUser, provisionDevice, cleanupUser, makeServiceClient } from './test-utils';

async function run() {
  await initCrypto();

  const aliceUser = await createTestUser(`test-alice-mskr-${Date.now()}@example.com`);
  const userIds   = [aliceUser.userId];
  const svc       = makeServiceClient();

  try {
    const alice = await provisionDevice(aliceUser.supabase, aliceUser.userId);

    // -- Alice creates room and sends a message before rotation ----------------
    const { data: room, error: roomErr } = await aliceUser.supabase
      .from('rooms')
      .insert({ kind: 'group', created_by: alice.userId })
      .select('*').single();
    if (roomErr || !room) throw new Error(`createRoom: ${roomErr?.message}`);
    const generation = room.current_generation as number;
    const roomKey = await generateRoomKey(generation);

    const wrap = await wrapRoomKeyFor(roomKey, alice.bundle.x25519PublicKey);
    const sig  = await signMembershipWrap(
      { roomId: room.id, generation, memberUserId: alice.userId,
        memberDeviceId: alice.deviceId, wrappedRoomKey: wrap.wrapped,
        signerDeviceId: alice.deviceId },
      alice.bundle.ed25519PrivateKey,
    );
    await aliceUser.supabase.from('room_members').insert({
      room_id: room.id, user_id: alice.userId, device_id: alice.deviceId,
      generation, wrapped_room_key: await toBase64(wrap.wrapped),
      signer_device_id: alice.deviceId, wrap_signature: await toBase64(sig),
    });

    const preBlob = await encryptBlob<{ text: string }>({
      payload: { text: 'Pre-rotation message' },
      roomId: room.id, roomKey,
      senderUserId: alice.userId, senderDeviceId: alice.deviceId,
      senderDeviceEd25519PrivateKey: alice.bundle.ed25519PrivateKey,
    });
    const { data: blobRow, error: blobErr } = await aliceUser.supabase.from('blobs').insert({
      room_id: room.id, sender_id: alice.userId, sender_device_id: alice.deviceId,
      generation: preBlob.generation, nonce: await toBase64(preBlob.nonce),
      ciphertext: await toBase64(preBlob.ciphertext),
      signature: preBlob.signature.byteLength > 0 ? await toBase64(preBlob.signature) : null,
      session_id: null, message_index: null,
    }).select('*').single();
    if (blobErr || !blobRow) throw new Error(`insertBlob: ${blobErr?.message}`);

    // -- Fetch the existing device row (for cert re-issuance) -----------------
    const { data: deviceRow } = await svc.from('devices').select('*').eq('id', alice.deviceId).single();
    if (!deviceRow) throw new Error('alice device row not found');
    const dr = deviceRow as {
      device_ed25519_pub: string; device_x25519_pub: string; issuance_created_at_ms: number;
    };

    // -- Generate new MSK + SSK + USK + cross-sigs ----------------------------
    const newMsk = await generateUserMasterKey();
    const { ssk: newSsk, usk: newUsk, sskCrossSignature, uskCrossSignature } =
      await generateSigningKeys(newMsk);

    // Re-sign existing device cert with the new SSK (v2)
    const newIssuanceSig = await signDeviceIssuanceV2(
      {
        userId: alice.userId,
        deviceId: alice.deviceId,
        deviceEd25519PublicKey: await fromBase64(dr.device_ed25519_pub),
        deviceX25519PublicKey: await fromBase64(dr.device_x25519_pub),
        createdAtMs: dr.issuance_created_at_ms,
      },
      newSsk.ed25519PrivateKey,
    );

    // Publish new identity (upsert via Alice's authenticated client)
    const { error: idErr } = await aliceUser.supabase.from('identities').upsert({
      user_id: alice.userId,
      ed25519_pub: await toBase64(newMsk.ed25519PublicKey),
      x25519_pub: null,
      self_signature: null,
      ssk_pub: await toBase64(newSsk.ed25519PublicKey),
      ssk_cross_signature: await toBase64(sskCrossSignature),
      usk_pub: await toBase64(newUsk.ed25519PublicKey),
      usk_cross_signature: await toBase64(uskCrossSignature),
      identity_epoch: 1,
    });
    if (idErr) throw new Error(`publishNewIdentity: ${idErr.message}`);

    // Update device cert
    const { error: certErr } = await aliceUser.supabase.from('devices')
      .update({ issuance_signature: await toBase64(newIssuanceSig) })
      .eq('id', alice.deviceId);
    if (certErr) throw new Error(`updateDeviceCert: ${certErr.message}`);

    // -- Verify new cross-signing chain ---------------------------------------
    await verifyCrossSigningChain({
      mskPub: newMsk.ed25519PublicKey,
      sskPub: newSsk.ed25519PublicKey,
      sskCrossSignature,
      uskPub: newUsk.ed25519PublicKey,
      uskCrossSignature,
    });

    // Verify re-issued device cert with the new SSK
    await verifyDeviceIssuance(
      {
        userId: alice.userId,
        deviceId: alice.deviceId,
        deviceEd25519PublicKey: await fromBase64(dr.device_ed25519_pub),
        deviceX25519PublicKey: await fromBase64(dr.device_x25519_pub),
        createdAtMs: dr.issuance_created_at_ms,
      },
      newIssuanceSig,
      newMsk.ed25519PublicKey,
      newSsk.ed25519PublicKey,
    );

    // Confirm old MSK pub is gone from DB
    const { data: idRow } = await svc.from('identities').select('ed25519_pub').eq('user_id', alice.userId).single();
    if (!idRow) throw new Error('identity row gone after rotation');
    const storedMskPub = await fromBase64((idRow as { ed25519_pub: string }).ed25519_pub);
    // Old MSK and new MSK should be different
    if (storedMskPub.every((b, i) => b === alice.msk.ed25519PublicKey[i])) {
      throw new Error('identity row still holds old MSK pub after rotation');
    }

    // -- Alice can still decrypt pre-rotation messages (room key unchanged) ---
    const row = blobRow as {
      nonce: string; ciphertext: string; signature: string | null;
      generation: number; session_id: string | null; message_index: number | null;
    };
    const wireBlob: EncryptedBlob = {
      nonce: await fromBase64(row.nonce),
      ciphertext: await fromBase64(row.ciphertext),
      signature: row.signature ? await fromBase64(row.signature) : new Uint8Array(0),
      generation: row.generation, sessionId: null, messageIndex: null,
    };
    // Unwrap room key using Alice's device X25519 (unchanged)
    const { data: myKey } = await svc.from('room_members')
      .select('wrapped_room_key').eq('room_id', room.id).eq('device_id', alice.deviceId).single();
    const unwrapped = await unwrapRoomKey(
      { wrapped: await fromBase64((myKey as { wrapped_room_key: string }).wrapped_room_key), generation },
      alice.bundle.x25519PublicKey, alice.bundle.x25519PrivateKey,
    );
    const { payload } = await decryptBlob<{ text: string }>({
      blob: wireBlob, roomId: room.id, roomKey: unwrapped,
      // Use OLD device ed pub (device keys didn't change — just the cert's signer changed)
      resolveSenderDeviceEd25519Pub: async () => alice.bundle.ed25519PublicKey,
    });
    if (payload.text !== 'Pre-rotation message') {
      throw new Error(`Plaintext mismatch: "${payload.text}"`);
    }

    console.log('PASS: MSK rotation — new cross-sig chain verifies; re-issued cert verifies; pre-rotation messages still decrypt ✓');
  } finally {
    for (const id of userIds) await cleanupUser(id).catch(console.error);
  }
}

run().catch((err) => { console.error('FAIL:', err); process.exit(1); });
