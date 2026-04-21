/**
 * Test: MSK rotation orchestrator scope — only rooms the user ADMINS
 * get a gen bump; rooms where they're a non-admin member are left alone.
 *
 * The cascade test (test-msk-rotation-cascade.ts) covers the positive path
 * (every admined room gets rotated). It does NOT cover the negative: what
 * happens when Alice rotates her MSK while being a member of a room she
 * does not own. That room's rotation is Bob's responsibility, not Alice's —
 * `rotateAllRoomsIAdmin` must not attempt to rotate it, since:
 *   (a) `kick_and_rotate` is creator-only at the RPC level (migration 0040);
 *       Alice calling it on Bob's room would fail authorization;
 *   (b) even if it didn't fail, scope-creeping would let any user trigger
 *       rotation in rooms they merely joined — a governance violation.
 *
 * Scenario:
 *   - Alice has two devices (dev0 + dev1). dev1 gets revoked.
 *   - Alice admins R1, R2; Alice is a member of R3 (Bob admins R3).
 *   - Simulate the MSK rotation orchestrator: rotate identity atomically
 *     with cert reissue + revocation; then cascade rotate Alice's own rooms.
 *   - Assert:
 *       R1, R2: gen bumped from 1 → 2; only dev0 in new-gen membership.
 *       R3:     gen STILL 1 after Alice's rotation (Alice didn't touch it).
 *       dev1:   revocation_signature present; Alice's identity_epoch = 1.
 *       Alice still sees R3 at gen-1 via her dev0 membership.
 *
 * Why this matters: a buggy orchestrator that iterates ALL rooms visible
 * to Alice (including ones where she's a non-admin member) would call
 * `kick_and_rotate` on R3 — the RPC would reject it with a "not room
 * creator" error, but some implementations might swallow that silently
 * and report success. This test pins the correct scope.
 *
 * Run: npx tsx --env-file=.env.local scripts/test-msk-rotation-orchestrator.ts
 */

import {
  generateUserMasterKey,
  generateSigningKeys,
  signDeviceIssuanceV2,
  signDeviceRevocationV2,
  generateRoomKey,
  rotateRoomKey,
  wrapRoomKeyFor,
  signMembershipWrap,
  signInviteEnvelope,
  toBase64,
  fromBase64,
} from '../src/lib/e2ee-core';
import {
  initCrypto,
  createTestUser,
  provisionDevice,
  provisionSecondDevice,
  cleanupUser,
  makeServiceClient,
} from './test-utils';

