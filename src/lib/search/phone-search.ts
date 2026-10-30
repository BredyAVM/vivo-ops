/** Search-only normalization. Never rewrites a stored phone or an order number. */
export function phoneSearchDigits(value: string | null | undefined): string {
  const raw = String(value ?? '').trim();
  const digits = raw.replace(/[^0-9]/g, '');
  if (raw.startsWith('00')) return digits.slice(2);
  if (raw.startsWith('+')) return digits;
  if (digits.length === 11 && digits.startsWith('0')) return `58${digits.slice(1)}`;
  if (digits.length === 10) return `58${digits}`;
  return digits;
}

export function matchesPhoneSearch(query: string, ...phones: Array<string | null | undefined>): boolean {
  const digits = phoneSearchDigits(query);
  return digits.length >= 4 && phones.some((phone) => phoneSearchDigits(phone).includes(digits));
}
