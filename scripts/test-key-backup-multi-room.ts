/**
 * Test 42: Key Backup Multi-Room Restore
 *
 * Alice has three rooms, each with a backed-up room key in key_backup. A new
 * device downloads all three rows and decrypts each room key using the backup
 * key. Each recovered key then decrypts a blob from the correct room. A key
 * from room-A must not decrypt a blob from room-B (AD binding).
 *
 * Asserts:
 *   - All 3 key_backup rows download and decrypt successfully
 *   - Each recovered key decrypts the matching room blob
 *   - Wrong room_id in decryptRoomKeyFromBackup causes DECRYPT_FAILED
 *
 * Run: npx tsx --env-file=.env.local scripts/test-key-backup-multi-room.ts
 */

import {
  generateRoomKey,
  wrapRoomKeyFor,
  signMembershipWrap,
  encryptBlob,
  decryptBlob,
  encryptRoomKeyForBackup,
  decryptRoomKeyFromBackup,
  randomBytes,
  toBase64,
  fromBase64,
  CryptoError,
  type EncryptedBlob,
} from '../src/lib/e2ee-core';
import { initCrypto, createTestUser, provisionDevice, cleanupUser, makeServiceClient } from './test-utils';

async function run() {
  await initCrypto();

  const aliceUser = await createTestUser(`test-alice-kbmr-${Date.now()}@example.com`);
  const userIds   = [aliceUser.userId];
  const svc       = makeServiceClient();

  try {
    const alice     = await provisionDevice(aliceUser.supabase, aliceUser.userId);
    const backupKey = await randomBytes(32);

    const rooms: Array<{ id: string; generation: number; roomKey: Awaited<ReturnType<typeof generateRoomKey>> }> = [];
    const blobRows: Array<Record<string, unknown>> = [];

    // -- Create 3 rooms, back up each key, send a message ---------------------
    for (let i = 0; i < 3; i++) {
      const { data: room, error: roomErr } = await aliceUser.supabase
        .from('rooms').insert({ kind: 'group', created_by: alice.userId })
        .select('*').single();
      if (roomErr || !room) throw new Error(`createRoom ${i}: ${roomErr?.message}`);
      const generation = room.current_generation as number;
      const roomKey = await generateRoomKey(generation);
      rooms.push({ id: room.id, generation, roomKey });

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

      const { ciphertext: bkCt, nonce: bkNonce } = await encryptRoomKeyForBackup({
        roomKey: { key: roomKey.key, generation },
        backupKey,
        roomId: room.id,
      });
      await svc.from('key_backup').insert({
        user_id: alice.userId, room_id: room.id, generation,
        ciphertext: await toBase64(bkCt), nonce: await toBase64(bkNonce),
      });

      const encBlob = await encryptBlob<{ idx: number }>({
        payload: { idx: i }, roomId: room.id, roomKey,
        senderUserId: alice.userId, senderDeviceId: alice.deviceId,
        senderDeviceEd25519PrivateKey: alice.bundle.ed25519PrivateKey,
      });
      const { data: blobRow } = await aliceUser.supabase.from('blobs').insert({
        room_id: room.id, sender_id: alice.userId, sender_device_id: alice.deviceId,
        generation: encBlob.generation, nonce: await toBase64(encBlob.nonce),
        ciphertext: await toBase64(encBlob.ciphertext),
        signature: encBlob.signature.byteLength > 0 ? await toBase64(encBlob.signature) : null,
        session_id: null, message_index: null,
      }).select('*').single();
      blobRows.push(blobRow as Record<string, unknown>);
    }

    // -- Download all 3 key_backup rows and restore ---------------------------
    const { data: kbRows } = await svc.from('key_backup').select('*')
      .eq('user_id', alice.userId).order('created_at');
    if (!kbRows || kbRows.length !== 3) {
      throw new Error(`Expected 3 key_backup rows, found ${kbRows?.length ?? 0}`);
    }

    for (let i = 0; i < 3; i++) {
      const kb = kbRows[i] as { ciphertext: string; nonce: string; generation: number; room_id: string };
      const restoredKey = await decryptRoomKeyFromBackup({
        ciphertext: await fromBase64(kb.ciphertext),
        nonce: await fromBase64(kb.nonce),
        generation: kb.generation,
        backupKey,
        roomId: kb.room_id,
      });

      const row = blobRows[i] as {
        nonce: string; ciphertext: string; signature: string | null;
        generation: number; room_id: string;
      };
      const wireBlob: EncryptedBlob = {
        nonce: await fromBase64(row.nonce), ciphertext: await fromBase64(row.ciphertext),
        signature: row.signature ? await fromBase64(row.signature) : new Uint8Array(0),
        generation: row.generation, sessionId: null, messageIndex: null,
      };
      const { payload } = await decryptBlob<{ idx: number }>({
        blob: wireBlob, roomId: row.room_id,
        roomKey: { key: restoredKey.key, generation: restoredKey.generation },
        resolveSenderDeviceEd25519Pub: async () => alice.bundle.ed25519PublicKey,
      });
      if (payload.idx !== i) throw new Error(`Room ${i} payload mismatch: got ${payload.idx}`);
    }

    // -- Wrong room_id in decryptRoomKeyFromBackup causes DECRYPT_FAILED ------
    const kb0 = kbRows[0] as { ciphertext: string; nonce: string; generation: number };
    try {
      await decryptRoomKeyFromBackup({
        ciphertext: await fromBase64(kb0.ciphertext),
        nonce: await fromBase64(kb0.nonce),
        generation: kb0.generation,
        backupKey,
        roomId: rooms[1].id, // wrong room
      });
      throw new Error('Vulnerability: wrong roomId accepted by decryptRoomKeyFromBackup');
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Vulnerability')) throw err;
      if (err instanceof CryptoError && err.code !== 'DECRYPT_FAILED') {
        throw new Error(`Expected DECRYPT_FAILED, got ${(err as CryptoError).code}`);
      }
    }

    console.log('PASS: Key backup multi-room restore — 3 rooms recovered; AD binding blocks wrong-room decrypt ✓');
  } finally {
    for (const id of userIds) await cleanupUser(id).catch(console.error);
  }
}

run().catch((err) => { console.error('FAIL:', err); process.exit(1); });
