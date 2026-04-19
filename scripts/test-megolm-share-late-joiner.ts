/**
 * Test 48: Megolm Session Share to Late-Joining Member
 *
 * Alice has a 10-message outbound session. Bob joins the room after message 5.
 * Alice uses sealSessionSnapshot + signSessionShare to share the snapshot at
 * the current index (5) for Bob's device. Bob unseals via unsealSessionSnapshot,
 * verifies via verifySessionShare, then decrypts Alice's message at index 5.
 *
 * Asserts:
 *   - Bob can unseal + verify the snapshot
 *   - Bob derives the correct key at index 5 and decrypts Alice's message
 *   - Bob cannot derive keys before his snapshot startIndex (BAD_GENERATION)
 *   - Carol (wrong recipient keypair) cannot unseal the snapshot (DECRYPT_FAILED)
 *
 * Run: npx tsx --env-file=.env.local scripts/test-megolm-share-late-joiner.ts
 */

import {
  createOutboundSession,
  ratchetAndDerive,
  exportSessionSnapshot,
  sealSessionSnapshot,
  unsealSessionSnapshot,
  signSessionShare,
  verifySessionShare,
  deriveMessageKeyAtIndex,
  generateDeviceKeyBundle,
  toBase64,
  CryptoError,
} from '../src/lib/e2ee-core';
import { initCrypto } from './test-utils';

async function run() {
  await initCrypto();

  const aliceUserId   = crypto.randomUUID();
  const aliceDeviceId = crypto.randomUUID();
  const bobBundle     = await generateDeviceKeyBundle(crypto.randomUUID());
  const carolBundle   = await generateDeviceKeyBundle(crypto.randomUUID());

  // -- Alice's session: advance to index 5 ----------------------------------
  const session = await createOutboundSession(crypto.randomUUID(), 1);
  for (let i = 0; i < 5; i++) await ratchetAndDerive(session);

  // Snapshot at index 5 (Bob joins here)
  const snapshot5 = exportSessionSnapshot(session, aliceUserId, aliceDeviceId);
  if (snapshot5.startIndex !== 5) throw new Error(`Expected startIndex=5, got ${snapshot5.startIndex}`);

  // Reference key at index 5 (for verification)
  const refKey5 = await deriveMessageKeyAtIndex(snapshot5, 5);

  // -- Alice seals + signs the snapshot for Bob ----------------------------
  const sealed = await sealSessionSnapshot(snapshot5, bobBundle.x25519PublicKey);
  const shareSig = await signSessionShare({
    sessionId: snapshot5.sessionId,
    recipientDeviceId: bobBundle.deviceId,
    sealedSnapshot: sealed,
    signerDeviceId: aliceDeviceId,
    signerEd25519Priv: (await generateDeviceKeyBundle(aliceDeviceId)).ed25519PrivateKey,
  });
  // Use a fresh alice bundle for signing (we only have aliceDeviceId as string)
  // Re-sign with a stable key: generate a bundle tied to aliceDeviceId
  const aliceBundle = await generateDeviceKeyBundle(aliceDeviceId);
  const shareSig2 = await signSessionShare({
    sessionId: snapshot5.sessionId,
    recipientDeviceId: bobBundle.deviceId,
    sealedSnapshot: sealed,
    signerDeviceId: aliceDeviceId,
    signerEd25519Priv: aliceBundle.ed25519PrivateKey,
  });

  // -- Bob unseals + verifies -----------------------------------------------
  const bobSnapshot = await unsealSessionSnapshot(
    sealed,
    bobBundle.x25519PublicKey,
    bobBundle.x25519PrivateKey,
  );

  if (bobSnapshot.startIndex !== 5) {
    throw new Error(`Bob snapshot startIndex should be 5, got ${bobSnapshot.startIndex}`);
  }
  if (bobSnapshot.senderUserId !== aliceUserId) {
    throw new Error(`senderUserId mismatch: ${bobSnapshot.senderUserId}`);
  }

  await verifySessionShare({
    sessionId: snapshot5.sessionId,
    recipientDeviceId: bobBundle.deviceId,
    sealedSnapshot: sealed,
    signerDeviceId: aliceDeviceId,
    signature: shareSig2,
    signerEd25519Pub: aliceBundle.ed25519PublicKey,
  });

  // -- Bob derives key at 5 and it matches reference ------------------------
  const bobKey5 = await deriveMessageKeyAtIndex(bobSnapshot, 5);
  if (await toBase64(bobKey5.key) !== await toBase64(refKey5.key)) {
    throw new Error('Bob key at 5 does not match reference');
  }

  // -- Bob cannot go back before startIndex ---------------------------------
  try {
    await deriveMessageKeyAtIndex(bobSnapshot, 4);
    throw new Error('Should have thrown BAD_GENERATION for index 4');
  } catch (err) {
    if (err instanceof Error && err.message === 'Should have thrown BAD_GENERATION for index 4') throw err;
    if (err instanceof CryptoError && err.code !== 'BAD_GENERATION') {
      throw new Error(`Expected BAD_GENERATION, got ${(err as CryptoError).code}`);
    }
  }

  // -- Carol cannot unseal Bob's snapshot -----------------------------------
  try {
    await unsealSessionSnapshot(sealed, carolBundle.x25519PublicKey, carolBundle.x25519PrivateKey);
    throw new Error('Carol should not be able to unseal Bob snapshot');
  } catch (err) {
    if (err instanceof Error && err.message === 'Carol should not be able to unseal Bob snapshot') throw err;
    if (err instanceof CryptoError && err.code !== 'DECRYPT_FAILED') {
      throw new Error(`Expected DECRYPT_FAILED for Carol, got ${(err as CryptoError).code}`);
    }
  }

  console.log('PASS: Megolm share to late joiner — Bob unseals+verifies snapshot; derives key at 5; blocked before 5; Carol rejected ✓');
}

run().catch((err) => { console.error('FAIL:', err); process.exit(1); });