async function run() {
  await initCrypto();

  const aliceUser = await createTestUser(`test-alice-mskorch-${Date.now()}@example.com`);
  const bobUser   = await createTestUser(`test-bob-mskorch-${Date.now()}@example.com`);
  const userIds = [aliceUser.userId, bobUser.userId];
  const svc = makeServiceClient();

  try {
    const dev0 = await provisionDevice(aliceUser.supabase, aliceUser.userId);
    const dev1 = await provisionSecondDevice(aliceUser.supabase, aliceUser.userId, dev0.ssk);
    const bob  = await provisionDevice(bobUser.supabase,   bobUser.userId);

    // Helper: create a room owned by `creator`, with `members` at gen 1.
    interface RoomMember {
      userId: string; deviceId: string; xPub: Uint8Array;
      signerDeviceId: string; signerEdPriv: Uint8Array;
      client: typeof aliceUser.supabase;
    }
    async function mkRoom(creator: RoomMember, members: RoomMember[]): Promise<string> {
      const { data: room, error: roomErr } = await creator.client
        .from('rooms').insert({ kind: 'group', created_by: creator.userId })
        .select('id, current_generation').single();
      if (roomErr || !room) throw new Error(`createRoom: ${roomErr?.message}`);
      const roomId = (room as { id: string }).id;
      const gen1 = (room as { current_generation: number }).current_generation;
      const k1 = await generateRoomKey(gen1);
      for (const m of members) {
        const wrap = await wrapRoomKeyFor(k1, m.xPub);
        const sig = await signMembershipWrap(
          { roomId, generation: gen1, memberUserId: m.userId, memberDeviceId: m.deviceId,
            wrappedRoomKey: wrap.wrapped, signerDeviceId: creator.deviceId },
          creator.signerEdPriv,
        );
        const { error } = await m.client.from('room_members').insert({
          room_id: roomId, user_id: m.userId, device_id: m.deviceId, generation: gen1,
          wrapped_room_key: await toBase64(wrap.wrapped),
          signer_device_id: creator.deviceId,
          wrap_signature: await toBase64(sig),
        });
        if (error) throw new Error(`room_members insert: ${error.message}`);
      }
      return roomId;
    }

    const aliceCreator: RoomMember = {
      userId: aliceUser.userId, deviceId: dev0.deviceId, xPub: dev0.bundle.x25519PublicKey,
      signerDeviceId: dev0.deviceId, signerEdPriv: dev0.bundle.ed25519PrivateKey,
      client: aliceUser.supabase,
    };
    const aliceDev0Member: RoomMember = { ...aliceCreator };
    const aliceDev1Member: RoomMember = {
      ...aliceCreator, deviceId: dev1.deviceId, xPub: dev1.bundle.x25519PublicKey,
    };
    const bobCreator: RoomMember = {
      userId: bobUser.userId, deviceId: bob.deviceId, xPub: bob.bundle.x25519PublicKey,
      signerDeviceId: bob.deviceId, signerEdPriv: bob.bundle.ed25519PrivateKey,
      client: bobUser.supabase,
    };

    // R1, R2 — Alice admins; both devices are members.
    const r1 = await mkRoom(aliceCreator, [aliceDev0Member, aliceDev1Member]);
    const r2 = await mkRoom(aliceCreator, [aliceDev0Member, aliceDev1Member]);

    // R3 — Bob admins; Bob is a member. Alice joins via invite.
    const r3 = await mkRoom(bobCreator, [bobCreator]);

    // Bob invites Alice's dev0 into R3 so Alice is a non-admin member.
    async function inviteAndAccept(roomId: string): Promise<void> {
      const { data: r3Room } = await svc.from('rooms').select('current_generation').eq('id', roomId).single();
      const gen = (r3Room as { current_generation: number }).current_generation;
      const { data: wraps3 } = await svc.from('room_members').select('wrapped_room_key')
        .eq('room_id', roomId).eq('device_id', bob.deviceId).eq('generation', gen).single();
      // We need Bob's outbound room key to wrap for Alice. Re-derive: Bob
      // unwraps his own, then wraps for Alice dev0.
      const { unwrapRoomKey } = await import('../src/lib/e2ee-core');
      const bobKey = await unwrapRoomKey(
        { wrapped: await fromBase64((wraps3 as { wrapped_room_key: string }).wrapped_room_key), generation: gen },
        bob.bundle.x25519PublicKey, bob.bundle.x25519PrivateKey,
      );
      const aliceWrap = await wrapRoomKeyFor(bobKey, dev0.bundle.x25519PublicKey);
      const expiresAtMs = Date.now() + 60 * 60 * 1000;
      const inviteSig = await signInviteEnvelope(
        {
          roomId, generation: gen,
          invitedUserId: aliceUser.userId, invitedDeviceId: dev0.deviceId,
          invitedDeviceEd25519PublicKey: dev0.bundle.ed25519PublicKey,
          invitedDeviceX25519PublicKey:  dev0.bundle.x25519PublicKey,
          wrappedRoomKey: aliceWrap.wrapped,
          inviterUserId: bob.userId, inviterDeviceId: bob.deviceId,
          expiresAtMs,
        },
        bob.bundle.ed25519PrivateKey,
      );
      await bobUser.supabase.from('room_invites').insert({
        room_id: roomId, invited_user_id: aliceUser.userId, invited_device_id: dev0.deviceId,
        invited_x25519_pub: await toBase64(dev0.bundle.x25519PublicKey),
        invited_ed25519_pub: await toBase64(dev0.bundle.ed25519PublicKey),
        generation: gen, wrapped_room_key: await toBase64(aliceWrap.wrapped),
        created_by: bob.userId, inviter_device_id: bob.deviceId,
        inviter_signature: await toBase64(inviteSig),
        expires_at_ms: expiresAtMs,
      });
      const memberSig = await signMembershipWrap(
        { roomId, generation: gen, memberUserId: aliceUser.userId,
          memberDeviceId: dev0.deviceId, wrappedRoomKey: aliceWrap.wrapped,
          signerDeviceId: bob.deviceId },
        bob.bundle.ed25519PrivateKey,
      );
      const { error } = await aliceUser.supabase.from('room_members').insert({
        room_id: roomId, user_id: aliceUser.userId, device_id: dev0.deviceId, generation: gen,
        wrapped_room_key: await toBase64(aliceWrap.wrapped),
        signer_device_id: bob.deviceId, wrap_signature: await toBase64(memberSig),
      });
      if (error) throw new Error(`Alice accept into R3: ${error.message}`);
    }
    await inviteAndAccept(r3);

    // -- MSK rotation: new MSK + SSK + USK; reissue dev0 cert; revoke dev1 ----
    const newMsk = await generateUserMasterKey();
    const { ssk: newSsk, usk: newUsk, sskCrossSignature, uskCrossSignature } =
      await generateSigningKeys(newMsk);

    const { data: dev0Row } = await svc.from('devices')
      .select('device_ed25519_pub, device_x25519_pub, issuance_created_at_ms')
      .eq('id', dev0.deviceId).single();
    const d0 = dev0Row as { device_ed25519_pub: string; device_x25519_pub: string; issuance_created_at_ms: number };

    const dev0NewIssuanceSig = await signDeviceIssuanceV2(
      {
        userId: aliceUser.userId, deviceId: dev0.deviceId,
        deviceEd25519PublicKey: await fromBase64(d0.device_ed25519_pub),
        deviceX25519PublicKey:  await fromBase64(d0.device_x25519_pub),
        createdAtMs: d0.issuance_created_at_ms,
      },
      newSsk.ed25519PrivateKey,
    );
    const revokedAtMs = Date.now();
    const dev1RevSig = await signDeviceRevocationV2(
      { userId: aliceUser.userId, deviceId: dev1.deviceId, revokedAtMs },
      newSsk.ed25519PrivateKey,
    );

    // Identity + cert + revocation (commitRotatedUmk equivalent).
    const { error: idErr } = await aliceUser.supabase.from('identities').upsert({
      user_id: aliceUser.userId,
      ed25519_pub: await toBase64(newMsk.ed25519PublicKey),
      x25519_pub: null, self_signature: null,
      ssk_pub: await toBase64(newSsk.ed25519PublicKey),
      ssk_cross_signature: await toBase64(sskCrossSignature),
      usk_pub: await toBase64(newUsk.ed25519PublicKey),
      usk_cross_signature: await toBase64(uskCrossSignature),
      identity_epoch: 1,
    });
    if (idErr) throw new Error(`identity publish: ${idErr.message}`);

    await Promise.all([
      aliceUser.supabase.from('devices')
        .update({ issuance_signature: await toBase64(dev0NewIssuanceSig) })
        .eq('id', dev0.deviceId),
      aliceUser.supabase.from('devices')
        .update({ revoked_at_ms: revokedAtMs, revocation_signature: await toBase64(dev1RevSig) })
        .eq('id', dev1.deviceId),
    ]);

    // -- Cascade: rotate ONLY rooms Alice admins (R1, R2) ---------------------
    // Mirrors rotateAllRoomsIAdmin() at bootstrap.ts:809, which filters
    // `rooms where created_by = self` before calling rotateRoomMembership.
    const { data: roomsIAdmin } = await aliceUser.supabase
      .from('rooms').select('id, current_generation').eq('created_by', aliceUser.userId);
    const adminIds = (roomsIAdmin ?? []).map((r) => (r as { id: string }).id).sort();
    const expectedAdmins = [r1, r2].sort();
    if (JSON.stringify(adminIds) !== JSON.stringify(expectedAdmins)) {
      throw new Error(
        `Pre-condition: Alice admins mismatch. Got ${JSON.stringify(adminIds)}, ` +
        `expected ${JSON.stringify(expectedAdmins)}`,
      );
    }

    for (const roomId of adminIds) {
      const { data: room } = await svc.from('rooms').select('current_generation').eq('id', roomId).single();
      const gen1 = (room as { current_generation: number }).current_generation;
      const keepers = [{
        userId: aliceUser.userId, deviceId: dev0.deviceId, xPub: dev0.bundle.x25519PublicKey,
      }];
      const { next, wraps } = await rotateRoomKey(gen1, keepers.map((k) => k.xPub));
      const wrapSigs = await Promise.all(
        keepers.map((k, i) =>
          signMembershipWrap(
            { roomId, generation: next.generation, memberUserId: k.userId,
              memberDeviceId: k.deviceId, wrappedRoomKey: wraps[i].wrapped,
              signerDeviceId: dev0.deviceId },
            dev0.bundle.ed25519PrivateKey,
          ),
        ),
      );
      const { error: kickErr } = await aliceUser.supabase.rpc('kick_and_rotate', {
        p_room_id: roomId,
        p_evictee_user_ids: [], // we don't evict; dev1 is omitted from wraps
        p_old_gen: gen1, p_new_gen: next.generation,
        p_wraps: await Promise.all(keepers.map(async (k, i) => ({
          user_id: k.userId, device_id: k.deviceId,
          wrapped_room_key: await toBase64(wraps[i].wrapped),
          wrap_signature:   await toBase64(wrapSigs[i]),
        }))),
        p_signer_device_id: dev0.deviceId,
        p_name_ciphertext: null, p_name_nonce: null,
      });
      if (kickErr) throw new Error(`kick_and_rotate ${roomId.slice(0, 8)}: ${kickErr.message}`);
    }

    // -- Assertion A: R1, R2 bumped to gen 2; dev0 only; dev1 absent ---------
    for (const roomId of [r1, r2]) {
      const { data: room } = await svc.from('rooms').select('current_generation').eq('id', roomId).single();
      const gen = (room as { current_generation: number }).current_generation;
      if (gen !== 2) throw new Error(`${roomId.slice(0, 8)}: expected gen 2, got ${gen}`);

      const { data: members } = await svc.from('room_members')
        .select('device_id, generation').eq('room_id', roomId);
      const rows = (members ?? []) as Array<{ device_id: string; generation: number }>;
      const gen2Devs = rows.filter((r) => r.generation === 2).map((r) => r.device_id);
      if (!gen2Devs.includes(dev0.deviceId)) {
        throw new Error(`${roomId.slice(0, 8)}: dev0 missing from gen 2`);
      }
      if (gen2Devs.includes(dev1.deviceId)) {
        throw new Error(`${roomId.slice(0, 8)}: ghost retention — dev1 in gen 2`);
      }
    }

    // -- Assertion B: R3 NOT touched — still gen 1; Alice dev0 still present -
    {
      const { data: r3Room } = await svc.from('rooms').select('current_generation').eq('id', r3).single();
      const r3Gen = (r3Room as { current_generation: number }).current_generation;
      if (r3Gen !== 1) {
        throw new Error(`Orchestrator over-reach: R3 (Bob's room) was rotated — gen=${r3Gen}`);
      }
      const { data: r3Members } = await svc.from('room_members')
        .select('user_id, device_id, generation').eq('room_id', r3);
      const r3Rows = (r3Members ?? []) as Array<{ user_id: string; device_id: string; generation: number }>;
      const aliceStill = r3Rows.some(
        (r) => r.user_id === aliceUser.userId && r.device_id === dev0.deviceId && r.generation === 1,
      );
      if (!aliceStill) {
        throw new Error('Alice dev0 should still be a gen-1 member of R3 after her own rotation');
      }
    }

    // -- Assertion C: attempt — calling kick_and_rotate on R3 as Alice must
    //    fail at the RPC (she isn't the creator). Defense-in-depth proof.
    {
      const { data: r3Room } = await svc.from('rooms').select('current_generation').eq('id', r3).single();
      const r3Gen = (r3Room as { current_generation: number }).current_generation;
      const { next: r3Next, wraps: r3Wraps } = await rotateRoomKey(
        r3Gen, [dev0.bundle.x25519PublicKey],
      );
      const wrapSig = await signMembershipWrap(
        { roomId: r3, generation: r3Next.generation, memberUserId: aliceUser.userId,
          memberDeviceId: dev0.deviceId, wrappedRoomKey: r3Wraps[0].wrapped,
          signerDeviceId: dev0.deviceId },
        dev0.bundle.ed25519PrivateKey,
      );
      const { error: forbidErr } = await aliceUser.supabase.rpc('kick_and_rotate', {
        p_room_id: r3, p_evictee_user_ids: [],
        p_old_gen: r3Gen, p_new_gen: r3Next.generation,
        p_wraps: [{
          user_id: aliceUser.userId, device_id: dev0.deviceId,
          wrapped_room_key: await toBase64(r3Wraps[0].wrapped),
          wrap_signature:   await toBase64(wrapSig),
        }],
        p_signer_device_id: dev0.deviceId,
        p_name_ciphertext: null, p_name_nonce: null,
      });
      if (!forbidErr) {
        throw new Error('Vulnerability: Alice rotated Bob\'s room R3 — creator check is not firing');
      }
      // Supabase surfaces a PostgresError for "not room creator".
    }

    // -- Assertion D: identity_epoch bumped; dev1.revoked_at_ms set ----------
    const { data: identity } = await svc.from('identities')
      .select('identity_epoch, ed25519_pub').eq('user_id', aliceUser.userId).single();
    const idRow = identity as { identity_epoch: number; ed25519_pub: string };
    if (idRow.identity_epoch !== 1) {
      throw new Error(`identity_epoch not bumped: got ${idRow.identity_epoch}`);
    }
    if (idRow.ed25519_pub !== await toBase64(newMsk.ed25519PublicKey)) {
      throw new Error('identity.ed25519_pub did not update to new MSK');
    }
    const { data: dev1Final } = await svc.from('devices')
      .select('revoked_at_ms, revocation_signature').eq('id', dev1.deviceId).single();
    const d1r = dev1Final as { revoked_at_ms: number | null; revocation_signature: string | null };
    if (d1r.revoked_at_ms !== revokedAtMs) {
      throw new Error(`dev1.revoked_at_ms wrong: ${d1r.revoked_at_ms}`);
    }
    if (!d1r.revocation_signature) {
      throw new Error('dev1.revocation_signature missing');
    }

    console.log(
      'PASS: MSK rotation orchestrator — R1/R2 (admin) bumped, R3 (non-admin) ' +
      'untouched, creator-only RPC rejects Alice on R3, identity_epoch + dev1 revocation persisted ✓',
    );
  } finally {
    for (const id of userIds) await cleanupUser(id).catch(console.error);
  }
}

run().catch((err) => { console.error('FAIL:', err); process.exit(1); });
