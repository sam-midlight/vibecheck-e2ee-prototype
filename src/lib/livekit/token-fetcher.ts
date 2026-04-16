/**
 * Default LiveKit token fetcher — POSTs to the edge function with the
 * caller's Supabase session token.
 *
 * Uses plain fetch (not supabase.functions.invoke) so we can be explicit
 * about BOTH headers the Supabase Edge gateway requires:
 *   - apikey: the public anon key (gateway auth)
 *   - Authorization: Bearer <user_jwt>   (our function's verify_jwt check)
 *
 * Separated from the adapter so tests/SSR paths can supply their own fetcher.
 */

import { getSupabase } from '@/lib/supabase/client';
import type { LiveKitTokenFetcher, LiveKitTokenResponse } from './adapter';

export function makeDefaultTokenFetcher(): LiveKitTokenFetcher {
  return async (callId, deviceId): Promise<LiveKitTokenResponse> => {
    const supabase = getSupabase();
    const { data: sess } = await supabase.auth.getSession();
    const accessToken = sess?.session?.access_token;
    if (!accessToken) {
      throw new Error('no supabase session');
    }

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!supabaseUrl || !supabaseAnonKey) {
      throw new Error('supabase env vars missing');
    }

    const res = await fetch(`${supabaseUrl}/functions/v1/livekit-token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: supabaseAnonKey,
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ call_id: callId, device_id: deviceId }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(
        `livekit-token ${res.status}: ${text || res.statusText}`,
      );
    }
    const data = (await res.json()) as unknown;
    if (!data || typeof data !== 'object') {
      throw new Error('livekit-token returned no data');
    }
    const { jwt, url, expiresAt } = data as {
      jwt?: unknown;
      url?: unknown;
      expiresAt?: unknown;
    };
    if (
      typeof jwt !== 'string' ||
      typeof url !== 'string' ||
      typeof expiresAt !== 'number'
    ) {
      throw new Error('livekit-token returned malformed data');
    }
    return { jwt, url, expiresAt };
  };
}
