import { addDateKeyDays, buildAdminFinancePeriod, getCaracasDateKey, normalizeAdminFinancePeriod } from './period.ts';

export type DeliveryFilters = { from: string; to: string; mode: 'all' | 'internal' | 'external' | 'unassigned'; q: string; page: number; settlementBefore: string; settlementId: string };
export type DeliveryRow = { id: number; orderNumber: string; clientName: string; deliveredAt: string; mode: Exclude<DeliveryFilters['mode'], 'all'>; responsible: string; costUsd: number | null; costSource: string | null };
export type DeliverySettlementRow = { id: number; orderId: number; orderNumber: string; status: 'open' | 'partial' | 'discrepancy'; responsible: string; dispatchedAt: string };
export type DeliveryOverview = {
  asOf: string; from: string; to: string; mode: DeliveryFilters['mode']; query: string; offset: number;
  summary: { deliveries: number; costed: number; knownCostUsd: number; internal: number; external: number; unassigned: number };
  undatedDeliveries: number; rows: DeliveryRow[]; settlements: DeliverySettlementRow[]; nextSettlementCursor: { dispatchedAt: string; id: number } | null;
};
export function validDeliveryDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
export function deliveryFilters(values: Record<string, string | string[] | undefined>, now = new Date()): DeliveryFilters {
  const first = (key: string) => (Array.isArray(values[key]) ? values[key][0] : values[key]) ?? '';
  const period = buildAdminFinancePeriod(normalizeAdminFinancePeriod(first('period') || 'month'), now);
  const from = first('from') || period.startKey;
  const to = first('to') || addDateKeyDays(period.endExclusiveKey, -1);
  if (!validDeliveryDate(from) || !validDeliveryDate(to) || to < from || to > addDateKeyDays(from, 366)) throw new Error('Selecciona fechas válidas, en un rango máximo de 367 días.');
  const mode = first('mode');
  const page = (value: string) => Math.min(1001, /^\d+$/.test(value) && Number(value) > 0 ? Number(value) : 1);
  const settlementBefore = first('settlementBefore'), settlementId = first('settlementId');
  if ((settlementBefore || settlementId) && (!settlementBefore || !Number.isFinite(Date.parse(settlementBefore)) || !/^[1-9]\d*$/.test(settlementId) || !Number.isSafeInteger(Number(settlementId)))) throw new Error('El cursor de liquidaciones no es válido. Vuelve a abrir Delivery.');
  return { from, to, mode: mode === 'internal' || mode === 'external' || mode === 'unassigned' ? mode : 'all', q: first('q').trim().slice(0, 80), page: page(first('page')), settlementBefore, settlementId };
}
export function deliveryHref(filters: DeliveryFilters, patch: Partial<DeliveryFilters> = {}) {
  const f = { ...filters, ...patch };
  return `/app/admin/finanzas/delivery?${new URLSearchParams({ from: f.from, to: f.to, mode: f.mode, q: f.q, page: String(f.page), settlementBefore: f.settlementBefore, settlementId: f.settlementId })}`;
}
export function deliveryOrderHref(row: DeliveryRow) {
  return `/app/master/ops?${new URLSearchParams({ openOrder: String(row.id), focusDate: getCaracasDateKey(new Date(row.deliveredAt)), tab: 'entrega' })}`;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid delivery object');
  return value as Record<string, unknown>;
}
function number(value: unknown, integer = false) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || (integer && !Number.isSafeInteger(value))) throw new Error('Invalid delivery number');
  return value;
}
function text(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Invalid delivery text');
  return value;
}
function timestamp(value: unknown) {
  const result = text(value);
  if (!Number.isFinite(Date.parse(result))) throw new Error('Invalid delivery time');
  return result;
}
function rows<T>(value: unknown, parse: (row: Record<string, unknown>) => T) {
  if (!Array.isArray(value) || value.length > 30) throw new Error('Invalid delivery page');
  return value.map(row => parse(object(row)));
}
export function parseDeliveryOverview(value: unknown, filters: DeliveryFilters, now = new Date()): DeliveryOverview {
  const data = object(value);
  const asOf = timestamp(data.asOf);
  if (data.definitionVersion !== 'admin-delivery-v1' || data.pageSize !== 30
    || !Number.isFinite(now.getTime()) || Math.abs(Date.parse(asOf) - now.getTime()) > 300000
    || data.from !== filters.from || data.to !== filters.to || data.mode !== filters.mode || data.query !== filters.q
    || data.offset !== (filters.page - 1) * 30) throw new Error('Incompatible delivery contract');
  const s = object(data.summary);
  const summary = { deliveries: number(s.deliveries, true), costed: number(s.costed, true), knownCostUsd: number(s.knownCostUsd), internal: number(s.internal, true), external: number(s.external, true), unassigned: number(s.unassigned, true) };
  if (summary.costed > summary.deliveries || summary.deliveries !== summary.internal + summary.external + summary.unassigned) throw new Error('Inconsistent delivery totals');
  const deliveries = rows<DeliveryRow>(data.rows, row => {
    const mode = row.mode;
    if (mode !== 'internal' && mode !== 'external' && mode !== 'unassigned') throw new Error('Invalid delivery mode');
    const id = number(row.id, true);
    const deliveredAt = timestamp(row.deliveredAt);
    const date = getCaracasDateKey(new Date(deliveredAt));
    if (!id || date < filters.from || date > filters.to || (filters.mode !== 'all' && filters.mode !== mode)) throw new Error('Delivery outside requested scope');
    return { id, orderNumber: text(row.orderNumber), clientName: text(row.clientName), deliveredAt, mode,
      responsible: text(row.responsible), costUsd: row.costUsd === null ? null : number(row.costUsd), costSource: row.costSource === null ? null : text(row.costSource) };
  });
  const pending = object(data.pending);
  const settlements = rows<DeliverySettlementRow>(pending.results, row => {
    if (row.status !== 'open' && row.status !== 'partial' && row.status !== 'discrepancy') throw new Error('Invalid settlement status');
    const id = number(row.id, true), orderId = number(row.orderId, true);
    if (!id || !orderId) throw new Error('Invalid settlement ID');
    return { id, orderId, orderNumber: row.orderNumber == null ? String(orderId) : text(row.orderNumber), status: row.status, responsible: text(row.responsibleName), dispatchedAt: timestamp(row.dispatchedAt) };
  });
  const cursor = pending.nextCursor === null ? null : object(pending.nextCursor);
  const nextSettlementCursor = cursor ? { dispatchedAt: timestamp(cursor.dispatchedAt), id: number(cursor.id, true) } : null;
  if (deliveries.length !== Math.min(30, Math.max(0, summary.deliveries - Number(data.offset)))
    || new Set(deliveries.map(r => r.id)).size !== deliveries.length || new Set(settlements.map(r => r.id)).size !== settlements.length) throw new Error('Incomplete delivery page');
  if (nextSettlementCursor && (settlements.length !== 30 || nextSettlementCursor.id !== settlements.at(-1)?.id || nextSettlementCursor.dispatchedAt !== settlements.at(-1)?.dispatchedAt)) throw new Error('Invalid delivery cursor');
  return { asOf, from: filters.from, to: filters.to, mode: filters.mode, query: filters.q, offset: Number(data.offset), summary, undatedDeliveries: number(data.undatedDeliveries, true), rows: deliveries, settlements, nextSettlementCursor };
}

