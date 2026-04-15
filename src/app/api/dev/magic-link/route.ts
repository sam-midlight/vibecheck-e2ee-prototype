/**
 * TEMP DEV SHORTCUT — do not ship.
 *
 * Generates a Supabase magic-link URL server-side using the service-role key
 * and returns it to the client, instead of emailing it. Lets us click-through
 * the sign-in flow without waiting for SMTP.
 *
 * Guarded to `NODE_ENV !== 'production'` so this can't accidentally go live.
 * Requires `SUPABASE_SERVICE_ROLE_KEY` in .env.local (never exposed to the
 * client — it only exists in the server-side bundle).
 */
import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  if (process.env.NODE_ENV === 'production') {
    return NextResponse.json(
      { error: 'dev-only endpoint' },
      { status: 404 },
    );
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    return NextResponse.json(
      {
        error:
          'server missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY — add to .env.local',
      },
      { status: 500 },
    );
  }

  let email: string;
  let redirectTo: string | undefined;
  try {
    const body = (await req.json()) as { email?: unknown; redirectTo?: unknown };
    if (typeof body.email !== 'string' || !body.email.trim()) {
      return NextResponse.json({ error: 'email is required' }, { status: 400 });
    }
    email = body.email.trim();
    redirectTo =
      typeof body.redirectTo === 'string' ? body.redirectTo : undefined;
  } catch {
    return NextResponse.json({ error: 'invalid json body' }, { status: 400 });
  }

  const admin = createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data, error } = await admin.auth.admin.generateLink({
    type: 'magiclink',
    email,
    options: redirectTo ? { redirectTo } : undefined,
  });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  const actionLink = data?.properties?.action_link;
  if (!actionLink) {
    return NextResponse.json(
      { error: 'generateLink returned no action_link' },
      { status: 500 },
    );
  }
  return NextResponse.json({ url: actionLink });
}
