import {
  calculateAdvisorCollectionOrderValue,
  type AdvisorGoalCollectionOrder,
} from './goal-engine.ts';

export type AdvisorGoalCollectionSnapshotOrder = {
  orderId: number;
  orderNumber: string | null;
  clientName: string;
  deliveryDate: string;
  totalUsd: number;
  confirmedPaidUsd: number;
  pendingUsd: number;
};

export type AdvisorGoalCollectionOrderStatus =
  | 'punctual_paid'
  | 'credit_paid'
  | 'credit_open'
  | 'overdue_paid'
  | 'overdue_open'
  | 'missing_registration';

export type AdvisorGoalCollectionOrderDetail = AdvisorGoalCollectionSnapshotOrder &
  AdvisorGoalCollectionOrder & {
    value: number;
    status: AdvisorGoalCollectionOrderStatus;
    elapsedDays: number;
    creditDueDate: string;
  };

export type AdvisorGoalPaymentRegistrationEntry = {
  orderId: number;
  registeredDate: string;
  amountUsd: number;
};

export type AdvisorGoalCollectionSummary = {
  ratio: number;
  ordersCount: number;
  punctualCount: number;
  creditCount: number;
  overdueCount: number;
  orders: AdvisorGoalCollectionOrderDetail[];
};

function round(value: number, digits = 4) {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function validDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T12:00:00Z`));
}

function elapsedDays(from: string, to: string) {
  return Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000);
}

function datePlusDays(value: string, days: number) {
  return new Date(Date.parse(`${value}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

export function buildAdvisorGoalPaymentCompletionDates(params: {
  orders: AdvisorGoalCollectionSnapshotOrder[];
  entries: AdvisorGoalPaymentRegistrationEntry[];
}) {
  const entriesByOrderId = new Map<number, AdvisorGoalPaymentRegistrationEntry[]>();
  for (const entry of params.entries) {
    if (!Number.isInteger(entry.orderId) || entry.orderId <= 0) continue;
    if (!validDate(entry.registeredDate) || !Number.isFinite(entry.amountUsd)) continue;
    const entries = entriesByOrderId.get(entry.orderId) ?? [];
    entries.push(entry);
    entriesByOrderId.set(entry.orderId, entries);
  }

  const completionDates = new Map<number, string>();
  for (const order of params.orders) {
    if (order.pendingUsd > 0.005) continue;
    const targetUsd = Math.min(
      Math.max(0, round(order.totalUsd, 2)),
      Math.max(0, round(order.confirmedPaidUsd, 2))
    );
    if (targetUsd <= 0.005) continue;

    const entries = [...(entriesByOrderId.get(order.orderId) ?? [])].sort((left, right) =>
      left.registeredDate.localeCompare(right.registeredDate)
    );
    let accumulatedUsd = 0;
    let completionDate: string | null = null;
    for (const entry of entries) {
      const wasComplete = accumulatedUsd >= targetUsd - 0.005;
      accumulatedUsd = Math.max(0, round(accumulatedUsd + entry.amountUsd, 2));
      const isComplete = accumulatedUsd >= targetUsd - 0.005;
      if (!wasComplete && isComplete) completionDate = entry.registeredDate;
      if (wasComplete && !isComplete) completionDate = null;
    }
    if (completionDate) completionDates.set(order.orderId, completionDate);
  }
  return completionDates;
}

export function calculateAdvisorGoalCollectionSummary(params: {
  orders: AdvisorGoalCollectionSnapshotOrder[];
  entries: AdvisorGoalPaymentRegistrationEntry[];
  asOfDate: string;
}): AdvisorGoalCollectionSummary {
  const completionDates = buildAdvisorGoalPaymentCompletionDates(params);
  const orders = params.orders.map((order) => {
    const completedPaymentRegistrationDate = completionDates.get(order.orderId) ?? null;
    const elapsed = elapsedDays(order.deliveryDate, completedPaymentRegistrationDate ?? params.asOfDate);
    const value = calculateAdvisorCollectionOrderValue(
      {
        deliveryDate: order.deliveryDate,
        completedPaymentRegistrationDate,
        paymentValidated: Boolean(completedPaymentRegistrationDate),
      },
      params.asOfDate
    );
    const status: AdvisorGoalCollectionOrderStatus = completedPaymentRegistrationDate
      ? elapsed <= 0
        ? 'punctual_paid'
        : elapsed <= 5
          ? 'credit_paid'
          : 'overdue_paid'
      : order.pendingUsd <= 0.005
        ? 'missing_registration'
        : elapsed >= 0 && elapsed <= 5
          ? 'credit_open'
          : 'overdue_open';
    return {
      ...order,
      completedPaymentRegistrationDate,
      paymentValidated: Boolean(completedPaymentRegistrationDate),
      value,
      status,
      elapsedDays: elapsed,
      creditDueDate: datePlusDays(order.deliveryDate, 5),
    };
  });
  const ordersCount = orders.length;
  const punctualCount = orders.filter((order) => order.value === 1).length;
  const creditCount = orders.filter((order) => order.value === 0.8).length;
  const overdueCount = ordersCount - punctualCount - creditCount;
  return {
    ratio: ordersCount > 0 ? round(orders.reduce((sum, order) => sum + order.value, 0) / ordersCount) : 0,
    ordersCount,
    punctualCount,
    creditCount,
    overdueCount,
    orders,
  };
}
