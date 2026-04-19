/**
 * Test 45: USK Cross-Sign Verification
 *
 * Alice's USK signs Bob's MSK pub (the SAS post-verification write).
 * verifyUserMskSignature passes. Negative cases:
 *   - Wrong USK pub → CERT_INVALID
 *   - Wrong signerMskPub → CERT_INVALID (domain binding)
 *   - Wrong signedMskPub → CERT_INVALID
 *   - Wrong timestamp → CERT_INVALID
 *
 * Run: npx tsx --env-file=.env.local scripts/test-usk-cross-sign.ts
 */

import {
  generateUserMasterKey,
  generateSigningKeys,
  signUserMsk,
  verifyUserMskSignature,
  CryptoError,
} from '../src/lib/e2ee-core';
import { initCrypto } from './test-utils';

async function run() {
  await initCrypto();

  const aliceMsk = await generateUserMasterKey();
  const bobMsk   = await generateUserMasterKey();
  const { ssk: aliceSsk, usk: aliceUsk } = await generateSigningKeys(aliceMsk);
  const timestamp = Date.now();

  // -- Positive: Alice's USK signs Bob's MSK ---------------------------------
  const sig = await signUserMsk({
    signerMskPub: aliceMsk.ed25519PublicKey,
    signedMskPub: bobMsk.ed25519PublicKey,
    uskPriv: aliceUsk.ed25519PrivateKey,
    timestamp,
  });

  await verifyUserMskSignature({
    signerMskPub: aliceMsk.ed25519PublicKey,
    signedMskPub: bobMsk.ed25519PublicKey,
    uskPub: aliceUsk.ed25519PublicKey,
    signature: sig,
    timestamp,
  });

  // -- Wrong USK pub ---------------------------------------------------------
  const impostorUsk = await generateUserMasterKey();
  try {
    await verifyUserMskSignature({
      signerMskPub: aliceMsk.ed25519PublicKey,
      signedMskPub: bobMsk.ed25519PublicKey,
      uskPub: impostorUsk.ed25519PublicKey,
      signature: sig,
      timestamp,
    });
    throw new Error('Wrong USK pub should have thrown');
  } catch (err) {
    if (err instanceof Error && err.message === 'Wrong USK pub should have thrown') throw err;
    if (err instanceof CryptoError && err.code !== 'CERT_INVALID') {
      throw new Error(`Expected CERT_INVALID for wrong USK, got ${(err as CryptoError).code}`);
    }
  }

  // -- Wrong signerMskPub ----------------------------------------------------
  const impostorMsk = await generateUserMasterKey();
  try {
    await verifyUserMskSignature({
      signerMskPub: impostorMsk.ed25519PublicKey, // different signer MSK in domain
      signedMskPub: bobMsk.ed25519PublicKey,
      uskPub: aliceUsk.ed25519PublicKey,
      signature: sig,
      timestamp,
    });
    throw new Error('Wrong signerMskPub should have thrown');
  } catch (err) {
    if (err instanceof Error && err.message === 'Wrong signerMskPub should have thrown') throw err;
    if (err instanceof CryptoError && err.code !== 'CERT_INVALID') {
      throw new Error(`Expected CERT_INVALID for wrong signerMsk, got ${(err as CryptoError).code}`);
    }
  }

  // -- Wrong signedMskPub ----------------------------------------------------
  try {
    await verifyUserMskSignature({
      signerMskPub: aliceMsk.ed25519PublicKey,
      signedMskPub: impostorMsk.ed25519PublicKey, // different target
      uskPub: aliceUsk.ed25519PublicKey,
      signature: sig,
      timestamp,
    });
    throw new Error('Wrong signedMskPub should have thrown');
  } catch (err) {
    if (err instanceof Error && err.message === 'Wrong signedMskPub should have thrown') throw err;
    if (err instanceof CryptoError && err.code !== 'CERT_INVALID') {
      throw new Error(`Expected CERT_INVALID for wrong signedMsk, got ${(err as CryptoError).code}`);
    }
  }

  // -- Wrong timestamp -------------------------------------------------------
  try {
    await verifyUserMskSignature({
      signerMskPub: aliceMsk.ed25519PublicKey,
      signedMskPub: bobMsk.ed25519PublicKey,
      uskPub: aliceUsk.ed25519PublicKey,
      signature: sig,
      timestamp: timestamp + 1,
    });
    throw new Error('Wrong timestamp should have thrown');
  } catch (err) {
    if (err instanceof Error && err.message === 'Wrong timestamp should have thrown') throw err;
    if (err instanceof CryptoError && err.code !== 'CERT_INVALID') {
      throw new Error(`Expected CERT_INVALID for wrong timestamp, got ${(err as CryptoError).code}`);
    }
  }

  console.log('PASS: USK cross-sign — positive verifies; wrong USK / wrong signerMsk / wrong signedMsk / wrong ts all throw CERT_INVALID ✓');
}

run().catch((err) => { console.error('FAIL:', err); process.exit(1); });
