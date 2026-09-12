import { sanitizeOrderChangeDetails, type OrderChangeDetail } from '../orders/order-change-detail';
export type OrderReviewAction = 'approve' | 'reapprove';
export type OrderReview = {
  id: number; snapshot: string; action: OrderReviewAction | null; status: string;
  client: string; advisor: string; date: string | null; time: string; fulfillment: string;
  address: string; notes: string; totalUsd: number; confirmedUsd: number; fundUsedUsd: number;
  pendingUsd: number; overpaidUsd: number; reportedUsd: number;
  items: { id: number; name: string; qty: number; totalUsd: number; notes: string }[];
  changes: { id: number; title: string; message: string; actor: string; date: string; details: OrderChangeDetail[] }[];
};
function obj(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Revisión incompleta.');
  return value as Record<string, unknown>;
}
function str(value: unknown) { return typeof value === 'string' ? value : ''; }
function num(value: unknown): number {
  if ((typeof value !== 'number' && typeof value !== 'string') || (typeof value === 'string' && !value.trim())) throw new Error('Importe no disponible.');
  const n = Number(value); if (!Number.isFinite(n) || n < 0) throw new Error('Importe inválido.'); return n;
}
function id(value: unknown) { const n = num(value); if (!Number.isSafeInteger(n) || n < 1) throw new Error('Identificador inválido.'); return n; }
export function parseOrderReview(value: unknown): OrderReview {
  const d = obj(value), o = obj(d.order), f = obj(d.financial), extra = obj(o.extra_fields ?? {});
  const schedule = extra.schedule && typeof extra.schedule === 'object' ? obj(extra.schedule) : {};
  if (!/^[a-f0-9]{32}$/.test(str(d.snapshot)) || ![null, 'approve', 'reapprove'].includes(d.action as string | null)
    || !Array.isArray(d.items) || !Array.isArray(d.changes) || id(f.order_id) !== id(o.id)) throw new Error('Revisión inconsistente.');
  const items = d.items.map(v => { const i = obj(v); return { id: id(i.id), name: str(i.product_name_snapshot), qty: num(i.qty), totalUsd: num(i.line_total_usd),
    notes: str(i.notes).split('\n').filter(line => !line.trim().startsWith('@')).join('\n') }; });
  if (new Set(items.map(i => i.id)).size !== items.length) throw new Error('Detalle duplicado.');
  return { id: id(o.id), snapshot: str(d.snapshot), action: d.action as OrderReviewAction | null, status: str(o.status),
    client: str(o.client_name) || 'Sin cliente', advisor: str(o.advisor_name) || 'Sin asesor',
    date: /^\d{4}-\d{2}-\d{2}$/.test(str(schedule.date)) ? str(schedule.date) : null, time: schedule.asap === true ? 'Lo antes posible' : str(schedule.time_24) || str(schedule.time),
    fulfillment: str(o.fulfillment), address: str(o.delivery_address), notes: str(o.notes),
    totalUsd: num(f.total_usd), confirmedUsd: num(f.confirmed_paid_usd), fundUsedUsd: num(f.client_fund_used_usd),
    pendingUsd: num(f.pending_usd), overpaidUsd: num(f.overpaid_usd), reportedUsd: num(f.pending_reports_usd), items,
    changes: d.changes.map(v => { const e = obj(v), p = obj(e.payload ?? {}); return { id: id(e.id), title: str(e.title), message: str(e.message),
      actor: str(e.actor_name) || 'Usuario no disponible', date: str(e.created_at), details: sanitizeOrderChangeDetails(p.change_details) }; }),
  };
}
export type OrderReviewResult = { status: 'approved'; orderId: number; eventId: number }
  | { status: 'stale' | 'error' | 'uncertain'; message: string };
export function parseOrderReviewReceipt(value: unknown, orderId: number, action: OrderReviewAction): OrderReviewResult {
  const d = obj(value);
  if (d.status === 'stale') return { status: 'stale', message: 'La orden cambió o ya fue revisada. Actualiza la revisión antes de aprobar.' };
  if (d.status !== 'approved' || id(d.orderId) !== orderId || d.action !== action) throw new Error('Comprobante inválido.');
  return { status: 'approved', orderId, eventId: id(d.eventId) };
}
