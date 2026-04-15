'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AppShell } from '@/components/AppShell';
import { MagicLinkForm } from '@/components/MagicLinkForm';
import { getSupabase } from '@/lib/supabase/client';

export default function LandingPage() {
  const router = useRouter();
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let mounted = true;
    const supabase = getSupabase();
    void supabase.auth.getUser().then(({ data }) => {
      if (!mounted) return;
      if (data.user) {
        router.replace('/rooms');
        return;
      }
      setLoaded(true);
    });
    return () => {
      mounted = false;
    };
  }, [router]);

  if (!loaded) return <main className="p-8 text-sm text-neutral-500">loading…</main>;

  return (
    <AppShell>
      <div className="mx-auto max-w-md space-y-6">
        <div>
          <h1 className="text-2xl font-semibold">Sign in</h1>
          <p className="mt-1 text-sm text-neutral-500">
            Enter your email; we&apos;ll send a one-time sign-in link. No
            password, no account recovery &mdash; your device holds the
            encryption keys.
          </p>
        </div>
        <MagicLinkForm />
      </div>
    </AppShell>
  );
}
