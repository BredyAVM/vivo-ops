import type { OrderMoneySource } from '../orders/order-money.ts';
import { getOrderOperationalKpiAmounts, hasValidKpiFinancialState, roundKpiAmount,
  sumOperationalKpis } from '../orders/operational-kpis.ts';
import {
  addDateKeyDays,
  buildAdminFinancePeriod,
  getCaracasDateKey,
  listDateKeys,
} from './period.ts';

const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const HISTORICAL_WEEKS = 4;
export const ADMIN_EXECUTIVE_DEFINITION_VERSION = 'admin-executive-v1';

export function executiveHistoryStartKey(asOf: Date) {
  const period = buildAdminFinancePeriod('week', asOf);
  return addDateKeyDays(period.startKey, -(HISTORICAL_WEEKS * 7));
}

export function executiveWindowEndKey(asOf: Date) {
  return buildAdminFinancePeriod('week', asOf).fullEndExclusiveKey;
}

export type ExecutiveOrderRow = OrderMoneySource & {
  id: number | string;
  status: string | null;
  fulfillment: string | null;
  created_at: string;
  commercial_date?: string | null;
  commercial_at?: string | null;
  extra_fields?: (OrderMoneySource['extra_fields'] & {
    schedule?: {
      date?: string | null;
    } | null;
  }) | null;
};

export type ExecutiveFinancialStateRow = {
  order_id: number | string;
  total_usd: number | string | null;
  confirmed_paid_usd: number | string | null;
  pending_usd: number | string | null;
};

export type ExecutiveKpiTotals = {
  closures: number;
  billedOrders: number;
  billedUsd: number;
  commercialNetUsd: number;
  coveredUsd: number | null;
  pendingUsd: number | null;
  financialCoveragePct: number | null;
  deliveries: number;
  deliveriesCompleted: number;
  deliveriesPending: number;
};

export type ExecutiveTrendPoint = {
  dateKey: string;
  currentBilledUsd: number | null;
  historicalBilledUsd: number;
  currentClosures: number | null;
  historicalClosures: number;
};

export type AdminExecutiveKpiOverview = {
  definitionVersion: typeof ADMIN_EXECUTIVE_DEFINITION_VERSION;
  asOf: string;
  todayKey: string;
  weekStartKey: string;
  weekEndExclusiveKey: string;
  today: ExecutiveKpiTotals;
  week: ExecutiveKpiTotals;
  historicalAverage: {
    todayBilledUsd: number;
    todayClosures: number;
    weekBilledUsd: number;
    weekClosures: number;
  };
  trend: ExecutiveTrendPoint[];
  operational: OperationalOverview;
  quality: {
    deliveryRowsTruncated: boolean;
    financialStatesComplete: boolean;
    financialStateRows: number;
    billedOrders: number;
    historicalWeeks: number;
  };
};

export type OperationalTotals = {
  closures: number;
  commercialNetUsd: number;
  confirmedPaidUsd: number | null;
  pendingUsd: number | null;
  financialStatesComplete: boolean;
};

export type OperationalOverview = {
  today: OperationalTotals;
  week: OperationalTotals;
  history: { startKey: string; endExclusiveKey: string; closures: number; commercialNetUsd: number }[];
  trend: ExecutiveTrendPoint[];
  historyWeeks: number;
  growthPct: number;
  weeklyReferenceUsd: number;
  weeklyReferenceClosures: number;
};

export function parseProjectionOptions(weeks: unknown, growth: unknown) {
  const historyWeeks = Number(weeks);
  const growthPct = typeof growth === 'string' && growth.trim() !== '' ? Number(growth) : 0;
  return {
    historyWeeks: Number.isInteger(historyWeeks) && historyWeeks >= 1 && historyWeeks <= HISTORICAL_WEEKS ? historyWeeks : HISTORICAL_WEEKS,
    growthPct: Number.isFinite(growthPct) && growthPct >= 0 && growthPct <= 100 ? growthPct : 0,
  };
}

function operationalTotals(orders: ExecutiveOrderRow[], states: Map<number, ExecutiveFinancialStateRow>): OperationalTotals {
  const totals = sumOperationalKpis(orders.map(order => ({ status: order.status,
    ...getOrderOperationalKpiAmounts(order, states.get(Number(order.id))) })));
  return {
    closures: totals.cierres, commercialNetUsd: totals.factNeta,
    confirmedPaidUsd: totals.abonadoConfirmado, pendingUsd: totals.pendiente,
    financialStatesComplete: totals.financialStatesComplete,
  };
}

function displayOperationalTotals(totals: OperationalTotals): OperationalTotals {
  return { ...totals, commercialNetUsd: roundMoney(totals.commercialNetUsd),
    confirmedPaidUsd: totals.confirmedPaidUsd === null ? null : roundMoney(totals.confirmedPaidUsd),
    pendingUsd: totals.pendingUsd === null ? null : roundMoney(totals.pendingUsd) };
}

