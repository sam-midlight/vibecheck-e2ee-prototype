'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AppShell } from '@/components/AppShell';
import { MagicLinkForm } from '@/components/MagicLinkForm';
import { Loading } from '@/components/OrganicLoader';
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

  if (!loaded) {
    return (
      <main className="p-8">
        <Loading />
      </main>
    );
  }

  return (
    <AppShell>
      <div className="mx-auto max-w-3xl space-y-14 pb-16">
        <Hero />
        <HowItWorks />
        <SignIn />
        <Details />
      </div>
    </AppShell>
  );
}

function Hero() {
  return (
    <section className="pt-8 text-center">
      <p className="text-xs uppercase tracking-[0.2em] text-neutral-500">
        VibeCheck 2.0
      </p>
      <h1 className="mt-4 font-display italic text-4xl tracking-tight sm:text-5xl">
        A private space <span className="whitespace-nowrap">for just the two of you.</span>
      </h1>
      <p className="mx-auto mt-5 max-w-xl text-base text-neutral-600 dark:text-neutral-400">
        Check-ins, safe-space messaging, shared date ideas, gratitude, and
        more — end-to-end encrypted so even we can&apos;t read them.
      </p>
    </section>
  );
}

function HowItWorks() {
  const items: { title: string; body: string }[] = [
    {
      title: 'Your device holds the keys.',
      body:
        'When you first sign in, your browser generates a personal encryption key and keeps it locally. It never leaves the device.',
    },
    {
      title: 'Everything is sealed before it leaves.',
      body:
        'Every slider, message, reflection, and gratitude note is encrypted on your device before being sent. What we store on our server is unreadable ciphertext.',
    },
    {
      title: 'Zero-knowledge, by design.',
      body:
        'We see routing metadata — who posted to which room, when. That&apos;s it. No content, no emotions, no moods. Not for us, not for anyone.',
    },
  ];
  return (
    <section className="grid gap-4 sm:grid-cols-3">
      {items.map((it) => (
        <div
          key={it.title}
          className="rounded-2xl border border-white/50 bg-white/60 p-5 shadow-lg backdrop-blur-md dark:border-white/10 dark:bg-neutral-900/50"
        >
          <h2 className="text-sm font-semibold">{it.title}</h2>
          <p
            className="mt-2 text-sm text-neutral-600 dark:text-neutral-400"
            dangerouslySetInnerHTML={{ __html: it.body }}
          />
        </div>
      ))}
    </section>
  );
}

function SignIn() {
  return (
    <section className="mx-auto max-w-md rounded-3xl border border-white/60 bg-white/70 p-8 shadow-xl backdrop-blur-md dark:border-white/10 dark:bg-neutral-900/60">
      <h2 className="text-lg font-semibold">Sign in</h2>
      <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
        Enter your email; we&apos;ll send a one-time sign-in link. No password
        — your device is the only thing that can unlock your data.
      </p>
      <div className="mt-4">
        <MagicLinkForm />
      </div>
    </section>
  );
}

function Details() {
  return (
    <section className="rounded-2xl border border-white/50 bg-white/60 p-6 text-sm shadow-lg backdrop-blur-md dark:border-white/10 dark:bg-neutral-900/50">
      <details>
        <summary className="cursor-pointer font-medium">
          For the curious — how the encryption actually works
        </summary>
        <div className="mt-4 space-y-3 text-neutral-600 dark:text-neutral-400">
          <p>
            VibeCheck uses the same cryptographic primitives behind Signal and
            Bitwarden:
          </p>
          <ul className="ml-5 list-disc space-y-2">
            <li>
              <strong>Identity keys</strong> — on first sign-in, your browser
              generates an Ed25519 signing keypair and an X25519 key-exchange
              keypair. The private halves live in your browser&apos;s
              IndexedDB and are never transmitted.
            </li>
            <li>
              <strong>Room keys</strong> — each shared space (a pair or group
              room) has its own symmetric XChaCha20-Poly1305 key, wrapped for
              each member with their X25519 public key via{' '}
              <code>crypto_box_seal</code>. Our server only ever sees the
              wraps.
            </li>
            <li>
              <strong>Every event is signed</strong> — we verify the sender on
              decrypt, so a compromised server can&apos;t forge writes into
              your room.
            </li>
            <li>
              <strong>No recovery codes</strong> — by design. If you lose every
              device, your data is unrecoverable and your partner simply
              re-invites you. We never held anything that could get it back.
            </li>
          </ul>
          <p className="pt-2 text-xs">
            Want to see it live? After you sign in, visit <code>/status</code>{' '}
            — it runs twelve end-to-end checks against the encryption
            pipeline in real time.
          </p>
        </div>
      </details>
    </section>
  );
}
