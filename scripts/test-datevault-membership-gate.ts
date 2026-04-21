/**
 * Test: DateVault membership gate (and intra-room sub-scoping is UX-only)
 *
 * Splits a real invariant from a documented intentional gap:
 *
 *   (A) REAL: a non-room-member cannot read `date_post` blobs. The vault
 *       is just `date_post` events scoped by `dateId` inside an existing
 *       room — confidentiality rides on the room's RLS + room-key wrapping,
 *       not on a separate vault primitive. This test confirms RLS still
 *       blocks an outsider from seeing date_post rows.
 *
 *   (B) UX-ONLY: any current room member can decrypt date_post blobs for
 *       ANY dateId. The per-date scoping is a renderer filter; the vault
 *       does NOT cryptographically isolate one date's wall from another.
 *       Documented in the DatePostEventSchema commentary. If two members
 *       share a room, neither can hide a date_post from the other.
 *
 * Run: npx tsx --env-file=.env.local scripts/test-datevault-membership-gate.ts
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

interface DatePostPayload {
  type: 'date_post';
  postId: string;
  dateId: string;
  kind: 'text' | 'photo';
  text?: string;
  ts: number;
}

async function run() {
  await initCrypto();

  const aliceUser = await createTestUser(`test-alice-dvm-${Date.now()}@example.com`);
  const bobUser   = await createTestUser(`test-bob-dvm-${Date.now()}@example.com`);
  const eveUser   = await createTestUser(`test-eve-dvm-${Date.now()}@example.com`);
  const userIds   = [aliceUser.userId, bobUser.userId, eveUser.userId];
  const svc       = makeServiceClient();

  try {
    const alice = await provisionDevice(aliceUser.supabase, aliceUser.userId);
    const bob   = await provisionDevice(bobUser.supabase,   bobUser.userId);
    /* Eve has no device — she's a non-member outsider. */ await provisionDevice(eveUser.supabase, eveUser.userId);

    // -- Two-member room (Alice + Bob); Eve is NOT a member -------------------
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

    // -- Alice posts date_post events for TWO different dates -----------------
    const dateIdA = crypto.randomUUID();
    const dateIdB = crypto.randomUUID();

    async function postFor(dateId: string, text: string) {
      const payload: DatePostPayload = {
        type: 'date_post',
        postId: crypto.randomUUID(),
        dateId,
        kind: 'text',
        text,
        ts: Date.now(),
      };
      const enc = await encryptBlob<DatePostPayload>({
        payload, roomId: room.id, roomKey,
        senderUserId: alice.userId, senderDeviceId: alice.bundle.deviceId,
        senderDeviceEd25519PrivateKey: alice.bundle.ed25519PrivateKey,
      });
      const { error } = await aliceUser.supabase.from('blobs').insert({
        room_id: room.id, sender_id: alice.userId, sender_device_id: alice.bundle.deviceId,
        generation: enc.generation, nonce: await toBase64(enc.nonce),
        ciphertext: await toBase64(enc.ciphertext),
        signature: enc.signature.byteLength > 0 ? await toBase64(enc.signature) : null,
        session_id: null, message_index: null,
      });
      if (error) throw new Error(`insertBlob: ${error.message}`);
    }

    await postFor(dateIdA, 'Memory from Date A: that walk by the river');
    await postFor(dateIdB, 'Memory from Date B: tasting menu');

    // -- (A) Eve (non-member) tries to read blobs in this room ---------------
    const { data: eveBlobs, error: eveErr } = await eveUser.supabase
      .from('blobs').select('id').eq('room_id', room.id);
    if (eveErr) throw new Error(`eveQuery: ${eveErr.message}`);
    if (eveBlobs && eveBlobs.length > 0) {
      throw new Error(`Vulnerability: Eve sees ${eveBlobs.length} date_post(s) in a room she is not in`);
    }
    const { data: eveMembers } = await eveUser.supabase
      .from('room_members').select('device_id').eq('room_id', room.id);
    if (eveMembers && eveMembers.length > 0) {
      throw new Error(`Vulnerability: Eve sees ${eveMembers.length} room_members rows`);
    }

    // -- (B) Bob (a member) decrypts BOTH date_post blobs, regardless of dateId --
    const { data: bobBlobs } = await bobUser.supabase
      .from('blobs').select('*').eq('room_id', room.id)
      .order('created_at', { ascending: true });
    if (!bobBlobs || bobBlobs.length !== 2) {
      throw new Error(`Bob expected 2 blobs, got ${bobBlobs?.length}`);
    }

    const memberRow = await bobUser.supabase.from('room_members')
      .select('wrapped_room_key').eq('room_id', room.id)
      .eq('device_id', bob.bundle.deviceId).eq('generation', generation).single();
    if (memberRow.error || !memberRow.data) throw new Error('Bob has no room key');
    const bobRoomKey = await unwrapRoomKey(
      { wrapped: await fromBase64(memberRow.data.wrapped_room_key as string), generation },
      bob.bundle.x25519PublicKey, bob.bundle.x25519PrivateKey,
    );

    const seenDateIds = new Set<string>();
    for (const r of bobBlobs as Array<{
      nonce: string; ciphertext: string; signature: string | null;
      generation: number; session_id: string | null; message_index: number | null;
    }>) {
      const wireBlob: EncryptedBlob = {
        nonce: await fromBase64(r.nonce), ciphertext: await fromBase64(r.ciphertext),
        signature: r.signature ? await fromBase64(r.signature) : new Uint8Array(0),
        generation: r.generation, sessionId: null, messageIndex: null,
      };
      const { payload } = await decryptBlob<DatePostPayload>({
        blob: wireBlob, roomId: room.id, roomKey: bobRoomKey,
        resolveSenderDeviceEd25519Pub: async () => alice.bundle.ed25519PublicKey,
      });
      if (payload.type !== 'date_post') throw new Error(`unexpected payload type: ${payload.type}`);
      seenDateIds.add(payload.dateId);
    }

    if (!seenDateIds.has(dateIdA) || !seenDateIds.has(dateIdB)) {
      throw new Error(
        `Bob should have decrypted both date_post events but only saw `
        + `[${[...seenDateIds].map((d) => d.slice(0, 8)).join(', ')}]`,
      );
    }

    console.log(
      'PASS: DateVault membership gate — non-member Eve blocked by RLS; '
      + 'member Bob decrypted both date_post events across two dateIds ✓',
    );
    console.log(
      '      (Note: per-dateId sub-scoping is a UX filter only — every member of '
      + 'the room can decrypt every date_post regardless of dateId.)',
    );
  } finally {
    for (const id of userIds) await cleanupUser(id).catch(console.error);
  }
}

run().catch((err) => { console.error('FAIL:', err); process.exit(1); });
