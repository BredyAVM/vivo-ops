import 'server-only';
import { parseDeliveryOverview, parseDeliverySettlement, type DeliveryFilters } from './delivery-model';
export type DeliveryRpcClient = { rpc: (name: string, params: Record<string, unknown>) => Promise<{ data: unknown; error: { message?: string } | null }> };
export async function loadDeliveryOverview(supabase: DeliveryRpcClient, filters: DeliveryFilters) {
  const now = new Date();
  try {
    const response = await supabase.rpc('admin_delivery_overview_v1', { p_from: filters.from, p_to: filters.to, p_mode: filters.mode, p_query: filters.q, p_offset: (filters.page - 1) * 30, p_settlement_before: filters.settlementBefore || null, p_settlement_id: filters.settlementId ? Number(filters.settlementId) : null });
    if (response.error) throw new Error(response.error.message);
    return { status: 'ready' as const, data: parseDeliveryOverview(response.data, filters, now) };
  } catch (error) {
    console.warn('admin delivery unavailable', error instanceof Error ? error.message : 'unknown');
    return { status: 'error' as const, message: 'No pudimos consultar Delivery. No se modificó ninguna entrega ni liquidación.' };
  }
}
export async function loadDeliverySettlement(supabase: DeliveryRpcClient, id: number) {
  try {
    const result = await supabase.rpc('counter_read_delivery_settlement_detail', { p_settlement_id: id, p_order_id: null });
    if (result.error) throw new Error(result.error.message);
    return { status: 'ready' as const, data: parseDeliverySettlement(result.data, id) };
  } catch (error) {
    console.warn('admin delivery settlement unavailable', error instanceof Error ? error.message : 'unknown');
    return { status: 'error' as const, message: 'No pudimos consultar esta liquidación. No se modificó ningún importe.' };
  }
}
