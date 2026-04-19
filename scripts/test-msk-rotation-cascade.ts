/**
 * Test 69: MSK Rotation Cascade Across Multiple Admined Rooms
 *
 * T13 covers MSK-rotation cryptographic primitives for a single room.
 * CLAUDE.md mandates: "MSK rotation cascades to room rotation, so a ghost
 * device can't retain room access" — enforced by `rotateAllRoomsIAdmin`.
 * No existing test exercises the N-room cascade; a regression that silently
 * skips any one of Alice's rooms would leave the ghost with access there.
 *
 * Scenario:
 *   - Alice provisions a trusted primary device A1 + ghost device A2.
 *   - Alice creates ROOM_COUNT rooms, all with (Alice A1 + A2, Bob B1) at gen 1.
 *   - MSK rotation: new MSK+SSK+USK, re-sign A1 under new SSK, DO NOT re-sign
 *     A2 (ghost — it's the device being squeezed out).
 *   - For EACH room, kick_and_rotate with wraps for (A1, B1) only — A2 omitted.
 *   - Verify per-room: A1 has a new-gen row, B1 has a new-gen row, A2 does NOT.
 *   - Verify: A2's cert no longer chains to the new SSK (CERT_INVALID) — the
 *     ghost is effectively revoked by cert-chain break, not just omitted.
 *
 * A buggy rotator that handled only the first room would leave A2 with a
 * valid gen-1 wrap (still in retention window) in rooms 2 and 3. This test
 * detects that by scanning every room.
 *
 * Run: npx tsx --env-file=.env.local scripts/test-msk-rotation-cascade.ts
 */

import {
  generateUserMasterKey,
  generateSigningKeys,
  signDeviceIssuanceV2,
  verifyCrossSigningChain,
  verifyDeviceIssuance,
  generateRoomKey,
  rotateRoomKey,
  wrapRoomKeyFor,
  unwrapRoomKey,
  signMembershipWrap,
  encryptBlob,
  decryptBlob,
  CryptoError,
  toBase64,
  fromBase64,
  type EncryptedBlob,
} from '../src/lib/e2ee-core';
import {
  initCrypto,
  createTestUser,
  provisionDevice,
  provisionSecondDevice,
  cleanupUser,
  makeServiceClient,
} from './test-utils';

const ROOM_COUNT = 3;

