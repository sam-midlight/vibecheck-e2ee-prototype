/**
 * Test: Call RPC ownership gate (migration 0041)
 *
 * Regression harness for the ghost call-member hole in start_call /
 * rotate_call_key. Before 0041, a current-gen room member acting as rotator
 * could include an attacker-controlled device (owned by a user who is NOT a
 * room member) in p_envelopes, seating them in call_members. Combined with
 * the livekit-token edge function's missing room-member check, this granted
 * the non-member a valid SFU JWT. Migration 0041 adds two per-envelope
 * checks: (a) device_id belongs to target_user_id and is not revoked;
 * (b) target_user_id is a current-generation member of the call's room.
 *
 * Setup: Alice creates a room. Only Alice is a member. Bob has a real
 * identity + device but is NOT in Alice's room.
 *
 * Cases (all from Alice's authenticated client):
 *   A. start_call envelope with target_user_id=bob + target_device_id=alice's
 *      device → ownership-check rejects (device not owned by stated user).
 *   B. start_call envelope with target_user_id=bob + target_device_id=bob's
 *      device → ownership passes, room-member check rejects (bob not a member).
 *   C. Legitimate start_call for Alice only succeeds (sanity — the gate
 *      doesn't false-positive on real envelopes).
 *   D. After C, Alice-as-rotator calls rotate_call_key to bump gen 1→2 with
 *      an envelope set [Alice, Bob]. Bob's entry trips the room-member check;
 *      transaction rolls back.
 *
 * Post-conditions (via service client, RLS-bypassing):
 *   - No call_members row exists for bob.userId.
 *   - calls.current_generation remains 1 (the rotation rolled back atomically).
 *
 * Run: npx tsx --env-file=.env.local scripts/test-call-rpc-ownership-gate.ts
 */

import {
  generateRoomKey,
  wrapRoomKeyFor,
  signMembershipWrap,
  generateCallKey,
  wrapAndSignCallEnvelope,
  toBase64,
  type CallKey,
  type Bytes,
} from '../src/lib/e2ee-core';
import {
  initCrypto,
  createTestUser,
  provisionDevice,
  cleanupUser,
  makeServiceClient,
  type TestDevice,
} from './test-utils';

