/**
 * Test: Bribe author attribution cannot be forged
 *
 * The `bribe` event spends hearts from the sender's running balance toward
 * a target (mind_reader game or date_idea). The reducer enforces "you can't
 * bribe yourself" by comparing the envelope sender against the bribe
 * target's author. If a member could forge another's authorship on a bribe,
 * they could:
 *   - drain a peer's heart balance by spending it for them
 *   - force-reveal a mind_reader game while attributing the solve to someone
 *     other than themselves
 *
 * This test confirms that crafting a `bribe` event with sender=Alice but
 * signed by Bob is rejected at the SIGNATURE_INVALID layer.
 *
 * Asserts:
 *   - Forged bribe (Bob signs, claims sender=Alice) is rejected.
 *   - Honest bribe by Bob decrypts and yields senderUserId = Bob.
 *
 * Run: npx tsx --env-file=.env.local scripts/test-bribe-author-attribution.ts
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

interface BribePayload {
  type: 'bribe';
  targetType: 'mind_reader' | 'date_idea';
  targetId: string;
  amount: number;
  comment?: string;
  ts: number;
}

async function run() {
  await initCrypto();

  const aliceUser = await createTestUser(`test-alice-bri-${Date.now()}@example.com`);
  const bobUser   = await createTestUser(`test-bob-bri-${Date.now()}@example.com`);
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

    // -- Forgery: Bob spends hearts "as Alice" -------------------------------
    const forged = await encryptBlob<BribePayload>({
      payload: { type: 'bribe', targetType: 'date_idea',
                 targetId: crypto.randomUUID(), amount: 50,
                 comment: 'forged bribe', ts: Date.now() },
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
      await decryptBlob<BribePayload>({
        blob: wireForged, roomId: room.id, roomKey, resolveSenderDeviceEd25519Pub: prodResolver,
      });
    } catch (err) {
      if (err instanceof CryptoError && err.code === 'SIGNATURE_INVALID') forgeryCaught = true;
      else throw new Error(`Unexpected error type for forgery: ${err}`);
    }
    if (!forgeryCaught) {
      throw new Error('Vulnerability: forged bribe (Bob → Alice claim) decrypted');
    }

    // -- Control: honest bribe from Bob --------------------------------------
    const honest = await encryptBlob<BribePayload>({
      payload: { type: 'bribe', targetType: 'mind_reader',
                 targetId: crypto.randomUUID(), amount: 5,
                 comment: 'real bribe', ts: Date.now() },
      roomId: room.id, roomKey,
      senderUserId: bob.userId, senderDeviceId: bob.bundle.deviceId,
      senderDeviceEd25519PrivateKey: bob.bundle.ed25519PrivateKey,
    });
    const wireHonest: EncryptedBlob = {
      nonce: honest.nonce, ciphertext: honest.ciphertext, signature: honest.signature,
      generation: honest.generation, sessionId: null, messageIndex: null,
    };
    const { payload, senderUserId } = await decryptBlob<BribePayload>({
      blob: wireHonest, roomId: room.id, roomKey, resolveSenderDeviceEd25519Pub: prodResolver,
    });
    if (senderUserId !== bob.userId) throw new Error(`honest sender attribution broken: ${senderUserId}`);
    if (payload.amount !== 5) throw new Error(`amount mangled: ${payload.amount}`);

    console.log('PASS: Bribe author attribution — forged sender rejected, honest spend intact ✓');
  } finally {
    for (const id of userIds) await cleanupUser(id).catch(console.error);
  }
}

run().catch((err) => { console.error('FAIL:', err); process.exit(1); });
