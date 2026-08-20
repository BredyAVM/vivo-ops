import {
  readAdvisorCommissionSettlementSnapshot,
  type AdvisorCommissionSettlementSnapshotState,
} from './closure-snapshot.ts';
import {
  calculateAdvisorCommissionSettlement,
  type AdvisorCommissionSettlementCalculation,
} from './settlement-engine.ts';

export type AdminCommissionAuditSection =
  | 'billing'
  | 'commission'
  | 'deductions'
  | 'debts'
  | 'settlement'
  | 'payments';

export type CommissionAuditOrder = {
  orderId?: number | string | null;
  orderNumber?: string | null;
  clientId?: number | string | null;
  clientName?: string | null;
  deliveryDate?: string | null;
  billedUsd?: number | string | null;
  totalUsd?: number | string | null;
  confirmedPaidUsd?: number | string | null;
  pendingUsd?: number | string | null;
  regularBaseUsd?: number | string | null;
  specialItemBaseUsd?: number | string | null;
  specialOrderBaseUsd?: number | string | null;
  commissionUsd?: number | string | null;
  commissionMode?: string | null;
  paymentStatus?: string | null;
  paymentCompletedDate?: string | null;
  paymentTiming?: 'punctual' | 'late' | 'pending' | null;
};

export type CommissionAuditProduct = {
  orderId?: number | string | null;
  orderNumber?: string | null;
  clientName?: string | null;
  productName?: string | null;
  productType?: string | null;
  qty?: number | string | null;
  lineBaseUsd?: number | string | null;
  commissionMode?: string | null;
  commissionValue?: number | string | null;
};

export type CommissionAuditGift = CommissionAuditProduct & {
  productId?: number | string | null;
  deductionUsd?: number | string | null;
  unitDeductionUsd?: number | string | null;
};

export type CommissionAuditClient = {
  clientId?: number | string | null;
  clientName?: string | null;
  clientType?: string | null;
  orderId?: number | string | null;
  orderNumber?: string | null;
  billedUsd?: number | string | null;
  totalUsd?: number | string | null;
  createdAt?: string | null;
};

export type CommissionAuditDeduction = {
  deduction_type?: string | null;
  amount_usd?: number | string | null;
};

export type CommissionAuditPayment = {
  amount_usd_equivalent?: number | string | null;
};

export type CommissionAuditClosure = {
  billed_usd?: number | string | null;
  gross_commission_usd?: number | string | null;
  gift_deductions_usd?: number | string | null;
  manual_deductions_usd?: number | string | null;
  pending_collection_usd?: number | string | null;
  payable_usd?: number | string | null;
  snapshot?: unknown;
};

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

