import { redirect } from 'next/navigation';
import { getAuthContext, isAdvisorRole, isMasterOrAdminRole } from '@/lib/auth';

export default async function LegacyNewOrderPage() {
  const ctx = await getAuthContext();

  if (!ctx) {
    redirect('/login');
  }

  if (isAdvisorRole(ctx.roles)) {
    redirect('/app/advisor/new');
  }

  if (isMasterOrAdminRole(ctx.roles)) {
    redirect('/app/master/dashboard');
  }

  if (ctx.roles.includes('kitchen')) {
    redirect('/app/kitchen');
  }

  if (ctx.roles.includes('driver')) {
    redirect('/app/driver');
  }

  redirect('/app');
}
