/**
 * Test 8: Offline / Stale Key Forward (Race Condition)
 *
 * Alice sends a v4 (Megolm) message but does NOT share the session with Bob
 * upfront — simulating the case where Bob's device was offline when the
 * session was created, or came online after the message was sent.
 *
 * Bob detects the missing key, posts a key_forward_request to Supabase.
 * Alice's device (simulated here via the service client, standing in for the
 * realtime notification handler) reads the request, seals the snapshot for
 * Bob's X25519 pub, and uploads a megolm_session_share.
 *
 * Bob fetches the share, unseals it, verifies the signature, and decrypts
 * the original message.
 *
 * Asserts: the dynamically forwarded key allows Bob to decrypt the message
 * with the correct plaintext.
 *
 * Run: npx tsx --env-file=.env.local scripts/test-stale-key-forward.ts
 */

import {
  generateRoomKey,
  wrapRoomKeyFor,
  signMembershipWrap,
  createOutboundSession,
  ratchetAndDerive,
  exportSessionSnapshot,
  sealSessionSnapshot,
  signSessionShare,
  verifySessionShare,
  unsealSessionSnapshot,
  deriveMessageKeyAtIndex,
  encryptBlobV4,
  decryptBlob,
  fromBase64,
  toBase64,
  type EncryptedBlob,
  type RoomKey,
} from '../src/lib/e2ee-core';
import { initCrypto, createTestUser, provisionDevice, cleanupUser, makeServiceClient } from './test-utils';

