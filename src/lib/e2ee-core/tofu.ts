/**
 * Trust-On-First-Use cache + key-change detection.
 *
 * When we fetch a contact's published pubkeys from the server, we route them
 * through `observeContact()` before using them. On first sight, the pubkeys
 * are recorded locally and accepted silently. On any subsequent sight, we
 * compare to what's cached:
 *   - if equal → silent accept
 *   - if different → emit a KeyChangeEvent; caller decides whether to show
 *     a banner, block the operation, re-pair, etc.
 *
 * This catches a malicious Supabase swapping a contact's pubkey AFTER first
 * contact. It does NOT catch a swap that was in place at first contact —
 * that's the TOFU tradeoff we accept for zero friction.
 */

import type { KeyChangeEvent, KnownContact, PublicIdentity } from './types';
import { bytesEqual } from './sodium';
import { getKnownContact, putKnownContact } from './storage';

export type KeyChangeListener = (event: KeyChangeEvent) => void;

const listeners = new Set<KeyChangeListener>();

/** Subscribe to key-change events across the whole app. Returns an unsubscriber. */
export function onKeyChange(listener: KeyChangeListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emitKeyChange(event: KeyChangeEvent): void {
  for (const l of listeners) {
    try {
      l(event);
    } catch (e) {
      console.error('key-change listener threw:', e);
    }
  }
}

/**
 * Record a sighting of this contact's published identity. Returns:
 *   - `{ status: 'new' }` on first-ever sight
 *   - `{ status: 'same' }` if the published keys match our cached ones
 *   - `{ status: 'changed', event }` if they differ — caller should react
 *
 * Always updates `lastSeenAt`. On a change, does NOT automatically overwrite
 * the cached keys — the caller decides whether to accept the new keys via
 * `acceptKeyChange()`.
 */
export async function observeContact(
  userId: string,
  pub: PublicIdentity,
): Promise<
  | { status: 'new' }
  | { status: 'same' }
  | { status: 'changed'; event: KeyChangeEvent }
> {
  const cached = await getKnownContact(userId);
  const now = Date.now();

  if (!cached) {
    const record: KnownContact = {
      userId,
      ed25519PublicKey: pub.ed25519PublicKey,
      x25519PublicKey: pub.x25519PublicKey,
      firstSeenAt: now,
      lastSeenAt: now,
    };
    await putKnownContact(record);
    return { status: 'new' };
  }

  const sameEd = await bytesEqual(cached.ed25519PublicKey, pub.ed25519PublicKey);
  const sameX = await bytesEqual(cached.x25519PublicKey, pub.x25519PublicKey);
  if (sameEd && sameX) {
    await putKnownContact({ ...cached, lastSeenAt: now });
    return { status: 'same' };
  }

  const event: KeyChangeEvent = {
    userId,
    previous: {
      ed25519PublicKey: cached.ed25519PublicKey,
      x25519PublicKey: cached.x25519PublicKey,
      firstSeenAt: cached.firstSeenAt,
    },
    current: {
      ed25519PublicKey: pub.ed25519PublicKey,
      x25519PublicKey: pub.x25519PublicKey,
    },
    detectedAt: now,
  };
  emitKeyChange(event);
  return { status: 'changed', event };
}

/**
 * After the user acknowledges a key change (e.g. "yes, my partner reinstalled"),
 * overwrite the cached keys with the new ones so future sightings don't keep
 * alerting.
 */
export async function acceptKeyChange(
  userId: string,
  pub: PublicIdentity,
): Promise<void> {
  const now = Date.now();
  await putKnownContact({
    userId,
    ed25519PublicKey: pub.ed25519PublicKey,
    x25519PublicKey: pub.x25519PublicKey,
    firstSeenAt: now, // reset; this is effectively a new TOFU anchor
    lastSeenAt: now,
  });
}
