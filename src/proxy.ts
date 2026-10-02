import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';

export async function proxy(req: NextRequest) {
  const requestHeaders = new Headers(req.headers);
  // Never trust a client-provided workspace hint. Authorization remains in auth.ts.
  requestHeaders.set('x-vivo-workspace-path', req.nextUrl.pathname);
  const res = NextResponse.next({ request: { headers: requestHeaders } });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return req.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => {
            res.cookies.set(name, value, options);
          });
        },
      },
    }
  );

  let user = null;

  try {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    user = session?.user ?? null;
  } catch {
    user = null;
  }

  if (req.nextUrl.pathname.startsWith('/orders') || req.nextUrl.pathname.startsWith('/app')) {
    if (!user) {
      const url = req.nextUrl.clone();
      url.pathname = '/login';
      return NextResponse.redirect(url);
    }
  }

  return res;
}

export const config = {
  matcher: ['/orders/:path*', '/app/:path*'],
};
