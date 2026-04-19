/**
 * Test 32: Full Invite-Accept Flow
 *
 * Alice creates a room, inserts her own membership, then invites Bob via a
 * room_invites row (signed invite envelope). Bob reads the invite, verifies
 * the signature, unwraps the room key, inserts his own room_members row
 * (accepted via the invite arm of the RLS policy), then decrypts a message
 * Alice sent after the invite was accepted.
 *
 * Asserts:
 *   - Bob can read his pending invite
 *   - Invite envelope signature verifies against Alice's device pub
 *   - Bob can insert room_members row using the invite arm (expires_at_ms null)
 *   - Bob decrypts Alice's message correctly
 *   - Carol (uninvited) cannot insert using the same invite
 *
 * Run: npx tsx --env-file=.env.local scripts/test-invite-accept-flow.ts
 */

import {
  generateRoomKey,
  wrapRoomKeyFor,
  unwrapRoomKey,
  signMembershipWrap,
  signInviteEnvelope,
  verifyInviteEnvelope,
  encryptBlob,
  decryptBlob,
  fromBase64,
  toBase64,
  type EncryptedBlob,
} from '../src/lib/e2ee-core';
import { initCrypto, createTestUser, provisionDevice, cleanupUser, makeServiceClient } from './test-utils';

async function run() {
  await initCrypto();

  const aliceUser = await createTestUser(`test-alice-iaf-${Date.now()}@example.com`);
  const bobUser   = await createTestUser(`test-bob-iaf-${Date.now()}@example.com`);
  const carolUser = await createTestUser(`test-carol-iaf-${Date.now()}@example.com`);
  const userIds   = [aliceUser.userId, bobUser.userId, carolUser.userId];
  const svc       = makeServiceClient();

  try {
    const alice = await provisionDevice(aliceUser.supabase, aliceUser.userId);
    const bob   = await provisionDevice(bobUser.supabase,   bobUser.userId);
    const carol = await provisionDevice(carolUser.supabase, carolUser.userId);

    // -- Alice creates room + her own membership ------------------------------
    const { data: room, error: roomErr } = await aliceUser.supabase
      .from('rooms').insert({ kind: 'group', created_by: alice.userId })
      .select('*').single();
    if (roomErr || !room) throw new Error(`createRoom: ${roomErr?.message}`);
    const generation = room.current_generation as number;
    const roomKey = await generateRoomKey(generation);

    const aliceWrap = await wrapRoomKeyFor(roomKey, alice.bundle.x25519PublicKey);
    const aliceSig  = await signMembershipWrap(
      { roomId: room.id, generation, memberUserId: alice.userId,
        memberDeviceId: alice.deviceId, wrappedRoomKey: aliceWrap.wrapped,
        signerDeviceId: alice.deviceId },
      alice.bundle.ed25519PrivateKey,
    );
    await aliceUser.supabase.from('room_members').insert({
      room_id: room.id, user_id: alice.userId, device_id: alice.deviceId, generation,
      wrapped_room_key: await toBase64(aliceWrap.wrapped),
      signer_device_id: alice.deviceId, wrap_signature: await toBase64(aliceSig),
    });

    // -- Alice creates a signed invite for Bob's device -----------------------
    const bobWrap   = await wrapRoomKeyFor(roomKey, bob.bundle.x25519PublicKey);
    const expiresAtMs = Date.now() + 60 * 60 * 1000; // 1 hour from now
    const inviteSig = await signInviteEnvelope(
      {
        roomId: room.id, generation,
        invitedUserId: bob.userId, invitedDeviceId: bob.deviceId,
        invitedDeviceEd25519PublicKey: bob.bundle.ed25519PublicKey,
        invitedDeviceX25519PublicKey:  bob.bundle.x25519PublicKey,
        wrappedRoomKey: bobWrap.wrapped,
        inviterUserId: alice.userId, inviterDeviceId: alice.deviceId,
        expiresAtMs,
      },
      alice.bundle.ed25519PrivateKey,
    );

    // Alice inserts the invite row
    const { data: inviteRow, error: inviteErr } = await aliceUser.supabase
      .from('room_invites').insert({
        room_id: room.id, invited_user_id: bob.userId, invited_device_id: bob.deviceId,
        invited_x25519_pub: await toBase64(bob.bundle.x25519PublicKey),
        invited_ed25519_pub: await toBase64(bob.bundle.ed25519PublicKey),
        generation, wrapped_room_key: await toBase64(bobWrap.wrapped),
        created_by: alice.userId, inviter_device_id: alice.deviceId,
        inviter_signature: await toBase64(inviteSig),
        expires_at_ms: expiresAtMs,
      }).select('*').single();
    if (inviteErr || !inviteRow) throw new Error(`insertInvite: ${inviteErr?.message}`);

    // -- Bob reads his invite and verifies the envelope -----------------------
    const { data: bobInvites } = await bobUser.supabase
      .from('room_invites').select('*')
      .eq('room_id', room.id).eq('invited_device_id', bob.deviceId);
    if (!bobInvites || bobInvites.length === 0) throw new Error('Bob cannot read his invite');

    const inv = bobInvites[0] as {
      wrapped_room_key: string; inviter_signature: string;
      expires_at_ms: number; inviter_device_id: string;
    };
    await verifyInviteEnvelope(
      {
        roomId: room.id, generation,
        invitedUserId: bob.userId, invitedDeviceId: bob.deviceId,
        invitedDeviceEd25519PublicKey: bob.bundle.ed25519PublicKey,
        invitedDeviceX25519PublicKey:  bob.bundle.x25519PublicKey,
        wrappedRoomKey: await fromBase64(inv.wrapped_room_key),
        inviterUserId: alice.userId, inviterDeviceId: inv.inviter_device_id,
        expiresAtMs: inv.expires_at_ms,
      },
      await fromBase64(inv.inviter_signature),
      alice.bundle.ed25519PublicKey,
    );

    // -- Bob unwraps the room key and inserts his room_members row ------------
    const bobRoomKey = await unwrapRoomKey(
      { wrapped: await fromBase64(inv.wrapped_room_key), generation },
      bob.bundle.x25519PublicKey, bob.bundle.x25519PrivateKey,
    );
    const memberSig = await signMembershipWrap(
      { roomId: room.id, generation, memberUserId: bob.userId,
        memberDeviceId: bob.deviceId, wrappedRoomKey: await fromBase64(inv.wrapped_room_key),
        signerDeviceId: alice.deviceId },
      alice.bundle.ed25519PrivateKey,
    );
    const { error: memberErr } = await bobUser.supabase.from('room_members').insert({
      room_id: room.id, user_id: bob.userId, device_id: bob.deviceId, generation,
      wrapped_room_key: inv.wrapped_room_key,
      signer_device_id: alice.deviceId, wrap_signature: await toBase64(memberSig),
    });
    if (memberErr) throw new Error(`Bob accept invite: ${memberErr.message}`);

    // -- Alice sends a message after Bob accepted -----------------------------
    const encBlob = await encryptBlob<{ text: string }>({
      payload: { text: 'Welcome Bob!' }, roomId: room.id, roomKey,
      senderUserId: alice.userId, senderDeviceId: alice.deviceId,
      senderDeviceEd25519PrivateKey: alice.bundle.ed25519PrivateKey,
    });
    const { data: blobRow } = await aliceUser.supabase.from('blobs').insert({
      room_id: room.id, sender_id: alice.userId, sender_device_id: alice.deviceId,
      generation: encBlob.generation, nonce: await toBase64(encBlob.nonce),
      ciphertext: await toBase64(encBlob.ciphertext),
      signature: encBlob.signature.byteLength > 0 ? await toBase64(encBlob.signature) : null,
      session_id: null, message_index: null,
    }).select('*').single();

    // -- Bob decrypts with his unwrapped key ----------------------------------
    const row = blobRow as {
      nonce: string; ciphertext: string; signature: string | null;
      generation: number; session_id: string | null; message_index: number | null;
    };
    const wireBlob: EncryptedBlob = {
      nonce: await fromBase64(row.nonce), ciphertext: await fromBase64(row.ciphertext),
      signature: row.signature ? await fromBase64(row.signature) : new Uint8Array(0),
      generation: row.generation, sessionId: null, messageIndex: null,
    };
    const { payload } = await decryptBlob<{ text: string }>({
      blob: wireBlob, roomId: room.id, roomKey: bobRoomKey,
      resolveSenderDeviceEd25519Pub: async () => alice.bundle.ed25519PublicKey,
    });
    if (payload.text !== 'Welcome Bob!') throw new Error(`Plaintext mismatch: "${payload.text}"`);

    // -- Carol cannot insert using Bob's invite (wrong device_id in RLS check) -
    const carolMemberSig = await signMembershipWrap(
      { roomId: room.id, generation, memberUserId: carol.userId,
        memberDeviceId: carol.deviceId, wrappedRoomKey: await fromBase64(inv.wrapped_room_key),
        signerDeviceId: alice.deviceId },
      alice.bundle.ed25519PrivateKey,
    );
    const { error: carolErr } = await carolUser.supabase.from('room_members').insert({
      room_id: room.id, user_id: carol.userId, device_id: carol.deviceId, generation,
      wrapped_room_key: inv.wrapped_room_key,
      signer_device_id: alice.deviceId, wrap_signature: await toBase64(carolMemberSig),
    });
    if (!carolErr) throw new Error('Vulnerability: Carol accepted Bob\'s invite — device_id binding not enforced');

    console.log('PASS: Full invite-accept flow — Bob verified invite, accepted, decrypted; Carol blocked ✓');
  } finally {
    for (const id of userIds) await cleanupUser(id).catch(console.error);
  }
}

run().catch((err) => { console.error('FAIL:', err); process.exit(1); });
