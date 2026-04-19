/**
 * Test 47: Megolm Snapshot Fast-Path Decryption
 *
 * Bob holds a cached InboundSessionSnapshot at index 5 (he received the
 * session at message 5). He later receives a blob at index 12. Using
 * deriveMessageKeyAtIndexAndAdvance starting from his cached snapshot (5→12)
 * he should get the same key as computing from the session-start snapshot.
 *
 * Also: after advancing cursor to 13, re-deriving index 12 from the new
 * snapshot (startIndex=13) throws BAD_GENERATION — demonstrating the
 * cursor can't go backwards.
 *
 * Run: npx tsx --env-file=.env.local scripts/test-megolm-snapshot-fastpath.ts
 */

import {
  createOutboundSession,
  ratchetAndDerive,
  exportSessionSnapshot,
  deriveMessageKeyAtIndex,
  deriveMessageKeyAtIndexAndAdvance,
  toBase64,
  CryptoError,
} from '../src/lib/e2ee-core';
import { initCrypto } from './test-utils';

async function run() {
  await initCrypto();

  const SENDER_USER_ID   = crypto.randomUUID();
  const SENDER_DEVICE_ID = crypto.randomUUID();

  // Build session to index 12 (advance 13 times for indices 0..12)
  const session = await createOutboundSession(crypto.randomUUID(), 1);
  for (let i = 0; i < 13; i++) await ratchetAndDerive(session);
  // session.messageIndex is now 13

  // Export snapshot at index 0 (session-start) for ground-truth
  // We can't go back to 0 — instead capture at index 5 by re-building.
  const sessionId = session.sessionId;
  const roomId = (session as unknown as { roomId: string }).roomId;

  // Rebuild to capture snapshots at 0 and 5
  const fresh = await createOutboundSession(roomId, 1);
  const snapshotAt0 = exportSessionSnapshot(fresh, SENDER_USER_ID, SENDER_DEVICE_ID);
  for (let i = 0; i < 5; i++) await ratchetAndDerive(fresh);
  const snapshotAt5 = exportSessionSnapshot(fresh, SENDER_USER_ID, SENDER_DEVICE_ID);

  // -- Reference: derive key at 12 from snapshot at 0 -----------------------
  const refKey12 = await deriveMessageKeyAtIndex(snapshotAt0, 12);

  // -- Fast-path: derive key at 12 from snapshot at 5 -----------------------
  const { messageKey: fastKey12, nextSnapshot: snap13 } =
    await deriveMessageKeyAtIndexAndAdvance(snapshotAt5, 12);

  if (await toBase64(fastKey12.key) !== await toBase64(refKey12.key)) {
    throw new Error('Fast-path key at 12 does not match reference from snapshot-0');
  }
  if (snap13.startIndex !== 13) {
    throw new Error(`Expected nextSnapshot.startIndex=13, got ${snap13.startIndex}`);
  }

  // -- Cursor at 13 can't re-derive index 12 --------------------------------
  try {
    await deriveMessageKeyAtIndexAndAdvance(snap13, 12);
    throw new Error('Should have thrown BAD_GENERATION for index < startIndex');
  } catch (err) {
    if (err instanceof Error && err.message === 'Should have thrown BAD_GENERATION for index < startIndex') throw err;
    if (err instanceof CryptoError && err.code !== 'BAD_GENERATION') {
      throw new Error(`Expected BAD_GENERATION, got ${(err as CryptoError).code}`);
    }
  }

  // -- Chaining from snap13 correctly derives 13, 14, 15 --------------------
  for (let idx = 13; idx <= 15; idx++) {
    const refKey = await deriveMessageKeyAtIndex(snapshotAt0, idx);
    const { messageKey: fastKey } = await deriveMessageKeyAtIndexAndAdvance(snap13, idx);
    if (await toBase64(fastKey.key) !== await toBase64(refKey.key)) {
      throw new Error(`Key mismatch at index ${idx} using snapshot-13`);
    }
  }

  console.log('PASS: Megolm snapshot fast-path — index 12 matches reference; cursor 13 blocks index 12; chain 13-15 matches ✓');
}

run().catch((err) => { console.error('FAIL:', err); process.exit(1); });
