import {
  getOrderCommercialNetUsd,
  getOrderMoneySnapshot,
  type OrderMoneySource,
} from '../orders/order-money.ts';
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
  return buildAdminFinancePeriod('week', asOf).endExclusiveKey;
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
  quality: {
    deliveryRowsTruncated: boolean;
    financialStatesComplete: boolean;
    financialStateRows: number;
    billedOrders: number;
    historicalWeeks: number;
  };
};

function numberValue(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function roundMoney(value: number) {
  return Number(value.toFixed(2));
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

    const money = getOrderMoneySnapshot(order);
    const financialState = input.financialStateByOrderId.get(Number(order.id));
    const contractualTotal = financialState
      ? Math.max(0, numberValue(financialState.total_usd))
      : money.totalUsd;
    if (isScheduledWithinWindow && order.fulfillment === 'delivery' && order.status !== 'cancelled') {
      result.deliveries += 1;
      if (order.status === 'delivered') result.deliveriesCompleted += 1;
    }

    if (!isCommercialWithinWindow || !isDeliveredSaleOrder(order.status, contractualTotal)) continue;

    result.closures += 1;
    result.billedOrders += 1;
    result.billedUsd += contractualTotal;
    result.commercialNetUsd += getOrderCommercialNetUsd(order);

    if (!input.requireFinancialState) continue;
    if (!financialState) continue;

    coveredBilledOrders += 1;
    const orderTotal = contractualTotal;
    const pendingUsd = Math.min(
      orderTotal,
      Math.max(0, numberValue(financialState.pending_usd))
    );
    result.coveredUsd = numberValue(result.coveredUsd) + Math.max(0, orderTotal - pendingUsd);
    result.pendingUsd = numberValue(result.pendingUsd) + pendingUsd;
  }

  result.billedUsd = roundMoney(result.billedUsd);
  result.commercialNetUsd = roundMoney(result.commercialNetUsd);
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
        commercialMinuteCutoff:
          weekdayIndex === currentWeekdayIndex ? currentMinuteOfDay : undefined,
      });
    });
    return {
      billedUsd: roundMoney(samples.reduce((sum, sample) => sum + sample.billedUsd, 0) / HISTORICAL_WEEKS),
      closures: Number(
        (samples.reduce((sum, sample) => sum + sample.closures, 0) / HISTORICAL_WEEKS).toFixed(1)
      ),
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
    });
    historicalBilledUsd = roundMoney(historicalBilledUsd + historicalDaily[weekdayIndex].billedUsd);
    historicalClosures = Number((historicalClosures + historicalDaily[weekdayIndex].closures).toFixed(1));
    const isObserved = dateKey <= todayKey;
    if (isObserved) {
      currentBilledUsd = roundMoney(currentBilledUsd + currentDay.billedUsd);
      currentClosures = Number((currentClosures + currentDay.closures).toFixed(1));
    }
    return {
      dateKey,
      currentBilledUsd: isObserved ? currentBilledUsd : null,
      historicalBilledUsd,
      currentClosures: isObserved ? currentClosures : null,
      historicalClosures,
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
      todayBilledUsd: historicalToday.billedUsd,
      todayClosures: historicalToday.closures,
      weekBilledUsd: roundMoney(historicalAverageWeek.billedUsd),
      weekClosures: Number(historicalAverageWeek.closures.toFixed(1)),
    },
    trend,
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
