import Link from 'next/link';
import AccountsOverview from './_components/AccountsOverview';
import { requireAdminContext } from '@/lib/auth';
import {
  loadAdminFinanceAccountsOverview,
  type AdminFinanceAccountsRpcClient,
} from '@/lib/admin-finance/accounts-data';
import { normalizeAdminFinanceAccountsFilters } from '@/lib/admin-finance/accounts-model';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function AdminFinanceAccountsPage({
  searchParams,
}: {
  searchParams?: SearchParams;
}) {
  const filters = normalizeAdminFinanceAccountsFilters((await searchParams) ?? {});
  const ctx = await requireAdminContext();
  const overview = await loadAdminFinanceAccountsOverview({
    supabase: ctx.supabase as unknown as AdminFinanceAccountsRpcClient,
    asOf: new Date(),
  });

  if (overview.status === 'error') {
    return (
      <section className="rounded-2xl border border-red-400/20 bg-red-400/5 p-5">
        <h1 className="text-lg font-semibold text-white">Cuentas no disponibles</h1>
        <p className="mt-1 text-sm text-red-100/75">{overview.message}</p>
        <Link
          href="/app/master/dashboard"
          prefetch={false}
          className="mt-4 inline-flex min-h-10 items-center rounded-xl border border-red-200/25 px-3 text-xs font-semibold text-red-100"
        >
          Abrir panel vigente
        </Link>
      </section>
    );
  }

  return (
    <AccountsOverview
      overview={overview.data}
      filters={filters}
      basePath="/app/admin/finanzas/cuentas"
    />
  );
}
