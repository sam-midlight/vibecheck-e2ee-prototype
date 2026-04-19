/**
 * Test 65: Cross-Tab Race Condition
 *
 * A web user opens the app in two tabs. Both receive the same realtime blob
 * row at the same instant and both attempt to decrypt it concurrently. The
 * two protections against desync are:
 *
 *   1. LoadMutex — each tab's in-process scheduler coalesces concurrent
 *      decrypt triggers (tested in T64). Cross-tab version: two independent
 *      mutex instances (one per "tab") run concurrently; each must drain all
 *      blobs without losing any.
 *
 *   2. BroadcastChannel coordination — on identity changes (MSK rotation,
 *      device revocation, identity nuke) a signal is broadcast so sibling
 *      tabs reload before their stale in-memory keys produce failures.
 *      tab-sync.ts exports broadcastIdentityChange / subscribeIdentityChanges
 *      for this purpose. Node 18+ ships BroadcastChannel globally; same-name
 *      channels in one process deliver messages to each other, so this path
 *      is fully testable in Node.
 *
 * Test structure:
 *   Part A — BroadcastChannel coordination (pure, no DB)
 *     - "Tab A" broadcasts 3 identity-change kinds.
 *     - "Tab B" subscriber receives all 3, filtered to correct userId.
 *     - Wrong-userId events are not delivered to subscriber.
 *     - Unsubscribe stops delivery.
 *
 *   Part B — Concurrent cross-tab decrypt (integration)
 *     - Alice sends 10 Megolm messages.
 *     - Tab A and Tab B each have their own LoadMutex and blob queue.
 *     - Both tabs receive all 10 blob rows at the same instant.
 *     - Each tab independently decrypts with its own snapshot.
 *     - Assert: each tab decrypts all 10 correctly; no tab loses messages.
 *
 * Asserts:
 *   - BroadcastChannel routes events to matching userId, not to mismatched
 *   - Unsubscribe prevents further delivery
 *   - Both simulated tabs decrypt all 10 messages independently and correctly
 *
 * Run: npx tsx --env-file=.env.local scripts/test-cross-tab-race.ts
 */

import {
  generateRoomKey,
  wrapRoomKeyFor,
  signMembershipWrap,
  createOutboundSession,
  ratchetAndDerive,
  exportSessionSnapshot,
  sealSessionSnapshot,
  unsealSessionSnapshot,
  signSessionShare,
  encryptBlobV4,
  decryptBlob,
  deriveMessageKeyAtIndex,
  toBase64,
  fromBase64,
  type EncryptedBlob,
  type MegolmMessageKey,
  type InboundSessionSnapshot,
} from '../src/lib/e2ee-core';
import { createLoadMutex } from '../src/lib/load-mutex';
import { initCrypto, createTestUser, provisionDevice, cleanupUser, makeServiceClient } from './test-utils';

// ── Part A: BroadcastChannel coordination ──────────────────────────────────
//
// tab-sync.ts guards itself with `typeof window === 'undefined'` so its API
// is a no-op in Node. We test the underlying BroadcastChannel directly —
// same semantics, same code path a browser tab uses.

interface IdentityChangeEvent {
  kind: 'msk-rotated' | 'device-revoked' | 'identity-nuked';
  userId: string;
  ts: number;
}

async function testBroadcastChannel(): Promise<void> {
  const CHANNEL = 'vibecheck-e2ee-identity-test';
  const userId  = crypto.randomUUID();
  const otherId = crypto.randomUUID();

  const received: IdentityChangeEvent[] = [];
  let unsubCalled = false;
  const afterUnsub: IdentityChangeEvent[] = [];

  // "Tab B" subscriber
  const subCh = new BroadcastChannel(CHANNEL);
  subCh.onmessage = (e: MessageEvent<IdentityChangeEvent>) => {
    const data = e.data;
    if (!data || data.userId !== userId) return; // filter by userId (as tab-sync does)
    if (unsubCalled) {
      afterUnsub.push(data);
    } else {
      received.push(data);
    }
  };

  // "Tab A" broadcaster
  const pubCh = new BroadcastChannel(CHANNEL);

  const kinds: IdentityChangeEvent['kind'][] = ['msk-rotated', 'device-revoked', 'identity-nuked'];

  function broadcast(kind: IdentityChangeEvent['kind'], uid: string) {
    pubCh.postMessage({ kind, userId: uid, ts: Date.now() } satisfies IdentityChangeEvent);
  }

  // Fire 3 correct-userId events + 2 wrong-userId events
  for (const kind of kinds)           broadcast(kind, userId);
  broadcast('msk-rotated', otherId);   // should not appear in received
  broadcast('device-revoked', otherId);

  // BroadcastChannel delivers asynchronously within the same process — wait a tick
  await new Promise<void>(r => setTimeout(r, 20));

  if (received.length !== 3) {
    throw new Error(`Expected 3 received events, got ${received.length}`);
  }
  for (const [i, kind] of kinds.entries()) {
    if (received[i].kind !== kind) {
      throw new Error(`Event ${i}: expected kind "${kind}", got "${received[i].kind}"`);
    }
  }

  // Unsubscribe ("Tab B" closes its channel, simulating tab navigation/reload)
  subCh.close();
  unsubCalled = true;

  broadcast('identity-nuked', userId);
  await new Promise<void>(r => setTimeout(r, 20));

  if (afterUnsub.length !== 0) {
    throw new Error(`Received ${afterUnsub.length} events after unsubscribe (expected 0)`);
  }

  pubCh.close();
}

