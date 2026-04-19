/**
 * Test 12: Megolm Session Auto-Rotation at Message Cap
 *
 * Alice creates an outbound Megolm session and ratchets it 100 times.
 * After exactly 100 messages, shouldRotateSession must return true.
 * A 101st ratchet-and-derive should still work (the hard cap is 200),
 * but the caller should have rotated before sending.
 *
 * This test also verifies that a recipient holding a start-index-0 snapshot
 * can derive message key 99 (the 100th message) correctly, and that
 * shouldRotateSession is false at index 99 but true at 100.
 *
 * Asserts:
 *   - shouldRotateSession returns false at messageIndex 99
 *   - shouldRotateSession returns true at messageIndex 100
 *   - A second outbound session (new rotation) produces a different sessionId
 *   - Recipient can decrypt message at index 99 from a start-0 snapshot
 *
 * Run: npx tsx --env-file=.env.local scripts/test-session-auto-rotation.ts
 */

import {
  createOutboundSession,
  exportSessionSnapshot,
  ratchetAndDerive,
  deriveMessageKeyAtIndex,
  shouldRotateSession,
  toBase64,
  encryptBlobV4,
  decryptBlob,
  generateRoomKey,
  type EncryptedBlob,
} from '../src/lib/e2ee-core';
import { initCrypto } from './test-utils';

async function run() {
  await initCrypto();

  const roomId     = crypto.randomUUID();
  const generation = 1;
  const roomKey    = await generateRoomKey(generation);
  const userId     = crypto.randomUUID();
  const deviceId   = crypto.randomUUID();

  // Create session — capture snapshot at index 0 for recipient simulation
  const outbound = await createOutboundSession(roomId, generation);
  const snapshot = exportSessionSnapshot(outbound, userId, deviceId);

  // shouldRotateSession must be false initially
  if (shouldRotateSession(outbound)) {
    throw new Error('shouldRotateSession returned true at index 0 — expected false');
  }

  // Ratchet 99 times (indices 0..98) — still below the 100-message cap
  let lastKey99 = null;
  for (let i = 0; i < 99; i++) {
    await ratchetAndDerive(outbound);
  }
  // messageIndex is now 99 — one more step will hit 100
  if (shouldRotateSession(outbound)) {
    throw new Error(`shouldRotateSession returned true at index 99 — expected false (index is ${outbound.messageIndex})`);
  }

  // Ratchet once more to produce message 99 (index 99)
  lastKey99 = await ratchetAndDerive(outbound); // produces index 99, advances to 100
  if (lastKey99.index !== 99) throw new Error(`Expected key index 99, got ${lastKey99.index}`);

  // Now messageIndex = 100 — shouldRotateSession must be true
  if (!shouldRotateSession(outbound)) {
    throw new Error(`shouldRotateSession returned false at index ${outbound.messageIndex} — expected true (cap=100)`);
  }

  // -- Verify recipient can derive key at index 99 from start-0 snapshot -----
  const derivedKey99 = await deriveMessageKeyAtIndex(snapshot, 99);
  if (derivedKey99.index !== 99) throw new Error('Derived key index mismatch');

  // Both paths should produce the same 32-byte key
  const senderKey99Hex = await toBase64(lastKey99.key);
  const recipientKey99Hex = await toBase64(derivedKey99.key);
  if (senderKey99Hex !== recipientKey99Hex) {
    throw new Error(`Key mismatch at index 99: sender=${senderKey99Hex.slice(0,8)}… recipient=${recipientKey99Hex.slice(0,8)}…`);
  }

  // -- New session after rotation has a different sessionId -------------------
  const newSession = await createOutboundSession(roomId, generation);
  const oldId = await toBase64(outbound.sessionId);
  const newId = await toBase64(newSession.sessionId);
  if (oldId === newId) {
    throw new Error('New session has same sessionId as old session — rotation did not produce a fresh session');
  }

  // -- Verify shouldRotateSession respects maxMessages config -----------------
  // At index 100 with custom cap of 50, should also be true
  if (!shouldRotateSession(outbound, { maxMessages: 50, maxAgeMs: 7 * 24 * 60 * 60 * 1000 })) {
    throw new Error('shouldRotateSession returned false with custom cap=50 at index 100');
  }

  console.log('PASS: Session auto-rotation triggers correctly at message cap 100 ✓');
}

run().catch((err) => { console.error('FAIL:', err); process.exit(1); });
