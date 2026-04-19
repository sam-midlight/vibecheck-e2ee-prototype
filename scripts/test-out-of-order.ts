/**
 * Test 61: Out-of-Order Delivery (The Ratchet)
 *
 * Alice sends 3 Megolm messages (indices 0, 1, 2). Bob's network drops and
 * he receives message at index 2 first. He later receives messages 0 and 1.
 *
 * The Megolm design allows this: `deriveMessageKeyAtIndex` is non-destructive
 * (re-derives from the snapshot without mutating it), so keys can be resolved
 * in any order from the same snapshot.
 *
 * The advancing-cursor variant (`deriveMessageKeyAtIndexAndAdvance`) is O(1)
 * for in-order delivery but cannot go backwards. To handle out-of-order you
 * must either (a) use non-advancing derivation per-message, or (b) cache
 * skipped keys before advancing. This test demonstrates both: the non-advancing
 * path works in any order, and the advancing path fails on retrograde access.
 *
 * Asserts:
 *   - Bob decrypts message at index 2 first (out of order) — succeeds
 *   - Bob decrypts messages 0 and 1 afterwards — both succeed
 *   - decryptedPayloads are correct for all 3 messages
 *   - If Bob advanced cursor past 2, indices 0 and 1 are unreachable
 *     (demonstrating WHY skipped keys must be cached before advancing)
 *
 * Run: npx tsx --env-file=.env.local scripts/test-out-of-order.ts
 */

import {
  generateRoomKey,
  wrapRoomKeyFor,
  signMembershipWrap,
  createOutboundSession,
  ratchetAndDerive,
  exportSessionSnapshot,
  sealSessionSnapshot,
  unsealSessionSnapshot,
  signSessionShare,
  encryptBlobV4,
  decryptBlob,
  deriveMessageKeyAtIndex,
  deriveMessageKeyAtIndexAndAdvance,
  generateDeviceKeyBundle,
  signDeviceIssuanceV2,
  toBase64,
  fromBase64,
  CryptoError,
  type EncryptedBlob,
  type MegolmMessageKey,
} from '../src/lib/e2ee-core';
import { initCrypto, createTestUser, provisionDevice, cleanupUser, makeServiceClient } from './test-utils';

