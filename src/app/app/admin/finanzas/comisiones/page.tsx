import Link from 'next/link';
import { requireAdminContext } from '@/lib/auth';
import { loadCommissionsOverview, type CommissionsRpcClient } from '@/lib/admin-finance/commissions-data';
import { normalizeCommissionFilters } from '@/lib/admin-finance/commissions-model';
import CommissionsOverview from './_components/CommissionsOverview';

export default async function AdminCommissionsPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await requireAdminContext();
  const filters = normalizeCommissionFilters(await searchParams);
  const result = await loadCommissionsOverview({ supabase: ctx.supabase as unknown as CommissionsRpcClient });
  if (result.status === 'error') return <section className="rounded-2xl border border-red-400/20 p-5">
    <h1 className="text-lg font-semibold text-white">Comisiones no disponibles</h1>
    <p className="mt-2 text-sm text-red-100">{result.message}</p>
    <Link href="/app/commissions" prefetch={false} className="mt-3 inline-flex min-h-11 items-center text-white underline">Abrir módulo de comisiones</Link>
  </section>;
  return <CommissionsOverview data={result.data} filters={filters} />;
}
