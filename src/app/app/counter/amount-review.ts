export { parsePaymentAmount as parseCounterAmount } from '../../../lib/payments/payment-amount.ts';

const amountFormatter = new Intl.NumberFormat('es-VE', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
  useGrouping: true,
});

export function formatCounterAmount(amount: number, currency: 'USD' | 'VES') {
  return `${currency === 'VES' ? 'Bs' : 'USD'} ${amountFormatter.format(amount)}`;
}

export const COUNTER_AMOUNT_HINT = 'Escribe sin separadores de miles y con máximo 2 decimales. Ejemplo: 2300,50.';
