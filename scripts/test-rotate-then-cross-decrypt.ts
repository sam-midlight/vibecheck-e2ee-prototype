/**
 * Test 34: Rotate-Then-Send Cross-Decrypt
 *
 * Alice and Bob are in a room. Alice kicks Carol and rotates to gen-2.
 * At gen-2, both Alice and Bob send messages. Each must be able to decrypt
 * the other's gen-2 message.
 *
 * Asserts:
 *   - Alice decrypts Bob's gen-2 message
 *   - Bob decrypts Alice's gen-2 message
 *   - Carol has no gen-2 room_members row (already tested in T17, but
 *     here we also confirm she cannot read any gen-2 blobs)
 *
 * Run: npx tsx --env-file=.env.local scripts/test-rotate-then-cross-decrypt.ts
 */

import {
  generateRoomKey,
  wrapRoomKeyFor,
  unwrapRoomKey,
  signMembershipWrap,
  encryptBlob,
  decryptBlob,
  fromBase64,
  toBase64,
  type EncryptedBlob,
  type RoomKey,
} from '../src/lib/e2ee-core';
import { initCrypto, createTestUser, provisionDevice, cleanupUser, makeServiceClient } from './test-utils';

async function run() {
  await initCrypto();

  const aliceUser = await createTestUser(`test-alice-rtcd-${Date.now()}@example.com`);
  const bobUser   = await createTestUser(`test-bob-rtcd-${Date.now()}@example.com`);
  const carolUser = await createTestUser(`test-carol-rtcd-${Date.now()}@example.com`);
  const userIds   = [aliceUser.userId, bobUser.userId, carolUser.userId];
  const svc       = makeServiceClient();

  try {
    const alice = await provisionDevice(aliceUser.supabase, aliceUser.userId);
    const bob   = await provisionDevice(bobUser.supabase,   bobUser.userId);
    const carol = await provisionDevice(carolUser.supabase, carolUser.userId);

    // -- Gen-1: Alice + Bob + Carol -------------------------------------------
    const { data: room, error: roomErr } = await aliceUser.supabase
      .from('rooms').insert({ kind: 'group', created_by: alice.userId })
      .select('*').single();
    if (roomErr || !room) throw new Error(`createRoom: ${roomErr?.message}`);
    const gen1 = room.current_generation as number;
    const key1 = await generateRoomKey(gen1);

    for (const m of [
      { u: alice, c: aliceUser.supabase },
      { u: bob,   c: svc },
      { u: carol, c: svc },
    ]) {
      const wrap = await wrapRoomKeyFor(key1, m.u.bundle.x25519PublicKey);
      const sig  = await signMembershipWrap(
        { roomId: room.id, generation: gen1, memberUserId: m.u.userId, memberDeviceId: m.u.deviceId,
          wrappedRoomKey: wrap.wrapped, signerDeviceId: alice.deviceId },
        alice.bundle.ed25519PrivateKey,
      );
      await m.c.from('room_members').insert({
        room_id: room.id, user_id: m.u.userId, device_id: m.u.deviceId, generation: gen1,
        wrapped_room_key: await toBase64(wrap.wrapped),
        signer_device_id: alice.deviceId, wrap_signature: await toBase64(sig),
      });
    }

    // -- Gen-2: evict Carol, keep Alice + Bob ---------------------------------
    const gen2 = gen1 + 1;
    const key2 = await generateRoomKey(gen2);

    const wraps2 = await Promise.all([alice, bob].map(async (m) => {
      const wrap = await wrapRoomKeyFor(key2, m.bundle.x25519PublicKey);
      const sig  = await signMembershipWrap(
        { roomId: room.id, generation: gen2, memberUserId: m.userId, memberDeviceId: m.deviceId,
          wrappedRoomKey: wrap.wrapped, signerDeviceId: alice.deviceId },
        alice.bundle.ed25519PrivateKey,
      );
      return { user_id: m.userId, device_id: m.deviceId,
        wrapped_room_key: await toBase64(wrap.wrapped), wrap_signature: await toBase64(sig) };
    }));
    const { error: rotErr } = await aliceUser.supabase.rpc('kick_and_rotate', {
      p_room_id: room.id, p_evictee_user_ids: [carol.userId],
      p_old_gen: gen1, p_new_gen: gen2,
      p_wraps: wraps2, p_signer_device_id: alice.deviceId,
      p_name_ciphertext: null, p_name_nonce: null,
    });
    if (rotErr) throw new Error(`kick_and_rotate: ${rotErr.message}`);

    // -- Alice sends a gen-2 message ------------------------------------------
    const aliceBlob = await encryptBlob<{ text: string }>({
      payload: { text: 'Alice gen-2' }, roomId: room.id, roomKey: key2,
      senderUserId: alice.userId, senderDeviceId: alice.deviceId,
      senderDeviceEd25519PrivateKey: alice.bundle.ed25519PrivateKey,
    });
    const { data: aliceBlobRow } = await aliceUser.supabase.from('blobs').insert({
      room_id: room.id, sender_id: alice.userId, sender_device_id: alice.deviceId,
      generation: aliceBlob.generation, nonce: await toBase64(aliceBlob.nonce),
      ciphertext: await toBase64(aliceBlob.ciphertext),
      signature: aliceBlob.signature.byteLength > 0 ? await toBase64(aliceBlob.signature) : null,
      session_id: null, message_index: null,
    }).select('*').single();

    // -- Bob sends a gen-2 message --------------------------------------------
    const bobBlob = await encryptBlob<{ text: string }>({
      payload: { text: 'Bob gen-2' }, roomId: room.id, roomKey: key2,
      senderUserId: bob.userId, senderDeviceId: bob.deviceId,
      senderDeviceEd25519PrivateKey: bob.bundle.ed25519PrivateKey,
    });
    const { data: bobBlobRow } = await bobUser.supabase.from('blobs').insert({
      room_id: room.id, sender_id: bob.userId, sender_device_id: bob.deviceId,
      generation: bobBlob.generation, nonce: await toBase64(bobBlob.nonce),
      ciphertext: await toBase64(bobBlob.ciphertext),
      signature: bobBlob.signature.byteLength > 0 ? await toBase64(bobBlob.signature) : null,
      session_id: null, message_index: null,
    }).select('*').single();

    // -- Unwrap helper --------------------------------------------------------
    async function unwrapFor(deviceId: string, xPub: Uint8Array, xPriv: Uint8Array, gen: number): Promise<RoomKey> {
      const { data: kr } = await svc.from('room_members').select('wrapped_room_key')
        .eq('room_id', room.id).eq('device_id', deviceId).eq('generation', gen).single();
      return unwrapRoomKey(
        { wrapped: await fromBase64((kr as { wrapped_room_key: string }).wrapped_room_key), generation: gen },
        xPub, xPriv,
      );
    }

    function toWireBlob(row: Record<string, unknown>): EncryptedBlob {
      const r = row as { nonce: string; ciphertext: string; signature: string | null;
        generation: number; session_id: string | null; message_index: number | null };
      return {
        nonce: Buffer.from(r.nonce, 'base64'),
        ciphertext: Buffer.from(r.ciphertext, 'base64'),
        signature: r.signature ? Buffer.from(r.signature, 'base64') : new Uint8Array(0),
        generation: r.generation, sessionId: null, messageIndex: null,
      };
    }

    const aliceKey2 = await unwrapFor(alice.deviceId, alice.bundle.x25519PublicKey, alice.bundle.x25519PrivateKey, gen2);
    const bobKey2   = await unwrapFor(bob.deviceId,   bob.bundle.x25519PublicKey,   bob.bundle.x25519PrivateKey,   gen2);

    // Bob decrypts Alice's message
    const { payload: pAlice } = await decryptBlob<{ text: string }>({
      blob: toWireBlob(aliceBlobRow as Record<string, unknown>), roomId: room.id, roomKey: bobKey2,
      resolveSenderDeviceEd25519Pub: async () => alice.bundle.ed25519PublicKey,
    });
    if (pAlice.text !== 'Alice gen-2') throw new Error(`Bob reading Alice: "${pAlice.text}"`);

    // Alice decrypts Bob's message
    const { payload: pBob } = await decryptBlob<{ text: string }>({
      blob: toWireBlob(bobBlobRow as Record<string, unknown>), roomId: room.id, roomKey: aliceKey2,
      resolveSenderDeviceEd25519Pub: async () => bob.bundle.ed25519PublicKey,
    });
    if (pBob.text !== 'Bob gen-2') throw new Error(`Alice reading Bob: "${pBob.text}"`);

    // Carol cannot read gen-2 blobs
    const { data: carolBlobs } = await carolUser.supabase
      .from('blobs').select('id').eq('room_id', room.id).eq('generation', gen2);
    if (carolBlobs && carolBlobs.length > 0) {
      throw new Error(`Vulnerability: Carol sees ${carolBlobs.length} gen-2 blob(s) after eviction`);
    }

    console.log('PASS: Post-rotation cross-decrypt — Alice and Bob read each other\'s gen-2 messages; Carol sees nothing ✓');
  } finally {
    for (const id of userIds) await cleanupUser(id).catch(console.error);
  }
}

run().catch((err) => { console.error('FAIL:', err); process.exit(1); });
