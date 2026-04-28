import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { configureWebPush, hasPushEnv } from '@/lib/push';

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

function isMissingTableError(message: string) {
  return /advisor_push_subscriptions/i.test(message) && /does not exist/i.test(message);
}

export async function POST(req: Request) {
  try {
    if (!hasPushEnv()) {
      return NextResponse.json({ error: 'Missing push environment variables' }, { status: 503 });
    }

    const body = (await req.json()) as { accessToken?: string };
    const accessToken = String(body.accessToken || '').trim();
    if (!accessToken) return NextResponse.json({ error: 'Missing accessToken' }, { status: 401 });

    const supa = serverSupabase();
    const { data: userRes, error: userErr } = await supa.auth.getUser(accessToken);
    if (userErr || !userRes?.user) {
      return NextResponse.json({ error: 'Invalid session' }, { status: 401 });
    }

    const { data: rows, error } = await supa
      .from('advisor_push_subscriptions')
      .select('endpoint, p256dh, auth')
      .eq('user_id', userRes.user.id)
      .eq('is_active', true);

    if (error) {
      if (isMissingTableError(error.message)) {
        return NextResponse.json(
          { error: 'Missing advisor_push_subscriptions table', code: 'missing_table' },
          { status: 503 }
        );
      }

      return NextResponse.json({ error: error.message }, { status: 400 });
    }

    if (!rows || rows.length === 0) {
      return NextResponse.json({ error: 'No active subscriptions found' }, { status: 404 });
    }

    const webpush = configureWebPush();
    const payload = JSON.stringify({
      title: 'VIVO OPS',
      body: 'Notificaciones listas en el asesor.',
      url: '/app/advisor/inbox?filter=all',
      tag: 'advisor-test',
    });

    const results = await Promise.allSettled(
      rows.map((row) =>
        webpush.sendNotification(
          {
            endpoint: String(row.endpoint),
            keys: {
              p256dh: String(row.p256dh),
              auth: String(row.auth),
            },
          },
          payload
        )
      )
    );

    let delivered = 0;
    let invalid = 0;

    for (const result of results) {
      if (result.status === 'fulfilled') {
        delivered += 1;
        continue;
      }

      const statusCode = Number((result.reason as { statusCode?: number })?.statusCode || 0);
      if (statusCode === 404 || statusCode === 410) invalid += 1;
    }

    if (invalid > 0) {
      const invalidEndpoints = rows
        .filter((_, index) => {
          const result = results[index];
          if (result?.status !== 'rejected') return false;
          const statusCode = Number((result.reason as { statusCode?: number })?.statusCode || 0);
          return statusCode === 404 || statusCode === 410;
        })
        .map((row) => String(row.endpoint));

      if (invalidEndpoints.length > 0) {
        await supa
          .from('advisor_push_subscriptions')
          .update({ is_active: false })
          .in('endpoint', invalidEndpoints);
      }
    }

    return NextResponse.json({ ok: true, delivered, invalid });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
