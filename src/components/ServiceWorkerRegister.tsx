'use client';

/**
 * Register the service worker (public/sw.js) on app mount. Only in the
 * browser + only on production-ish conditions — local HMR reloads can fight
 * an active worker, so we skip unless we're on https (or localhost, which
 * browsers treat as a secure context). The worker powers PWA install and
 * the push-notification handler.
 */

import { useEffect } from 'react';

export function ServiceWorkerRegister() {
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!('serviceWorker' in navigator)) return;
    const isSecure =
      window.location.protocol === 'https:' ||
      window.location.hostname === 'localhost' ||
      window.location.hostname === '127.0.0.1';
    if (!isSecure) return;
    const register = () => {
      navigator.serviceWorker
        .register('/sw.js', { scope: '/' })
        .catch((err) => {
          console.warn('sw register failed', err);
        });
    };
    const w = window as Window & {
      requestIdleCallback?: (cb: () => void) => number;
    };
    if (typeof w.requestIdleCallback === 'function') {
      w.requestIdleCallback(register);
    } else {
      window.setTimeout(register, 1500);
    }
  }, []);
  return null;
}
