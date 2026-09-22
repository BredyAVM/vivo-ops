import type { AuthContext } from '@/lib/auth';
import { loadEligibleCommissionAdvisors } from './advisor-eligibility.ts';
import {
  buildAdvisorGoalPaymentCompletionDates,
  calculateAdvisorGoalCollectionSummary,
  type AdvisorGoalCollectionSnapshotOrder,
  type AdvisorGoalPaymentRegistrationEntry,
} from './goal-collection.ts';
import {
  buildAdvisorGoalSimulation,
  type AdvisorGoalCommercialMetricRow,
  type AdvisorGoalSimulation,
  type AdvisorGoalSimulationContext,
} from './goal-simulation.ts';

type SupabaseServerClient = AuthContext['supabase'];

type CommercialMetricDbRow = {
  period_key: string;
  period_from: string;
  period_to: string;
  period_year: number | string;
  period_month: number | string;
  period_half: number | string;
  advisor_user_id: string;
  advisor_name: string;
  billing_usd: number | string;
  closures_count: number | string;
  new_own_clients_count: number | string;
  new_assigned_clients_count: number | string;
};

type CurrentCommercialMetricDbRow = {
  period_from: string;
  period_to: string;
  advisor_user_id: string;
  billing_usd: number | string;
  closures_count: number | string;
  new_own_clients_count: number | string;
  new_assigned_clients_count: number | string;
  observed_at: string;
};

type CurrentCommercialFactDbRow = {
  source_record_id: number | string;
  source_control: string | null;
  client_id: number | string;
  purchased_at: string;
  net_total_usd: number | string;
};

type ClientDbRow = {
  id: number | string;
  full_name: string | null;
};

type ClosureDbRow = {
  id: number | string;
  advisor_user_id: string;
  snapshot: unknown;
};

type MovementDbRow = {
  id: number | string;
  order_id: number | string;
  created_at: string;
  direction: string;
  movement_type: string;
  amount_usd_equivalent: number | string;
  amount: number | string;
  currency_code: string;
  movement_group_id: string | null;
  payment_report_id: number | string | null;
};

type PaymentReportDbRow = {
  id: number | string;
  confirmed_movement_id: number | string | null;
  created_at: string;
  operation_date: string | null;
};

