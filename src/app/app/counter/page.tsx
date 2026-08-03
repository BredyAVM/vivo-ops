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

function formatCounterOperatingDate(date: Date) {
  const label = new Intl.DateTimeFormat('es-VE', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'America/Caracas',
  }).format(date);
  return label.charAt(0).toLocaleUpperCase('es-VE') + label.slice(1);
}

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
      operatingDateLabel={formatCounterOperatingDate(new Date())}
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
