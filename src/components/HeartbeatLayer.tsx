'use client';

import type { ReactNode } from 'react';

/**
 * HeartbeatLayer — stub during the vibecheck2 merge.
 *
 * Final form pulses a red edge-vignette when a partner's Heartbeat
 * toggle is broadcast over the room's realtime channel. In the composed
 * RoomProvider it wraps the whole room tree, so for now this shim just
 * passes children through unchanged.
 */
export function HeartbeatLayer({ children }: { children?: ReactNode }) {
  return <>{children}</>;
}
