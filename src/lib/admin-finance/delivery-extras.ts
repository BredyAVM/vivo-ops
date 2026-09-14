import { validDeliveryDate } from './delivery-model.ts';
import { deliveryPaymentBatch, type DeliveryService } from './delivery-services.ts';

export type DeliveryExtra = {
  id: string; responsibleKey: string; responsible: string; date: string; concept: string; amount: number;
  paymentId: string | null; voided: boolean; voidReason: string | null; fingerprint: string;
};
export type DeliveryPayee = { key: string; name: string };
export type DeliveryExtraInput = { responsibleKey: string; date: string; concept: string; amount: number };
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const payeeKey = /^(internal:[a-f0-9-]{36}|external:[1-9][0-9]*)$/i;
export function parseDeliveryExtras(value: unknown, from: string, to: string): { rows: DeliveryExtra[]; payees: DeliveryPayee[] } {
  const data = value as { version?: unknown; from?: unknown; to?: unknown; rows?: unknown; payees?: unknown } | null;
  if (!data || data.version !== 1 || data.from !== from || data.to !== to || !Array.isArray(data.rows)
    || data.rows.length > 5000 || !Array.isArray(data.payees)) throw new Error('Consulta de servicios adicionales incompleta.');
  const rows = data.rows.map((r: DeliveryExtra) => {
    if (!r || !uuid.test(r.id) || !payeeKey.test(r.responsibleKey) || typeof r.responsible !== 'string' || !r.responsible
      || !validDeliveryDate(r.date) || r.date < from || r.date > to || typeof r.concept !== 'string' || r.concept.trim().length < 3
      || typeof r.amount !== 'number' || !Number.isFinite(r.amount) || r.amount <= 0 || r.amount > 999999999.99
      || Math.abs(Math.round(r.amount * 100) / 100 - r.amount) > 0.000001 || typeof r.voided !== 'boolean'
      || (r.paymentId !== null && !uuid.test(r.paymentId)) || (r.voided && r.paymentId !== null)
      || !/^[a-f0-9]{32}$/.test(r.fingerprint)) throw new Error('Servicio adicional inválido.');
    return r;
  });
  const payees = data.payees.map((p: DeliveryPayee) => {
    if (!p || !payeeKey.test(p.key) || typeof p.name !== 'string' || !p.name) throw new Error('Responsable inválido.');
    return { key: p.key, name: p.name };
  });
  if (new Set(rows.map(r => r.id)).size !== rows.length || new Set(payees.map(p => p.key)).size !== payees.length)
    throw new Error('Consulta de servicios adicionales duplicada.');
  return { rows, payees };
}
export const extraPayable = (r: DeliveryExtra) => !r.voided && !r.paymentId;
export const extraTotal = (rows: DeliveryExtra[]) => rows.reduce((sum, r) => sum + Math.round(r.amount * 100), 0) / 100;
export function deliveryCombinedBatch(rows: DeliveryService[], extras: DeliveryExtra[], responsible: string, selectedIds?: number[], selectedExtraIds?: string[]) {
  const orderBatch = deliveryPaymentBatch(rows, responsible, selectedIds);
  const payable = extras.filter(r => r.responsibleKey === responsible && extraPayable(r));
  const chosen = selectedExtraIds === undefined ? payable : payable.filter(r => selectedExtraIds.includes(r.id));
  const total = (Math.round(orderBatch.total * 100) + Math.round(extraTotal(chosen) * 100)) / 100;
  // Extras-only is valid; never hide a missing order cost or invalid order selection.
  let error = orderBatch.error;
  if (responsible && !orderBatch.rows.length && (!selectedIds || selectedIds.length === 0) && chosen.length) error = '';
  if (error === 'Estas entregas no tienen un importe positivo que pagar.' && total > 0 && chosen.length) error = '';
  if (selectedExtraIds && (new Set(selectedExtraIds).size !== selectedExtraIds.length || chosen.length !== selectedExtraIds.length))
    error = 'La selección contiene servicios pagados, anulados o de otro responsable.';
  if (orderBatch.rows.length + chosen.length > 500) error = 'Selecciona un máximo de 500 entregas y servicios por pago.';
  return { ...orderBatch, extras: chosen, total, error };
}
export function deliveryExtrasCsv(rows: DeliveryExtra[]) {
  const cell = (v: unknown) => {
    const s = String(v ?? '');
    return `"${(/^[=+\-@\t\r\n]/.test(s) ? "'" + s : s).replaceAll('"', '""')}"`;
  };
  return '\uFEFF' + [['Fecha', 'Responsable', 'Servicio adicional', 'Monto USD', 'Estado'],
    ...rows.map(r => [r.date, r.responsible, r.concept, r.amount.toFixed(2), r.voided ? 'Anulado' : r.paymentId ? 'Pagado' : 'Pendiente'])]
    .map(line => line.map(cell).join(';')).join('\r\n');
}
