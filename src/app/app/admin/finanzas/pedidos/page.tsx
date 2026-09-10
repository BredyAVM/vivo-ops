import Link from 'next/link';
import { requireAdminContext } from '@/lib/auth';
import { loadActiveOrdersOverview, type ActiveOrdersRpcClient } from '@/lib/admin-finance/active-orders-data';
import { normalizeActiveOrdersFilters } from '@/lib/admin-finance/active-orders-model';
import ActiveOrdersOverview from './_components/ActiveOrdersOverview';

export default async function AdminActiveOrdersPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await requireAdminContext();
  const filters = normalizeActiveOrdersFilters(await searchParams);
  const result = await loadActiveOrdersOverview({ supabase: ctx.supabase as unknown as ActiveOrdersRpcClient });
  if (result.status === 'error') {
    return <section className="rounded-2xl border border-red-400/20 bg-red-400/5 p-5">
      <h1 className="text-lg font-semibold text-white">Pedidos no disponibles</h1>
      <p className="mt-2 text-sm text-red-100">{result.message}</p>
      <Link href="/app/master/ops" prefetch={false} className="mt-4 inline-flex min-h-11 items-center text-sm text-white underline">Abrir órdenes</Link>
    </section>;
  }
  return <ActiveOrdersOverview overview={result.data} filters={filters} />;
}
