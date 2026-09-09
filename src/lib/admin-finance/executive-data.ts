import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  buildAdminExecutiveKpiOverview,
  executiveHistoryStartKey,
  executiveWindowEndKey,
  getExecutiveCommercialDateKey,
  getExecutiveOrderDateKey,
  type AdminExecutiveKpiOverview,
  type ExecutiveFinancialStateRow,
  type ExecutiveOrderRow,
} from './executive-model';
import {
  buildAdminFinancePeriod,
  caracasDateKeyToUtcIso,
  getCaracasDateKey,
} from './period';

const EXECUTIVE_ORDER_LIMIT = 2_000;
const EXECUTIVE_ORDER_BATCH_SIZE = 250;

export type AdminExecutiveKpiDomain =
  | { status: 'ready'; data: AdminExecutiveKpiOverview }
  | { status: 'error'; message: string };

type ExecutiveSupabaseClient = Pick<SupabaseClient, 'from' | 'rpc'>;

const orderSelect = 'id,status,fulfillment,total_usd,total_bs_snapshot,created_at,extra_fields';

type DeliveredEventRow = {
  order_id: number | string;
  created_at: string;
};

function hasScheduledDate(order: ExecutiveOrderRow) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(order.extra_fields?.schedule?.date ?? ''));
}

