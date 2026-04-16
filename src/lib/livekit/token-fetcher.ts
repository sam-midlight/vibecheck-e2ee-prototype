/**
 * Default LiveKit token fetcher — POSTs to the edge function with the
 * caller's Supabase session token.
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

    const { data, error } = await supabase.functions.invoke('livekit-token', {
      body: { call_id: callId, device_id: deviceId },
    });
    if (error) {
      // `FunctionsHttpError` carries the HTTP status in its message text.
      throw new Error(error.message || 'livekit-token fetch failed');
    }
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
