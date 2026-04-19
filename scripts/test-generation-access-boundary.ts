/**
 * Test 51: Generation-Based Access Boundary
 *
 * Confirms the security model: forward secrecy is per-generation, not per
 * join time. Alice creates a gen-0 room, rotates to gen-1 (evicting no one),
 * then adds Bob at gen-1. Bob has a gen-1 room key but NOT gen-0.
 *
 * Asserts:
 *   - Bob CAN decrypt gen-1 blobs (the generation he joined)
 *   - Bob CANNOT decrypt gen-0 blobs (wrong key — AEAD fails)
 *   - Alice CAN still decrypt gen-0 blobs with her stored gen-0 key
 *
 * Run: npx tsx --env-file=.env.local scripts/test-generation-access-boundary.ts
 */

import {
  generateRoomKey,
  wrapRoomKeyFor,
  unwrapRoomKey,
  signMembershipWrap,
  encryptBlob,
  decryptBlob,
  toBase64,
  fromBase64,
  type EncryptedBlob,
} from '../src/lib/e2ee-core';
import { initCrypto, createTestUser, provisionDevice, cleanupUser, makeServiceClient } from './test-utils';

async function run() {
  await initCrypto();

  const aliceUser = await createTestUser(`test-alice-gab-${Date.now()}@example.com`);
  const bobUser   = await createTestUser(`test-bob-gab-${Date.now()}@example.com`);
  const userIds   = [aliceUser.userId, bobUser.userId];
  const svc       = makeServiceClient();

  try {
    const alice = await provisionDevice(aliceUser.supabase, aliceUser.userId);
    const bob   = await provisionDevice(bobUser.supabase,   bobUser.userId);

    // -- Gen-0: Alice alone ---------------------------------------------------
    const { data: room, error: roomErr } = await aliceUser.supabase
      .from('rooms').insert({ kind: 'group', created_by: alice.userId })
      .select('*').single();
    if (roomErr || !room) throw new Error(`createRoom: ${roomErr?.message}`);
    const gen0 = room.current_generation as number;
    const key0 = await generateRoomKey(gen0);

    const wrap0 = await wrapRoomKeyFor(key0, alice.bundle.x25519PublicKey);
    const sig0  = await signMembershipWrap(
      { roomId: room.id, generation: gen0, memberUserId: alice.userId,
        memberDeviceId: alice.deviceId, wrappedRoomKey: wrap0.wrapped,
        signerDeviceId: alice.deviceId },
      alice.bundle.ed25519PrivateKey,
    );
    await aliceUser.supabase.from('room_members').insert({
      room_id: room.id, user_id: alice.userId, device_id: alice.deviceId, generation: gen0,
      wrapped_room_key: await toBase64(wrap0.wrapped),
      signer_device_id: alice.deviceId, wrap_signature: await toBase64(sig0),
    });

    // -- Alice sends a gen-0 blob ---------------------------------------------
    const gen0Blob = await encryptBlob<{ text: string }>({
      payload: { text: 'gen-0 secret' }, roomId: room.id, roomKey: key0,
      senderUserId: alice.userId, senderDeviceId: alice.deviceId,
      senderDeviceEd25519PrivateKey: alice.bundle.ed25519PrivateKey,
    });
    const { data: gen0Row } = await aliceUser.supabase.from('blobs').insert({
      room_id: room.id, sender_id: alice.userId, sender_device_id: alice.deviceId,
      generation: gen0Blob.generation, nonce: await toBase64(gen0Blob.nonce),
      ciphertext: await toBase64(gen0Blob.ciphertext),
      signature: gen0Blob.signature.byteLength > 0 ? await toBase64(gen0Blob.signature) : null,
      session_id: null, message_index: null,
    }).select('*').single();

    // -- Rotate to gen-1, add Bob ---------------------------------------------
    const gen1 = gen0 + 1;
    const key1 = await generateRoomKey(gen1);
    const wrapAlice1 = await wrapRoomKeyFor(key1, alice.bundle.x25519PublicKey);
    const sigAlice1  = await signMembershipWrap(
      { roomId: room.id, generation: gen1, memberUserId: alice.userId,
        memberDeviceId: alice.deviceId, wrappedRoomKey: wrapAlice1.wrapped,
        signerDeviceId: alice.deviceId },
      alice.bundle.ed25519PrivateKey,
    );
    const wrapBob1 = await wrapRoomKeyFor(key1, bob.bundle.x25519PublicKey);
    const sigBob1  = await signMembershipWrap(
      { roomId: room.id, generation: gen1, memberUserId: bob.userId,
        memberDeviceId: bob.deviceId, wrappedRoomKey: wrapBob1.wrapped,
        signerDeviceId: alice.deviceId },
      alice.bundle.ed25519PrivateKey,
    );
    await aliceUser.supabase.rpc('kick_and_rotate', {
      p_room_id: room.id, p_evictee_user_ids: [],
      p_old_gen: gen0, p_new_gen: gen1,
      p_wraps: [
        { user_id: alice.userId, device_id: alice.deviceId,
          wrapped_room_key: await toBase64(wrapAlice1.wrapped), wrap_signature: await toBase64(sigAlice1) },
        { user_id: bob.userId, device_id: bob.deviceId,
          wrapped_room_key: await toBase64(wrapBob1.wrapped), wrap_signature: await toBase64(sigBob1) },
      ],
      p_signer_device_id: alice.deviceId,
      p_name_ciphertext: null, p_name_nonce: null,
    });

    // -- Alice sends a gen-1 blob ---------------------------------------------
    const gen1Blob = await encryptBlob<{ text: string }>({
      payload: { text: 'gen-1 shared' }, roomId: room.id, roomKey: key1,
      senderUserId: alice.userId, senderDeviceId: alice.deviceId,
      senderDeviceEd25519PrivateKey: alice.bundle.ed25519PrivateKey,
    });
    const { data: gen1Row } = await aliceUser.supabase.from('blobs').insert({
      room_id: room.id, sender_id: alice.userId, sender_device_id: alice.deviceId,
      generation: gen1Blob.generation, nonce: await toBase64(gen1Blob.nonce),
      ciphertext: await toBase64(gen1Blob.ciphertext),
      signature: gen1Blob.signature.byteLength > 0 ? await toBase64(gen1Blob.signature) : null,
      session_id: null, message_index: null,
    }).select('*').single();

    // -- Bob unwraps his gen-1 key from DB ------------------------------------
    const { data: km1 } = await svc.from('room_members').select('wrapped_room_key')
      .eq('room_id', room.id).eq('device_id', bob.deviceId).eq('generation', gen1).single();
    const bobKey1 = await unwrapRoomKey(
      { wrapped: await fromBase64((km1 as { wrapped_room_key: string }).wrapped_room_key), generation: gen1 },
      bob.bundle.x25519PublicKey, bob.bundle.x25519PrivateKey,
    );

    function toWireBlob(row: Record<string, unknown>): EncryptedBlob {
      const r = row as { nonce: string; ciphertext: string; signature: string | null; generation: number };
      return {
        nonce: Buffer.from(r.nonce, 'base64'),
        ciphertext: Buffer.from(r.ciphertext, 'base64'),
        signature: r.signature ? Buffer.from(r.signature, 'base64') : new Uint8Array(0),
        generation: r.generation, sessionId: null, messageIndex: null,
      };
    }

    // -- Bob CAN decrypt gen-1 blob ------------------------------------------
    const { payload: p1 } = await decryptBlob<{ text: string }>({
      blob: toWireBlob(gen1Row as Record<string, unknown>),
      roomId: room.id, roomKey: bobKey1,
      resolveSenderDeviceEd25519Pub: async () => alice.bundle.ed25519PublicKey,
    });
    if (p1.text !== 'gen-1 shared') throw new Error(`Gen-1 plaintext mismatch: "${p1.text}"`);

    // -- Bob CANNOT decrypt gen-0 blob (wrong key) ---------------------------
    try {
      await decryptBlob<{ text: string }>({
        blob: toWireBlob(gen0Row as Record<string, unknown>),
        roomId: room.id, roomKey: bobKey1,
        resolveSenderDeviceEd25519Pub: async () => alice.bundle.ed25519PublicKey,
      });
      throw new Error('Vulnerability: Bob decrypted gen-0 blob with gen-1 key');
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Vulnerability')) throw err;
    }

    // -- Alice CAN still decrypt gen-0 blob with her stored key0 -------------
    const { payload: p0 } = await decryptBlob<{ text: string }>({
      blob: toWireBlob(gen0Row as Record<string, unknown>),
      roomId: room.id, roomKey: key0,
      resolveSenderDeviceEd25519Pub: async () => alice.bundle.ed25519PublicKey,
    });
    if (p0.text !== 'gen-0 secret') throw new Error(`Gen-0 plaintext mismatch: "${p0.text}"`);

    console.log('PASS: Generation access boundary — Bob reads gen-1; blocked from gen-0; Alice reads gen-0 ✓');
  } finally {
    for (const id of userIds) await cleanupUser(id).catch(console.error);
  }
}

run().catch((err) => { console.error('FAIL:', err); process.exit(1); });
