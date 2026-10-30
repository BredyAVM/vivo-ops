import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

type SaveBody = {
  accessToken?: string;
  displayName?: string;
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

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as SaveBody;
    const accessToken = String(body.accessToken || '').trim();
    const displayName = String(body.displayName || '').trim();

    if (!accessToken) {
      return NextResponse.json({ error: 'Missing accessToken' }, { status: 401 });
    }

    if (!displayName) {
      return NextResponse.json({ error: 'Missing displayName' }, { status: 400 });
    }

    const { supa, user } = await getActorUser(accessToken);
    if (!user) {
      return NextResponse.json({ error: 'Invalid session' }, { status: 401 });
    }

    const { error: metadataError } = await supa.auth.admin.updateUserById(user.id, {
      user_metadata: {
        ...(user.user_metadata || {}),
        full_name: displayName,
        name: displayName,
      },
    });

    if (metadataError) {
      return NextResponse.json({ error: metadataError.message }, { status: 400 });
    }

    const { data: existingProfile } = await supa
      .from('profiles')
      .select('id')
      .eq('id', user.id)
      .maybeSingle();

    let profileWarning: string | null = null;

    if (existingProfile?.id) {
      const { error: updateProfileError } = await supa
        .from('profiles')
        .update({ full_name: displayName })
        .eq('id', user.id);

      if (updateProfileError) {
        profileWarning = updateProfileError.message;
      }
    } else {
      const { error: insertProfileError } = await supa
        .from('profiles')
        .insert({ id: user.id, full_name: displayName });

      if (insertProfileError) {
        profileWarning = insertProfileError.message;
      }
    }

    return NextResponse.json({
      ok: true,
      profileWarning,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
