/**
 * Test 31: Call Key Envelope Round-Trip
 *
 * Alice generates a CallKey and wraps it for Bob's device using
 * wrapAndSignCallEnvelope. Bob verifies the envelope signature and
 * unwraps the key. A tampered ciphertext must cause verifyCallEnvelope
 * to throw (signature covers the sha256 of ciphertext).
 *
 * Asserts:
 *   - Bob can verify + unwrap the envelope and recover the exact CallKey bytes
 *   - Flipping a byte in the ciphertext causes verifyCallEnvelope to throw
 *   - Wrong sender public key causes verifyCallEnvelope to throw
 *   - zeroCallKey zeros the key in memory (best-effort check)
 *
 * Run: npx tsx --env-file=.env.local scripts/test-call-key-envelope.ts
 */

import {
  generateCallKey,
  wrapAndSignCallEnvelope,
  verifyCallEnvelope,
  unwrapCallKey,
  zeroCallKey,
  generateDeviceKeyBundle,
  toBase64,
} from '../src/lib/e2ee-core';
import { initCrypto } from './test-utils';

async function run() {
  await initCrypto();

  const callId    = crypto.randomUUID();
  const generation = 1;

  // Create Alice's and Bob's device bundles (in-memory, no DB needed)
  const aliceBundle = await generateDeviceKeyBundle(crypto.randomUUID());
  const bobBundle   = await generateDeviceKeyBundle(crypto.randomUUID());

  // -- Alice generates call key and wraps it for Bob ------------------------
  const callKey = await generateCallKey(generation);
  const envelope = await wrapAndSignCallEnvelope({
    callKey,
    callId,
    targetDeviceId:  bobBundle.deviceId,
    targetX25519PublicKey: bobBundle.x25519PublicKey,
    senderDeviceId:  aliceBundle.deviceId,
    senderDeviceEd25519PrivateKey: aliceBundle.ed25519PrivateKey,
  });

  // -- Bob verifies the envelope signature ----------------------------------
  await verifyCallEnvelope(
    {
      callId,
      generation,
      targetDeviceId:  bobBundle.deviceId,
      senderDeviceId:  aliceBundle.deviceId,
      ciphertext: envelope.ciphertext,
    },
    envelope.signature,
    aliceBundle.ed25519PublicKey,
  );

  // -- Bob unwraps the call key ---------------------------------------------
  const unwrapped = await unwrapCallKey(
    envelope.ciphertext,
    generation,
    bobBundle.x25519PublicKey,
    bobBundle.x25519PrivateKey,
  );

  if (await toBase64(unwrapped.key) !== await toBase64(callKey.key)) {
    throw new Error('Unwrapped call key does not match original');
  }
  if (unwrapped.generation !== generation) {
    throw new Error(`Generation mismatch: expected ${generation}, got ${unwrapped.generation}`);
  }

  // -- Tampered ciphertext: verifyCallEnvelope must throw -------------------
  const tamperedCt = new Uint8Array(envelope.ciphertext);
  tamperedCt[5] ^= 0xff;

  try {
    await verifyCallEnvelope(
      { callId, generation, targetDeviceId: bobBundle.deviceId,
        senderDeviceId: aliceBundle.deviceId, ciphertext: tamperedCt },
      envelope.signature,
      aliceBundle.ed25519PublicKey,
    );
    throw new Error('Vulnerability: Tampered ciphertext passed verifyCallEnvelope — signature not binding ciphertext');
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('Vulnerability')) throw err;
    // Expected: SIGNATURE_INVALID
  }

  // -- Wrong sender pubkey: verifyCallEnvelope must throw -------------------
  const impostorBundle = await generateDeviceKeyBundle(crypto.randomUUID());
  try {
    await verifyCallEnvelope(
      { callId, generation, targetDeviceId: bobBundle.deviceId,
        senderDeviceId: aliceBundle.deviceId, ciphertext: envelope.ciphertext },
      envelope.signature,
      impostorBundle.ed25519PublicKey,
    );
    throw new Error('Vulnerability: Wrong sender pubkey passed verifyCallEnvelope');
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('Vulnerability')) throw err;
    // Expected: SIGNATURE_INVALID
  }

  // -- zeroCallKey zeroes the key (best-effort) -----------------------------
  await zeroCallKey(callKey);
  // After zeroing, the key bytes should be all zero (libsodium.memzero)
  const allZero = callKey.key.every((b) => b === 0);
  if (!allZero) {
    throw new Error('zeroCallKey did not zero the key bytes (libsodium.memzero may have no-op\'d)');
  }

  console.log('PASS: Call key envelope — round-trip verified; tampered ct + wrong pubkey rejected; zeroCallKey zeroes bytes ✓');
}

run().catch((err) => { console.error('FAIL:', err); process.exit(1); });
