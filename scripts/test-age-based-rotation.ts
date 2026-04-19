/**
 * Test 24: Age-Based Session Rotation Trigger
 *
 * shouldRotateSession returns true when a session's createdAt is older than
 * maxAgeMs (default 7 days), even at messageIndex 0.
 *
 * Asserts:
 *   - A fresh session at index 0 returns false
 *   - A session with createdAt set to 8 days ago returns true at index 0
 *   - A session with createdAt 6 days ago returns false (within window)
 *   - Custom maxAgeMs is respected
 *
 * Run: npx tsx --env-file=.env.local scripts/test-age-based-rotation.ts
 */

import {
  createOutboundSession,
  shouldRotateSession,
  DEFAULT_AUTO_ROTATION,
} from '../src/lib/e2ee-core';
import { initCrypto } from './test-utils';

async function run() {
  await initCrypto();

  const roomId = crypto.randomUUID();
  const DAY_MS = 24 * 60 * 60 * 1000;

  // Fresh session — should not rotate
  const fresh = await createOutboundSession(roomId, 1);
  if (shouldRotateSession(fresh)) {
    throw new Error('shouldRotateSession returned true for a fresh session at index 0');
  }

  // Session created 8 days ago — should rotate (age > 7 days)
  const stale = await createOutboundSession(roomId, 1);
  stale.createdAt = Date.now() - 8 * DAY_MS;
  if (!shouldRotateSession(stale)) {
    throw new Error(`shouldRotateSession returned false for session created 8 days ago (age=${stale.createdAt})`);
  }

  // Session created 6 days ago — should not rotate
  const recent = await createOutboundSession(roomId, 1);
  recent.createdAt = Date.now() - 6 * DAY_MS;
  if (shouldRotateSession(recent)) {
    throw new Error('shouldRotateSession returned true for session created 6 days ago');
  }

  // Custom maxAgeMs: 1 hour — a session 2 hours old should rotate
  const shortLived = await createOutboundSession(roomId, 1);
  shortLived.createdAt = Date.now() - 2 * 60 * 60 * 1000;
  if (!shouldRotateSession(shortLived, { maxMessages: 100, maxAgeMs: 60 * 60 * 1000 })) {
    throw new Error('shouldRotateSession returned false with custom 1-hour maxAgeMs for 2-hour-old session');
  }

  // Exactly at the boundary (7 days) — should not yet rotate (< not <=)
  const boundary = await createOutboundSession(roomId, 1);
  boundary.createdAt = Date.now() - DEFAULT_AUTO_ROTATION.maxAgeMs + 1000; // 1s short
  if (shouldRotateSession(boundary)) {
    throw new Error('shouldRotateSession returned true for session 1 second short of maxAgeMs');
  }

  console.log('PASS: Age-based rotation — stale (8d) rotates; recent (6d) does not; custom maxAgeMs respected ✓');
}

run().catch((err) => { console.error('FAIL:', err); process.exit(1); });
