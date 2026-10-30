import 'server-only';
import { loadAdminFinanceAccountsOverview } from './accounts-data';
import { loadActiveOrdersOverview } from './active-orders-data';
import { accountsReport, activeOrdersReport } from './reports-model';
import type { DeliveryRpcClient } from './delivery-data';
export async function loadAdminReport(supabase: DeliveryRpcClient, domain: 'cuentas' | 'pedidos') {
  if (domain === 'cuentas') {
    const result = await loadAdminFinanceAccountsOverview({ supabase });
    if (result.status === 'error') return result;
    return { status: 'ready' as const, csv: accountsReport(result.data), asOf: result.data.asOf, count: result.data.accounts.length };
  }
  const result = await loadActiveOrdersOverview({ supabase });
  if (result.status === 'error') return result;
  return { status: 'ready' as const, csv: activeOrdersReport(result.data), asOf: result.data.asOf, count: result.data.orders.length };
}
