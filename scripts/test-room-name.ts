/**
 * Test 13: Room Name Round-Trip
 *
 * Alice creates a room, encrypts a name under the room key, stores nonce +
 * ciphertext in the rooms table, then decrypts it. A second decryption with
 * a wrong room key must throw.
 *
 * Asserts:
 *   - Decrypted name matches the original plaintext
 *   - Decryption with a different room key throws (AEAD binding)
 *   - Decryption with null inputs returns null (graceful no-op)
 *
 * Run: npx tsx --env-file=.env.local scripts/test-room-name.ts
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

  const aliceUser = await createTestUser(`test-alice-rn-${Date.now()}@example.com`);
  const userIds   = [aliceUser.userId];
  const svc       = makeServiceClient();

  try {
    const alice = await provisionDevice(aliceUser.supabase, aliceUser.userId);

    // -- Create room ----------------------------------------------------------
    const { data: room, error: roomErr } = await aliceUser.supabase
      .from('rooms')
      .insert({ kind: 'group', created_by: alice.userId })
      .select('*').single();
    if (roomErr || !room) throw new Error(`createRoom: ${roomErr?.message}`);
    const generation = room.current_generation as number;
    const roomKey = await generateRoomKey(generation);

    // -- Encrypt and store the room name --------------------------------------
    const name = 'The Secret Lair';
    const { ciphertext, nonce } = await encryptRoomName({ name, roomId: room.id, roomKey });

    const { error: updateErr } = await svc.from('rooms').update({
      name_ciphertext: await toBase64(ciphertext),
      name_nonce: await toBase64(nonce),
    }).eq('id', room.id);
    if (updateErr) throw new Error(`storeRoomName: ${updateErr.message}`);

    // -- Fetch and decrypt the room name --------------------------------------
    const { data: fetchedRoom, error: fetchErr } = await aliceUser.supabase
      .from('rooms')
      .select('name_ciphertext, name_nonce')
      .eq('id', room.id)
      .single();
    if (fetchErr || !fetchedRoom) throw new Error(`fetchRoom: ${fetchErr?.message}`);

    const fr = fetchedRoom as { name_ciphertext: string | null; name_nonce: string | null };
    if (!fr.name_ciphertext || !fr.name_nonce) throw new Error('Room name fields are null after update');

    const decryptedName = await decryptRoomName({
      ciphertext: await fromBase64(fr.name_ciphertext),
      nonce: await fromBase64(fr.name_nonce),
      roomId: room.id, roomKey,
    });
    if (decryptedName !== name) {
      throw new Error(`Name mismatch: expected "${name}", got "${decryptedName}"`);
    }

    // -- Decryption with wrong key must throw ---------------------------------
    const wrongKey = await generateRoomKey(generation);
    try {
      await decryptRoomName({
        ciphertext: await fromBase64(fr.name_ciphertext),
        nonce: await fromBase64(fr.name_nonce),
        roomId: room.id, roomKey: wrongKey,
      });
      throw new Error('Vulnerability: Room name decrypted with wrong key — AEAD not enforcing key binding');
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Vulnerability')) throw err;
      // Expected: AEAD authentication error
    }

    // -- Null inputs return null (graceful no-op) -----------------------------
    const nullResult = await decryptRoomName({ ciphertext: null, nonce: null, roomId: room.id, roomKey });
    if (nullResult !== null) throw new Error(`Expected null for null inputs, got "${nullResult}"`);

    console.log('PASS: Room name round-trip verified; wrong-key + null-input guards work ✓');
  } finally {
    for (const id of userIds) await cleanupUser(id).catch(console.error);
  }
}

run().catch((err) => { console.error('FAIL:', err); process.exit(1); });
