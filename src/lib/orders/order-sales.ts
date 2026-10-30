// Shared operational criteria for Master and Administration. Delivery recognition
// is a separate financial cohort and must not replace these scheduled sales KPIs.
type SalesOrder = { status: string | null | undefined; totalUsd?: number | null };

export function isScheduledClosingOrder(order: SalesOrder) {
  return String(order.status || '').trim() !== 'cancelled' && Number(order.totalUsd || 0) > 0.005;
}

export function isRecognizedBillingOrder(order: SalesOrder) {
  return !['created', 'cancelled'].includes(String(order.status || '').trim()) && Number(order.totalUsd || 0) > 0.005;
}