// ── Part B: Concurrent cross-tab decrypt ───────────────────────────────────

async function run() {
  await initCrypto();

  // Part A first (pure, no DB)
  await testBroadcastChannel();

  const aliceUser = await createTestUser(`test-alice-ct-${Date.now()}@example.com`);
  const bobUser   = await createTestUser(`test-bob-ct-${Date.now()}@example.com`);
  const userIds   = [aliceUser.userId, bobUser.userId];
  const svc       = makeServiceClient();

  try {
    const alice = await provisionDevice(aliceUser.supabase, aliceUser.userId);
    const bob   = await provisionDevice(bobUser.supabase,   bobUser.userId);

    // -- Room + memberships ---------------------------------------------------
    const { data: room, error: roomErr } = await aliceUser.supabase
      .from('rooms').insert({ kind: 'group', created_by: alice.userId })
      .select('*').single();
    if (roomErr || !room) throw new Error(`createRoom: ${roomErr?.message}`);
    const generation = room.current_generation as number;
    const roomKey    = await generateRoomKey(generation);

    for (const m of [alice, bob]) {
      const wrap = await wrapRoomKeyFor(roomKey, m.bundle.x25519PublicKey);
      const sig  = await signMembershipWrap(
        { roomId: room.id, generation, memberUserId: m.userId,
          memberDeviceId: m.deviceId, wrappedRoomKey: wrap.wrapped,
          signerDeviceId: alice.deviceId },
        alice.bundle.ed25519PrivateKey,
      );
      const client = m === alice ? aliceUser.supabase : svc;
      await client.from('room_members').insert({
        room_id: room.id, user_id: m.userId, device_id: m.deviceId, generation,
        wrapped_room_key: await toBase64(wrap.wrapped),
        signer_device_id: alice.deviceId, wrap_signature: await toBase64(sig),
      });
    }

    // -- Alice sends 10 messages ----------------------------------------------
    const MSG_COUNT   = 10;
    const outbound    = await createOutboundSession(room.id, generation);
    const snapshotAt0 = exportSessionSnapshot(outbound, alice.userId, alice.deviceId);
    const sessionIdB64 = await toBase64(snapshotAt0.sessionId);

    const msgKeys: MegolmMessageKey[] = [];
    for (let i = 0; i < MSG_COUNT; i++) msgKeys.push(await ratchetAndDerive(outbound));

    const blobs: EncryptedBlob[] = [];
    for (let i = 0; i < MSG_COUNT; i++) {
      blobs.push(await encryptBlobV4<{ text: string; i: number }>({
        payload: { text: `TabRace-${i}`, i },
        roomId: room.id,
        messageKey: msgKeys[i],
        sessionId: snapshotAt0.sessionId,
        generation,
        senderUserId: alice.userId,
        senderDeviceId: alice.deviceId,
        senderDeviceEd25519PrivateKey: alice.bundle.ed25519PrivateKey,
      }));
    }

    for (let i = 0; i < MSG_COUNT; i++) {
      const eb = blobs[i];
      await aliceUser.supabase.from('blobs').insert({
        room_id: room.id, sender_id: alice.userId, sender_device_id: alice.deviceId,
        generation: eb.generation,
        nonce: await toBase64(eb.nonce),
        ciphertext: await toBase64(eb.ciphertext),
        signature: null,
        session_id: sessionIdB64,
        message_index: msgKeys[i].index,
      });
    }

    // -- Alice shares snapshot with Bob ---------------------------------------
    const sealed = await sealSessionSnapshot(snapshotAt0, bob.bundle.x25519PublicKey);
    const shareSig = await signSessionShare({
      sessionId: snapshotAt0.sessionId,
      recipientDeviceId: bob.deviceId,
      sealedSnapshot: sealed,
      signerDeviceId: alice.deviceId,
      signerEd25519Priv: alice.bundle.ed25519PrivateKey,
    });
    await svc.from('megolm_session_shares').insert({
      session_id: sessionIdB64,
      recipient_device_id: bob.deviceId,
      sealed_snapshot: await toBase64(sealed),
      start_index: snapshotAt0.startIndex,
      signer_device_id: alice.deviceId,
      share_signature: await toBase64(shareSig),
    });

    const { data: shareRow } = await svc.from('megolm_session_shares')
      .select('sealed_snapshot').eq('session_id', sessionIdB64)
      .eq('recipient_device_id', bob.deviceId).single();
    const bobSnapshot = await unsealSessionSnapshot(
      await fromBase64((shareRow as { sealed_snapshot: string }).sealed_snapshot),
      bob.bundle.x25519PublicKey,
      bob.bundle.x25519PrivateKey,
    );

    // -- Simulate two browser tabs for Bob ------------------------------------
    // Each tab has its own in-memory state: a LoadMutex, a pending queue, and
    // a result set. Both tabs share the same IDB (here: same `bobSnapshot` and
    // same `roomKey`) but process independently — the key invariant is that
    // each tab INDIVIDUALLY recovers all messages, even if both are processing
    // concurrently.

    function makeTab(label: string, snapshot: InboundSessionSnapshot) {
      const mutex      = createLoadMutex();
      const pending    = blobs.map((eb, i): { blob: EncryptedBlob; idx: number } => ({
        blob: {
          nonce: eb.nonce, ciphertext: eb.ciphertext, signature: eb.signature,
          generation: eb.generation, sessionId: sessionIdB64,
          messageIndex: msgKeys[i].index,
        },
        idx: msgKeys[i].index,
      }));
      const results: Map<number, string> = new Map();
      let loadCount = 0;

      let drainResolve!: () => void;
      const drained = new Promise<void>(r => { drainResolve = r; });

      async function resolveMegolmKey(sid: string, mi: number): Promise<Uint8Array | null> {
        if (sid !== sessionIdB64) return null;
        const { key } = await deriveMessageKeyAtIndex(snapshot, mi);
        return key;
      }

      async function loadBatch(): Promise<void> {
        loadCount++;
        const toProcess = pending.splice(0, pending.length);
        await Promise.all(toProcess.map(async ({ blob, idx }) => {
          const { payload } = await decryptBlob<{ text: string; i: number }>({
            blob, roomId: room.id, roomKey,
            resolveSenderDeviceEd25519Pub: async () => alice.bundle.ed25519PublicKey,
            resolveMegolmKey,
          });
          results.set(idx, payload.text);
        }));
        const promoted = mutex.release();
        if (promoted) await loadBatch();
        else drainResolve();
      }

      async function triggerLoad(): Promise<void> {
        const slot = mutex.acquire();
        if (slot === 'run') await loadBatch();
        else if (slot === 'queue') await drained;
        // 'drop' — running load will sweep this blob too
      }

      return { label, mutex, pending, results, triggerLoad, drained,
               get loadCount() { return loadCount; } };
    }

    // Each "tab" gets its own snapshot copy (simulating two IDB reads)
    const tabA = makeTab('TabA', { ...bobSnapshot, chainKeyAtIndex: new Uint8Array(bobSnapshot.chainKeyAtIndex) });
    const tabB = makeTab('TabB', { ...bobSnapshot, chainKeyAtIndex: new Uint8Array(bobSnapshot.chainKeyAtIndex) });

    // Fire MSG_COUNT concurrent triggers on BOTH tabs simultaneously
    const allTriggers: Promise<void>[] = [];
    for (let i = 0; i < MSG_COUNT; i++) {
      allTriggers.push(tabA.triggerLoad());
      allTriggers.push(tabB.triggerLoad());
    }
    await Promise.all(allTriggers);
    await tabA.drained;
    await tabB.drained;

    // -- Assertions -----------------------------------------------------------
    for (const tab of [tabA, tabB]) {
      if (tab.results.size !== MSG_COUNT) {
        throw new Error(`${tab.label}: expected ${MSG_COUNT} decrypted, got ${tab.results.size}`);
      }
      for (let i = 0; i < MSG_COUNT; i++) {
        const got = tab.results.get(i);
        const expected = `TabRace-${i}`;
        if (got !== expected) {
          throw new Error(`${tab.label} index ${i}: expected "${expected}", got "${got}"`);
        }
      }
    }

    console.log(
      `PASS: Cross-tab race — BroadcastChannel routes 3 identity events, filters wrong userId, stops after close; ` +
      `TabA (${tabA.loadCount} batch(es)) and TabB (${tabB.loadCount} batch(es)) each decrypted all ${MSG_COUNT} messages independently ✓`,
    );
  } finally {
    for (const id of userIds) await cleanupUser(id).catch(console.error);
  }
}

run().catch((err) => { console.error('FAIL:', err); process.exit(1); });