export function buildOperationalOverview(input: {
  orders: ExecutiveOrderRow[];
  financialStates: ExecutiveFinancialStateRow[];
  asOf: Date;
  historyWeeks?: number;
  growthPct?: number;
}): OperationalOverview {
  const { historyWeeks, growthPct } = parseProjectionOptions(input.historyWeeks, String(input.growthPct ?? 0));
  const period = buildAdminFinancePeriod('week', input.asOf);
  const todayKey = getCaracasDateKey(input.asOf);
  const states = new Map(input.financialStates.map((state) => [Number(state.order_id), state]));
  const byDay = new Map<string, ExecutiveOrderRow[]>();
  // One order contributes once, even if the loader found it by multiple dates/events.
  for (const order of new Map(input.orders.map((order) => [Number(order.id), order])).values()) {
    const key = getExecutiveOrderDateKey(order);
    if (key) byDay.set(key, [...(byDay.get(key) ?? []), order]);
  }
  const days = listDateKeys(period.startKey, period.fullEndExclusiveKey);
  const currentDaily = days.map((key) => operationalTotals(byDay.get(key) ?? [], states));
  const historyStartKey = addDateKeyDays(period.startKey, -historyWeeks * 7);
  const history = Array.from({ length: historyWeeks }, (_, index) => {
    const startKey = addDateKeyDays(historyStartKey, index * 7);
    const totals = operationalTotals(listDateKeys(startKey, addDateKeyDays(startKey, 7)).flatMap((key) => byDay.get(key) ?? []), states);
    return { startKey, endExclusiveKey: addDateKeyDays(startKey, 7), closures: totals.closures, commercialNetUsd: totals.commercialNetUsd };
  });
  let actualUsd = 0;
  let referenceUsd = 0;
  let actualClosures = 0;
  let referenceClosures = 0;
  const factor = 1 + growthPct / 100;
  const trend = days.map((dateKey, weekday) => {
    const samples = history.map((week) => operationalTotals(byDay.get(addDateKeyDays(week.startKey, weekday)) ?? [], states));
    referenceUsd += samples.reduce((sum, day) => sum + day.commercialNetUsd, 0) / historyWeeks * factor;
    referenceClosures += samples.reduce((sum, day) => sum + day.closures, 0) / historyWeeks * factor;
    actualUsd += currentDaily[weekday].commercialNetUsd;
    actualClosures += currentDaily[weekday].closures;
    return {
      dateKey, currentBilledUsd: dateKey <= todayKey ? roundMoney(actualUsd) : null,
      historicalBilledUsd: roundMoney(referenceUsd),
      currentClosures: dateKey <= todayKey ? actualClosures : null,
      historicalClosures: Number(referenceClosures.toFixed(1)),
    };
  });
  return {
    today: displayOperationalTotals(currentDaily[days.indexOf(todayKey)]),
    week: displayOperationalTotals(operationalTotals(days.flatMap((key) => byDay.get(key) ?? []), states)),
    history: history.map(week => ({ ...week, commercialNetUsd: roundMoney(week.commercialNetUsd) })),
    trend, historyWeeks, growthPct,
    weeklyReferenceUsd: roundMoney(history.reduce((sum, week) => sum + week.commercialNetUsd, 0) / historyWeeks * factor),
    weeklyReferenceClosures: Number((history.reduce((sum, week) => sum + week.closures, 0) / historyWeeks * factor).toFixed(1)),
  };
}

function numberValue(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function roundMoney(value: number) {
  return roundKpiAmount(value);
}

function caracasMinuteOfDay(value: Date) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/Caracas',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(value);
  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? 0);
  const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? 0);
  return hour * 60 + minute;
}

function isAtOrBeforeMinute(order: ExecutiveOrderRow, cutoff: number | undefined) {
  if (cutoff === undefined) return true;
  if (!order.commercial_at) return false;
  const deliveredAt = new Date(order.commercial_at);
  if (Number.isNaN(deliveredAt.getTime())) return false;
  return caracasMinuteOfDay(deliveredAt) <= cutoff;
}

function ratioPct(numerator: number, denominator: number) {
  if (denominator <= 0) return null;
  return Number(((numerator / denominator) * 100).toFixed(1));
}

function isDeliveredSaleOrder(status: string | null, totalUsd: number) {
  return status === 'delivered' && totalUsd > 0.005;
}

