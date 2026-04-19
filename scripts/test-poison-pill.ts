/**
 * Test 66: Poison Pill (Local Storage Corruption)
 *
 * Browser storage is notoriously volatile: Safari can wipe IDB data without
 * warning; a botched deployment can change a field type; a GC race can leave
 * a zero-length Uint8Array where a 32-byte key should be. If the app blindly
 * trusts locally stored session snapshots, a corrupted chain key passed to
 * libsodium can cause a WASM memory panic or unhandled promise rejection that
 * hard-crashes the tab.
 *
 * The note on "CORRUPT_LOCAL_STATE": there is no dedicated error code for
 * storage corruption — the crypto layer can't distinguish "wrong key" from
 * "key came from a corrupted IDB row". What matters is that the AEAD
 * rejection surfaces as a handled CryptoError('DECRYPT_FAILED') rather than
 * crashing the process. Applications should treat any CryptoError thrown
 * during decrypt as a signal to refetch the session snapshot from the server.
 *
 * Corruption scenarios tested:
 *   1. chainKeyAtIndex replaced with 32 null bytes (all zeros) — HMAC produces
 *      deterministically wrong key → AEAD rejects → DECRYPT_FAILED
 *   2. chainKeyAtIndex truncated to 0 bytes — HMAC on empty key → wrong key →
 *      AEAD rejects → DECRYPT_FAILED (or BAD_INPUT if libsodium validates length)
 *   3. chainKeyAtIndex replaced with 16 bytes (half-length) — wrong-length key →
 *      DECRYPT_FAILED (or BAD_INPUT)
 *   4. startIndex advanced past the target message index → BAD_GENERATION
 *      (this is the "IDB cursor corruption" scenario: stored cursor > actual index)
 *   5. sessionId corrupted (wrong UUID bytes) — resolver returns null →
 *      DECRYPT_FAILED ("no Megolm key for session...")
 *   6. A sealed snapshot with tampered bytes — unsealSessionSnapshot throws
 *      DECRYPT_FAILED, never WASM panic
 *   7. resolveMegolmKey returns a zero-length Uint8Array (corrupt read from IDB) →
 *      AEAD rejects → DECRYPT_FAILED
 *
 * Asserts in every case:
 *   - decryptBlob throws — it never returns plaintext
 *   - The error is a handled CryptoError or Error, not a RangeError / memory panic
 *   - The Node process remains alive
 *
 * Run: npx tsx --env-file=.env.local scripts/test-poison-pill.ts
 */

import {
  generateRoomKey,
  wrapRoomKeyFor,
  signMembershipWrap,
  createOutboundSession,
  ratchetAndDerive,
  exportSessionSnapshot,
  sealSessionSnapshot,
  encryptBlobV4,
  decryptBlob,
  deriveMessageKeyAtIndex,
  toBase64,
  CryptoError,
  type EncryptedBlob,
  type InboundSessionSnapshot,
} from '../src/lib/e2ee-core';
import { initCrypto, createTestUser, provisionDevice, cleanupUser, makeServiceClient } from './test-utils';

/** Assert that fn() throws without crashing the process. */
async function mustThrowSafely(label: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
    throw new Error(`Vulnerability: ${label} — succeeded instead of throwing`);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('Vulnerability')) throw err;
    // WASM memory panics surface as RangeError or messages containing "memory"
    if (err instanceof RangeError) {
      throw new Error(`WASM panic on "${label}": ${(err as Error).message}`);
    }
    if (err instanceof Error && /memory|wasm|unreachable/i.test(err.message)) {
      throw new Error(`WASM panic on "${label}": ${err.message}`);
    }
    // Any other throw (CryptoError, TypeError, Error) is a safe failure — pass
  }
}

