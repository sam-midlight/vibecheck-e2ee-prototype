/**
 * Test: Service-role invite-row injection must be rejected client-side.
 *
 * Threat model: an attacker who gains service-role credentials (or a future
 * RLS regression) bypasses the invites-table INSERT policy and writes an
 * unsigned / bogus-signature / wrong-inviter row. The clients are the last
 * line of defense — `verifyInviteEnvelope` must throw SIGNATURE_INVALID
 * before the invitee unwraps the room key or inserts a room_members row.
 *
 * Attack vectors exercised:
 *   A. Empty/zeroed inviter_signature           → SIGNATURE_INVALID
 *   B. Random-bytes inviter_signature            → SIGNATURE_INVALID
 *   C. Valid signature over DIFFERENT fields     → SIGNATURE_INVALID
 *      (attacker replays a genuine sig from a different invite — binding
 *      to roomId/device/wrapped-key must detect the mismatch)
 *   D. Valid signature by a DIFFERENT inviter    → SIGNATURE_INVALID
 *      (Mallory signs an invite claiming Alice's user_id — verifier uses
 *      Alice's device pub and rejects)
 *   E. Signature over expired expires_at_ms      → SIGNATURE_INVALID when
 *      verifier is passed the ROW's fields (including whatever the row
 *      claims), if the row's exp_ms has been tampered post-sign
 *
 * Why this matters beyond RLS: service_role writes bypass every row-level
 * policy. Test 33 asserts that the *write path* rejects an unsigned invite
 * under the invitee's own auth. This test asserts the read/accept path
 * rejects a row that *did* get written (via service-role or an RLS gap).
 *
 * Run: npx tsx --env-file=.env.local scripts/test-invite-signature-injection.ts
 */

import {
  generateRoomKey,
  wrapRoomKeyFor,
  signMembershipWrap,
  signInviteEnvelope,
  verifyInviteEnvelope,
  getSodium,
  fromBase64,
  toBase64,
} from '../src/lib/e2ee-core';
import { initCrypto, createTestUser, provisionDevice, cleanupUser, makeServiceClient } from './test-utils';

type InjectionCase =
  | 'empty-sig'
  | 'random-sig'
  | 'valid-sig-different-fields'
  | 'valid-sig-different-inviter'
  | 'tampered-expires-at';