async function run() {
  await initCrypto();

  const aliceUser = await createTestUser(`test-alice-crog-${Date.now()}@example.com`);
  const bobUser   = await createTestUser(`test-bob-crog-${Date.now()}@example.com`);
  const userIds   = [aliceUser.userId, bobUser.userId];
  const svc       = makeServiceClient();

  try {
    const alice = await provisionDevice(aliceUser.supabase, aliceUser.userId);
    const bob   = await provisionDevice(bobUser.supabase,   bobUser.userId);

    // -- Alice creates a room with ONLY herself as a member -------------------
    // Bob exists + has a published device but is not a room member.
    const { data: room, error: roomErr } = await aliceUser.supabase
      .from('rooms').insert({ kind: 'group', created_by: alice.userId })
      .select('*').single();
    if (roomErr || !room) throw new Error(`createRoom: ${roomErr?.message}`);

    const gen1 = room.current_generation as number;
    const key1 = await generateRoomKey(gen1);

    const aliceWrap = await wrapRoomKeyFor(key1, alice.bundle.x25519PublicKey);
    const aliceMemberSig = await signMembershipWrap(
      { roomId: room.id, generation: gen1, memberUserId: alice.userId,
        memberDeviceId: alice.deviceId, wrappedRoomKey: aliceWrap.wrapped,
        signerDeviceId: alice.deviceId },
      alice.bundle.ed25519PrivateKey,
    );
    const { error: memErr } = await aliceUser.supabase.from('room_members').insert({
      room_id: room.id, user_id: alice.userId, device_id: alice.deviceId, generation: gen1,
      wrapped_room_key: await toBase64(aliceWrap.wrapped),
      signer_device_id: alice.deviceId,
      wrap_signature: await toBase64(aliceMemberSig),
    });
    if (memErr) throw new Error(`alice membership: ${memErr.message}`);

    // Helper: build a realistic call envelope signed by Alice's device.
    // The RPC only requires non-null ciphertext/signature, but using real
    // crypto mirrors what the production client sends.
    const makeEnv = async (
      ck: CallKey,
      callId: string,
      targetDeviceId: string,
      targetX25519Pub: Bytes,
      signerDev: TestDevice = alice,
    ) => {
      const env = await wrapAndSignCallEnvelope({
        callKey: ck,
        callId,
        targetDeviceId,
        targetX25519PublicKey: targetX25519Pub,
        senderDeviceId: signerDev.deviceId,
        senderDeviceEd25519PrivateKey: signerDev.bundle.ed25519PrivateKey,
      });
      return {
        ciphertext: await toBase64(env.ciphertext),
        signature:  await toBase64(env.signature),
      };
    };

    // -- Case A: start_call ownership check -----------------------------------
    // target_device_id=alice, target_user_id=bob → device owner != stated user.
    {
      const callId = crypto.randomUUID();
      const ck = await generateCallKey(1);
      const env = await makeEnv(ck, callId, alice.deviceId, alice.bundle.x25519PublicKey);
      const { error } = await aliceUser.supabase.rpc('start_call', {
        p_call_id: callId,
        p_room_id: room.id,
        p_signer_device_id: alice.deviceId,
        p_envelopes: [{
          target_device_id: alice.deviceId,
          target_user_id:   bob.userId,           // ← mismatch
          ciphertext: env.ciphertext,
          signature:  env.signature,
        }],
      });
      if (!error) {
        throw new Error('Vulnerability (A): start_call accepted envelope where device does not belong to stated user');
      }
      if (!/does not belong to user|is revoked/i.test(error.message)) {
        throw new Error(`Case A rejected but not via ownership gate: ${error.message}`);
      }
      console.log(`  Case A: start_call device-ownership rejected (${error.code}) ✓`);
    }

    // -- Case B: start_call room-member check ---------------------------------
    // target_device_id=bob, target_user_id=bob. Device ownership passes. Bob
    // is not a current-gen member of room → must reject.
    {
      const callId = crypto.randomUUID();
      const ck = await generateCallKey(1);
      const env = await makeEnv(ck, callId, bob.deviceId, bob.bundle.x25519PublicKey);
      const { error } = await aliceUser.supabase.rpc('start_call', {
        p_call_id: callId,
        p_room_id: room.id,
        p_signer_device_id: alice.deviceId,
        p_envelopes: [{
          target_device_id: bob.deviceId,
          target_user_id:   bob.userId,
          ciphertext: env.ciphertext,
          signature:  env.signature,
        }],
      });
      if (!error) {
        throw new Error('Vulnerability (B): start_call seated a non-room-member in call_members');
      }
      if (!/not a current-gen member/i.test(error.message)) {
        throw new Error(`Case B rejected but not via room-member gate: ${error.message}`);
      }
      console.log(`  Case B: start_call non-member rejected (${error.code}) ✓`);
    }

    // -- Case C: legitimate start_call (sanity — gate must not false-positive)
    const callId = crypto.randomUUID();
    {
      const ck = await generateCallKey(1);
      const env = await makeEnv(ck, callId, alice.deviceId, alice.bundle.x25519PublicKey);
      const { error } = await aliceUser.supabase.rpc('start_call', {
        p_call_id: callId,
        p_room_id: room.id,
        p_signer_device_id: alice.deviceId,
        p_envelopes: [{
          target_device_id: alice.deviceId,
          target_user_id:   alice.userId,
          ciphertext: env.ciphertext,
          signature:  env.signature,
        }],
      });
      if (error) throw new Error(`Case C: legitimate start_call rejected: ${error.message}`);
      console.log('  Case C: legitimate start_call succeeded ✓');
    }

    // -- Case D: rotate_call_key room-member check ----------------------------
    // Alice (rotator) attempts to add Bob as a call participant via rotation.
    // Expect whole-transaction rollback: no generation bump, no ghost row.
    {
      const gen2 = 2;
      const ck2 = await generateCallKey(gen2);
      const aliceEnv2 = await makeEnv(ck2, callId, alice.deviceId, alice.bundle.x25519PublicKey);
      const bobEnv2   = await makeEnv(ck2, callId, bob.deviceId,   bob.bundle.x25519PublicKey);
      const { error } = await aliceUser.supabase.rpc('rotate_call_key', {
        p_call_id: callId,
        p_signer_device_id: alice.deviceId,
        p_old_gen: 1,
        p_new_gen: gen2,
        p_envelopes: [
          { target_device_id: alice.deviceId, target_user_id: alice.userId,
            ciphertext: aliceEnv2.ciphertext, signature: aliceEnv2.signature },
          { target_device_id: bob.deviceId,   target_user_id: bob.userId,   // ← non-member
            ciphertext: bobEnv2.ciphertext, signature: bobEnv2.signature },
        ],
      });
      if (!error) {
        throw new Error('Vulnerability (D): rotate_call_key seated a non-room-member');
      }
      if (!/not a current-gen member/i.test(error.message)) {
        throw new Error(`Case D rejected but not via room-member gate: ${error.message}`);
      }
      console.log(`  Case D: rotate_call_key non-member rejected (${error.code}) ✓`);
    }

    // -- Post-conditions ------------------------------------------------------
    // 1. No call_members row exists for Bob anywhere (RLS-bypass scan).
    const { data: ghosts, error: ghostErr } = await svc
      .from('call_members')
      .select('call_id, device_id, user_id')
      .eq('user_id', bob.userId);
    if (ghostErr) throw new Error(`ghost scan: ${ghostErr.message}`);
    if ((ghosts ?? []).length > 0) {
      throw new Error(
        `Vulnerability: ${ghosts!.length} ghost call_members row(s) persisted for Bob: ${JSON.stringify(ghosts)}`,
      );
    }

    // 2. Call generation did not bump (the rejected rotation rolled back).
    const { data: callRow, error: callErr } = await svc
      .from('calls')
      .select('current_generation')
      .eq('id', callId)
      .single();
    if (callErr) throw new Error(`calls read: ${callErr.message}`);
    const currentGen = (callRow as { current_generation: number }).current_generation;
    if (currentGen !== 1) {
      throw new Error(`Call generation bumped despite rejected rotation: expected 1, got ${currentGen}`);
    }

    console.log('PASS: 0041 ownership + room-member gates enforced across start_call + rotate_call_key; no ghost rows; generation unchanged ✓');
  } finally {
    for (const id of userIds) await cleanupUser(id).catch(console.error);
  }
}

run().catch((err) => { console.error('FAIL:', err); process.exit(1); });
