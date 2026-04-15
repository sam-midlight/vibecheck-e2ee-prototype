/**
 * Next.js 16 Proxy (formerly middleware.ts).
 *
 * Sets a strict Content-Security-Policy on every HTML response. Any XSS in
 * this app would let an attacker read the identity private keys out of
 * IndexedDB, so CSP is a meaningful defense — not a checkbox.
 *
 * Model: per-request nonce + `strict-dynamic`. Next.js automatically tags its
 * own inline bootstrap scripts with this nonce, so nothing else can execute.
 * `'wasm-unsafe-eval'` is required for libsodium's WebAssembly.
 *
 * `style-src 'unsafe-inline'` stays because (a) Next.js injects un-nonced
 * critical CSS and (b) the recovery-phrase "Save as PDF" path renders into an
 * `about:blank` iframe with inline <style>. Style-XSS is low impact — the real
 * threat is script execution, which we block.
 */

import { NextResponse, type NextRequest } from 'next/server';

export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const isDev = process.env.NODE_ENV === 'development';

  const csp = [
    `default-src 'self'`,
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' 'wasm-unsafe-eval'${isDev ? " 'unsafe-eval'" : ''}`,
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' blob: data:`,
    `font-src 'self' data:`,
    `connect-src 'self' https://*.supabase.co wss://*.supabase.co`,
    `worker-src 'self' blob:`,
    `object-src 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `frame-ancestors 'none'`,
    `upgrade-insecure-requests`,
  ].join('; ');

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('Content-Security-Policy', csp);
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('X-Frame-Options', 'DENY');
  return response;
}

export const config = {
  matcher: [
    {
      source: '/((?!api|_next/static|_next/image|favicon.ico).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
