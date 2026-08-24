const MONTH_NAMES = [
  'Enero',
  'Febrero',
  'Marzo',
  'Abril',
  'Mayo',
  'Junio',
  'Julio',
  'Agosto',
  'Septiembre',
  'Octubre',
  'Noviembre',
  'Diciembre',
] as const;

function dateOnly(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`La fecha ${value} no es válida.`);
  const parsed = Date.parse(`${value}T12:00:00Z`);
  if (!Number.isFinite(parsed)) throw new Error(`La fecha ${value} no es válida.`);
  return parsed;
}

function isoDate(year: number, month: number, day: number) {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function advisorGoalPeriodIdentity(periodFrom: string) {
  const parsed = new Date(dateOnly(periodFrom));
  const year = parsed.getUTCFullYear();
  const month = parsed.getUTCMonth() + 1;
  const half = parsed.getUTCDate() <= 15 ? 1 : 2;
  return {
    year,
    month,
    half,
    key: `${year}-${String(month).padStart(2, '0')}-${half}`,
  };
}

export function suggestNextAdvisorGoalPeriod(periodTo: string) {
  const next = new Date(dateOnly(periodTo) + 86_400_000);
  const year = next.getUTCFullYear();
  const month = next.getUTCMonth() + 1;
  const day = next.getUTCDate();
  const half = day <= 15 ? 1 : 2;
  const dateFrom = isoDate(year, month, day);
  const finalDay = half === 1 ? 15 : new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    name: `${MONTH_NAMES[month - 1]} ${String(half).padStart(2, '0')}`,
    dateFrom,
    dateTo: isoDate(year, month, finalDay),
    year,
    month,
    half,
  };
}
