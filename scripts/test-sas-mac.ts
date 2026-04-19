/**
 * Test 68: SAS MAC Verification (Cryptographic Integrity)
 *
 * The SAS protocol's MAC step (src/lib/e2ee-core/sas.ts:computeSasMac /
 * verifySasMac) is the cryptographic defense against a MITM who substituted
 * an ephemeral pub mid-flight. T45 only exercises signUserMsk — the
 * post-SAS cross-signing. This test covers the commitment + shared-secret +
 * emoji-divergence + MAC tamper-detection that T45 does not.
 *
 * Scenarios:
 *   1. Happy path: Alice + Bob exchange commitments, reveal ephemerals, derive
 *      the same 7 emoji, exchange + verify MACs both directions.
 *   2. Commitment mismatch: revealed ephemeral pub that doesn't match the
 *      committed hash → verifySasCommitment returns false.
 *   3. MITM-substituted ephemeral: Eve swaps Bob's ephemeral pub after the
 *      commit/reveal → Alice and Bob derive DIFFERENT emoji arrays. (The only
 *      cryptographic detection since Bob does not commit to his ephemeral.)
 *   4. Tampered MAC: single-byte flip → verifySasMac returns false.
 *   5. Wrong-identity MAC: MAC computed over Alice's identity but verifier
 *      claims it's Bob's → verifySasMac returns false.
 *
 * Run: npx tsx --env-file=.env.local scripts/test-sas-mac.ts
 */

import {
  generateSasCommitment,
  verifySasCommitment,
  computeSasSharedSecret,
  deriveSasEmoji,
  computeSasMac,
  verifySasMac,
  generateUserMasterKey,
  generateDeviceKeyBundle,
} from '../src/lib/e2ee-core';
import { initCrypto } from './test-utils';

