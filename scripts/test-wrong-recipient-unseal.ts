/**
 * Test 59: Wrong-Recipient Unsealing Fails
 *
 * Alice seals a session snapshot for Bob's X25519 pub using sealSessionSnapshot.
 * Carol attempts to unseal it with her own keypair — must throw DECRYPT_FAILED.
 * Bob unseals it successfully with his keypair.
 *
 * Also tests the share signature binding: tampering the sealed bytes makes
 * verifySessionShare throw CERT_INVALID.
 *
 * Asserts:
 *   - Bob can unseal + verify the snapshot
 *   - Carol cannot unseal (wrong keypair) → DECRYPT_FAILED
 *   - Tampered sealed bytes fail verifySessionShare → CERT_INVALID
 *
 * Run: npx tsx --env-file=.env.local scripts/test-wrong-recipient-unseal.ts
 */

import {
  createOutboundSession,
  ratchetAndDerive,
  exportSessionSnapshot,
  sealSessionSnapshot,
  unsealSessionSnapshot,
  signSessionShare,
  verifySessionShare,
  generateDeviceKeyBundle,
  CryptoError,
} from '../src/lib/e2ee-core';
import { initCrypto } from './test-utils';

async function run() {
  await initCrypto();

  const aliceUserId   = crypto.randomUUID();
  const aliceDeviceId = crypto.randomUUID();
  const aliceBundle   = await generateDeviceKeyBundle(aliceDeviceId);
  const bobBundle     = await generateDeviceKeyBundle(crypto.randomUUID());
  const carolBundle   = await generateDeviceKeyBundle(crypto.randomUUID());

  const session = await createOutboundSession(crypto.randomUUID(), 1);
  for (let i = 0; i < 3; i++) await ratchetAndDerive(session);
  const snapshot = exportSessionSnapshot(session, aliceUserId, aliceDeviceId);

  // Alice seals for Bob
  const sealed = await sealSessionSnapshot(snapshot, bobBundle.x25519PublicKey);
  const shareSig = await signSessionShare({
    sessionId: snapshot.sessionId,
    recipientDeviceId: bobBundle.deviceId,
    sealedSnapshot: sealed,
    signerDeviceId: aliceDeviceId,
    signerEd25519Priv: aliceBundle.ed25519PrivateKey,
  });

  // -- Bob can unseal --------------------------------------------------------
  const bobSnapshot = await unsealSessionSnapshot(
    sealed, bobBundle.x25519PublicKey, bobBundle.x25519PrivateKey,
  );
  if (bobSnapshot.startIndex !== snapshot.startIndex) {
    throw new Error(`Bob snapshot startIndex mismatch: ${bobSnapshot.startIndex}`);
  }

  // -- Bob verifies the share signature --------------------------------------
  await verifySessionShare({
    sessionId: snapshot.sessionId,
    recipientDeviceId: bobBundle.deviceId,
    sealedSnapshot: sealed,
    signerDeviceId: aliceDeviceId,
    signature: shareSig,
    signerEd25519Pub: aliceBundle.ed25519PublicKey,
  });

  // -- Carol cannot unseal ---------------------------------------------------
  try {
    await unsealSessionSnapshot(sealed, carolBundle.x25519PublicKey, carolBundle.x25519PrivateKey);
    throw new Error('Vulnerability: Carol unsealed Bob\'s snapshot');
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('Vulnerability')) throw err;
    if (err instanceof CryptoError && err.code !== 'DECRYPT_FAILED') {
      throw new Error(`Expected DECRYPT_FAILED for Carol, got ${(err as CryptoError).code}`);
    }
  }

  // -- Tampered sealed bytes fail verifySessionShare -------------------------
  const tampered = new Uint8Array(sealed);
  tampered[10] ^= 0xff;

  try {
    await verifySessionShare({
      sessionId: snapshot.sessionId,
      recipientDeviceId: bobBundle.deviceId,
      sealedSnapshot: tampered,
      signerDeviceId: aliceDeviceId,
      signature: shareSig,
      signerEd25519Pub: aliceBundle.ed25519PublicKey,
    });
    throw new Error('Vulnerability: tampered sealed bytes passed verifySessionShare');
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('Vulnerability')) throw err;
    if (err instanceof CryptoError && err.code !== 'CERT_INVALID') {
      throw new Error(`Expected CERT_INVALID for tampered bytes, got ${(err as CryptoError).code}`);
    }
  }

  console.log('PASS: Wrong-recipient unseal — Bob unseals+verifies; Carol rejected; tampered bytes fail verification ✓');
}

run().catch((err) => { console.error('FAIL:', err); process.exit(1); });
