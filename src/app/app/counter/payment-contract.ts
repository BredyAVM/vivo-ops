export type CounterPaymentLineInput = {
  lineKey: string;
  moneyAccountId: number;
  paymentMethod: string;
  currencyCode: 'USD' | 'VES';
  amount: number;
  exchangeRateVesPerUsd: number | null;
  operationDate: string;
  referenceCode: string | null;
  bankName: string | null;
  payerName: string | null;
  notes: string | null;
};

export type CounterChangeLineInput = {
  lineKey: string;
  changeMode: 'cash' | 'digital_pending';
  moneyAccountId: number | null;
  paymentMethod: string | null;
  currencyCode: 'USD' | 'VES';
  amount: number;
  exchangeRateVesPerUsd: number | null;
  notes: string | null;
};

export type CounterPaymentIntent = {
  idempotencyKey: string;
  orderId: number;
  paymentLines: CounterPaymentLineInput[];
  overpaymentHandling: 'store_fund' | 'change_given' | null;
  changeLines: CounterChangeLineInput[];
  notes: string | null;
};

export type CounterPaymentOperationResult = {
  ok: true;
  idempotencyKey: string;
  orderId: number;
  reportCount: number;
  confirmedReportCount: number;
  pendingReportCount: number;
  confirmedPaymentUsd: number;
  pendingPaymentUsd: number;
  cashChangeUsd: number;
  digitalChangePendingUsd: number;
  fundCreditUsd: number;
  pendingUsd: number;
  overpaidUsd: number;
};

export type CounterGiveChangeIntent = {
  idempotencyKey: string;
  orderId: number;
  moneyAccountId: number;
  amount: number;
  operationDate: string;
  notes: string | null;
};

export type CounterGiveChangeResult = {
  ok: true;
  idempotencyKey: string;
  orderId: number;
  movementId: number;
  moneyAccountId: number;
  accountName: string;
  currencyCode: 'USD' | 'VES';
  amount: number;
  exchangeRateVesPerUsd: number | null;
  amountUsdEquivalent: number;
  remainingChangeUsd: number;
};

export type CounterRefundLineInput = {
  lineKey: string;
  moneyAccountId: number;
  currencyCode: 'USD' | 'VES';
  amount: number;
  exchangeRateVesPerUsd: number | null;
  referenceCode: string | null;
  notes: string | null;
};

export type CounterRefundRequestIntent = {
  idempotencyKey: string;
  orderId: number;
  refundLines: CounterRefundLineInput[];
  reason: string;
};

export type CounterRefundRequestResult = {
  ok: true;
  idempotencyKey: string;
  movementGroupId: string;
  status: 'pending';
  amountUsdEquivalent: number;
};

export type CounterRefundExecutionIntent = {
  idempotencyKey: string;
  refundGroupId: string;
  operationDate: string;
  notes: string | null;
};

export type CounterRefundExecutionResult = {
  ok: true;
  idempotencyKey: string;
  movementGroupId: string;
  status: 'executed';
  amountUsdEquivalent: number;
};

export type CounterRefundAuthorization = {
  movementGroupId: string;
  status: 'pending' | 'approved' | 'rejected' | 'executed';
  amountUsdEquivalent: number;
  createdAt: string;
  reviewedAt: string | null;
  lines: Array<{
    movementId: number;
    moneyAccountId: number;
    accountName: string;
    currencyCode: 'USD' | 'VES';
    amount: number;
    amountUsdEquivalent: number;
  }>;
};