async function run() {
  await initCrypto();

  const aliceUser = await createTestUser(`test-alice-kf-${Date.now()}@example.com`);
  const bobUser   = await createTestUser(`test-bob-kf-${Date.now()}@example.com`);
  const userIds   = [aliceUser.userId, bobUser.userId];
  const svc       = makeServiceClient();

  try {
    const alice = await provisionDevice(aliceUser.supabase, aliceUser.userId);
    const bob   = await provisionDevice(bobUser.supabase,   bobUser.userId);

    // -- Room + gen-1 membership ---------------------------------------------
    const { data: room, error: roomErr } = await aliceUser.supabase
      .from('rooms')
      .insert({ kind: 'group', created_by: alice.userId })
      .select('*').single();
    if (roomErr || !room) throw new Error(`createRoom: ${roomErr?.message}`);
    const generation = room.current_generation as number;
    const roomKey: RoomKey = await generateRoomKey(generation);

    async function addMember(userId: string, deviceId: string, xPub: Uint8Array) {
      const wrap = await wrapRoomKeyFor(roomKey, xPub);
      const sig  = await signMembershipWrap(
        { roomId: room.id, generation, memberUserId: userId, memberDeviceId: deviceId,
          wrappedRoomKey: wrap.wrapped, signerDeviceId: alice.deviceId },
        alice.bundle.ed25519PrivateKey,
      );
      const client = userId === alice.userId ? aliceUser.supabase : svc;
      await client.from('room_members').insert({
        room_id: room.id, user_id: userId, device_id: deviceId, generation,
        wrapped_room_key: await toBase64(wrap.wrapped),
        signer_device_id: alice.deviceId, wrap_signature: await toBase64(sig),
      });
    }
    await addMember(alice.userId, alice.deviceId, alice.bundle.x25519PublicKey);
    await addMember(bob.userId,   bob.deviceId,   bob.bundle.x25519PublicKey);

    // -- Alice creates Megolm session and sends a message --------------------
    // Deliberately does NOT share the session with Bob yet.
    const outbound     = await createOutboundSession(room.id, generation);
    const sessionIdB64 = await toBase64(outbound.sessionId);

    // Capture snapshot before ratcheting so it covers message index 0
    const aliceSnapshot = exportSessionSnapshot(outbound, alice.userId, alice.deviceId);
    const messageKey    = await ratchetAndDerive(outbound); // index 0

    const encBlob = await encryptBlobV4<{ text: string }>({
      payload: { text: 'Offline message' },
      roomId: room.id, messageKey,
      sessionId: outbound.sessionId, generation,
      senderUserId: alice.userId, senderDeviceId: alice.deviceId,
      senderDeviceEd25519PrivateKey: alice.bundle.ed25519PrivateKey,
    });

    await svc.from('megolm_sessions').upsert({
      session_id: sessionIdB64, room_id: room.id,
      sender_user_id: alice.userId, sender_device_id: alice.deviceId,
      generation, message_count: 1,
    });

    const { data: blobRow, error: blobErr } = await aliceUser.supabase.from('blobs').insert({
      room_id: room.id, sender_id: alice.userId, sender_device_id: alice.deviceId,
      generation: encBlob.generation, nonce: await toBase64(encBlob.nonce),
      ciphertext: await toBase64(encBlob.ciphertext), signature: null,
      session_id: encBlob.sessionId ?? null, message_index: encBlob.messageIndex ?? null,
    }).select('*').single();
    if (blobErr || !blobRow) throw new Error(`insertBlob: ${blobErr?.message}`);

    // -- Bob: no session share exists yet ------------------------------------
    const { data: earlyShare } = await bobUser.supabase
      .from('megolm_session_shares')
      .select('session_id')
      .eq('session_id', sessionIdB64)
      .eq('recipient_device_id', bob.deviceId)
      .maybeSingle();
    if (earlyShare !== null) throw new Error('Expected no share yet — test setup error');

    // -- Bob: post a key forward request -------------------------------------
    // RLS requires user_id = auth.uid(), so Bob posts under his own userId.
    const { error: kfrErr } = await bobUser.supabase.from('key_forward_requests').insert({
      user_id: bob.userId,
      requester_device_id: bob.deviceId,
      session_id: sessionIdB64,
      room_id: room.id,
    });
    if (kfrErr) throw new Error(`insertKeyForwardRequest: ${kfrErr.message}`);

    // -- Alice: reads the pending request (service client bridges cross-user gap) --
    // In production this arrives via realtime subscription on Alice's device;
    // the service client here simulates that notification handler.
    const { data: requests, error: reqErr } = await svc
      .from('key_forward_requests')
      .select('*')
      .eq('session_id', sessionIdB64)
      .eq('requester_device_id', bob.deviceId);
    if (reqErr) throw new Error(`listKeyForwardRequests: ${reqErr.message}`);
    if (!requests || requests.length === 0) throw new Error('Alice found no key forward request');

    const request = requests[0] as { id: string; requester_device_id: string };

    // -- Alice: seals snapshot for Bob and uploads the session share ----------
    const sealedSnapshot = await sealSessionSnapshot(aliceSnapshot, bob.bundle.x25519PublicKey);
    const shareSignature = await signSessionShare({
      sessionId: outbound.sessionId, recipientDeviceId: bob.deviceId,
      sealedSnapshot, signerDeviceId: alice.deviceId,
      signerEd25519Priv: alice.bundle.ed25519PrivateKey,
    });
    await svc.from('megolm_session_shares').insert({
      session_id: sessionIdB64,
      recipient_device_id: bob.deviceId,
      sealed_snapshot: await toBase64(sealedSnapshot),
      start_index: aliceSnapshot.startIndex,
      signer_device_id: alice.deviceId,
      share_signature: await toBase64(shareSignature),
    });

    // -- Bob: fetches, verifies, and unseals the forwarded share -------------
    const { data: shareRow, error: shareErr } = await bobUser.supabase
      .from('megolm_session_shares')
      .select('*')
      .eq('session_id', sessionIdB64)
      .eq('recipient_device_id', bob.deviceId)
      .single();
    if (shareErr || !shareRow) throw new Error(`fetchShare: ${shareErr?.message}`);

    const sr = shareRow as {
      sealed_snapshot: string; start_index: number;
      signer_device_id: string; share_signature: string;
    };

    await verifySessionShare({
      sessionId: outbound.sessionId,
      recipientDeviceId: bob.deviceId,
      sealedSnapshot: await fromBase64(sr.sealed_snapshot),
      signerDeviceId: sr.signer_device_id,
      signature: await fromBase64(sr.share_signature),
      signerEd25519Pub: alice.bundle.ed25519PublicKey,
    });

    const bobSnapshot = await unsealSessionSnapshot(
      await fromBase64(sr.sealed_snapshot),
      bob.bundle.x25519PublicKey, bob.bundle.x25519PrivateKey,
    );

    // -- Bob: decrypts the original message with the forwarded key -----------
    const row = blobRow as {
      nonce: string; ciphertext: string; signature: string | null;
      generation: number; session_id: string | null; message_index: number | null;
    };
    const mk = await deriveMessageKeyAtIndex(bobSnapshot, row.message_index!);

    const wireBlob: EncryptedBlob = {
      nonce: await fromBase64(row.nonce),
      ciphertext: await fromBase64(row.ciphertext),
      signature: new Uint8Array(0),
      generation: row.generation,
      sessionId: row.session_id, messageIndex: row.message_index,
    };
    const { payload } = await decryptBlob<{ text: string }>({
      blob: wireBlob, roomId: room.id, roomKey,
      resolveSenderDeviceEd25519Pub: async () => alice.bundle.ed25519PublicKey,
      resolveMegolmKey: async (_sid, _idx) => mk.key,
    });
    if (payload.text !== 'Offline message') {
      throw new Error(`Plaintext mismatch: "${payload.text}"`);
    }

    // -- Cleanup: delete the fulfilled key forward request ------------------
    await svc.from('key_forward_requests').delete().eq('id', request.id);

    console.log('PASS: Stale key forward — Bob decrypted "Offline message" via forwarded session ✓');
  } finally {
    for (const id of userIds) await cleanupUser(id).catch(console.error);
  }
}

run().catch((err) => { console.error('FAIL:', err); process.exit(1); });
