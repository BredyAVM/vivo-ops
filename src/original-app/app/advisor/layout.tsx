import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import AdvisorShell from './AdvisorShell';
import AdvisorPwaRegistrar from './AdvisorPwaRegistrar';
import {
  ADVISOR_TIMELINE_RECIPIENT_SELECT,
  countCommissionNotificationsByKind,
  countCoalescedNotificationsByKind,
  type InboxRecipientCountRow,
  type RawCommissionNotification,
} from './inbox/inbox-shared';
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
    .select('full_name, receives_commissions')
    .eq('id', ctx.user.id)
    .maybeSingle();

  const [recipientsResult, commissionNotificationsResult] = await Promise.all([
    ctx.supabase
      .from('order_timeline_event_recipients')
      .select(ADVISOR_TIMELINE_RECIPIENT_SELECT)
      .eq('target_user_id', ctx.user.id)
      .order('created_at', { ascending: false })
      .limit(500),
    ctx.supabase
      .from('notifications')
      .select('id, status, title, body, meta, created_at, read_at')
      .eq('recipient_user_id', ctx.user.id)
      .contains('meta', { domain: 'advisor_commissions' })
      .order('created_at', { ascending: false })
      .limit(100),
  ]);
  const orderNotificationCounts = countCoalescedNotificationsByKind(
    (recipientsResult.data ?? []) as unknown as InboxRecipientCountRow[]
  );
  const commissionNotificationCounts = countCommissionNotificationsByKind(
    (commissionNotificationsResult.data ?? []) as RawCommissionNotification[],
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
      actionCount={orderNotificationCounts.unreadActions + commissionNotificationCounts.unreadActions}
      updateCount={orderNotificationCounts.unreadUpdates + commissionNotificationCounts.unreadUpdates}
      receivesCommissions={profile?.receives_commissions === true}
    >
      <AdvisorPwaRegistrar />
      {children}
    </AdvisorShell>
  );
}