export async function loadAdminExecutiveKpis(input: {
  supabase: ExecutiveSupabaseClient;
  asOf?: Date;
}): Promise<AdminExecutiveKpiOverview> {
  const asOf = input.asOf ?? new Date();
  const historyStartKey = executiveHistoryStartKey(asOf);
  const windowEndKey = executiveWindowEndKey(asOf);
  const weekPeriod = buildAdminFinancePeriod('week', asOf);
  const [deliveredEventResult, scheduledResult, legacyCreatedResult] = await Promise.all([
    input.supabase
      .from('order_events')
      .select('order_id,created_at')
      .eq('event', 'delivered')
      .gte('created_at', caracasDateKeyToUtcIso(historyStartKey))
      .lt('created_at', caracasDateKeyToUtcIso(windowEndKey))
      .lte('created_at', asOf.toISOString())
      .order('created_at', { ascending: true })
      .limit(EXECUTIVE_ORDER_LIMIT + 1),
    input.supabase
      .from('orders')
      .select(orderSelect)
      .eq('fulfillment', 'delivery')
      .neq('status', 'cancelled')
      .gte('extra_fields->schedule->>date', weekPeriod.startKey)
      .lt('extra_fields->schedule->>date', windowEndKey)
      .lte('created_at', asOf.toISOString())
      .order('id', { ascending: true })
      .limit(EXECUTIVE_ORDER_LIMIT + 1),
    input.supabase
      .from('orders')
      .select(orderSelect)
      .eq('fulfillment', 'delivery')
      .neq('status', 'cancelled')
      .gte('created_at', caracasDateKeyToUtcIso(weekPeriod.startKey))
      .lt('created_at', caracasDateKeyToUtcIso(windowEndKey))
      .lte('created_at', asOf.toISOString())
      .order('id', { ascending: true })
      .limit(EXECUTIVE_ORDER_LIMIT + 1),
  ]);

  const orderError =
    deliveredEventResult.error ?? scheduledResult.error ?? legacyCreatedResult.error;
  if (orderError) throw new Error(orderError.message || 'No se pudieron consultar las ordenes del tablero.');

  const deliveredEvents = (deliveredEventResult.data ?? []) as unknown as DeliveredEventRow[];
  if (deliveredEvents.length > EXECUTIVE_ORDER_LIMIT) {
    throw new Error('El volumen de entregas supera el rango seguro del tablero ejecutivo.');
  }
  const scheduledRows = (scheduledResult.data ?? []) as unknown as ExecutiveOrderRow[];
  const legacyCreatedRows = (legacyCreatedResult.data ?? []) as unknown as ExecutiveOrderRow[];
  const deliveryRowsTruncated =
    scheduledRows.length > EXECUTIVE_ORDER_LIMIT ||
    legacyCreatedRows.length > EXECUTIVE_ORDER_LIMIT;
  const latestDeliveredEventByOrderId = new Map<number, DeliveredEventRow>();

  for (const event of deliveredEvents) {
    const orderId = Number(event.order_id);
    if (!Number.isFinite(orderId) || orderId <= 0) continue;
    latestDeliveredEventByOrderId.set(orderId, event);
  }

  const deliveredOrderIds = Array.from(latestDeliveredEventByOrderId.keys());
  const deliveredOrderBatches = Array.from(
    { length: Math.ceil(deliveredOrderIds.length / EXECUTIVE_ORDER_BATCH_SIZE) },
    (_, index) =>
      deliveredOrderIds.slice(
        index * EXECUTIVE_ORDER_BATCH_SIZE,
        (index + 1) * EXECUTIVE_ORDER_BATCH_SIZE
      )
  );
  const deliveredOrderResults = await Promise.all(
    deliveredOrderBatches.map((orderIds) =>
      input.supabase.from('orders').select(orderSelect).in('id', orderIds)
    )
  );
  const deliveredOrderError = deliveredOrderResults.find((result) => result.error)?.error;
  if (deliveredOrderError) {
    throw new Error(deliveredOrderError.message || 'No se pudieron consultar las ventas entregadas.');
  }

  const rowsById = new Map<number, ExecutiveOrderRow>();

  for (const order of scheduledRows.slice(0, EXECUTIVE_ORDER_LIMIT)) {
    rowsById.set(Number(order.id), order);
  }
  for (const order of legacyCreatedRows.slice(0, EXECUTIVE_ORDER_LIMIT)) {
    if (!hasScheduledDate(order)) rowsById.set(Number(order.id), order);
  }
  for (const result of deliveredOrderResults) {
    for (const order of (result.data ?? []) as unknown as ExecutiveOrderRow[]) {
      rowsById.set(Number(order.id), order);
    }
  }
  for (const [orderId, event] of latestDeliveredEventByOrderId) {
    const order = rowsById.get(orderId);
    const deliveredAt = new Date(event.created_at);
    if (!order || Number.isNaN(deliveredAt.getTime())) continue;
    rowsById.set(orderId, {
      ...order,
      commercial_date: getCaracasDateKey(deliveredAt),
      commercial_at: deliveredAt.toISOString(),
    });
  }

  const orders = Array.from(rowsById.values()).filter((order) => {
    const scheduledDateKey = getExecutiveOrderDateKey(order);
    const commercialDateKey = getExecutiveCommercialDateKey(order);
    return Boolean(
      (scheduledDateKey &&
        scheduledDateKey >= historyStartKey &&
        scheduledDateKey < windowEndKey) ||
        (commercialDateKey &&
          commercialDateKey >= historyStartKey &&
          commercialDateKey < windowEndKey)
    );
  });
  const currentWeekOrderIds = orders
    .filter((order) => {
      const dateKey = getExecutiveCommercialDateKey(order);
      return Boolean(
        order.status === 'delivered' &&
          dateKey &&
          dateKey >= weekPeriod.startKey &&
          dateKey < weekPeriod.endExclusiveKey
      );
    })
    .map((order) => Number(order.id))
    .filter((orderId) => Number.isFinite(orderId) && orderId > 0);

  let financialStates: ExecutiveFinancialStateRow[] = [];
  if (currentWeekOrderIds.length > 0) {
    const financialStateResult = await input.supabase.rpc('get_orders_financial_state', {
      p_order_ids: currentWeekOrderIds,
      p_operation_date: null,
      p_active_bs_rate: null,
    });
    if (financialStateResult.error) {
      throw new Error(
        financialStateResult.error.message || 'No se pudo consultar la cobranza de las ordenes.'
      );
    }
    financialStates = (financialStateResult.data ?? []) as unknown as ExecutiveFinancialStateRow[];
  }

  return buildAdminExecutiveKpiOverview({
    orders,
    financialStates,
    asOf,
    deliveryRowsTruncated,
  });
}

export async function loadAdminExecutiveKpiDomain(input: {
  supabase: ExecutiveSupabaseClient;
  asOf?: Date;
}): Promise<AdminExecutiveKpiDomain> {
  try {
    return { status: 'ready', data: await loadAdminExecutiveKpis(input) };
  } catch (error) {
    console.warn(
      'admin executive KPI overview skipped',
      error instanceof Error ? error.message : error
    );
    return {
      status: 'error',
      message: 'No pudimos cargar los indicadores principales. Los centros operativos siguen disponibles.',
    };
  }
}
