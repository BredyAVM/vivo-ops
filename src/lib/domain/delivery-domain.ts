import type { AppRole } from './role-domain';

export type DeliveryMode = 'pickup' | 'internal' | 'external';

export type DeliveryActionKey =
  | 'assign_internal'
  | 'assign_external'
  | 'clear_assignment'
  | 'mark_out_for_delivery'
  | 'mark_delivered'
  | 'correct_assignment';

export type OfficialDeliveryDateKey =
  | 'delivery_reference_date'
  | 'assigned_at'
  | 'out_for_delivery_at'
  | 'delivered_at';

export const DELIVERY_MODE_LABELS: Record<DeliveryMode, string> = {
  pickup: 'Retiro',
  internal: 'Delivery interno',
  external: 'Delivery externo',
};

export const OFFICIAL_DELIVERY_DATES: Array<{
  key: OfficialDeliveryDateKey;
  label: string;
  meaning: string;
}> = [
  {
    key: 'delivery_reference_date',
    label: 'Entrega pactada',
    meaning: 'Fecha y hora prometida al cliente.',
  },
  {
    key: 'assigned_at',
    label: 'Asignacion',
    meaning: 'Momento en que se asigno interno o externo.',
  },
  {
    key: 'out_for_delivery_at',
    label: 'Salida',
    meaning: 'Momento en que el pedido salio a ruta.',
  },
  {
    key: 'delivered_at',
    label: 'Entrega real',
    meaning: 'Momento en que cliente recibio o retiro el pedido.',
  },
];

export const DELIVERY_ACTIONS_BY_ROLE: Record<AppRole, DeliveryActionKey[]> = {
  admin: ['assign_internal', 'assign_external', 'clear_assignment', 'correct_assignment'],
  master: ['assign_internal', 'assign_external', 'clear_assignment'],
  advisor: [],
  kitchen: [],
  counter: ['mark_delivered'],
  driver: ['mark_out_for_delivery', 'mark_delivered'],
};
