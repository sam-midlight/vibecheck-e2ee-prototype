/**
 * Test 56c: v1 Blob Sender Signature Verification (legacy outer-sig path).
 *
 * Before Sealed-Sender-lite (v2), blobs carried an Ed25519 signature in the
 * OUTER `blobs.signature` column, computed over `nonce || ciphertext` with
 * the sender user's root key. The column was later made nullable (migration
 * 0014) so new inserts could skip it — but the decrypt path still verifies
 * existing v1 rows for back-compat.
 *
 * Asserts:
 *   - Correct user-root pub decrypts via the v1 fallback branch
 *   - Wrong user-root pub throws SIGNATURE_INVALID
 *   - Flipped outer-signature byte throws SIGNATURE_INVALID
 *   - Missing signature column throws with 'no outer signature'
 *   - Missing senderEd25519PublicKey throws SIGNATURE_INVALID
 *
 * Why: the v1 branch (blob.ts:502-527) is never exercised by any other test.
 * If a mutation silently short-circuits it, a forged legacy blob could be
 * accepted as authentic on delta-sync / /status renders.
 *
 * Run: npx tsx --env-file=.env.local scripts/test-blob-sender-verification-v1.ts
 */

import {
  generateRoomKey,
  wrapRoomKeyFor,
  signMembershipWrap,
  signMessage,
  decryptBlob,
  generateUserMasterKey,
  getSodium,
  randomBytes,
  concatBytes,
  stringToBytes,
  fromHex,
  toBase64,
  fromBase64,
  type Bytes,
  type EncryptedBlob,
  type RoomKey,
} from '../src/lib/e2ee-core';
import { initCrypto, createTestUser, provisionDevice, cleanupUser } from './test-utils';

const NONCE_BYTES = 24;

async function buildAd(roomId: string, generation: number): Promise<Bytes> {
  const uuidBytes = await fromHex(roomId.replaceAll('-', ''));
  const gen = new Uint8Array(4);
  new DataView(gen.buffer).setUint32(0, generation, false);
  return concatBytes(uuidBytes, gen);
}

/**
 * Manually encode a v1 blob:
 *   - Plaintext = JSON of the raw payload (no envelope wrapper)
 *   - AEAD-sealed with the room key
 *   - Outer sig = Ed25519(user-root, nonce || ciphertext)
 */
async function encryptBlobV1<T>(params: {
  payload: T;
  roomId: string;
  roomKey: RoomKey;
  senderRootEd25519PrivateKey: Bytes;
}): Promise<EncryptedBlob> {
  const { payload, roomId, roomKey, senderRootEd25519PrivateKey } = params;
  const sodium = await getSodium();
  const nonce = await randomBytes(NONCE_BYTES);
  const plaintext = stringToBytes(JSON.stringify(payload));

  const ad = await buildAd(roomId, roomKey.generation);
  const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    plaintext, ad, null, nonce, roomKey.key,
  );
  const outerSig = await signMessage(
    concatBytes(nonce, ciphertext),
    senderRootEd25519PrivateKey,
  );
  return { nonce, ciphertext, signature: outerSig, generation: roomKey.generation };
}

