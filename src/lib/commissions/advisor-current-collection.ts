import { mergeCommissionLiveOrders, type CommissionLiveCollection } from './live-collections.ts';
import type { AdvisorGoalCollectionOrderDetail } from './goal-collection.ts';

type RecordedOrder = {
  orderId?: number | string | null;
  confirmedPaidUsd?: number | string | null;
  pendingUsd?: number | string | null;
  paymentTiming?: 'punctual' | 'late' | 'pending' | null;
  paymentCompletedDate?: string | null;
};

/** Read-only presentation: current cash never replaces the agreed calculation. */
export function buildAdvisorCurrentCollection<T extends RecordedOrder>(params: {
  closureId: number;
  recordedOrders: T[];
  live?: CommissionLiveCollection;
  error?: string | null;
  timingOrders?: AdvisorGoalCollectionOrderDetail[];
}) {
  const state = !params.error && params.live?.supported && params.live.closureId === params.closureId
    ? params.live
    : undefined;
  const recordedById = new Map(params.recordedOrders.map((order) => [Number(order.orderId), order]));
  const timingById = new Map(params.timingOrders?.map((order) => [order.orderId, order]));
  const collectionOrders = state
    ? mergeCommissionLiveOrders(params.recordedOrders, state.orders).map((order) => {
        const recorded = recordedById.get(order.orderId);
        const timing = timingById.get(order.orderId);
        let paymentTiming: RecordedOrder['paymentTiming'] = null;
        let paymentCompletedDate: string | null = null;
        if (order.pendingUsd > 0) {
          paymentTiming = 'pending';
        } else if (timing) {
          if (timing.pendingUsd <= 0 && timing.completedPaymentRegistrationDate
            && Math.abs(timing.confirmedPaidUsd - order.confirmedPaidUsd) < 0.005) {
            paymentTiming = timing.status === 'punctual_paid' ? 'punctual'
              : timing.status === 'credit_paid' || timing.status === 'overdue_paid' ? 'late' : null;
            paymentCompletedDate = paymentTiming ? timing.completedPaymentRegistrationDate : null;
          }
        } else if (recorded && Number(recorded.pendingUsd) === 0
          && Math.abs(Number(recorded.confirmedPaidUsd) - order.confirmedPaidUsd) < 0.005
          && (recorded.paymentTiming === 'punctual' || recorded.paymentTiming === 'late')) {
          paymentTiming = recorded.paymentTiming;
          paymentCompletedDate = recorded.paymentCompletedDate ?? null;
        }
        // A newly settled invoice is not automatically a punctual payment.
        return { ...order, paymentTiming, paymentCompletedDate };
      })
    : params.recordedOrders;
  return {
    state,
    // Incoming carry orders explain current debt, but are not new sales or commissions.
    orders: collectionOrders.filter((order) => recordedById.has(Number(order.orderId))),
    pendingOrders: collectionOrders.filter((order) => Number(order.pendingUsd) > 0),
    punctualOrders: collectionOrders.filter((order) => Number(order.pendingUsd) === 0 && order.paymentTiming === 'punctual'),
    lateOrders: collectionOrders.filter((order) => Number(order.pendingUsd) === 0 && order.paymentTiming === 'late'),
    unverifiedPaidOrders: collectionOrders.filter((order) => Number(order.pendingUsd) === 0
      && order.paymentTiming !== 'punctual' && order.paymentTiming !== 'late'),
  };
}
