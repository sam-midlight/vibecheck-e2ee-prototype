/**
 * Test 21: Forward Secrecy Within Session
 *
 * Alice creates an outbound session and ratchets it 100 times.
 * She shares a snapshot starting at index 50 with Bob.
 *
 * Asserts:
 *   - Bob can derive message keys at indices 50, 75, 99 (forward from his snapshot)
 *   - Bob CANNOT derive key at index 49 (before his snapshot start) — throws
 *   - Bob CANNOT derive key at index 0 (well before his snapshot) — throws
 *   - Keys at the same index derived by sender and recipient match
 *   - Key at index 50 != key at index 51 (ratchet advances each step)
 *
 * Run: npx tsx --env-file=.env.local scripts/test-forward-secrecy.ts
 */

import {
  createOutboundSession,
  ratchetAndDerive,
  exportSessionSnapshot,
  deriveMessageKeyAtIndex,
  toBase64,
  CryptoError,
} from '../src/lib/e2ee-core';
import { initCrypto } from './test-utils';

async function run() {
  await initCrypto();

  const userId   = crypto.randomUUID();
  const deviceId = crypto.randomUUID();
  const session  = await createOutboundSession(crypto.randomUUID(), 1);

  // Ratchet 50 times to advance to index 50
  const keys: Map<number, Awaited<ReturnType<typeof ratchetAndDerive>>> = new Map();
  for (let i = 0; i < 100; i++) {
    const mk = await ratchetAndDerive(session);
    keys.set(mk.index, mk);
  }
  // session.messageIndex is now 100

  // Export snapshot at index 50 — startIndex=50, so only indices 50+ are derivable
  // We need to create a fresh session and ratchet to index 50 to export from there.
  // Instead: ratchet a second session 50 times and export, then ratchet 50 more.
  const session2 = await createOutboundSession(crypto.randomUUID(), 1);
  // Ratchet 50 times silently
  for (let i = 0; i < 50; i++) await ratchetAndDerive(session2);
  // Export at index 50
  const snapshot50 = exportSessionSnapshot(session2, userId, deviceId);
  if (snapshot50.startIndex !== 50) throw new Error(`Expected startIndex 50, got ${snapshot50.startIndex}`);

  // Continue ratcheting to capture actual keys at 50, 75, 99
  const senderKeys: Map<number, Awaited<ReturnType<typeof ratchetAndDerive>>> = new Map();
  for (let i = 0; i < 50; i++) {
    const mk = await ratchetAndDerive(session2);
    senderKeys.set(mk.index, mk);
  }

  // Bob derives keys from snapshot50 — indices 50, 75, 99 must match sender
  for (const idx of [50, 75, 99]) {
    const recipientKey = await deriveMessageKeyAtIndex(snapshot50, idx);
    const senderKey    = senderKeys.get(idx);
    if (!senderKey) throw new Error(`Sender key at index ${idx} not captured`);
    const rB64 = await toBase64(recipientKey.key);
    const sB64 = await toBase64(senderKey.key);
    if (rB64 !== sB64) {
      throw new Error(`Key mismatch at index ${idx}: sender=${sB64.slice(0,8)}… recipient=${rB64.slice(0,8)}…`);
    }
  }

  // Keys at consecutive indices must differ (ratchet advances)
  const k50 = await deriveMessageKeyAtIndex(snapshot50, 50);
  const k51 = await deriveMessageKeyAtIndex(snapshot50, 51);
  if (await toBase64(k50.key) === await toBase64(k51.key)) {
    throw new Error('Keys at index 50 and 51 are identical — ratchet is not advancing');
  }

  // Bob CANNOT derive index 49 (before snapshot start)
  try {
    await deriveMessageKeyAtIndex(snapshot50, 49);
    throw new Error('Vulnerability: derived key at index 49 from snapshot starting at 50 — forward secrecy broken');
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('Vulnerability')) throw err;
    if (err instanceof CryptoError && err.message.includes('cannot derive')) {
      // Expected
    } else if (err instanceof Error && err.message.includes('cannot derive')) {
      // Expected
    } else {
      throw err;
    }
  }

  // Bob CANNOT derive index 0
  try {
    await deriveMessageKeyAtIndex(snapshot50, 0);
    throw new Error('Vulnerability: derived key at index 0 from snapshot starting at 50 — forward secrecy broken');
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('Vulnerability')) throw err;
    // Expected: BAD_GENERATION or similar
  }

  console.log('PASS: Forward secrecy — snapshot@50 can derive 50/75/99 but not 49/0; consecutive keys differ ✓');
}

run().catch((err) => { console.error('FAIL:', err); process.exit(1); });
