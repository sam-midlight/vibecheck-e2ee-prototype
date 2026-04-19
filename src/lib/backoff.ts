/**
 * Exponential backoff formula used for missing-key retry and similar
 * deferral loops. Pure function — no side effects, no timers.
 *
 * delay(0) = 500ms, delay(1) = 1000ms, delay(2) = 2000ms, ...
 * Capped at `cap` to prevent unbounded waits.
 */
export function computeBackoffDelay(
  retryCount: number,
  base = 500,
  cap = 5000,
): number {
  return Math.min(base * Math.pow(2, retryCount), cap);
}
