export const ADVISOR_COMMISSION_PAYMENT_DESCRIPTION_PREFIX =
  'Liquidación de comisión · Cierre ';
export const ADVISOR_COMMISSION_BANK_FEE_DESCRIPTION_PREFIX =
  'Comisión bancaria · ';

export type AdvisorCommissionPaymentCurrency = 'USD' | 'VES';

function roundMoney(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function calculateAdvisorCommissionPaymentOperation(input: {
  amountUsd: number;
  feeAmountNative?: number;
  currencyCode: AdvisorCommissionPaymentCurrency;
  exchangeRateVesPerUsd?: number | null;
}) {
  const amountUsd = Number(input.amountUsd);
  const feeAmountNative = Number(input.feeAmountNative ?? 0);
  const exchangeRate = Number(input.exchangeRateVesPerUsd ?? 0);

  if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
    throw new Error('El abono debe ser mayor a cero.');
  }
  if (!Number.isFinite(feeAmountNative) || feeAmountNative < 0) {
    throw new Error('La comisión bancaria no es válida.');
  }
  if (input.currencyCode !== 'USD' && input.currencyCode !== 'VES') {
    throw new Error('La moneda de la cuenta no es válida.');
  }
  if (input.currencyCode === 'VES' && (!Number.isFinite(exchangeRate) || exchangeRate <= 0)) {
    throw new Error('Indica la tasa usada para el pago en bolívares.');
  }

  const paymentUsd = roundMoney(amountUsd);
  const paymentNativeAmount =
    input.currencyCode === 'VES'
      ? roundMoney(paymentUsd * exchangeRate)
      : paymentUsd;
  const bankFeeNativeAmount = roundMoney(feeAmountNative);
  const bankFeeUsdEquivalent =
    input.currencyCode === 'VES'
      ? roundMoney(bankFeeNativeAmount / exchangeRate)
      : bankFeeNativeAmount;

  return {
    paymentUsd,
    paymentNativeAmount,
    bankFeeNativeAmount,
    bankFeeUsdEquivalent,
    totalNativeAmount: roundMoney(paymentNativeAmount + bankFeeNativeAmount),
    totalUsdOutflow: roundMoney(paymentUsd + bankFeeUsdEquivalent),
  };
}

function cleanLabel(value: string, fallback: string) {
  const clean = value.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  return clean || fallback;
}

export function buildAdvisorCommissionPaymentDescription(input: {
  closureId: number;
  periodName: string;
  advisorName: string;
}) {
  if (!Number.isInteger(input.closureId) || input.closureId <= 0) {
    throw new Error('closureId debe ser un entero positivo.');
  }

  return `${ADVISOR_COMMISSION_PAYMENT_DESCRIPTION_PREFIX}${input.closureId} · ${cleanLabel(
    input.periodName,
    'Periodo'
  )} · ${cleanLabel(input.advisorName, 'Asesor')}`;
}

export function buildAdvisorCommissionBankFeeDescription(paymentDescription: string) {
  return `${ADVISOR_COMMISSION_BANK_FEE_DESCRIPTION_PREFIX}${cleanLabel(
    paymentDescription,
    'Pago de comisión'
  )}`;
}

export function getAdvisorCommissionClosureIdFromPaymentDescription(
  description: unknown
) {
  if (typeof description !== 'string') return null;
  if (!description.startsWith(ADVISOR_COMMISSION_PAYMENT_DESCRIPTION_PREFIX)) return null;
  const remainder = description.slice(
    ADVISOR_COMMISSION_PAYMENT_DESCRIPTION_PREFIX.length
  );
  const id = Number(remainder.split(' · ', 1)[0]);
  return Number.isInteger(id) && id > 0 ? id : null;
}
