export function normalizeDecimalInput(value: unknown) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : '';
  }

  const raw = String(value ?? '').trim();
  if (!raw) return '';

  const compact = raw.replace(/\s/g, '');
  if (!/^-?[\d.,]+$/.test(compact)) return '';

  const sign = compact.startsWith('-') ? '-' : '';
  const numeric = compact.replace('-', '');
  if (!/\d/.test(numeric)) return '';

  const decimalIndex = Math.max(numeric.lastIndexOf(','), numeric.lastIndexOf('.'));
  if (decimalIndex < 0) return `${sign}${numeric}`;

  const integerPart = numeric.slice(0, decimalIndex).replace(/[.,]/g, '') || '0';
  const decimalPart = numeric.slice(decimalIndex + 1).replace(/[.,]/g, '');

  return `${sign}${integerPart}.${decimalPart}`;
}

export function parseDecimalInput(value: unknown, fallback = Number.NaN) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : fallback;
  }

  const normalized = normalizeDecimalInput(value);
  if (!normalized) return fallback;

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : fallback;
}
