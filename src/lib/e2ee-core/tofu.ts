/**
 * Trust-On-First-Use cache + key-change detection.
 *
 * When we fetch a contact's published pubkeys from the server, we route them
 * through `observeContact()` before using them. On first sight, the ed25519
 * UMK pub is recorded locally. Subsequent sightings compare ed25519 only:
 *   - if equal → silent accept (x25519 refreshed quietly)
 *   - if different → emit a KeyChangeEvent; caller decides whether to show
 *     a banner, block the operation, re-pair, etc.
 *
 * Why ed25519-only in v3: the UMK pub is a stable per-user anchor, but the
 * x25519 field on a PublicIdentity is whichever device the contact happens
 * to be acting from right now. A contact switching devices (phone → laptop)
 * or approving a new device on their account must not trigger a TOFU alarm,
 * because the UMK hasn't rotated — the device cert chain already vouches for
 * the new x25519 against the same UMK.
 *
 * This catches a malicious Supabase swapping a contact's UMK AFTER first
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
  if (sameEd) {
    // Same UMK. The x25519 may differ because the contact is acting from a
    // different device than before — that's normal in the v3 model, not a
    // trust event. Refresh the cached x silently.
    await putKnownContact({
      ...cached,
      x25519PublicKey: pub.x25519PublicKey,
      lastSeenAt: now,
    });
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