async function run() {
  await initCrypto();

  const aliceUser = await createTestUser(`test-alice-ooo-${Date.now()}@example.com`);
  const bobUser   = await createTestUser(`test-bob-ooo-${Date.now()}@example.com`);
  const userIds   = [aliceUser.userId, bobUser.userId];
  const svc       = makeServiceClient();

  try {
    const alice = await provisionDevice(aliceUser.supabase, aliceUser.userId);
    const bob   = await provisionDevice(bobUser.supabase, bobUser.userId);

    // -- Room + memberships ---------------------------------------------------
    const { data: room, error: roomErr } = await aliceUser.supabase
      .from('rooms').insert({ kind: 'group', created_by: alice.userId })
      .select('*').single();
    if (roomErr || !room) throw new Error(`createRoom: ${roomErr?.message}`);
    const generation = room.current_generation as number;
    const roomKey    = await generateRoomKey(generation);

    for (const m of [alice, bob]) {
      const wrap = await wrapRoomKeyFor(roomKey, m.bundle.x25519PublicKey);
      const sig  = await signMembershipWrap(
        { roomId: room.id, generation, memberUserId: m.userId,
          memberDeviceId: m.deviceId, wrappedRoomKey: wrap.wrapped,
          signerDeviceId: alice.deviceId },
        alice.bundle.ed25519PrivateKey,
      );
      const client = m === alice ? aliceUser.supabase : svc;
      await client.from('room_members').insert({
        room_id: room.id, user_id: m.userId, device_id: m.deviceId, generation,
        wrapped_room_key: await toBase64(wrap.wrapped),
        signer_device_id: alice.deviceId, wrap_signature: await toBase64(sig),
      });
    }

    // -- Alice starts Megolm session, sends 3 messages -----------------------
    const outbound = await createOutboundSession(room.id, generation);

    // Export snapshot at index 0 BEFORE any ratcheting — Bob's inbound snapshot
    const snapshotAt0 = exportSessionSnapshot(outbound, alice.userId, alice.deviceId);
    const sessionIdB64 = await toBase64(snapshotAt0.sessionId);

    // Ratchet 3 times to produce 3 message keys (indices 0, 1, 2)
    const msgKeys: MegolmMessageKey[] = [];
    for (let i = 0; i < 3; i++) msgKeys.push(await ratchetAndDerive(outbound));

    // Encrypt 3 v4 blobs
    const blobs: Array<{ blob: EncryptedBlob; text: string }> = [];
    for (let i = 0; i < 3; i++) {
      const text = `Message ${i + 1}`;
      const eb = await encryptBlobV4<{ text: string }>({
        payload: { text },
        roomId: room.id,
        messageKey: msgKeys[i],
        sessionId: snapshotAt0.sessionId,
        generation,
        senderUserId: alice.userId,
        senderDeviceId: alice.deviceId,
        senderDeviceEd25519PrivateKey: alice.bundle.ed25519PrivateKey,
      });
      blobs.push({ blob: eb, text });
    }

    // Insert all 3 to DB
    for (let i = 0; i < 3; i++) {
      const eb = blobs[i].blob;
      await aliceUser.supabase.from('blobs').insert({
        room_id: room.id, sender_id: alice.userId, sender_device_id: alice.deviceId,
        generation: eb.generation,
        nonce: await toBase64(eb.nonce),
        ciphertext: await toBase64(eb.ciphertext),
        signature: null,
        session_id: sessionIdB64,
        message_index: msgKeys[i].index,
      });
    }

    // -- Alice shares her session snapshot with Bob ---------------------------
    const sealed = await sealSessionSnapshot(snapshotAt0, bob.bundle.x25519PublicKey);
    const shareSig = await signSessionShare({
      sessionId: snapshotAt0.sessionId,
      recipientDeviceId: bob.deviceId,
      sealedSnapshot: sealed,
      signerDeviceId: alice.deviceId,
      signerEd25519Priv: alice.bundle.ed25519PrivateKey,
    });
    await svc.from('megolm_session_shares').insert({
      session_id: sessionIdB64,
      recipient_device_id: bob.deviceId,
      sealed_snapshot: await toBase64(sealed),
      start_index: snapshotAt0.startIndex,
      signer_device_id: alice.deviceId,
      share_signature: await toBase64(shareSig),
    });

    // -- Bob unseals his snapshot --------------------------------------------
    const { data: shareRow } = await svc.from('megolm_session_shares')
      .select('sealed_snapshot').eq('session_id', sessionIdB64)
      .eq('recipient_device_id', bob.deviceId).single();
    const bobSnapshot = await unsealSessionSnapshot(
      await fromBase64((shareRow as { sealed_snapshot: string }).sealed_snapshot),
      bob.bundle.x25519PublicKey,
      bob.bundle.x25519PrivateKey,
    );

    // Helper: resolve Megolm message key using non-advancing derivation
    // (this is the correct pattern for out-of-order delivery)
    async function resolveMegolmKey(sessionId: string, messageIndex: number): Promise<Uint8Array | null> {
      if (sessionId !== sessionIdB64) return null;
      const { key } = await deriveMessageKeyAtIndex(bobSnapshot, messageIndex);
      return key;
    }

    function toWireBlob(eb: EncryptedBlob): EncryptedBlob {
      return {
        nonce: eb.nonce,
        ciphertext: eb.ciphertext,
        signature: eb.signature,
        generation: eb.generation,
        sessionId: sessionIdB64,
        messageIndex: eb.messageIndex,
      };
    }

    // -- Bob receives Message 3 (index 2) FIRST -- out of order --------------
    const { payload: p2 } = await decryptBlob<{ text: string }>({
      blob: toWireBlob(blobs[2].blob), roomId: room.id, roomKey,
      resolveSenderDeviceEd25519Pub: async () => alice.bundle.ed25519PublicKey,
      resolveMegolmKey,
    });
    if (p2.text !== 'Message 3') throw new Error(`Index 2 plaintext: "${p2.text}"`);

    // -- Bob receives Message 1 (index 0) and Message 2 (index 1) later ------
    const { payload: p0 } = await decryptBlob<{ text: string }>({
      blob: toWireBlob(blobs[0].blob), roomId: room.id, roomKey,
      resolveSenderDeviceEd25519Pub: async () => alice.bundle.ed25519PublicKey,
      resolveMegolmKey,
    });
    if (p0.text !== 'Message 1') throw new Error(`Index 0 plaintext: "${p0.text}"`);

    const { payload: p1 } = await decryptBlob<{ text: string }>({
      blob: toWireBlob(blobs[1].blob), roomId: room.id, roomKey,
      resolveSenderDeviceEd25519Pub: async () => alice.bundle.ed25519PublicKey,
      resolveMegolmKey,
    });
    if (p1.text !== 'Message 2') throw new Error(`Index 1 plaintext: "${p1.text}"`);

    // -- Demonstrate: advancing cursor past 2 blocks retrograde access --------
    // This shows WHY the non-advancing variant must be used (or skipped keys cached).
    const { nextSnapshot: snapAt3 } = await deriveMessageKeyAtIndexAndAdvance(bobSnapshot, 2);
    // snapAt3.startIndex === 3 — cursor is now ahead of indices 0 and 1

    try {
      await deriveMessageKeyAtIndex(snapAt3, 0);
      throw new Error('Vulnerability: retrograde access succeeded on advanced cursor');
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Vulnerability')) throw err;
      if (err instanceof CryptoError && err.code !== 'BAD_GENERATION') {
        throw new Error(`Expected BAD_GENERATION on retrograde access, got ${(err as CryptoError).code}`);
      }
    }

    console.log('PASS: Out-of-order delivery — received index 2 first; decrypted 0 and 1 out of order; retrograde on advanced cursor blocked ✓');
  } finally {
    for (const id of userIds) await cleanupUser(id).catch(console.error);
  }
}

run().catch((err) => { console.error('FAIL:', err); process.exit(1); });
