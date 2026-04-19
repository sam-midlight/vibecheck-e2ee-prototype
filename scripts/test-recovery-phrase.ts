/**
 * Test 29: Recovery Phrase v4 Round-Trip
 *
 * Generate a 24-word BIP-39 phrase, wrap a full v4 identity payload
 * (MSK + SSK + USK + backupKey) under it, then unwrap and verify:
 *   - All four key materials are recovered correctly
 *   - A wrong phrase throws DECRYPT_FAILED
 *   - isPhraseValid rejects a bad/corrupted word
 *   - normalizePhrase strips common list decorations
 *   - pickVerificationIndices produces the expected count and sorted order
 *
 * Run: npx tsx --env-file=.env.local scripts/test-recovery-phrase.ts
 */

import {
  generateUserMasterKey,
  generateSigningKeys,
  generateBackupKey,
  generateRecoveryPhrase,
  wrapUserMasterKeyWithPhrase,
  unwrapUserMasterKeyWithPhrase,
  isPhraseValid,
  normalizePhrase,
  pickVerificationIndices,
  toBase64,
  randomBytes,
} from '../src/lib/e2ee-core';
import { initCrypto } from './test-utils';

async function run() {
  await initCrypto();

  // -- Generate a v4 identity bundle -----------------------------------------
  const msk = await generateUserMasterKey();
  const { ssk, usk } = await generateSigningKeys(msk);
  const backupKey = await generateBackupKey();

  const phrase = generateRecoveryPhrase();
  const words  = phrase.split(' ');
  if (words.length !== 24) throw new Error(`Expected 24-word phrase, got ${words.length}`);
  if (!isPhraseValid(phrase)) throw new Error('Generated phrase fails BIP-39 checksum');

  const userId = crypto.randomUUID();

  // Use deliberately low KDF params so the test runs quickly
  const blob = await wrapUserMasterKeyWithPhrase(msk, phrase, userId, {
    opslimit: 1,
    memlimit: 8 * 1024 * 1024, // 8 MiB — libsodium minimum
    backupKey,
    sskPriv: ssk.ed25519PrivateKey,
    uskPriv: usk.ed25519PrivateKey,
  });

  // -- Unwrap with correct phrase --------------------------------------------
  const result = await unwrapUserMasterKeyWithPhrase(blob, phrase, userId);

  // v4 blob → all four fields present
  if (!result.sskPriv || !result.uskPriv || !result.backupKey) {
    throw new Error('v4 unwrap missing sskPriv / uskPriv / backupKey');
  }

  // Verify recovered MSK priv matches
  if (await toBase64(result.ed25519PrivateKey) !== await toBase64(msk.ed25519PrivateKey)) {
    throw new Error('Recovered MSK priv does not match original');
  }
  if (await toBase64(result.sskPriv) !== await toBase64(ssk.ed25519PrivateKey)) {
    throw new Error('Recovered SSK priv does not match original');
  }
  if (await toBase64(result.uskPriv) !== await toBase64(usk.ed25519PrivateKey)) {
    throw new Error('Recovered USK priv does not match original');
  }
  if (await toBase64(result.backupKey) !== await toBase64(backupKey)) {
    throw new Error('Recovered backup key does not match original');
  }

  // -- Wrong phrase throws ---------------------------------------------------
  const wrongPhrase = generateRecoveryPhrase(); // fresh random phrase
  try {
    await unwrapUserMasterKeyWithPhrase(blob, wrongPhrase, userId);
    throw new Error('Vulnerability: Wrong phrase decrypted the recovery blob');
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('Vulnerability')) throw err;
    // Expected: DECRYPT_FAILED
  }

  // -- isPhraseValid rejects a corrupted word --------------------------------
  const badWords = [...words];
  badWords[3] = 'xyznotaword';
  if (isPhraseValid(badWords.join(' '))) {
    throw new Error('isPhraseValid returned true for a phrase with an invalid word');
  }

  // -- normalizePhrase strips numbered-list decorations ----------------------
  const decorated = words.map((w, i) => `${i + 1}. ${w}`).join(' ');
  const stripped  = normalizePhrase(decorated);
  if (stripped !== phrase.toLowerCase()) {
    throw new Error(`normalizePhrase failed: got "${stripped.slice(0, 40)}…"`);
  }

  // -- pickVerificationIndices returns sorted 1-based indices ----------------
  const rng = await randomBytes(32);
  const indices = pickVerificationIndices(24, 3, rng);
  if (indices.length !== 3) throw new Error(`Expected 3 indices, got ${indices.length}`);
  for (const idx of indices) {
    if (idx < 1 || idx > 24) throw new Error(`Index ${idx} out of range [1, 24]`);
  }
  if (!indices.every((v, i) => i === 0 || v > indices[i - 1])) {
    throw new Error(`Indices not sorted: ${indices.join(', ')}`);
  }

  console.log('PASS: Recovery phrase v4 round-trip — MSK+SSK+USK+backup recovered; wrong phrase throws; validation works ✓');
}

run().catch((err) => { console.error('FAIL:', err); process.exit(1); });
