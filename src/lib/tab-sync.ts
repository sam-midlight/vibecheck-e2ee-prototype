/**
 * Cross-tab coordination for same-origin identity changes.
 *
 * Problem: two tabs of the app share IndexedDB but not React / in-memory
 * state. If tab A rotates MSK / revokes a device / nukes the identity, tab
 * B holds stale keys in memory and will produce failing operations until the
 * user manually refreshes.
 *
 * Fix: broadcast the change via BroadcastChannel; other tabs reload. Reload
 * re-reads from IDB so the post-change state is picked up cleanly without
 * needing to wire a full cross-tab state-sync protocol.
 *
 * BroadcastChannel is a window-level API with broad support (Chrome, Firefox,
 * Safari 15.4+, Edge). Safe to no-op if unavailable — the consequence is
 * only that sibling tabs don't auto-refresh, which is the pre-existing
 * behaviour.
 */

export type IdentityChangeKind =
  | 'msk-rotated'
  | 'device-revoked'
  | 'identity-nuked';

export interface IdentityChangeEvent {
  kind: IdentityChangeKind;
  userId: string;
  ts: number;
}

const CHANNEL_NAME = 'vibecheck-e2ee-identity';

function getChannel(): BroadcastChannel | null {
  if (typeof window === 'undefined') return null;
  if (typeof BroadcastChannel === 'undefined') return null;
  return new BroadcastChannel(CHANNEL_NAME);
}

/** Broadcast an identity change to sibling tabs. No-ops on unsupported envs. */
export function broadcastIdentityChange(
  kind: IdentityChangeKind,
  userId: string,
): void {
  const ch = getChannel();
  if (!ch) return;
  try {
    const event: IdentityChangeEvent = { kind, userId, ts: Date.now() };
    ch.postMessage(event);
  } finally {
    ch.close();
  }
}

/**
 * Subscribe to identity changes from sibling tabs. The handler is called on
 * every received message; callers typically respond by reloading the tab.
 * Returns an unsubscribe function.
 */
export function subscribeIdentityChanges(
  userId: string,
  onChange: (event: IdentityChangeEvent) => void,
): () => void {
  const ch = getChannel();
  if (!ch) return () => {};
  const handler = (e: MessageEvent<IdentityChangeEvent>) => {
    const data = e.data;
    if (!data || typeof data !== 'object') return;
    if (data.userId !== userId) return;
    onChange(data);
  };
  ch.addEventListener('message', handler);
  return () => {
    ch.removeEventListener('message', handler);
    ch.close();
  };
}
