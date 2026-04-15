/**
 * Lazy libsodium initializer + small helpers.
 *
 * libsodium is a WASM module that must be awaited to `sodium.ready` before
 * any primitive is called. Everything else in e2ee-core goes through
 * `getSodium()` so callers never think about init.
 *
 * Browser-only: do NOT import this from a Server Component.
 */

import _sodium from 'libsodium-wrappers-sumo';
import { CryptoError, type Bytes } from './types';

type Sodium = typeof _sodium;

let readyPromise: Promise<Sodium> | null = null;

/**
 * Returns the ready libsodium instance. Safe to call concurrently; the WASM
 * init runs exactly once.
 */
export function getSodium(): Promise<Sodium> {
  if (!readyPromise) {
    readyPromise = (async () => {
      await _sodium.ready;
      return _sodium;
    })();
  }
  return readyPromise;
}

/** Concatenate any number of byte arrays into one. */
export function concatBytes(...parts: Bytes[]): Bytes {
  let total = 0;
  for (const p of parts) total += p.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.byteLength;
  }
  return out;
}

/** Compare two byte arrays for equality in constant time where it matters. */
export async function bytesEqual(a: Bytes, b: Bytes): Promise<boolean> {
  if (a.byteLength !== b.byteLength) return false;
  const sodium = await getSodium();
  try {
    return sodium.memcmp(a, b);
  } catch {
    return false;
  }
}

/** Encode bytes to base64 (URL-safe, no padding) for transport/storage. */
export async function toBase64(bytes: Bytes): Promise<string> {
  const sodium = await getSodium();
  return sodium.to_base64(bytes, sodium.base64_variants.URLSAFE_NO_PADDING);
}

/** Decode URL-safe base64 back to bytes. */
export async function fromBase64(s: string): Promise<Bytes> {
  const sodium = await getSodium();
  return sodium.from_base64(s, sodium.base64_variants.URLSAFE_NO_PADDING);
}

/** Encode bytes to a hex string. Handy for fingerprints and debug dumps. */
export async function toHex(bytes: Bytes): Promise<string> {
  const sodium = await getSodium();
  return sodium.to_hex(bytes);
}

/** Decode a hex string to bytes. */
export async function fromHex(s: string): Promise<Bytes> {
  const sodium = await getSodium();
  return sodium.from_hex(s);
}

/** Generate N cryptographically random bytes. */
export async function randomBytes(n: number): Promise<Bytes> {
  const sodium = await getSodium();
  return sodium.randombytes_buf(n);
}

/** Encode a UTF-8 string to bytes. */
export function stringToBytes(s: string): Bytes {
  return new TextEncoder().encode(s);
}

/** Decode bytes as UTF-8 text. */
export function bytesToString(b: Bytes): string {
  return new TextDecoder().decode(b);
}

/** Assert a byte array has the expected length. */
export function assertLength(b: Bytes, expected: number, label: string): void {
  if (b.byteLength !== expected) {
    throw new CryptoError(
      `${label} has length ${b.byteLength}, expected ${expected}`,
      'BAD_KEY_LENGTH',
    );
  }
}
