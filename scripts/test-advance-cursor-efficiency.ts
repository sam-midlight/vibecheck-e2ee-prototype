/**
 * Test 40: deriveMessageKeyAtIndexAndAdvance Cursor Efficiency
 *
 * The advancing variant of the ratchet should:
 *   1. Produce the same message key as deriveMessageKeyAtIndex for any target
 *   2. Return a nextSnapshot whose startIndex is targetIndex+1
 *   3. Enable O(1) subsequent derivation: re-calling with the nextSnapshot at
 *      targetIndex+1 should not need to re-ratchet from the original startIndex
 *
 * This test exercises the correctness invariant rather than timing, since
 * we can't measure wall-clock O(n) vs O(1) reliably in a test script.
 *
 * Asserts:
 *   - Keys from advancing variant match deriveMessageKeyAtIndex at same indices
 *   - nextSnapshot.startIndex === targetIndex + 1 after each advance
 *   - Chaining advances (use nextSnapshot as input for next call) yields same
 *     keys as calling deriveMessageKeyAtIndex from scratch at each index
 *   - Advancing variant throws BAD_GENERATION for targetIndex < snapshot.startIndex
 *
 * Run: npx tsx --env-file=.env.local scripts/test-advance-cursor-efficiency.ts
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

  // Build an outbound session and advance to index 5 so startIndex > 0
  const outboundSession = await createOutboundSession(crypto.randomUUID(), 1);
  for (let i = 0; i < 5; i++) await ratchetAndDerive(outboundSession);

  // Export snapshot at messageIndex = 5
  const snapshot = exportSessionSnapshot(outboundSession, SENDER_USER_ID, SENDER_DEVICE_ID);
  if (snapshot.startIndex !== 5) throw new Error(`Expected startIndex=5, got ${snapshot.startIndex}`);

  // -- 1. Advancing variant matches deriveMessageKeyAtIndex at index 5 -------
  const { messageKey: advKey5, nextSnapshot: snap6 } =
    await deriveMessageKeyAtIndexAndAdvance(snapshot, 5);
  const refKey5 = await deriveMessageKeyAtIndex(snapshot, 5);

  if (await toBase64(advKey5.key) !== await toBase64(refKey5.key)) {
    throw new Error('Key mismatch at index 5 between advancing and reference variant');
  }
  if (advKey5.index !== 5) throw new Error(`advKey5.index should be 5, got ${advKey5.index}`);

  // -- 2. nextSnapshot.startIndex === targetIndex + 1 ------------------------
  if (snap6.startIndex !== 6) {
    throw new Error(`nextSnapshot.startIndex should be 6, got ${snap6.startIndex}`);
  }

  // -- 3. Chaining advances matches reference for indices 6..10 --------------
  let cursor = snap6;
  for (let idx = 6; idx <= 10; idx++) {
    const { messageKey: advKey, nextSnapshot: next } =
      await deriveMessageKeyAtIndexAndAdvance(cursor, idx);
    const refKey = await deriveMessageKeyAtIndex(snapshot, idx); // from original snapshot

    if (await toBase64(advKey.key) !== await toBase64(refKey.key)) {
      throw new Error(`Key mismatch at index ${idx}`);
    }
    if (advKey.index !== idx) {
      throw new Error(`advKey.index should be ${idx}, got ${advKey.index}`);
    }
    if (next.startIndex !== idx + 1) {
      throw new Error(`nextSnapshot.startIndex should be ${idx + 1}, got ${next.startIndex}`);
    }
    cursor = next;
  }
  // cursor.startIndex should now be 11
  if (cursor.startIndex !== 11) throw new Error(`Final cursor startIndex should be 11, got ${cursor.startIndex}`);

  // -- 4. BAD_GENERATION for targetIndex < snapshot.startIndex ---------------
  try {
    await deriveMessageKeyAtIndexAndAdvance(snapshot, 4); // snapshot.startIndex = 5
    throw new Error('Should have thrown for targetIndex < startIndex');
  } catch (err) {
    if (err instanceof Error && err.message === 'Should have thrown for targetIndex < startIndex') throw err;
    if (err instanceof CryptoError && err.code !== 'BAD_GENERATION') {
      throw new Error(`Expected BAD_GENERATION, got ${(err as CryptoError).code}`);
    }
    // Expected
  }

  console.log('PASS: Advancing cursor — keys match reference; startIndex tracks correctly; BAD_GENERATION on underflow ✓');
}

run().catch((err) => { console.error('FAIL:', err); process.exit(1); });
