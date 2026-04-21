/**
 * Test 56b: v2 Blob Sender Signature Verification (legacy read-path).
 *
 * v3 per-device envelopes are the default encoder; v2 remains a legacy read
 * path for blobs encrypted before the per-device migration. The sig lives
 * INSIDE the AEAD and is Ed25519 over the user's root (MSK) key. This test
 * manually constructs a v2 envelope, inserts it, and proves decryptBlob's
 * v2 verifier:
 *   - accepts a correct user-root pub
 *   - rejects an impostor pub with SIGNATURE_INVALID
 *   - rejects a missing senderEd25519PublicKey with SIGNATURE_INVALID
 *   - rejects a payload flipped post-sign (inner sig covers payloadBytes)
 *
 * Why: mutation testing M06 weakens the v3 sig check; the v2 path was not
 * previously exercised at all. If a mutation silently short-circuits the
 * v2 branch, a legacy blob could be forged — not hypothetical, because
 * /status and delta-sync still render v2 rows if they exist.
 *
 * Run: npx tsx --env-file=.env.local scripts/test-blob-sender-verification-v2.ts
 */

import {
  generateRoomKey,
  wrapRoomKeyFor,
  signMembershipWrap,
  signMessage,
  decryptBlob,
  generateDeviceKeyBundle,
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

const BLOB_DOMAIN_V2 = stringToBytes('vibecheck:blob:v2');
const NONCE_BYTES = 24;

async function buildAd(roomId: string, generation: number): Promise<Bytes> {
  const uuidBytes = await fromHex(roomId.replaceAll('-', ''));
  const gen = new Uint8Array(4);
  new DataView(gen.buffer).setUint32(0, generation, false);
  return concatBytes(uuidBytes, gen);
}

async function buildV2SigMessage(
  roomId: string,
  generation: number,
  nonce: Bytes,
  payloadBytes: Bytes,
): Promise<Bytes> {
  const uuidBytes = await fromHex(roomId.replaceAll('-', ''));
  const gen = new Uint8Array(4);
  new DataView(gen.buffer).setUint32(0, generation, false);
  return concatBytes(BLOB_DOMAIN_V2, uuidBytes, gen, nonce, payloadBytes);
}

/** Manually encode a v2 envelope and AEAD-seal it with the room key. */
async function encryptBlobV2<T>(params: {
  payload: T;
  roomId: string;
  roomKey: RoomKey;
  senderRootEd25519PrivateKey: Bytes;
}): Promise<EncryptedBlob> {
  const { payload, roomId, roomKey, senderRootEd25519PrivateKey } = params;
  const sodium = await getSodium();
  const nonce = await randomBytes(NONCE_BYTES);
  const payloadBytes = stringToBytes(JSON.stringify(payload));

  const sigBytes = await signMessage(
    await buildV2SigMessage(roomId, roomKey.generation, nonce, payloadBytes),
    senderRootEd25519PrivateKey,
  );
  const envelope = { v: 2 as const, sig: await toBase64(sigBytes), p: payload };
  const plaintext = stringToBytes(JSON.stringify(envelope));

  const ad = await buildAd(roomId, roomKey.generation);
  const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    plaintext, ad, null, nonce, roomKey.key,
  );

  return {
    nonce,
    ciphertext,
    signature: new Uint8Array(0),
    generation: roomKey.generation,
  };
}

/** Tamper: decrypt, swap payload text, re-encrypt with same nonce+key (sig unchanged). */
async function tamperPayloadInPlace(
  blob: EncryptedBlob,
  roomId: string,
  roomKey: RoomKey,
): Promise<EncryptedBlob> {
  const sodium = await getSodium();
  const ad = await buildAd(roomId, blob.generation);
  const plain = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
    null, blob.ciphertext, ad, blob.nonce, roomKey.key,
  );
  const env = JSON.parse(new TextDecoder().decode(plain)) as { v: 2; sig: string; p: { text: string } };
  env.p = { text: 'FORGED' };
  const newPlain = stringToBytes(JSON.stringify(env));
  const newCt = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    newPlain, ad, null, blob.nonce, roomKey.key,
  );
  return { ...blob, ciphertext: newCt };
}

