/**
 * Test 70: Pre-Megolm → v4 Lazy Transition (Mixed-Envelope Room)
 *
 * CLAUDE.md invariant: "Pre-Megolm rooms transition lazily on next generation
 * bump." The reader path must decrypt BOTH v3 (flat-key) and v4 (Megolm)
 * blobs in the same room — a refactor that accidentally forces one envelope
 * version would silently break long-lived rooms' history.
 *
 * No existing test mixes envelope versions in a single room.
 *
 * Scenario:
 *   - Alice creates a room at gen 1; Bob joins at gen 1.
 *   - Alice sends a v3 blob B1 (flat room key) — represents a pre-Megolm message.
 *   - Alice starts a Megolm session S1 and sends a v4 blob B2 — represents the
 *     first post-transition message.
 *   - Alice reads back BOTH blobs from Supabase using the router-style
 *     decryptBlob (routes on blob.sessionId presence). B1 decrypts via the
 *     room key; B2 decrypts via the session snapshot.
 *   - Negative: rotate the room to gen 2 (new flat key). Assert the gen-2
 *     room key does NOT decrypt B1 (AEAD AD binds (roomId, generation)).
 *   - Negative: S1 snapshot (bound to gen 1) does not decrypt a freshly-minted
 *     v4 blob at gen 2 — confirms sessions don't cross generation boundaries.
 *
 * Run: npx tsx --env-file=.env.local scripts/test-pre-megolm-transition.ts
 */

import {
  generateRoomKey,
  rotateRoomKey,
  wrapRoomKeyFor,
  unwrapRoomKey,
  signMembershipWrap,
  encryptBlob,
  encryptBlobV4,
  decryptBlob,
  createOutboundSession,
  ratchetAndDerive,
  CryptoError,
  toBase64,
  fromBase64,
  type EncryptedBlob,
} from '../src/lib/e2ee-core';
import {
  initCrypto,
  createTestUser,
  provisionDevice,
  cleanupUser,
  makeServiceClient,
} from './test-utils';

