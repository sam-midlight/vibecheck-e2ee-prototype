/**
 * PostgrestError and friends are plain objects, not Error instances. Naive
 * `String(e)` or `console.error('...', e)` collapses them to `[object Object]`
 * or `{}`, hiding message/details/hint/code. Always funnel unknown errors
 * through this helper before logging or surfacing.
 */
export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e && typeof e === 'object') {
    const o = e as { message?: unknown; details?: unknown; hint?: unknown; code?: unknown };
    const parts = [o.message, o.details, o.hint, o.code]
      .filter((v): v is string => typeof v === 'string' && v.length > 0);
    if (parts.length) return parts.join(' — ');
    try {
      const s = JSON.stringify(e);
      return s.length > 500 ? `${s.slice(0, 500)}…` : s;
    } catch {
      /* circular ref or BigInt — fall through */
    }
  }
  return String(e);
}
