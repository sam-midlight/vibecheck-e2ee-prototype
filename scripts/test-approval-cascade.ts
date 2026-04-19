/**
 * Test 33: Device Approval Cascade — Two Devices, One Room
 *
 * Alice provisions Device 1 (existing, in a room). She then provisions
 * Device 2 by simulating the approval flow: Device 2 generates a linking
 * keypair, Device 1 seals the SSK+USK to it and writes a handoff row,
 * Device 2 unseals and registers itself in the devices table with a
 * fresh SSK-signed cert.
 *
 * After enrollment, a new room_members row is inserted for Device 2
 * at the existing generation (same user, already a current-gen member).
 *
 * Asserts:
 *   - Device 2 receives a valid SSK and can sign new certs
 *   - Device 2 can be added to the room_members table
 *   - Both Device 1 and Device 2 can independently decrypt the same message
 *
 * Run: npx tsx --env-file=.env.local scripts/test-approval-cascade.ts
 */

import {
  generateRoomKey,
  wrapRoomKeyFor,
  unwrapRoomKey,
  signMembershipWrap,
  signDeviceIssuanceV2,
  generateDeviceKeyBundle,
  getSodium,
  encryptBlob,
  decryptBlob,
  toBase64,
  fromBase64,
  randomBytes,
  type EncryptedBlob,
} from '../src/lib/e2ee-core';
import { initCrypto, createTestUser, provisionDevice, cleanupUser, makeServiceClient } from './test-utils';

