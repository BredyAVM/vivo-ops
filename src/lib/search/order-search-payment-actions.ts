'use server';

import { requireMasterOrAdminContext } from '@/lib/auth';
import { searchMasterDirectoryAction } from '@/app/app/master/dashboard/actions';
import { readOrderSearchPayments, searchPaymentOrderIds, type OrderSearchPayment } from './order-search-payments';

/** Extends the operational workspace only; the legacy Dashboard stays unchanged. */
export async function searchOrderDirectoryWithPaymentsAction(input: { query: string; localOrderIds: number[] }) {
  const { supabase } = await requireMasterOrAdminContext();
  const localIds = searchPaymentOrderIds(input.localOrderIds, 10);
  const query = String(input.query ?? '').trim();
  if (query.length < 2 && !/^\d+$/.test(query)) return { orders: [], clients: [], payments: [] as OrderSearchPayment[] };
  const results = await searchMasterDirectoryAction({ query, limit: 10 });
  const ids = searchPaymentOrderIds([...localIds, ...results.orders.map(order => order.id)]);
  let payments: OrderSearchPayment[] = [];
  try {
    payments = await readOrderSearchPayments(ids, orderIds => supabase.rpc('get_orders_financial_state', {
      p_order_ids: orderIds, p_operation_date: null, p_active_bs_rate: null,
    }));
  } catch {
    // Keep matches usable but never manufacture a zero balance on read failure.
  }
  return { ...results, payments };
}
