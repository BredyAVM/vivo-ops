import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import AdvisorShell from './AdvisorShell';
import AdvisorPwaRegistrar from './AdvisorPwaRegistrar';
import { countUnreadOrderNotificationsByKind, type RawOrderNotification } from './inbox/inbox-shared';
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

  const { data: notificationsData } = await ctx.supabase
    .from('notifications')
    .select('id, order_id, type, status, meta, created_at, read_at')
    .eq('recipient_user_id', ctx.user.id)
    .not('order_id', 'is', null)
    .order('created_at', { ascending: false })
    .limit(500);
  const notificationCounts = countUnreadOrderNotificationsByKind(
    (notificationsData ?? []) as RawOrderNotification[]
  );

  return (
    <AdvisorShell
      userId={ctx.user.id}
      fullName={
        profile?.full_name?.trim() ||
        ctx.user.user_metadata?.full_name ||
        ctx.user.user_metadata?.name ||
        'Asesor'
      }
      actionCount={notificationCounts.actions}
      updateCount={notificationCounts.updates}
    >
      <AdvisorPwaRegistrar />
      {children}
    </AdvisorShell>
  );
}
