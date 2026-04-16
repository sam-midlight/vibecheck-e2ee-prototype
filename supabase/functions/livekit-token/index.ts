// ============================================================================
// livekit-token — mints short-lived LiveKit JWTs for authenticated, unrevoked,
// active call-member devices.
//
// Why server-minted: the LiveKit JWT binds (user_id:device_id) to a specific
// call. The app-layer Supabase JWT can't double as a LiveKit JWT (different
// secret, different claims), and we want the edge function to re-check
// revocation state + call membership on every mint. 5-minute TTL means a
// revoked device loses SFU access within one renewal cycle even if its
// current connection is still open.
//
// POST body: { call_id: string (uuid), device_id: string (uuid) }
// Auth:      standard Supabase user JWT in Authorization header
// Response:  { jwt, url, expiresAt } — expiresAt is epoch millis for client
//            renewal scheduling
//
// Runtime: Deno (Supabase edge). HS256 JWT is hand-rolled via Web Crypto to
// avoid a Deno-compatibility audit on external libs.
// ============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

type JsonRecord = Record<string, unknown>;

function corsHeaders(origin: string | null): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': origin ?? '*',
    'Access-Control-Allow-Headers':
      'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}

function jsonResponse(
  status: number,
  body: JsonRecord,
  origin: string | null,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(origin),
    },
  });
}

// ---------------------------------------------------------------------------
// HS256 JWT helpers (Web Crypto).
// ---------------------------------------------------------------------------

function b64urlEncode(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlEncodeString(s: string): string {
  return b64urlEncode(new TextEncoder().encode(s));
}

async function signHS256(
  header: JsonRecord,
  payload: JsonRecord,
  secret: string,
): Promise<string> {
  const h = b64urlEncodeString(JSON.stringify(header));
  const p = b64urlEncodeString(JSON.stringify(payload));
  const signingInput = `${h}.${p}`;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${b64urlEncode(new Uint8Array(sig))}`;
}

// ---------------------------------------------------------------------------
// Handler.
// ---------------------------------------------------------------------------

Deno.serve(async (req: Request) => {
  const origin = req.headers.get('origin');

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }
  if (req.method !== 'POST') {
    return jsonResponse(405, { error: 'method not allowed' }, origin);
  }

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
  const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY');
  const LIVEKIT_API_KEY = Deno.env.get('LIVEKIT_API_KEY');
  const LIVEKIT_API_SECRET = Deno.env.get('LIVEKIT_API_SECRET');
  const LIVEKIT_WS_URL = Deno.env.get('LIVEKIT_WS_URL');

  if (
    !SUPABASE_URL ||
    !SUPABASE_ANON_KEY ||
    !LIVEKIT_API_KEY ||
    !LIVEKIT_API_SECRET ||
    !LIVEKIT_WS_URL
  ) {
    return jsonResponse(500, { error: 'server misconfigured' }, origin);
  }

  const authHeader = req.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return jsonResponse(401, { error: 'missing auth' }, origin);
  }

  let body: { call_id?: unknown; device_id?: unknown };
  try {
    body = await req.json();
  } catch {
    return jsonResponse(400, { error: 'bad json' }, origin);
  }
  const callId = typeof body.call_id === 'string' ? body.call_id : null;
  const deviceId = typeof body.device_id === 'string' ? body.device_id : null;
  if (!callId || !deviceId) {
    return jsonResponse(
      400,
      { error: 'call_id and device_id required' },
      origin,
    );
  }

  // Supabase client scoped to the caller's JWT — RLS + auth.uid() apply.
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: userData, error: userErr } = await supabase.auth.getUser();
  if (userErr || !userData?.user) {
    return jsonResponse(401, { error: 'invalid session' }, origin);
  }
  const userId = userData.user.id;

  // Device must belong to caller and be unrevoked.
  const { data: device, error: devErr } = await supabase
    .from('devices')
    .select('id, user_id, revoked_at_ms')
    .eq('id', deviceId)
    .maybeSingle();
  if (devErr) {
    return jsonResponse(500, { error: 'device lookup failed' }, origin);
  }
  if (!device || device.user_id !== userId || device.revoked_at_ms !== null) {
    return jsonResponse(
      403,
      { error: 'device not active for this user' },
      origin,
    );
  }

  // Device must be an active call member.
  const { data: member, error: memErr } = await supabase
    .from('call_members')
    .select('call_id, device_id, left_at')
    .eq('call_id', callId)
    .eq('device_id', deviceId)
    .maybeSingle();
  if (memErr) {
    return jsonResponse(500, { error: 'membership lookup failed' }, origin);
  }
  if (!member || member.left_at !== null) {
    return jsonResponse(
      403,
      { error: 'device is not an active call member' },
      origin,
    );
  }

  // Mint LiveKit JWT.
  const nowSec = Math.floor(Date.now() / 1000);
  const ttlSec = 5 * 60; // §7.1 of the design doc
  const expSec = nowSec + ttlSec;

  const header = { alg: 'HS256', typ: 'JWT' };
  const payload: JsonRecord = {
    iss: LIVEKIT_API_KEY,
    sub: `${userId}:${deviceId}`,
    nbf: nowSec,
    exp: expSec,
    name: `${userId}:${deviceId}`,
    video: {
      room: `call:${callId}`,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    },
  };

  const jwt = await signHS256(header, payload, LIVEKIT_API_SECRET);

  return jsonResponse(
    200,
    {
      jwt,
      url: LIVEKIT_WS_URL,
      expiresAt: expSec * 1000,
    },
    origin,
  );
});
