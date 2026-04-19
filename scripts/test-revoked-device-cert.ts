/**
 * Test 60: Revoked Device Cert Chain Breaks
 *
 * Alice has Dev1 and Dev2. Dev1 signs a revocation cert for Dev2 using SSK.
 * verifyPublicDevice for Dev2 throws DEVICE_REVOKED.
 * verifyPublicDevice for Dev1 (no revocation) still passes.
 * filterActiveDevices returns only Dev1.
 *
 * Also: verifyDeviceRevocation with wrong SSK pub throws CERT_INVALID.
 *
 * Asserts:
 *   - verifyPublicDevice(dev2 with revocation) throws DEVICE_REVOKED
 *   - verifyPublicDevice(dev1, no revocation) passes
 *   - filterActiveDevices([dev1, dev2]) returns [dev1] only
 *   - verifyDeviceRevocation with impostor SSK throws CERT_INVALID
 *
 * Run: npx tsx --env-file=.env.local scripts/test-revoked-device-cert.ts
 */

import {
  generateDeviceKeyBundle,
  generateUserMasterKey,
  generateSigningKeys,
  signDeviceIssuanceV2,
  signDeviceRevocationV2,
  verifyPublicDevice,
  verifyDeviceRevocation,
  filterActiveDevices,
  CryptoError,
  type PublicDevice,
} from '../src/lib/e2ee-core';
import { initCrypto } from './test-utils';

async function run() {
  await initCrypto();

  const userId = crypto.randomUUID();
  const msk    = await generateUserMasterKey();
  const { ssk } = await generateSigningKeys(msk);

  const dev1Bundle = await generateDeviceKeyBundle(crypto.randomUUID());
  const dev2Bundle = await generateDeviceKeyBundle(crypto.randomUUID());
  const createdAtMs = Date.now();

  // Issue certs for both devices
  const dev1Sig = await signDeviceIssuanceV2(
    { userId, deviceId: dev1Bundle.deviceId,
      deviceEd25519PublicKey: dev1Bundle.ed25519PublicKey,
      deviceX25519PublicKey: dev1Bundle.x25519PublicKey, createdAtMs },
    ssk.ed25519PrivateKey,
  );
  const dev2Sig = await signDeviceIssuanceV2(
    { userId, deviceId: dev2Bundle.deviceId,
      deviceEd25519PublicKey: dev2Bundle.ed25519PublicKey,
      deviceX25519PublicKey: dev2Bundle.x25519PublicKey, createdAtMs },
    ssk.ed25519PrivateKey,
  );

  // Revoke Dev2
  const revokedAtMs = Date.now();
  const revSig = await signDeviceRevocationV2(
    { userId, deviceId: dev2Bundle.deviceId, revokedAtMs },
    ssk.ed25519PrivateKey,
  );

  const dev1Public: PublicDevice = {
    userId, deviceId: dev1Bundle.deviceId,
    ed25519PublicKey: dev1Bundle.ed25519PublicKey,
    x25519PublicKey: dev1Bundle.x25519PublicKey,
    createdAtMs, issuanceSignature: dev1Sig, revocation: null,
  };
  const dev2Public: PublicDevice = {
    userId, deviceId: dev2Bundle.deviceId,
    ed25519PublicKey: dev2Bundle.ed25519PublicKey,
    x25519PublicKey: dev2Bundle.x25519PublicKey,
    createdAtMs, issuanceSignature: dev2Sig,
    revocation: { revokedAtMs, signature: revSig },
  };

  // -- Dev1 passes verifyPublicDevice ----------------------------------------
  await verifyPublicDevice(dev1Public, msk.ed25519PublicKey, ssk.ed25519PublicKey);

  // -- Dev2 throws DEVICE_REVOKED -------------------------------------------
  try {
    await verifyPublicDevice(dev2Public, msk.ed25519PublicKey, ssk.ed25519PublicKey);
    throw new Error('Should have thrown DEVICE_REVOKED for Dev2');
  } catch (err) {
    if (err instanceof Error && err.message === 'Should have thrown DEVICE_REVOKED for Dev2') throw err;
    if (err instanceof CryptoError && err.code !== 'DEVICE_REVOKED') {
      throw new Error(`Expected DEVICE_REVOKED, got ${(err as CryptoError).code}`);
    }
  }

  // -- filterActiveDevices returns only Dev1 ---------------------------------
  const active = await filterActiveDevices(
    [dev1Public, dev2Public],
    msk.ed25519PublicKey,
    ssk.ed25519PublicKey,
  );
  if (active.length !== 1 || active[0].deviceId !== dev1Bundle.deviceId) {
    throw new Error(`filterActiveDevices returned wrong devices: ${active.map((d) => d.deviceId)}`);
  }

  // -- verifyDeviceRevocation with impostor SSK throws ----------------------
  const impostorSsk = await generateUserMasterKey();
  try {
    await verifyDeviceRevocation(
      { userId, deviceId: dev2Bundle.deviceId, revokedAtMs },
      revSig,
      msk.ed25519PublicKey,
      impostorSsk.ed25519PublicKey,
    );
    throw new Error('Impostor SSK should have failed revocation verify');
  } catch (err) {
    if (err instanceof Error && err.message === 'Impostor SSK should have failed revocation verify') throw err;
    if (err instanceof CryptoError && err.code !== 'CERT_INVALID') {
      throw new Error(`Expected CERT_INVALID for impostor SSK, got ${(err as CryptoError).code}`);
    }
  }

  console.log('PASS: Revoked device cert — Dev1 passes; Dev2 DEVICE_REVOKED; filterActiveDevices returns 1; impostor SSK rejected ✓');
}

run().catch((err) => { console.error('FAIL:', err); process.exit(1); });
