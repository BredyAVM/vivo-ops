import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  buildAdminExecutiveKpiOverview,
  buildOperationalOverview,
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
import { isRecognizedBillingOrder } from '../orders/order-sales';
import { getOrderMoneySnapshot } from '../orders/order-money';
import { indexKpiFinancialStates } from '../orders/operational-kpis';

const EXECUTIVE_ORDER_LIMIT = 8_000;
const EXECUTIVE_ORDER_BATCH_SIZE = 250;

// Never assume .limit() overrides the API row cap: walk stable, bounded pages.
export async function readExecutivePages<T>(query: (from: number, to: number) => PromiseLike<{
  data: unknown[] | null; error: { message: string } | null;
}>): Promise<T[]> {
  const rows: T[] = [];
  for (let offset = 0; offset <= EXECUTIVE_ORDER_LIMIT; offset += EXECUTIVE_ORDER_BATCH_SIZE) {
    const result = await query(offset, offset + EXECUTIVE_ORDER_BATCH_SIZE - 1);
    if (result.error) throw new Error(result.error.message);
    const page = (result.data ?? []) as T[];
    rows.push(...page);
    if (rows.length > EXECUTIVE_ORDER_LIMIT) throw new Error('La consulta supera el rango seguro de 8.000 registros; no se mostrarán cifras incompletas.');
    if (page.length < EXECUTIVE_ORDER_BATCH_SIZE) return rows;
  }
  throw new Error('No se pudo completar la consulta del tablero.');
}

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
  includeFinancialStates?: boolean;
  historyWeeks?: number;
  growthPct?: number;
}): Promise<AdminExecutiveKpiOverview> {
  const asOf = input.asOf ?? new Date();
  const historyStartKey = executiveHistoryStartKey(asOf);
  const windowEndKey = executiveWindowEndKey(asOf);
  const weekPeriod = buildAdminFinancePeriod('week', asOf);
  const [deliveredEvents, scheduledRows, legacyCreatedRows] = await Promise.all([
    readExecutivePages<DeliveredEventRow>((from, to) => input.supabase
      .from('order_events')
      .select('order_id,created_at')
      .eq('event', 'delivered')
      .gte('created_at', caracasDateKeyToUtcIso(historyStartKey))
      .lt('created_at', caracasDateKeyToUtcIso(windowEndKey))
      .lte('created_at', asOf.toISOString())
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to)),
    readExecutivePages<ExecutiveOrderRow>((from, to) => input.supabase
      .from('orders')
      .select(orderSelect)
      .neq('status', 'cancelled')
      .gte('extra_fields->schedule->>date', historyStartKey)
      .lt('extra_fields->schedule->>date', windowEndKey)
      .lte('created_at', asOf.toISOString())
      .order('id', { ascending: true })
      .range(from, to)),
    readExecutivePages<ExecutiveOrderRow>((from, to) => input.supabase
      .from('orders')
      .select(orderSelect)
      .neq('status', 'cancelled')
      .gte('created_at', caracasDateKeyToUtcIso(historyStartKey))
      .lt('created_at', caracasDateKeyToUtcIso(windowEndKey))
      .lte('created_at', asOf.toISOString())
      .order('id', { ascending: true })
      .range(from, to)),
  ]);

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
      const dateKey = getExecutiveOrderDateKey(order);
      const commercialKey = getExecutiveCommercialDateKey(order);
      return Boolean(
        (isRecognizedBillingOrder({ status: order.status, totalUsd: getOrderMoneySnapshot(order).totalUsd }) && dateKey &&
          dateKey >= weekPeriod.startKey &&
          dateKey < weekPeriod.fullEndExclusiveKey) ||
        (order.status === 'delivered' && commercialKey && commercialKey >= weekPeriod.startKey && commercialKey < weekPeriod.endExclusiveKey)
      );
    })
    .map((order) => Number(order.id))
    .filter((orderId) => Number.isFinite(orderId) && orderId > 0);

  let financialStates: ExecutiveFinancialStateRow[] = [];
  if (currentWeekOrderIds.length > 0 && input.includeFinancialStates !== false) {
    financialStates = await readExecutiveFinancialStates(input.supabase, currentWeekOrderIds);
  }

  const result = buildAdminExecutiveKpiOverview({
    orders,
    financialStates,
    asOf,
    deliveryRowsTruncated: false,
  });
  if (input.historyWeeks !== undefined || input.growthPct !== undefined) {
    result.operational = buildOperationalOverview({ orders, financialStates, asOf, historyWeeks: input.historyWeeks, growthPct: input.growthPct });
  }
  return result;
}

/** Keep every financial batch below the API cap, with at most four concurrent reads. */
export async function readExecutiveFinancialStates(supabase: ExecutiveSupabaseClient, orderIds: number[]) {
  const ids=[...new Set(orderIds)],rows:ExecutiveFinancialStateRow[]=[];
  for(let offset=0;offset<ids.length;offset+=EXECUTIVE_ORDER_BATCH_SIZE*4){
    const batches=Array.from({length:Math.min(4,Math.ceil((ids.length-offset)/EXECUTIVE_ORDER_BATCH_SIZE))},(_,i)=>ids.slice(offset+i*EXECUTIVE_ORDER_BATCH_SIZE,offset+(i+1)*EXECUTIVE_ORDER_BATCH_SIZE));
    const results=await Promise.all(batches.map(async batch=>{
      const {data,error}=await supabase.rpc('get_orders_financial_state',{p_order_ids:batch,p_operation_date:null,p_active_bs_rate:null});
      if(error)throw new Error(error.message||'No se pudieron consultar los saldos.');
      if(!Array.isArray(data))throw new Error('Respuesta de saldos incompleta.');
      indexKpiFinancialStates(data as ExecutiveFinancialStateRow[], batch);
      return data as unknown as ExecutiveFinancialStateRow[];
    }));
    rows.push(...results.flat());
  }
  return rows;
}

export async function loadAdminExecutiveKpiDomain(input: {
  supabase: ExecutiveSupabaseClient;
  asOf?: Date;
  includeFinancialStates?: boolean;
  historyWeeks?: number;
  growthPct?: number;
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
