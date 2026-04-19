/**
 * Test 2: Multi-Device Key Wrap
 *
 * Alice has Device 1 and Device 2. Bob creates a room and invites Alice
 * (wrapping the room key for BOTH of Alice's devices). Bob sends a message.
 * Asserts: both Alice devices independently unwrap their key and decrypt
 * 'Multi-device test'.
 *
 * Run: npx tsx --env-file=.env.local scripts/test-multi-device.ts
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
import {
  initCrypto,
  createTestUser,
  provisionDevice,
  provisionSecondDevice,
  cleanupUser,
  makeServiceClient,
} from './test-utils';

async function run() {
  await initCrypto();

  const aliceUser = await createTestUser(`test-alice-md-${Date.now()}@example.com`);
  const bobUser   = await createTestUser(`test-bob-md-${Date.now()}@example.com`);
  const userIds   = [aliceUser.userId, bobUser.userId];

  const svc = makeServiceClient();

  try {
    // -- Provision identities ------------------------------------------------
    const alice1 = await provisionDevice(aliceUser.supabase, aliceUser.userId);
    // Alice's second device reuses her existing MSK/SSK via provisionSecondDevice
    const alice2 = await provisionSecondDevice(aliceUser.supabase, aliceUser.userId, alice1.ssk);
    const bob    = await provisionDevice(bobUser.supabase, bobUser.userId);

    // -- Bob creates a room --------------------------------------------------
    const { data: room, error: roomErr } = await bobUser.supabase
      .from('rooms')
      .insert({ kind: 'group', created_by: bob.userId })
      .select('*')
      .single();
    if (roomErr || !room) throw new Error(`createRoom: ${roomErr?.message}`);

    const generation = room.current_generation as number; // 1
    const roomKey    = await generateRoomKey(generation);

    // -- Helper: add a device as a room member (service client for cross-user inserts) --
    async function addMember(
      memberUserId: string,
      memberDeviceId: string,
      memberX25519Pub: Uint8Array,
    ) {
      const wrap = await wrapRoomKeyFor(roomKey, memberX25519Pub);
      const sig  = await signMembershipWrap(
        { roomId: room.id, generation, memberUserId, memberDeviceId,
          wrappedRoomKey: wrap.wrapped, signerDeviceId: bob.deviceId },
        bob.bundle.ed25519PrivateKey,
      );
      const { error } = await svc.from('room_members').insert({
        room_id: room.id,
        user_id: memberUserId,
        device_id: memberDeviceId,
        generation,
        wrapped_room_key: await toBase64(wrap.wrapped),
        signer_device_id: bob.deviceId,
        wrap_signature: await toBase64(sig),
      });
      if (error) throw new Error(`addMember(${memberDeviceId}): ${error.message}`);
    }

    await addMember(bob.userId,   bob.deviceId,    bob.bundle.x25519PublicKey);
    await addMember(alice1.userId, alice1.deviceId, alice1.bundle.x25519PublicKey);
    await addMember(alice1.userId, alice2.deviceId, alice2.bundle.x25519PublicKey);

    // -- Bob encrypts a message ----------------------------------------------
    const encBlob = await encryptBlob<{ text: string }>({
      payload: { text: 'Multi-device test' },
      roomId: room.id,
      roomKey,
      senderUserId: bob.userId,
      senderDeviceId: bob.deviceId,
      senderDeviceEd25519PrivateKey: bob.bundle.ed25519PrivateKey,
    });

    const { error: blobErr } = await bobUser.supabase.from('blobs').insert({
      room_id: room.id,
      sender_id: bob.userId,
      sender_device_id: bob.deviceId,
      generation: encBlob.generation,
      nonce: await toBase64(encBlob.nonce),
      ciphertext: await toBase64(encBlob.ciphertext),
      signature: encBlob.signature.byteLength > 0 ? await toBase64(encBlob.signature) : null,
      session_id: encBlob.sessionId ?? null,
      message_index: encBlob.messageIndex ?? null,
    });
    if (blobErr) throw new Error(`insertBlob: ${blobErr.message}`);

    // -- Helper: fetch blob row ----------------------------------------------
    const { data: blobRows, error: listErr } = await aliceUser.supabase
      .from('blobs')
      .select('*')
      .eq('room_id', room.id)
      .order('created_at', { ascending: true });
    if (listErr) throw new Error(`listBlobs: ${listErr.message}`);
    if (!blobRows || blobRows.length === 0) throw new Error('Alice received no blobs');

    const row = blobRows[0] as {
      nonce: string; ciphertext: string; signature: string | null;
      generation: number; session_id: string | null; message_index: number | null;
    };
    const wireBlob: EncryptedBlob = {
      nonce: await fromBase64(row.nonce),
      ciphertext: await fromBase64(row.ciphertext),
      signature: row.signature ? await fromBase64(row.signature) : new Uint8Array(0),
      generation: row.generation,
      sessionId: row.session_id ?? null,
      messageIndex: row.message_index ?? null,
    };

    // -- Alice Device 1 decrypts ---------------------------------------------
    const { data: m1Row, error: m1Err } = await aliceUser.supabase
      .from('room_members')
      .select('wrapped_room_key')
      .eq('room_id', room.id)
      .eq('device_id', alice1.deviceId)
      .eq('generation', generation)
      .single();
    if (m1Err || !m1Row) throw new Error(`Alice Dev1 has no key: ${m1Err?.message}`);

    const key1 = await unwrapRoomKey(
      { wrapped: await fromBase64(m1Row.wrapped_room_key as string), generation },
      alice1.bundle.x25519PublicKey, alice1.bundle.x25519PrivateKey,
    );
    const { payload: p1 } = await decryptBlob<{ text: string }>({
      blob: wireBlob, roomId: room.id, roomKey: key1,
      resolveSenderDeviceEd25519Pub: async () => bob.bundle.ed25519PublicKey,
    });
    if (p1.text !== 'Multi-device test') throw new Error(`Dev1 plaintext mismatch: "${p1.text}"`);

    // -- Alice Device 2 decrypts ---------------------------------------------
    const { data: m2Row, error: m2Err } = await aliceUser.supabase
      .from('room_members')
      .select('wrapped_room_key')
      .eq('room_id', room.id)
      .eq('device_id', alice2.deviceId)
      .eq('generation', generation)
      .single();
    if (m2Err || !m2Row) throw new Error(`Alice Dev2 has no key: ${m2Err?.message}`);

    const key2 = await unwrapRoomKey(
      { wrapped: await fromBase64(m2Row.wrapped_room_key as string), generation },
      alice2.bundle.x25519PublicKey, alice2.bundle.x25519PrivateKey,
    );
    const { payload: p2 } = await decryptBlob<{ text: string }>({
      blob: wireBlob, roomId: room.id, roomKey: key2,
      resolveSenderDeviceEd25519Pub: async () => bob.bundle.ed25519PublicKey,
    });
    if (p2.text !== 'Multi-device test') throw new Error(`Dev2 plaintext mismatch: "${p2.text}"`);

    console.log('PASS: Multi-device — both Alice devices decrypted successfully ✓');
  } finally {
    for (const id of userIds) await cleanupUser(id).catch(console.error);
  }
}

run().catch((err) => { console.error('FAIL:', err); process.exit(1); });
