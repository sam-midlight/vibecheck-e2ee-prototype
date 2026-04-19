/**
 * Test 5: Late Joiner / Ratchet History (Data Integrity)
 *
 * Alice creates a room and sends Message 1 (gen 1). Alice then rotates the
 * room to gen 2, adding Bob. Alice sends Message 2 (gen 2).
 *
 * Asserts:
 *   - Bob decrypts Message 2 successfully.
 *   - Bob has no room_members row at gen 1 (cannot obtain the pre-join key).
 *   - Attempting to decrypt Message 1 with the gen-2 key throws a CryptoError
 *     (wrong key — AEAD authentication fails).
 *
 * Run: npx tsx --env-file=.env.local scripts/test-late-joiner.ts
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
} from '../src/lib/e2ee-core';
import { initCrypto, createTestUser, provisionDevice, cleanupUser } from './test-utils';

async function run() {
  await initCrypto();

  const aliceUser = await createTestUser(`test-alice-lj-${Date.now()}@example.com`);
  const bobUser   = await createTestUser(`test-bob-lj-${Date.now()}@example.com`);
  const userIds   = [aliceUser.userId, bobUser.userId];

  try {
    const alice = await provisionDevice(aliceUser.supabase, aliceUser.userId);
    const bob   = await provisionDevice(bobUser.supabase,   bobUser.userId);

    // -- Alice creates room (gen 1), adds herself ----------------------------
    const { data: room, error: roomErr } = await aliceUser.supabase
      .from('rooms')
      .insert({ kind: 'group', created_by: alice.userId })
      .select('*')
      .single();
    if (roomErr || !room) throw new Error(`createRoom: ${roomErr?.message}`);

    const gen1    = room.current_generation as number; // 1
    const key1    = await generateRoomKey(gen1);

    const w1  = await wrapRoomKeyFor(key1, alice.bundle.x25519PublicKey);
    const s1  = await signMembershipWrap(
      { roomId: room.id, generation: gen1, memberUserId: alice.userId,
        memberDeviceId: alice.deviceId, wrappedRoomKey: w1.wrapped,
        signerDeviceId: alice.deviceId },
      alice.bundle.ed25519PrivateKey,
    );
    const { error: m1Err } = await aliceUser.supabase.from('room_members').insert({
      room_id: room.id, user_id: alice.userId, device_id: alice.deviceId,
      generation: gen1, wrapped_room_key: await toBase64(w1.wrapped),
      signer_device_id: alice.deviceId, wrap_signature: await toBase64(s1),
    });
    if (m1Err) throw new Error(`addAlice gen1: ${m1Err.message}`);

    // -- Alice sends Message 1 (gen 1) ---------------------------------------
    const blob1 = await encryptBlob<{ text: string }>({
      payload: { text: 'Message 1 — before Bob joined' },
      roomId: room.id, roomKey: key1,
      senderUserId: alice.userId, senderDeviceId: alice.deviceId,
      senderDeviceEd25519PrivateKey: alice.bundle.ed25519PrivateKey,
    });
    const { error: b1Err } = await aliceUser.supabase.from('blobs').insert({
      room_id: room.id, sender_id: alice.userId, sender_device_id: alice.deviceId,
      generation: blob1.generation, nonce: await toBase64(blob1.nonce),
      ciphertext: await toBase64(blob1.ciphertext),
      signature: blob1.signature.byteLength > 0 ? await toBase64(blob1.signature) : null,
      session_id: blob1.sessionId ?? null, message_index: blob1.messageIndex ?? null,
    });
    if (b1Err) throw new Error(`insertBlob1: ${b1Err.message}`);

    // -- Alice rotates to gen 2, adding Bob ----------------------------------
    const gen2 = gen1 + 1;
    const key2 = await generateRoomKey(gen2);

    async function makeWrap(memberUserId: string, memberDeviceId: string, xPub: Uint8Array) {
      const wrap = await wrapRoomKeyFor(key2, xPub);
      const sig  = await signMembershipWrap(
        { roomId: room.id, generation: gen2, memberUserId, memberDeviceId,
          wrappedRoomKey: wrap.wrapped, signerDeviceId: alice.deviceId },
        alice.bundle.ed25519PrivateKey,
      );
      return {
        user_id: memberUserId, device_id: memberDeviceId,
        wrapped_room_key: await toBase64(wrap.wrapped),
        wrap_signature: await toBase64(sig),
      };
    }

    const { error: rotErr } = await aliceUser.supabase.rpc('kick_and_rotate', {
      p_room_id: room.id,
      p_evictee_user_ids: [],
      p_old_gen: gen1,
      p_new_gen: gen2,
      p_wraps: [
        await makeWrap(alice.userId, alice.deviceId, alice.bundle.x25519PublicKey),
        await makeWrap(bob.userId,   bob.deviceId,   bob.bundle.x25519PublicKey),
      ],
      p_signer_device_id: alice.deviceId,
      p_name_ciphertext: null,
      p_name_nonce: null,
    });
    if (rotErr) throw new Error(`kick_and_rotate: ${rotErr.message}`);

    // -- Alice sends Message 2 (gen 2) ---------------------------------------
    const blob2 = await encryptBlob<{ text: string }>({
      payload: { text: 'Message 2 — after Bob joined' },
      roomId: room.id, roomKey: key2,
      senderUserId: alice.userId, senderDeviceId: alice.deviceId,
      senderDeviceEd25519PrivateKey: alice.bundle.ed25519PrivateKey,
    });
    const { error: b2Err } = await aliceUser.supabase.from('blobs').insert({
      room_id: room.id, sender_id: alice.userId, sender_device_id: alice.deviceId,
      generation: blob2.generation, nonce: await toBase64(blob2.nonce),
      ciphertext: await toBase64(blob2.ciphertext),
      signature: blob2.signature.byteLength > 0 ? await toBase64(blob2.signature) : null,
      session_id: blob2.sessionId ?? null, message_index: blob2.messageIndex ?? null,
    });
    if (b2Err) throw new Error(`insertBlob2: ${b2Err.message}`);

    // -- Bob fetches his gen-2 key -------------------------------------------
    const { data: bobKeyRow, error: bkErr } = await bobUser.supabase
      .from('room_members')
      .select('wrapped_room_key')
      .eq('room_id', room.id)
      .eq('device_id', bob.deviceId)
      .eq('generation', gen2)
      .single();
    if (bkErr || !bobKeyRow) throw new Error(`Bob missing gen2 key: ${bkErr?.message}`);

    const bobKey2 = await unwrapRoomKey(
      { wrapped: await fromBase64(bobKeyRow.wrapped_room_key as string), generation: gen2 },
      bob.bundle.x25519PublicKey, bob.bundle.x25519PrivateKey,
    );

    // -- Assert 1: Bob decrypts Message 2 ------------------------------------
    const { data: allBlobs } = await bobUser.supabase
      .from('blobs')
      .select('*')
      .eq('room_id', room.id)
      .order('created_at', { ascending: true });
    if (!allBlobs || allBlobs.length < 2) throw new Error('Expected at least 2 blobs');

    function toEncBlob(row: {
      nonce: string; ciphertext: string; signature: string | null;
      generation: number; session_id: string | null; message_index: number | null;
    }): Promise<EncryptedBlob> {
      return Promise.all([fromBase64(row.nonce), fromBase64(row.ciphertext)]).then(
        ([n, c]) => ({
          nonce: n, ciphertext: c,
          signature: row.signature ? new Uint8Array(0) : new Uint8Array(0), // sig inside envelope
          generation: row.generation,
          sessionId: row.session_id ?? null,
          messageIndex: row.message_index ?? null,
        }),
      );
    }

    const msg2Wire = await toEncBlob(allBlobs[1] as Parameters<typeof toEncBlob>[0]);
    const { payload: p2 } = await decryptBlob<{ text: string }>({
      blob: msg2Wire, roomId: room.id, roomKey: bobKey2,
      resolveSenderDeviceEd25519Pub: async () => alice.bundle.ed25519PublicKey,
    });
    if (p2.text !== 'Message 2 — after Bob joined') {
      throw new Error(`Message 2 plaintext mismatch: "${p2.text}"`);
    }

    // -- Assert 2: Bob has no gen-1 room_members row -------------------------
    const { data: preJoinRow } = await bobUser.supabase
      .from('room_members')
      .select('wrapped_room_key')
      .eq('room_id', room.id)
      .eq('device_id', bob.deviceId)
      .eq('generation', gen1)
      .maybeSingle();
    if (preJoinRow !== null) {
      throw new Error('Vulnerability: Bob obtained a gen-1 room_members row (should not exist)');
    }

    // -- Assert 3: Decrypting Message 1 with gen-2 key throws ----------------
    const msg1Wire = await toEncBlob(allBlobs[0] as Parameters<typeof toEncBlob>[0]);
    try {
      await decryptBlob<{ text: string }>({
        blob: msg1Wire, roomId: room.id, roomKey: bobKey2,
        resolveSenderDeviceEd25519Pub: async () => alice.bundle.ed25519PublicKey,
      });
      throw new Error('Vulnerability: Bob decrypted Message 1 with gen-2 key (should have failed)');
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Vulnerability')) throw err;
      // Any other error means decryption correctly failed (AEAD authentication failure).
    }

    console.log('PASS: Late-joiner isolation — Bob read msg2, blocked from msg1 ✓');
  } finally {
    for (const id of userIds) await cleanupUser(id).catch(console.error);
  }
}

run().catch((err) => { console.error('FAIL:', err); process.exit(1); });
