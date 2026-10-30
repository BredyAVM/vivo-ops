/** Counter accepts an ungrouped amount, never guesses ambiguous thousands/decimals. */
export function parseCounterAmount(raw: string): number | null {
  const value = raw.trim();
  if (!/^\d+(?:[.,]\d{1,2})?$/.test(value)) return null;
  const amount = Number(value.replace(',', '.'));
  if (!Number.isFinite(amount) || amount <= 0 || !Number.isSafeInteger(Math.round(amount * 100))) return null;
  return amount;
}

const amountFormatter = new Intl.NumberFormat('es-VE', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
  useGrouping: true,
});

export function formatCounterAmount(amount: number, currency: 'USD' | 'VES') {
  return `${currency === 'VES' ? 'Bs' : 'USD'} ${amountFormatter.format(amount)}`;
}

export const COUNTER_AMOUNT_HINT = 'Escribe sin separadores de miles y con máximo 2 decimales. Ejemplo: 2300,50.';
