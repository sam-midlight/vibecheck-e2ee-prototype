'use client';

/**
 * PushSubscribeButton — prompts the user to enable web push notifications
 * on this device, and registers their PushSubscription into the
 * `push_subscriptions` table.
 *
 * What the server sees: { endpoint, p256dh, auth, device_name }. These
 * are the keys Push services need to route a message to the browser.
 * The server NEVER sees the encrypted event content — the edge function
 * that dispatches pushes only sends a generic "something new" title +
 * the roomId to route the click target.
 */

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { errorMessage } from '@/lib/errors';
import { getSupabase } from '@/lib/supabase/client';

const VAPID_PUB = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || '';

type State =
  | 'checking'
  | 'unsupported'
  | 'no-vapid'
  | 'default'
  | 'subscribed'
  | 'denied'
  | 'working';

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function keysFromSubscription(
  sub: PushSubscription,
): Promise<{ endpoint: string; p256dh: string; auth: string }> {
  const p = sub.getKey('p256dh');
  const a = sub.getKey('auth');
  if (!p || !a) throw new Error('Subscription is missing p256dh / auth keys');
  const toB64 = (b: ArrayBuffer) =>
    btoa(String.fromCharCode(...new Uint8Array(b)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  return { endpoint: sub.endpoint, p256dh: toB64(p), auth: toB64(a) };
}

function guessDeviceName(): string {
  if (typeof navigator === 'undefined') return 'device';
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android';
  if (/Mac/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows';
  return 'device';
}

export function PushSubscribeButton() {
  const [state, setState] = useState<State>('checking');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (typeof window === 'undefined') return;
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
        if (!cancelled) setState('unsupported');
        return;
      }
      if (!VAPID_PUB) {
        if (!cancelled) setState('no-vapid');
        return;
      }
      if (Notification.permission === 'denied') {
        if (!cancelled) setState('denied');
        return;
      }
      try {
        const reg = await navigator.serviceWorker.ready;
        const existing = await reg.pushManager.getSubscription();
        if (!cancelled) setState(existing ? 'subscribed' : 'default');
      } catch {
        if (!cancelled) setState('default');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function subscribe() {
    setState('working');
    try {
      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        const keyBytes = urlBase64ToUint8Array(VAPID_PUB);
        // applicationServerKey insists on ArrayBuffer under newer DOM lib;
        // copy into a fresh ArrayBuffer so the type is exact.
        const keyBuffer = new ArrayBuffer(keyBytes.byteLength);
        new Uint8Array(keyBuffer).set(keyBytes);
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: keyBuffer,
        });
      }
      const { endpoint, p256dh, auth } = await keysFromSubscription(sub);
      const supabase = getSupabase();
      const { data: user } = await supabase.auth.getUser();
      if (!user.user) throw new Error('Not signed in');
      const { error } = await supabase.from('push_subscriptions').upsert(
        {
          user_id: user.user.id,
          endpoint,
          p256dh,
          auth,
          device_name: guessDeviceName(),
          last_used: new Date().toISOString(),
        },
        { onConflict: 'endpoint' },
      );
      if (error) throw error;
      setState('subscribed');
      toast.success('Notifications on for this device ✨');
    } catch (err) {
      toast.error(errorMessage(err));
      setState('default');
    }
  }

  async function unsubscribe() {
    setState('working');
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await sub.unsubscribe().catch(() => {
          /* noop */
        });
        const supabase = getSupabase();
        await supabase
          .from('push_subscriptions')
          .delete()
          .eq('endpoint', sub.endpoint);
      }
      setState('default');
      toast.success('Notifications off for this device');
    } catch (err) {
      toast.error(errorMessage(err));
      setState('subscribed');
    }
  }

  const label = (() => {
    switch (state) {
      case 'checking':   return 'Checking…';
      case 'working':    return 'Working…';
      case 'subscribed': return 'Turn notifications off';
      case 'denied':     return 'Notifications blocked — enable in browser settings';
      case 'unsupported':return 'Notifications aren\u2019t supported on this browser';
      case 'no-vapid':   return 'Push key not configured';
      case 'default':    return 'Enable notifications on this device';
    }
  })();

  const disabled =
    state === 'checking' ||
    state === 'working' ||
    state === 'denied' ||
    state === 'unsupported' ||
    state === 'no-vapid';

  return (
    <button
      type="button"
      onClick={() => {
        if (state === 'subscribed') void unsubscribe();
        else if (state === 'default') void subscribe();
      }}
      disabled={disabled}
      className={`rounded-full px-5 py-2 font-display italic text-sm transition-all disabled:opacity-60 ${
        state === 'subscribed'
          ? 'border border-neutral-200 bg-white/80 text-neutral-700 hover:scale-[1.04] hover:bg-white active:scale-[1.02] dark:border-neutral-700 dark:bg-neutral-900/60 dark:text-neutral-200'
          : 'bg-gradient-to-br from-violet-300 via-violet-400 to-indigo-500 text-white shadow-[0_8px_20px_-4px_rgba(124,58,237,0.5),inset_0_2px_3px_rgba(255,255,255,0.4),inset_0_-3px_6px_rgba(67,56,202,0.3)] ring-1 ring-violet-200/60 hover:scale-[1.04] active:scale-[1.06]'
      }`}
    >
      {label}
    </button>
  );
}
