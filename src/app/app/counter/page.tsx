import { unstable_noStore as noStore } from 'next/cache';
import { redirect } from 'next/navigation';
import { getAuthContext, isCounterOperatorRole, resolveHomePath } from '@/lib/auth';
import { getPublicVapidKey } from '@/lib/push';
import CounterClient from './CounterClient';
import {
  loadCounterActiveQueueRead,
  loadCounterConfigurationRead,
} from './read-model';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function CounterPage() {
  noStore();

  const ctx = await getAuthContext();
  if (!ctx) redirect('/login');
  if (!isCounterOperatorRole(ctx.roles)) redirect(resolveHomePath(ctx.roles));

  const [configuration, orders] = await Promise.all([
    loadCounterConfigurationRead(ctx.supabase),
    loadCounterActiveQueueRead(ctx.supabase),
  ]);

  return (
    <CounterClient
      publicVapidKey={getPublicVapidKey()}
      fullName={
        configuration.fullName ||
        ctx.user.user_metadata?.full_name ||
        ctx.user.user_metadata?.name ||
        'Mostrador'
      }
      orders={orders}
      paymentAccounts={configuration.paymentAccounts}
      activeBsRate={configuration.activeBsRate}
    />
  );
}