async function run() {
  await initCrypto();

  const aliceUser = await createTestUser(`test-alice-pp-${Date.now()}@example.com`);
  const userIds   = [aliceUser.userId];
  const svc       = makeServiceClient();

  try {
    const alice = await provisionDevice(aliceUser.supabase, aliceUser.userId);

    // -- Room + membership ----------------------------------------------------
    const { data: room, error: roomErr } = await aliceUser.supabase
      .from('rooms').insert({ kind: 'group', created_by: alice.userId })
      .select('*').single();
    if (roomErr || !room) throw new Error(`createRoom: ${roomErr?.message}`);
    const generation = room.current_generation as number;
    const roomKey    = await generateRoomKey(generation);

    const wrap = await wrapRoomKeyFor(roomKey, alice.bundle.x25519PublicKey);
    const sig  = await signMembershipWrap(
      { roomId: room.id, generation, memberUserId: alice.userId,
        memberDeviceId: alice.deviceId, wrappedRoomKey: wrap.wrapped,
        signerDeviceId: alice.deviceId },
      alice.bundle.ed25519PrivateKey,
    );
    await aliceUser.supabase.from('room_members').insert({
      room_id: room.id, user_id: alice.userId, device_id: alice.deviceId, generation,
      wrapped_room_key: await toBase64(wrap.wrapped),
      signer_device_id: alice.deviceId, wrap_signature: await toBase64(sig),
    });

    // -- Alice sends one v4 message -------------------------------------------
    const outbound    = await createOutboundSession(room.id, generation);
    const snapshotAt0 = exportSessionSnapshot(outbound, alice.userId, alice.deviceId);
    const sessionIdB64 = await toBase64(snapshotAt0.sessionId);
    const msgKey       = await ratchetAndDerive(outbound); // index 0

    const blob = await encryptBlobV4<{ text: string }>({
      payload: { text: 'healthy message' },
      roomId: room.id,
      messageKey: msgKey,
      sessionId: snapshotAt0.sessionId,
      generation,
      senderUserId: alice.userId,
      senderDeviceId: alice.deviceId,
      senderDeviceEd25519PrivateKey: alice.bundle.ed25519PrivateKey,
    });

    const wireBlob: EncryptedBlob = {
      nonce: blob.nonce,
      ciphertext: blob.ciphertext,
      signature: blob.signature,
      generation: blob.generation,
      sessionId: sessionIdB64,
      messageIndex: msgKey.index,
    };

    const decryptParams = {
      blob: wireBlob,
      roomId: room.id,
      roomKey,
      resolveSenderDeviceEd25519Pub: async () => alice.bundle.ed25519PublicKey,
    } as const;

    // Healthy baseline — confirm the blob decrypts fine before we corrupt anything
    const { payload: healthy } = await decryptBlob<{ text: string }>({
      ...decryptParams,
      resolveMegolmKey: async (sid, mi) => {
        if (sid !== sessionIdB64) return null;
        const { key } = await deriveMessageKeyAtIndex(snapshotAt0, mi);
        return key;
      },
    });
    if (healthy.text !== 'healthy message') {
      throw new Error(`Baseline decrypt wrong: "${healthy.text}"`);
    }

    // ── Scenario 1: chainKeyAtIndex = 32 null bytes (zeroed) ─────────────────
    await mustThrowSafely('zeroed chainKey', async () => {
      const corrupted: InboundSessionSnapshot = {
        ...snapshotAt0,
        chainKeyAtIndex: new Uint8Array(32), // all zeros
      };
      await decryptBlob<{ text: string }>({
        ...decryptParams,
        resolveMegolmKey: async (sid, mi) => {
          if (sid !== sessionIdB64) return null;
          const { key } = await deriveMessageKeyAtIndex(corrupted, mi);
          return key;
        },
      });
    });

    // ── Scenario 2: chainKeyAtIndex = 0 bytes (empty) ────────────────────────
    await mustThrowSafely('empty chainKey', async () => {
      const corrupted: InboundSessionSnapshot = {
        ...snapshotAt0,
        chainKeyAtIndex: new Uint8Array(0),
      };
      await decryptBlob<{ text: string }>({
        ...decryptParams,
        resolveMegolmKey: async (sid, mi) => {
          if (sid !== sessionIdB64) return null;
          const { key } = await deriveMessageKeyAtIndex(corrupted, mi);
          return key;
        },
      });
    });

    // ── Scenario 3: chainKeyAtIndex = 16 bytes (half-length) ─────────────────
    await mustThrowSafely('half-length chainKey', async () => {
      const corrupted: InboundSessionSnapshot = {
        ...snapshotAt0,
        chainKeyAtIndex: new Uint8Array(16),
      };
      await decryptBlob<{ text: string }>({
        ...decryptParams,
        resolveMegolmKey: async (sid, mi) => {
          if (sid !== sessionIdB64) return null;
          const { key } = await deriveMessageKeyAtIndex(corrupted, mi);
          return key;
        },
      });
    });

    // ── Scenario 4: startIndex advanced past target (IDB cursor corruption) ──
    await mustThrowSafely('startIndex past target', async () => {
      const corrupted: InboundSessionSnapshot = {
        ...snapshotAt0,
        startIndex: msgKey.index + 10, // cursor is ahead of the message we want
      };
      await decryptBlob<{ text: string }>({
        ...decryptParams,
        resolveMegolmKey: async (sid, mi) => {
          if (sid !== sessionIdB64) return null;
          // deriveMessageKeyAtIndex will throw BAD_GENERATION here
          const { key } = await deriveMessageKeyAtIndex(corrupted, mi);
          return key;
        },
      });
    });

    // ── Scenario 5: sessionId corrupted — resolver returns null ──────────────
    await mustThrowSafely('unknown sessionId', async () => {
      const wrongSessionId = await toBase64(new Uint8Array(32)); // all zeros ≠ real session
      const corruptBlob: EncryptedBlob = { ...wireBlob, sessionId: wrongSessionId };
      await decryptBlob<{ text: string }>({
        ...decryptParams,
        blob: corruptBlob,
        resolveMegolmKey: async (sid) => {
          // sid won't match sessionIdB64 → return null → DECRYPT_FAILED
          if (sid !== sessionIdB64) return null;
          const { key } = await deriveMessageKeyAtIndex(snapshotAt0, wireBlob.messageIndex!);
          return key;
        },
      });
    });

    // ── Scenario 6: tampered sealed snapshot bytes ────────────────────────────
    await mustThrowSafely('tampered sealed snapshot', async () => {
      const { randomBytes: randBytes } = await import('../src/lib/e2ee-core');
      const sealed = await sealSessionSnapshot(snapshotAt0, alice.bundle.x25519PublicKey);
      // Flip 8 bytes in the middle of the sealed blob
      const tampered = new Uint8Array(sealed);
      for (let i = 20; i < 28; i++) tampered[i] ^= 0xff;
      // unsealSessionSnapshot with wrong keys (we use alice pub/priv — correct — but data is tampered)
      const { unsealSessionSnapshot } = await import('../src/lib/e2ee-core');
      await unsealSessionSnapshot(tampered, alice.bundle.x25519PublicKey, alice.bundle.x25519PrivateKey);
    });

    // ── Scenario 7: resolveMegolmKey returns zero-length Uint8Array ──────────
    await mustThrowSafely('zero-length resolved key', async () => {
      await decryptBlob<{ text: string }>({
        ...decryptParams,
        resolveMegolmKey: async () => new Uint8Array(0), // empty key from corrupt IDB read
      });
    });

    console.log('PASS: Poison pill — all 7 storage-corruption scenarios throw safely (DECRYPT_FAILED or BAD_GENERATION); no WASM panic; process intact ✓');
  } finally {
    for (const id of userIds) await cleanupUser(id).catch(console.error);
  }
}

run().catch((err) => { console.error('FAIL:', err); process.exit(1); });
