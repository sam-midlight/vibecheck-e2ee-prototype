/**
 * Test 20: Megolm Hard Cap Enforcement
 *
 * Ratchets an outbound session 200 times (MEGOLM_HARD_CAP). The 201st call
 * to ratchetAndDerive must throw. This validates the client-side guard that
 * mirrors the server-side trigger in migration 0029 (which rejects blobs
 * with message_count > 200).
 *
 * Also confirms that the 200th ratchet (index 199) succeeds — the cap is
 * exclusive (>= 200 throws), not inclusive.
 *
 * Run: npx tsx --env-file=.env.local scripts/test-megolm-hard-cap.ts
 */

import {
  createOutboundSession,
  ratchetAndDerive,
  MEGOLM_HARD_CAP,
} from '../src/lib/e2ee-core';
import { initCrypto } from './test-utils';

async function run() {
  await initCrypto();

  const session = await createOutboundSession(crypto.randomUUID(), 1);

  // Ratchet up to index MEGOLM_HARD_CAP - 1 (i.e. 199 times → produces keys 0..198,
  // advances messageIndex to 199)
  for (let i = 0; i < MEGOLM_HARD_CAP - 1; i++) {
    await ratchetAndDerive(session);
  }
  if (session.messageIndex !== MEGOLM_HARD_CAP - 1) {
    throw new Error(`Expected messageIndex ${MEGOLM_HARD_CAP - 1}, got ${session.messageIndex}`);
  }

  // The next ratchet (producing key at index 199, advancing to 200) should still succeed
  const lastKey = await ratchetAndDerive(session);
  if (lastKey.index !== MEGOLM_HARD_CAP - 1) {
    throw new Error(`Expected last key index ${MEGOLM_HARD_CAP - 1}, got ${lastKey.index}`);
  }
  if (session.messageIndex !== MEGOLM_HARD_CAP) {
    throw new Error(`Expected messageIndex ${MEGOLM_HARD_CAP} after last ratchet, got ${session.messageIndex}`);
  }

  // Now messageIndex === 200 — next ratchet must throw
  try {
    await ratchetAndDerive(session);
    throw new Error(`Vulnerability: ratchetAndDerive succeeded at index ${session.messageIndex} — hard cap not enforced`);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('Vulnerability')) throw err;
    if (err instanceof Error && err.message.includes('exhausted')) {
      // Expected: "Megolm session exhausted at index 200"
    } else {
      throw err;
    }
  }

  console.log(`PASS: Megolm hard cap ${MEGOLM_HARD_CAP} enforced — ratchet throws at index ${MEGOLM_HARD_CAP} ✓`);
}

run().catch((err) => { console.error('FAIL:', err); process.exit(1); });
