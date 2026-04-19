/**
 * Test 44: Device Cert Chain Verification (v2)
 *
 * Full MSK → SSK (cross-sig) → SSK-signed device cert chain. Tests:
 *   - verifyCrossSigningChain passes with correct sigs
 *   - Swapping to a different SSK pub breaks the chain (CERT_INVALID)
 *   - verifyDeviceIssuance passes for v2 cert via SSK pub
 *   - verifyDeviceIssuance v1 fallback: MSK-signed cert still verifies
 *     even when sskPub is provided (falls back after v2 attempt fails)
 *   - verifyPublicDevice with revocation=null passes; with valid revocation throws DEVICE_REVOKED
 *
 * Run: npx tsx --env-file=.env.local scripts/test-cert-chain-verification.ts
 */

import {
  generateDeviceKeyBundle,
  generateUserMasterKey,
  generateSigningKeys,
  signDeviceIssuance,
  signDeviceIssuanceV2,
  signDeviceRevocationV2,
  verifyDeviceIssuance,
  verifyPublicDevice,
  verifyCrossSigningChain,
  toBase64,
  CryptoError,
  type PublicDevice,
} from '../src/lib/e2ee-core';
import { initCrypto } from './test-utils';

async function run() {
  await initCrypto();

  const userId = crypto.randomUUID();
  const msk    = await generateUserMasterKey();
  const { ssk, usk, sskCrossSignature, uskCrossSignature } = await generateSigningKeys(msk);
  const bundle = await generateDeviceKeyBundle(crypto.randomUUID());
  const createdAtMs = Date.now();

  // -- verifyCrossSigningChain passes with correct chain ---------------------
  await verifyCrossSigningChain({
    mskPub: msk.ed25519PublicKey,
    sskPub: ssk.ed25519PublicKey,
    sskCrossSignature,
    uskPub: usk.ed25519PublicKey,
    uskCrossSignature,
  });

  // -- Swapping SSK pub breaks chain -----------------------------------------
  const impostorSsk = await generateUserMasterKey();
  try {
    await verifyCrossSigningChain({
      mskPub: msk.ed25519PublicKey,
      sskPub: impostorSsk.ed25519PublicKey, // wrong
      sskCrossSignature,
      uskPub: usk.ed25519PublicKey,
      uskCrossSignature,
    });
    throw new Error('Should have thrown for wrong SSK pub');
  } catch (err) {
    if (err instanceof Error && err.message === 'Should have thrown for wrong SSK pub') throw err;
    if (err instanceof CryptoError && err.code !== 'CERT_INVALID') {
      throw new Error(`Expected CERT_INVALID, got ${(err as CryptoError).code}`);
    }
  }

  // -- v2 device cert: SSK-signed -------------------------------------------
  const issuanceFields = {
    userId, deviceId: bundle.deviceId,
    deviceEd25519PublicKey: bundle.ed25519PublicKey,
    deviceX25519PublicKey: bundle.x25519PublicKey,
    createdAtMs,
  };
  const v2Sig = await signDeviceIssuanceV2(issuanceFields, ssk.ed25519PrivateKey);
  await verifyDeviceIssuance(issuanceFields, v2Sig, msk.ed25519PublicKey, ssk.ed25519PublicKey);

  // -- v1 device cert: MSK-signed, still verifies with sskPub provided ------
  const v1Sig = await signDeviceIssuance(issuanceFields, msk.ed25519PrivateKey);
  await verifyDeviceIssuance(issuanceFields, v1Sig, msk.ed25519PublicKey, ssk.ed25519PublicKey);

  // -- verifyPublicDevice: clean device passes -------------------------------
  const cleanDevice: PublicDevice = {
    userId,
    deviceId: bundle.deviceId,
    ed25519PublicKey: bundle.ed25519PublicKey,
    x25519PublicKey: bundle.x25519PublicKey,
    createdAtMs,
    issuanceSignature: v2Sig,
    revocation: null,
  };
  await verifyPublicDevice(cleanDevice, msk.ed25519PublicKey, ssk.ed25519PublicKey);

  // -- verifyPublicDevice: revoked device throws DEVICE_REVOKED --------------
  const revokedAtMs = Date.now();
  const revSig = await signDeviceRevocationV2(
    { userId, deviceId: bundle.deviceId, revokedAtMs },
    ssk.ed25519PrivateKey,
  );
  const revokedDevice: PublicDevice = {
    ...cleanDevice,
    revocation: { revokedAtMs, signature: revSig },
  };
  try {
    await verifyPublicDevice(revokedDevice, msk.ed25519PublicKey, ssk.ed25519PublicKey);
    throw new Error('Should have thrown DEVICE_REVOKED');
  } catch (err) {
    if (err instanceof Error && err.message === 'Should have thrown DEVICE_REVOKED') throw err;
    if (err instanceof CryptoError && err.code !== 'DEVICE_REVOKED') {
      throw new Error(`Expected DEVICE_REVOKED, got ${(err as CryptoError).code}`);
    }
  }

  console.log('PASS: Cert chain verification — full chain passes; wrong SSK breaks chain; v1 fallback works; revocation detected ✓');
}

run().catch((err) => { console.error('FAIL:', err); process.exit(1); });
