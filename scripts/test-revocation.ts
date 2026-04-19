/**
 * Test 4: Device Revocation Cutoff (Security / Forward Secrecy)
 *
 * Bob has Dev1 and Dev2. Alice creates a room for both. Bob revokes Dev2.
 * Alice rotates the room key (gen 1 → 2) including only Dev1. Alice sends
 * a post-rotation message.
 *
 * Asserts:
 *   - Bob Dev1 successfully decrypts the message.
 *   - Bob Dev2 has no room_members row at gen 2 (cannot obtain the key).
 *
 * Run: npx tsx --env-file=.env.local scripts/test-revocation.ts
 */

import {
  generateRoomKey,
  wrapRoomKeyFor,
  unwrapRoomKey,
  signMembershipWrap,
  signDeviceRevocationV2,
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

  const aliceUser = await createTestUser(`test-alice-rev-${Date.now()}@example.com`);
  const bobUser   = await createTestUser(`test-bob-rev-${Date.now()}@example.com`);
  const userIds   = [aliceUser.userId, bobUser.userId];

  const svc = makeServiceClient();

  try {
    const alice = await provisionDevice(aliceUser.supabase, aliceUser.userId);
    const bob1  = await provisionDevice(bobUser.supabase, bobUser.userId);
    const bob2  = await provisionSecondDevice(bobUser.supabase, bobUser.userId, bob1.ssk);

    // -- Alice creates room, wraps gen-1 key for Alice + both Bob devices ---
    const { data: room, error: roomErr } = await aliceUser.supabase
      .from('rooms')
      .insert({ kind: 'group', created_by: alice.userId })
      .select('*')
      .single();
    if (roomErr || !room) throw new Error(`createRoom: ${roomErr?.message}`);

    const gen1    = room.current_generation as number; // 1
    const roomKey = await generateRoomKey(gen1);

    async function addMember(
      memberUserId: string,
      memberDeviceId: string,
      memberX25519Pub: Uint8Array,
    ) {
      const wrap = await wrapRoomKeyFor(roomKey, memberX25519Pub);
      const sig  = await signMembershipWrap(
        { roomId: room.id, generation: gen1, memberUserId, memberDeviceId,
          wrappedRoomKey: wrap.wrapped, signerDeviceId: alice.deviceId },
        alice.bundle.ed25519PrivateKey,
      );
      const { error } = await svc.from('room_members').insert({
        room_id: room.id, user_id: memberUserId, device_id: memberDeviceId,
        generation: gen1, wrapped_room_key: await toBase64(wrap.wrapped),
        signer_device_id: alice.deviceId, wrap_signature: await toBase64(sig),
      });
      if (error) throw new Error(`addMember(${memberDeviceId}): ${error.message}`);
    }

    await addMember(alice.userId, alice.deviceId, alice.bundle.x25519PublicKey);
    await addMember(bob1.userId,  bob1.deviceId,  bob1.bundle.x25519PublicKey);
    await addMember(bob1.userId,  bob2.deviceId,  bob2.bundle.x25519PublicKey);

    // -- Bob revokes Dev2 (signed with the shared SSK) ----------------------
    const revokedAtMs = Date.now();
    const revSig = await signDeviceRevocationV2(
      { userId: bob1.userId, deviceId: bob2.deviceId, revokedAtMs },
      bob1.ssk.ed25519PrivateKey,
    );
    const { error: revErr } = await bobUser.supabase
      .from('devices')
      .update({
        revoked_at_ms: revokedAtMs,
        revocation_signature: await toBase64(revSig),
      })
      .eq('id', bob2.deviceId);
    if (revErr) throw new Error(`revokeDevice: ${revErr.message}`);

    // -- Alice rotates (gen 1 → 2), deliberately excluding Dev2 -------------
    const gen2    = gen1 + 1;
    const newKey  = await generateRoomKey(gen2);

    async function makeWrap(memberUserId: string, memberDeviceId: string, xPub: Uint8Array) {
      const wrap = await wrapRoomKeyFor(newKey, xPub);
      const sig  = await signMembershipWrap(
        { roomId: room.id, generation: gen2, memberUserId, memberDeviceId,
          wrappedRoomKey: wrap.wrapped, signerDeviceId: alice.deviceId },
        alice.bundle.ed25519PrivateKey,
      );
      return {
        user_id: memberUserId,
        device_id: memberDeviceId,
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
        await makeWrap(bob1.userId,  bob1.deviceId,  bob1.bundle.x25519PublicKey),
        // bob2.deviceId intentionally omitted (revoked)
      ],
      p_signer_device_id: alice.deviceId,
      p_name_ciphertext: null,
      p_name_nonce: null,
    });
    if (rotErr) throw new Error(`kick_and_rotate: ${rotErr.message}`);

    // -- Alice sends a post-rotation message ---------------------------------
    const encBlob = await encryptBlob<{ text: string }>({
      payload: { text: 'Post-revocation' },
      roomId: room.id,
      roomKey: newKey,
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

    // -- Bob Dev1 decrypts successfully --------------------------------------
    const { data: m1Row, error: m1Err } = await bobUser.supabase
      .from('room_members')
      .select('wrapped_room_key')
      .eq('room_id', room.id)
      .eq('device_id', bob1.deviceId)
      .eq('generation', gen2)
      .single();
    if (m1Err || !m1Row) throw new Error(`Bob Dev1 missing gen2 key: ${m1Err?.message}`);

    const { data: blobRows } = await bobUser.supabase
      .from('blobs')
      .select('*')
      .eq('room_id', room.id)
      .eq('generation', gen2)
      .order('created_at', { ascending: true });
    if (!blobRows || blobRows.length === 0) throw new Error('Bob sees no gen-2 blobs');

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

    const dev1Key = await unwrapRoomKey(
      { wrapped: await fromBase64(m1Row.wrapped_room_key as string), generation: gen2 },
      bob1.bundle.x25519PublicKey, bob1.bundle.x25519PrivateKey,
    );
    const { payload: p1 } = await decryptBlob<{ text: string }>({
      blob: wireBlob, roomId: room.id, roomKey: dev1Key,
      resolveSenderDeviceEd25519Pub: async () => alice.bundle.ed25519PublicKey,
    });
    if (p1.text !== 'Post-revocation') throw new Error(`Dev1 plaintext mismatch: "${p1.text}"`);

    // -- Bob Dev2 must have NO gen-2 room_members row ------------------------
    const { data: dev2Row } = await bobUser.supabase
      .from('room_members')
      .select('wrapped_room_key')
      .eq('room_id', room.id)
      .eq('device_id', bob2.deviceId)
      .eq('generation', gen2)
      .maybeSingle();

    if (dev2Row !== null) {
      throw new Error('Vulnerability: Revoked Dev2 obtained a gen-2 room key');
    }

    console.log('PASS: Revocation cutoff — Dev1 decrypted; Dev2 has no gen-2 key ✓');
  } finally {
    for (const id of userIds) await cleanupUser(id).catch(console.error);
  }
}

run().catch((err) => { console.error('FAIL:', err); process.exit(1); });
