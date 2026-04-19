/**
 * Test 30: Session Snapshot Backup Round-Trip
 *
 * Encrypt an InboundSessionSnapshot under a backup key, store it, then
 * decrypt it and verify all fields are recovered correctly.
 *
 * Asserts:
 *   - chainKeyAtIndex, startIndex, senderUserId, senderDeviceId all match
 *   - Decryption with the correct sessionId + startIndex succeeds
 *   - Decryption with a wrong roomId in AD throws (AEAD binding)
 *   - Decryption with a wrong backup key throws
 *
 * Run: npx tsx --env-file=.env.local scripts/test-session-snapshot-backup.ts
 */

import {
  createOutboundSession,
  exportSessionSnapshot,
  ratchetAndDerive,
  generateBackupKey,
  encryptSessionSnapshotForBackup,
  decryptSessionSnapshotFromBackup,
  toBase64,
} from '../src/lib/e2ee-core';
import { initCrypto } from './test-utils';

async function run() {
  await initCrypto();

  const roomId   = crypto.randomUUID();
  const userId   = crypto.randomUUID();
  const deviceId = crypto.randomUUID();
  const backupKey = await generateBackupKey();

  // Create an outbound session and ratchet to index 5
  const session = await createOutboundSession(roomId, 1);
  for (let i = 0; i < 5; i++) await ratchetAndDerive(session);
  // session.messageIndex is now 5 — export snapshot at startIndex=5
  const snapshot = exportSessionSnapshot(session, userId, deviceId);
  const sessionIdB64 = await toBase64(session.sessionId);

  // -- Encrypt the snapshot for backup --------------------------------------
  const { ciphertext, nonce } = await encryptSessionSnapshotForBackup({
    snapshot,
    sessionId: sessionIdB64,
    backupKey,
    roomId,
  });

  // -- Decrypt and verify ---------------------------------------------------
  const recovered = await decryptSessionSnapshotFromBackup({
    ciphertext, nonce,
    sessionId: sessionIdB64,
    startIndex: snapshot.startIndex,
    backupKey,
    roomId,
  });

  if (recovered.startIndex !== 5) throw new Error(`startIndex mismatch: expected 5, got ${recovered.startIndex}`);
  if (recovered.senderUserId !== userId) throw new Error(`senderUserId mismatch: "${recovered.senderUserId}"`);
  if (recovered.senderDeviceId !== deviceId) throw new Error(`senderDeviceId mismatch: "${recovered.senderDeviceId}"`);
  if (await toBase64(recovered.chainKeyAtIndex) !== await toBase64(snapshot.chainKeyAtIndex)) {
    throw new Error('chainKeyAtIndex mismatch after round-trip');
  }

  // -- Wrong roomId in AD throws --------------------------------------------
  try {
    await decryptSessionSnapshotFromBackup({
      ciphertext, nonce,
      sessionId: sessionIdB64,
      startIndex: snapshot.startIndex,
      backupKey,
      roomId: crypto.randomUUID(), // wrong room
    });
    throw new Error('Vulnerability: decrypted snapshot with wrong roomId — AD binding broken');
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('Vulnerability')) throw err;
    // Expected: AEAD failure
  }

  // -- Wrong backup key throws ----------------------------------------------
  const wrongKey = await generateBackupKey();
  try {
    await decryptSessionSnapshotFromBackup({
      ciphertext, nonce,
      sessionId: sessionIdB64,
      startIndex: snapshot.startIndex,
      backupKey: wrongKey,
      roomId,
    });
    throw new Error('Vulnerability: decrypted snapshot with wrong backup key');
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('Vulnerability')) throw err;
    // Expected: DECRYPT_FAILED
  }

  // -- Wrong startIndex in AD throws ----------------------------------------
  try {
    await decryptSessionSnapshotFromBackup({
      ciphertext, nonce,
      sessionId: sessionIdB64,
      startIndex: 99, // wrong index
      backupKey,
      roomId,
    });
    throw new Error('Vulnerability: decrypted snapshot with wrong startIndex — AD binding broken');
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('Vulnerability')) throw err;
    // Expected: AEAD failure
  }

  console.log('PASS: Session snapshot backup round-trip — all fields recovered; wrong roomId/key/startIndex throw ✓');
}

run().catch((err) => { console.error('FAIL:', err); process.exit(1); });
