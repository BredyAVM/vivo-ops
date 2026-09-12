export const AUTHORIZATION_KINDS = ['all', 'expense', 'order', 'reapproval', 'payment'] as const;
export type AuthorizationKind = typeof AUTHORIZATION_KINDS[number];
export const authorizationLabels: Record<AuthorizationKind, string> = {
  all: 'Todas', expense: 'Egresos y movimientos', order: 'Órdenes nuevas', reapproval: 'Modificaciones', payment: 'Pagos reportados',
};
export type AuthorizationRow = {
  kind: Exclude<AuthorizationKind, 'all'>; id: number; orderId: number | null;
  createdAt: string; title: string; entity: string; actorName: string;
  currency: 'USD' | 'VES' | null; amount: number | null; focusDate: string | null;
};
export type AuthorizationQueue = { rows: AuthorizationRow[]; total: number; page: number; counts: Record<string, number> };
export type ExpenseRow = {
  id: number; accountId: number; accountName: string; currency: 'USD' | 'VES'; amount: number;
  amountUsd: number; rate: number | null; type: string; direction: string; status: string; description: string;
  date: string; createdAt: string; creator: string; counterparty: string; reference: string;
  notes: string; approvalReason: string; reviewedAt: string | null; reviewer: string; rejectionReason: string;
};
export type ExpenseReview = { movementId: number; snapshot: string; eligible: boolean; rows: ExpenseRow[] };

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Respuesta de autorización inválida.');
  return value as Record<string, unknown>;
}
function numeric(value: unknown, integer = false): number {
  if ((typeof value !== 'number' && typeof value !== 'string') || value === '') throw new Error('Importe no disponible.');
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || (integer && !Number.isSafeInteger(n))) throw new Error('Número inválido.');
  return n;
}
function id(value: unknown) { const n = numeric(value, true); if (!n) throw new Error('Identificador inválido.'); return n; }
function text(value: unknown) { return typeof value === 'string' ? value : ''; }
function currency(value: unknown): 'USD' | 'VES' {
  if (value !== 'USD' && value !== 'VES') throw new Error('Moneda no admitida.');
  return value;
}
function timestamp(value: unknown) {
  const s = text(value); if (!s || !Number.isFinite(Date.parse(s))) throw new Error('Fecha no disponible.'); return s;
}
export function parseAuthorizationQueue(value: unknown): AuthorizationQueue {
  const data = object(value); if (!Array.isArray(data.rows)) throw new Error('Listado de autorizaciones no disponible.');
  const counts = object(data.counts);
  return { total: numeric(data.total, true), page: id(data.page),
    counts: Object.fromEntries(AUTHORIZATION_KINDS.slice(1).map(k => [k, numeric(counts[k] ?? 0, true)])),
    rows: data.rows.map(value => {
      const r = object(value);
      if (!AUTHORIZATION_KINDS.slice(1).includes(r.kind as Exclude<AuthorizationKind, 'all'>)) throw new Error('Autorización no reconocida.');
      return { kind: r.kind as AuthorizationRow['kind'], id: id(r.id), orderId: r.order_id === null ? null : id(r.order_id),
        createdAt: timestamp(r.created_at), title: text(r.title) || 'Revisar movimiento', entity: text(r.entity) || 'Sin nombre registrado',
        actorName: text(r.actor_name) || 'Usuario no disponible', currency: r.currency === null ? null : currency(r.currency),
        amount: r.amount === null ? null : numeric(r.amount), focusDate: /^\d{4}-\d{2}-\d{2}$/.test(text(r.focus_date)) ? text(r.focus_date) : null };
    }) };
}
export function parseExpenseReview(value: unknown): ExpenseReview {
  const d = object(value);
  if (!/^[a-f0-9]{32}$/.test(text(d.snapshot)) || typeof d.eligible !== 'boolean' || !Array.isArray(d.rows) || !d.rows.length) throw new Error('Revisión de egreso incompleta.');
  const rows = d.rows.map(value => { const r = object(value); return {
    id: id(r.id), accountId: id(r.money_account_id), accountName: text(r.account_name), currency: currency(r.currency_code),
    amount: numeric(r.amount), amountUsd: numeric(r.amount_usd_equivalent), rate: r.exchange_rate_ves_per_usd === null ? null : numeric(r.exchange_rate_ves_per_usd),
    type: text(r.movement_type), direction: text(r.direction), status: text(r.status), description: text(r.description), date: text(r.movement_date),
    createdAt: timestamp(r.created_at), creator: text(r.creator_name) || 'Usuario no disponible', counterparty: text(r.counterparty_name),
    reference: text(r.reference_code), notes: text(r.notes), approvalReason: text(r.approval_required_reason),
    reviewedAt: r.reviewed_at === null ? null : timestamp(r.reviewed_at), reviewer: text(r.reviewer_name) || 'Usuario no disponible', rejectionReason: text(r.rejection_reason),
  }; });
  const movementId = id(d.movementId);
  if (!rows.some(r => r.id === movementId) || new Set(rows.map(r => r.id)).size !== rows.length) throw new Error('Movimientos inconsistentes.');
  return { movementId, snapshot: text(d.snapshot), eligible: d.eligible, rows };
}
export function authorizationHref(row: AuthorizationRow) {
  if (row.kind === 'expense') return `/app/admin/autorizaciones/egresos/${row.id}`;
  if (row.kind === 'order' || row.kind === 'reapproval') return `/app/admin/autorizaciones/ordenes/${row.orderId ?? row.id}`;
  const p = new URLSearchParams({ openOrder: String(row.orderId ?? row.id), returnTo: '/app/admin/autorizaciones',
    ...(row.focusDate ? { focusDate: row.focusDate } : {}), ...(row.kind === 'payment' ? { tab: 'pagos' } : {}) });
  return `/app/master/ops?${p}`;
}
export type ExpenseDecisionResult = { status: 'decided'; decision: 'approve' | 'reject'; movementIds: number[]; reviewedAt: string }
  | { status: 'stale' | 'error' | 'uncertain'; message: string };
export function parseExpenseDecision(value: unknown, movementId: number, decision: 'approve' | 'reject'): ExpenseDecisionResult {
  const d = object(value);
  if (d.status === 'stale') return { status: 'stale', message: 'El movimiento cambió o ya fue resuelto. Actualiza la revisión antes de decidir.' };
  if (d.status !== 'decided' || d.decision !== decision || !Array.isArray(d.movementIds)) throw new Error('Comprobante no disponible.');
  const ids = d.movementIds.map(id);
  if (!ids.includes(movementId) || ids.length > 2 || new Set(ids).size !== ids.length) throw new Error('Comprobante inconsistente.');
  return { status: 'decided', decision, movementIds: ids, reviewedAt: timestamp(d.reviewedAt) };
}
