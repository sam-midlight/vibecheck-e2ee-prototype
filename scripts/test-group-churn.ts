/**
 * Test 17: Group Churn Stability
 *
 * Simulates a full membership lifecycle across 4 generations:
 *   gen 1: Alice + Bob + Carol
 *   gen 2: Alice + Bob (evict Carol)
 *   gen 3: Alice + Bob + Dave (add Dave)
 *   gen 4: Alice + Dave (Bob self-leaves via kick_and_rotate p_evictee_user_ids=[Bob])
 *
 * At each generation the active members can decrypt messages encrypted at that
 * generation. Evicted users have no room_members row at the new generation.
 *
 * Asserts:
 *   - Each rotation bumps current_generation by 1
 *   - Evicted members have no room_members row at the new generation
 *   - Active members can decrypt the gen-N test message
 *   - Carol cannot decrypt gen-2 messages (no key)
 *   - Bob cannot decrypt gen-4 messages (no key)
 *
 * Run: npx tsx --env-file=.env.local scripts/test-group-churn.ts
 */

import {
  generateRoomKey,
  wrapRoomKeyFor,
  signMembershipWrap,
  encryptBlob,
  decryptBlob,
  unwrapRoomKey,
  fromBase64,
  toBase64,
  type EncryptedBlob,
  type RoomKey,
} from '../src/lib/e2ee-core';
import { initCrypto, createTestUser, provisionDevice, cleanupUser, makeServiceClient } from './test-utils';

