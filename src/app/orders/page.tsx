import { redirect } from 'next/navigation';
import { getAuthContext, isAdvisorRole, isMasterOrAdminRole, resolveHomePath } from '@/lib/auth';

export default async function LegacyOrdersPage() {
  const ctx = await getAuthContext();

  if (!ctx) {
    redirect('/login');
  }

  if (isMasterOrAdminRole(ctx.roles)) {
    redirect('/app/master/dashboard');
  }

  if (isAdvisorRole(ctx.roles)) {
    redirect('/app/advisor/orders');
  }

  redirect(resolveHomePath(ctx.roles));
}
