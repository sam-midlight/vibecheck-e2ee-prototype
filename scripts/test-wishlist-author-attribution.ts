/**
 * Test: Wishlist author attribution cannot be forged
 *
 * `wishlist_add`/`claim`/`delete` events identify the author exclusively by
 * the v3 envelope's senderUserId. Without verification, Bob could:
 *   - add an item to Alice's wishlist (skewing her record)
 *   - claim Alice's items as if Alice did it
 *   - delete entries owned by Alice
 *
 * This test confirms a forged `wishlist_add` (Bob signs, claims sender=Alice)
 * is rejected at the SIGNATURE_INVALID layer.
 *
 * Asserts:
 *   - Forged wishlist_add → SIGNATURE_INVALID.
 *   - Honest wishlist_add by Bob decrypts cleanly with sender=Bob.
 *
 * Run: npx tsx --env-file=.env.local scripts/test-wishlist-author-attribution.ts
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

interface WishlistAddPayload {
  type: 'wishlist_add';
  itemId: string;
  title: string;
  category: 'gift' | 'experience' | 'food' | 'activity' | 'other';
  notes?: string;
  ts: number;
}

async function run() {
  await initCrypto();

  const aliceUser = await createTestUser(`test-alice-wla-${Date.now()}@example.com`);
  const bobUser   = await createTestUser(`test-bob-wla-${Date.now()}@example.com`);
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

    // -- Forgery: Bob adds an item to "Alice's" wishlist ---------------------
    const forged = await encryptBlob<WishlistAddPayload>({
      payload: { type: 'wishlist_add', itemId: crypto.randomUUID(),
                 title: 'PS5 (forged-Alice request)', category: 'gift',
                 ts: Date.now() },
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
      await decryptBlob<WishlistAddPayload>({
        blob: wireForged, roomId: room.id, roomKey, resolveSenderDeviceEd25519Pub: prodResolver,
      });
    } catch (err) {
      if (err instanceof CryptoError && err.code === 'SIGNATURE_INVALID') forgeryCaught = true;
      else throw new Error(`Unexpected error type for forgery: ${err}`);
    }
    if (!forgeryCaught) {
      throw new Error('Vulnerability: forged wishlist_add (Bob → Alice claim) decrypted');
    }

    // -- Control: honest wishlist_add by Bob ---------------------------------
    const honest = await encryptBlob<WishlistAddPayload>({
      payload: { type: 'wishlist_add', itemId: crypto.randomUUID(),
                 title: 'Bob actually wants new shoes', category: 'gift',
                 ts: Date.now() },
      roomId: room.id, roomKey,
      senderUserId: bob.userId, senderDeviceId: bob.bundle.deviceId,
      senderDeviceEd25519PrivateKey: bob.bundle.ed25519PrivateKey,
    });
    const wireHonest: EncryptedBlob = {
      nonce: honest.nonce, ciphertext: honest.ciphertext, signature: honest.signature,
      generation: honest.generation, sessionId: null, messageIndex: null,
    };
    const { payload, senderUserId } = await decryptBlob<WishlistAddPayload>({
      blob: wireHonest, roomId: room.id, roomKey, resolveSenderDeviceEd25519Pub: prodResolver,
    });
    if (senderUserId !== bob.userId) throw new Error(`honest sender attribution broken: ${senderUserId}`);
    if (!payload.title.startsWith('Bob actually')) throw new Error(`payload mangled: ${payload.title}`);

    console.log('PASS: Wishlist author attribution — forged sender rejected, honest add intact ✓');
  } finally {
    for (const id of userIds) await cleanupUser(id).catch(console.error);
  }
}

run().catch((err) => { console.error('FAIL:', err); process.exit(1); });