export function commissionAuditNumber(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function roundCommissionAuditMoney(value: unknown) {
  return Math.round((commissionAuditNumber(value) + Number.EPSILON) * 100) / 100;
}

function arrayValue<T>(value: unknown) {
  return Array.isArray(value) ? (value as T[]) : [];
}

export function getAdminCommissionAuditSection(
  value: string | null | undefined
): AdminCommissionAuditSection {
  const sections: AdminCommissionAuditSection[] = [
    'billing',
    'commission',
    'deductions',
    'debts',
    'settlement',
    'payments',
  ];
  return sections.includes(value as AdminCommissionAuditSection)
    ? (value as AdminCommissionAuditSection)
    : 'settlement';
}

export function adminCommissionAuditHref(
  closureId: number | string,
  section: AdminCommissionAuditSection
) {
  return `/app/commissions/${closureId}?section=${section}#audit-detail`;
}

export function readAdminCommissionAuditSnapshot(snapshot: unknown) {
  const source = record(snapshot);
  const advisor = record(source.advisor);

  return {
    advisorName:
      typeof advisor.name === 'string' && advisor.name.trim()
        ? advisor.name.trim()
        : null,
    orders: arrayValue<CommissionAuditOrder>(source.orders),
    paidOrders: arrayValue<CommissionAuditOrder>(source.paid_orders),
    punctualOrders: arrayValue<CommissionAuditOrder>(source.punctual_orders),
    lateOrders: arrayValue<CommissionAuditOrder>(source.late_orders),
    pendingOrders: arrayValue<CommissionAuditOrder>(source.pending_orders),
    products: arrayValue<CommissionAuditProduct>(source.products),
    gifts: arrayValue<CommissionAuditGift>(source.gifts),
    newClients: arrayValue<CommissionAuditClient>(source.new_clients),
  };
}

export type AdminCommissionAuditCalculation = {
  settlement: AdvisorCommissionSettlementSnapshotState;
  recalculation: AdvisorCommissionSettlementCalculation;
  registeredDirectDeductionsUsd: number;
  directDeductionDifferenceUsd: number;
  normalCommissionUsd: number;
  specialItemsCommissionUsd: number;
  specialOrdersCommissionUsd: number;
  paidUsd: number;
  paymentBalanceUsd: number;
  payableDifferenceUsd: number;
  perOrderBilledUsd: number | null;
  billedDifferenceUsd: number | null;
  perOrderCommissionUsd: number;
  commissionDifferenceUsd: number;
  pendingOrdersUsd: number;
  pendingCollectionDifferenceUsd: number;
  registeredGiftDeductionsUsd: number;
  giftDeductionDifferenceUsd: number;
};

export function buildAdminCommissionAuditCalculation(input: {
  closure: CommissionAuditClosure;
  deductions: CommissionAuditDeduction[];
  payments: CommissionAuditPayment[];
}): AdminCommissionAuditCalculation {
  const snapshot = readAdminCommissionAuditSnapshot(input.closure.snapshot);
  const settlement = readAdvisorCommissionSettlementSnapshot(input.closure.snapshot);
  const registeredDirectDeductionsUsd = roundCommissionAuditMoney(
    input.deductions
      .filter((deduction) => deduction.deduction_type !== 'gift')
      .reduce((sum, deduction) => sum + commissionAuditNumber(deduction.amount_usd), 0)
  );
  const storedDirectDeductionsUsd = roundCommissionAuditMoney(
    input.closure.manual_deductions_usd
  );
  const specialItemsCommissionUsd = roundCommissionAuditMoney(
    snapshot.products
      .filter((product) => product.commissionMode === 'fixed_item')
      .reduce(
        (sum, product) =>
          sum +
          commissionAuditNumber(product.lineBaseUsd) *
            (commissionAuditNumber(product.commissionValue) / 100),
        0
      )
  );
  const specialOrdersCommissionUsd = roundCommissionAuditMoney(
    snapshot.orders
      .filter((order) => order.commissionMode === 'fixed_order')
      .reduce((sum, order) => sum + commissionAuditNumber(order.commissionUsd), 0)
  );
  const grossCommissionUsd = roundCommissionAuditMoney(
    input.closure.gross_commission_usd
  );
  const normalCommissionUsd = Math.max(
    0,
    roundCommissionAuditMoney(
      grossCommissionUsd - specialItemsCommissionUsd - specialOrdersCommissionUsd
    )
  );
  const recalculation = calculateAdvisorCommissionSettlement({
    carriedCommissionUsd: settlement.carriedCommissionUsd,
    priorAdvisorDebtUsd: settlement.priorAdvisorDebtUsd,
    grossCommissionUsd,
    positiveAdjustmentsUsd: settlement.positiveAdjustmentsUsd,
    giftDeductionsUsd: commissionAuditNumber(input.closure.gift_deductions_usd),
    directDeductionsUsd: storedDirectDeductionsUsd,
    negativeAdjustmentsUsd: settlement.negativeAdjustmentsUsd,
    outstandingCustomerDebtUsd: commissionAuditNumber(
      input.closure.pending_collection_usd
    ),
  });
  const paidUsd = roundCommissionAuditMoney(
    input.payments.reduce(
      (sum, payment) =>
        sum + commissionAuditNumber(payment.amount_usd_equivalent),
      0
    )
  );
  const storedPayableUsd = roundCommissionAuditMoney(input.closure.payable_usd);
  const hasPerOrderBilling =
    snapshot.orders.length > 0 &&
    snapshot.orders.every(
      (order) => order.billedUsd !== null && order.billedUsd !== undefined
    );
  const perOrderBilledUsd = hasPerOrderBilling
    ? roundCommissionAuditMoney(
        snapshot.orders.reduce(
          (sum, order) => sum + commissionAuditNumber(order.billedUsd),
          0
        )
      )
    : null;
  const perOrderCommissionUsd = roundCommissionAuditMoney(
    snapshot.orders.reduce(
      (sum, order) => sum + commissionAuditNumber(order.commissionUsd),
      0
    )
  );
  const pendingOrdersUsd = roundCommissionAuditMoney(
    snapshot.pendingOrders.reduce(
      (sum, order) => sum + commissionAuditNumber(order.pendingUsd),
      0
    )
  );
  const registeredGiftDeductionsUsd = roundCommissionAuditMoney(
    snapshot.gifts.reduce(
      (sum, gift) => sum + commissionAuditNumber(gift.deductionUsd),
      0
    )
  );

  return {
    settlement,
    recalculation,
    registeredDirectDeductionsUsd,
    directDeductionDifferenceUsd: roundCommissionAuditMoney(
      storedDirectDeductionsUsd - registeredDirectDeductionsUsd
    ),
    normalCommissionUsd,
    specialItemsCommissionUsd,
    specialOrdersCommissionUsd,
    paidUsd,
    paymentBalanceUsd: roundCommissionAuditMoney(
      Math.max(0, storedPayableUsd - paidUsd)
    ),
    payableDifferenceUsd: roundCommissionAuditMoney(
      storedPayableUsd - recalculation.payableUsd
    ),
    perOrderBilledUsd,
    billedDifferenceUsd:
      perOrderBilledUsd === null
        ? null
        : roundCommissionAuditMoney(
            commissionAuditNumber(input.closure.billed_usd) - perOrderBilledUsd
          ),
    perOrderCommissionUsd,
    commissionDifferenceUsd: roundCommissionAuditMoney(
      grossCommissionUsd - perOrderCommissionUsd
    ),
    pendingOrdersUsd,
    pendingCollectionDifferenceUsd: roundCommissionAuditMoney(
      commissionAuditNumber(input.closure.pending_collection_usd) - pendingOrdersUsd
    ),
    registeredGiftDeductionsUsd,
    giftDeductionDifferenceUsd: roundCommissionAuditMoney(
      commissionAuditNumber(input.closure.gift_deductions_usd) -
        registeredGiftDeductionsUsd
    ),
  };
}
