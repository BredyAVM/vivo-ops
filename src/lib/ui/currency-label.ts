/** Presentation only: never changes amounts, precision or conversion rules. */
export function currencyLabel(currency: string | null | undefined): string {
  if (currency === 'VES') return 'Bs';
  if (currency === 'USD') return 'USD';
  return currency?.trim() || 'selecciona cuenta';
}
