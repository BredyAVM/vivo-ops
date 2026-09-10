import 'server-only';
import { loadAdminFinanceAccountsOverview } from './accounts-data';
import { loadActiveOrdersOverview } from './active-orders-data';
import { loadCommissionsOverview } from './commissions-data';
import { selectCommissionPeriod } from './commissions-model';
import { getCaracasDateKey } from './period';
import { buildAdminTaskGroups } from './tasks-model';
import type { DeliveryRpcClient } from './delivery-data';
export async function loadAdminTasks(supabase: DeliveryRpcClient) {
  const now = new Date();
  const [accounts, orders, commissions] = await Promise.all([
    loadAdminFinanceAccountsOverview({ supabase }), loadActiveOrdersOverview({ supabase }), loadCommissionsOverview({ supabase }),
  ]);
  const errors = [accounts.status === 'error' ? 'Cuentas' : '', orders.status === 'error' ? 'Pedidos' : '', commissions.status === 'error' ? 'Comisiones' : ''].filter(Boolean);
  return { asOf: now.toISOString(), errors, groups: buildAdminTaskGroups({ accounts: accounts.status === 'ready' ? accounts.data.accounts : [], orders: orders.status === 'ready' ? orders.data.orders : [], commissions: commissions.status === 'ready' ? commissions.data.rows : [], currentPeriodId: commissions.status === 'ready' ? selectCommissionPeriod(commissions.data, null)?.id ?? null : null, today: getCaracasDateKey(now) }) };
}
