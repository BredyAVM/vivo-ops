import { getCaracasDateKey } from './period.ts';
import { formatOrderDisplayNumber } from '../orders/order-labels.ts';
import type { PaymentConfirmationInput } from '../domain/payment-confirmation-command.ts';

export type PaymentReviewReport = {
  id: number; order_id: number; status: string; created_at: string;
  operation_date: string | null; reported_money_account_id: number;
  reported_currency_code: string; reported_amount: number | string;
  reported_exchange_rate_ves_per_usd: number | string | null;
  reference_code: string | null; payer_name: string | null; notes: string | null;
  review_notes: string | null;
  confirmed_movement_id?: number | null;
};
export type PaymentVoidPreview = {
  accountId: number; movementId: number; fingerprint: string;
  accountName: string; amount: number; currency: 'USD' | 'VES';
  reference: string | null; date: string; blocked: string | null;
  movements: Array<{ id: number; accountName: string; amount: number;
    currency: 'USD' | 'VES'; direction: 'inflow' | 'outflow';
    type: string; orderId: number | null }>;
};
export type PaymentReviewContext = {
  report: PaymentReviewReport;
  pendingUsd: number | null;
  accountName: string;
  voidPreview?: PaymentVoidPreview | null;
  voidUnavailable?: string | null;
};
export type PaymentReviewDecision = {
  reportId: number; orderId: number; reportSnapshot: string;
} & ({ decision: 'reject'; reason: string } | {
  decision: 'confirm'; date: string; rate: number | null;
  handling: 'store_fund' | 'close_difference' | null;
});

export function validatePaymentReviewIdentity(reportId: number, orderId: number) {
  if (![reportId, orderId].every(id => Number.isSafeInteger(id) && id > 0))
    throw new Error('No se pudo identificar el reporte de pago.');
}
export function paymentReviewDate(report: PaymentReviewReport) {
  return report.operation_date ?? getCaracasDateKey(new Date(report.created_at));
}
export function paymentReviewSnapshot(report: PaymentReviewReport) {
  return JSON.stringify([report.id, report.order_id, report.status,
    report.reported_money_account_id, report.reported_currency_code,
    String(report.reported_amount), report.reported_exchange_rate_ves_per_usd == null
      ? null : String(report.reported_exchange_rate_ves_per_usd),
    report.operation_date, report.reference_code, report.payer_name, report.notes,
    report.confirmed_movement_id ?? null]);
}
export function paymentReviewConfirmation(report: PaymentReviewReport,
  input: Extract<PaymentReviewDecision, { decision: 'confirm' }>,
  account: { name: string; currency_code: string; is_active: boolean },
): PaymentConfirmationInput {
  if (!account.is_active || account.currency_code !== report.reported_currency_code)
    throw new Error('La cuenta del reporte está inactiva o su moneda no coincide. Revisa la cuenta antes de confirmar.');
  const amount = Number(report.reported_amount);
  if (!Number.isFinite(amount) || amount <= 0 || !['USD', 'VES'].includes(report.reported_currency_code))
    throw new Error('El reporte no tiene un monto o moneda válido.');
  const date = new Date(`${input.date}T12:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== input.date)
    throw new Error('Indica una fecha de operación válida.');
  if (report.reported_currency_code === 'VES' && (typeof input.rate !== 'number' || !Number.isFinite(input.rate) || input.rate <= 0))
    throw new Error('Indica la tasa del pago en bolívares.');
  if (input.handling !== null && !['store_fund', 'close_difference'].includes(input.handling))
    throw new Error('Selecciona una opción válida para el excedente.');
  const retentionText = `${account.name} ${report.notes ?? ''}`.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  return {
    reportId: report.id, orderId: report.order_id,
    confirmedMoneyAccountId: report.reported_money_account_id,
    confirmedCurrency: report.reported_currency_code, confirmedAmount: amount,
    movementDate: input.date,
    confirmedExchangeRateVesPerUsd: report.reported_currency_code === 'VES' ? input.rate : null,
    reviewNotes: 'Confirmado desde Pagos de clientes.',
    referenceCode: report.reference_code, counterpartyName: report.payer_name,
    description: `Pago de cliente · orden #${formatOrderDisplayNumber(report.order_id)}`,
    paymentKind: retentionText.includes('retencion') ? 'retention' : null,
    overpaymentHandling: input.handling, changeLines: [],
    overrideOperationDate: true, requireExplicitHandling: true, requireExactChange: true,
  };
}
