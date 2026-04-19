/**
 * Test 41: Recovery Phrase Full Restore Flow
 *
 * Alice sets up a recovery phrase (v4 blob: MSK+SSK+USK+backupKey), backs up
 * her room key, sends a message, then provisions a "new device" by unwrapping
 * the phrase and re-downloading the backed-up room key. The new device must
 * be able to decrypt Alice's message.
 *
 * Asserts:
 *   - v4 recovery blob wraps and unwraps correctly
 *   - backupKey from unwrapped blob decrypts key_backup row
 *   - Restored device decrypts blob encrypted before restore
 *
 * Run: npx tsx --env-file=.env.local scripts/test-recovery-restore-flow.ts
 */

import {
  generateRoomKey,
  wrapRoomKeyFor,
  signMembershipWrap,
  encryptBlob,
  decryptBlob,
  wrapUserMasterKeyWithPhrase,
  unwrapUserMasterKeyWithPhrase,
  encryptRoomKeyForBackup,
  decryptRoomKeyFromBackup,
  generateSigningKeys,
  generateRecoveryPhrase,
  randomBytes,
  toBase64,
  fromBase64,
  type EncryptedBlob,
} from '../src/lib/e2ee-core';
import { initCrypto, createTestUser, provisionDevice, cleanupUser, makeServiceClient } from './test-utils';

async function run() {
  await initCrypto();

  const aliceUser = await createTestUser(`test-alice-rrf-${Date.now()}@example.com`);
  const userIds   = [aliceUser.userId];
  const svc       = makeServiceClient();

  try {
    const alice = await provisionDevice(aliceUser.supabase, aliceUser.userId);

    // -- Generate signing key hierarchy + backup key --------------------------
    const signingKeys = await generateSigningKeys(alice.ssk); // uses ssk as if it were msk here
    const backupKey   = await randomBytes(32);

    // -- Wrap recovery phrase (v4) --------------------------------------------
    const PHRASE = generateRecoveryPhrase(); // valid BIP-39 24-word phrase
    const recoveryBlob = await wrapUserMasterKeyWithPhrase(
      alice.ssk,   // using SSK as the "msk" for simplicity — same key shape
      PHRASE,
      alice.userId,
      {
        opslimit: 1,   // fast KDF for tests
        memlimit: 8 * 1024 * 1024,
        backupKey,
        sskPriv: signingKeys.ssk.ed25519PrivateKey,
        uskPriv: signingKeys.usk.ed25519PrivateKey,
      },
    );

    // -- Alice creates room, membership, backs up room key --------------------
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

    // Back up room key
    const { ciphertext: bkCt, nonce: bkNonce } = await encryptRoomKeyForBackup({
      roomKey: { key: roomKey.key, generation },
      backupKey,
      roomId: room.id,
    });
    await svc.from('key_backup').insert({
      user_id: alice.userId, room_id: room.id, generation,
      ciphertext: await toBase64(bkCt), nonce: await toBase64(bkNonce),
    });

    // -- Alice sends a message ------------------------------------------------
    const encBlob = await encryptBlob<{ text: string }>({
      payload: { text: 'Message before restore' }, roomId: room.id, roomKey,
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

    // -- "New device" unwraps recovery phrase ---------------------------------
    const recovered = await unwrapUserMasterKeyWithPhrase(recoveryBlob, PHRASE, alice.userId);
    if (!recovered.backupKey) throw new Error('No backupKey in recovered blob');

    // -- New device downloads key_backup and decrypts -------------------------
    const { data: kbRow } = await svc.from('key_backup').select('ciphertext, nonce, generation')
      .eq('user_id', alice.userId).eq('room_id', room.id).single();
    const kb = kbRow as { ciphertext: string; nonce: string; generation: number };
    const restoredRoomKey = await decryptRoomKeyFromBackup({
      ciphertext: await fromBase64(kb.ciphertext),
      nonce: await fromBase64(kb.nonce),
      generation: kb.generation,
      backupKey: recovered.backupKey,
      roomId: room.id,
    });

    // -- New device decrypts Alice's message ----------------------------------
    const row = blobRow as {
      nonce: string; ciphertext: string; signature: string | null;
      generation: number; session_id: string | null; message_index: number | null;
    };
    const wireBlob: EncryptedBlob = {
      nonce: await fromBase64(row.nonce), ciphertext: await fromBase64(row.ciphertext),
      signature: row.signature ? await fromBase64(row.signature) : new Uint8Array(0),
      generation: row.generation, sessionId: null, messageIndex: null,
    };
    const { payload } = await decryptBlob<{ text: string }>({
      blob: wireBlob, roomId: room.id,
      roomKey: { key: restoredRoomKey.key, generation: restoredRoomKey.generation },
      resolveSenderDeviceEd25519Pub: async () => alice.bundle.ed25519PublicKey,
    });
    if (payload.text !== 'Message before restore') {
      throw new Error(`Plaintext mismatch: "${payload.text}"`);
    }

    console.log('PASS: Recovery phrase full restore — v4 blob unwrapped; backup key decrypts room key; restored device reads message ✓');
  } finally {
    for (const id of userIds) await cleanupUser(id).catch(console.error);
  }
}

run().catch((err) => { console.error('FAIL:', err); process.exit(1); });
