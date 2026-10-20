/** Parse a completed nonnegative price, without normalizing the text being edited. */
export function parseOrderPriceDraft(text: string): number | null {
  const value = text.trim();
  if (!/^(?:\d+(?:[.,]\d+)?|[.,]\d+)$/.test(value)) return null;
  const amount = Number(value.replace(',', '.'));
  return Number.isFinite(amount) ? amount : null;
}
