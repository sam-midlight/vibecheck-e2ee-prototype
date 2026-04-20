/**
 * Consistent error → user-facing string.
 *
 * Matters because Supabase's PostgREST errors and Storage errors are plain
 * `{ message, details, hint, code }` objects, not `Error` instances. Naively
 * stringifying them produces the infamous `[object Object]` banner. This
 * helper digs out the most useful field we can find.
 */

export function describeError(e: unknown): string {
  if (e instanceof Error && e.message) return e.message;
  if (typeof e === 'string') return e;
  if (e && typeof e === 'object') {
    const obj = e as Record<string, unknown>;
    const message = obj.message;
    if (typeof message === 'string' && message.length > 0) return message;
    const details = obj.details;
    if (typeof details === 'string' && details.length > 0) return details;
    try {
      return JSON.stringify(e);
    } catch {
      /* fall through */
    }
  }
  return 'unknown error';
}
