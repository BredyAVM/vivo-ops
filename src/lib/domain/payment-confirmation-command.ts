export type PaymentConfirmationInput = {
  reportId: number;
  orderId?: number | null;
  clientId?: number | null;
  confirmedMoneyAccountId: number;
  confirmedCurrency: string;
  confirmedAmount: number;
  movementDate: string;
  confirmedExchangeRateVesPerUsd: number | null;
  reviewNotes: string;
  referenceCode: string | null;
  counterpartyName: string | null;
  description: string | null;
  paymentKind?: 'retention' | null;
  overpaymentHandling?: 'change_given' | 'store_fund' | 'close_difference' | null;
  overpaymentNotes?: string | null;
  changeLines?: Array<{
    moneyAccountId: number;
    currencyCode: string;
    amount: number;
    exchangeRateVesPerUsd?: number | null;
    notes?: string | null;
  }>;
  changeMoneyAccountId?: number | null;
  changeCurrency?: string | null;
  changeAmount?: number | null;
  changeExchangeRateVesPerUsd?: number | null;
  overrideOperationDate?: boolean;
  requireExplicitHandling?: boolean;
  requireExactChange?: boolean;
  expectedChangeDebtUsd?: number;
};

const clean = (value: string | null | undefined) => value?.trim() || null;

// Keep the same payload on a network retry. Dates, rates and balances are never
// filled from the current clock here; the transaction resolves them once.
export function buildPaymentConfirmationCommand(input: PaymentConfirmationInput) {
  const currency = input.confirmedCurrency.trim().toUpperCase();
  const changeLines = input.changeLines?.length
    ? input.changeLines
    : input.overpaymentHandling === 'change_given'
      ? [{ moneyAccountId: input.changeMoneyAccountId ?? 0,
          currencyCode: input.changeCurrency ?? '', amount: input.changeAmount ?? null,
          exchangeRateVesPerUsd: input.changeExchangeRateVesPerUsd ?? null,
          notes: input.overpaymentNotes ?? null }]
      : [];
  return {
    reportId: input.reportId, orderId: input.orderId ?? null, clientId: input.clientId ?? null,
    accountId: input.confirmedMoneyAccountId, currency, amount: input.confirmedAmount,
    rate: currency === 'VES' ? input.confirmedExchangeRateVesPerUsd : null,
    date: clean(input.movementDate), reviewNotes: clean(input.reviewNotes),
    reference: clean(input.referenceCode), counterparty: clean(input.counterpartyName),
    description: clean(input.description), paymentKind: input.paymentKind ?? null,
    handling: input.overpaymentHandling ?? null, notes: clean(input.overpaymentNotes),
    overrideOperationDate: input.overrideOperationDate === true,
    requireExplicitHandling: input.requireExplicitHandling === true,
    requireExactChange: input.requireExactChange === true,
    ...(input.expectedChangeDebtUsd === undefined ? {} : { expectedChangeDebtUsd: input.expectedChangeDebtUsd }),
    changeLines: changeLines.map(line => {
      const code = line.currencyCode.trim().toUpperCase();
      return { accountId: line.moneyAccountId, currency: code, amount: line.amount,
        rate: code === 'VES' ? line.exchangeRateVesPerUsd ?? null : null,
        notes: clean(line.notes) ?? clean(input.overpaymentNotes) };
    }),
  };
}

export function readPaymentConfirmationReceipt(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('No se pudo verificar el comprobante del pago.');
  const row = value as Record<string, unknown>;
  const orderId = Number(row.orderId), eventId = Number(row.eventId), movementId = Number(row.movementId);
  if (![orderId, eventId, movementId].every(id => Number.isSafeInteger(id) && id > 0)
    || !row.payload || typeof row.payload !== 'object' || Array.isArray(row.payload)) {
    throw new Error('No se pudo verificar el comprobante del pago.');
  }
  return { orderId, eventId, movementId, payload: row.payload as Record<string, unknown>, replayed: row.replayed === true };
}
