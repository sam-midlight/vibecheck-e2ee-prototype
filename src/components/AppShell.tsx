'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getSupabase } from '@/lib/supabase/client';
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
  const [checking, setChecking] = useState(requireAuth);

  useEffect(() => {
    const supabase = getSupabase();
    let mounted = true;

    void supabase.auth.getUser().then(({ data }) => {
      if (!mounted) return;
      setEmail(data.user?.email ?? null);
      if (requireAuth && !data.user) router.replace('/');
      setChecking(false);
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!mounted) return;
      setEmail(session?.user?.email ?? null);
      if (requireAuth && !session) router.replace('/');
    });

    return () => {
      mounted = false;
      sub.subscription.unsubscribe();
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
              <Link href="/status" className="text-neutral-600 hover:underline dark:text-neutral-400">status</Link>
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
    </div>
  );
}