export function getExecutiveOrderDateKey(order: ExecutiveOrderRow) {
  const scheduledDate = order.extra_fields?.schedule?.date;
  if (typeof scheduledDate === 'string' && DATE_KEY_PATTERN.test(scheduledDate)) {
    return scheduledDate;
  }

  const createdAt = new Date(order.created_at);
  return Number.isNaN(createdAt.getTime()) ? null : getCaracasDateKey(createdAt);
}

export function getExecutiveCommercialDateKey(order: ExecutiveOrderRow) {
  return typeof order.commercial_date === 'string' && DATE_KEY_PATTERN.test(order.commercial_date)
    ? order.commercial_date
    : null;
}

function emptyTotals(): ExecutiveKpiTotals {
  return {
    closures: 0,
    billedOrders: 0,
    billedUsd: 0,
    commercialNetUsd: 0,
    coveredUsd: 0,
    pendingUsd: 0,
    financialCoveragePct: 100,
    deliveries: 0,
    deliveriesCompleted: 0,
    deliveriesPending: 0,
  };
}

function summarizeOrders(input: {
  orders: ExecutiveOrderRow[];
  financialStateByOrderId: Map<number, ExecutiveFinancialStateRow>;
  startKey: string;
  endExclusiveKey: string;
  requireFinancialState: boolean;
  commercialMinuteCutoff?: number;
  preservePrecision?: boolean;
}) {
  const result = emptyTotals();
  let coveredBilledOrders = 0;

  for (const order of input.orders) {
    const scheduledDateKey = getExecutiveOrderDateKey(order);
    const commercialDateKey = getExecutiveCommercialDateKey(order);
    const isScheduledWithinWindow = Boolean(
      scheduledDateKey &&
        scheduledDateKey >= input.startKey &&
        scheduledDateKey < input.endExclusiveKey
    );
    const isCommercialWithinWindow = Boolean(
      commercialDateKey &&
        commercialDateKey >= input.startKey &&
        commercialDateKey < input.endExclusiveKey &&
        isAtOrBeforeMinute(order, input.commercialMinuteCutoff)
    );

    const financialState = input.financialStateByOrderId.get(Number(order.id));
    const money = getOrderOperationalKpiAmounts(order, financialState);
    const contractualTotal = money.totalUsd;
    if (isScheduledWithinWindow && order.fulfillment === 'delivery' && order.status !== 'cancelled') {
      result.deliveries += 1;
      if (order.status === 'delivered') result.deliveriesCompleted += 1;
    }

    if (!isCommercialWithinWindow || !isDeliveredSaleOrder(order.status, contractualTotal)) continue;

    result.closures += 1;
    result.billedOrders += 1;
    result.billedUsd += contractualTotal;
    result.commercialNetUsd += money.commercialNetUsd;

    if (!input.requireFinancialState) continue;
    if (!hasValidKpiFinancialState(financialState)) continue;

    coveredBilledOrders += 1;
    const orderTotal = contractualTotal;
    // Over-change can create debt above the sale price. Coverage is bounded,
    // but the canonical collectible balance must not be capped to that price.
    const pendingUsd = money.pendingUsd ?? 0;
    result.coveredUsd = numberValue(result.coveredUsd) + Math.max(0, orderTotal - pendingUsd);
    result.pendingUsd = numberValue(result.pendingUsd) + pendingUsd;
  }

  if (!input.preservePrecision) {
    result.billedUsd = roundMoney(result.billedUsd);
    result.commercialNetUsd = roundMoney(result.commercialNetUsd);
  }
  result.deliveriesPending = Math.max(0, result.deliveries - result.deliveriesCompleted);

  if (input.requireFinancialState) {
    result.financialCoveragePct =
      result.billedOrders === 0 ? 100 : ratioPct(coveredBilledOrders, result.billedOrders);
    if (coveredBilledOrders !== result.billedOrders) {
      result.coveredUsd = null;
      result.pendingUsd = null;
    } else {
      result.coveredUsd = roundMoney(numberValue(result.coveredUsd));
      result.pendingUsd = roundMoney(numberValue(result.pendingUsd));
    }
  } else {
    result.coveredUsd = null;
    result.pendingUsd = null;
    result.financialCoveragePct = null;
  }

  return result;
}

