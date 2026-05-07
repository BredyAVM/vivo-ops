import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { normalizePushSubscription } from '@/lib/push';

type SaveBody = {
  accessToken?: string;
  subscription?: unknown;
  scope?: string;
};

function serverSupabase() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error('Missing SUPABASE_URL/NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in env.');
  }

  return createClient(url, key, {
    auth: { persistSession: false },
  });
}

async function getActorUser(accessToken: string) {
  const supa = serverSupabase();
  const { data, error } = await supa.auth.getUser(accessToken);
  if (error || !data?.user) return { supa, user: null };
  return { supa, user: data.user };
}

function isMissingTableError(message: string) {
  return /user_push_subscriptions/i.test(message) && /does not exist/i.test(message);
}

function normalizeScope(value: unknown) {
  const scope = String(value || '').trim().toLowerCase();
  if (scope === 'master' || scope === 'advisor' || scope === 'kitchen' || scope === 'driver') return scope;
  return 'app';
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as SaveBody;
    const accessToken = String(body.accessToken || '').trim();
    if (!accessToken) return NextResponse.json({ error: 'Missing accessToken' }, { status: 401 });

    const subscription = normalizePushSubscription(body.subscription);
    if (!subscription) {
      return NextResponse.json({ error: 'Invalid subscription payload' }, { status: 400 });
    }

    const { supa, user } = await getActorUser(accessToken);
    if (!user) return NextResponse.json({ error: 'Invalid session' }, { status: 401 });

    const payload = {
      user_id: user.id,
      endpoint: subscription.endpoint,
      p256dh: subscription.keys.p256dh,
      auth: subscription.keys.auth,
      user_agent: req.headers.get('user-agent'),
      scope: normalizeScope(body.scope),
      is_active: true,
      last_seen_at: new Date().toISOString(),
    };

    const { error } = await supa.from('user_push_subscriptions').upsert(payload, {
      onConflict: 'endpoint',
    });

    if (error) {
      if (isMissingTableError(error.message)) {
        return NextResponse.json(
          { error: 'Missing user_push_subscriptions table', code: 'missing_table' },
          { status: 503 }
        );
      }

      return NextResponse.json({ error: error.message }, { status: 400 });
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

export async function DELETE(req: Request) {
  try {
    const body = (await req.json()) as SaveBody;
    const accessToken = String(body.accessToken || '').trim();
    if (!accessToken) return NextResponse.json({ error: 'Missing accessToken' }, { status: 401 });

    const subscription = normalizePushSubscription(body.subscription);
    if (!subscription) {
      return NextResponse.json({ error: 'Invalid subscription payload' }, { status: 400 });
    }

    const { supa, user } = await getActorUser(accessToken);
    if (!user) return NextResponse.json({ error: 'Invalid session' }, { status: 401 });

    const { error } = await supa
      .from('user_push_subscriptions')
      .delete()
      .eq('user_id', user.id)
      .eq('endpoint', subscription.endpoint);

    if (error) {
      if (isMissingTableError(error.message)) {
        return NextResponse.json(
          { error: 'Missing user_push_subscriptions table', code: 'missing_table' },
          { status: 503 }
        );
      }

      return NextResponse.json({ error: error.message }, { status: 400 });
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
