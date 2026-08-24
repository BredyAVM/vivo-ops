import {
  calculateAdvisorCollectionOrderValue,
  type AdvisorGoalCollectionOrder,
} from './goal-engine.ts';

export type AdvisorGoalCollectionSnapshotOrder = {
  orderId: number;
  deliveryDate: string;
  totalUsd: number;
  confirmedPaidUsd: number;
  pendingUsd: number;
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
  orders: Array<AdvisorGoalCollectionOrder & { orderId: number; value: number }>;
};

function round(value: number, digits = 4) {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function validDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T12:00:00Z`));
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
    const value = calculateAdvisorCollectionOrderValue(
      {
        deliveryDate: order.deliveryDate,
        completedPaymentRegistrationDate,
        paymentValidated: Boolean(completedPaymentRegistrationDate),
      },
      params.asOfDate
    );
    return {
      orderId: order.orderId,
      deliveryDate: order.deliveryDate,
      completedPaymentRegistrationDate,
      paymentValidated: Boolean(completedPaymentRegistrationDate),
      value,
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
