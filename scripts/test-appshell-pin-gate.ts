/**
 * Test 67 — AppShell mandatory-PIN gate (source-structural)
 *
 * Background
 * ----------
 * `bootstrapNewUser`, `enrollDeviceWithUmk`, and `AwaitingApproval.tryInstall`
 * all write plaintext device keys to IDB *and* publish the cert to the server
 * BEFORE the callback page's `require-pin-setup` React step fires. Between
 * those two moments, a user who URL-bar-navigates to `/rooms` (or any other
 * `requireAuth` route) passes AppShell's chain-validity check and lands in
 * the app with plaintext keys in IDB and no passphrase ever set. That
 * directly contradicts the "PIN-lock is mandatory, not opt-in" invariant in
 * `AGENTS.md` §3.
 *
 * Fix (commit 9be7ee4): in `src/components/AppShell.tsx`, after the chain
 * check passes, call `hasWrappedIdentity`; if the blob is missing, redirect
 * to `/auth/callback` (which routes through `proceedOrRequirePin` →
 * `require-pin-setup` modal).
 *
 * Why a structural test
 * ---------------------
 * The bypass lives in a React `useEffect` doing IDB reads and `router.replace`.
 * The repo has no jsdom / React Testing Library / Playwright, and adding them
 * is out of proportion with the one-file fix. Instead this test asserts the
 * structural invariants over the source text of `AppShell.tsx`:
 *
 *   1. `hasWrappedIdentity` is imported from `@/lib/e2ee-core`.
 *   2. It is called in the "success branch" of the auth handler (i.e. AFTER
 *      the `if (!ok) { ... }` block closes) — not only inside the orphan/
 *      locked branch at line ~120.
 *   3. The success-branch call gates a `router.replace('/auth/callback')` on
 *      a falsy (`!…`) condition, followed by `return;`.
 *   4. The guard sits BEFORE `setChecking(false)` — otherwise the app would
 *      render for one frame with plaintext keys.
 *
 * Paired mutations in `scripts/run-mutations.ts`:
 *   - M13: guard block removed entirely.
 *   - M14: `setChecking(false)` moved to before the guard (UI renders first).
 *   - M15: redirect target changed from `/auth/callback` to `/rooms`.
 *
 * This test is deliberately strict about idiom (`if (!hasPin)` shape). A
 * refactor that changes the shape should update this test in the same
 * commit as the AppShell change.
 *
 * Run: npx tsx scripts/test-appshell-pin-gate.ts
 * (No Supabase credentials required — pure filesystem read.)
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';

const APPSHELL = resolve(__dirname, '..', 'src', 'components', 'AppShell.tsx');

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
}

/** Given index of an opening `{`, return index of its matching `}`. */
function findMatchingBrace(src: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function run() {
  const src = readFileSync(APPSHELL, 'utf8').replace(/\r\n/g, '\n');

  // --- 1. import ---------------------------------------------------------
  const importRe =
    /import\s*\{[^}]*\bhasWrappedIdentity\b[^}]*\}\s*from\s*['"]@\/lib\/e2ee-core['"]/;
  assert(
    importRe.test(src),
    '`hasWrappedIdentity` is not imported from `@/lib/e2ee-core`',
  );

  // --- Locate the auth handler anchors ----------------------------------
  const ensureIdx = src.indexOf(
    'const ok = await ensureIdentityStillValid(',
  );
  assert(
    ensureIdx !== -1,
    '`const ok = await ensureIdentityStillValid(` anchor not found',
  );

  const setCheckingIdx = src.indexOf('setChecking(false)', ensureIdx);
  assert(
    setCheckingIdx !== -1,
    '`setChecking(false)` not found after `ensureIdentityStillValid`',
  );

  const ifNotOkIdx = src.indexOf('if (!ok) {', ensureIdx);
  assert(
    ifNotOkIdx !== -1 && ifNotOkIdx < setCheckingIdx,
    '`if (!ok) {` block not found before `setChecking(false)`',
  );
  const openBrace = src.indexOf('{', ifNotOkIdx);
  const closeBrace = findMatchingBrace(src, openBrace);
  assert(
    closeBrace > 0 && closeBrace < setCheckingIdx,
    '`if (!ok)` block closing brace not found before `setChecking(false)`',
  );

  // Success branch = code between `if (!ok)`'s `}` and `setChecking(false)`.
  const successBranch = src.slice(closeBrace + 1, setCheckingIdx);

  // --- 2. hasWrappedIdentity call in success branch ---------------------
  assert(
    /hasWrappedIdentity\s*\(/.test(successBranch),
    '`hasWrappedIdentity` is not called on the success path (between `if (!ok)` close and `setChecking(false)`)',
  );

  // --- 3. Guarded redirect to /auth/callback + return -------------------
  const redirectRe = /router\.replace\(\s*['"]\/auth\/callback['"]\s*\)/;
  const redirectMatch = successBranch.match(redirectRe);
  assert(
    redirectMatch !== null,
    "`router.replace('/auth/callback')` is not called in the success branch",
  );
  const redirectIdx = successBranch.indexOf(redirectMatch![0]);

  // Nearest preceding `if (` must exist and be a negation (`if (!…)`).
  const beforeRedirect = successBranch.slice(0, redirectIdx);
  const lastIfIdx = beforeRedirect.lastIndexOf('if (');
  assert(
    lastIfIdx !== -1,
    'no `if (...)` guard precedes the `/auth/callback` redirect',
  );
  const ifHeader = beforeRedirect.slice(lastIfIdx);
  assert(
    /if\s*\(\s*!/.test(ifHeader),
    'the `/auth/callback` redirect is not gated by a negated (`!…`) condition',
  );

  const afterRedirect = successBranch.slice(redirectIdx, redirectIdx + 200);
  assert(
    /return\s*;/.test(afterRedirect),
    '`return;` does not follow the `/auth/callback` redirect within 200 chars',
  );

  // --- 4. Guard precedes setChecking(false) ----------------------------
  const absRedirectIdx = closeBrace + 1 + redirectIdx;
  assert(
    absRedirectIdx < setCheckingIdx,
    "PIN-gate redirect is not positioned before `setChecking(false)`",
  );

  console.log(
    'PASS: AppShell PIN gate — hasWrappedIdentity check on success path, negated guard redirects to /auth/callback + return, before setChecking(false) ✓',
  );
}

run();