export function buildAdminExecutiveKpiOverview(input: {
  orders: ExecutiveOrderRow[];
  financialStates: ExecutiveFinancialStateRow[];
  asOf: Date;
  deliveryRowsTruncated?: boolean;
}): AdminExecutiveKpiOverview {
  const asOf = input.asOf;
  const weekPeriod = buildAdminFinancePeriod('week', asOf);
  const todayKey = getCaracasDateKey(asOf);
  const currentMinuteOfDay = caracasMinuteOfDay(asOf);
  const currentWeekKeys = listDateKeys(weekPeriod.startKey, weekPeriod.fullEndExclusiveKey);
  const currentWeekdayIndex = currentWeekKeys.indexOf(todayKey);
  const historyStartKey = executiveHistoryStartKey(asOf);
  const financialStateByOrderId = new Map(
    input.financialStates.map((state) => [Number(state.order_id), state])
  );

  const today = summarizeOrders({
    orders: input.orders,
    financialStateByOrderId,
    startKey: todayKey,
    endExclusiveKey: addDateKeyDays(todayKey, 1),
    requireFinancialState: true,
  });
  const week = summarizeOrders({
    orders: input.orders,
    financialStateByOrderId,
    startKey: weekPeriod.startKey,
    endExclusiveKey: weekPeriod.endExclusiveKey,
    requireFinancialState: true,
  });

  const historicalByWeek = Array.from({ length: HISTORICAL_WEEKS }, (_, index) => {
    const startKey = addDateKeyDays(historyStartKey, index * 7);
    return summarizeOrders({
      orders: input.orders,
      financialStateByOrderId,
      startKey,
      endExclusiveKey: addDateKeyDays(startKey, 7),
      requireFinancialState: false,
      preservePrecision: true,
    });
  });

  const historicalDaily = currentWeekKeys.map((_, weekdayIndex) => {
    const samples = Array.from({ length: HISTORICAL_WEEKS }, (__, weekIndex) => {
      const dateKey = addDateKeyDays(historyStartKey, weekIndex * 7 + weekdayIndex);
      return summarizeOrders({
        orders: input.orders,
        financialStateByOrderId,
        startKey: dateKey,
        endExclusiveKey: addDateKeyDays(dateKey, 1),
        requireFinancialState: false,
        preservePrecision: true,
        commercialMinuteCutoff:
          weekdayIndex === currentWeekdayIndex ? currentMinuteOfDay : undefined,
      });
    });
    return {
      billedUsd: samples.reduce((sum, sample) => sum + sample.billedUsd, 0) / HISTORICAL_WEEKS,
      closures: samples.reduce((sum, sample) => sum + sample.closures, 0) / HISTORICAL_WEEKS,
    };
  });

  let currentBilledUsd = 0;
  let historicalBilledUsd = 0;
  let currentClosures = 0;
  let historicalClosures = 0;
  const trend = currentWeekKeys.map((dateKey, weekdayIndex) => {
    const currentDay = summarizeOrders({
      orders: input.orders,
      financialStateByOrderId,
      startKey: dateKey,
      endExclusiveKey: addDateKeyDays(dateKey, 1),
      requireFinancialState: false,
      preservePrecision: true,
    });
    historicalBilledUsd += historicalDaily[weekdayIndex].billedUsd;
    historicalClosures += historicalDaily[weekdayIndex].closures;
    const isObserved = dateKey <= todayKey;
    if (isObserved) {
      currentBilledUsd += currentDay.billedUsd;
      currentClosures = Number((currentClosures + currentDay.closures).toFixed(1));
    }
    return {
      dateKey,
      currentBilledUsd: isObserved ? roundMoney(currentBilledUsd) : null,
      historicalBilledUsd: roundMoney(historicalBilledUsd),
      currentClosures: isObserved ? currentClosures : null,
      historicalClosures: Number(historicalClosures.toFixed(1)),
    };
  });

  const historicalToday = historicalDaily[Math.max(0, currentWeekdayIndex)] ?? { billedUsd: 0, closures: 0 };
  const historicalAverageWeek = historicalByWeek.reduce(
    (summary, sample) => ({
      billedUsd: summary.billedUsd + sample.billedUsd / HISTORICAL_WEEKS,
      closures: summary.closures + sample.closures / HISTORICAL_WEEKS,
    }),
    { billedUsd: 0, closures: 0 }
  );

  return {
    definitionVersion: ADMIN_EXECUTIVE_DEFINITION_VERSION,
    asOf: asOf.toISOString(),
    todayKey,
    weekStartKey: weekPeriod.startKey,
    weekEndExclusiveKey: weekPeriod.endExclusiveKey,
    today,
    week,
    historicalAverage: {
      todayBilledUsd: roundMoney(historicalToday.billedUsd),
      todayClosures: Number(historicalToday.closures.toFixed(1)),
      weekBilledUsd: roundMoney(historicalAverageWeek.billedUsd),
      weekClosures: Number(historicalAverageWeek.closures.toFixed(1)),
    },
    trend,
    operational: buildOperationalOverview(input),
    quality: {
      deliveryRowsTruncated: Boolean(input.deliveryRowsTruncated),
      financialStatesComplete:
        today.financialCoveragePct === 100 && week.financialCoveragePct === 100,
      financialStateRows: input.financialStates.length,
      billedOrders: week.billedOrders,
      historicalWeeks: HISTORICAL_WEEKS,
    },
  };
}