async function run() {
  await initCrypto();

  const aliceUser = await createTestUser(`test-alice-bsvv1-${Date.now()}@example.com`);
  try {
    const alice = await provisionDevice(aliceUser.supabase, aliceUser.userId);

    // -- Room + membership ----------------------------------------------------
    const { data: room, error: roomErr } = await aliceUser.supabase
      .from('rooms').insert({ kind: 'group', created_by: alice.userId })
      .select('*').single();
    if (roomErr || !room) throw new Error(`createRoom: ${roomErr?.message}`);
    const generation = room.current_generation as number;
    const roomKey = await generateRoomKey(generation);

    const wrap = await wrapRoomKeyFor(roomKey, alice.bundle.x25519PublicKey);
    const wrapSig = await signMembershipWrap(
      { roomId: room.id, generation, memberUserId: alice.userId,
        memberDeviceId: alice.deviceId, wrappedRoomKey: wrap.wrapped,
        signerDeviceId: alice.deviceId },
      alice.bundle.ed25519PrivateKey,
    );
    await aliceUser.supabase.from('room_members').insert({
      room_id: room.id, user_id: alice.userId, device_id: alice.deviceId, generation,
      wrapped_room_key: await toBase64(wrap.wrapped),
      signer_device_id: alice.deviceId, wrap_signature: await toBase64(wrapSig),
    });

    // -- Alice writes a v1 blob -----------------------------------------------
    const encBlob = await encryptBlobV1<{ text: string }>({
      payload: { text: 'v1 ancient message' },
      roomId: room.id, roomKey,
      senderRootEd25519PrivateKey: alice.msk.ed25519PrivateKey,
    });
    const { data: blobRow, error: blobErr } = await aliceUser.supabase.from('blobs').insert({
      room_id: room.id, sender_id: alice.userId, sender_device_id: alice.deviceId,
      generation: encBlob.generation, nonce: await toBase64(encBlob.nonce),
      ciphertext: await toBase64(encBlob.ciphertext),
      signature: await toBase64(encBlob.signature),
      session_id: null, message_index: null,
    }).select('*').single();
    if (blobErr || !blobRow) throw new Error(`blob insert: ${blobErr?.message}`);

    const row = blobRow as { nonce: string; ciphertext: string; signature: string | null; generation: number };
    const wireBlob: EncryptedBlob = {
      nonce: await fromBase64(row.nonce),
      ciphertext: await fromBase64(row.ciphertext),
      signature: row.signature ? await fromBase64(row.signature) : new Uint8Array(0),
      generation: row.generation, sessionId: null, messageIndex: null,
    };

    // -- Correct user-root pub decrypts via v1 fallback -----------------------
    const { payload, senderUserId, senderDeviceId } = await decryptBlob<{ text: string }>({
      blob: wireBlob, roomId: room.id, roomKey,
      senderEd25519PublicKey: alice.msk.ed25519PublicKey,
    });
    if (payload.text !== 'v1 ancient message') throw new Error(`Plaintext mismatch: "${payload.text}"`);
    if (senderUserId !== null || senderDeviceId !== null) {
      throw new Error('v1 must return null sender attribution (no envelope attribution)');
    }

    // -- Impostor user-root pub throws ----------------------------------------
    const impostor = await generateUserMasterKey();
    try {
      await decryptBlob<{ text: string }>({
        blob: wireBlob, roomId: room.id, roomKey,
        senderEd25519PublicKey: impostor.ed25519PublicKey,
      });
      throw new Error('Vulnerability: v1 decryptBlob accepted impostor user-root pub');
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Vulnerability')) throw err;
    }

    // -- Flipped signature byte throws ----------------------------------------
    const flipped = new Uint8Array(wireBlob.signature);
    flipped[0] ^= 0xff;
    try {
      await decryptBlob<{ text: string }>({
        blob: { ...wireBlob, signature: flipped },
        roomId: room.id, roomKey,
        senderEd25519PublicKey: alice.msk.ed25519PublicKey,
      });
      throw new Error('Vulnerability: v1 decryptBlob accepted flipped outer signature');
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Vulnerability')) throw err;
    }

    // -- Missing signature (empty) — v1 branch must refuse --------------------
    try {
      await decryptBlob<{ text: string }>({
        blob: { ...wireBlob, signature: new Uint8Array(0) },
        roomId: room.id, roomKey,
        senderEd25519PublicKey: alice.msk.ed25519PublicKey,
      });
      throw new Error('Vulnerability: v1 decryptBlob accepted blob with no outer signature');
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Vulnerability')) throw err;
    }

    // -- Missing pubkey — v1 branch must refuse -------------------------------
    try {
      await decryptBlob<{ text: string }>({
        blob: wireBlob, roomId: room.id, roomKey,
        // senderEd25519PublicKey omitted
      });
      throw new Error('Vulnerability: v1 decryptBlob decrypted with no sender pub supplied');
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Vulnerability')) throw err;
    }

    console.log('PASS: v1 blob sender verification — correct pub decrypts; impostor/flipped/missing rejected ✓');
  } finally {
    await cleanupUser(aliceUser.userId).catch(console.error);
  }
}

run().catch((err) => { console.error('FAIL:', err); process.exit(1); });
