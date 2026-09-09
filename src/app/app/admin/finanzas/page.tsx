import FinancialDashboard from '../_components/FinancialDashboard';
import { requireAdminContext } from '@/lib/auth';
import { loadAdminFinancialOverview, type AdminFinanceRpcClient } from '@/lib/admin-finance/data';
import { ADMIN_FINANCE_DEFINITION_VERSION } from '@/lib/admin-finance/model';
import { normalizeAdminFinancePeriod, parseAdminFinanceAsOf } from '@/lib/admin-finance/period';
import { notFound } from 'next/navigation';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function firstParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export default async function AdminFinancesPage({ searchParams }: { searchParams?: SearchParams }) {
  const params = (await searchParams) ?? {};
  const periodKey = normalizeAdminFinancePeriod(firstParam(params.period));
  const requestedDefinition = firstParam(params.definition);
  if (requestedDefinition && requestedDefinition !== ADMIN_FINANCE_DEFINITION_VERSION) notFound();
  const asOf = parseAdminFinanceAsOf(firstParam(params.asOf));
  const ctx = await requireAdminContext();
  const overview = await loadAdminFinancialOverview({
    supabase: ctx.supabase as unknown as AdminFinanceRpcClient,
    periodKey,
    asOf,
  });

  return <FinancialDashboard overview={overview} basePath="/app/admin/finanzas" detail />;
}
