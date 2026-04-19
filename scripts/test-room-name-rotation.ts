/**
 * Test 55: Room Name Encrypted in kick_and_rotate
 *
 * Alice creates a room, encrypts a name with gen-1 key. She kicks Carol and
 * passes a new encrypted name in kick_and_rotate. Bob (remaining member)
 * decrypts the new name with his gen-2 key. Alice's original gen-1 name
 * cannot be decrypted with the gen-2 key (different room key).
 *
 * Asserts:
 *   - encryptRoomName / decryptRoomName round-trip with correct key
 *   - After rotation, gen-2 members decrypt the new name
 *   - Gen-1 name ciphertext fails to decrypt with gen-2 key
 *   - Carol (evicted) has no gen-2 membership
 *
 * Run: npx tsx --env-file=.env.local scripts/test-room-name-rotation.ts
 */

import {
  generateRoomKey,
  wrapRoomKeyFor,
  signMembershipWrap,
  encryptRoomName,
  decryptRoomName,
  toBase64,
  fromBase64,
} from '../src/lib/e2ee-core';
import { initCrypto, createTestUser, provisionDevice, cleanupUser, makeServiceClient } from './test-utils';

async function run() {
  await initCrypto();

  const aliceUser = await createTestUser(`test-alice-rnr-${Date.now()}@example.com`);
  const bobUser   = await createTestUser(`test-bob-rnr-${Date.now()}@example.com`);
  const carolUser = await createTestUser(`test-carol-rnr-${Date.now()}@example.com`);
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

    for (const m of [alice, bob, carol]) {
      const wrap = await wrapRoomKeyFor(key1, m.bundle.x25519PublicKey);
      const sig  = await signMembershipWrap(
        { roomId: room.id, generation: gen1, memberUserId: m.userId,
          memberDeviceId: m.deviceId, wrappedRoomKey: wrap.wrapped,
          signerDeviceId: alice.deviceId },
        alice.bundle.ed25519PrivateKey,
      );
      const client = m === alice ? aliceUser.supabase : svc;
      await client.from('room_members').insert({
        room_id: room.id, user_id: m.userId, device_id: m.deviceId, generation: gen1,
        wrapped_room_key: await toBase64(wrap.wrapped),
        signer_device_id: alice.deviceId, wrap_signature: await toBase64(sig),
      });
    }

    // Gen-1 encrypted room name
    const gen1Name = await encryptRoomName({ name: 'Secret Project', roomId: room.id, roomKey: key1 });

    // -- Rotate to gen-2, evict Carol, pass new name --------------------------
    const gen2 = gen1 + 1;
    const key2 = await generateRoomKey(gen2);

    const gen2Wraps = await Promise.all([alice, bob].map(async (m) => {
      const wrap = await wrapRoomKeyFor(key2, m.bundle.x25519PublicKey);
      const sig  = await signMembershipWrap(
        { roomId: room.id, generation: gen2, memberUserId: m.userId,
          memberDeviceId: m.deviceId, wrappedRoomKey: wrap.wrapped,
          signerDeviceId: alice.deviceId },
        alice.bundle.ed25519PrivateKey,
      );
      return { user_id: m.userId, device_id: m.deviceId,
        wrapped_room_key: await toBase64(wrap.wrapped), wrap_signature: await toBase64(sig) };
    }));

    const gen2Name = await encryptRoomName({ name: 'New Secret Project', roomId: room.id, roomKey: key2 });

    const { error: rotErr } = await aliceUser.supabase.rpc('kick_and_rotate', {
      p_room_id: room.id, p_evictee_user_ids: [carol.userId],
      p_old_gen: gen1, p_new_gen: gen2,
      p_wraps: gen2Wraps, p_signer_device_id: alice.deviceId,
      p_name_ciphertext: await toBase64(gen2Name.ciphertext),
      p_name_nonce: await toBase64(gen2Name.nonce),
    });
    if (rotErr) throw new Error(`kick_and_rotate: ${rotErr.message}`);

    // -- Bob decrypts the new gen-2 name from the rooms row -------------------
    const { data: updatedRoom } = await svc.from('rooms').select('name_ciphertext, name_nonce')
      .eq('id', room.id).single();
    const ur = updatedRoom as { name_ciphertext: string | null; name_nonce: string | null };
    if (!ur.name_ciphertext || !ur.name_nonce) throw new Error('Room has no encrypted name after rotation');

    const decryptedName = await decryptRoomName({
      ciphertext: await fromBase64(ur.name_ciphertext),
      nonce: await fromBase64(ur.name_nonce),
      roomId: room.id,
      roomKey: key2,
    });
    if (decryptedName !== 'New Secret Project') {
      throw new Error(`Gen-2 name mismatch: "${decryptedName}"`);
    }

    // -- Gen-1 name ciphertext must fail with gen-2 key -----------------------
    try {
      await decryptRoomName({
        ciphertext: gen1Name.ciphertext,
        nonce: gen1Name.nonce,
        roomId: room.id,
        roomKey: key2,
      });
      throw new Error('Vulnerability: gen-1 name decrypted with gen-2 key');
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Vulnerability')) throw err;
    }

    // -- Carol has no gen-2 membership ----------------------------------------
    const { data: carolRows } = await svc.from('room_members').select('device_id')
      .eq('room_id', room.id).eq('user_id', carol.userId).eq('generation', gen2);
    if (carolRows && carolRows.length > 0) {
      throw new Error('Vulnerability: Carol has gen-2 membership after eviction');
    }

    console.log('PASS: Room name rotation — gen-2 name decrypted by Bob; gen-1 name rejected by gen-2 key; Carol evicted ✓');
  } finally {
    for (const id of userIds) await cleanupUser(id).catch(console.error);
  }
}

run().catch((err) => { console.error('FAIL:', err); process.exit(1); });
