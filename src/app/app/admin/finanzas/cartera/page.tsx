import Link from 'next/link';
import ReceivablesOverview from './_components/ReceivablesOverview';
import { requireAdminContext } from '@/lib/auth';
import {
  loadAdminFinanceReceivablesOverview,
  type AdminFinanceReceivablesRpcClient,
} from '@/lib/admin-finance/receivables-data';
import { normalizeAdminFinanceReceivablesFilters } from '@/lib/admin-finance/receivables-model';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function AdminFinanceReceivablesPage({
  searchParams,
}: {
  searchParams?: SearchParams;
}) {
  const filters = normalizeAdminFinanceReceivablesFilters((await searchParams) ?? {});
  const ctx = await requireAdminContext();
  const overview = await loadAdminFinanceReceivablesOverview({
    supabase: ctx.supabase as unknown as AdminFinanceReceivablesRpcClient,
    periodKey: filters.period,
    asOf: new Date(),
  });

  if (overview.status === 'error') {
    return (
      <section className="rounded-2xl border border-red-400/20 bg-red-400/5 p-5">
        <h1 className="text-lg font-semibold text-white">Cartera no disponible</h1>
        <p className="mt-1 text-sm text-red-100/75">{overview.message}</p>
        <Link
          href="/app/master/ops"
          prefetch={false}
          className="mt-4 inline-flex min-h-10 items-center rounded-xl border border-red-200/25 px-3 text-xs font-semibold text-red-100"
        >
          Abrir órdenes
        </Link>
      </section>
    );
  }

  return (
    <ReceivablesOverview
      overview={overview.data}
      filters={filters}
      basePath="/app/admin/finanzas/cartera"
    />
  );
}
