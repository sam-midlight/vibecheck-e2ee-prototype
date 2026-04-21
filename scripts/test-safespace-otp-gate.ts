/**
 * Test: Safe Space OTP gate is UI-only
 *
 * Documents — and asserts — that the 4-digit OTP on an `icebreaker_post`
 * event is NOT cryptographically privileged. The OTP rides inside the
 * encrypted payload as a plain string; any current room member who can
 * decrypt the blob (i.e. all of them) can read the OTP without ever
 * needing the partner to "share it out loud".
 *
 * Trust model per src/lib/domain/events.ts (Safe Space + Time-Out section):
 * "the OTP sits in the encrypted blob alongside the content and is visible
 * to all members on decrypt — the gate is UX-enforced, not cryptographic."
 *
 * This test PASSES today because that gap is the documented intentional
 * behavior. If you ever harden Safe Space (e.g. derive a per-entry key from
 * the OTP and only ship the wrapped key when the partner re-enters it),
 * this test will need to be flipped.
 *
 * Asserts:
 *   - Bob (a member) decrypts an icebreaker_post and reads the OTP plaintext
 *     directly from the payload, with no `icebreaker_unlock` event present.
 *   - The decrypted OTP matches the four-digit pattern (sanity).
 *
 * Run: npx tsx --env-file=.env.local scripts/test-safespace-otp-gate.ts
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

interface IcebreakerPostPayload {
  type: 'icebreaker_post';
  entryId: string;
  content: string;
  otp: string;
  ts: number;
}

async function run() {
  await initCrypto();

  const aliceUser = await createTestUser(`test-alice-sso-${Date.now()}@example.com`);
  const bobUser   = await createTestUser(`test-bob-sso-${Date.now()}@example.com`);
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

    // -- Alice posts an icebreaker behind a 4-digit OTP -----------------------
    const payload: IcebreakerPostPayload = {
      type: 'icebreaker_post',
      entryId: crypto.randomUUID(),
      content: 'I want to talk about how I feel when you forget our anniversary.',
      otp: '7391',
      ts: Date.now(),
    };
    const encBlob = await encryptBlob<IcebreakerPostPayload>({
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

    // -- Bob fetches + decrypts the post (no unlock event has been sent) ------
    const { data: rows } = await bobUser.supabase
      .from('blobs').select('*').eq('room_id', room.id);
    if (!rows || rows.length !== 1) {
      throw new Error(`expected exactly 1 blob, got ${rows?.length}`);
    }
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
    const { payload: decrypted } = await decryptBlob<IcebreakerPostPayload>({
      blob: wireBlob, roomId: room.id, roomKey: bobRoomKey,
      resolveSenderDeviceEd25519Pub: async () => alice.bundle.ed25519PublicKey,
    });

    if (!/^\d{4}$/.test(decrypted.otp)) {
      throw new Error(`payload OTP "${decrypted.otp}" doesn't match 4-digit pattern`);
    }
    if (decrypted.otp !== '7391') {
      throw new Error(`OTP mismatch: got "${decrypted.otp}"`);
    }
    if (!decrypted.content.includes('anniversary')) {
      throw new Error(`content payload didn't survive decrypt`);
    }

    console.log(
      'PASS: Safe-Space OTP is UI-only — Bob read OTP "'
      + decrypted.otp + '" + content directly from the encrypted payload ✓',
    );
    console.log(
      '      (Documented gap: enforcement lives in SafeSpace.tsx, not the AEAD. '
      + 'See src/lib/domain/events.ts → Safe Space + Time-Out section.)',
    );
  } finally {
    for (const id of userIds) await cleanupUser(id).catch(console.error);
  }
}

run().catch((err) => { console.error('FAIL:', err); process.exit(1); });
