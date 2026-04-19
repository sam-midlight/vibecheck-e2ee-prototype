/**
 * At-most-one-running, at-most-one-queued mutex for async load functions.
 *
 * Semantics:
 *   acquire() → 'run'   : no contention, caller may proceed
 *   acquire() → 'queue' : one caller already running, this call queued
 *   acquire() → 'drop'  : one running + one already queued, caller discarded
 *   release() → true    : a queued call was promoted to running, caller should invoke it
 *   release() → false   : queue was empty, mutex is now idle
 */
export interface LoadMutex {
  acquire(): 'run' | 'queue' | 'drop';
  release(): boolean;
}

export function createLoadMutex(): LoadMutex {
  let running = false;
  let pending = false;
  return {
    acquire() {
      if (!running) { running = true; return 'run'; }
      if (!pending) { pending = true; return 'queue'; }
      return 'drop';
    },
    release() {
      running = false;
      if (pending) { pending = false; running = true; return true; }
      return false;
    },
  };
}