async function run() {
  await initCrypto();

  // Alice + Bob each have an MSK (the identity being verified) and a device
  // bundle (the device doing the verification — commitment binds ephemeral to
  // device ed pub so a MITM can't replay the commit with a different device).
  const aliceMsk = await generateUserMasterKey();
  const bobMsk   = await generateUserMasterKey();
  const aliceDev = await generateDeviceKeyBundle(crypto.randomUUID());
  const bobDev   = await generateDeviceKeyBundle(crypto.randomUUID());

  // ── Scenario 1: happy path ────────────────────────────────────────────────
  const aliceCommit = await generateSasCommitment(aliceDev.ed25519PublicKey);
  const bobCommit   = await generateSasCommitment(bobDev.ed25519PublicKey);

  // Alice sends commitment, Bob sends his ephemeral pub.
  // Alice reveals her ephemeral pub; Bob verifies the commitment.
  const bobVerifiesAlicesCommit = await verifySasCommitment(
    aliceCommit.commitment,
    aliceCommit.ephemeralPub,
    aliceDev.ed25519PublicKey,
  );
  if (!bobVerifiesAlicesCommit) {
    throw new Error('Scenario 1: Bob failed to verify Alice\'s legitimate commitment');
  }

  // Shared secret — must be equal both sides (X25519 is symmetric).
  const aliceSs = await computeSasSharedSecret(aliceCommit.ephemeralPriv, bobCommit.ephemeralPub);
  const bobSs   = await computeSasSharedSecret(bobCommit.ephemeralPriv,   aliceCommit.ephemeralPub);
  if (!aliceSs.every((b, i) => b === bobSs[i])) {
    throw new Error('Scenario 1: shared secrets diverged in honest protocol run');
  }

  // Emoji — must be equal both sides.
  const aliceEmoji = await deriveSasEmoji({
    sharedSecret: aliceSs,
    aliceMskPub: aliceMsk.ed25519PublicKey,
    bobMskPub:   bobMsk.ed25519PublicKey,
    aliceEphemeralPub: aliceCommit.ephemeralPub,
    bobEphemeralPub:   bobCommit.ephemeralPub,
  });
  const bobEmoji = await deriveSasEmoji({
    sharedSecret: bobSs,
    aliceMskPub: aliceMsk.ed25519PublicKey,
    bobMskPub:   bobMsk.ed25519PublicKey,
    aliceEphemeralPub: aliceCommit.ephemeralPub,
    bobEphemeralPub:   bobCommit.ephemeralPub,
  });
  if (aliceEmoji.length !== 7 || bobEmoji.length !== 7) {
    throw new Error(`Scenario 1: expected 7 emoji each, got ${aliceEmoji.length} / ${bobEmoji.length}`);
  }
  if (aliceEmoji.some((e, i) => e !== bobEmoji[i])) {
    throw new Error(`Scenario 1: emoji diverged — Alice=${aliceEmoji.join('')} Bob=${bobEmoji.join('')}`);
  }

  // MAC exchange — each side MACs their OWN identity; other side verifies.
  const aliceMac = await computeSasMac({
    sharedSecret: aliceSs,
    ownMskPub: aliceMsk.ed25519PublicKey,
    ownDeviceEdPub: aliceDev.ed25519PublicKey,
  });
  const bobMac = await computeSasMac({
    sharedSecret: bobSs,
    ownMskPub: bobMsk.ed25519PublicKey,
    ownDeviceEdPub: bobDev.ed25519PublicKey,
  });

  const bobVerifiesAliceMac = await verifySasMac({
    sharedSecret: bobSs,
    otherMskPub: aliceMsk.ed25519PublicKey,
    otherDeviceEdPub: aliceDev.ed25519PublicKey,
    mac: aliceMac,
  });
  const aliceVerifiesBobMac = await verifySasMac({
    sharedSecret: aliceSs,
    otherMskPub: bobMsk.ed25519PublicKey,
    otherDeviceEdPub: bobDev.ed25519PublicKey,
    mac: bobMac,
  });
  if (!bobVerifiesAliceMac || !aliceVerifiesBobMac) {
    throw new Error(`Scenario 1: honest MAC exchange failed (bob→alice=${bobVerifiesAliceMac}, alice→bob=${aliceVerifiesBobMac})`);
  }

  // ── Scenario 2: commitment mismatch ───────────────────────────────────────
  // Attacker reveals a different ephemeral pub than the one committed.
  const fakeEphCommit = await generateSasCommitment(aliceDev.ed25519PublicKey);
  const commitMismatch = await verifySasCommitment(
    aliceCommit.commitment,                // Alice's committed hash
    fakeEphCommit.ephemeralPub,            // but a different ephemeral revealed
    aliceDev.ed25519PublicKey,
  );
  if (commitMismatch) {
    throw new Error('Scenario 2: verifySasCommitment accepted a revealed pub that did not match the committed hash');
  }

  // ── Scenario 3: MITM-substituted ephemeral → emoji diverge ────────────────
  // Eve replaces Bob's ephemeral pub mid-flight. Bob doesn't commit, so
  // there's no commitment check to fail. The only defense is emoji divergence.
  const eveCommit = await generateSasCommitment(bobDev.ed25519PublicKey);

  // Alice sees Eve's ephemeral (thinking it's Bob's):
  const aliceSsWithEve = await computeSasSharedSecret(aliceCommit.ephemeralPriv, eveCommit.ephemeralPub);
  const aliceEmojiWithEve = await deriveSasEmoji({
    sharedSecret: aliceSsWithEve,
    aliceMskPub: aliceMsk.ed25519PublicKey,
    bobMskPub:   bobMsk.ed25519PublicKey,
    aliceEphemeralPub: aliceCommit.ephemeralPub,
    bobEphemeralPub:   eveCommit.ephemeralPub,  // what Alice thinks she saw
  });

  // Bob still sees Alice's legitimate ephemeral; bobMskPub/bobEphemeralPub
  // unchanged (Bob has no idea Eve interposed). Bob's emoji from scenario 1
  // is the reference — compare against it.
  if (aliceEmojiWithEve.every((e, i) => e === bobEmoji[i])) {
    throw new Error('Scenario 3: emoji collided under MITM — cryptographic defense failed');
  }

  // ── Scenario 4: tampered MAC ──────────────────────────────────────────────
  const tamperedAliceMac = new Uint8Array(aliceMac);
  tamperedAliceMac[0] ^= 0x01;  // flip one bit
  const tamperedVerify = await verifySasMac({
    sharedSecret: bobSs,
    otherMskPub: aliceMsk.ed25519PublicKey,
    otherDeviceEdPub: aliceDev.ed25519PublicKey,
    mac: tamperedAliceMac,
  });
  if (tamperedVerify) {
    throw new Error('Scenario 4: verifySasMac accepted a MAC with a flipped byte');
  }

  // ── Scenario 5: MAC over one identity, verified as another ────────────────
  // Alice's MAC binds (aliceMsk, aliceDev). If verifier substitutes Bob's
  // identity claim, the HMAC input diverges → verification fails. This is
  // what stops a MITM from relaying a legitimate MAC under a forged identity.
  const wrongIdentityVerify = await verifySasMac({
    sharedSecret: bobSs,
    otherMskPub: bobMsk.ed25519PublicKey,       // wrong — Alice signed her own
    otherDeviceEdPub: aliceDev.ed25519PublicKey,
    mac: aliceMac,
  });
  if (wrongIdentityVerify) {
    throw new Error('Scenario 5: verifySasMac accepted Alice\'s MAC under Bob\'s MSK claim');
  }

  console.log('PASS: SAS MAC — commitment/emoji/MAC all tamper-detect; MITM ephemeral diverges emoji ✓');
}

run().catch((err) => { console.error('FAIL:', err); process.exit(1); });
