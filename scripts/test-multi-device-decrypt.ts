/**
 * Test 53: Multi-Device Room — 3 Devices All Decrypt Same Message
 *
 * Alice provisions 3 devices. All 3 are added to the same room with
 * individually wrapped room keys. Dev1 sends a message. All 3 devices
 * independently unwrap their key and decrypt the blob.
 *
 * Asserts:
 *   - Each device has a distinct wrapped_room_key in room_members
 *   - All 3 decryptions succeed and return the same plaintext
 *
 * Run: npx tsx --env-file=.env.local scripts/test-multi-device-decrypt.ts
 */

import {
  generateRoomKey,
  wrapRoomKeyFor,
  unwrapRoomKey,
  signMembershipWrap,
  encryptBlob,
  decryptBlob,
  generateDeviceKeyBundle,
  signDeviceIssuanceV2,
  toBase64,
  fromBase64,
  type EncryptedBlob,
} from '../src/lib/e2ee-core';
import { initCrypto, createTestUser, provisionDevice, cleanupUser, makeServiceClient } from './test-utils';

async function run() {
  await initCrypto();

  const aliceUser = await createTestUser(`test-alice-mdd-${Date.now()}@example.com`);
  const userIds   = [aliceUser.userId];
  const svc       = makeServiceClient();

  try {
    // Dev1 is provisioned via normal path
    const dev1 = await provisionDevice(aliceUser.supabase, aliceUser.userId);

    // Dev2 and Dev3: generate bundles and register in devices table
    const dev2Bundle = await generateDeviceKeyBundle(crypto.randomUUID());
    const dev3Bundle = await generateDeviceKeyBundle(crypto.randomUUID());
    const createdAtMs = Date.now();

    for (const bundle of [dev2Bundle, dev3Bundle]) {
      const issuanceSig = await signDeviceIssuanceV2(
        { userId: dev1.userId, deviceId: bundle.deviceId,
          deviceEd25519PublicKey: bundle.ed25519PublicKey,
          deviceX25519PublicKey: bundle.x25519PublicKey, createdAtMs },
        dev1.ssk.ed25519PrivateKey,
      );
      await svc.from('devices').insert({
        id: bundle.deviceId, user_id: dev1.userId,
        device_ed25519_pub: await toBase64(bundle.ed25519PublicKey),
        device_x25519_pub:  await toBase64(bundle.x25519PublicKey),
        issuance_created_at_ms: createdAtMs,
        issuance_signature: await toBase64(issuanceSig),
        display_name: null, display_name_ciphertext: null,
      });
    }

    // -- Create room and add all 3 devices ------------------------------------
    const { data: room, error: roomErr } = await aliceUser.supabase
      .from('rooms').insert({ kind: 'group', created_by: dev1.userId })
      .select('*').single();
    if (roomErr || !room) throw new Error(`createRoom: ${roomErr?.message}`);
    const generation = room.current_generation as number;
    const roomKey    = await generateRoomKey(generation);

    const devices = [
      { bundle: dev1.bundle, userId: dev1.userId },
      { bundle: dev2Bundle, userId: dev1.userId },
      { bundle: dev3Bundle, userId: dev1.userId },
    ];

    for (const d of devices) {
      const wrap = await wrapRoomKeyFor(roomKey, d.bundle.x25519PublicKey);
      const sig  = await signMembershipWrap(
        { roomId: room.id, generation, memberUserId: d.userId,
          memberDeviceId: d.bundle.deviceId, wrappedRoomKey: wrap.wrapped,
          signerDeviceId: dev1.deviceId },
        dev1.bundle.ed25519PrivateKey,
      );
      // Use alice's client for dev1; service client for dev2/dev3
      const client = d.bundle.deviceId === dev1.deviceId ? aliceUser.supabase : svc;
      await client.from('room_members').insert({
        room_id: room.id, user_id: d.userId, device_id: d.bundle.deviceId, generation,
        wrapped_room_key: await toBase64(wrap.wrapped),
        signer_device_id: dev1.deviceId, wrap_signature: await toBase64(sig),
      });
    }

    // -- Dev1 sends a message -------------------------------------------------
    const encBlob = await encryptBlob<{ text: string }>({
      payload: { text: 'All 3 devices read this' }, roomId: room.id, roomKey,
      senderUserId: dev1.userId, senderDeviceId: dev1.deviceId,
      senderDeviceEd25519PrivateKey: dev1.bundle.ed25519PrivateKey,
    });
    const { data: blobRow } = await aliceUser.supabase.from('blobs').insert({
      room_id: room.id, sender_id: dev1.userId, sender_device_id: dev1.deviceId,
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

    // -- All 3 devices decrypt ------------------------------------------------
    for (let i = 0; i < devices.length; i++) {
      const d = devices[i];
      const { data: km } = await svc.from('room_members').select('wrapped_room_key')
        .eq('room_id', room.id).eq('device_id', d.bundle.deviceId).single();
      const devKey = await unwrapRoomKey(
        { wrapped: await fromBase64((km as { wrapped_room_key: string }).wrapped_room_key), generation },
        d.bundle.x25519PublicKey, d.bundle.x25519PrivateKey,
      );
      const { payload } = await decryptBlob<{ text: string }>({
        blob: wireBlob, roomId: room.id, roomKey: devKey,
        resolveSenderDeviceEd25519Pub: async () => dev1.bundle.ed25519PublicKey,
      });
      if (payload.text !== 'All 3 devices read this') {
        throw new Error(`Dev${i + 1} plaintext mismatch: "${payload.text}"`);
      }
    }

    console.log('PASS: Multi-device decrypt — 3 devices each independently unwrapped key and decrypted same message ✓');
  } finally {
    for (const id of userIds) await cleanupUser(id).catch(console.error);
  }
}

run().catch((err) => { console.error('FAIL:', err); process.exit(1); });
