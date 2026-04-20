'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getSupabase } from '@/lib/supabase/client';
import {
  clearDeviceBundle,
  clearUserMasterKey,
  clearSelfSigningKey,
  clearUserSigningKey,
  hasWrappedIdentity,
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
import { Loading } from './OrganicLoader';
import { PendingApprovalBanner } from './PendingApprovalBanner';
import { ThemeToggle } from './design/ThemeToggle';

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
        // If the device is passphrase-locked (wrapped blob exists but no
        // plaintext bundle), route to auth/callback to handle unlock — don't
        // sign out and force another magic link.
        const locked = await hasWrappedIdentity(data.user.id).catch(() => false);
        if (locked) {
          router.replace('/auth/callback');
          return;
        }
        await bootOut(data.user.id);
        return;
      }
      // Chain is valid and plaintext is in IDB — but if no wrapped blob exists,
      // the user is mid-bootstrap / mid-recovery / mid-approval and has not
      // completed the mandatory PIN setup. Bounce back to /auth/callback so
      // proceedOrRequirePin surfaces the require-pin-setup modal. Without this
      // gate, typing /rooms in the URL bar during that window renders the app
      // with plaintext keys and no passphrase ever set (the bypass the React
      // step machine inside the callback page cannot prevent on its own).
      const hasPin = await hasWrappedIdentity(data.user.id).catch(() => false);
      if (!hasPin) {
        router.replace('/auth/callback');
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
    return (
      <main className="p-8">
        <Loading />
      </main>
    );
  }

  return (
    <div className="flex min-h-full flex-col">
      <header className="sticky top-0 z-30 flex items-center justify-between gap-3 border-b border-white/40 bg-white/50 px-4 py-3 text-sm backdrop-blur-md sm:px-6 dark:border-white/10 dark:bg-neutral-950/50">
        {/* Desktop nav — full list. Hidden on narrow screens; replaced
            by the hamburger on the right. */}
        <nav className="hidden items-center gap-4 md:flex">
          <Link href="/" className="font-semibold">VibeCheck 2.0</Link>
          {email && (
            <>
              <Link href="/rooms" className="text-neutral-600 hover:underline dark:text-neutral-400">rooms</Link>
              <Link href="/invites" className="text-neutral-600 hover:underline dark:text-neutral-400">invites</Link>
              {devMode && (
                <Link href="/status" className="text-neutral-600 hover:underline dark:text-neutral-400">status</Link>
              )}
              <Link href="/settings" className="text-neutral-600 hover:underline dark:text-neutral-400">settings</Link>
            </>
          )}
          <Link href="/about" className="text-neutral-600 hover:underline dark:text-neutral-400">about</Link>
        </nav>

        {/* Mobile: logo only on the left. Everything else collapses into
            the hamburger on the right. */}
        <Link href="/" className="font-semibold md:hidden">VibeCheck 2.0</Link>

        {/* Desktop right-side: theme toggle + email + id + sign-out */}
        <div className="hidden items-center gap-3 md:flex">
          <ThemeToggle compact />
          {email ? (
            <>
              <div className="flex min-w-0 flex-col items-end leading-tight">
                <span className="truncate text-xs text-neutral-500">{email}</span>
                {userId && <UserIdChip userId={userId} />}
              </div>
              <button
                onClick={handleSignOut}
                className="rounded-full border border-white/50 bg-white/50 px-3 py-1 text-xs backdrop-blur-md transition-all hover:bg-white/80 hover:shadow-sm active:scale-[0.98] dark:border-white/10 dark:bg-neutral-900/50 dark:hover:bg-neutral-900/80"
              >
                sign out
              </button>
            </>
          ) : (
            <span className="text-neutral-500">not signed in</span>
          )}
        </div>

        {/* Mobile hamburger — collapses rooms/status/settings PLUS the
            user-identity block + sign-out into one menu. */}
        <MobileNavMenu
          email={email}
          userId={userId}
          devMode={devMode}
          onSignOut={handleSignOut}
        />
      </header>
      <main className="flex-1 p-6">
        {email && (
          <div className="mx-auto mb-4 max-w-5xl space-y-2">
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

/**
 * Hamburger menu shown only below the `md:` breakpoint. Collapses the
 * whole global nav (rooms / status / settings) plus the user identity
 * block + sign-out into one dropdown so the iPhone header is just
 * `logo · ⋯`.
 */
function MobileNavMenu({
  email,
  userId,
  devMode,
  onSignOut,
}: {
  email: string | null;
  userId: string | null;
  devMode: boolean;
  onSignOut: () => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointer(e: PointerEvent) {
      const el = wrapRef.current;
      if (el && !el.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={wrapRef} className="relative md:hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="menu"
        aria-expanded={open}
        className="relative flex h-9 w-9 items-center justify-center rounded-full border border-white/50 bg-white/60 text-neutral-700 shadow-sm backdrop-blur-md transition-all hover:bg-white/80 active:scale-[0.96] dark:border-white/10 dark:bg-neutral-900/60 dark:text-neutral-300"
      >
        <span aria-hidden className="text-base leading-none">⋯</span>
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-50 mt-2 flex w-64 flex-col overflow-hidden rounded-2xl border border-white/60 bg-white/95 shadow-2xl backdrop-blur-md dark:border-white/10 dark:bg-neutral-900/95"
        >
          {email ? (
            <>
              <div className="border-b border-neutral-200/60 px-4 py-3 dark:border-neutral-700/60">
                <p className="truncate text-[11px] text-neutral-500">{email}</p>
                {userId && (
                  <div className="mt-1">
                    <UserIdChip userId={userId} />
                  </div>
                )}
              </div>
              <Link
                href="/rooms"
                onClick={() => setOpen(false)}
                className="flex items-center justify-between px-4 py-2.5 font-display italic text-sm text-neutral-800 hover:bg-neutral-100/60 dark:text-neutral-200 dark:hover:bg-neutral-800/60"
              >
                <span>Rooms</span>
                <span aria-hidden>🏠</span>
              </Link>
              <Link
                href="/invites"
                onClick={() => setOpen(false)}
                className="flex items-center justify-between px-4 py-2.5 font-display italic text-sm text-neutral-800 hover:bg-neutral-100/60 dark:text-neutral-200 dark:hover:bg-neutral-800/60"
              >
                <span>Invites</span>
                <span aria-hidden>💌</span>
              </Link>
              {devMode && (
                <Link
                  href="/status"
                  onClick={() => setOpen(false)}
                  className="flex items-center justify-between px-4 py-2.5 font-display italic text-sm text-neutral-800 hover:bg-neutral-100/60 dark:text-neutral-200 dark:hover:bg-neutral-800/60"
                >
                  <span>Status</span>
                  <span aria-hidden>🔌</span>
                </Link>
              )}
              <Link
                href="/settings"
                onClick={() => setOpen(false)}
                className="flex items-center justify-between px-4 py-2.5 font-display italic text-sm text-neutral-800 hover:bg-neutral-100/60 dark:text-neutral-200 dark:hover:bg-neutral-800/60"
              >
                <span>Settings</span>
                <span aria-hidden>⚙️</span>
              </Link>
              <Link
                href="/about"
                onClick={() => setOpen(false)}
                className="flex items-center justify-between px-4 py-2.5 font-display italic text-sm text-neutral-800 hover:bg-neutral-100/60 dark:text-neutral-200 dark:hover:bg-neutral-800/60"
              >
                <span>About</span>
                <span aria-hidden>ℹ️</span>
              </Link>
              <div className="flex items-center justify-between border-t border-neutral-200/60 px-4 py-2.5 dark:border-neutral-700/60">
                <span className="font-display italic text-sm text-neutral-800 dark:text-neutral-200">
                  Theme
                </span>
                <ThemeToggle />
              </div>
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  onSignOut();
                }}
                className="border-t border-neutral-200/60 px-4 py-2.5 text-left font-display italic text-sm text-red-700 hover:bg-red-50/80 dark:border-neutral-700/60 dark:text-red-300 dark:hover:bg-red-950/40"
              >
                Sign out
              </button>
            </>
          ) : (
            <>
              <Link
                href="/about"
                onClick={() => setOpen(false)}
                className="flex items-center justify-between px-4 py-2.5 font-display italic text-sm text-neutral-800 hover:bg-neutral-100/60 dark:text-neutral-200 dark:hover:bg-neutral-800/60"
              >
                <span>About</span>
                <span aria-hidden>ℹ️</span>
              </Link>
              <p className="px-4 py-3 text-sm text-neutral-500">not signed in</p>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Subtle user-id chip. Copies the full UUID to the clipboard on click so
 * users can hand it to a partner without hunting through settings.
 */
function UserIdChip({ userId }: { userId: string }) {
  const [copied, setCopied] = useState(false);
  const short = userId.slice(0, 8);

  async function copy() {
    try {
      await navigator.clipboard.writeText(userId);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      // clipboard may be blocked — fail silently, the visible id still helps.
    }
  }

  return (
    <button
      type="button"
      onClick={() => void copy()}
      title={`Your user id · click to copy\n${userId}`}
      aria-label={`Your user id ${userId}, click to copy`}
      className="group flex items-center gap-1 rounded-full border border-white/40 bg-white/30 px-2 py-0.5 font-mono text-[10px] text-neutral-400 transition-all hover:bg-white/60 hover:text-neutral-700 active:scale-[0.97] dark:border-white/10 dark:bg-neutral-900/30 dark:hover:bg-neutral-900/60 dark:hover:text-neutral-300"
    >
      <span className="opacity-70 transition-opacity group-hover:opacity-100">id</span>
      <span className="tabular-nums">{short}…</span>
      <span aria-hidden className="text-[9px] opacity-0 transition-opacity group-hover:opacity-100">
        {copied ? '✓' : '⧉'}
      </span>
    </button>
  );
}
