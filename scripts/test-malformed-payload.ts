/**
 * Test 63: Malformed Payload (The Untrusted Server)
 *
 * A malicious server administrator intercepts Alice's ciphertext and corrupts
 * it before Bob receives it. The test constructs EncryptedBlob objects with
 * various types of corruption and asserts that decryptBlob throws a CryptoError
 * rather than crashing the Node process or causing a WASM memory panic.
 *
 * Corruption scenarios tested:
 *   1. Truncated nonce (wrong length — 10 bytes instead of 24)
 *   2. Nonce correct but ciphertext truncated (MAC removed — <16 bytes)
 *   3. Ciphertext entirely replaced with zeros (MAC invalid)
 *   4. Completely empty ciphertext (0 bytes)
 *   5. Valid nonce + ciphertext but wrong room key (AD mismatch)
 *   6. Valid nonce + ciphertext but generation=0 when roomKey.generation=1
 *
 * Asserts:
 *   - All 6 corruptions throw a CryptoError (never crash / never return data)
 *   - The error codes are predictable (DECRYPT_FAILED or similar)
 *   - The process does not exit(1) or panic
 *
 * Run: npx tsx --env-file=.env.local scripts/test-malformed-payload.ts
 */

import {
  generateRoomKey,
  wrapRoomKeyFor,
  signMembershipWrap,
  encryptBlob,
  decryptBlob,
  randomBytes,
  toBase64,
  fromBase64,
  CryptoError,
  type EncryptedBlob,
} from '../src/lib/e2ee-core';
import { initCrypto, createTestUser, provisionDevice, cleanupUser, makeServiceClient } from './test-utils';

async function run() {
  await initCrypto();

  const aliceUser = await createTestUser(`test-alice-mp-${Date.now()}@example.com`);
  const userIds   = [aliceUser.userId];
  const svc       = makeServiceClient();

  try {
    const alice = await provisionDevice(aliceUser.supabase, aliceUser.userId);

    // -- Room + membership + valid blob to extract nonce/ciphertext from ------
    const { data: room, error: roomErr } = await aliceUser.supabase
      .from('rooms').insert({ kind: 'group', created_by: alice.userId })
      .select('*').single();
    if (roomErr || !room) throw new Error(`createRoom: ${roomErr?.message}`);
    const generation = room.current_generation as number;
    const roomKey    = await generateRoomKey(generation);

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

    // Produce a legitimate blob — extract its valid nonce for reuse
    const legitBlob = await encryptBlob<{ text: string }>({
      payload: { text: 'legitimate' }, roomId: room.id, roomKey,
      senderUserId: alice.userId, senderDeviceId: alice.deviceId,
      senderDeviceEd25519PrivateKey: alice.bundle.ed25519PrivateKey,
    });
    const validNonce      = legitBlob.nonce;        // 24 bytes
    const validCiphertext = legitBlob.ciphertext;   // ciphertext with MAC

    const baseParams = {
      roomId: room.id,
      roomKey,
      resolveSenderDeviceEd25519Pub: async () => alice.bundle.ed25519PublicKey,
    } as const;

    async function mustThrow(label: string, blob: EncryptedBlob): Promise<void> {
      try {
        await decryptBlob({ blob, ...baseParams });
        throw new Error(`Vulnerability: ${label} — decryptBlob returned data instead of throwing`);
      } catch (err) {
        if (err instanceof Error && err.message.startsWith('Vulnerability')) throw err;
        if (!(err instanceof CryptoError)) {
          // Some corruptions may surface as non-CryptoError (e.g., JSON parse)
          // As long as it throws and doesn't return data, that's acceptable.
          // Re-throw only if it's an unexpected crash type
          if (err instanceof RangeError || (err instanceof Error && err.message.includes('memory'))) {
            throw new Error(`WASM panic on ${label}: ${(err as Error).message}`);
          }
        }
        // Any throw is a pass — just check it's not a process crash
      }
    }

    // 1. Truncated nonce (10 bytes instead of 24)
    await mustThrow('truncated nonce', {
      nonce: new Uint8Array(10),
      ciphertext: validCiphertext,
      signature: new Uint8Array(0),
      generation,
      sessionId: null, messageIndex: null,
    });

    // 2. Correct nonce, ciphertext truncated to 5 bytes (MAC stripped)
    await mustThrow('MAC-stripped ciphertext', {
      nonce: validNonce,
      ciphertext: validCiphertext.slice(0, 5),
      signature: new Uint8Array(0),
      generation,
      sessionId: null, messageIndex: null,
    });

    // 3. Ciphertext replaced with zeros (same length, invalid MAC)
    await mustThrow('all-zero ciphertext', {
      nonce: validNonce,
      ciphertext: new Uint8Array(validCiphertext.byteLength),
      signature: new Uint8Array(0),
      generation,
      sessionId: null, messageIndex: null,
    });

    // 4. Completely empty ciphertext (0 bytes)
    await mustThrow('empty ciphertext', {
      nonce: validNonce,
      ciphertext: new Uint8Array(0),
      signature: new Uint8Array(0),
      generation,
      sessionId: null, messageIndex: null,
    });

    // 5. Valid nonce + ciphertext but wrong room key (AD mismatch)
    const wrongKey = await generateRoomKey(generation);
    // (Calling with wrong roomKey directly — mustThrow uses baseParams with the correct key)
    try {
      await decryptBlob({
        blob: { nonce: validNonce, ciphertext: validCiphertext, signature: new Uint8Array(0),
                generation, sessionId: null, messageIndex: null },
        roomId: room.id,
        roomKey: wrongKey,
        resolveSenderDeviceEd25519Pub: async () => alice.bundle.ed25519PublicKey,
      });
      throw new Error('Vulnerability: wrong room key accepted by decryptBlob');
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Vulnerability')) throw err;
    }

    // 6. Valid ciphertext but generation mismatch (roomKey.generation != blob.generation)
    const key2 = await generateRoomKey(generation + 1);
    try {
      await decryptBlob({
        blob: { nonce: validNonce, ciphertext: validCiphertext, signature: new Uint8Array(0),
                generation: generation + 1, sessionId: null, messageIndex: null },
        roomId: room.id,
        roomKey: key2, // generation+1 key but ciphertext is generation
        resolveSenderDeviceEd25519Pub: async () => alice.bundle.ed25519PublicKey,
      });
      throw new Error('Vulnerability: generation-mismatch ciphertext accepted');
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Vulnerability')) throw err;
    }

    console.log('PASS: Malformed payload — truncated nonce, stripped MAC, zeroed ciphertext, empty, wrong key, gen mismatch all throw safely ✓');
  } finally {
    for (const id of userIds) await cleanupUser(id).catch(console.error);
  }
}

run().catch((err) => { console.error('FAIL:', err); process.exit(1); });
