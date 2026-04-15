/**
 * Browser-side Supabase client singleton.
 *
 * This prototype renders everything as Client Components (crypto requires
 * browser APIs), so we only need one shared browser client. For SSR-heavy
 * apps you'd use `@supabase/ssr` + cookie-based sessions instead.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let client: SupabaseClient | null = null;

function readEnv(): { url: string; anonKey: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error(
      'Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY. ' +
        'Copy .env.example to .env.local and fill in your Supabase keys.',
    );
  }
  return { url, anonKey };
}

export function getSupabase(): SupabaseClient {
  if (!client) {
    const { url, anonKey } = readEnv();
    client = createClient(url, anonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        // Implicit flow: magic-link tokens come back in the URL hash instead of
        // via a code-exchange that requires a verifier stored in localStorage.
        // This lets the link work across browsers/devices (you can request it
        // in Browser B and open the email in Browser A), which PKCE does not.
        flowType: 'implicit',
      },
      realtime: {
        params: { eventsPerSecond: 10 },
      },
    });
  }
  return client;
}
