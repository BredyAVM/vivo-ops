import { readStoredDeliveryCost } from '../domain/delivery-cost.ts';
import { validDeliveryDate } from './delivery-model.ts';

export type DeliveryService = {
  id: number; orderNumber: string; client: string; date: string;
  mode: 'internal' | 'external' | 'unassigned'; responsibleKey: string; responsible: string;
  cost: { stored: number | null; proposed: number | null; fingerprint: string; reason: string | null };
  payment: { id: string; movementId: number; amountUsd: number; date: string; status: string } | null;
  legacyPaid: boolean;
};
export function parseDeliveryServices(value: unknown, from: string, to: string): DeliveryService[] {
  if (!value || typeof value !== 'object') throw new Error('Consulta de delivery inválida.');
  const data = value as Record<string, unknown>;
  if (data.version !== 1 || data.from !== from || data.to !== to || !Array.isArray(data.rows) || data.rows.length > 5000)
    throw new Error('Consulta de delivery incompleta.');
  const rows = data.rows.map(raw => {
    const row = raw as DeliveryService;
    if (!row || !Number.isSafeInteger(row.id) || row.id <= 0 || !validDeliveryDate(row.date) || row.date < from || row.date > to
      || !['internal', 'external', 'unassigned'].includes(row.mode) || !row.responsibleKey || !row.responsible
      || typeof row.client !== 'string' || typeof row.orderNumber !== 'string' || typeof row.legacyPaid !== 'boolean'
      || !row.cost || !/^[a-f0-9]{32}$/.test(row.cost.fingerprint)) throw new Error('Entrega inválida.');
    for (const amount of [row.cost.stored, row.cost.proposed]) {
      if (amount !== null && (typeof amount !== 'number' || readStoredDeliveryCost(amount) === null)) throw new Error('Costo inválido.');
    }
    if (row.payment !== null && (!row.payment || !row.payment.id || !Number.isSafeInteger(row.payment.movementId)
      || !validDeliveryDate(row.payment.date) || readStoredDeliveryCost(row.payment.amountUsd) === null || row.payment.status !== 'confirmed'))
      throw new Error('Pago de delivery inconsistente.');
    return { id: row.id, orderNumber: row.orderNumber, client: row.client, date: row.date, mode: row.mode,
      responsibleKey: row.responsibleKey, responsible: row.responsible, legacyPaid: row.legacyPaid,
      payment: row.payment, cost: { stored: row.cost.stored, proposed: row.cost.proposed, fingerprint: row.cost.fingerprint, reason: row.cost.reason } };
  });
  if (new Set(rows.map(row => row.id)).size !== rows.length) throw new Error('Entregas duplicadas.');
  return rows;
}
export const serviceAmount = (row: DeliveryService) => row.payment?.amountUsd ?? row.cost.stored ?? row.cost.proposed;
export const servicePayable = (row: DeliveryService) => !row.payment && !row.legacyPaid && row.mode !== 'unassigned' && serviceAmount(row) !== null;
export function deliveryServiceTotals(rows: DeliveryService[]) {
  const cents = (n: number) => Math.round(n * 100);
  return {
    deliveries: rows.length,
    amount: rows.reduce((n, row) => n + cents(serviceAmount(row) ?? 0), 0) / 100,
    paid: rows.reduce((n, row) => n + cents(row.payment?.amountUsd ?? 0), 0) / 100,
    unlinked: rows.filter(row => !row.payment && !row.legacyPaid).reduce((n, row) => n + cents(serviceAmount(row) ?? 0), 0) / 100,
    missing: rows.filter(row => serviceAmount(row) === null).length,
    proposed: rows.filter(row => !row.payment && row.cost.stored === null && row.cost.proposed !== null).length,
  };
}
export function deliveryServicesCsv(rows: DeliveryService[]) {
  const cell = (value: unknown) => {
    const text = String(value ?? '');
    return `"${(/^[=+\-@\t\r\n]/.test(text) ? "'" + text : text).replaceAll('"', '""')}"`;
  };
  return '\uFEFF' + [
    ['Fecha', 'Orden', 'Cliente', 'Tipo', 'Responsable', 'Costo USD', 'Origen', 'Pago', 'Egreso'],
    ...rows.map(row => [row.date, row.orderNumber, row.client, row.mode === 'internal' ? 'Interno' : row.mode === 'external' ? 'Externo' : 'Sin asignar', row.responsible,
      serviceAmount(row)?.toFixed(2) ?? '', row.payment ? 'Confirmado al pagar' : row.cost.stored !== null ? 'Guardado' : row.cost.proposed !== null ? 'Tarifa propuesta' : 'Pendiente',
      row.payment ? 'Pago vinculado' : row.legacyPaid ? 'Pago histórico' : 'Sin pago vinculado', row.payment?.movementId ?? '']),
  ].map(line => line.map(cell).join(';')).join('\r\n');
}
