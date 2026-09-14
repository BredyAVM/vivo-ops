import { deliveryFilters, validDeliveryDate } from './delivery-model.ts';
import { addDateKeyDays, getCaracasDateKey } from './period.ts';

export type DeliveryWeek = { from: string; to: string };

export function deliveryWeekContaining(dateKey: string): DeliveryWeek {
  if (!validDeliveryDate(dateKey)) throw new Error('Selecciona una fecha válida.');
  const day = new Date(`${dateKey}T12:00:00Z`).getUTCDay();
  const from = addDateKeyDays(dateKey, -(day === 0 ? 6 : day - 1));
  return { from, to: addDateKeyDays(from, 6) };
}

export function deliveryWeekShortcuts(today: string, from: string, to: string) {
  const current = deliveryWeekContaining(today);
  const selected = deliveryWeekContaining(from);
  return {
    current,
    lastComplete: deliveryWeekContaining(addDateKeyDays(current.from, -1)),
    previous: deliveryWeekContaining(addDateKeyDays(selected.from, -1)),
    next: deliveryWeekContaining(addDateKeyDays(selected.to, 1)),
    isWeekly: selected.from === from && selected.to === to,
  };
}

export function deliveryServiceFilters(
  values: Record<string, string | string[] | undefined>, now = new Date(),
) {
  const first = (key: string) => (Array.isArray(values[key]) ? values[key][0] : values[key]) ?? '';
  if (first('from') || first('to') || first('period')) return deliveryFilters(values, now);
  const current = deliveryWeekContaining(getCaracasDateKey(now));
  const lastComplete = deliveryWeekContaining(addDateKeyDays(current.from, -1));
  return deliveryFilters({ ...values, ...lastComplete }, now);
}

export function deliveryPeriodHref(period: DeliveryWeek, filters: { mode: string; responsible: string; query: string }) {
  return `/app/admin/finanzas/delivery?${new URLSearchParams({ ...period, mode: filters.mode, responsible: filters.responsible, q: filters.query })}`;
}
