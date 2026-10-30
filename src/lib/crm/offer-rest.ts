export type OfferRestMode = 'none' | 'days' | 'dates' | 'previous_month';

export type OfferRestInput = {
  offerRestMode?: OfferRestMode;
  offerRestDays?: number | null;
  offerRestFrom?: string;
  offerRestTo?: string;
};

export function readOfferRestMode(rules: Record<string, unknown>): OfferRestMode {
  const mode = rules.offer_rest_mode;
  return mode === 'none' || mode === 'days' || mode === 'dates' ? mode : 'previous_month';
}

function strictDate(value: unknown): string {
  const date = String(value ?? '');
  if (!/^[1-9]\d{3}-\d{2}-\d{2}$/.test(date)) throw new Error('Selecciona las fechas desde y hasta del descanso.');
  const parsed = new Date(`${date}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new Error('Una fecha del descanso no es válida.');
  }
  return date;
}

export function offerRestRules(input: OfferRestInput) {
  const mode = input.offerRestMode ?? 'previous_month'; // Older callers retain the existing policy.
  if (!['none', 'days', 'dates', 'previous_month'].includes(mode)) throw new Error('Selecciona un tipo válido de descanso.');
  let days: number | null = null;
  let from = '';
  let to = '';
  if (mode === 'days') {
    days = input.offerRestDays ?? null;
    if (days == null || !Number.isInteger(days) || days < 1 || days > 3650) {
      throw new Error('El descanso debe ser de 1 a 3650 días enteros.');
    }
  }
  if (mode === 'dates') {
    from = strictDate(input.offerRestFrom);
    to = strictDate(input.offerRestTo);
    if (to < from) throw new Error('La fecha hasta del descanso no puede ser anterior a la fecha desde.');
  }
  return { offer_rest_mode: mode, offer_rest_days: days, offer_rest_from: from, offer_rest_to: to };
}

export function offerRestLabel(rules: Record<string, unknown>, startsAt: string | null): string | null {
  const mode = readOfferRestMode(rules);
  if (mode === 'none') return null;
  if (mode === 'days') return `Sin propuesta de jugada en los ${Number(rules.offer_rest_days)} días anteriores al inicio`;
  if (mode === 'dates') {
    const display = (value: unknown) => String(value ?? '').split('-').reverse().join('/');
    return `Sin propuesta de jugada del ${display(rules.offer_rest_from)} al ${display(rules.offer_rest_to)}`;
  }
  // Do not claim the October policy applied to earlier frozen snapshots.
  return startsAt && new Date(startsAt).getTime() >= new Date('2026-10-01T04:00:00Z').getTime()
    ? 'Sin propuesta de jugada durante el mes anterior' : null;
}
