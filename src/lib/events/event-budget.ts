export type EventPreparationMode = 'kitchen' | 'on_site' | 'not_applicable';
export type EventCommissionMode = 'default' | 'fixed_item' | 'fixed_order' | 'none';
export type EventBudgetCurrency = 'USD' | 'VES';
export type EventBudgetFulfillment = 'pickup' | 'delivery';

export type EventBudgetComponent = {
  productId: number;
  productName: string;
  qty: number;
  preparationMode: EventPreparationMode;
};

export type EventBudgetData = {
  schemaVersion: 1;
  title: string;
  eventDate: string;
  eventTime: string;
  fulfillment: EventBudgetFulfillment;
  deliveryAddress: string;
  notes: string;
  negotiatedCurrency: EventBudgetCurrency;
  negotiatedAmount: number;
  totalUsd: number;
  commissionMode: EventCommissionMode;
  commissionValue: number | null;
  components: EventBudgetComponent[];
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown) {
  return String(value ?? '').trim();
}

function number(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function preparationMode(value: unknown): EventPreparationMode {
  if (value === 'on_site' || value === 'not_applicable') return value;
  return 'kitchen';
}

function commissionMode(value: unknown): EventCommissionMode {
  if (value === 'fixed_item' || value === 'fixed_order' || value === 'none') return value;
  return 'default';
}

export function readEventBudgetPayload(payload: unknown): EventBudgetData | null {
  const event = record(record(payload).event_budget);
  if (event.kind !== 'admin_event_budget') return null;

  const components = (Array.isArray(event.components) ? event.components : [])
    .map((value): EventBudgetComponent | null => {
      const component = record(value);
      const productId = Math.trunc(number(component.product_id ?? component.productId));
      const qty = number(component.qty);
      if (productId <= 0 || qty <= 0) return null;
      return {
        productId,
        productName: text(component.product_name ?? component.productName) || `Producto #${productId}`,
        qty,
        preparationMode: preparationMode(component.preparation_mode ?? component.preparationMode),
      };
    })
    .filter((value): value is EventBudgetComponent => Boolean(value));

  const negotiatedCurrency: EventBudgetCurrency = event.negotiated_currency === 'VES' ? 'VES' : 'USD';
  const fulfillment: EventBudgetFulfillment = event.fulfillment === 'delivery' ? 'delivery' : 'pickup';
  const mode = commissionMode(event.commission_mode);
  const rawCommissionValue = event.commission_value == null ? null : number(event.commission_value);

  return {
    schemaVersion: 1,
    title: text(event.title) || 'Evento sin título',
    eventDate: text(event.event_date),
    eventTime: text(event.event_time) || '12:00',
    fulfillment,
    deliveryAddress: text(event.delivery_address),
    notes: text(event.notes),
    negotiatedCurrency,
    negotiatedAmount: Math.max(0, number(event.negotiated_amount)),
    totalUsd: Math.max(0, number(event.total_usd)),
    commissionMode: mode,
    commissionValue: mode === 'fixed_item' || mode === 'fixed_order'
      ? Math.max(0, rawCommissionValue ?? 0)
      : null,
    components,
  };
}

export function eventPreparationLabel(mode: EventPreparationMode) {
  if (mode === 'on_site') return 'Freír en el sitio';
  if (mode === 'not_applicable') return 'No requiere preparación';
  return 'Preparar en cocina';
}

export function eventCommissionLabel(mode: EventCommissionMode, value: number | null) {
  if (mode === 'none') return 'Sin comisión';
  if (mode === 'fixed_item' || mode === 'fixed_order') return `${Number(value || 0).toFixed(2)}% específico`;
  return 'Comisión general del asesor';
}