async function run() {
  await initCrypto();

  const aliceUser = await createTestUser(`test-alice-pmt-${Date.now()}@example.com`);
  const bobUser   = await createTestUser(`test-bob-pmt-${Date.now()}@example.com`);
  const userIds   = [aliceUser.userId, bobUser.userId];
  const svc       = makeServiceClient();

  try {
    const alice = await provisionDevice(aliceUser.supabase, aliceUser.userId);
    const bob   = await provisionDevice(bobUser.supabase, bobUser.userId);

    // ── Room at gen 1 with Alice + Bob ───────────────────────────────────────
    const { data: room, error: roomErr } = await aliceUser.supabase
      .from('rooms').insert({ kind: 'group', created_by: alice.userId })
      .select('*').single();
    if (roomErr || !room) throw new Error(`createRoom: ${roomErr?.message}`);
    const gen1 = room.current_generation as number;
    const key1 = await generateRoomKey(gen1);

    for (const m of [
      { userId: alice.userId, deviceId: alice.deviceId, xPub: alice.bundle.x25519PublicKey, client: aliceUser.supabase },
      { userId: bob.userId,   deviceId: bob.deviceId,   xPub: bob.bundle.x25519PublicKey,   client: svc },
    ]) {
      const wrap = await wrapRoomKeyFor(key1, m.xPub);
      const sig  = await signMembershipWrap(
        { roomId: room.id, generation: gen1, memberUserId: m.userId,
          memberDeviceId: m.deviceId, wrappedRoomKey: wrap.wrapped,
          signerDeviceId: alice.deviceId },
        alice.bundle.ed25519PrivateKey,
      );
      const { error } = await m.client.from('room_members').insert({
        room_id: room.id, user_id: m.userId, device_id: m.deviceId, generation: gen1,
        wrapped_room_key: await toBase64(wrap.wrapped),
        signer_device_id: alice.deviceId, wrap_signature: await toBase64(sig),
      });
      if (error) throw new Error(`insert room_members ${m.deviceId.slice(0, 8)}: ${error.message}`);
    }

    // ── v3 blob B1 (flat room key) ───────────────────────────────────────────
    const b1 = await encryptBlob<{ text: string }>({
      payload: { text: 'pre-megolm message' },
      roomId: room.id, roomKey: key1,
      senderUserId: alice.userId, senderDeviceId: alice.deviceId,
      senderDeviceEd25519PrivateKey: alice.bundle.ed25519PrivateKey,
    });
    const { data: b1Row, error: b1Err } = await aliceUser.supabase.from('blobs').insert({
      room_id: room.id, sender_id: alice.userId, sender_device_id: alice.deviceId,
      generation: b1.generation, nonce: await toBase64(b1.nonce),
      ciphertext: await toBase64(b1.ciphertext),
      signature: null,
      session_id: null, message_index: null,
    }).select('*').single();
    if (b1Err || !b1Row) throw new Error(`insert B1: ${b1Err?.message}`);

    // ── v4 blob B2 (Megolm session S1, still at gen 1) ───────────────────────
    const s1 = await createOutboundSession(room.id, gen1);
    const msgKey0 = await ratchetAndDerive(s1);
    // ratchetAndDerive advances+zeroes the chain key; we hold msgKey0
    // directly and key the resolver off (sessionId, index) below rather
    // than capturing a snapshot we'd never use.

    const b2 = await encryptBlobV4<{ text: string }>({
      payload: { text: 'first megolm message' },
      roomId: room.id, messageKey: msgKey0, sessionId: s1.sessionId,
      generation: gen1,
      senderUserId: alice.userId, senderDeviceId: alice.deviceId,
      senderDeviceEd25519PrivateKey: alice.bundle.ed25519PrivateKey,
    });
    const { data: b2Row, error: b2Err } = await aliceUser.supabase.from('blobs').insert({
      room_id: room.id, sender_id: alice.userId, sender_device_id: alice.deviceId,
      generation: b2.generation, nonce: await toBase64(b2.nonce),
      ciphertext: await toBase64(b2.ciphertext),
      signature: null,
      session_id: b2.sessionId, message_index: b2.messageIndex,
    }).select('*').single();
    if (b2Err || !b2Row) throw new Error(`insert B2: ${b2Err?.message}`);

    // Fetch back — realistic reader path: stream all blobs for the room.
    const { data: allBlobs } = await svc.from('blobs')
      .select('*').eq('room_id', room.id)
      .order('created_at', { ascending: true });
    type BlobRow = {
      id: string; nonce: string; ciphertext: string; signature: string | null;
      generation: number; session_id: string | null; message_index: number | null;
    };
    const blobs = (allBlobs ?? []) as BlobRow[];
    if (blobs.length !== 2) throw new Error(`expected 2 blobs, got ${blobs.length}`);

    // Sanity on envelope mix before decrypt.
    const sessionIds = new Set(blobs.map((b) => b.session_id));
    if (!sessionIds.has(null)) throw new Error('expected a v3 blob (session_id=null) in the fetch');
    if ([...sessionIds].filter((x) => x != null).length !== 1) {
      throw new Error('expected exactly one v4 blob (non-null session_id) in the fetch');
    }

    // Megolm resolver: knows only session S1's key at index 0 (the one we
    // kept in-memory above).
    const msgKey0B64 = await toBase64(msgKey0.key);
    const resolveMegolm = async (sid: string, idx: number): Promise<Uint8Array | null> => {
      if (sid === b2.sessionId && idx === 0) return await fromBase64(msgKey0B64);
      return null;
    };

    // Router-style decrypt of every row.
    const decoded: string[] = [];
    for (const row of blobs) {
      const wire: EncryptedBlob = {
        nonce: await fromBase64(row.nonce),
        ciphertext: await fromBase64(row.ciphertext),
        signature: row.signature ? await fromBase64(row.signature) : new Uint8Array(0),
        generation: row.generation,
        sessionId: row.session_id ?? undefined,
        messageIndex: row.message_index ?? undefined,
      };
      const { payload } = await decryptBlob<{ text: string }>({
        blob: wire,
        roomId: room.id,
        roomKey: key1,
        resolveSenderDeviceEd25519Pub: async () => alice.bundle.ed25519PublicKey,
        resolveMegolmKey: resolveMegolm,
      });
      decoded.push(payload.text);
    }

    if (!decoded.includes('pre-megolm message')) {
      throw new Error(`v3 blob did not decrypt via flat room key: got ${JSON.stringify(decoded)}`);
    }
    if (!decoded.includes('first megolm message')) {
      throw new Error(`v4 blob did not decrypt via Megolm session: got ${JSON.stringify(decoded)}`);
    }

    // ── Negative: rotate room to gen 2. Gen-2 flat key must not decrypt B1. ─
    const { next: key2, wraps } = await rotateRoomKey(gen1, [
      alice.bundle.x25519PublicKey, bob.bundle.x25519PublicKey,
    ]);
    const keepers = [
      { userId: alice.userId, deviceId: alice.deviceId },
      { userId: bob.userId,   deviceId: bob.deviceId },
    ];
    const wrapSigs = await Promise.all(keepers.map((k, i) =>
      signMembershipWrap(
        { roomId: room.id, generation: key2.generation, memberUserId: k.userId,
          memberDeviceId: k.deviceId, wrappedRoomKey: wraps[i].wrapped,
          signerDeviceId: alice.deviceId },
        alice.bundle.ed25519PrivateKey,
      ),
    ));
    const { error: kickErr } = await aliceUser.supabase.rpc('kick_and_rotate', {
      p_room_id: room.id,
      p_evictee_user_ids: [],
      p_old_gen: gen1, p_new_gen: key2.generation,
      p_wraps: await Promise.all(keepers.map(async (k, i) => ({
        user_id: k.userId, device_id: k.deviceId,
        wrapped_room_key: await toBase64(wraps[i].wrapped),
        wrap_signature: await toBase64(wrapSigs[i]),
      }))),
      p_signer_device_id: alice.deviceId,
      p_name_ciphertext: null, p_name_nonce: null,
    });
    if (kickErr) throw new Error(`kick_and_rotate: ${kickErr.message}`);

    // Unwrap gen-2 key for Alice and try to decrypt the historical v3 B1 with it.
    const { data: a2Wrap } = await svc.from('room_members')
      .select('wrapped_room_key').eq('room_id', room.id)
      .eq('device_id', alice.deviceId).eq('generation', key2.generation).single();
    const aliceGen2Key = await unwrapRoomKey(
      { wrapped: await fromBase64((a2Wrap as { wrapped_room_key: string }).wrapped_room_key),
        generation: key2.generation },
      alice.bundle.x25519PublicKey, alice.bundle.x25519PrivateKey,
    );

    const b1Wire: EncryptedBlob = {
      nonce: await fromBase64((b1Row as BlobRow).nonce),
      ciphertext: await fromBase64((b1Row as BlobRow).ciphertext),
      signature: new Uint8Array(0),
      generation: (b1Row as BlobRow).generation,
    };
    try {
      await decryptBlob<{ text: string }>({
        blob: b1Wire,
        roomId: room.id,
        roomKey: aliceGen2Key,  // wrong key for gen 1 blob
        resolveSenderDeviceEd25519Pub: async () => alice.bundle.ed25519PublicKey,
      });
      throw new Error('Gen-2 flat key should not decrypt gen-1 v3 blob');
    } catch (err) {
      if (err instanceof Error && err.message.includes('should not decrypt')) throw err;
      if (!(err instanceof CryptoError)) {
        throw new Error(`Expected CryptoError, got ${err}`);
      }
      // BAD_GENERATION (caught by pre-AEAD generation check) or DECRYPT_FAILED
      // (AEAD) are both acceptable. What we reject is silent success.
    }

    // ── Gen-1 v3 blob still decrypts with the retained gen-1 key ─────────────
    const { payload: b1Replayed } = await decryptBlob<{ text: string }>({
      blob: b1Wire,
      roomId: room.id,
      roomKey: key1,
      resolveSenderDeviceEd25519Pub: async () => alice.bundle.ed25519PublicKey,
    });
    if (b1Replayed.text !== 'pre-megolm message') {
      throw new Error('Gen-1 v3 blob no longer decrypts with retained gen-1 key after rotation');
    }

    // ── S1 snapshot (bound to gen 1) does not decrypt a gen-2 v4 blob ────────
    // Build a fresh session S2 at gen 2, encrypt, then try to decrypt via the
    // S1 snapshot's known key — must fail AEAD (different session keys).
    const s2 = await createOutboundSession(room.id, key2.generation);
    const s2Key0 = await ratchetAndDerive(s2);
    const b3 = await encryptBlobV4<{ text: string }>({
      payload: { text: 'post-rotation megolm' },
      roomId: room.id, messageKey: s2Key0, sessionId: s2.sessionId,
      generation: key2.generation,
      senderUserId: alice.userId, senderDeviceId: alice.deviceId,
      senderDeviceEd25519PrivateKey: alice.bundle.ed25519PrivateKey,
    });

    // Try to decrypt b3 with a confused resolver that returns S1's key for
    // any sessionId — closest analogue to a cross-session key-reuse bug.
    // AEAD must catch it (different session keys → MAC mismatch).
    const wrongResolver = async (): Promise<Uint8Array | null> =>
      await fromBase64(msgKey0B64);
    try {
      await decryptBlob<{ text: string }>({
        blob: b3, roomId: room.id, roomKey: aliceGen2Key,
        resolveSenderDeviceEd25519Pub: async () => alice.bundle.ed25519PublicKey,
        resolveMegolmKey: wrongResolver,
      });
      throw new Error('S1 key should not decrypt a v4 blob encrypted with a different session');
    } catch (err) {
      if (err instanceof Error && err.message.includes('should not decrypt')) throw err;
      if (!(err instanceof CryptoError)) {
        throw new Error(`Expected CryptoError from wrong-session decrypt, got ${err}`);
      }
    }

    console.log('PASS: mixed-envelope room — v3 + v4 blobs both decrypt via router; gen-2 key rejects gen-1 v3; cross-session key fails AEAD ✓');
  } finally {
    for (const id of userIds) await cleanupUser(id).catch(console.error);
  }
}

run().catch((err) => { console.error('FAIL:', err); process.exit(1); });
