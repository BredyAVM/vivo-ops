import Link from 'next/link';
import { getAuthContext } from '@/lib/auth';
import {
  OPERATIONAL_PHASES,
  type OperationalPhase,
  getOperationalPhase,
  getOperationalPhaseIndex,
  getOperationalStatusLabel,
  formatOrderDisplayNumber,
} from '@/lib/orders/order-labels';
import { getOrderMoneySnapshot } from '@/lib/orders/order-money';
import { isOpenOrderStatus, needsOrderReapproval } from '@/lib/domain/order-domain';
import { getPhoneSearchTerms } from '@/lib/phone/normalize-phone';
import { normalizeRemoteSearchValue, normalizeSearchValue } from '@/lib/search/normalize-search';
import AdvisorCalendarStrip from './AdvisorCalendarStrip';
import AdvisorSearchForm from './AdvisorSearchForm';
import { EmptyBlock, SectionCard, StatusBadge } from './advisor-ui';

type SearchParams = Promise<{
  day?: string;
  q?: string;
}>;

type OrderRow = {
  id: number;
  client_id?: number | string | null;
  order_number: string;
  status: string;
  queued_needs_reapproval?: boolean | null;
  fulfillment: 'pickup' | 'delivery';
  total_usd: number | string;
  created_at: string;
  delivery_address: string | null;
  extra_fields: {
    schedule?: {
      date?: string | null;
      time_12?: string | null;
      time_24?: string | null;
      asap?: boolean | null;
    } | null;
    payment?: {
      client_fund_used_usd?: number | string | null;
    } | null;
    pricing?: {
      fx_rate?: number | string | null;
      total_usd?: number | string | null;
      total_bs?: number | string | null;
    } | null;
  } | null;
  client:
    | { full_name: string | null; phone: string | null }[]
    | { full_name: string | null; phone: string | null }
    | null;
};

type PaymentRow = {
  order_id: number;
  status: 'pending' | 'confirmed' | 'rejected';
  reported_amount: number | string | null;
  reported_currency_code: string | null;
  reported_amount_usd_equivalent: number | string;
};

type PaymentState = {
  confirmedUsd: number;
  confirmedBs: number;
  pendingUsd: number;
  pendingBs: number;
  balanceUsd: number;
  balanceBs: number;
  reportableBalanceUsd: number;
  reportableBalanceBs: number;
  totalBs: number;
  hasRejected: boolean;
};

type RawOrderFinancialStateRow = {
  order_id: number | string;
  total_usd: number | string | null;
  total_bs: number | string | null;
  confirmed_paid_usd: number | string | null;
  confirmed_paid_bs_snapshot: number | string | null;
  pending_reports_usd: number | string | null;
  pending_reports_bs_snapshot: number | string | null;
  rejected_reports_count: number | string | null;
  pending_usd: number | string | null;
  pending_bs: number | string | null;
};

type TimelineEventRow = {
  order_id: number | string | null;
  event_type: string | null;
  created_at: string | null;
};

const REVIEW_EVENT_TYPES = [
  'order_returned_to_review',
  'order_changes_rejected',
  'order_changes_approved',
  'order_reapproved',
  'order_approved',
] as const;

function formatUsd(value: number | string) {
  const amount = Number(value);
  return Number.isFinite(amount) ? `$${amount.toFixed(2)}` : '$0.00';
}

function formatBs(value: number | string) {
  const amount = Number(value);
  return Number.isFinite(amount) ? `Bs ${amount.toFixed(2)}` : 'Bs 0.00';
}

function toSafeNumber(value: unknown, fallback = 0) {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : fallback;
}

function getCaracasDayRange(dayKey: string) {
  const start = new Date(`${dayKey}T00:00:00-04:00`);
  const end = new Date(start);
  end.setDate(start.getDate() + 1);
  return {
    startISO: start.toISOString(),
    endISO: end.toISOString(),
  };
}

function formatDateLabel(value: Date) {
  return value.toLocaleDateString('es-VE', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'America/Caracas',
  });
}

function getDateKey(date: Date) {
  return date.toLocaleDateString('en-CA', {
    timeZone: 'America/Caracas',
  });
}

function getIsoDayKey(value: string) {
  return new Date(value).toLocaleDateString('en-CA', {
    timeZone: 'America/Caracas',
  });
}

function isDayKey(value: string | null | undefined) {
  return Boolean(value && /^\d{4}-\d{2}-\d{2}$/.test(value));
}

function getAgendaDayKey(order: Pick<OrderRow, 'created_at' | 'extra_fields'>) {
  const scheduledDay = order.extra_fields?.schedule?.date;
  return isDayKey(scheduledDay) ? String(scheduledDay) : getIsoDayKey(order.created_at);
}

function getAgendaTime24(order: Pick<OrderRow, 'extra_fields'>) {
  return String(order.extra_fields?.schedule?.time_24 || '').trim();
}

function getOrderTotalUsd(order: OrderRow) {
  return getOrderMoneySnapshot(order).totalUsd;
}

function getOrderFxRate(order: OrderRow) {
  return getOrderMoneySnapshot(order).fxRate;
}

