/**
 * Test: Mind Reader author attribution cannot be forged
 *
 * `mind_reader_post` carries a hint + secret keyword + thought. Authorship
 * is whoever owns the v3 envelope's senderUserId. Without attribution
 * verification, Bob could publish a game claiming Alice posted it (then
 * "solve" it himself for the social-credit point).
 *
 * Forgery rejected: production resolver returns null when (claimed user,
 * deviceId) doesn't match a real device row → SIGNATURE_INVALID.
 *
 * Asserts:
 *   - Forged mind_reader_post (Bob signs, claims sender=Alice) is rejected.
 *   - Honest post by Bob decrypts and yields senderUserId = Bob.
 *
 * Run: npx tsx --env-file=.env.local scripts/test-mindreader-author-attribution.ts
 */

import {
  generateRoomKey,
  wrapRoomKeyFor,
  signMembershipWrap,
  encryptBlob,
  decryptBlob,
  toBase64,
  type EncryptedBlob,
  CryptoError,
} from '../src/lib/e2ee-core';
import { initCrypto, createTestUser, provisionDevice, cleanupUser, makeServiceClient } from './test-utils';

interface MindReaderPostPayload {
  type: 'mind_reader_post';
  gameId: string;
  hint: string;
  keyword: string;
  thought: string;
  ts: number;
}

async function run() {
  await initCrypto();

  const aliceUser = await createTestUser(`test-alice-mra-${Date.now()}@example.com`);
  const bobUser   = await createTestUser(`test-bob-mra-${Date.now()}@example.com`);
  const userIds   = [aliceUser.userId, bobUser.userId];
  const svc       = makeServiceClient();

  try {
    const alice = await provisionDevice(aliceUser.supabase, aliceUser.userId);
    const bob   = await provisionDevice(bobUser.supabase,   bobUser.userId);

    const { data: room, error: roomErr } = await aliceUser.supabase
      .from('rooms').insert({ kind: 'group', created_by: alice.userId })
      .select('*').single();
    if (roomErr || !room) throw new Error(`createRoom: ${roomErr?.message}`);
    const generation = room.current_generation as number;
    const roomKey    = await generateRoomKey(generation);

    for (const m of [
      { dev: alice, signerDev: alice, client: aliceUser.supabase },
      { dev: bob,   signerDev: alice, client: svc },
    ]) {
      const wrap = await wrapRoomKeyFor(roomKey, m.dev.bundle.x25519PublicKey);
      const sig  = await signMembershipWrap(
        { roomId: room.id, generation, memberUserId: m.dev.userId,
          memberDeviceId: m.dev.bundle.deviceId, wrappedRoomKey: wrap.wrapped,
          signerDeviceId: m.signerDev.bundle.deviceId },
        m.signerDev.bundle.ed25519PrivateKey,
      );
      const { error } = await m.client.from('room_members').insert({
        room_id: room.id, user_id: m.dev.userId, device_id: m.dev.bundle.deviceId,
        generation, wrapped_room_key: await toBase64(wrap.wrapped),
        signer_device_id: m.signerDev.bundle.deviceId,
        wrap_signature: await toBase64(sig),
      });
      if (error) throw new Error(`addMember: ${error.message}`);
    }

    const prodResolver = async (userId: string, deviceId: string): Promise<Uint8Array | null> => {
      const ownerDevices = userId === alice.userId ? [alice.bundle] : [bob.bundle];
      return ownerDevices.find((d) => d.deviceId === deviceId)?.ed25519PublicKey ?? null;
    };

    // -- Forgery -------------------------------------------------------------
    const forged = await encryptBlob<MindReaderPostPayload>({
      payload: {
        type: 'mind_reader_post', gameId: crypto.randomUUID(),
        hint: 'something I want from you', keyword: 'flowers',
        thought: 'fake-Alice authored thought', ts: Date.now(),
      },
      roomId: room.id, roomKey,
      senderUserId: alice.userId, senderDeviceId: bob.bundle.deviceId,
      senderDeviceEd25519PrivateKey: bob.bundle.ed25519PrivateKey,
    });
    const wireForged: EncryptedBlob = {
      nonce: forged.nonce, ciphertext: forged.ciphertext, signature: forged.signature,
      generation: forged.generation, sessionId: null, messageIndex: null,
    };
    let forgeryCaught = false;
    try {
      await decryptBlob<MindReaderPostPayload>({
        blob: wireForged, roomId: room.id, roomKey, resolveSenderDeviceEd25519Pub: prodResolver,
      });
    } catch (err) {
      if (err instanceof CryptoError && err.code === 'SIGNATURE_INVALID') forgeryCaught = true;
      else throw new Error(`Unexpected error type for forgery: ${err}`);
    }
    if (!forgeryCaught) {
      throw new Error('Vulnerability: forged mind_reader_post (Bob → Alice claim) decrypted');
    }

    // -- Control -------------------------------------------------------------
    const honest = await encryptBlob<MindReaderPostPayload>({
      payload: {
        type: 'mind_reader_post', gameId: crypto.randomUUID(),
        hint: 'real hint', keyword: 'pizza', thought: 'real thought',
        ts: Date.now(),
      },
      roomId: room.id, roomKey,
      senderUserId: bob.userId, senderDeviceId: bob.bundle.deviceId,
      senderDeviceEd25519PrivateKey: bob.bundle.ed25519PrivateKey,
    });
    const wireHonest: EncryptedBlob = {
      nonce: honest.nonce, ciphertext: honest.ciphertext, signature: honest.signature,
      generation: honest.generation, sessionId: null, messageIndex: null,
    };
    const { payload, senderUserId } = await decryptBlob<MindReaderPostPayload>({
      blob: wireHonest, roomId: room.id, roomKey, resolveSenderDeviceEd25519Pub: prodResolver,
    });
    if (senderUserId !== bob.userId) throw new Error(`honest sender attribution broken: ${senderUserId}`);
    if (payload.keyword !== 'pizza') throw new Error(`keyword mangled: ${payload.keyword}`);

    console.log('PASS: MindReader author attribution — forged sender rejected, honest game intact ✓');
  } finally {
    for (const id of userIds) await cleanupUser(id).catch(console.error);
  }
}

run().catch((err) => { console.error('FAIL:', err); process.exit(1); });
