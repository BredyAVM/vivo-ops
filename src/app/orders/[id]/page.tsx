import { redirect } from 'next/navigation';
import { getAuthContext, isAdvisorRole, isMasterOrAdminRole } from '@/lib/auth';

type PageParams = Promise<{
  id: string;
}>;

export default async function LegacyOrderDetailPage({
  params,
}: {
  params: PageParams;
}) {
  const ctx = await getAuthContext();

  if (!ctx) {
    redirect('/login');
  }

  const { id } = await params;
  const orderId = Number(id);

  if (isAdvisorRole(ctx.roles) && Number.isFinite(orderId) && orderId > 0) {
    redirect(`/app/advisor/orders/${orderId}`);
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
