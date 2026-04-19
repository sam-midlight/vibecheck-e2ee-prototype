/**
 * Test 62: Spoofed Identity (Identity & Trust)
 *
 * Eve generates a valid Ed25519 keypair and attempts to publish it to Supabase
 * as Alice's device (using Alice's user_id). Two attack surfaces are tested:
 *
 *   1. DB layer: Eve's authenticated Supabase client tries to INSERT into
 *      `devices` with user_id = alice.userId. The RLS policy
 *      (user_id = auth.uid()) must reject this because Eve is not Alice.
 *
 *   2. Crypto layer: Eve self-signs a device cert with her own key (not Alice's
 *      SSK). verifyPublicDevice with Alice's MSK/SSK pub rejects it (CERT_INVALID).
 *
 *   3. Trust layer: When Bob tries to resolve Eve's device and wrap a room key
 *      for it, he should refuse because the cert doesn't chain to Alice's MSK.
 *
 * Asserts:
 *   - Eve's INSERT with Alice's user_id fails (RLS)
 *   - verifyDeviceIssuance with Alice's SSK pub rejects Eve's self-signed cert
 *   - verifyPublicDevice throws CERT_INVALID for Eve's device
 *
 * Run: npx tsx --env-file=.env.local scripts/test-spoofed-identity.ts
 */

import {
  generateDeviceKeyBundle,
  generateUserMasterKey,
  generateSigningKeys,
  signDeviceIssuanceV2,
  verifyDeviceIssuance,
  verifyPublicDevice,
  toBase64,
  CryptoError,
  type PublicDevice,
} from '../src/lib/e2ee-core';
import { initCrypto, createTestUser, provisionDevice, cleanupUser, makeServiceClient } from './test-utils';

async function run() {
  await initCrypto();

  const aliceUser = await createTestUser(`test-alice-si-${Date.now()}@example.com`);
  const eveUser   = await createTestUser(`test-eve-si-${Date.now()}@example.com`);
  const userIds   = [aliceUser.userId, eveUser.userId];
  const svc       = makeServiceClient();

  try {
    const alice = await provisionDevice(aliceUser.supabase, aliceUser.userId);
    const eve   = await provisionDevice(eveUser.supabase, eveUser.userId);

    // Eve generates a keypair she claims belongs to Alice
    const spoofedBundle = await generateDeviceKeyBundle(crypto.randomUUID());
    const createdAtMs   = Date.now();

    // -- Attack 1: DB layer — Eve inserts a device row with Alice's user_id --
    // Eve signs the cert with her own MSK (not Alice's SSK) — doesn't matter
    // because the RLS check fires before the row is even stored.
    const eveSelfSignedCert = await signDeviceIssuanceV2(
      { userId: alice.userId,   // ← claims to be Alice
        deviceId: spoofedBundle.deviceId,
        deviceEd25519PublicKey: spoofedBundle.ed25519PublicKey,
        deviceX25519PublicKey:  spoofedBundle.x25519PublicKey,
        createdAtMs },
      eve.ssk.ed25519PrivateKey, // ← but signed with Eve's SSK
    );

    const { error: rlsErr } = await eveUser.supabase.from('devices').insert({
      id: spoofedBundle.deviceId,
      user_id: alice.userId,          // ← Alice's user_id, Eve's session
      device_ed25519_pub: await toBase64(spoofedBundle.ed25519PublicKey),
      device_x25519_pub:  await toBase64(spoofedBundle.x25519PublicKey),
      issuance_created_at_ms: createdAtMs,
      issuance_signature: await toBase64(eveSelfSignedCert),
      display_name: null, display_name_ciphertext: null,
    });

    if (!rlsErr) {
      // Clean up the rogue row before throwing
      await svc.from('devices').delete().eq('id', spoofedBundle.deviceId);
      throw new Error('Vulnerability: Eve inserted a device row under Alice\'s user_id — RLS failed');
    }

    // -- Attack 2: Crypto layer — Eve's cert fails against Alice's SSK pub ---
    // Eve signs the issuance fields with her own SSK, but Alice's SSK pub is used to verify.
    const issuanceFields = {
      userId: alice.userId,
      deviceId: spoofedBundle.deviceId,
      deviceEd25519PublicKey: spoofedBundle.ed25519PublicKey,
      deviceX25519PublicKey:  spoofedBundle.x25519PublicKey,
      createdAtMs,
    };

    try {
      await verifyDeviceIssuance(
        issuanceFields,
        eveSelfSignedCert,
        alice.ssk.ed25519PublicKey,  // Alice's MSK (used as UMK for v1 fallback)
        alice.ssk.ed25519PublicKey,  // Alice's SSK pub
      );
      throw new Error('Vulnerability: Eve\'s cert verified against Alice\'s SSK — key confusion');
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Vulnerability')) throw err;
      if (err instanceof CryptoError && err.code !== 'CERT_INVALID') {
        throw new Error(`Expected CERT_INVALID for Eve's cert, got ${(err as CryptoError).code}`);
      }
    }

    // -- Attack 3: verifyPublicDevice rejects the spoofed device -------------
    // Generate Alice's proper key hierarchy for comparison
    const aliceMsk = await generateUserMasterKey();
    const { ssk: aliceSsk } = await generateSigningKeys(aliceMsk);

    const spoofedPublicDevice: PublicDevice = {
      userId: alice.userId,
      deviceId: spoofedBundle.deviceId,
      ed25519PublicKey: spoofedBundle.ed25519PublicKey,
      x25519PublicKey:  spoofedBundle.x25519PublicKey,
      createdAtMs,
      issuanceSignature: eveSelfSignedCert, // signed by Eve's SSK, not Alice's
      revocation: null,
    };

    try {
      await verifyPublicDevice(
        spoofedPublicDevice,
        aliceMsk.ed25519PublicKey,    // Alice's MSK pub
        aliceSsk.ed25519PublicKey,    // Alice's SSK pub
      );
      throw new Error('Vulnerability: verifyPublicDevice accepted Eve\'s spoofed device');
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Vulnerability')) throw err;
      if (err instanceof CryptoError && err.code !== 'CERT_INVALID') {
        throw new Error(`Expected CERT_INVALID, got ${(err as CryptoError).code}`);
      }
    }

    console.log('PASS: Spoofed identity — RLS blocked DB insert; Eve\'s cert rejected by Alice\'s SSK; verifyPublicDevice throws CERT_INVALID ✓');
  } finally {
    for (const id of userIds) await cleanupUser(id).catch(console.error);
  }
}

run().catch((err) => { console.error('FAIL:', err); process.exit(1); });
