export const ADMIN_FINANCE_TIME_ZONE = 'America/Caracas';

export const ADMIN_FINANCE_PERIOD_KEYS = ['today', 'week', 'month'] as const;

export type AdminFinancePeriodKey = (typeof ADMIN_FINANCE_PERIOD_KEYS)[number];

export type AdminFinancePeriod = {
  key: AdminFinancePeriodKey;
  label: string;
  startKey: string;
  endExclusiveKey: string;
  fullEndExclusiveKey: string;
  previousStartKey: string;
  previousEndExclusiveKey: string;
  asOf: string;
};

const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ADMIN_FINANCE_SNAPSHOT_MAX_AGE_MS = 15 * 60 * 1000;
const ADMIN_FINANCE_SNAPSHOT_FUTURE_TOLERANCE_MS = 60 * 1000;

function partsForCaracas(value: Date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: ADMIN_FINANCE_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(value);

  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? '';
  return {
    year: Number(part('year')),
    month: Number(part('month')),
    day: Number(part('day')),
  };
}

function utcDateFromKey(key: string) {
  if (!DATE_KEY_PATTERN.test(key)) throw new Error(`Fecha invalida: ${key}`);
  const [year, month, day] = key.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day, 12));
}

function dateKeyFromUtcDate(value: Date) {
  return value.toISOString().slice(0, 10);
}

export function addDateKeyDays(key: string, days: number) {
  const value = utcDateFromKey(key);
  value.setUTCDate(value.getUTCDate() + days);
  return dateKeyFromUtcDate(value);
}

function monthStartKey(year: number, month: number) {
  return dateKeyFromUtcDate(new Date(Date.UTC(year, month - 1, 1, 12)));
}

function daysBetween(startKey: string, endExclusiveKey: string) {
  return Math.round((utcDateFromKey(endExclusiveKey).getTime() - utcDateFromKey(startKey).getTime()) / 86_400_000);
}

export function getCaracasDateKey(value: Date = new Date()) {
  const { year, month, day } = partsForCaracas(value);
  return `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-${day
    .toString()
    .padStart(2, '0')}`;
}

export function normalizeAdminFinancePeriod(value: unknown): AdminFinancePeriodKey {
  return ADMIN_FINANCE_PERIOD_KEYS.includes(value as AdminFinancePeriodKey)
    ? (value as AdminFinancePeriodKey)
    : 'today';
}

export function parseAdminFinanceAsOf(value: unknown, reference: Date = new Date()) {
  if (typeof value !== 'string' || value.length > 64 || value.trim() === '') return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || Number.isNaN(reference.getTime())) return undefined;

  const ageMs = reference.getTime() - parsed.getTime();
  if (
    ageMs > ADMIN_FINANCE_SNAPSHOT_MAX_AGE_MS ||
    ageMs < -ADMIN_FINANCE_SNAPSHOT_FUTURE_TOLERANCE_MS
  ) {
    return undefined;
  }

  return parsed;
}

export function buildAdminFinancePeriod(
  key: AdminFinancePeriodKey,
  asOf: Date = new Date()
): AdminFinancePeriod {
  const todayKey = getCaracasDateKey(asOf);
  const today = utcDateFromKey(todayKey);
  const endExclusiveKey = addDateKeyDays(todayKey, 1);

  if (key === 'today') {
    return {
      key,
      label: 'Hoy',
      startKey: todayKey,
      endExclusiveKey,
      fullEndExclusiveKey: endExclusiveKey,
      previousStartKey: addDateKeyDays(todayKey, -1),
      previousEndExclusiveKey: todayKey,
      asOf: asOf.toISOString(),
    };
  }

  if (key === 'week') {
    const dayOfWeek = today.getUTCDay();
    const daysSinceMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    const startKey = addDateKeyDays(todayKey, -daysSinceMonday);
    const elapsedDays = daysBetween(startKey, endExclusiveKey);
    const previousStartKey = addDateKeyDays(startKey, -7);

    return {
      key,
      label: 'Semana',
      startKey,
      endExclusiveKey,
      fullEndExclusiveKey: addDateKeyDays(startKey, 7),
      previousStartKey,
      previousEndExclusiveKey: addDateKeyDays(previousStartKey, elapsedDays),
      asOf: asOf.toISOString(),
    };
  }

  const { year, month } = partsForCaracas(asOf);
  const startKey = monthStartKey(year, month);
  const fullEndExclusiveKey = month === 12 ? monthStartKey(year + 1, 1) : monthStartKey(year, month + 1);
  const previousStartKey = month === 1 ? monthStartKey(year - 1, 12) : monthStartKey(year, month - 1);
  const elapsedDays = daysBetween(startKey, endExclusiveKey);
  const uncappedPreviousEnd = addDateKeyDays(previousStartKey, elapsedDays);
  const previousEndKey = uncappedPreviousEnd > startKey ? startKey : uncappedPreviousEnd;

  return {
    key,
    label: 'Mes',
    startKey,
    endExclusiveKey,
    fullEndExclusiveKey,
    previousStartKey,
    previousEndExclusiveKey: previousEndKey,
    asOf: asOf.toISOString(),
  };
}

export function listDateKeys(startKey: string, endExclusiveKey: string) {
  const result: string[] = [];
  for (let key = startKey; key < endExclusiveKey; key = addDateKeyDays(key, 1)) {
    result.push(key);
  }
  return result;
}

export function caracasDateKeyToUtcIso(key: string) {
  if (!DATE_KEY_PATTERN.test(key)) throw new Error(`Fecha invalida: ${key}`);
  return `${key}T04:00:00.000Z`;
}
