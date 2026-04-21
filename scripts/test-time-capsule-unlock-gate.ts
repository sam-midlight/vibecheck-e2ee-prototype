/**
 * Test: Time Capsule unlockAt is a UI-only gate
 *
 * Documents — and asserts — that `unlockAt` on a `time_capsule_post` event is
 * NOT cryptographically bound. The field sits inside the encrypted payload as
 * a plain number; any current room member can decrypt the blob the moment it
 * lands and read `message` regardless of the unlock time.
 *
 * Trust model per src/lib/domain/events.ts (Time Capsules section): the gate
 * is enforced by the renderer, not the cryptography. This test PASSES today
 * because that gap is the documented intentional behavior. If you ever want
 * a real time-lock, the upgrade path is to bind unlockAt into the AEAD AD
 * (so tampering invalidates) AND withhold a second key until unlockAt — at
 * which point this test will need to be flipped.
 *
 * Asserts:
 *   - Bob (a member) decrypts a future-locked capsule and reads its message
 *     immediately (proves data-layer leak).
 *   - The decrypted payload's unlockAt is in the future (sanity).
 *
 * Run: npx tsx --env-file=.env.local scripts/test-time-capsule-unlock-gate.ts
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
} from '../src/lib/e2ee-core';
import { initCrypto, createTestUser, provisionDevice, cleanupUser, makeServiceClient } from './test-utils';

interface TimeCapsulePayload {
  type: 'time_capsule_post';
  capsuleId: string;
  unlockAt: number;
  message: string;
  ts: number;
}

async function run() {
  await initCrypto();

  const aliceUser = await createTestUser(`test-alice-tcu-${Date.now()}@example.com`);
  const bobUser   = await createTestUser(`test-bob-tcu-${Date.now()}@example.com`);
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

    // -- Alice posts a capsule that "unlocks" 1 hour from now -----------------
    const unlockAt = Date.now() + 60 * 60 * 1000;
    const payload: TimeCapsulePayload = {
      type: 'time_capsule_post',
      capsuleId: crypto.randomUUID(),
      unlockAt,
      message: 'SECRET — should be hidden until unlockAt',
      ts: Date.now(),
    };
    const encBlob = await encryptBlob<TimeCapsulePayload>({
      payload, roomId: room.id, roomKey,
      senderUserId: alice.userId, senderDeviceId: alice.bundle.deviceId,
      senderDeviceEd25519PrivateKey: alice.bundle.ed25519PrivateKey,
    });
    const { error: blobErr } = await aliceUser.supabase.from('blobs').insert({
      room_id: room.id, sender_id: alice.userId, sender_device_id: alice.bundle.deviceId,
      generation: encBlob.generation, nonce: await toBase64(encBlob.nonce),
      ciphertext: await toBase64(encBlob.ciphertext),
      signature: encBlob.signature.byteLength > 0 ? await toBase64(encBlob.signature) : null,
      session_id: null, message_index: null,
    });
    if (blobErr) throw new Error(`insertBlob: ${blobErr.message}`);

    // -- Bob fetches + decrypts immediately (well before unlockAt) ------------
    const { data: rows } = await bobUser.supabase
      .from('blobs').select('*').eq('room_id', room.id);
    if (!rows || rows.length === 0) throw new Error('Bob received no blobs');
    const r = rows[0] as { nonce: string; ciphertext: string; signature: string | null;
                           generation: number; session_id: string | null; message_index: number | null };

    const memberRow = await bobUser.supabase.from('room_members')
      .select('wrapped_room_key').eq('room_id', room.id)
      .eq('device_id', bob.bundle.deviceId).eq('generation', generation).single();
    if (memberRow.error || !memberRow.data) throw new Error('Bob has no room key');
    const bobRoomKey = await unwrapRoomKey(
      { wrapped: await fromBase64(memberRow.data.wrapped_room_key as string), generation },
      bob.bundle.x25519PublicKey, bob.bundle.x25519PrivateKey,
    );

    const wireBlob: EncryptedBlob = {
      nonce: await fromBase64(r.nonce), ciphertext: await fromBase64(r.ciphertext),
      signature: r.signature ? await fromBase64(r.signature) : new Uint8Array(0),
      generation: r.generation, sessionId: null, messageIndex: null,
    };
    const { payload: decrypted } = await decryptBlob<TimeCapsulePayload>({
      blob: wireBlob, roomId: room.id, roomKey: bobRoomKey,
      resolveSenderDeviceEd25519Pub: async () => alice.bundle.ed25519PublicKey,
    });

    // -- Sanity: payload unlockAt is in the future ----------------------------
    if (decrypted.unlockAt <= Date.now()) {
      throw new Error(`Test setup broken: unlockAt ${decrypted.unlockAt} is not in the future`);
    }

    // -- The asserted gap: Bob can read the secret message NOW ---------------
    if (decrypted.message !== 'SECRET — should be hidden until unlockAt') {
      throw new Error(`Decrypt produced wrong plaintext: "${decrypted.message}"`);
    }

    console.log(
      'PASS: Time-capsule unlockAt is UI-only — Bob decrypted future-locked content '
      + `${Math.round((decrypted.unlockAt - Date.now()) / 60000)} min before unlock ✓`,
    );
    console.log(
      '      (Documented gap: enforcement lives in the renderer, not the AEAD AD. '
      + 'See src/lib/domain/events.ts → Time Capsules section.)',
    );
  } finally {
    for (const id of userIds) await cleanupUser(id).catch(console.error);
  }
}

run().catch((err) => { console.error('FAIL:', err); process.exit(1); });
