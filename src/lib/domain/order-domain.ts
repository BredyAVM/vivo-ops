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
