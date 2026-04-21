/**
 * Test: LoveTank author attribution cannot be forged
 *
 * A `love_tank_set` event has no author field in its payload — authorship is
 * carried exclusively by the v3 envelope's (senderUserId, senderDeviceId)
 * and verified by the blob's sender-device signature. This test confirms
 * Bob cannot publish a love_tank_set event that appears to come from Alice.
 *
 * Forgery path exercised:
 *   Bob signs a v3 envelope with Bob's device key but stamps the envelope
 *   with senderUserId=Alice, senderDeviceId=Bob's-device-id. The production
 *   resolver (src/components/RoomProvider.tsx) looks up Alice's published
 *   devices — Bob's deviceId isn't among them, so the resolver returns null
 *   and decryptBlob throws SIGNATURE_INVALID.
 *
 * Asserts:
 *   - A forged love_tank_set claiming Alice as sender is rejected with
 *     SIGNATURE_INVALID when decrypted via a production-style resolver.
 *   - The honest event from Bob himself still decrypts fine (control).
 *
 * Run: npx tsx --env-file=.env.local scripts/test-lovetank-author-attribution.ts
 */

import {
  generateRoomKey,
  wrapRoomKeyFor,
  unwrapRoomKey,
  signMembershipWrap,
  encryptBlob,
  decryptBlob,
  fromBase64,
  toBase64,
  type EncryptedBlob,
  CryptoError,
} from '../src/lib/e2ee-core';
import { initCrypto, createTestUser, provisionDevice, cleanupUser, makeServiceClient } from './test-utils';

interface LoveTankSetPayload {
  type: 'love_tank_set';
  level: number;
  ts: number;
}

async function run() {
  await initCrypto();

  const aliceUser = await createTestUser(`test-alice-lta-${Date.now()}@example.com`);
  const bobUser   = await createTestUser(`test-bob-lta-${Date.now()}@example.com`);
  const userIds   = [aliceUser.userId, bobUser.userId];
  const svc       = makeServiceClient();

  try {
    const alice = await provisionDevice(aliceUser.supabase, aliceUser.userId);
    const bob   = await provisionDevice(bobUser.supabase,   bobUser.userId);

    // -- Two-member room ------------------------------------------------------
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

    // -- Bob forges a love_tank_set claiming Alice authorship ----------------
    const forged = await encryptBlob<LoveTankSetPayload>({
      payload: { type: 'love_tank_set', level: 5, ts: Date.now() },
      roomId: room.id, roomKey,
      senderUserId: alice.userId,            // <-- CLAIM = Alice
      senderDeviceId: bob.bundle.deviceId,   // <-- but Bob's device id
      senderDeviceEd25519PrivateKey: bob.bundle.ed25519PrivateKey, // signed by Bob
    });

    // Production-style resolver: fetches target user's public devices and
    // looks for the claimed deviceId among them. Alice's device list does
    // NOT contain Bob's deviceId → returns null.
    const prodResolver = async (userId: string, deviceId: string): Promise<Uint8Array | null> => {
      const allDevices = [alice.bundle, bob.bundle];
      // Mimic RoomProvider: look up the CLAIMED user's devices only.
      const ownerDevices = userId === alice.userId ? [alice.bundle] : [bob.bundle];
      const match = ownerDevices.find((d) => d.deviceId === deviceId);
      void allDevices;
      return match?.ed25519PublicKey ?? null;
    };

    const wireForged: EncryptedBlob = {
      nonce: forged.nonce, ciphertext: forged.ciphertext,
      signature: forged.signature, generation: forged.generation,
      sessionId: null, messageIndex: null,
    };

    let forgeryCaught = false;
    try {
      await decryptBlob<LoveTankSetPayload>({
        blob: wireForged, roomId: room.id, roomKey,
        resolveSenderDeviceEd25519Pub: prodResolver,
      });
    } catch (err) {
      if (err instanceof CryptoError && err.code === 'SIGNATURE_INVALID') {
        forgeryCaught = true;
      } else {
        throw new Error(`Unexpected error type for forgery: ${err}`);
      }
    }
    if (!forgeryCaught) {
      throw new Error(
        'Vulnerability: forged love_tank_set (Alice claim, Bob device) decrypted successfully',
      );
    }

    // -- Control: Bob's honest love_tank_set decrypts fine -------------------
    const honest = await encryptBlob<LoveTankSetPayload>({
      payload: { type: 'love_tank_set', level: 77, ts: Date.now() },
      roomId: room.id, roomKey,
      senderUserId: bob.userId, senderDeviceId: bob.bundle.deviceId,
      senderDeviceEd25519PrivateKey: bob.bundle.ed25519PrivateKey,
    });
    const wireHonest: EncryptedBlob = {
      nonce: honest.nonce, ciphertext: honest.ciphertext,
      signature: honest.signature, generation: honest.generation,
      sessionId: null, messageIndex: null,
    };
    const { payload, senderUserId } = await decryptBlob<LoveTankSetPayload>({
      blob: wireHonest, roomId: room.id, roomKey,
      resolveSenderDeviceEd25519Pub: prodResolver,
    });
    if (senderUserId !== bob.userId) throw new Error(`honest sender attribution broken: ${senderUserId}`);
    if (payload.level !== 77) throw new Error(`honest payload corrupt: level=${payload.level}`);

    // -- Ensure honest unwrap still works for Bob (no silent corruption) ----
    const memberRow = await bobUser.supabase.from('room_members')
      .select('wrapped_room_key').eq('room_id', room.id)
      .eq('device_id', bob.bundle.deviceId).eq('generation', generation).single();
    if (memberRow.error || !memberRow.data) throw new Error('Bob has no room key');
    await unwrapRoomKey(
      { wrapped: await fromBase64(memberRow.data.wrapped_room_key as string), generation },
      bob.bundle.x25519PublicKey, bob.bundle.x25519PrivateKey,
    );

    console.log('PASS: LoveTank author attribution — forged Alice-claim rejected, honest event verified ✓');
  } finally {
    for (const id of userIds) await cleanupUser(id).catch(console.error);
  }
}

run().catch((err) => { console.error('FAIL:', err); process.exit(1); });
