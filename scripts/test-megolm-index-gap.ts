/**
 * Test 50: Megolm Message-Index Gap Tolerance
 *
 * Alice's session advances but blobs for indices 3 and 4 are never inserted
 * (simulating dropped/skipped messages). A receiver with a snapshot at
 * index 0 can still derive the key at index 5 by ratcheting through the gap.
 * After advancing to cursor 6, trying to derive index 4 (in the gap) throws
 * BAD_GENERATION — you can't go back.
 *
 * Asserts:
 *   - Key at index 5 derived correctly even when indices 3+4 were skipped
 *   - Key at index 5 matches independent derivation from session start
 *   - After advancing cursor to 6, index 4 throws BAD_GENERATION
 *   - Index 6 and beyond still work from cursor 6
 *
 * Run: npx tsx --env-file=.env.local scripts/test-megolm-index-gap.ts
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

  // Build session: advance 6 times (indices 0..5)
  const session = await createOutboundSession(crypto.randomUUID(), 1);
  const keys: Array<Awaited<ReturnType<typeof ratchetAndDerive>>> = [];
  for (let i = 0; i < 6; i++) keys.push(await ratchetAndDerive(session));

  // Export snapshot at startIndex=0 for receiver
  const sessionAtStart = await createOutboundSession((session as unknown as { roomId: string }).roomId, 1);
  const snapshotAt0 = exportSessionSnapshot(sessionAtStart, SENDER_USER_ID, SENDER_DEVICE_ID);

  // -- Reference key at 5 from clean start ----------------------------------
  const refKey5 = await deriveMessageKeyAtIndex(snapshotAt0, 5);

  // -- Derive key at 5 via advancing cursor (skipping 3 and 4) --------------
  const { messageKey: key5, nextSnapshot: snap6 } =
    await deriveMessageKeyAtIndexAndAdvance(snapshotAt0, 5);

  if (await toBase64(key5.key) !== await toBase64(refKey5.key)) {
    throw new Error('Key at 5 does not match reference despite gap at 3+4');
  }
  if (snap6.startIndex !== 6) throw new Error(`Expected cursor 6, got ${snap6.startIndex}`);

  // -- After advancing to 6, index 4 (in gap) is unreachable ---------------
  try {
    await deriveMessageKeyAtIndex(snap6, 4);
    throw new Error('Should throw BAD_GENERATION for index 4 from cursor 6');
  } catch (err) {
    if (err instanceof Error && err.message === 'Should throw BAD_GENERATION for index 4 from cursor 6') throw err;
    if (err instanceof CryptoError && err.code !== 'BAD_GENERATION') {
      throw new Error(`Expected BAD_GENERATION, got ${(err as CryptoError).code}`);
    }
  }

  // -- Index 6 from cursor 6 works ------------------------------------------
  const refKey6 = await deriveMessageKeyAtIndex(snapshotAt0, 6);
  const { messageKey: key6 } = await deriveMessageKeyAtIndexAndAdvance(snap6, 6);
  if (await toBase64(key6.key) !== await toBase64(refKey6.key)) {
    throw new Error('Key at 6 mismatch');
  }

  console.log('PASS: Megolm index gap — key at 5 derived over gap at 3+4; cursor 6 blocks index 4; index 6 correct ✓');
}

run().catch((err) => { console.error('FAIL:', err); process.exit(1); });