async function run() {
  await initCrypto();

  const aliceUser = await createTestUser(`test-alice-bsvv2-${Date.now()}@example.com`);
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

    // -- Alice writes a v2 blob (MSK-signed, inside AEAD) ---------------------
    const encBlob = await encryptBlobV2<{ text: string }>({
      payload: { text: 'v2 legacy message' },
      roomId: room.id,
      roomKey,
      senderRootEd25519PrivateKey: alice.msk.ed25519PrivateKey,
    });
    const { data: blobRow, error: blobErr } = await aliceUser.supabase.from('blobs').insert({
      room_id: room.id, sender_id: alice.userId, sender_device_id: alice.deviceId,
      generation: encBlob.generation, nonce: await toBase64(encBlob.nonce),
      ciphertext: await toBase64(encBlob.ciphertext),
      signature: null, session_id: null, message_index: null,
    }).select('*').single();
    if (blobErr || !blobRow) throw new Error(`blob insert: ${blobErr?.message}`);

    const row = blobRow as { nonce: string; ciphertext: string; generation: number };
    const wireBlob: EncryptedBlob = {
      nonce: await fromBase64(row.nonce),
      ciphertext: await fromBase64(row.ciphertext),
      signature: new Uint8Array(0),
      generation: row.generation, sessionId: null, messageIndex: null,
    };

    // -- Correct user-root pub decrypts ---------------------------------------
    const { payload } = await decryptBlob<{ text: string }>({
      blob: wireBlob, roomId: room.id, roomKey,
      senderEd25519PublicKey: alice.msk.ed25519PublicKey,
    });
    if (payload.text !== 'v2 legacy message') throw new Error(`Plaintext mismatch: "${payload.text}"`);

    // -- Impostor pub throws SIGNATURE_INVALID --------------------------------
    const impostor = await generateUserMasterKey();
    try {
      await decryptBlob<{ text: string }>({
        blob: wireBlob, roomId: room.id, roomKey,
        senderEd25519PublicKey: impostor.ed25519PublicKey,
      });
      throw new Error('Vulnerability: v2 decryptBlob accepted impostor user-root pub');
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Vulnerability')) throw err;
      // Expected.
    }

    // -- A different (device-bundle) pub also throws --------------------------
    const deviceBundle = await generateDeviceKeyBundle(crypto.randomUUID());
    try {
      await decryptBlob<{ text: string }>({
        blob: wireBlob, roomId: room.id, roomKey,
        senderEd25519PublicKey: deviceBundle.ed25519PublicKey,
      });
      throw new Error('Vulnerability: v2 decryptBlob accepted impostor device pub');
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Vulnerability')) throw err;
    }

    // -- Missing pubkey — v2 branch must refuse instead of skipping the check -
    try {
      await decryptBlob<{ text: string }>({
        blob: wireBlob, roomId: room.id, roomKey,
        // senderEd25519PublicKey omitted
      });
      throw new Error('Vulnerability: v2 decryptBlob decrypted with no sender pub supplied');
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Vulnerability')) throw err;
    }

    // -- Payload swapped post-sign — AEAD reseal, original sig no longer covers it
    const forged = await tamperPayloadInPlace(wireBlob, room.id, roomKey);
    try {
      await decryptBlob<{ text: string }>({
        blob: forged, roomId: room.id, roomKey,
        senderEd25519PublicKey: alice.msk.ed25519PublicKey,
      });
      throw new Error('Vulnerability: v2 decryptBlob accepted forged payload under original sig');
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Vulnerability')) throw err;
    }

    console.log('PASS: v2 blob sender verification — correct pub decrypts; impostor/missing/forged rejected ✓');
  } finally {
    await cleanupUser(aliceUser.userId).catch(console.error);
  }
}

run().catch((err) => { console.error('FAIL:', err); process.exit(1); });
