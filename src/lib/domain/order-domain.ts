import {
  ORDER_STATUS_LABELS,
  type FulfillmentType,
  type OrderStatus,
  getOperationalPhase,
  getOperationalStatusLabel,
  getOrderStatusLabel,
} from '@/lib/orders/order-labels';
import type { AppRole } from './role-domain';

export type { FulfillmentType, OrderStatus };

export type OrderActionKey =
  | 'approve'
  | 'return_to_advisor'
  | 'send_to_kitchen'
  | 'take_in_kitchen'
  | 'mark_ready'
  | 'assign_delivery'
  | 'out_for_delivery'
  | 'mark_delivered'
  | 'cancel'
  | 'admin_edit';

export type OfficialOrderDateKey =
  | 'created_at'
  | 'delivery_reference_date'
  | 'effective_operation_date'
  | 'sent_to_kitchen_at'
  | 'kitchen_started_at'
  | 'ready_at'
  | 'out_for_delivery_at'
  | 'delivered_at'
  | 'cancelled_at';

export const ORDER_STATUS = ORDER_STATUS_LABELS;

export const OFFICIAL_ORDER_DATES: Array<{
  key: OfficialOrderDateKey;
  label: string;
  meaning: string;
}> = [
  {
    key: 'created_at',
    label: 'Creacion',
    meaning: 'Momento en que la orden fue registrada en el sistema.',
  },
  {
    key: 'delivery_reference_date',
    label: 'Entrega pactada',
    meaning: 'Fecha operativa que ordena agenda, produccion y cobranza snapshot.',
  },
  {
    key: 'effective_operation_date',
    label: 'Operacion efectiva',
    meaning: 'Fecha que debe usarse para cierres, pagos y movimientos cuando aplique.',
  },
  {
    key: 'sent_to_kitchen_at',
    label: 'Enviada a cocina',
    meaning: 'Momento en que master autorizo preparacion.',
  },
  {
    key: 'kitchen_started_at',
    label: 'Tomada por cocina',
    meaning: 'Momento en que preparacion tomo el pedido.',
  },
  {
    key: 'ready_at',
    label: 'Lista',
    meaning: 'Momento en que cocina marco el pedido como listo.',
  },
  {
    key: 'out_for_delivery_at',
    label: 'En camino',
    meaning: 'Momento en que salio a entrega.',
  },
  {
    key: 'delivered_at',
    label: 'Entregada',
    meaning: 'Momento en que se completo entrega o retiro.',
  },
  {
    key: 'cancelled_at',
    label: 'Cancelada',
    meaning: 'Momento en que se anulo la orden.',
  },
];

export const ORDER_ACTIONS_BY_ROLE: Record<AppRole, OrderActionKey[]> = {
  admin: ['approve', 'return_to_advisor', 'send_to_kitchen', 'assign_delivery', 'cancel', 'admin_edit'],
  master: ['approve', 'return_to_advisor', 'send_to_kitchen', 'assign_delivery', 'cancel'],
  advisor: [],
  kitchen: ['take_in_kitchen', 'mark_ready'],
  counter: ['mark_delivered'],
  driver: ['out_for_delivery', 'mark_delivered'],
};

export function getCanonicalOrderStatusLabel(status: string | null | undefined, fulfillment?: FulfillmentType | null) {
  return getOrderStatusLabel(status, fulfillment);
}

export function getCanonicalOperationalStatusLabel(order: {
  status: string | null | undefined;
  fulfillment?: FulfillmentType | null;
}) {
  return getOperationalStatusLabel(order);
}

export function getCanonicalOperationalPhase(status: string | null | undefined) {
  return getOperationalPhase(status);
}

type OrderStatusInput = {
  status: string | null | undefined;
};

type OrderProcessInput = OrderStatusInput & {
  queuedNeedsReapproval?: boolean | null;
};

type FulfillmentOrderInput = OrderStatusInput & {
  fulfillment?: FulfillmentType | null;
};

