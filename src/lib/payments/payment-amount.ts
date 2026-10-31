/** Accept ungrouped money only; never guess thousands or silently round inputs. */
export function parsePaymentAmount(raw: string): number | null {
  const value = raw.trim();
  if (!/^\d+(?:[.,]\d{1,2})?$/.test(value)) return null;
  const amount = Number(value.replace(',', '.'));
  if (!Number.isFinite(amount) || amount <= 0 || !Number.isSafeInteger(Math.round(amount * 100))) return null;
  return amount;
}
