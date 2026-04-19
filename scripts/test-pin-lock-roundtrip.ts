/**
 * Test 43: PIN Lock Round-Trip
 *
 * wrapDeviceStateWithPin / unwrapDeviceStateWithPin round-trip. Tests:
 *   - Correct passphrase recovers identical deviceBundle + MSK
 *   - Wrong passphrase throws DECRYPT_FAILED
 *   - v3 format (with SSK + USK) round-trips all keys
 *   - Short passphrase (< 4 chars) throws BAD_INPUT
 *
 * Run: npx tsx --env-file=.env.local scripts/test-pin-lock-roundtrip.ts
 */

import {
  generateDeviceKeyBundle,
  generateUserMasterKey,
  generateSigningKeys,
  wrapDeviceStateWithPin,
  unwrapDeviceStateWithPin,
  toBase64,
  CryptoError,
} from '../src/lib/e2ee-core';
import { initCrypto } from './test-utils';

async function run() {
  await initCrypto();

  const userId      = crypto.randomUUID();
  const deviceBundle = await generateDeviceKeyBundle(crypto.randomUUID());
  const msk          = await generateUserMasterKey();
  const signingKeys  = await generateSigningKeys(msk);
  const PASSPHRASE   = 'hunter2!';

  // -- v3 round-trip (with MSK, SSK, USK) ------------------------------------
  const wrapped = await wrapDeviceStateWithPin(
    deviceBundle,
    msk,
    PASSPHRASE,
    userId,
    {
      opslimit: 1,
      memlimit: 8 * 1024 * 1024,
      ssk: signingKeys.ssk,
      usk: signingKeys.usk,
    },
  );

  const unlocked = await unwrapDeviceStateWithPin(wrapped, PASSPHRASE, userId);

  // Verify deviceBundle fields
  if (await toBase64(unlocked.deviceBundle.ed25519PublicKey) !== await toBase64(deviceBundle.ed25519PublicKey)) {
    throw new Error('DeviceBundle ed25519PublicKey mismatch after PIN unwrap');
  }
  if (await toBase64(unlocked.deviceBundle.x25519PublicKey) !== await toBase64(deviceBundle.x25519PublicKey)) {
    throw new Error('DeviceBundle x25519PublicKey mismatch after PIN unwrap');
  }
  if (unlocked.deviceBundle.deviceId !== deviceBundle.deviceId) {
    throw new Error('DeviceBundle deviceId mismatch after PIN unwrap');
  }

  // Verify MSK
  if (!unlocked.umk) throw new Error('MSK missing from unlocked state');
  if (await toBase64(unlocked.umk.ed25519PublicKey) !== await toBase64(msk.ed25519PublicKey)) {
    throw new Error('MSK ed25519PublicKey mismatch');
  }

  // Verify SSK
  if (!unlocked.ssk) throw new Error('SSK missing from unlocked state');
  if (await toBase64(unlocked.ssk.ed25519PublicKey) !== await toBase64(signingKeys.ssk.ed25519PublicKey)) {
    throw new Error('SSK ed25519PublicKey mismatch');
  }

  // Verify USK
  if (!unlocked.usk) throw new Error('USK missing from unlocked state');
  if (await toBase64(unlocked.usk.ed25519PublicKey) !== await toBase64(signingKeys.usk.ed25519PublicKey)) {
    throw new Error('USK ed25519PublicKey mismatch');
  }

  // -- Wrong passphrase throws DECRYPT_FAILED --------------------------------
  try {
    await unwrapDeviceStateWithPin(wrapped, 'wrongpass', userId);
    throw new Error('Should have thrown on wrong passphrase');
  } catch (err) {
    if (err instanceof Error && err.message === 'Should have thrown on wrong passphrase') throw err;
    if (err instanceof CryptoError && err.code !== 'DECRYPT_FAILED') {
      throw new Error(`Expected DECRYPT_FAILED, got ${(err as CryptoError).code}`);
    }
  }

  // -- Wrong userId throws DECRYPT_FAILED (AD mismatch) ---------------------
  try {
    await unwrapDeviceStateWithPin(wrapped, PASSPHRASE, crypto.randomUUID());
    throw new Error('Should have thrown on wrong userId');
  } catch (err) {
    if (err instanceof Error && err.message === 'Should have thrown on wrong userId') throw err;
    if (err instanceof CryptoError && err.code !== 'DECRYPT_FAILED') {
      throw new Error(`Expected DECRYPT_FAILED, got ${(err as CryptoError).code}`);
    }
  }

  // -- Short passphrase throws BAD_INPUT ------------------------------------
  try {
    await wrapDeviceStateWithPin(deviceBundle, msk, 'ab', userId);
    throw new Error('Should have thrown on short passphrase');
  } catch (err) {
    if (err instanceof Error && err.message === 'Should have thrown on short passphrase') throw err;
    if (err instanceof CryptoError && err.code !== 'BAD_INPUT') {
      throw new Error(`Expected BAD_INPUT for short passphrase, got ${(err as CryptoError).code}`);
    }
  }

  console.log('PASS: PIN lock round-trip — v3 keys recovered; wrong passphrase + wrong userId + short passphrase all throw ✓');
}

run().catch((err) => { console.error('FAIL:', err); process.exit(1); });