function getOrderTotalBs(order: OrderRow) {
  return getOrderMoneySnapshot(order).totalBs;
}

function usdToOrderBs(order: OrderRow, amountUsd: number) {
  const fxRate = getOrderFxRate(order);
  return fxRate > 0 ? amountUsd * fxRate : 0;
}

function getPaymentAmountBs(report: PaymentRow, order: OrderRow) {
  const currency = String(report.reported_currency_code || '').toUpperCase();
  if (currency === 'VES') return toSafeNumber(report.reported_amount, 0);
  return usdToOrderBs(order, toSafeNumber(report.reported_amount_usd_equivalent, 0));
}

function getAgendaSortKey(order: Pick<OrderRow, 'created_at' | 'extra_fields'>) {
  const dayKey = getAgendaDayKey(order);
  const timeKey = order.extra_fields?.schedule?.asap ? '00:00' : getAgendaTime24(order) || '99:99';

  return `${dayKey}|${timeKey}|${order.created_at}`;
}

function getAgendaTimeLabel(order: Pick<OrderRow, 'created_at' | 'extra_fields'>) {
  const schedule = order.extra_fields?.schedule;
  if (schedule?.asap) return 'Lo antes posible';

  const time12 = String(schedule?.time_12 || '').trim();
  return time12 || new Date(order.created_at).toLocaleString('es-VE', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: 'America/Caracas',
  });
}

function statusTone(status: string): 'neutral' | 'warning' | 'success' | 'danger' {
  if (status === 'created' || status === 'queued' || status === 'ready') return 'warning';
  if (status === 'delivered') return 'success';
  if (status === 'cancelled') return 'danger';
  return 'neutral';
}

function isOpenStatus(status: string) {
  return isOpenOrderStatus(status);
}

function isOverdueOrder(order: OrderRow, selectedDayKey: string) {
  if (!isOpenStatus(order.status)) return false;
  if (selectedDayKey !== getDateKey(new Date())) return false;
  if (order.extra_fields?.schedule?.asap) return false;

  const time24 = getAgendaTime24(order);
  if (!time24) return false;

  const currentKey = new Date().toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'America/Caracas',
  });
  return time24 < currentKey;
}

function getPaymentState(order: OrderRow, paymentReportsByOrderId: Map<number, PaymentRow[]>): PaymentState {
  const reports = paymentReportsByOrderId.get(order.id) ?? [];
  const totalUsd = getOrderTotalUsd(order);
  const totalBs = getOrderTotalBs(order);
  const clientFundUsd = toSafeNumber(order.extra_fields?.payment?.client_fund_used_usd, 0);
  let confirmedUsd = clientFundUsd;
  let confirmedBs = usdToOrderBs(order, clientFundUsd);
  let pendingUsd = 0;
  let pendingBs = 0;
  let hasRejected = false;

  for (const report of reports) {
    if (report.status === 'confirmed') {
      confirmedUsd += toSafeNumber(report.reported_amount_usd_equivalent, 0);
      confirmedBs += getPaymentAmountBs(report, order);
    } else if (report.status === 'pending') {
      pendingUsd += toSafeNumber(report.reported_amount_usd_equivalent, 0);
      pendingBs += getPaymentAmountBs(report, order);
    } else if (report.status === 'rejected') {
      hasRejected = true;
    }
  }

  const balanceUsd = Math.max(0, Number((totalUsd - confirmedUsd).toFixed(2)));
  const reportableBalanceUsd = Math.max(0, Number((totalUsd - confirmedUsd - pendingUsd).toFixed(2)));
  const balanceBs =
    totalBs > 0 ? Math.max(0, Number((totalBs - confirmedBs).toFixed(2))) : usdToOrderBs(order, balanceUsd);
  const reportableBalanceBs = Math.max(0, Number((balanceBs - pendingBs).toFixed(2)));

  return {
    confirmedUsd,
    confirmedBs,
    pendingUsd,
    pendingBs,
    balanceUsd,
    balanceBs,
    reportableBalanceUsd,
    reportableBalanceBs,
    totalBs,
    hasRejected,
  };
}

function getCanonicalPaymentState(state: RawOrderFinancialStateRow): PaymentState {
  const pendingUsd = toSafeNumber(state.pending_reports_usd, 0);
  const pendingBs = toSafeNumber(state.pending_reports_bs_snapshot, 0);
  const balanceUsd = toSafeNumber(state.pending_usd, 0);
  const balanceBs = toSafeNumber(state.pending_bs, 0);

  return {
    confirmedUsd: toSafeNumber(state.confirmed_paid_usd, 0),
    confirmedBs: toSafeNumber(state.confirmed_paid_bs_snapshot, 0),
    pendingUsd,
    pendingBs,
    balanceUsd,
    balanceBs,
    reportableBalanceUsd: Math.max(0, Number((balanceUsd - pendingUsd).toFixed(2))),
    reportableBalanceBs: Math.max(0, Number((balanceBs - pendingBs).toFixed(2))),
    totalBs: toSafeNumber(state.total_bs, 0),
    hasRejected: toSafeNumber(state.rejected_reports_count, 0) > 0,
  };
}

