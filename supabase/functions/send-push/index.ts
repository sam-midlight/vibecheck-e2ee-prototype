/**
 * send-push — Supabase Edge Function that dispatches a Web Push
 * notification to every registered device of every room member EXCEPT
 * the sender. Intended to be invoked by a postgres trigger on
 * `blobs` INSERT (see supabase/migrations/0045_blobs_push_trigger.sql).
 *
 * The trigger sends us:
 *   { room_id: uuid, sender_id: uuid, blob_id: uuid }
 *
 * We look up current-gen members of the room, pull their push
 * subscriptions, and post a generic payload to each. Zero content leaks
 * — just "💫 new in your room" + the roomId for click-through.
 *
 * Requires these edge-function secrets:
 *   VAPID_PUBLIC_KEY   (same as NEXT_PUBLIC_VAPID_PUBLIC_KEY in the app)
 *   VAPID_PRIVATE_KEY  (kept server-side only)
 *   VAPID_SUBJECT      (e.g. "mailto:owner@example.com" — required by the
 *                       VAPID spec; otherwise Push services 400)
 *   SEND_PUSH_SECRET   (shared with the DB trigger's internal.push_config)
 */

// @ts-expect-error — Deno-only import resolved at edge runtime, ignored in app TS
import webpush from 'https://esm.sh/web-push@3.6.7';
// @ts-expect-error — Deno-only
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.103.0';

// Deno.env exists at edge runtime; declare loosely to keep local tsc happy.
declare const Deno: { env: { get(k: string): string | undefined }; serve: (h: (req: Request) => Promise<Response> | Response) => void };

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const VAPID_PUBLIC_KEY = Deno.env.get('VAPID_PUBLIC_KEY')!;
const VAPID_PRIVATE_KEY = Deno.env.get('VAPID_PRIVATE_KEY')!;
const VAPID_SUBJECT = Deno.env.get('VAPID_SUBJECT') ?? 'mailto:unset@example.com';
// Shared secret the DB trigger includes so random callers can't spam
// pushes. The trigger posts with header `x-edge-secret: $secret`.
const EDGE_SECRET = Deno.env.get('SEND_PUSH_SECRET') ?? '';

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

interface TriggerPayload {
  room_id: string;
  sender_id: string;
  blob_id?: string;
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }
  if (EDGE_SECRET && req.headers.get('x-edge-secret') !== EDGE_SECRET) {
    return new Response('Forbidden', { status: 403 });
  }
  let body: TriggerPayload;
  try {
    body = await req.json();
  } catch {
    return new Response('Bad JSON', { status: 400 });
  }
  if (!body.room_id || !body.sender_id) {
    return new Response('Missing room_id or sender_id', { status: 400 });
  }

  const supa = createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { persistSession: false },
  });

  const { data: room } = await supa
    .from('rooms')
    .select('current_generation')
    .eq('id', body.room_id)
    .maybeSingle();
  if (!room) return new Response('Unknown room', { status: 404 });

  const { data: members } = await supa
    .from('room_members')
    .select('user_id')
    .eq('room_id', body.room_id)
    .eq('generation', room.current_generation);
  const recipients = (members ?? [])
    .map((m: { user_id: string }) => m.user_id)
    .filter((uid: string) => uid !== body.sender_id);
  if (recipients.length === 0) return new Response('No recipients', { status: 200 });

  const { data: subs } = await supa
    .from('push_subscriptions')
    .select('id, endpoint, p256dh, auth, user_id')
    .in('user_id', recipients);
  if (!subs || subs.length === 0) {
    return new Response('No subscribed devices', { status: 200 });
  }

  const payload = JSON.stringify({
    title: '💫 Something new in your room',
    body: 'Open VibeCheck to see.',
    roomId: body.room_id,
  });

  const results = await Promise.allSettled(
    subs.map(async (s: { id: string; endpoint: string; p256dh: string; auth: string }) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          payload,
          { TTL: 3600 },
        );
        await supa
          .from('push_subscriptions')
          .update({ last_used: new Date().toISOString() })
          .eq('id', s.id);
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) {
          await supa.from('push_subscriptions').delete().eq('id', s.id);
        }
        throw err;
      }
    }),
  );

  const sent = results.filter((r) => r.status === 'fulfilled').length;
  const failed = results.length - sent;
  return new Response(
    JSON.stringify({ sent, failed }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
});
