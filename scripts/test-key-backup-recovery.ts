/**
 * Test 18: Key Backup → Device Loss → Recovery
 *
 * Alice encrypts a room key under a backup key and stores it in key_backup.
 * Simulates "device loss" by using a brand-new device bundle.
 * The new device has the backup key (from recovery phrase) and uses it to
 * recover the room key, then decrypts a pre-loss message.
 *
 * Asserts:
 *   - encryptRoomKeyForBackup / decryptRoomKeyFromBackup round-trips correctly
 *   - The recovered room key allows decryption of pre-loss messages
 *   - A wrong backup key throws (AEAD authentication)
 *
 * Run: npx tsx --env-file=.env.local scripts/test-key-backup-recovery.ts
 */

import {
  generateRoomKey,
  wrapRoomKeyFor,
  signMembershipWrap,
  encryptBlob,
  decryptBlob,
  generateBackupKey,
  encryptRoomKeyForBackup,
  decryptRoomKeyFromBackup,
  fromBase64,
  toBase64,
  type EncryptedBlob,
  type RoomKey,
} from '../src/lib/e2ee-core';
import { initCrypto, createTestUser, provisionDevice, cleanupUser, makeServiceClient } from './test-utils';

async function run() {
  await initCrypto();

  const aliceUser = await createTestUser(`test-alice-kbr-${Date.now()}@example.com`);
  const userIds   = [aliceUser.userId];
  const svc       = makeServiceClient();

  try {
    const alice = await provisionDevice(aliceUser.supabase, aliceUser.userId);

    // -- Generate backup key (normally derived from recovery phrase) -----------
    const backupKey = await generateBackupKey();

    // -- Alice creates room and sends a message --------------------------------
    const { data: room, error: roomErr } = await aliceUser.supabase
      .from('rooms')
      .insert({ kind: 'group', created_by: alice.userId })
      .select('*').single();
    if (roomErr || !room) throw new Error(`createRoom: ${roomErr?.message}`);
    const generation = room.current_generation as number;
    const roomKey: RoomKey = await generateRoomKey(generation);

    const wrap = await wrapRoomKeyFor(roomKey, alice.bundle.x25519PublicKey);
    const sig  = await signMembershipWrap(
      { roomId: room.id, generation, memberUserId: alice.userId,
        memberDeviceId: alice.deviceId, wrappedRoomKey: wrap.wrapped,
        signerDeviceId: alice.deviceId },
      alice.bundle.ed25519PrivateKey,
    );
    await aliceUser.supabase.from('room_members').insert({
      room_id: room.id, user_id: alice.userId, device_id: alice.deviceId,
      generation, wrapped_room_key: await toBase64(wrap.wrapped),
      signer_device_id: alice.deviceId, wrap_signature: await toBase64(sig),
    });

    const preLossBlob = await encryptBlob<{ text: string }>({
      payload: { text: 'Before device loss' },
      roomId: room.id, roomKey,
      senderUserId: alice.userId, senderDeviceId: alice.deviceId,
      senderDeviceEd25519PrivateKey: alice.bundle.ed25519PrivateKey,
    });
    const { data: blobRow, error: blobErr } = await aliceUser.supabase.from('blobs').insert({
      room_id: room.id, sender_id: alice.userId, sender_device_id: alice.deviceId,
      generation: preLossBlob.generation, nonce: await toBase64(preLossBlob.nonce),
      ciphertext: await toBase64(preLossBlob.ciphertext),
      signature: preLossBlob.signature.byteLength > 0 ? await toBase64(preLossBlob.signature) : null,
      session_id: null, message_index: null,
    }).select('*').single();
    if (blobErr || !blobRow) throw new Error(`insertBlob: ${blobErr?.message}`);

    // -- Backup the room key --------------------------------------------------
    const { ciphertext: backupCt, nonce: backupNonce } = await encryptRoomKeyForBackup({
      roomKey, backupKey, roomId: room.id,
    });

    // Store in key_backup table
    const { error: backupErr } = await aliceUser.supabase.from('key_backup').insert({
      user_id: alice.userId,
      room_id: room.id,
      generation,
      ciphertext: await toBase64(backupCt),
      nonce: await toBase64(backupNonce),
    });
    if (backupErr) throw new Error(`storeKeyBackup: ${backupErr.message}`);

    // -- Simulate device loss: use only the backup key to recover room key ----
    // (A new device wouldn't have the original x25519 private key)
    const { data: backupRow, error: backupFetchErr } = await aliceUser.supabase
      .from('key_backup')
      .select('ciphertext, nonce, generation')
      .eq('room_id', room.id)
      .eq('generation', generation)
      .single();
    if (backupFetchErr || !backupRow) throw new Error(`fetchBackup: ${backupFetchErr?.message}`);

    const br = backupRow as { ciphertext: string; nonce: string; generation: number };
    const recoveredKey = await decryptRoomKeyFromBackup({
      ciphertext: await fromBase64(br.ciphertext),
      nonce: await fromBase64(br.nonce),
      generation: br.generation,
      backupKey,
      roomId: room.id,
    });

    if (recoveredKey.generation !== generation) {
      throw new Error(`Generation mismatch: expected ${generation}, got ${recoveredKey.generation}`);
    }

    // -- Decrypt the pre-loss message with the recovered key ------------------
    const row = blobRow as {
      nonce: string; ciphertext: string; signature: string | null;
      generation: number; session_id: string | null; message_index: number | null;
    };
    const wireBlob: EncryptedBlob = {
      nonce: await fromBase64(row.nonce),
      ciphertext: await fromBase64(row.ciphertext),
      signature: row.signature ? await fromBase64(row.signature) : new Uint8Array(0),
      generation: row.generation, sessionId: null, messageIndex: null,
    };
    const { payload } = await decryptBlob<{ text: string }>({
      blob: wireBlob, roomId: room.id, roomKey: recoveredKey,
      resolveSenderDeviceEd25519Pub: async () => alice.bundle.ed25519PublicKey,
    });
    if (payload.text !== 'Before device loss') {
      throw new Error(`Plaintext mismatch: "${payload.text}"`);
    }

    // -- Wrong backup key throws AEAD error -----------------------------------
    const wrongBackupKey = await generateBackupKey();
    try {
      await decryptRoomKeyFromBackup({
        ciphertext: await fromBase64(br.ciphertext),
        nonce: await fromBase64(br.nonce),
        generation: br.generation,
        backupKey: wrongBackupKey,
        roomId: room.id,
      });
      throw new Error('Vulnerability: Wrong backup key decrypted room key — AEAD broken');
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Vulnerability')) throw err;
      // Expected: AEAD authentication failure
    }

    console.log('PASS: Key backup → device loss → recovery — pre-loss message decrypted with recovered key ✓');
  } finally {
    for (const id of userIds) await cleanupUser(id).catch(console.error);
  }
}

run().catch((err) => { console.error('FAIL:', err); process.exit(1); });
