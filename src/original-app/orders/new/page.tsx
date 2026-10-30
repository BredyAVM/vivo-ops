import { redirect } from 'next/navigation';
import { getAuthContext, isAdvisorRole, isMasterOrAdminRole, resolveHomePath } from '@/lib/auth';

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

  redirect(resolveHomePath(ctx.roles));
}