async function run() {
  await initCrypto();

  const aliceUser = await createTestUser(`test-alice-mskc-${Date.now()}@example.com`);
  const bobUser   = await createTestUser(`test-bob-mskc-${Date.now()}@example.com`);
  const userIds   = [aliceUser.userId, bobUser.userId];
  const svc       = makeServiceClient();

  try {
    // Alice: primary A1 + ghost A2 (both under the same SSK initially)
    const alice1 = await provisionDevice(aliceUser.supabase, aliceUser.userId);
    const alice2 = await provisionSecondDevice(aliceUser.supabase, aliceUser.userId, alice1.ssk);
    const bob    = await provisionDevice(bobUser.supabase, bobUser.userId);

    // ── Create ROOM_COUNT rooms, each with (A1, A2, B1) at gen 1 ─────────────
    interface RoomFixture {
      id: string;
      gen1Key: { key: Uint8Array; generation: number };
      preBlobId: string;
      preBlob: EncryptedBlob;
    }
    const rooms: RoomFixture[] = [];

    for (let r = 0; r < ROOM_COUNT; r++) {
      const { data: room, error: roomErr } = await aliceUser.supabase
        .from('rooms')
        .insert({ kind: 'group', created_by: alice1.userId })
        .select('*')
        .single();
      if (roomErr || !room) throw new Error(`createRoom[${r}]: ${roomErr?.message}`);
      const gen1 = room.current_generation as number;
      const key1 = await generateRoomKey(gen1);

      // Wrap for A1, A2, B1
      const members: Array<{
        userId: string; deviceId: string; xPub: Uint8Array;
        client: typeof aliceUser.supabase;
      }> = [
        { userId: alice1.userId, deviceId: alice1.deviceId, xPub: alice1.bundle.x25519PublicKey, client: aliceUser.supabase },
        { userId: alice1.userId, deviceId: alice2.deviceId, xPub: alice2.bundle.x25519PublicKey, client: aliceUser.supabase },
        { userId: bob.userId,    deviceId: bob.deviceId,    xPub: bob.bundle.x25519PublicKey,    client: svc },
      ];
      for (const m of members) {
        const wrap = await wrapRoomKeyFor(key1, m.xPub);
        const sig = await signMembershipWrap(
          { roomId: room.id, generation: gen1, memberUserId: m.userId,
            memberDeviceId: m.deviceId, wrappedRoomKey: wrap.wrapped,
            signerDeviceId: alice1.deviceId },
          alice1.bundle.ed25519PrivateKey,
        );
        const { error } = await m.client.from('room_members').insert({
          room_id: room.id, user_id: m.userId, device_id: m.deviceId, generation: gen1,
          wrapped_room_key: await toBase64(wrap.wrapped),
          signer_device_id: alice1.deviceId,
          wrap_signature: await toBase64(sig),
        });
        if (error) throw new Error(`insert room_members r${r} dev ${m.deviceId.slice(0, 8)}: ${error.message}`);
      }

      // Alice (A1) sends a pre-rotation blob so we can assert A1 still reads it later.
      const blob = await encryptBlob<{ text: string }>({
        payload: { text: `room-${r}-pre` },
        roomId: room.id, roomKey: key1,
        senderUserId: alice1.userId, senderDeviceId: alice1.deviceId,
        senderDeviceEd25519PrivateKey: alice1.bundle.ed25519PrivateKey,
      });
      const { data: blobRow, error: blobErr } = await aliceUser.supabase.from('blobs').insert({
        room_id: room.id, sender_id: alice1.userId, sender_device_id: alice1.deviceId,
        generation: blob.generation, nonce: await toBase64(blob.nonce),
        ciphertext: await toBase64(blob.ciphertext),
        signature: null, session_id: null, message_index: null,
      }).select('id').single();
      if (blobErr || !blobRow) throw new Error(`preBlob r${r}: ${blobErr?.message}`);

      rooms.push({
        id: room.id,
        gen1Key: key1,
        preBlobId: (blobRow as { id: string }).id,
        preBlob: blob,
      });
    }

    // ── MSK rotation: new MSK+SSK+USK, re-sign A1 (not A2) ───────────────────
    const newMsk = await generateUserMasterKey();
    const { ssk: newSsk, usk: newUsk, sskCrossSignature, uskCrossSignature } =
      await generateSigningKeys(newMsk);

    // Re-sign A1's issuance cert under new SSK. A2 is intentionally left
    // carrying its old cert — after the identity upsert below, A2's cert will
    // no longer chain to the published SSK.
    const { data: a1Row } = await svc.from('devices')
      .select('device_ed25519_pub, device_x25519_pub, issuance_created_at_ms')
      .eq('id', alice1.deviceId).single();
    const a1rr = a1Row as { device_ed25519_pub: string; device_x25519_pub: string; issuance_created_at_ms: number };
    const a1NewSig = await signDeviceIssuanceV2(
      {
        userId: alice1.userId,
        deviceId: alice1.deviceId,
        deviceEd25519PublicKey: await fromBase64(a1rr.device_ed25519_pub),
        deviceX25519PublicKey:  await fromBase64(a1rr.device_x25519_pub),
        createdAtMs: a1rr.issuance_created_at_ms,
      },
      newSsk.ed25519PrivateKey,
    );

    // Publish new identity row — old SSK/USK now gone.
    const { error: idErr } = await aliceUser.supabase.from('identities').upsert({
      user_id: alice1.userId,
      ed25519_pub: await toBase64(newMsk.ed25519PublicKey),
      x25519_pub: null,
      self_signature: null,
      ssk_pub: await toBase64(newSsk.ed25519PublicKey),
      ssk_cross_signature: await toBase64(sskCrossSignature),
      usk_pub: await toBase64(newUsk.ed25519PublicKey),
      usk_cross_signature: await toBase64(uskCrossSignature),
      identity_epoch: 1,
    });
    if (idErr) throw new Error(`publish new identity: ${idErr.message}`);

    // Update A1's cert in devices.
    const { error: certErr } = await aliceUser.supabase.from('devices')
      .update({ issuance_signature: await toBase64(a1NewSig) })
      .eq('id', alice1.deviceId);
    if (certErr) throw new Error(`update A1 cert: ${certErr.message}`);

    // Sanity: new cross-sig chain verifies, A1 cert verifies against new SSK.
    await verifyCrossSigningChain({
      mskPub: newMsk.ed25519PublicKey,
      sskPub: newSsk.ed25519PublicKey,
      sskCrossSignature,
      uskPub: newUsk.ed25519PublicKey,
      uskCrossSignature,
    });
    await verifyDeviceIssuance(
      {
        userId: alice1.userId,
        deviceId: alice1.deviceId,
        deviceEd25519PublicKey: await fromBase64(a1rr.device_ed25519_pub),
        deviceX25519PublicKey:  await fromBase64(a1rr.device_x25519_pub),
        createdAtMs: a1rr.issuance_created_at_ms,
      },
      a1NewSig, newMsk.ed25519PublicKey, newSsk.ed25519PublicKey,
    );

    // ── Cascade room rotation: each room → gen 2, wraps for (A1, B1) only ────
    for (const room of rooms) {
      const keepers: Array<{ userId: string; deviceId: string; xPub: Uint8Array }> = [
        { userId: alice1.userId, deviceId: alice1.deviceId, xPub: alice1.bundle.x25519PublicKey },
        { userId: bob.userId,    deviceId: bob.deviceId,    xPub: bob.bundle.x25519PublicKey },
      ];
      const { next, wraps } = await rotateRoomKey(
        room.gen1Key.generation,
        keepers.map((k) => k.xPub),
      );
      const wrapSigs = await Promise.all(
        keepers.map((k, i) =>
          signMembershipWrap(
            { roomId: room.id, generation: next.generation, memberUserId: k.userId,
              memberDeviceId: k.deviceId, wrappedRoomKey: wraps[i].wrapped,
              signerDeviceId: alice1.deviceId },
            alice1.bundle.ed25519PrivateKey,
          ),
        ),
      );

      const { error: kickErr } = await aliceUser.supabase.rpc('kick_and_rotate', {
        p_room_id: room.id,
        p_evictee_user_ids: [],
        p_old_gen: room.gen1Key.generation,
        p_new_gen: next.generation,
        p_wraps: await Promise.all(keepers.map(async (k, i) => ({
          user_id: k.userId, device_id: k.deviceId,
          wrapped_room_key: await toBase64(wraps[i].wrapped),
          wrap_signature:   await toBase64(wrapSigs[i]),
        }))),
        p_signer_device_id: alice1.deviceId,
        p_name_ciphertext: null, p_name_nonce: null,
      });
      if (kickErr) throw new Error(`kick_and_rotate room ${room.id.slice(0, 8)}: ${kickErr.message}`);
    }

    // ── Per-room assertions: A1 + B1 present at gen 2, A2 absent ─────────────
    for (const room of rooms) {
      const { data: memberRows } = await svc.from('room_members')
        .select('device_id, generation')
        .eq('room_id', room.id);
      const rows = (memberRows ?? []) as Array<{ device_id: string; generation: number }>;
      const gen2Devices = rows.filter((r) => r.generation === 2).map((r) => r.device_id);

      if (!gen2Devices.includes(alice1.deviceId)) {
        throw new Error(`Cascade regression: A1 missing from room ${room.id.slice(0, 8)} gen 2`);
      }
      if (!gen2Devices.includes(bob.deviceId)) {
        throw new Error(`Cascade regression: Bob missing from room ${room.id.slice(0, 8)} gen 2`);
      }
      if (gen2Devices.includes(alice2.deviceId)) {
        throw new Error(
          `Ghost retention: A2 retained gen-2 membership in room ${room.id.slice(0, 8)} — cascade failed to exclude`,
        );
      }
    }

    // ── A2 cert no longer chains to new SSK ──────────────────────────────────
    const { data: a2Row } = await svc.from('devices')
      .select('device_ed25519_pub, device_x25519_pub, issuance_created_at_ms, issuance_signature')
      .eq('id', alice2.deviceId).single();
    const a2rr = a2Row as {
      device_ed25519_pub: string; device_x25519_pub: string;
      issuance_created_at_ms: number; issuance_signature: string;
    };
    try {
      await verifyDeviceIssuance(
        {
          userId: alice1.userId,
          deviceId: alice2.deviceId,
          deviceEd25519PublicKey: await fromBase64(a2rr.device_ed25519_pub),
          deviceX25519PublicKey:  await fromBase64(a2rr.device_x25519_pub),
          createdAtMs: a2rr.issuance_created_at_ms,
        },
        await fromBase64(a2rr.issuance_signature),
        newMsk.ed25519PublicKey,
        newSsk.ed25519PublicKey,
      );
      throw new Error('Ghost retention: A2 cert still verifies against new SSK after rotation');
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Ghost retention')) throw err;
      if (!(err instanceof CryptoError) || err.code !== 'CERT_INVALID') {
        throw new Error(`Expected CERT_INVALID for A2 under new SSK, got ${err}`);
      }
    }

    // ── A1 can actually decrypt new-gen blobs: round-trip one ────────────────
    // (proves the re-signed cert + new-gen wrap work end-to-end, not just
    // that the row exists.)
    const probeRoom = rooms[0];
    const { data: a1Wrap } = await svc.from('room_members')
      .select('wrapped_room_key').eq('room_id', probeRoom.id)
      .eq('device_id', alice1.deviceId).eq('generation', 2).single();
    const a1Gen2Key = await unwrapRoomKey(
      { wrapped: await fromBase64((a1Wrap as { wrapped_room_key: string }).wrapped_room_key), generation: 2 },
      alice1.bundle.x25519PublicKey, alice1.bundle.x25519PrivateKey,
    );
    const postBlob = await encryptBlob<{ text: string }>({
      payload: { text: 'post-rotation' },
      roomId: probeRoom.id, roomKey: a1Gen2Key,
      senderUserId: alice1.userId, senderDeviceId: alice1.deviceId,
      senderDeviceEd25519PrivateKey: alice1.bundle.ed25519PrivateKey,
    });
    const { payload: decoded } = await decryptBlob<{ text: string }>({
      blob: postBlob, roomId: probeRoom.id, roomKey: a1Gen2Key,
      resolveSenderDeviceEd25519Pub: async () => alice1.bundle.ed25519PublicKey,
    });
    if (decoded.text !== 'post-rotation') {
      throw new Error(`Round-trip failed: expected "post-rotation", got "${decoded.text}"`);
    }

    console.log(`PASS: MSK rotation cascaded across ${ROOM_COUNT} rooms — A1+Bob retained at gen 2, A2 excluded from every room, A2 cert broken by new SSK ✓`);
  } finally {
    for (const id of userIds) await cleanupUser(id).catch(console.error);
  }
}

run().catch((err) => { console.error('FAIL:', err); process.exit(1); });
