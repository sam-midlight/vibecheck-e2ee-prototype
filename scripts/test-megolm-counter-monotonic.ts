/**
 * Test: Megolm message_count monotonicity guard (migration 0042).
 *
 * Verifies that the BEFORE UPDATE trigger on megolm_sessions rejects
 * counter-stomp UPDATEs that keep the same session_id, while still allowing:
 *   (a) the AFTER INSERT trigger on blobs to increment the counter, and
 *   (b) legitimate session rotation (new session_id + message_count: 0 via
 *       the insertMegolmSession upsert path).
 *
 * The bypass this test closes: a patched client that UPDATEs its own row
 * back to message_count=0 to evade the 200-cap trigger from migration 0029.
 *
 * Run: npx tsx --env-file=.env.local scripts/test-megolm-counter-monotonic.ts
 */

import {
  generateRoomKey,
  wrapRoomKeyFor,
  signMembershipWrap,
  createOutboundSession,
  ratchetAndDerive,
  encryptBlobV4,
  toBase64,
  type RoomKey,
} from '../src/lib/e2ee-core';
import {
  initCrypto,
  createTestUser,
  provisionDevice,
  cleanupUser,
} from './test-utils';

async function run() {
  await initCrypto();

  const alice = await createTestUser(`test-megolm-mono-${Date.now()}@example.com`);
  const userIds = [alice.userId];

  try {
    const device = await provisionDevice(alice.supabase, alice.userId);

    // -- Room + self-membership ------------------------------------------------
    const { data: room, error: roomErr } = await alice.supabase
      .from('rooms').insert({ kind: 'group', created_by: device.userId })
      .select('*').single();
    if (roomErr || !room) throw new Error(`createRoom: ${roomErr?.message}`);
    const generation = room.current_generation as number;
    const roomKey: RoomKey = await generateRoomKey(generation);

    const wrap = await wrapRoomKeyFor(roomKey, device.bundle.x25519PublicKey);
    const wrapSig = await signMembershipWrap(
      {
        roomId: room.id,
        generation,
        memberUserId: device.userId,
        memberDeviceId: device.deviceId,
        wrappedRoomKey: wrap.wrapped,
        signerDeviceId: device.deviceId,
      },
      device.bundle.ed25519PrivateKey,
    );
    const { error: memErr } = await alice.supabase.from('room_members').insert({
      room_id: room.id,
      user_id: device.userId,
      device_id: device.deviceId,
      generation,
      wrapped_room_key: await toBase64(wrap.wrapped),
      signer_device_id: device.deviceId,
      wrap_signature: await toBase64(wrapSig),
    });
    if (memErr) throw new Error(`room_members insert: ${memErr.message}`);

    // -- Create an outbound session and seed message_count by sending a blob --
    const session = await createOutboundSession(room.id, generation);
    const sessionIdB64 = await toBase64(session.sessionId);

    const { error: sessErr } = await alice.supabase.from('megolm_sessions').insert({
      room_id: room.id,
      sender_user_id: device.userId,
      sender_device_id: device.deviceId,
      session_id: sessionIdB64,
      generation,
      message_count: 0,
    });
    if (sessErr) throw new Error(`megolm_sessions insert: ${sessErr.message}`);

    // Send a blob to fire the AFTER-INSERT increment trigger (0029).
    const msgKey = await ratchetAndDerive(session);
    const blob = await encryptBlobV4<{ text: string }>({
      payload: { text: 'first' },
      roomId: room.id,
      messageKey: msgKey,
      sessionId: session.sessionId,
      generation,
      senderUserId: device.userId,
      senderDeviceId: device.deviceId,
      senderDeviceEd25519PrivateKey: device.bundle.ed25519PrivateKey,
    });
    const { error: blobErr } = await alice.supabase.from('blobs').insert({
      room_id: room.id,
      sender_id: device.userId,
      sender_device_id: device.deviceId,
      generation: blob.generation,
      nonce: await toBase64(blob.nonce),
      ciphertext: await toBase64(blob.ciphertext),
      signature: null,
      session_id: blob.sessionId,
      message_index: blob.messageIndex,
    });
    if (blobErr) throw new Error(`blobs insert: ${blobErr.message}`);

    // Confirm the increment trigger ran: count is now 1.
    const { data: afterIncrement } = await alice.supabase
      .from('megolm_sessions').select('message_count')
      .eq('session_id', sessionIdB64).single();
    if (!afterIncrement || afterIncrement.message_count !== 1) {
      throw new Error(
        `AFTER-INSERT increment trigger did not fire: message_count=` +
        `${afterIncrement?.message_count ?? 'null'} (expected 1)`,
      );
    }

    // -- Assertion 1: counter-stomp with SAME session_id must be rejected ------
    const { error: stompErr } = await alice.supabase
      .from('megolm_sessions')
      .update({ message_count: 0 })
      .eq('session_id', sessionIdB64);

    if (!stompErr) {
      throw new Error(
        'Vulnerability: UPDATE message_count=0 with unchanged session_id succeeded ' +
        '— the 0042 monotonicity guard did not fire.',
      );
    }
    // Postgres code '23514' = check_violation. Supabase/PostgREST surfaces this
    // as a PostgrestError; accept either the SQL code or the raised-text match.
    const errMsg = stompErr.message ?? '';
    const errCode = (stompErr as { code?: string }).code ?? '';
    if (errCode !== '23514' && !errMsg.includes('monotonic')) {
      throw new Error(
        `Stomp was rejected but with an unexpected error shape: code=${errCode} msg="${errMsg}"`,
      );
    }

    // Verify the row is unchanged.
    const { data: afterStomp } = await alice.supabase
      .from('megolm_sessions').select('message_count')
      .eq('session_id', sessionIdB64).single();
    if (!afterStomp || afterStomp.message_count !== 1) {
      throw new Error(
        `Row was mutated despite rejection: message_count=${afterStomp?.message_count ?? 'null'} ` +
        `(expected 1)`,
      );
    }

    // -- Assertion 2: legitimate rotation (new session_id + reset) is allowed --
    const newSession = await createOutboundSession(room.id, generation);
    const newSessionIdB64 = await toBase64(newSession.sessionId);

    const { error: rotateErr } = await alice.supabase
      .from('megolm_sessions')
      .upsert(
        {
          room_id: room.id,
          sender_user_id: device.userId,
          sender_device_id: device.deviceId,
          session_id: newSessionIdB64,
          generation,
          message_count: 0,
        },
        { onConflict: 'room_id,sender_device_id,generation' },
      );
    if (rotateErr) {
      throw new Error(
        `Legitimate rotation (new session_id, reset counter) was rejected: ${rotateErr.message}`,
      );
    }

    const { data: afterRotate } = await alice.supabase
      .from('megolm_sessions').select('session_id, message_count')
      .eq('room_id', room.id).eq('sender_device_id', device.deviceId).single();
    if (!afterRotate
        || afterRotate.session_id !== newSessionIdB64
        || afterRotate.message_count !== 0) {
      throw new Error(
        `Row did not reflect rotation: session_id=${afterRotate?.session_id} ` +
        `message_count=${afterRotate?.message_count}`,
      );
    }

    console.log(
      'PASS: 0042 monotonicity guard — counter-stomp rejected, rotation allowed, ' +
      'AFTER-INSERT increment still works ✓',
    );
  } finally {
    for (const id of userIds) await cleanupUser(id).catch(console.error);
  }
}

run().catch((err) => { console.error('FAIL:', err); process.exit(1); });
