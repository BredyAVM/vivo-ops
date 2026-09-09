import type { SupabaseClient } from '@supabase/supabase-js';
import ExecutiveDashboard from './_components/ExecutiveDashboard';
import { requireAdminContext } from '@/lib/auth';
import { loadAdminExecutiveKpiDomain } from '@/lib/admin-finance/executive-data';
import { loadAdminFinancialOverview, type AdminFinanceRpcClient } from '@/lib/admin-finance/data';

export default async function AdminHomePage() {
  const ctx = await requireAdminContext();
  const asOf = new Date();
  const [executive, finance] = await Promise.all([
    loadAdminExecutiveKpiDomain({
      supabase: ctx.supabase as unknown as SupabaseClient,
      asOf,
    }),
    loadAdminFinancialOverview({
      supabase: ctx.supabase as unknown as AdminFinanceRpcClient,
      periodKey: 'week',
      asOf,
    }),
  ]);

  return <ExecutiveDashboard executive={executive} finance={finance} />;
}