type FinancialStateDbRow = {
  order_id: number | string;
  order_number: string | null;
  total_usd: number | string | null;
  total_bs: number | string | null;
  snapshot_rate_bs_per_usd: number | string | null;
  confirmed_paid_bs_snapshot: number | string | null;
  confirmed_paid_usd: number | string | null;
  pending_usd: number | string | null;
  delivery_reference_date: string | null;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function numberValue(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function caracasDate(value: string | Date) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Caracas',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const fields = new Map(parts.map((part) => [part.type, part.value]));
  return `${fields.get('year')}-${fields.get('month')}-${fields.get('day')}`;
}

function datePlusDays(value: string, days: number) {
  const parsed = Date.parse(`${value}T12:00:00Z`);
  if (!Number.isFinite(parsed)) throw new Error(`La fecha ${value} no es válida.`);
  return new Date(parsed + days * 86_400_000).toISOString().slice(0, 10);
}

function snapshotOrders(snapshot: unknown) {
  const orders = record(snapshot).orders;
  if (!Array.isArray(orders)) return [];
  return orders.flatMap<AdvisorGoalCollectionSnapshotOrder>((value) => {
    const order = record(value);
    const orderId = numberValue(order.orderId);
    const deliveryDate = String(order.deliveryDate ?? '');
    const totalUsd = numberValue(order.totalUsd);
    if (!Number.isInteger(orderId) || orderId <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(deliveryDate)) {
      return [];
    }
    if (totalUsd <= 0.005) return [];
    return [{
      orderId,
      orderNumber: order.orderNumber == null ? null : String(order.orderNumber),
      clientName: String(order.clientName || 'Cliente').trim() || 'Cliente',
      deliveryDate,
      totalUsd,
      confirmedPaidUsd: numberValue(order.confirmedPaidUsd),
      pendingUsd: numberValue(order.pendingUsd),
    }];
  });
}

function metricRow(row: CommercialMetricDbRow): AdvisorGoalCommercialMetricRow {
  return {
    periodKey: row.period_key,
    periodFrom: row.period_from,
    periodTo: row.period_to,
    periodYear: numberValue(row.period_year),
    periodMonth: numberValue(row.period_month),
    periodHalf: numberValue(row.period_half),
    advisorUserId: row.advisor_user_id,
    advisorName: row.advisor_name,
    billingUsd: numberValue(row.billing_usd),
    closuresCount: numberValue(row.closures_count),
    newOwnClientsCount: numberValue(row.new_own_clients_count),
    newAssignedClientsCount: numberValue(row.new_assigned_clients_count),
  };
}

export type AdvisorGoalCurrentCommercialMetric = {
  periodFrom: string;
  periodTo: string;
  advisorUserId: string;
  billingUsd: number;
  closuresCount: number;
  newOwnClientsCount: number;
  newAssignedClientsCount: number;
  observedAt: string;
};

export async function loadAdvisorGoalCurrentCommercialMetric(params: {
  supabase: SupabaseServerClient;
  periodFrom: string;
  periodTo: string;
}): Promise<AdvisorGoalCurrentCommercialMetric | null> {
  const result = await params.supabase.rpc('advisor_goal_current_commercial_metric_v1', {
    p_from: params.periodFrom,
    p_to: params.periodTo,
  });
  if (result.error) throw new Error(result.error.message);
  const row = ((result.data ?? []) as CurrentCommercialMetricDbRow[])[0];
  if (!row) return null;
  return {
    periodFrom: row.period_from,
    periodTo: row.period_to,
    advisorUserId: row.advisor_user_id,
    billingUsd: numberValue(row.billing_usd),
    closuresCount: numberValue(row.closures_count),
    newOwnClientsCount: numberValue(row.new_own_clients_count),
    newAssignedClientsCount: numberValue(row.new_assigned_clients_count),
    observedAt: row.observed_at,
  };
}

async function loadCollectionByAdvisorId(params: {
  supabase: SupabaseServerClient;
  closures: ClosureDbRow[];
  cutoffDate: string;
}) {
  const ordersByAdvisorId = new Map<string, AdvisorGoalCollectionSnapshotOrder[]>();
  const orderIds: number[] = [];
  for (const closure of params.closures) {
    const orders = snapshotOrders(closure.snapshot);
    ordersByAdvisorId.set(closure.advisor_user_id, orders);
    orderIds.push(...orders.map((order) => order.orderId));
  }
  const uniqueOrderIds = Array.from(new Set(orderIds));
  const entries: AdvisorGoalPaymentRegistrationEntry[] = [];
  const financialStateByOrderId = new Map<number, FinancialStateDbRow>();

  for (let index = 0; index < uniqueOrderIds.length; index += 250) {
    const chunk = uniqueOrderIds.slice(index, index + 250);
    const [movementsResult, reportsResult, fundResult, refundReceiptsResult, financialStatesResult, allocationsResult] = await Promise.all([
      params.supabase
        .from('money_movements')
        .select('id, order_id, created_at, direction, movement_type, amount_usd_equivalent, amount, currency_code, movement_group_id, payment_report_id')
        .in('order_id', chunk)
        .eq('status', 'confirmed'),
      params.supabase
        .from('payment_reports')
        .select('id, confirmed_movement_id, created_at, operation_date')
        .in('order_id', chunk)
        .eq('status', 'confirmed')
        .not('confirmed_movement_id', 'is', null),
      params.supabase
        .from('client_fund_movements')
        .select('order_id, movement_type, reason_code, amount_usd, created_at')
        .in('order_id', chunk),
      params.supabase
        .from('counter_command_receipts')
        .select('order_id, idempotency_key')
        .in('order_id', chunk)
        .eq('command_type', 'request_refund'),
      params.supabase.rpc('get_orders_financial_state', {
        p_order_ids: chunk,
        p_operation_date: null,
        p_active_bs_rate: null,
      }),
      params.supabase.from('order_payment_precision_allocations')
        .select('movement_id, applied_usd')
        .in('order_id', chunk),
    ]);
    if (movementsResult.error) throw new Error(movementsResult.error.message);
    if (reportsResult.error) throw new Error(reportsResult.error.message);
    if (fundResult.error) throw new Error(fundResult.error.message);
    if (refundReceiptsResult.error) throw new Error(refundReceiptsResult.error.message);
    if (financialStatesResult.error) throw new Error(financialStatesResult.error.message);
    if (allocationsResult.error) throw new Error(allocationsResult.error.message);

    for (const state of (financialStatesResult.data ?? []) as FinancialStateDbRow[]) {
      const orderId = Number(state.order_id);
      if (Number.isInteger(orderId) && orderId > 0) financialStateByOrderId.set(orderId, state);
    }

    const reports = (reportsResult.data ?? []) as PaymentReportDbRow[];
    const reportByMovementId = new Map(reports.map((report) => [Number(report.confirmed_movement_id), report]));
    const appliedUsdByMovementId = new Map(
      (allocationsResult.data ?? []).map((allocation) => [Number(allocation.movement_id), numberValue(allocation.applied_usd)])
    );
    const reportDateById = new Map(
      reports.map((report) => [Number(report.id), caracasDate(report.created_at)])
    );
    const reportDateByMovementId = new Map(
      reports
        .filter((report) => report.confirmed_movement_id != null)
        .map((report) => [Number(report.confirmed_movement_id), caracasDate(report.created_at)])
    );
    const refundReceiptKeys = new Set(
      (refundReceiptsResult.data ?? []).map((receipt) =>
        `${receipt.order_id}:${receipt.idempotency_key || ''}`
      )
    );

    for (const movement of (movementsResult.data ?? []) as MovementDbRow[]) {
      const orderId = Number(movement.order_id);
      const isInflow = movement.direction === 'inflow';
      const amountUsd = Math.max(0, isInflow
        ? appliedUsdByMovementId.get(Number(movement.id)) ?? numberValue(movement.amount_usd_equivalent)
        : numberValue(movement.amount_usd_equivalent));
      const isReduction = movement.direction === 'outflow' && (
        movement.movement_type === 'change_given'
        || (
          movement.movement_type === 'withdrawal'
          && refundReceiptKeys.has(`${movement.order_id}:${movement.movement_group_id || ''}`)
        )
      );
      if (!isInflow && !isReduction) continue;
      const registeredDate = (
        movement.payment_report_id == null
          ? null
          : reportDateById.get(Number(movement.payment_report_id))
      ) ?? reportDateByMovementId.get(Number(movement.id)) ?? caracasDate(movement.created_at);
      if (!registeredDate || amountUsd <= 0.005) continue;
      const state = financialStateByOrderId.get(orderId);
      const report = reportByMovementId.get(Number(movement.id));
      const snapshotRate = numberValue(state?.snapshot_rate_bs_per_usd);
      const operationDate = report?.operation_date || (report ? caracasDate(report.created_at) : '');
      const eligibleReport = isInflow && report && operationDate
        && (!state?.delivery_reference_date || operationDate <= state.delivery_reference_date);
      // Native coverage uses the validated movement, never an uncorrected
      // reported amount. Registration time still belongs to the linked report.
      const nativeBs = movement.currency_code === 'VES' ? numberValue(movement.amount)
        : numberValue(movement.amount_usd_equivalent) * snapshotRate;
      const eligibleSnapshotBs = eligibleReport
        ? nativeBs : isReduction ? -nativeBs : 0;
      entries.push({ orderId, registeredDate, amountUsd: isInflow ? amountUsd : -amountUsd, eligibleSnapshotBs });
    }

    for (const movement of fundResult.data ?? []) {
      const orderId = Number(movement.order_id);
      const amountUsd = Math.max(0, numberValue(movement.amount_usd));
      const applied = movement.movement_type === 'debit' && (
        movement.reason_code === 'order_fund_applied'
        || movement.reason_code === 'counter_change_fund_reversal'
      );
      const restored = movement.movement_type === 'credit' && movement.reason_code === 'order_fund_restore';
      const registeredDate = caracasDate(movement.created_at);
      if ((!applied && !restored) || !registeredDate || amountUsd <= 0.005) continue;
      entries.push({ orderId, registeredDate, amountUsd: applied ? amountUsd : -amountUsd });
    }
  }

  const currentOrdersByAdvisorId = new Map(Array.from(ordersByAdvisorId, ([advisorId, orders]) => [
    advisorId,
    orders.map((order) => {
      const state = financialStateByOrderId.get(order.orderId);
      return state ? {
        ...order,
        orderNumber: state.order_number ?? order.orderNumber,
        deliveryDate: state.delivery_reference_date || order.deliveryDate,
        totalUsd: numberValue(state.total_usd) || order.totalUsd,
        confirmedPaidUsd: numberValue(state.confirmed_paid_usd),
        pendingUsd: numberValue(state.pending_usd),
      } : order;
    }),
  ]));
  const currentOrders = Array.from(currentOrdersByAdvisorId.values()).flat();
  const completed = buildAdvisorGoalPaymentCompletionDates({ orders: currentOrders, entries });
  const ordersWithEntries = new Set(entries.filter((entry) => entry.amountUsd > 0).map((entry) => entry.orderId));
  const unresolved = currentOrders.filter((order) => order.pendingUsd <= 0.005
    && order.confirmedPaidUsd > 0 && !completed.has(order.orderId) && ordersWithEntries.has(order.orderId));
  // Fetch the existing canonical precision basis only for settled orders whose
  // dated ledger does not cover the displayed (rounded) invoice. Never invent a
  // payment date or increase a generic money tolerance to hide missing evidence.
  for (let index = 0; index < unresolved.length; index += 10) {
    await Promise.all(unresolved.slice(index, index + 10).map(async (order) => {
      const result = await params.supabase.rpc('order_collection_precision_basis_v1', { p_order_id: order.orderId });
      if (result.error) throw new Error(result.error.message);
      const basis = result.data?.[0];
      if (basis?.total_precise_usd != null && numberValue(basis.total_precise_usd) > 0) {
        order.paymentTargetUsd = numberValue(basis.total_precise_usd);
      } else {
        const state = financialStateByOrderId.get(order.orderId);
        // Legacy invoices can be fully covered by their native VES quote even
        // when the cash equivalent is a cent below their displayed USD total.
        if (state && numberValue(state.total_bs) > 0
          && numberValue(state.confirmed_paid_usd) >= order.totalUsd
          && numberValue(state.confirmed_paid_bs_snapshot) + 0.01 >= numberValue(state.total_bs)) {
          order.paymentTargetBs = numberValue(state.total_bs);
        }
      }
    }));
  }

  const asOfDate = [caracasDate(new Date()), params.cutoffDate].sort()[0];
  return new Map(
    Array.from(currentOrdersByAdvisorId.entries()).map(([advisorUserId, orders]) => [
      advisorUserId,
      calculateAdvisorGoalCollectionSummary({
        orders,
        entries,
        asOfDate,
      }),
    ])
  );
}

export async function loadAdvisorGoalCollectionForClosure(params: {
  supabase: SupabaseServerClient;
  advisorUserId: string;
  snapshot: unknown;
  periodTo: string;
}) {
  const summaries = await loadCollectionByAdvisorId({
    supabase: params.supabase,
    closures: [{ id: 0, advisor_user_id: params.advisorUserId, snapshot: params.snapshot }],
    cutoffDate: datePlusDays(params.periodTo, 5),
  });
  return summaries.get(params.advisorUserId) ?? null;
}

export async function loadAdvisorGoalCurrentCollection(params: {
  supabase: SupabaseServerClient;
  advisorUserId: string;
  periodFrom: string;
  periodTo: string;
}) {
  const factsResult = await params.supabase
    .from('commercial_order_facts')
    .select('source_record_id, source_control, client_id, purchased_at, net_total_usd')
    .eq('fact_origin', 'live')
    .eq('event_kind', 'purchase')
    .eq('attributed_advisor_id', params.advisorUserId)
    .gte('purchased_at', `${params.periodFrom}T00:00:00-04:00`)
    .lte('purchased_at', `${params.periodTo}T23:59:59.999-04:00`)
    .gt('net_total_usd', 0)
    .order('purchased_at', { ascending: true });
  if (factsResult.error) throw new Error(factsResult.error.message);
  const facts = (factsResult.data ?? []) as CurrentCommercialFactDbRow[];
  const clientIds = Array.from(new Set(
    facts.map((fact) => Number(fact.client_id)).filter((clientId) => Number.isInteger(clientId) && clientId > 0)
  ));
  const clientNameById = new Map<number, string>();
  for (let index = 0; index < clientIds.length; index += 250) {
    const clientsResult = await params.supabase
      .from('clients')
      .select('id, full_name')
      .in('id', clientIds.slice(index, index + 250));
    if (clientsResult.error) throw new Error(clientsResult.error.message);
    for (const client of (clientsResult.data ?? []) as ClientDbRow[]) {
      const clientId = Number(client.id);
      if (Number.isInteger(clientId) && clientId > 0) {
        clientNameById.set(clientId, String(client.full_name || 'Cliente').trim() || 'Cliente');
      }
    }
  }
  const orders = facts.flatMap<AdvisorGoalCollectionSnapshotOrder>((fact) => {
    const orderId = Number(fact.source_record_id);
    const clientId = Number(fact.client_id);
    const deliveryDate = caracasDate(fact.purchased_at);
    const totalUsd = numberValue(fact.net_total_usd);
    if (!Number.isInteger(orderId) || orderId <= 0 || !deliveryDate || totalUsd <= 0.005) return [];
    return [{
      orderId,
      orderNumber: fact.source_control,
      clientName: clientNameById.get(clientId) ?? 'Cliente',
      deliveryDate,
      totalUsd,
      confirmedPaidUsd: 0,
      pendingUsd: totalUsd,
    }];
  });
  const summaries = await loadCollectionByAdvisorId({
    supabase: params.supabase,
    closures: [{ id: 0, advisor_user_id: params.advisorUserId, snapshot: { orders } }],
    cutoffDate: datePlusDays(params.periodTo, 5),
  });
  return summaries.get(params.advisorUserId) ?? null;
}

export async function loadAdvisorGoalSimulation(params: {
  supabase: SupabaseServerClient;
  periodId: number;
  periodFrom: string;
  periodTo: string;
  context?: Partial<AdvisorGoalSimulationContext>;
}): Promise<AdvisorGoalSimulation> {
  const [metricsResult, closuresResult, advisors] = await Promise.all([
    params.supabase.rpc('advisor_goal_commercial_metrics_v1', {
      p_from: '2023-01-01',
      p_to: params.periodTo,
    }),
    params.supabase
      .from('advisor_commission_closures')
      .select('id, advisor_user_id, snapshot')
      .eq('period_id', params.periodId),
    loadEligibleCommissionAdvisors(params.supabase),
  ]);
  if (metricsResult.error) throw new Error(metricsResult.error.message);
  if (closuresResult.error) throw new Error(closuresResult.error.message);

  const metrics = ((metricsResult.data ?? []) as CommercialMetricDbRow[]).map(metricRow);
  const cutoffDate = datePlusDays(params.periodTo, 5);
  const collectionByAdvisorId = await loadCollectionByAdvisorId({
    supabase: params.supabase,
    closures: (closuresResult.data ?? []) as ClosureDbRow[],
    cutoffDate,
  });
  return buildAdvisorGoalSimulation({
    periodFrom: params.periodFrom,
    periodTo: params.periodTo,
    metrics,
    projectionAdvisors: advisors.map((advisor) => ({
      advisorUserId: advisor.userId,
      advisorName: advisor.fullName,
    })),
    collectionByAdvisorId,
    context: params.context,
    mode: params.periodFrom > caracasDate(new Date()) ? 'projection' : 'active',
  });
}
