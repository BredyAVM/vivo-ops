export type EventUnit = 'UND' | 'servicio' | 'envase';
export type EventRate = { product_id: number; product_name: string; price: number; unit: EventUnit; preparation_mode: string };
export type EventTerms = { currency: 'USD' | 'VES'; commission_mode: string; commission_value: number | null; rates: EventRate[] };
export type EventRequestItem = Omit<EventRate, 'price'> & { qty: number; price: number | null; is_delivery: boolean };
export type EventRequest = { id: number; converted_order_id: number | null; extension: {
  stage: string; currency: 'USD' | 'VES'; amount: number | null; items: EventRequestItem[];
  reason?: string; requested_at: string; request_input: { date: string; time: string; fulfillment: string; address?: string; note?: string };
  terms_snapshot?: Partial<EventTerms>;
} };
export type EventFinancialOrder = { order_id: number; order_status: string; total_usd: number; total_bs: number; confirmed_paid_usd: number; pending_usd: number; overpaid_usd: number; pending_reports_count: number };
export type EventWorkspace = {
  root: { id: number; title: string; converted_order_id: number | null; payload: {
    event_budget: { event_date: string; event_time: string; delivery_address: string; fulfillment: string; components?: { product_id: number; product_name: string }[] };
    event_terms?: EventTerms; event_state?: { closed: boolean };
  } };
  requests: EventRequest[]; orders: EventFinancialOrder[]; products: { id: number; name: string }[];
};
export function summarizeEventOrders(orders: EventFinancialOrder[], rootOrderId: number | null) {
  const result = { initial: 0, additions: 0, total: 0, paid: 0, pending: 0, overpaid: 0, pendingReports: 0 };
  for (const order of orders) {
    if (order.order_status === 'cancelled') continue;
    const total = Number(order.total_usd || 0);
    result[Number(order.order_id) === Number(rootOrderId) ? 'initial' : 'additions'] += total;
    result.total += total;
    result.paid += Number(order.confirmed_paid_usd || 0);
    // Do not silently move credit from one order to another.
    result.pending += Number(order.pending_usd || 0);
    result.overpaid += Number(order.overpaid_usd || 0);
    result.pendingReports += Number(order.pending_reports_count || 0);
  }
  return result;
}
export const eventRequestLabel: Record<string, string> = {
  requested: 'Precio pendiente de Administración', priced: 'Pendiente de Máster', approved: 'Orden creada', rejected: 'Rechazada',
};
export const eventOrderLabel: Record<string, string> = {
  created: 'Por aprobar', queued: 'En cola', confirmed: 'Enviada a cocina', in_kitchen: 'En preparación', ready: 'Lista', out_for_delivery: 'En camino', delivered: 'Entregada', cancelled: 'Cancelada',
};