export function parseDeliverySettlement(value: unknown, expectedId: number) {
  const data = object(value);
  if (number(data.id, true) !== expectedId || !['not_required','open','partial','settled','discrepancy','voided'].includes(String(data.status))) throw new Error('Invalid delivery settlement');
  if (!Array.isArray(data.currencyBreakdown) || !Array.isArray(data.entries) || data.entries.length > 100) throw new Error('Missing delivery settlement detail');
  const currency = (value: unknown): 'USD' | 'VES' => { if (value !== 'USD' && value !== 'VES') throw new Error('Unknown currency'); return value; };
  const currencies = data.currencyBreakdown.map(value => {
    const row = object(value);
    return { currency: currency(row.currencyCode), expectedCollection: number(row.expectedCollection), customerCollection: number(row.customerCollection), cashReturned: number(row.cashReturned), custodyOutstanding: number(row.custodyOutstanding), cashChangeSent: number(row.cashChangeSent), cashChangeReturned: number(row.cashChangeReturned), digitalChangeOutstanding: number(row.digitalChangeOutstanding) };
  });
  if (new Set(currencies.map(row => row.currency)).size !== currencies.length) throw new Error('Duplicate delivery currency');
  const entries = data.entries.map(value => {
    const row = object(value);
    const amount = row.amount;
    if (typeof amount !== 'number' || !Number.isFinite(amount)) throw new Error('Invalid entry amount');
    return { id: number(row.id, true), type: text(row.entryType), currency: currency(row.currencyCode), amount, createdAt: timestamp(row.createdAt), actor: text(row.createdByName), reference: row.referenceCode == null ? '' : text(row.referenceCode), account: row.moneyAccountName == null ? '' : text(row.moneyAccountName) };
  });
  const orderId = number(data.orderId, true);
  if (!orderId || new Set(entries.map(row => row.id)).size !== entries.length) throw new Error('Invalid settlement entities');
  return { id: expectedId, orderId, orderNumber: data.orderNumber == null ? String(orderId) : text(data.orderNumber), status: text(data.status), client: text(data.clientName), responsible: text(data.responsibleName), dispatchedAt: timestamp(data.dispatchedAt), collectionFinalized: data.collectionFinalizedAt != null, currencies, entries };
}
