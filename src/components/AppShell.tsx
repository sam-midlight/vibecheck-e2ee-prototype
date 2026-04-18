'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getSupabase } from '@/lib/supabase/client';
import {
  clearDeviceBundle,
  clearUserMasterKey,
  clearSelfSigningKey,
  clearUserSigningKey,
  verifySskCrossSignature,
  verifyDeviceIssuance,
} from '@/lib/e2ee-core';
import {
  fetchPublicDevices,
  fetchUserMasterKeyPub,
} from '@/lib/supabase/queries';
import { loadEnrolledDevice } from '@/lib/bootstrap';
import { subscribeIdentityChanges } from '@/lib/tab-sync';
import { useDevMode } from '@/lib/use-dev-mode';
import { IncomingCallToast } from './IncomingCallToast';
import { KeyChangeBanner } from './KeyChangeBanner';
import { PendingApprovalBanner } from './PendingApprovalBanner';

interface AppShellProps {
  children: React.ReactNode;
  /** If true, require a logged-in session; redirect to `/` if missing. */
  requireAuth?: boolean;
}

export function AppShell({ children, requireAuth = false }: AppShellProps) {
  const router = useRouter();
  const [email, setEmail] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [checking, setChecking] = useState(requireAuth);
  const [devMode] = useDevMode();

  useEffect(() => {
    const supabase = getSupabase();
    let mounted = true;

    /**
     * Verify that this tab's cached device identity still chains to the
     * published UMK. If it doesn't (account nuked elsewhere, device revoked,
     * UMK rotated), wipe local state + sign out so the user lands on the
     * sign-in screen instead of poking around with stale keys.
     */
    async function ensureIdentityStillValid(uid: string): Promise<boolean> {
      try {
        const umkPub = await fetchUserMasterKeyPub(uid);
        if (!umkPub) return false;
        const local = await loadEnrolledDevice(uid);
        if (!local) return false;
        const devices = await fetchPublicDevices(uid);
        const mine = devices.find((d) => d.deviceId === local.deviceBundle.deviceId);
        if (!mine) return false;
        // Verify SSK cross-sig if present, then pass SSK pub for v2 cert dispatch.
        let sskPub: Uint8Array | undefined;
        if (umkPub.sskPub && umkPub.sskCrossSignature) {
          try {
            await verifySskCrossSignature(
              umkPub.ed25519PublicKey,
              umkPub.sskPub,
              umkPub.sskCrossSignature,
            );
            sskPub = umkPub.sskPub;
          } catch { /* fall back to MSK-only */ }
        }
        await verifyDeviceIssuance(
          {
            userId: uid,
            deviceId: mine.deviceId,
            deviceEd25519PublicKey: mine.ed25519PublicKey,
            deviceX25519PublicKey: mine.x25519PublicKey,
            createdAtMs: mine.createdAtMs,
          },
          mine.issuanceSignature,
          umkPub.ed25519PublicKey,
          sskPub,
        );
        return true;
      } catch {
        return false;
      }
    }

    async function bootOut(uid: string | null) {
      if (uid) {
        await clearDeviceBundle(uid).catch(() => {});
        await clearUserMasterKey(uid).catch(() => {});
        await clearSelfSigningKey(uid).catch(() => {});
        await clearUserSigningKey(uid).catch(() => {});
      }
      await supabase.auth.signOut().catch(() => {});
      router.replace('/');
    }

    let unsubTabSync: (() => void) | null = null;

    void supabase.auth.getUser().then(async ({ data }) => {
      if (!mounted) return;
      setEmail(data.user?.email ?? null);
      setUserId(data.user?.id ?? null);
      if (!requireAuth) {
        setChecking(false);
        return;
      }
      if (!data.user) {
        router.replace('/');
        return;
      }
      const ok = await ensureIdentityStillValid(data.user.id);
      if (!mounted) return;
      if (!ok) {
        await bootOut(data.user.id);
        return;
      }
      // Subscribe to sibling-tab identity changes. A rotation / revocation /
      // nuke in another tab leaves this tab's in-memory state stale; reload
      // is the cleanest recovery because it re-reads from IDB (which the
      // other tab already updated) and re-runs the post-mount chain check.
      const uid = data.user.id;
      unsubTabSync = subscribeIdentityChanges(uid, () => {
        if (!mounted) return;
        window.location.reload();
      });
      setChecking(false);
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!mounted) return;
      setEmail(session?.user?.email ?? null);
      setUserId(session?.user?.id ?? null);
      if (requireAuth && !session) router.replace('/');
    });

    return () => {
      mounted = false;
      sub.subscription.unsubscribe();
      unsubTabSync?.();
    };
  }, [requireAuth, router]);

  async function handleSignOut() {
    await getSupabase().auth.signOut();
    router.replace('/');
  }

  if (checking) {
    return <main className="p-8 text-sm text-neutral-500">loading…</main>;
  }

  return (
    <div className="flex min-h-full flex-col">
      <header className="flex items-center justify-between border-b border-neutral-200 px-6 py-3 text-sm dark:border-neutral-800">
        <nav className="flex gap-4">
          <Link href="/" className="font-semibold">e2ee-prototype</Link>
          {email && (
            <>
              <Link href="/rooms" className="text-neutral-600 hover:underline dark:text-neutral-400">rooms</Link>
              {devMode && <Link href="/status" className="text-neutral-600 hover:underline dark:text-neutral-400">status</Link>}
              <Link href="/settings" className="text-neutral-600 hover:underline dark:text-neutral-400">settings</Link>
            </>
          )}
        </nav>
        <div className="flex items-center gap-3">
          {email ? (
            <>
              <span className="text-neutral-500">{email}</span>
              <button
                onClick={handleSignOut}
                className="rounded border border-neutral-300 px-2 py-1 text-xs hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-900"
              >
                sign out
              </button>
            </>
          ) : (
            <span className="text-neutral-500">not signed in</span>
          )}
        </div>
      </header>
      <main className="flex-1 p-6">
        {email && (
          <div className="mb-4 space-y-2">
            <PendingApprovalBanner />
            <KeyChangeBanner />
          </div>
        )}
        {children}
      </main>
      {userId && <IncomingCallToast userId={userId} />}
    </div>
  );
}