function getStoredPaymentState(order: OrderRow, paymentStateByOrderId: Map<number, PaymentState>) {
  return paymentStateByOrderId.get(order.id) ?? {
    confirmedUsd: 0,
    confirmedBs: 0,
    pendingUsd: 0,
    pendingBs: 0,
    balanceUsd: 0,
    balanceBs: 0,
    reportableBalanceUsd: 0,
    reportableBalanceBs: 0,
    totalBs: getOrderTotalBs(order),
    hasRejected: false,
  };
}

function paymentAttentionLabel(order: OrderRow, paymentStateByOrderId: Map<number, PaymentState>) {
  if (order.status === 'cancelled') return null;

  const state = getStoredPaymentState(order, paymentStateByOrderId);
  if (state.balanceUsd <= 0.005) return null;
  if (state.pendingUsd > 0.005 && state.reportableBalanceUsd <= 0.005) return 'Por validar';
  if (state.confirmedUsd > 0.005 || state.pendingUsd > 0.005) {
    return `Saldo ${formatBs(state.reportableBalanceBs > 0.005 ? state.reportableBalanceBs : state.balanceBs)}`;
  }
  return 'Sin pago';
}

function isUnpaidOrder(order: OrderRow, paymentStateByOrderId: Map<number, PaymentState>) {
  if (order.status === 'cancelled') return false;
  return getStoredPaymentState(order, paymentStateByOrderId).balanceUsd > 0.005;
}

function latestReviewEvent(order: OrderRow, reviewEventByOrderId: Map<number, TimelineEventRow>) {
  return reviewEventByOrderId.get(order.id)?.event_type || null;
}

function needsAdvisorReview(order: OrderRow, reviewEventByOrderId: Map<number, TimelineEventRow>) {
  if (!isOpenStatus(order.status)) return false;
  return ['order_returned_to_review', 'order_changes_rejected'].includes(
    String(latestReviewEvent(order, reviewEventByOrderId) || '')
  );
}

function needsInitialApproval(order: OrderRow) {
  return order.status === 'created';
}

function needsReapproval(order: OrderRow) {
  return needsOrderReapproval({
    status: order.status,
    queuedNeedsReapproval: order.queued_needs_reapproval,
  });
}

function priorityScore(order: OrderRow, paymentStateByOrderId: Map<number, PaymentState>, selectedDayKey: string) {
  if (isOverdueOrder(order, selectedDayKey)) return 0;
  if (isUnpaidOrder(order, paymentStateByOrderId)) return 1;
  if (order.extra_fields?.schedule?.asap && isOpenStatus(order.status)) return 2;
  if (order.status === 'created' || order.status === 'queued') return 3;
  return 4;
}

function operationalPhase(order: OrderRow): OperationalPhase {
  return getOperationalPhase(order.status);
}

function operationalPhaseIndex(order: OrderRow) {
  return getOperationalPhaseIndex(order.status);
}

function operationalPhaseLabel(order: OrderRow) {
  return getOperationalStatusLabel(order);
}

function orderSearchText(order: OrderRow) {
  const clientPhone = getOrderClient(order)?.phone ?? null;
  return normalizeSearchValue(
    [
      order.id,
      order.order_number,
      getOrderClient(order)?.full_name,
      clientPhone,
      ...getPhoneSearchTerms(clientPhone),
      order.delivery_address,
    ]
      .filter(Boolean)
      .join(' ')
  );
}

function getOrderClient(order: OrderRow) {
  return Array.isArray(order.client) ? order.client[0] ?? null : order.client;
}

function paymentStatusBadge(order: OrderRow, paymentStateByOrderId: Map<number, PaymentState>) {
  if (order.status === 'cancelled') return null;

  const state = getStoredPaymentState(order, paymentStateByOrderId);
  if (state.hasRejected) return { label: 'Pago rechazado', tone: 'danger' as const };
  if (state.balanceUsd <= 0.005) return { label: 'Pagado', tone: 'success' as const };
  if (state.pendingUsd > 0.005 && state.reportableBalanceUsd <= 0.005) {
    return { label: 'Pago por validar', tone: 'warning' as const };
  }
  if (state.confirmedUsd > 0.005 || state.pendingUsd > 0.005) {
    return {
      label: `Saldo ${formatBs(state.reportableBalanceBs > 0.005 ? state.reportableBalanceBs : state.balanceBs)}`,
      tone: 'warning' as const,
    };
  }
  return { label: 'Cobro pendiente', tone: 'warning' as const };
}

function OrderPaymentStatusBadge({
  order,
  paymentStateByOrderId,
}: {
  order: OrderRow;
  paymentStateByOrderId: Map<number, PaymentState>;
}) {
  const badge = paymentStatusBadge(order, paymentStateByOrderId);
  return badge ? <StatusBadge label={badge.label} tone={badge.tone} /> : null;
}