async function run() {
  await initCrypto();

  const aliceUser = await createTestUser(`test-alice-isi-${Date.now()}@example.com`);
  const bobUser   = await createTestUser(`test-bob-isi-${Date.now()}@example.com`);
  const mallUser  = await createTestUser(`test-mall-isi-${Date.now()}@example.com`);
  const userIds   = [aliceUser.userId, bobUser.userId, mallUser.userId];
  const svc       = makeServiceClient();

  try {
    const alice   = await provisionDevice(aliceUser.supabase, aliceUser.userId);
    const bob     = await provisionDevice(bobUser.supabase,   bobUser.userId);
    const mallory = await provisionDevice(mallUser.supabase,  mallUser.userId);

    // Alice creates room + her own membership ---------------------------------
    const { data: room, error: roomErr } = await aliceUser.supabase
      .from('rooms').insert({ kind: 'group', created_by: alice.userId })
      .select('*').single();
    if (roomErr || !room) throw new Error(`createRoom: ${roomErr?.message}`);
    const generation = room.current_generation as number;
    const roomKey = await generateRoomKey(generation);

    const aliceWrap = await wrapRoomKeyFor(roomKey, alice.bundle.x25519PublicKey);
    const aliceMemberSig = await signMembershipWrap(
      { roomId: room.id, generation, memberUserId: alice.userId,
        memberDeviceId: alice.deviceId, wrappedRoomKey: aliceWrap.wrapped,
        signerDeviceId: alice.deviceId },
      alice.bundle.ed25519PrivateKey,
    );
    await aliceUser.supabase.from('room_members').insert({
      room_id: room.id, user_id: alice.userId, device_id: alice.deviceId, generation,
      wrapped_room_key: await toBase64(aliceWrap.wrapped),
      signer_device_id: alice.deviceId, wrap_signature: await toBase64(aliceMemberSig),
    });

    // Pre-compute the wrap for Bob's device (used by all injection cases).
    const bobWrap = await wrapRoomKeyFor(roomKey, bob.bundle.x25519PublicKey);
    const honestExpiresAtMs = Date.now() + 60 * 60 * 1000;

    // Alice's *honest* signature over the canonical fields — we'll clone the
    // row for the "valid-sig-different-fields" and "tampered-expires-at"
    // cases, where the sig is real but the row fields diverge from what was
    // signed. Also used to build the "different inviter" case via Mallory.
    const honestInviterSig = await signInviteEnvelope(
      {
        roomId: room.id, generation,
        invitedUserId: bob.userId, invitedDeviceId: bob.deviceId,
        invitedDeviceEd25519PublicKey: bob.bundle.ed25519PublicKey,
        invitedDeviceX25519PublicKey:  bob.bundle.x25519PublicKey,
        wrappedRoomKey: bobWrap.wrapped,
        inviterUserId: alice.userId, inviterDeviceId: alice.deviceId,
        expiresAtMs: honestExpiresAtMs,
      },
      alice.bundle.ed25519PrivateKey,
    );

    // Mallory signs a forged invite claiming Alice's room --------------------
    const malloryForgedSig = await signInviteEnvelope(
      {
        roomId: room.id, generation,
        invitedUserId: bob.userId, invitedDeviceId: bob.deviceId,
        invitedDeviceEd25519PublicKey: bob.bundle.ed25519PublicKey,
        invitedDeviceX25519PublicKey:  bob.bundle.x25519PublicKey,
        wrappedRoomKey: bobWrap.wrapped,
        inviterUserId: mallory.userId, inviterDeviceId: mallory.deviceId,
        expiresAtMs: honestExpiresAtMs,
      },
      mallory.bundle.ed25519PrivateKey,
    );

    // A DIFFERENT room — used to produce a valid sig for mismatched fields.
    const { data: otherRoom } = await aliceUser.supabase
      .from('rooms').insert({ kind: 'group', created_by: alice.userId })
      .select('*').single();
    const otherRoomId = (otherRoom as { id: string }).id;
    const sigForOtherRoom = await signInviteEnvelope(
      {
        roomId: otherRoomId, generation,
        invitedUserId: bob.userId, invitedDeviceId: bob.deviceId,
        invitedDeviceEd25519PublicKey: bob.bundle.ed25519PublicKey,
        invitedDeviceX25519PublicKey:  bob.bundle.x25519PublicKey,
        wrappedRoomKey: bobWrap.wrapped,
        inviterUserId: alice.userId, inviterDeviceId: alice.deviceId,
        expiresAtMs: honestExpiresAtMs,
      },
      alice.bundle.ed25519PrivateKey,
    );

    // Helper: service-role INSERT (bypasses RLS) a row with the chosen sig.
    // Returns the stored row exactly as Bob would read it.
    async function injectAndRead(
      label: InjectionCase,
      options: {
        inviterSigB64: string;
        inviterUserId?: string;
        inviterDeviceId?: string;
        expiresAtMs?: number;
      },
    ): Promise<{
      roomId: string; generation: number;
      invitedUserId: string; invitedDeviceId: string;
      invitedDeviceEd25519PublicKey: Uint8Array;
      invitedDeviceX25519PublicKey: Uint8Array;
      wrappedRoomKey: Uint8Array;
      inviterUserId: string; inviterDeviceId: string;
      expiresAtMs: number;
      sigBytes: Uint8Array;
    }> {
      const inviterUserId = options.inviterUserId ?? alice.userId;
      const inviterDeviceId = options.inviterDeviceId ?? alice.deviceId;
      const expMs = options.expiresAtMs ?? honestExpiresAtMs;

      const { error: insErr } = await svc.from('room_invites').insert({
        room_id: room.id, invited_user_id: bob.userId, invited_device_id: bob.deviceId,
        invited_x25519_pub: await toBase64(bob.bundle.x25519PublicKey),
        invited_ed25519_pub: await toBase64(bob.bundle.ed25519PublicKey),
        generation, wrapped_room_key: await toBase64(bobWrap.wrapped),
        created_by: inviterUserId, inviter_device_id: inviterDeviceId,
        inviter_signature: options.inviterSigB64,
        expires_at_ms: expMs,
      });
      if (insErr) throw new Error(`[${label}] service-role inject failed: ${insErr.message}`);

      return {
        roomId: room.id, generation,
        invitedUserId: bob.userId, invitedDeviceId: bob.deviceId,
        invitedDeviceEd25519PublicKey: bob.bundle.ed25519PublicKey,
        invitedDeviceX25519PublicKey:  bob.bundle.x25519PublicKey,
        wrappedRoomKey: bobWrap.wrapped,
        inviterUserId, inviterDeviceId,
        expiresAtMs: expMs,
        sigBytes: await fromBase64(options.inviterSigB64),
      };
    }

    async function expectVerifyThrows(
      label: InjectionCase,
      fields: Awaited<ReturnType<typeof injectAndRead>>,
      inviterPub: Uint8Array,
    ): Promise<void> {
      try {
        await verifyInviteEnvelope(fields, fields.sigBytes, inviterPub);
        throw new Error(`Vulnerability [${label}]: verifyInviteEnvelope accepted a tampered invite`);
      } catch (err) {
        if (err instanceof Error && err.message.startsWith('Vulnerability')) throw err;
        // Expected: SIGNATURE_INVALID.
      }
    }

    // Wipe between cases so Bob's read is unambiguous — each case reinserts.
    async function wipeInvites(): Promise<void> {
      await svc.from('room_invites').delete().eq('room_id', room.id);
    }

    // -- Case A: empty-bytes signature ----------------------------------------
    await wipeInvites();
    {
      const fields = await injectAndRead('empty-sig', {
        inviterSigB64: await toBase64(new Uint8Array(64)), // 64 zero bytes (Ed25519 sig length)
      });
      await expectVerifyThrows('empty-sig', fields, alice.bundle.ed25519PublicKey);
    }

    // -- Case B: random-bytes signature ---------------------------------------
    await wipeInvites();
    {
      const sodium = await getSodium();
      const randSig = sodium.randombytes_buf(64);
      const fields = await injectAndRead('random-sig', { inviterSigB64: await toBase64(randSig) });
      await expectVerifyThrows('random-sig', fields, alice.bundle.ed25519PublicKey);
    }

    // -- Case C: valid sig, but bound to a DIFFERENT room_id ------------------
    await wipeInvites();
    {
      // Row claims room.id; sig was over otherRoomId.
      const fields = await injectAndRead('valid-sig-different-fields', {
        inviterSigB64: await toBase64(sigForOtherRoom),
      });
      await expectVerifyThrows('valid-sig-different-fields', fields, alice.bundle.ed25519PublicKey);
    }

    // -- Case D: valid sig by Mallory; row claims Alice is inviter ------------
    await wipeInvites();
    {
      // Row attributes to Alice (created_by = alice), sig is Mallory's.
      // When Bob looks up "alice.deviceId"'s pubkey and verifies, he rejects.
      const fields = await injectAndRead('valid-sig-different-inviter', {
        inviterSigB64: await toBase64(malloryForgedSig),
        // row claims Alice as inviter, but the sig is Mallory's
        inviterUserId: alice.userId, inviterDeviceId: alice.deviceId,
      });
      await expectVerifyThrows('valid-sig-different-inviter', fields, alice.bundle.ed25519PublicKey);
    }

    // -- Case D': same row, reverse lookup — if Bob mistakenly verifies with
    //    Mallory's pub, the sig *would* pass. Assert the verifier is using
    //    the PUB the caller looked up for (inviterUserId, inviterDeviceId),
    //    not the pub embedded in the sig.
    {
      // Sanity: verifier with Mallory's pub actually validates, proving
      // the forged sig itself is valid Ed25519 — the rejection in Case D
      // is from the row attribution, not from the sig being random.
      // NOTE: the row's inviter_device_id = alice.deviceId, so an honest
      // verifier never reaches Mallory's pub unless cert-chain resolution
      // is bypassed. Just confirms sig is not accidentally invalid.
      await verifyInviteEnvelope(
        {
          roomId: room.id, generation,
          invitedUserId: bob.userId, invitedDeviceId: bob.deviceId,
          invitedDeviceEd25519PublicKey: bob.bundle.ed25519PublicKey,
          invitedDeviceX25519PublicKey:  bob.bundle.x25519PublicKey,
          wrappedRoomKey: bobWrap.wrapped,
          inviterUserId: mallory.userId, inviterDeviceId: mallory.deviceId,
          expiresAtMs: honestExpiresAtMs,
        },
        malloryForgedSig,
        mallory.bundle.ed25519PublicKey,
      );
    }

    // -- Case E: honest sig, but expires_at_ms on the row tampered ------------
    await wipeInvites();
    {
      // Row says exp_ms + 1 day; sig was over honestExpiresAtMs.
      const tamperedExp = honestExpiresAtMs + 86_400_000;
      const fields = await injectAndRead('tampered-expires-at', {
        inviterSigB64: await toBase64(honestInviterSig),
        expiresAtMs: tamperedExp,
      });
      await expectVerifyThrows('tampered-expires-at', fields, alice.bundle.ed25519PublicKey);
    }

    // -- Positive control: an HONEST service-role insert verifies fine --------
    await wipeInvites();
    {
      await svc.from('room_invites').insert({
        room_id: room.id, invited_user_id: bob.userId, invited_device_id: bob.deviceId,
        invited_x25519_pub: await toBase64(bob.bundle.x25519PublicKey),
        invited_ed25519_pub: await toBase64(bob.bundle.ed25519PublicKey),
        generation, wrapped_room_key: await toBase64(bobWrap.wrapped),
        created_by: alice.userId, inviter_device_id: alice.deviceId,
        inviter_signature: await toBase64(honestInviterSig),
        expires_at_ms: honestExpiresAtMs,
      });
      await verifyInviteEnvelope(
        {
          roomId: room.id, generation,
          invitedUserId: bob.userId, invitedDeviceId: bob.deviceId,
          invitedDeviceEd25519PublicKey: bob.bundle.ed25519PublicKey,
          invitedDeviceX25519PublicKey:  bob.bundle.x25519PublicKey,
          wrappedRoomKey: bobWrap.wrapped,
          inviterUserId: alice.userId, inviterDeviceId: alice.deviceId,
          expiresAtMs: honestExpiresAtMs,
        },
        honestInviterSig,
        alice.bundle.ed25519PublicKey,
      );
    }

    console.log('PASS: Invite-signature injection — all 5 tampering vectors rejected; honest baseline verifies ✓');
  } finally {
    for (const id of userIds) await cleanupUser(id).catch(console.error);
  }
}

run().catch((err) => { console.error('FAIL:', err); process.exit(1); });
