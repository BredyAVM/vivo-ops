import { addDateKeyDays, buildAdminFinancePeriod } from './period.ts';

export const COLLECTIONS_PATH = '/app/admin/finanzas/cobranzas';
export const collectionStatuses = { pending: 'Con saldo pendiente', review: 'Pagos por verificar', paid: 'Sin deuda', all: 'Todas las órdenes', cancelled: 'Canceladas' };
export const collectionSources = { all: 'Todos los canales', advisor: 'Asesores', master: 'Master', walk_in: 'Mostrador' };
export const collectionStages = { all: 'Cualquier estado', created: 'Creada', queued: 'En cola', confirmed: 'Confirmada', in_kitchen: 'En cocina', ready: 'Lista', out_for_delivery: 'En camino', delivered: 'Entregada', cancelled: 'Cancelada' };
export type CollectionFilters = {
  scope: 'period' | 'history';
  from: string; to: string; basis: 'created' | 'delivered';
  status: keyof typeof collectionStatuses; source: keyof typeof collectionSources;
  fulfillment: 'all' | 'pickup' | 'delivery'; person: string;
  personBasis: 'either' | 'creator' | 'advisor'; role: 'all' | 'admin' | 'master' | 'advisor' | 'counter';
  stage: keyof typeof collectionStages; sort: 'pending' | 'oldest' | 'newest'; q: string; page: number;
};
export type CollectionOrder = {
  id: number; clientName: string; clientPhone: string | null;
  creatorId: string | null; creatorName: string; advisorId: string | null; advisorName: string | null;
  createdDate: string; deliveredDate: string | null; source: string; fulfillment: string; stage: string;
  totalUsd: number; coveredUsd: number; pendingUsd: number; reviewUsd: number; reviewCount: number; paymentStatus: string;
};
export type CollectionsOverview = {
  version: 'admin-collections-v1'; asOf: string; page: number; pages: number; pageSize: 30;
  totals: { orders: number; totalUsd: number; coveredUsd: number; pendingUsd: number; reviewUsd: number; reviewCount: number };
  people: { id: string; name: string }[]; orders: CollectionOrder[];
};
type Params = Record<string, string | string[] | undefined>;
const first = (value: Params[string]) => (Array.isArray(value) ? value[0] : value) ?? '';
function choice<T extends string>(value: string, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? value as T : fallback;
}
export function validCollectionDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
export function normalizeCollectionFilters(params: Params): CollectionFilters {
  const scope = choice(first(params.scope), ['period', 'history'], 'period');
  const from = scope === 'history' ? '' : first(params.from), to = scope === 'history' ? '' : first(params.to), person = first(params.person);
  if ((from && !validCollectionDate(from)) || (to && !validCollectionDate(to)) || (from && to && from > to)) {
    throw new Error('Revisa el período: la fecha inicial debe ser anterior o igual a la final.');
  }
  const requestedPage = Number(first(params.page) || 1);
  return {
    scope, from, to, basis: choice(first(params.basis), ['created', 'delivered'], 'created'),
    status: choice(first(params.status), Object.keys(collectionStatuses) as CollectionFilters['status'][], 'pending'),
    source: choice(first(params.source), Object.keys(collectionSources) as CollectionFilters['source'][], 'all'),
    fulfillment: choice(first(params.fulfillment), ['all', 'pickup', 'delivery'], 'all'),
    person: /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(person) ? person : '',
    personBasis: choice(first(params.personBasis), ['either', 'creator', 'advisor'], 'either'),
    role: choice(first(params.role), ['all', 'admin', 'master', 'advisor', 'counter'], 'all'),
    stage: choice(first(params.stage), Object.keys(collectionStages) as CollectionFilters['stage'][], 'all'),
    sort: choice(first(params.sort), ['pending', 'oldest', 'newest'], 'pending'),
    q: first(params.q).trim().slice(0, 80),
    page: Number.isSafeInteger(requestedPage) ? Math.min(100000, Math.max(1, requestedPage)) : 1,
  };
}
export function collectionHref(filters: CollectionFilters, patch: Partial<CollectionFilters> = {}) {
  const merged = { ...filters, ...patch };
  const params = new URLSearchParams();
  params.set('action', 'query');
  for (const [key, value] of Object.entries(merged)) if (value !== '') params.set(key, String(value));
  return `${COLLECTIONS_PATH}?${params}`;
}
export function collectionPeriod(key: 'all' | 'today' | 'week' | 'month', asOf: Date) {
  if (key === 'all') return { from: '', to: '', page: 1 };
  const period = buildAdminFinancePeriod(key, asOf);
  return { from: period.startKey, to: addDateKeyDays(period.endExclusiveKey, -1), page: 1 };
}
export function collectionQueryRequested(params: Params) {
  return first(params.action) === 'query';
}
export function validateCollectionScope(filters: CollectionFilters) {
  if (filters.scope !== 'history' && (!filters.from || !filters.to)) {
    throw new Error('Selecciona desde y hasta antes de consultar.');
  }
}

