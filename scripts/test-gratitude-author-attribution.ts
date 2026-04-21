/**
 * Test: Gratitude author attribution cannot be forged
 *
 * `gratitude_send` carries a `to:` recipient field but NO `from:` — sender
 * identity is taken from the v3 envelope and verified by the device-key
 * signature. This test confirms Bob cannot forge a gratitude_send that
 * appears to come from Alice (which would let Bob fabricate "Alice thanked
 * you" notes or skew the heart-balance ledger in his favor).
 *
 * Forgery rejected because the production resolver looks up the CLAIMED
 * user's published devices; Bob's deviceId isn't in Alice's device list,
 * so the resolver returns null → SIGNATURE_INVALID.
 *
 * Asserts:
 *   - Forged gratitude (Bob signs, claims sender=Alice) → SIGNATURE_INVALID.
 *   - Honest gratitude from Bob → decrypts and `to` field survives intact.
 *
 * Run: npx tsx --env-file=.env.local scripts/test-gratitude-author-attribution.ts
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

interface GratitudeSendPayload {
  type: 'gratitude_send';
  to: string;
  amount: number;
  message: string;
  ts: number;
}

async function run() {
  await initCrypto();

  const aliceUser = await createTestUser(`test-alice-gra-${Date.now()}@example.com`);
  const bobUser   = await createTestUser(`test-bob-gra-${Date.now()}@example.com`);
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

    // -- Forgery: Bob signs but claims Alice authorship ----------------------
    const forged = await encryptBlob<GratitudeSendPayload>({
      payload: { type: 'gratitude_send', to: bob.userId, amount: 5,
                 message: 'You are amazing — fake Alice', ts: Date.now() },
      roomId: room.id, roomKey,
      senderUserId: alice.userId,
      senderDeviceId: bob.bundle.deviceId,
      senderDeviceEd25519PrivateKey: bob.bundle.ed25519PrivateKey,
    });
    const wireForged: EncryptedBlob = {
      nonce: forged.nonce, ciphertext: forged.ciphertext, signature: forged.signature,
      generation: forged.generation, sessionId: null, messageIndex: null,
    };
    let forgeryCaught = false;
    try {
      await decryptBlob<GratitudeSendPayload>({
        blob: wireForged, roomId: room.id, roomKey, resolveSenderDeviceEd25519Pub: prodResolver,
      });
    } catch (err) {
      if (err instanceof CryptoError && err.code === 'SIGNATURE_INVALID') forgeryCaught = true;
      else throw new Error(`Unexpected error type for forgery: ${err}`);
    }
    if (!forgeryCaught) {
      throw new Error('Vulnerability: forged gratitude (Bob → Alice claim) decrypted');
    }

    // -- Control: Honest Bob → Alice gratitude, recipient field intact -------
    const honest = await encryptBlob<GratitudeSendPayload>({
      payload: { type: 'gratitude_send', to: alice.userId, amount: 3,
                 message: 'Real thanks', ts: Date.now() },
      roomId: room.id, roomKey,
      senderUserId: bob.userId, senderDeviceId: bob.bundle.deviceId,
      senderDeviceEd25519PrivateKey: bob.bundle.ed25519PrivateKey,
    });
    const wireHonest: EncryptedBlob = {
      nonce: honest.nonce, ciphertext: honest.ciphertext, signature: honest.signature,
      generation: honest.generation, sessionId: null, messageIndex: null,
    };
    const { payload, senderUserId } = await decryptBlob<GratitudeSendPayload>({
      blob: wireHonest, roomId: room.id, roomKey, resolveSenderDeviceEd25519Pub: prodResolver,
    });
    if (senderUserId !== bob.userId) throw new Error(`honest sender attribution broken: ${senderUserId}`);
    if (payload.to !== alice.userId) throw new Error(`recipient mangled: ${payload.to}`);
    if (payload.amount !== 3) throw new Error(`amount mangled: ${payload.amount}`);

    console.log('PASS: Gratitude author attribution — forged sender rejected, honest payload intact ✓');
  } finally {
    for (const id of userIds) await cleanupUser(id).catch(console.error);
  }
}

run().catch((err) => { console.error('FAIL:', err); process.exit(1); });