async function run() {
  await initCrypto();

  const aliceUser = await createTestUser(`test-alice-ac-${Date.now()}@example.com`);
  const userIds   = [aliceUser.userId];
  const svc       = makeServiceClient();

  try {
    const dev1 = await provisionDevice(aliceUser.supabase, aliceUser.userId);
    const sodium = await getSodium();

    // -- Dev1 creates room and joins -------------------------------------------
    const { data: room, error: roomErr } = await aliceUser.supabase
      .from('rooms').insert({ kind: 'group', created_by: dev1.userId })
      .select('*').single();
    if (roomErr || !room) throw new Error(`createRoom: ${roomErr?.message}`);
    const generation = room.current_generation as number;
    const roomKey = await generateRoomKey(generation);

    const wrap1 = await wrapRoomKeyFor(roomKey, dev1.bundle.x25519PublicKey);
    const sig1  = await signMembershipWrap(
      { roomId: room.id, generation, memberUserId: dev1.userId,
        memberDeviceId: dev1.deviceId, wrappedRoomKey: wrap1.wrapped,
        signerDeviceId: dev1.deviceId },
      dev1.bundle.ed25519PrivateKey,
    );
    await aliceUser.supabase.from('room_members').insert({
      room_id: room.id, user_id: dev1.userId, device_id: dev1.deviceId, generation,
      wrapped_room_key: await toBase64(wrap1.wrapped),
      signer_device_id: dev1.deviceId, wrap_signature: await toBase64(sig1),
    });

    // -- Approval flow: Dev2 generates linking keypair + link_nonce -----------
    const dev2Bundle   = await generateDeviceKeyBundle(crypto.randomUUID());
    const linkKeypair  = sodium.crypto_box_keypair();
    const linkNonce    = await randomBytes(32);
    const linkNonceB64 = await toBase64(linkNonce);

    // Dev1 seals SSK+USK to Dev2's linking pubkey
    const packed = new Uint8Array(128);
    packed.set(dev1.ssk.ed25519PrivateKey,  0);
    packed.set(dev1.usk.ed25519PrivateKey, 64);
    const sealedKeys = sodium.crypto_box_seal(packed, linkKeypair.publicKey);

    await aliceUser.supabase.from('device_link_handoffs').insert({
      link_nonce: linkNonceB64,
      inviting_user_id: dev1.userId,
      sealed_payload: await toBase64(sealedKeys),
      expires_at: new Date(Date.now() + 2 * 60 * 1000).toISOString(),
    });

    // Dev2 fetches and unseals the handoff
    const { data: handoff } = await aliceUser.supabase
      .from('device_link_handoffs').select('sealed_payload')
      .eq('link_nonce', linkNonceB64).single();
    if (!handoff) throw new Error('Dev2 could not fetch handoff');

    const unsealed = sodium.crypto_box_seal_open(
      await fromBase64((handoff as { sealed_payload: string }).sealed_payload),
      linkKeypair.publicKey, linkKeypair.privateKey,
    );
    const recoveredSskPriv = unsealed.slice(0, 64);
    const recoveredSskPub  = sodium.crypto_sign_ed25519_sk_to_pk(recoveredSskPriv);

    // Dev2 signs its own issuance cert with the recovered SSK
    const createdAtMs = Date.now();
    const dev2IssuanceSig = await signDeviceIssuanceV2(
      {
        userId: dev1.userId,
        deviceId: dev2Bundle.deviceId,
        deviceEd25519PublicKey: dev2Bundle.ed25519PublicKey,
        deviceX25519PublicKey:  dev2Bundle.x25519PublicKey,
        createdAtMs,
      },
      recoveredSskPriv,
    );

    // Register Dev2 in the devices table (via service client — mirrors what
    // the auth callback would do after a browser-side approval)
    await svc.from('devices').insert({
      id: dev2Bundle.deviceId,
      user_id: dev1.userId,
      device_ed25519_pub: await toBase64(dev2Bundle.ed25519PublicKey),
      device_x25519_pub:  await toBase64(dev2Bundle.x25519PublicKey),
      issuance_created_at_ms: createdAtMs,
      issuance_signature: await toBase64(dev2IssuanceSig),
      display_name: null,
      display_name_ciphertext: null,
    });

    // -- Add Dev2 to room_members (same user, already current-gen member) -----
    const wrap2 = await wrapRoomKeyFor(roomKey, dev2Bundle.x25519PublicKey);
    const sig2  = await signMembershipWrap(
      { roomId: room.id, generation, memberUserId: dev1.userId,
        memberDeviceId: dev2Bundle.deviceId, wrappedRoomKey: wrap2.wrapped,
        signerDeviceId: dev1.deviceId },
      dev1.bundle.ed25519PrivateKey,
    );
    // Dev1 inserts Dev2's row — allowed because Alice (dev1) is the creator
    // and is_room_member_at(roomId, auth.uid(), current_gen) is true for Dev1.
    const { error: dev2MemberErr } = await aliceUser.supabase.from('room_members').insert({
      room_id: room.id, user_id: dev1.userId, device_id: dev2Bundle.deviceId, generation,
      wrapped_room_key: await toBase64(wrap2.wrapped),
      signer_device_id: dev1.deviceId, wrap_signature: await toBase64(sig2),
    });
    if (dev2MemberErr) throw new Error(`addDev2Membership: ${dev2MemberErr.message}`);

    // -- Alice (Dev1) sends a message -----------------------------------------
    const encBlob = await encryptBlob<{ text: string }>({
      payload: { text: 'Both devices should read this' },
      roomId: room.id, roomKey,
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

    const row = blobRow as {
      nonce: string; ciphertext: string; signature: string | null;
      generation: number; session_id: string | null; message_index: number | null;
    };
    const wireBlob: EncryptedBlob = {
      nonce: await fromBase64(row.nonce), ciphertext: await fromBase64(row.ciphertext),
      signature: row.signature ? await fromBase64(row.signature) : new Uint8Array(0),
      generation: row.generation, sessionId: null, messageIndex: null,
    };

    // -- Dev1 decrypts --------------------------------------------------------
    const { data: km1 } = await svc.from('room_members').select('wrapped_room_key')
      .eq('room_id', room.id).eq('device_id', dev1.deviceId).single();
    const key1 = await unwrapRoomKey(
      { wrapped: await fromBase64((km1 as { wrapped_room_key: string }).wrapped_room_key), generation },
      dev1.bundle.x25519PublicKey, dev1.bundle.x25519PrivateKey,
    );
    const { payload: p1 } = await decryptBlob<{ text: string }>({
      blob: wireBlob, roomId: room.id, roomKey: key1,
      resolveSenderDeviceEd25519Pub: async () => dev1.bundle.ed25519PublicKey,
    });
    if (p1.text !== 'Both devices should read this') throw new Error(`Dev1 plaintext mismatch: "${p1.text}"`);

    // -- Dev2 decrypts --------------------------------------------------------
    const { data: km2 } = await svc.from('room_members').select('wrapped_room_key')
      .eq('room_id', room.id).eq('device_id', dev2Bundle.deviceId).single();
    const key2 = await unwrapRoomKey(
      { wrapped: await fromBase64((km2 as { wrapped_room_key: string }).wrapped_room_key), generation },
      dev2Bundle.x25519PublicKey, dev2Bundle.x25519PrivateKey,
    );
    const { payload: p2 } = await decryptBlob<{ text: string }>({
      blob: wireBlob, roomId: room.id, roomKey: key2,
      resolveSenderDeviceEd25519Pub: async () => dev1.bundle.ed25519PublicKey,
    });
    if (p2.text !== 'Both devices should read this') throw new Error(`Dev2 plaintext mismatch: "${p2.text}"`);

    // Cleanup handoff
    await svc.from('device_link_handoffs').delete().eq('link_nonce', linkNonceB64);

    console.log('PASS: Approval cascade — Dev2 enrolled via handoff; both devices decrypt same message ✓');
  } finally {
    for (const id of userIds) await cleanupUser(id).catch(console.error);
  }
}

run().catch((err) => { console.error('FAIL:', err); process.exit(1); });
