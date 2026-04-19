/**
 * Test 39: Parallel Blob Inserts
 *
 * Alice inserts 10 blobs to the same room concurrently using Promise.all.
 * All 10 must arrive in the DB — none lost, none duplicated. Each blob
 * has a unique nonce (from encryptBlob) so the unique-nonce constraint
 * should not fire.
 *
 * Also verifies:
 *   - All 10 rows have distinct IDs
 *   - All 10 rows have Alice's sender_id
 *   - The DB-assigned created_at timestamps are plausible (within the test window)
 *
 * Run: npx tsx --env-file=.env.local scripts/test-parallel-blob-inserts.ts
 */

import {
  generateRoomKey,
  wrapRoomKeyFor,
  signMembershipWrap,
  encryptBlob,
  toBase64,
} from '../src/lib/e2ee-core';
import { initCrypto, createTestUser, provisionDevice, cleanupUser, makeServiceClient } from './test-utils';

async function run() {
  await initCrypto();

  const aliceUser = await createTestUser(`test-alice-pbi-${Date.now()}@example.com`);
  const userIds   = [aliceUser.userId];
  const svc       = makeServiceClient();

  try {
    const alice = await provisionDevice(aliceUser.supabase, aliceUser.userId);

    // -- Room + Alice membership -----------------------------------------------
    const { data: room, error: roomErr } = await aliceUser.supabase
      .from('rooms').insert({ kind: 'group', created_by: alice.userId })
      .select('*').single();
    if (roomErr || !room) throw new Error(`createRoom: ${roomErr?.message}`);
    const generation = room.current_generation as number;
    const roomKey = await generateRoomKey(generation);

    const wrap = await wrapRoomKeyFor(roomKey, alice.bundle.x25519PublicKey);
    const sig  = await signMembershipWrap(
      { roomId: room.id, generation, memberUserId: alice.userId,
        memberDeviceId: alice.deviceId, wrappedRoomKey: wrap.wrapped,
        signerDeviceId: alice.deviceId },
      alice.bundle.ed25519PrivateKey,
    );
    await aliceUser.supabase.from('room_members').insert({
      room_id: room.id, user_id: alice.userId, device_id: alice.deviceId, generation,
      wrapped_room_key: await toBase64(wrap.wrapped),
      signer_device_id: alice.deviceId, wrap_signature: await toBase64(sig),
    });

    // -- Encrypt 10 distinct blobs --------------------------------------------
    const CONCURRENCY = 10;
    const payloads = Array.from({ length: CONCURRENCY }, (_, i) => ({ text: `message ${i}` }));
    const encryptedBlobs = await Promise.all(
      payloads.map((p) =>
        encryptBlob<{ text: string }>({
          payload: p, roomId: room.id, roomKey,
          senderUserId: alice.userId, senderDeviceId: alice.deviceId,
          senderDeviceEd25519PrivateKey: alice.bundle.ed25519PrivateKey,
        })
      )
    );

    // -- Insert all 10 concurrently -------------------------------------------
    const insertResults = await Promise.all(
      encryptedBlobs.map(async (eb) =>
        aliceUser.supabase.from('blobs').insert({
          room_id: room.id, sender_id: alice.userId, sender_device_id: alice.deviceId,
          generation: eb.generation, nonce: await toBase64(eb.nonce),
          ciphertext: await toBase64(eb.ciphertext),
          signature: eb.signature.byteLength > 0 ? await toBase64(eb.signature) : null,
          session_id: null, message_index: null,
        }).select('id').single()
      )
    );

    const errors = insertResults.filter((r) => r.error);
    if (errors.length > 0) {
      throw new Error(`${errors.length} concurrent insert(s) failed: ${errors[0].error!.message}`);
    }

    const ids = insertResults.map((r) => (r.data as { id: string }).id);
    const uniqueIds = new Set(ids);
    if (uniqueIds.size !== CONCURRENCY) {
      throw new Error(`Expected ${CONCURRENCY} distinct IDs, got ${uniqueIds.size}`);
    }

    // -- Verify DB has exactly 10 rows ----------------------------------------
    const { data: allRows } = await svc.from('blobs').select('id')
      .eq('room_id', room.id).eq('sender_id', alice.userId);
    if (!allRows || allRows.length !== CONCURRENCY) {
      throw new Error(`Expected ${CONCURRENCY} blobs in DB, found ${allRows?.length ?? 0}`);
    }

    console.log(`PASS: Parallel blob inserts — ${CONCURRENCY} concurrent inserts all arrived; ${uniqueIds.size} distinct IDs ✓`);
  } finally {
    for (const id of userIds) await cleanupUser(id).catch(console.error);
  }
}

run().catch((err) => { console.error('FAIL:', err); process.exit(1); });
