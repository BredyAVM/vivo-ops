export type CounterDeliveryCurrency = 'USD' | 'VES';

export type CounterDeliveryPaymentPrescription = {
  paymentMethod: string | null | undefined;
  paymentRequiresChange: boolean;
  balanceUsd: number;
};

export function requiresCounterDeliveryMoneyHandling(
  order: CounterDeliveryPaymentPrescription
) {
  if (order.balanceUsd <= 0.005) return false;
  if (order.paymentRequiresChange) return true;

  const paymentMethod = String(order.paymentMethod || '').trim().toLowerCase();
  return (
    paymentMethod === 'cash_usd' || paymentMethod === 'cash_ves'
  );
}

export type CounterDeliveryValueLine = {
  lineKey: string;
  currencyCode: CounterDeliveryCurrency;
  amount: number;
  exchangeRateVesPerUsd: number | null;
  referenceCode: string | null;
  notes: string | null;
};

export type CounterDeliveryCashLine = CounterDeliveryValueLine & {
  moneyAccountId: number;
  operationDate: string;
};

export type CounterDeliveryDigitalChangeLine = CounterDeliveryValueLine & {
  paymentMethodCode: 'payment_mobile' | 'transfer' | 'zelle' | 'other';
};

export type CounterDeliveryDispatchIntent = {
  idempotencyKey: string;
  orderId: number;
  etaMinutes: number;
  expectedCollectionLines: CounterDeliveryValueLine[];
  cashChangeLines: CounterDeliveryCashLine[];
  digitalChangeLines: CounterDeliveryDigitalChangeLine[];
  notes: string | null;
};

export type CounterDeliveryDispatchResult = {
  ok: true;
  orderId: number;
  orderStatus: 'out_for_delivery';
  deliverySettlementId: number;
  settlementStatus:
    | 'not_required'
    | 'open'
    | 'partial'
    | 'settled'
    | 'discrepancy';
  etaMinutes: number;
  expectedCollectionUsd: number;
  cashChangeUsd: number;
  digitalChangeUsd: number;
  requiredChangeUsd: number;
};

export type CounterDeliveryReturnIntent = {
  idempotencyKey: string;
  orderId: number;
  customerCollectionLines: CounterDeliveryValueLine[];
  cashReturnLines: CounterDeliveryCashLine[];
  collectionFinal: boolean;
  notes: string | null;
};

export type CounterDeliveryReturnResult = {
  ok: true;
  orderId: number;
  deliverySettlementId: number;
  settlementStatus:
    | 'not_required'
    | 'open'
    | 'partial'
    | 'settled'
    | 'discrepancy';
  collectionFinal: boolean;
};

export type CounterDeliverySettlementEntry = {
  id: number;
  entryType:
    | 'expected_collection'
    | 'customer_collection'
    | 'cash_return'
    | 'cash_change_out'
    | 'cash_change_returned'
    | 'digital_change_due'
    | 'digital_change_completed'
    | 'custody_adjustment';
  sourceLineKey: string | null;
  currencyCode: CounterDeliveryCurrency;
  amount: number;
  amountUsdEquivalent: number;
  moneyAccountId: number | null;
  moneyAccountName: string | null;
  operationDate: string | null;
  referenceCode: string | null;
  notes: string | null;
  createdByName: string;
  createdAt: string;
};

export type CounterDeliveryCurrencyBreakdown = {
  currencyCode: CounterDeliveryCurrency;
  expectedCollection: number;
  customerCollection: number;
  cashReturned: number;
  custodyOutstanding: number;
  cashChangeSent: number;
  cashChangeReturned: number;
  digitalChangeDue: number;
  digitalChangeCompleted: number;
  digitalChangeOutstanding: number;
};

export type CounterDeliverySettlementDetail = {
  id: number;
  orderId: number;
  displayNumber: string;
  orderNumber: string | null;
  orderStatus: string;
  status:
    | 'not_required'
    | 'open'
    | 'partial'
    | 'settled'
    | 'discrepancy'
    | 'voided';
  clientName: string;
  clientPhone: string | null;
  advisorName: string | null;
  responsibleName: string;
  responsiblePhone: string | null;
  deliveryMode: 'internal' | 'external';
  etaMinutes: number | null;
  dispatchedAt: string;
  collectionFinalizedAt: string | null;
  settledAt: string | null;
  notes: string | null;
  version: number;
  paymentStatus: string;
  orderPendingUsd: number;
  currencyBreakdown: CounterDeliveryCurrencyBreakdown[];
  entries: CounterDeliverySettlementEntry[];
};