// Reject incomplete contracts instead of converting missing balances to zero.
export function parseCollectionsOverview(value: unknown, now: Date): CollectionsOverview {
  const obj = (v: unknown): Record<string, unknown> => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('Respuesta de cobranzas incompleta.');
    return v as Record<string, unknown>;
  };
  const str = (v: unknown) => { if (typeof v !== 'string' || !v.trim()) throw new Error('Dato de cobranza inválido.'); return v; };
  const nullable = (v: unknown) => v === null ? null : str(v);
  const num = (v: unknown, integer = false) => {
    if ((typeof v !== 'number' && typeof v !== 'string') || String(v).trim() === '') throw new Error('Importe no disponible.');
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || (integer && !Number.isSafeInteger(n))) throw new Error('Importe inválido.');
    return n;
  };
  const list = (v: unknown) => { if (!Array.isArray(v)) throw new Error('Lista de cobranzas incompleta.'); return v; };
  const date = (v: unknown) => { const s = str(v); if (!validCollectionDate(s)) throw new Error('Fecha inválida.'); return s; };
  const d = obj(value), t = obj(d.totals), asOf = str(d.asOf);
  if (d.version !== 'admin-collections-v1' || d.balanceSource !== 'canonical_order_financial_state'
    || d.cutoffMode !== 'current_statement' || d.pageSize !== 30
    || !Number.isFinite(Date.parse(asOf)) || Math.abs(Date.parse(asOf) - now.getTime()) > 300000) throw new Error('Consulta de cobranzas no vigente.');
  const orders = list(d.orders).map((value): CollectionOrder => {
    const r = obj(value);
    const id = num(r.id, true);
    if (id < 1) throw new Error('Orden inválida.');
    return {
      id, clientName: str(r.clientName), clientPhone: r.clientPhone === '' ? null : nullable(r.clientPhone),
      creatorId: nullable(r.creatorId), creatorName: str(r.creatorName), advisorId: nullable(r.advisorId), advisorName: nullable(r.advisorName),
      createdDate: date(r.createdDate), deliveredDate: r.deliveredDate === null ? null : date(r.deliveredDate),
      source: str(r.source), fulfillment: str(r.fulfillment), stage: str(r.stage), paymentStatus: str(r.paymentStatus),
      totalUsd: num(r.totalUsd), coveredUsd: num(r.coveredUsd), pendingUsd: num(r.pendingUsd), reviewUsd: num(r.reviewUsd), reviewCount: num(r.reviewCount, true),
    };
  });
  const count = num(t.orders, true), page = num(d.page, true), pages = num(d.pages, true);
  if (page < 1 || pages !== Math.max(1, Math.ceil(count / 30)) || page > pages
    || orders.length !== Math.min(30, Math.max(0, count - (page - 1) * 30))
    || new Set(orders.map(o => o.id)).size !== orders.length) throw new Error('Paginación de cobranzas incompleta.');
  return {
    version: 'admin-collections-v1', asOf, page, pages, pageSize: 30,
    totals: { orders: count, totalUsd: num(t.totalUsd), coveredUsd: num(t.coveredUsd), pendingUsd: num(t.pendingUsd), reviewUsd: num(t.reviewUsd), reviewCount: num(t.reviewCount, true) },
    people: list(d.people).map(value => { const p = obj(value); return { id: str(p.id), name: str(p.name) }; }), orders,
  };
}