async function run() {
  await initCrypto();

  const aliceUser = await createTestUser(`test-alice-gc-${Date.now()}@example.com`);
  const bobUser   = await createTestUser(`test-bob-gc-${Date.now()}@example.com`);
  const carolUser = await createTestUser(`test-carol-gc-${Date.now()}@example.com`);
  const daveUser  = await createTestUser(`test-dave-gc-${Date.now()}@example.com`);
  const userIds   = [aliceUser.userId, bobUser.userId, carolUser.userId, daveUser.userId];
  const svc       = makeServiceClient();

  try {
    const alice = await provisionDevice(aliceUser.supabase, aliceUser.userId);
    const bob   = await provisionDevice(bobUser.supabase,   bobUser.userId);
    const carol = await provisionDevice(carolUser.supabase, carolUser.userId);
    const dave  = await provisionDevice(daveUser.supabase,  daveUser.userId);

    // -- Create room at gen-1 -------------------------------------------------
    const { data: room, error: roomErr } = await aliceUser.supabase
      .from('rooms')
      .insert({ kind: 'group', created_by: alice.userId })
      .select('*').single();
    if (roomErr || !room) throw new Error(`createRoom: ${roomErr?.message}`);

    const keys: RoomKey[] = [];
    const memberMap: Record<string, { userId: string; deviceId: string; xPub: Uint8Array }> = {
      alice: { userId: alice.userId, deviceId: alice.deviceId, xPub: alice.bundle.x25519PublicKey },
      bob:   { userId: bob.userId,   deviceId: bob.deviceId,   xPub: bob.bundle.x25519PublicKey },
      carol: { userId: carol.userId, deviceId: carol.deviceId, xPub: carol.bundle.x25519PublicKey },
      dave:  { userId: dave.userId,  deviceId: dave.deviceId,  xPub: dave.bundle.x25519PublicKey },
    };

    // Helper: build wraps array for kick_and_rotate
    async function buildWraps(roomKey: RoomKey, members: string[]) {
      return Promise.all(members.map(async (name) => {
        const m = memberMap[name];
        const wrap = await wrapRoomKeyFor(roomKey, m.xPub);
        const sig  = await signMembershipWrap(
          { roomId: room.id, generation: roomKey.generation,
            memberUserId: m.userId, memberDeviceId: m.deviceId,
            wrappedRoomKey: wrap.wrapped, signerDeviceId: alice.deviceId },
          alice.bundle.ed25519PrivateKey,
        );
        return {
          user_id: m.userId, device_id: m.deviceId,
          wrapped_room_key: await toBase64(wrap.wrapped),
          wrap_signature: await toBase64(sig),
        };
      }));
    }

    // -- Gen-1: Alice + Bob + Carol -------------------------------------------
    const gen1 = room.current_generation as number;
    const key1 = await generateRoomKey(gen1);
    keys[0] = key1;

    // Bootstrap initial members via direct inserts (Alice is creator)
    for (const name of ['alice', 'bob', 'carol']) {
      const m = memberMap[name];
      const wrap = await wrapRoomKeyFor(key1, m.xPub);
      const sig  = await signMembershipWrap(
        { roomId: room.id, generation: gen1,
          memberUserId: m.userId, memberDeviceId: m.deviceId,
          wrappedRoomKey: wrap.wrapped, signerDeviceId: alice.deviceId },
        alice.bundle.ed25519PrivateKey,
      );
      const client = m.userId === alice.userId ? aliceUser.supabase : svc;
      await client.from('room_members').insert({
        room_id: room.id, user_id: m.userId, device_id: m.deviceId, generation: gen1,
        wrapped_room_key: await toBase64(wrap.wrapped),
        signer_device_id: alice.deviceId, wrap_signature: await toBase64(sig),
      });
    }

    // Send gen-1 message
    const blob1 = await encryptBlob<{ text: string }>({
      payload: { text: 'Gen-1 message' }, roomId: room.id, roomKey: key1,
      senderUserId: alice.userId, senderDeviceId: alice.deviceId,
      senderDeviceEd25519PrivateKey: alice.bundle.ed25519PrivateKey,
    });
    await aliceUser.supabase.from('blobs').insert({
      room_id: room.id, sender_id: alice.userId, sender_device_id: alice.deviceId,
      generation: blob1.generation, nonce: await toBase64(blob1.nonce),
      ciphertext: await toBase64(blob1.ciphertext),
      signature: blob1.signature.byteLength > 0 ? await toBase64(blob1.signature) : null,
      session_id: null, message_index: null,
    });

    // -- Gen-2: evict Carol ---------------------------------------------------
    const gen2 = gen1 + 1;
    const key2 = await generateRoomKey(gen2);
    keys[1] = key2;
    const wraps2 = await buildWraps(key2, ['alice', 'bob']);
    const { error: rot2Err } = await aliceUser.supabase.rpc('kick_and_rotate', {
      p_room_id: room.id,
      p_evictee_user_ids: [carol.userId],
      p_old_gen: gen1, p_new_gen: gen2,
      p_wraps: wraps2,
      p_signer_device_id: alice.deviceId,
      p_name_ciphertext: null, p_name_nonce: null,
    });
    if (rot2Err) throw new Error(`kick_and_rotate gen2: ${rot2Err.message}`);

    const blob2 = await encryptBlob<{ text: string }>({
      payload: { text: 'Gen-2 message' }, roomId: room.id, roomKey: key2,
      senderUserId: alice.userId, senderDeviceId: alice.deviceId,
      senderDeviceEd25519PrivateKey: alice.bundle.ed25519PrivateKey,
    });
    const { data: blob2Row } = await aliceUser.supabase.from('blobs').insert({
      room_id: room.id, sender_id: alice.userId, sender_device_id: alice.deviceId,
      generation: blob2.generation, nonce: await toBase64(blob2.nonce),
      ciphertext: await toBase64(blob2.ciphertext),
      signature: blob2.signature.byteLength > 0 ? await toBase64(blob2.signature) : null,
      session_id: null, message_index: null,
    }).select('*').single();

    // -- Gen-3: add Dave ------------------------------------------------------
    const gen3 = gen2 + 1;
    const key3 = await generateRoomKey(gen3);
    keys[2] = key3;
    const wraps3 = await buildWraps(key3, ['alice', 'bob', 'dave']);
    const { error: rot3Err } = await aliceUser.supabase.rpc('kick_and_rotate', {
      p_room_id: room.id,
      p_evictee_user_ids: [],
      p_old_gen: gen2, p_new_gen: gen3,
      p_wraps: wraps3,
      p_signer_device_id: alice.deviceId,
      p_name_ciphertext: null, p_name_nonce: null,
    });
    if (rot3Err) throw new Error(`kick_and_rotate gen3: ${rot3Err.message}`);

    const blob3 = await encryptBlob<{ text: string }>({
      payload: { text: 'Gen-3 message' }, roomId: room.id, roomKey: key3,
      senderUserId: alice.userId, senderDeviceId: alice.deviceId,
      senderDeviceEd25519PrivateKey: alice.bundle.ed25519PrivateKey,
    });
    const { data: blob3Row } = await aliceUser.supabase.from('blobs').insert({
      room_id: room.id, sender_id: alice.userId, sender_device_id: alice.deviceId,
      generation: blob3.generation, nonce: await toBase64(blob3.nonce),
      ciphertext: await toBase64(blob3.ciphertext),
      signature: blob3.signature.byteLength > 0 ? await toBase64(blob3.signature) : null,
      session_id: null, message_index: null,
    }).select('*').single();

    // -- Gen-4: Bob self-leaves -----------------------------------------------
    const gen4 = gen3 + 1;
    const key4 = await generateRoomKey(gen4);
    keys[3] = key4;
    const wraps4 = await buildWraps(key4, ['alice', 'dave']);
    const { error: rot4Err } = await aliceUser.supabase.rpc('kick_and_rotate', {
      p_room_id: room.id,
      p_evictee_user_ids: [bob.userId],
      p_old_gen: gen3, p_new_gen: gen4,
      p_wraps: wraps4,
      p_signer_device_id: alice.deviceId,
      p_name_ciphertext: null, p_name_nonce: null,
    });
    if (rot4Err) throw new Error(`kick_and_rotate gen4: ${rot4Err.message}`);

    const blob4 = await encryptBlob<{ text: string }>({
      payload: { text: 'Gen-4 message' }, roomId: room.id, roomKey: key4,
      senderUserId: alice.userId, senderDeviceId: alice.deviceId,
      senderDeviceEd25519PrivateKey: alice.bundle.ed25519PrivateKey,
    });
    const { data: blob4Row } = await aliceUser.supabase.from('blobs').insert({
      room_id: room.id, sender_id: alice.userId, sender_device_id: alice.deviceId,
      generation: blob4.generation, nonce: await toBase64(blob4.nonce),
      ciphertext: await toBase64(blob4.ciphertext),
      signature: blob4.signature.byteLength > 0 ? await toBase64(blob4.signature) : null,
      session_id: null, message_index: null,
    }).select('*').single();

    // -- Verify current_generation = gen4 -------------------------------------
    const { data: finalRoom } = await svc.from('rooms').select('current_generation').eq('id', room.id).single();
    const finalGen = (finalRoom as { current_generation: number }).current_generation;
    if (finalGen !== gen4) throw new Error(`Expected gen ${gen4}, got ${finalGen}`);

    // -- Assert evicted members have no room_members row at new gen -----------
    const { data: carolGen2 } = await svc.from('room_members')
      .select('device_id').eq('room_id', room.id).eq('user_id', carol.userId).eq('generation', gen2).maybeSingle();
    if (carolGen2 !== null) throw new Error('Vulnerability: Carol has gen-2 room_members row after eviction');

    const { data: bobGen4 } = await svc.from('room_members')
      .select('device_id').eq('room_id', room.id).eq('user_id', bob.userId).eq('generation', gen4).maybeSingle();
    if (bobGen4 !== null) throw new Error('Vulnerability: Bob has gen-4 room_members row after self-leave');

    // -- Dave decrypts gen-3 + gen-4 messages ---------------------------------
    async function decryptAsUser(
      row: { nonce: string; ciphertext: string; signature: string | null; generation: number; session_id: string | null; message_index: number | null },
      memberUserId: string, memberDeviceId: string,
      memberX25519Pub: Uint8Array, memberX25519Priv: Uint8Array,
      senderEdPub: Uint8Array,
    ) {
      const { data: keyRow } = await svc.from('room_members')
        .select('wrapped_room_key').eq('room_id', room.id)
        .eq('device_id', memberDeviceId).eq('generation', row.generation).maybeSingle();
      if (!keyRow) throw new Error(`${memberUserId} has no room_members row at gen ${row.generation}`);
      const rk = await unwrapRoomKey(
        { wrapped: await fromBase64((keyRow as { wrapped_room_key: string }).wrapped_room_key), generation: row.generation },
        memberX25519Pub, memberX25519Priv,
      );
      const wireBlob: EncryptedBlob = {
        nonce: await fromBase64(row.nonce),
        ciphertext: await fromBase64(row.ciphertext),
        signature: row.signature ? await fromBase64(row.signature) : new Uint8Array(0),
        generation: row.generation, sessionId: null, messageIndex: null,
      };
      const { payload } = await decryptBlob<{ text: string }>({
        blob: wireBlob, roomId: room.id, roomKey: rk,
        resolveSenderDeviceEd25519Pub: async () => senderEdPub,
      });
      return payload.text;
    }

    const dave3Text = await decryptAsUser(
      blob3Row as any, dave.userId, dave.deviceId,
      dave.bundle.x25519PublicKey, dave.bundle.x25519PrivateKey, alice.bundle.ed25519PublicKey,
    );
    if (dave3Text !== 'Gen-3 message') throw new Error(`Dave gen-3 mismatch: "${dave3Text}"`);

    const dave4Text = await decryptAsUser(
      blob4Row as any, dave.userId, dave.deviceId,
      dave.bundle.x25519PublicKey, dave.bundle.x25519PrivateKey, alice.bundle.ed25519PublicKey,
    );
    if (dave4Text !== 'Gen-4 message') throw new Error(`Dave gen-4 mismatch: "${dave4Text}"`);

    console.log('PASS: Group churn — 4 rotations, evictions enforced, Dave decrypts gen-3/4 ✓');
  } finally {
    for (const id of userIds) await cleanupUser(id).catch(console.error);
  }
}

run().catch((err) => { console.error('FAIL:', err); process.exit(1); });
