/**
 * Test 1: Happy Path
 *
 * Alice creates a room, wraps the room key for Bob, encrypts a message.
 * Bob fetches the blob, unwraps his key, and decrypts.
 * Asserts: Bob's decrypted plaintext === 'Hello Bob'
 *
 * Run: npx tsx --env-file=.env.local scripts/test-happy-path.ts
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
import { initCrypto, createTestUser, provisionDevice, cleanupUser, makeServiceClient } from './test-utils';

async function run() {
  await initCrypto();

  const aliceUser = await createTestUser(`test-alice-hp-${Date.now()}@example.com`);
  const bobUser   = await createTestUser(`test-bob-hp-${Date.now()}@example.com`);
  const userIds   = [aliceUser.userId, bobUser.userId];

  const svc = makeServiceClient();

  try {
    const alice = await provisionDevice(aliceUser.supabase, aliceUser.userId);
    const bob   = await provisionDevice(bobUser.supabase,   bobUser.userId);

    // -- Alice creates a room ------------------------------------------------
    const { data: room, error: roomErr } = await aliceUser.supabase
      .from('rooms')
      .insert({ kind: 'group', created_by: aliceUser.userId })
      .select('*')
      .single();
    if (roomErr || !room) throw new Error(`createRoom: ${roomErr?.message}`);

    const generation = room.current_generation as number; // 1

    // -- Generate room key ---------------------------------------------------
    const roomKey = await generateRoomKey(generation);

    // -- Wrap + add Alice as member ------------------------------------------
    const aliceWrap = await wrapRoomKeyFor(roomKey, alice.bundle.x25519PublicKey);
    const aliceSig  = await signMembershipWrap(
      { roomId: room.id, generation, memberUserId: alice.userId, memberDeviceId: alice.deviceId,
        wrappedRoomKey: aliceWrap.wrapped, signerDeviceId: alice.deviceId },
      alice.bundle.ed25519PrivateKey,
    );
    const { error: aliceMemberErr } = await aliceUser.supabase.from('room_members').insert({
      room_id: room.id,
      user_id: alice.userId,
      device_id: alice.deviceId,
      generation,
      wrapped_room_key: await toBase64(aliceWrap.wrapped),
      signer_device_id: alice.deviceId,
      wrap_signature: await toBase64(aliceSig),
    });
    if (aliceMemberErr) throw new Error(`addAliceMember: ${aliceMemberErr.message}`);

    // -- Wrap + add Bob as member (service client — RLS blocks cross-user inserts) --
    const bobWrap = await wrapRoomKeyFor(roomKey, bob.bundle.x25519PublicKey);
    const bobSig  = await signMembershipWrap(
      { roomId: room.id, generation, memberUserId: bob.userId, memberDeviceId: bob.deviceId,
        wrappedRoomKey: bobWrap.wrapped, signerDeviceId: alice.deviceId },
      alice.bundle.ed25519PrivateKey,
    );
    const { error: bobMemberErr } = await svc.from('room_members').insert({
      room_id: room.id,
      user_id: bob.userId,
      device_id: bob.deviceId,
      generation,
      wrapped_room_key: await toBase64(bobWrap.wrapped),
      signer_device_id: alice.deviceId,
      wrap_signature: await toBase64(bobSig),
    });
    if (bobMemberErr) throw new Error(`addBobMember: ${bobMemberErr.message}`);

    // -- Alice encrypts a message --------------------------------------------
    const encBlob = await encryptBlob<{ text: string }>({
      payload: { text: 'Hello Bob' },
      roomId: room.id,
      roomKey,
      senderUserId: alice.userId,
      senderDeviceId: alice.deviceId,
      senderDeviceEd25519PrivateKey: alice.bundle.ed25519PrivateKey,
    });

    const { error: blobErr } = await aliceUser.supabase.from('blobs').insert({
      room_id: room.id,
      sender_id: alice.userId,
      sender_device_id: alice.deviceId,
      generation: encBlob.generation,
      nonce: await toBase64(encBlob.nonce),
      ciphertext: await toBase64(encBlob.ciphertext),
      signature: encBlob.signature.byteLength > 0 ? await toBase64(encBlob.signature) : null,
      session_id: encBlob.sessionId ?? null,
      message_index: encBlob.messageIndex ?? null,
    });
    if (blobErr) throw new Error(`insertBlob: ${blobErr.message}`);

    // -- Bob fetches blobs ---------------------------------------------------
    const { data: blobRows, error: listErr } = await bobUser.supabase
      .from('blobs')
      .select('*')
      .eq('room_id', room.id)
      .order('created_at', { ascending: true });
    if (listErr) throw new Error(`listBlobs: ${listErr.message}`);
    if (!blobRows || blobRows.length === 0) throw new Error('Bob received no blobs');

    const row = blobRows[0] as {
      nonce: string; ciphertext: string; signature: string | null;
      generation: number; session_id: string | null; message_index: number | null;
    };

    // -- Bob fetches his wrapped key -----------------------------------------
    const { data: memberRow, error: memberErr } = await bobUser.supabase
      .from('room_members')
      .select('wrapped_room_key')
      .eq('room_id', room.id)
      .eq('device_id', bob.deviceId)
      .eq('generation', generation)
      .single();
    if (memberErr || !memberRow) throw new Error(`Bob has no room key: ${memberErr?.message}`);

    const bobRoomKey = await unwrapRoomKey(
      { wrapped: await fromBase64(memberRow.wrapped_room_key as string), generation },
      bob.bundle.x25519PublicKey,
      bob.bundle.x25519PrivateKey,
    );

    // -- Bob decrypts --------------------------------------------------------
    const wireBlob: EncryptedBlob = {
      nonce: await fromBase64(row.nonce),
      ciphertext: await fromBase64(row.ciphertext),
      signature: row.signature ? await fromBase64(row.signature) : new Uint8Array(0),
      generation: row.generation,
      sessionId: row.session_id ?? null,
      messageIndex: row.message_index ?? null,
    };

    const { payload } = await decryptBlob<{ text: string }>({
      blob: wireBlob,
      roomId: room.id,
      roomKey: bobRoomKey,
      resolveSenderDeviceEd25519Pub: async (_uid, _did) => alice.bundle.ed25519PublicKey,
    });

    if (payload.text !== 'Hello Bob') {
      throw new Error(`Plaintext mismatch: got "${payload.text}"`);
    }

    console.log('PASS: Happy path — Bob decrypted "Hello Bob" ✓');
  } finally {
    for (const id of userIds) await cleanupUser(id).catch(console.error);
  }
}

run().catch((err) => { console.error('FAIL:', err); process.exit(1); });