const CLOSED_ORDER_STATUSES = ['delivered', 'cancelled'] as const;
const ADVISOR_EDITABLE_STATUSES = ['created', 'queued'] as const;
const MASTER_RETURN_TO_ADVISOR_STATUSES = [
  'created',
  'queued',
  'confirmed',
  'in_kitchen',
  'ready',
  'out_for_delivery',
] as const;
const KITCHEN_RETURN_TO_QUEUE_STATUSES = ['confirmed', 'in_kitchen', 'ready'] as const;
const DELIVERY_ASSIGNMENT_STATUSES = ['queued', 'confirmed', 'in_kitchen', 'ready', 'out_for_delivery'] as const;

function statusKey(status: string | null | undefined) {
  return String(status || '').trim();
}

function hasStatus(status: string | null | undefined, statuses: readonly string[]) {
  return statuses.includes(statusKey(status));
}

export function isClosedOrderStatus(status: string | null | undefined) {
  return hasStatus(status, CLOSED_ORDER_STATUSES);
}

export function isOpenOrderStatus(status: string | null | undefined) {
  return !isClosedOrderStatus(status);
}

export function canAdvisorModifyOrder(orderOrStatus: OrderStatusInput | string | null | undefined) {
  const status = typeof orderOrStatus === 'object' && orderOrStatus !== null ? orderOrStatus.status : orderOrStatus;
  return hasStatus(status, ADVISOR_EDITABLE_STATUSES);
}

export function needsInitialOrderApproval(order: OrderStatusInput) {
  return statusKey(order.status) === 'created';
}

export function needsOrderReapproval(order: OrderProcessInput) {
  return statusKey(order.status) === 'queued' && Boolean(order.queuedNeedsReapproval);
}

export function getMasterOrderProcessFlag(order: OrderProcessInput): 'APROBAR' | 'RE-APROBAR' | null {
  if (needsInitialOrderApproval(order)) return 'APROBAR';
  if (needsOrderReapproval(order)) return 'RE-APROBAR';
  return null;
}

export function canSendOrderToKitchen(order: OrderProcessInput) {
  return statusKey(order.status) === 'queued' && order.queuedNeedsReapproval === false;
}

export function canKitchenTakeOrder(order: OrderStatusInput) {
  return statusKey(order.status) === 'confirmed';
}

export function canMarkOrderReady(order: OrderStatusInput) {
  return statusKey(order.status) === 'in_kitchen';
}

export function canStartOrderDelivery(order: FulfillmentOrderInput) {
  return order.fulfillment === 'delivery' && statusKey(order.status) === 'ready';
}

export function canCompleteOrder(order: FulfillmentOrderInput) {
  if (order.fulfillment === 'pickup') return statusKey(order.status) === 'ready';
  return statusKey(order.status) === 'out_for_delivery';
}

export function canReturnOrderToAdvisor(order: OrderStatusInput) {
  return hasStatus(order.status, MASTER_RETURN_TO_ADVISOR_STATUSES);
}

export function canReturnOrderFromKitchenToQueue(order: OrderStatusInput) {
  return hasStatus(order.status, KITCHEN_RETURN_TO_QUEUE_STATUSES);
}

export function canManageOrderDeliveryAssignment(order: FulfillmentOrderInput) {
  return order.fulfillment === 'delivery' && hasStatus(order.status, DELIVERY_ASSIGNMENT_STATUSES);
}

export function isDeliveredDeliveryOrder(order: FulfillmentOrderInput) {
  return order.fulfillment === 'delivery' && statusKey(order.status) === 'delivered';
}

export function canCorrectDeliveredDeliveryAssignment(order: FulfillmentOrderInput, canEditClosedOrders: boolean) {
  return canEditClosedOrders && isDeliveredDeliveryOrder(order);
}

export function isScheduledClosingOrder(order: OrderStatusInput & { totalUsd?: number | null }) {
  return statusKey(order.status) !== 'cancelled' && Number(order.totalUsd || 0) > 0.005;
}

export function isRecognizedBillingOrder(order: OrderStatusInput & { totalUsd?: number | null }) {
  return !hasStatus(order.status, ['created', 'cancelled']) && Number(order.totalUsd || 0) > 0.005;
}
