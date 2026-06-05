export type OrderStatus =
  | 'created'
  | 'queued'
  | 'confirmed'
  | 'in_kitchen'
  | 'ready'
  | 'out_for_delivery'
  | 'delivered'
  | 'cancelled';

export type FulfillmentType = 'pickup' | 'delivery';

export type PaymentMethodCode =
  | 'pending'
  | 'payment_mobile'
  | 'transfer'
  | 'cash_usd'
  | 'cash_ves'
  | 'pos'
  | 'zelle'
  | 'retention'
  | 'mixed';

export type OperationalPhase = 'new' | 'kitchen' | 'ready' | 'route' | 'closed' | 'cancelled';

export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  created: 'Creada',
  queued: 'En cola',
  confirmed: 'En cocina',
  in_kitchen: 'Preparando',
  ready: 'Lista',
  out_for_delivery: 'En camino',
  delivered: 'Entregada',
  cancelled: 'Cancelada',
};

export const PAYMENT_METHOD_LABELS: Record<PaymentMethodCode, string> = {
  pending: 'Pendiente',
  payment_mobile: 'Pago móvil',
  transfer: 'Transferencia',
  cash_usd: 'Efectivo USD',
  cash_ves: 'Efectivo Bs',
  pos: 'Punto de venta',
  zelle: 'Zelle',
  retention: 'Retención',
  mixed: 'Mixto',
};

export const OPERATIONAL_PHASES: Array<{ key: OperationalPhase; label: string; shortLabel: string }> = [
  { key: 'new', label: 'Nuevas', shortLabel: 'Nuevas' },
  { key: 'kitchen', label: 'Cocina', shortLabel: 'Cocina' },
  { key: 'ready', label: 'Listas', shortLabel: 'Listas' },
  { key: 'route', label: 'Camino', shortLabel: 'Camino' },
  { key: 'closed', label: 'Entregadas', shortLabel: 'Entregadas' },
];

export const ORDER_ACTION_LABELS = {
  initialApproval: 'Por aprobar',
  reapproval: 'Re-aprobación',
  returned: 'Devuelta',
  paymentReview: 'Pago por validar',
  paymentRejected: 'Pago rechazado',
  paymentPending: 'Cobro pendiente',
} as const;

export function formatOrderDisplayNumber(orderId: number | string | null | undefined) {
  const numericId = Number(orderId);

  if (Number.isFinite(numericId) && numericId > 0) {
    return String(Math.trunc(numericId)).padStart(2, '0');
  }

  return String(orderId ?? '').trim() || 'Sin orden';
}

export function formatOrderDisplayLabel(orderId: number | string | null | undefined) {
  return `Orden ${formatOrderDisplayNumber(orderId)}`;
}

function isOrderStatus(value: string): value is OrderStatus {
  return value in ORDER_STATUS_LABELS;
}

export function getOrderStatusLabel(status: string | null | undefined, fulfillment?: FulfillmentType | null) {
  const key = String(status || '').trim();
  if (key === 'delivered' && fulfillment === 'pickup') return 'Retirada';
  return isOrderStatus(key) ? ORDER_STATUS_LABELS[key] : key || 'Sin estado';
}

export function getOperationalPhase(status: string | null | undefined): OperationalPhase {
  if (status === 'cancelled') return 'cancelled';
  if (status === 'delivered') return 'closed';
  if (status === 'out_for_delivery') return 'route';
  if (status === 'ready') return 'ready';
  if (status === 'confirmed' || status === 'in_kitchen') return 'kitchen';
  return 'new';
}

export function getOperationalPhaseIndex(status: string | null | undefined) {
  const phase = getOperationalPhase(status);
  if (phase === 'cancelled') return 0;
  return Math.max(0, OPERATIONAL_PHASES.findIndex((item) => item.key === phase));
}

export function getOperationalStatusLabel(order: {
  status: string | null | undefined;
  fulfillment?: FulfillmentType | null;
}) {
  if (order.status === 'ready' && order.fulfillment === 'pickup') return 'Lista para retiro';
  return getOrderStatusLabel(order.status, order.fulfillment);
}

export function getPaymentMethodLabel(
  method: string | null | undefined,
  options: { lowercase?: boolean; fallback?: string } = {}
) {
  const key = String(method || 'pending').trim() as PaymentMethodCode;
  const label = PAYMENT_METHOD_LABELS[key] ?? options.fallback ?? 'Pendiente';
  return options.lowercase ? label.toLocaleLowerCase('es-VE') : label;
}
