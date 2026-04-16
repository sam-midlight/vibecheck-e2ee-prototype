/**
 * Cross-signing primitives (Matrix-aligned).
 *
 * MSK signs SSK-pub and USK-pub via cross-signatures. Verifiers chain:
 *   device cert (v2) → SSK → MSK cross-sig → MSK (TOFU anchor)
 *
 * Canonical byte layouts:
 *
 *   SSK cross-sig:
 *     "vibecheck:crosssig:ssk:v1" (26) || msk_pub(32) || ssk_pub(32)  = 90 bytes
 *
 *   USK cross-sig:
 *     "vibecheck:crosssig:usk:v1" (26) || msk_pub(32) || usk_pub(32)  = 90 bytes
 */

import {
  CryptoError,
  type Bytes,
  type MasterSigningKey,
  type SelfSigningKey,
  type UserSigningKey,
} from './types';
import { concatBytes, getSodium, stringToBytes } from './sodium';
import { signMessage, verifyMessageOrThrow } from './identity';

const SSK_CROSS_DOMAIN = stringToBytes('vibecheck:crosssig:ssk:v1');
const USK_CROSS_DOMAIN = stringToBytes('vibecheck:crosssig:usk:v1');

// ---------------------------------------------------------------------------
// Canonical messages
// ---------------------------------------------------------------------------

function canonicalSskCrossMessage(mskPub: Bytes, sskPub: Bytes): Bytes {
  return concatBytes(SSK_CROSS_DOMAIN, mskPub, sskPub);
}

function canonicalUskCrossMessage(mskPub: Bytes, uskPub: Bytes): Bytes {
  return concatBytes(USK_CROSS_DOMAIN, mskPub, uskPub);
}

// ---------------------------------------------------------------------------
// Sign / verify SSK cross-signature
// ---------------------------------------------------------------------------

export async function signSskCrossSignature(
  mskPriv: Bytes,
  mskPub: Bytes,
  sskPub: Bytes,
): Promise<Bytes> {
  return signMessage(canonicalSskCrossMessage(mskPub, sskPub), mskPriv);
}

export async function verifySskCrossSignature(
  mskPub: Bytes,
  sskPub: Bytes,
  signature: Bytes,
): Promise<void> {
  try {
    await verifyMessageOrThrow(
      canonicalSskCrossMessage(mskPub, sskPub),
      signature,
      mskPub,
    );
  } catch (err) {
    if (err instanceof CryptoError && err.code === 'SIGNATURE_INVALID') {
      throw new CryptoError(
        'SSK cross-signature did not verify against MSK',
        'CERT_INVALID',
      );
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Sign / verify USK cross-signature
// ---------------------------------------------------------------------------

export async function signUskCrossSignature(
  mskPriv: Bytes,
  mskPub: Bytes,
  uskPub: Bytes,
): Promise<Bytes> {
  return signMessage(canonicalUskCrossMessage(mskPub, uskPub), mskPriv);
}

export async function verifyUskCrossSignature(
  mskPub: Bytes,
  uskPub: Bytes,
  signature: Bytes,
): Promise<void> {
  try {
    await verifyMessageOrThrow(
      canonicalUskCrossMessage(mskPub, uskPub),
      signature,
      mskPub,
    );
  } catch (err) {
    if (err instanceof CryptoError && err.code === 'SIGNATURE_INVALID') {
      throw new CryptoError(
        'USK cross-signature did not verify against MSK',
        'CERT_INVALID',
      );
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Generate SSK + USK + cross-sigs in one call
// ---------------------------------------------------------------------------

export interface GeneratedSigningKeys {
  ssk: SelfSigningKey;
  usk: UserSigningKey;
  sskCrossSignature: Bytes;
  uskCrossSignature: Bytes;
}

export async function generateSigningKeys(
  msk: MasterSigningKey,
): Promise<GeneratedSigningKeys> {
  const sodium = await getSodium();
  const sskPair = sodium.crypto_sign_keypair();
  const uskPair = sodium.crypto_sign_keypair();

  const ssk: SelfSigningKey = {
    ed25519PublicKey: sskPair.publicKey,
    ed25519PrivateKey: sskPair.privateKey,
  };
  const usk: UserSigningKey = {
    ed25519PublicKey: uskPair.publicKey,
    ed25519PrivateKey: uskPair.privateKey,
  };

  const sskCrossSignature = await signSskCrossSignature(
    msk.ed25519PrivateKey,
    msk.ed25519PublicKey,
    ssk.ed25519PublicKey,
  );
  const uskCrossSignature = await signUskCrossSignature(
    msk.ed25519PrivateKey,
    msk.ed25519PublicKey,
    usk.ed25519PublicKey,
  );

  return { ssk, usk, sskCrossSignature, uskCrossSignature };
}

/**
 * Verify the full cross-signing chain: MSK → SSK and MSK → USK.
 * Throws CERT_INVALID on any failure.
 */
export async function verifyCrossSigningChain(params: {
  mskPub: Bytes;
  sskPub: Bytes;
  sskCrossSignature: Bytes;
  uskPub: Bytes;
  uskCrossSignature: Bytes;
}): Promise<void> {
  await verifySskCrossSignature(
    params.mskPub,
    params.sskPub,
    params.sskCrossSignature,
  );
  await verifyUskCrossSignature(
    params.mskPub,
    params.uskPub,
    params.uskCrossSignature,
  );
}
