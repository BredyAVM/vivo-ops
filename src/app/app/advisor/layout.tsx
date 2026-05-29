import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import AdvisorShell from './AdvisorShell';
import AdvisorPwaRegistrar from './AdvisorPwaRegistrar';
import { countCoalescedUnreadNotifications } from './inbox/inbox-shared';
import { getAuthContext, isMasterOrAdminRole, resolveHomePath } from '@/lib/auth';

export const metadata: Metadata = {
  title: 'VIVO OPS Asesor',
  description: 'Operacion movil del asesor en VIVO OPS',
  manifest: '/app/advisor/manifest.webmanifest',
  appleWebApp: {
    capable: true,
    title: 'VIVO OPS',
    statusBarStyle: 'black-translucent',
  },
  icons: {
    apple: '/pwa/advisor-180.png',
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: 'cover',
  themeColor: '#090B10',
};

export default async function AdvisorLayout({ children }: { children: ReactNode }) {
  const ctx = await getAuthContext();

  if (!ctx) {
    redirect('/login');
  }

  const canAccessAdvisor = isMasterOrAdminRole(ctx.roles) || ctx.roles.includes('advisor');
  if (!canAccessAdvisor) {
    redirect(resolveHomePath(ctx.roles));
  }

  const { data: profile } = await ctx.supabase
    .from('profiles')
    .select('full_name')
    .eq('id', ctx.user.id)
    .maybeSingle();

  const { data: recipientsData } = await ctx.supabase
    .from('order_timeline_event_recipients')
    .select('id, requires_action, read_at, event:order_timeline_events!inner(id, order_id, event_type, created_at)')
    .or(`target_user_id.eq.${ctx.user.id},target_role.eq.advisor`)
    .limit(200);

  const unreadCount = countCoalescedUnreadNotifications(recipientsData ?? []);

  return (
    <AdvisorShell
      userId={ctx.user.id}
      fullName={
        profile?.full_name?.trim() ||
        ctx.user.user_metadata?.full_name ||
        ctx.user.user_metadata?.name ||
        'Asesor'
      }
      unreadCount={unreadCount}
    >
      <AdvisorPwaRegistrar />
      {children}
    </AdvisorShell>
  );
}