function attentionLabels(order: OrderRow, paymentStateByOrderId: Map<number, PaymentState>, selectedDayKey: string) {
  const labels: Array<{ label: string; tone: 'neutral' | 'warning' | 'success' | 'danger' }> = [];
  const payment = getStoredPaymentState(order, paymentStateByOrderId);

  if (isOverdueOrder(order, selectedDayKey)) labels.push({ label: 'Hora atrasada', tone: 'danger' });
  if (payment.hasRejected) labels.push({ label: 'Pago rechazado', tone: 'danger' });
  else if (payment.balanceUsd > 0.005) labels.push({ label: 'Cobro pendiente', tone: 'warning' });
  if (order.extra_fields?.schedule?.asap && isOpenStatus(order.status)) {
    labels.push({ label: 'Lo antes posible', tone: 'warning' });
  }
  if (order.status === 'created' || order.status === 'queued') {
    labels.push({ label: 'Pendiente de avance', tone: 'neutral' });
  }

  return labels;
}

export default async function AdvisorHomePage({ searchParams }: { searchParams?: SearchParams }) {
  const params = (await searchParams) ?? {};
  const ctx = await getAuthContext();
  if (!ctx) return null;

  const selectedDayKey =
    params.day && /^\d{4}-\d{2}-\d{2}$/.test(params.day) ? params.day : getDateKey(new Date());
  const searchQuery = String(params.q || '').trim();
  const normalizedSearchQuery = normalizeSearchValue(searchQuery);
  const remoteSearchQuery = normalizeRemoteSearchValue(searchQuery);
  const searchIsNumeric = /^\d+$/.test(remoteSearchQuery);
  const searchCanRun = normalizedSearchQuery.length >= 2 || searchIsNumeric;
  const orderSelect =
    'id, client_id, order_number, status, queued_needs_reapproval, fulfillment, total_usd, created_at, delivery_address, extra_fields, client:clients!orders_client_id_fkey(full_name, phone)';
  const dayRange = getCaracasDayRange(selectedDayKey);

  const [scheduledOrdersResult, createdOrdersResult] = await Promise.all([
    ctx.supabase
      .from('orders')
      .select(orderSelect)
      .eq('attributed_advisor_id', ctx.user.id)
      .eq('extra_fields->schedule->>date', selectedDayKey)
      .order('created_at', { ascending: false })
      .limit(120),
    ctx.supabase
      .from('orders')
      .select(orderSelect)
      .eq('attributed_advisor_id', ctx.user.id)
      .gte('created_at', dayRange.startISO)
      .lt('created_at', dayRange.endISO)
      .order('created_at', { ascending: false })
      .limit(120),
  ]);

  const orderById = new Map<number, OrderRow>();
  for (const order of ([...(scheduledOrdersResult.data ?? []), ...(createdOrdersResult.data ?? [])] as OrderRow[])) {
    orderById.set(Number(order.id), {
      ...order,
      client: Array.isArray(order.client) ? order.client[0] ?? null : order.client,
    });
  }
  const orders = Array.from(orderById.values());

  const agendaOrders = orders
    .filter((order) => getAgendaDayKey(order) === selectedDayKey)
    .sort((a, b) => getAgendaSortKey(a).localeCompare(getAgendaSortKey(b)));

  let searchResults: OrderRow[] = [];

  if (searchCanRun) {
    const localMatches = orders.filter((order) => orderSearchText(order).includes(normalizedSearchQuery));
    let remoteMatches: OrderRow[] = [];
    const phoneSearchTerms = getPhoneSearchTerms(remoteSearchQuery)
      .map((term) => term.replace(/[,%]/g, ' '))
      .filter(Boolean)
      .slice(0, 5);
    const shouldSearchRemoteClients =
      remoteSearchQuery.length >= 2 || phoneSearchTerms.some((term) => term.replace(/\D/g, '').length >= 4);

    if (shouldSearchRemoteClients) {
      const phoneFilters = phoneSearchTerms.map((term) => `phone.ilike.%${term}%`);
      const { data: accentSafeClientMatches, error: accentSafeClientError } = await ctx.supabase.rpc('search_clients_unaccent', {
        p_query: remoteSearchQuery,
        p_limit: 18,
      });

      const clientMatches =
        !accentSafeClientError && Array.isArray(accentSafeClientMatches)
          ? accentSafeClientMatches
          : (await ctx.supabase
              .from('clients')
              .select('id')
              .or([`phone.ilike.%${remoteSearchQuery}%`, ...phoneFilters, `full_name.ilike.%${remoteSearchQuery}%`].join(','))
              .order('id', { ascending: false })
              .limit(18)).data;

      const clientIds = Array.from(
        new Set(
          (clientMatches ?? [])
            .map((client) => Number((client as { id?: number | string }).id))
            .filter((id) => Number.isFinite(id) && id > 0)
        )
      );

      if (clientIds.length > 0) {
        const { data: clientOrders } = await ctx.supabase
          .from('orders')
          .select(orderSelect)
          .eq('attributed_advisor_id', ctx.user.id)
          .in('client_id', clientIds)
          .order('created_at', { ascending: false })
          .limit(60);

        remoteMatches = ((clientOrders ?? []) as OrderRow[]).map((order) => ({
          ...order,
          client: Array.isArray(order.client) ? order.client[0] ?? null : order.client,
        }));
      }
    }

    if (remoteSearchQuery.length >= 2 || searchIsNumeric) {
      const orderFilters = remoteSearchQuery.length >= 2 ? [`order_number.ilike.%${remoteSearchQuery}%`] : [];
      const numericSearch = Number(remoteSearchQuery);
      if (searchIsNumeric && Number.isFinite(numericSearch) && numericSearch > 0) {
        orderFilters.push(`id.eq.${Math.trunc(numericSearch)}`);
      }
      const { data: directOrderMatches } = await ctx.supabase
        .from('orders')
        .select(orderSelect)
        .eq('attributed_advisor_id', ctx.user.id)
        .or(orderFilters.join(','))
        .order('created_at', { ascending: false })
        .limit(30);

      remoteMatches = [
        ...remoteMatches,
        ...(((directOrderMatches ?? []) as OrderRow[]).map((order) => ({
          ...order,
          client: Array.isArray(order.client) ? order.client[0] ?? null : order.client,
        }))),
      ];
    }

    const searchResultById = new Map<number, OrderRow>();
    for (const order of [...remoteMatches, ...localMatches]) {
      searchResultById.set(order.id, order);
    }
    searchResults = Array.from(searchResultById.values());
  }

  const detailOrderIds = Array.from(
    new Set([...agendaOrders, ...searchResults].map((order) => order.id))
  );
  const paymentOrderIds = Array.from(
    new Set([...agendaOrders, ...searchResults].filter((order) => order.status !== 'cancelled').map((order) => order.id))
  );
  const reviewOrderIds = Array.from(
    new Set([...agendaOrders, ...searchResults].filter((order) => isOpenStatus(order.status)).map((order) => order.id))
  );
  const { data: activeRateData } = detailOrderIds.length
    ? await ctx.supabase
        .from('exchange_rates')
        .select('rate_bs_per_usd')
        .eq('is_active', true)
        .order('effective_at', { ascending: false })
        .limit(1)
        .maybeSingle()
    : { data: null };
  const activeRateBsPerUsd = toSafeNumber((activeRateData as { rate_bs_per_usd?: number | string } | null)?.rate_bs_per_usd, 0);

  const [financialStateResult, timelineData] = detailOrderIds.length
    ? await Promise.all([
      paymentOrderIds.length
        ? (ctx.supabase as any).rpc('get_orders_financial_state', {
            p_order_ids: paymentOrderIds,
            p_operation_date: null,
            p_active_bs_rate: activeRateBsPerUsd > 0 ? activeRateBsPerUsd : null,
          })
        : Promise.resolve({ data: [], error: null }),
      reviewOrderIds.length
        ? ctx.supabase
            .from('order_timeline_events')
            .select('order_id, event_type, created_at')
            .in('order_id', reviewOrderIds)
            .in('event_type', REVIEW_EVENT_TYPES)
            .order('created_at', { ascending: false })
            .limit(160)
        : Promise.resolve({ data: [] }),
    ]).then(([financialResult, timelineResult]) => [
      financialResult,
      timelineResult.data ?? [],
    ] as const)
    : [{ data: [], error: null }, []] as const;
  const financialStateRows = (financialStateResult.data ?? []) as RawOrderFinancialStateRow[];
  const financialStateByOrderId = new Map<number, RawOrderFinancialStateRow>();
  for (const state of financialStateRows) {
    const orderId = Number(state.order_id);
    if (Number.isFinite(orderId)) financialStateByOrderId.set(orderId, state);
  }

  const { data: fallbackPaymentsData } =
    financialStateResult.error && paymentOrderIds.length
      ? await ctx.supabase
          .from('payment_reports')
          .select('order_id, status, reported_amount, reported_currency_code, reported_amount_usd_equivalent')
          .in('order_id', paymentOrderIds)
      : { data: [] };
  if (financialStateResult.error) {
    console.warn('get_orders_financial_state skipped in advisor home', financialStateResult.error.message);
  }
  const paymentReports = (fallbackPaymentsData ?? []) as PaymentRow[];

  const paymentReportsByOrderId = new Map<number, PaymentRow[]>();
  for (const report of paymentReports) {
    const current = paymentReportsByOrderId.get(report.order_id) ?? [];
    current.push(report);
    paymentReportsByOrderId.set(report.order_id, current);
  }
  const paymentStateByOrderId = new Map<number, PaymentState>();
  for (const order of [...agendaOrders, ...searchResults]) {
    const canonicalState = financialStateByOrderId.get(order.id);
    paymentStateByOrderId.set(
      order.id,
      canonicalState ? getCanonicalPaymentState(canonicalState) : getPaymentState(order, paymentReportsByOrderId)
    );
  }

  const reviewEventByOrderId = new Map<number, TimelineEventRow>();
  for (const event of (timelineData ?? []) as TimelineEventRow[]) {
    const orderId = Number(event.order_id);
    if (!Number.isFinite(orderId) || reviewEventByOrderId.has(orderId)) continue;
    reviewEventByOrderId.set(orderId, event);
  }

  const openOrders = agendaOrders.filter((order) => isOpenStatus(order.status));
  const unpaidOrders = agendaOrders.filter((order) => isUnpaidOrder(order, paymentStateByOrderId));
  const overdueOrders = agendaOrders.filter((order) => isOverdueOrder(order, selectedDayKey));
  const asapOrders = agendaOrders.filter(
    (order) => order.extra_fields?.schedule?.asap && isOpenStatus(order.status)
  );
  const deliveredOrders = agendaOrders.filter((order) => order.status === 'delivered');
  const returnedOrders = agendaOrders.filter((order) => needsAdvisorReview(order, reviewEventByOrderId));
  const pendingApprovalOrders = agendaOrders.filter((order) => needsInitialApproval(order));
  const pendingReapprovalOrders = agendaOrders.filter((order) => needsReapproval(order));
  const attentionOrders = [...agendaOrders]
    .filter((order) => isOpenStatus(order.status))
    .filter(
      (order) =>
        needsAdvisorReview(order, reviewEventByOrderId) ||
        needsInitialApproval(order) ||
        needsReapproval(order) ||
        attentionLabels(order, paymentStateByOrderId, selectedDayKey).length > 0
    )
    .sort((a, b) => {
      const reviewDiff =
        Number(needsAdvisorReview(b, reviewEventByOrderId)) - Number(needsAdvisorReview(a, reviewEventByOrderId));
      if (reviewDiff !== 0) return reviewDiff;
      const scoreDiff =
        priorityScore(a, paymentStateByOrderId, selectedDayKey) -
        priorityScore(b, paymentStateByOrderId, selectedDayKey);
      if (scoreDiff !== 0) return scoreDiff;
      return getAgendaSortKey(a).localeCompare(getAgendaSortKey(b));
    })
    .slice(0, 4);
  const phaseCounts = OPERATIONAL_PHASES.map((phase) => ({
    ...phase,
    count: agendaOrders.filter((order) => operationalPhase(order) === phase.key).length,
  }));
  const displayedSearchResults = searchResults
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .slice(0, 30);

  return (
    <div className="space-y-4">
      <AdvisorCalendarStrip
        selectedDayKey={selectedDayKey}
        todayKey={getDateKey(new Date())}
      />

      <section className="rounded-[22px] border border-[#232632] bg-[#12151d] px-4 py-3.5">
        <AdvisorSearchForm selectedDayKey={selectedDayKey} searchQuery={searchQuery} />

        {searchQuery ? (
          <div className="mt-3">
            <div className="mb-2 flex items-center justify-between gap-3 text-xs text-[#8B93A7]">
              <span>
                {displayedSearchResults.length} pedido{displayedSearchResults.length === 1 ? '' : 's'}
              </span>
              <Link href={`/app/advisor?day=${selectedDayKey}`} className="font-medium text-[#F7DA66]">
                Limpiar
              </Link>
            </div>

            {displayedSearchResults.length > 0 ? (
              <div className="space-y-2">
                {displayedSearchResults.map((order) => (
                  <Link
                    key={`search-${order.id}`}
                    href={`/app/advisor/orders/${order.id}`}
                    className="block rounded-[16px] border border-[#232632] bg-[#0F131B] px-3.5 py-3"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-semibold text-[#F5F7FB]">
                          {getOrderClient(order)?.full_name?.trim() || formatOrderDisplayNumber(order.id)}
                        </div>
                        <div className="mt-1 truncate text-xs text-[#8B93A7]">
                          Orden {formatOrderDisplayNumber(order.id)} · {formatDateLabel(new Date(`${getAgendaDayKey(order)}T12:00:00-04:00`))}
                        </div>
                      </div>
                      <div className="shrink-0 text-right">
                        <div className="text-xs font-semibold text-[#F0D000]">{formatUsd(getOrderTotalUsd(order))}</div>
                        <div className="mt-1 text-[11px] text-[#8B93A7]">{getAgendaTimeLabel(order)}</div>
                      </div>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      <StatusBadge label={operationalPhaseLabel(order)} tone={statusTone(order.status)} />
                      <OrderPaymentStatusBadge order={order} paymentStateByOrderId={paymentStateByOrderId} />
                      {needsAdvisorReview(order, reviewEventByOrderId) ? (
                        <StatusBadge label="Devuelta" tone="danger" />
                      ) : null}
                      {needsReapproval(order) ? <StatusBadge label="Re-aprobacion" tone="warning" /> : null}
                      {needsInitialApproval(order) ? <StatusBadge label="Por aprobar" tone="neutral" /> : null}
                    </div>
                  </Link>
                ))}
              </div>
            ) : searchCanRun ? (
              <div className="rounded-[16px] border border-[#232632] bg-[#0F131B] px-3.5 py-3 text-sm text-[#AAB2C5]">
                Sin coincidencias.
              </div>
            ) : null}
          </div>
        ) : null}
      </section>

      <section className="rounded-[22px] border border-[#232632] bg-[#12151d] px-4 py-3.5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-[#8B93A7]">
              Seguimiento
            </div>
            <h2 className="mt-1 text-xl font-semibold tracking-[-0.03em] text-[#F5F7FB]">Pedidos del día</h2>
          </div>
          <div className="text-right text-xs leading-5 text-[#AAB2C5]">
            <div>{agendaOrders.length} pedidos</div>
            <div>{openOrders.length} abiertos</div>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-5 gap-1.5">
          {phaseCounts.map((phase) => (
            <Link
              key={phase.key}
              href={`/app/advisor/orders?day=${selectedDayKey}&bucket=phase_${phase.key}`}
              className="min-w-0 rounded-[14px] border border-[#232632] bg-[#0F131B] px-1.5 py-2 text-center transition active:scale-[0.99]"
            >
              <div className="text-lg font-semibold text-[#F5F7FB]">{phase.count}</div>
              <div className="mt-0.5 text-[9px] font-semibold uppercase leading-3 tracking-normal text-[#8B93A7]">
                {phase.shortLabel}
              </div>
            </Link>
          ))}
        </div>

        <div className="mt-3 grid grid-cols-4 gap-1.5">
          <Link
            href={`/app/advisor/orders?day=${selectedDayKey}&bucket=overdue`}
            className="rounded-[12px] border border-[#232632] bg-[#0F131B] px-2.5 py-2 text-center text-xs text-[#CCD3E2]"
          >
            <span className="font-semibold text-[#F5F7FB]">{overdueOrders.length}</span> hora atrasada
          </Link>
          <Link
            href={`/app/advisor/orders?day=${selectedDayKey}&bucket=unpaid`}
            className="rounded-[12px] border border-[#232632] bg-[#0F131B] px-2.5 py-2 text-center text-xs text-[#CCD3E2]"
          >
            <span className="font-semibold text-[#F5F7FB]">{unpaidOrders.length}</span> cobro
          </Link>
          <Link
            href={`/app/advisor/orders?day=${selectedDayKey}&bucket=asap`}
            className="rounded-[12px] border border-[#232632] bg-[#0F131B] px-2.5 py-2 text-center text-xs text-[#CCD3E2]"
          >
            <span className="font-semibold text-[#F5F7FB]">{asapOrders.length}</span> ASAP
          </Link>
          <Link
            href={`/app/advisor/orders?day=${selectedDayKey}&bucket=delivered`}
            className="rounded-[12px] border border-[#232632] bg-[#0F131B] px-2.5 py-2 text-center text-xs text-[#CCD3E2]"
          >
            <span className="font-semibold text-[#F5F7FB]">{deliveredOrders.length}</span> entregadas
          </Link>
        </div>
      </section>

      <section className="grid grid-cols-3 gap-2">
        <Link
          href={`/app/advisor/orders?day=${selectedDayKey}&bucket=returned`}
          className={[
            'rounded-[14px] border px-2.5 py-2 text-center',
            returnedOrders.length > 0 ? 'border-[#5E2229] bg-[#171118]' : 'border-[#232632] bg-[#0F131B]',
          ].join(' ')}
        >
          <div className="text-xl font-semibold leading-none text-[#F5F7FB]">{returnedOrders.length}</div>
          <div className="mt-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-[#AAB2C5]">Devueltas</div>
        </Link>

        <Link
          href={`/app/advisor/orders?day=${selectedDayKey}&bucket=approval`}
          className={[
            'rounded-[14px] border px-2.5 py-2 text-center',
            pendingApprovalOrders.length > 0 ? 'border-[#564511] bg-[#151208]' : 'border-[#232632] bg-[#0F131B]',
          ].join(' ')}
        >
          <div className="text-xl font-semibold leading-none text-[#F5F7FB]">{pendingApprovalOrders.length}</div>
          <div className="mt-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-[#AAB2C5]">Por aprobar</div>
        </Link>

        <Link
          href={`/app/advisor/orders?day=${selectedDayKey}&bucket=reapproval`}
          className={[
            'rounded-[14px] border px-2.5 py-2 text-center',
            pendingReapprovalOrders.length > 0 ? 'border-[#564511] bg-[#151208]' : 'border-[#232632] bg-[#0F131B]',
          ].join(' ')}
        >
          <div className="text-xl font-semibold leading-none text-[#F5F7FB]">{pendingReapprovalOrders.length}</div>
          <div className="mt-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-[#AAB2C5]">Re-aprob.</div>
        </Link>
      </section>

      {attentionOrders.length > 0 ? (
        <SectionCard
          title="Atencion"
          subtitle="Pedidos con algo que puede frenar la operacion."
          action={
            <Link
              href={`/app/advisor/orders?day=${selectedDayKey}&bucket=priority`}
              className="inline-flex h-9 items-center rounded-[12px] border border-[#232632] px-3 text-sm font-medium text-[#F5F7FB]"
            >
              Ver todo
            </Link>
          }
        >
          <div className="space-y-2.5">
            {attentionOrders.map((order) => {
              const labels = attentionLabels(order, paymentStateByOrderId, selectedDayKey);
              const reviewBadge = needsAdvisorReview(order, reviewEventByOrderId)
                ? { label: 'Devuelta', tone: 'danger' as const }
                : needsReapproval(order)
                  ? { label: 'Re-aprobación', tone: 'warning' as const }
                  : needsInitialApproval(order)
                    ? { label: 'Por aprobar', tone: 'neutral' as const }
                    : null;

              return (
                <Link
                  key={order.id}
                  href={`/app/advisor/orders/${order.id}`}
                  className="block rounded-[18px] border border-[#2A3040] bg-[#0F131B] px-3.5 py-3"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-[#F5F7FB]">
                        {getOrderClient(order)?.full_name?.trim() || formatOrderDisplayNumber(order.id)}
                      </div>
                      <div className="mt-1 text-xs text-[#8B93A7]">
                        {getAgendaTimeLabel(order)} · {operationalPhaseLabel(order)}
                      </div>
                    </div>
                    <div className="shrink-0 text-xs font-semibold text-[#F0D000]">{formatUsd(getOrderTotalUsd(order))}</div>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {reviewBadge ? <StatusBadge label={reviewBadge.label} tone={reviewBadge.tone} /> : null}
                    {labels.map((label) => (
                      <StatusBadge key={`${order.id}-${label.label}`} label={label.label} tone={label.tone} />
                    ))}
                  </div>
                </Link>
              );
            })}
          </div>
        </SectionCard>
      ) : null}

      <SectionCard
        title="Pedidos del dia"
        subtitle="Lectura por fase, cobro y hora."
        action={
          <Link
            href={`/app/advisor/orders?day=${selectedDayKey}&bucket=priority`}
            className="inline-flex h-9 items-center rounded-[12px] border border-[#232632] px-3 text-sm font-medium text-[#F5F7FB]"
          >
            Lista
          </Link>
        }
      >
        {agendaOrders.length === 0 ? (
          <EmptyBlock
            title="Sin pedidos agendados"
            detail="Este dia no tiene pedidos visibles para este asesor."
            href="/app/advisor/new"
            cta="Crear pedido"
          />
        ) : (
          <div className="space-y-2.5">
            {agendaOrders.map((order) => {
              const phaseIndex = operationalPhaseIndex(order);
              const paymentBadge = paymentStatusBadge(order, paymentStateByOrderId);
              const reviewBadge = needsAdvisorReview(order, reviewEventByOrderId)
                ? { label: 'Devuelta', tone: 'danger' as const }
                : needsReapproval(order)
                  ? { label: 'Re-aprobación', tone: 'warning' as const }
                  : needsInitialApproval(order)
                    ? { label: 'Por aprobar', tone: 'neutral' as const }
                    : null;
              const labels = attentionLabels(order, paymentStateByOrderId, selectedDayKey).filter(
                (label) => label.label !== 'Cobro pendiente'
              );

              return (
                <Link
                  key={order.id}
                  href={`/app/advisor/orders/${order.id}`}
                  className="block rounded-[18px] border border-[#232632] bg-[#0F131B] px-3.5 py-3"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold text-[#F5F7FB]">
                        {getOrderClient(order)?.full_name?.trim() || formatOrderDisplayNumber(order.id)}
                      </div>
                      <div className="mt-1 truncate text-xs text-[#8B93A7]">
                        Orden {formatOrderDisplayNumber(order.id)} · {order.fulfillment === 'delivery' ? 'Delivery' : 'Retiro'}
                      </div>
                    </div>
                    <div className="shrink-0 text-right">
                      <div className="text-sm font-semibold text-[#F5F7FB]">{getAgendaTimeLabel(order)}</div>
                      <div className="mt-1 text-xs text-[#8B93A7]">{formatUsd(getOrderTotalUsd(order))}</div>
                    </div>
                  </div>

                  <div className="mt-3 flex items-center justify-between gap-3">
                    <StatusBadge label={operationalPhaseLabel(order)} tone={statusTone(order.status)} />
                    <div className="flex flex-wrap justify-end gap-1.5">
                      {reviewBadge ? <StatusBadge label={reviewBadge.label} tone={reviewBadge.tone} /> : null}
                      {paymentBadge ? <StatusBadge label={paymentBadge.label} tone={paymentBadge.tone} /> : null}
                    </div>
                  </div>

                  {operationalPhase(order) === 'cancelled' ? (
                    <div className="mt-3 rounded-[12px] bg-[#261114] px-3 py-2 text-xs text-[#F0A6AE]">
                      Pedido cancelado.
                    </div>
                  ) : (
                    <div className="mt-3 grid grid-cols-5 gap-1">
                      {OPERATIONAL_PHASES.map((phase, index) => (
                        <div
                          key={`${order.id}-${phase.key}`}
                          className={[
                            'h-1.5 rounded-full',
                            index <= phaseIndex ? 'bg-[#F0D000]' : 'bg-[#252B38]',
                          ].join(' ')}
                        />
                      ))}
                    </div>
                  )}

                  <div className="mt-3 flex items-center justify-between gap-3 text-xs text-[#AAB2C5]">
                    <span className="min-w-0 truncate">
                      {order.fulfillment === 'delivery'
                        ? order.delivery_address?.trim() || 'Delivery sin direccion'
                        : 'Retiro en tienda'}
                    </span>
                    {labels.length > 0 ? (
                      <span className="shrink-0 text-[#F7DA66]">{labels[0]?.label}</span>
                    ) : null}
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </SectionCard>
    </div>
  );
}
