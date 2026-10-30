export type AccountMovementDetail = {
  id: number;
  accountId: number;
  groupId: string | null;
  orderId: number | null;
  paymentReportId: number | null;
  date: string;
  status: 'pending' | 'confirmed' | 'rejected' | 'voided';
  direction: 'inflow' | 'outflow';
  type: string;
  currency: 'USD' | 'VES';
  amount: number;
  usd: number | null;
  rate: number | null;
  reference: string | null;
  counterparty: string | null;
  description: string | null;
  notes: string | null;
  voidReason: string | null;
};

export function positiveMovementId(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !/^\d+$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function nullableText(value: unknown) {
  return typeof value === 'string' && value ? value : null;
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' && typeof value !== 'string') throw new Error('Importe no verificable.');
  if (value === '') throw new Error('Importe no verificable.');
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error('Importe no verificable.');
  return number;
}

export function parseAccountMovement(value: unknown): AccountMovementDetail {
  if (!value || typeof value !== 'object') throw new Error('Movimiento no verificable.');
  const row = value as Record<string, unknown>;
  const id = positiveMovementId(row.id);
  const accountId = positiveMovementId(row.money_account_id);
  const amount = nullableNumber(row.amount);
  const groupId = nullableText(row.movement_group_id);
  const status = row.status;
  const direction = row.direction;
  const currency = row.currency_code;
  const orderId = row.order_id == null ? null : positiveMovementId(row.order_id);
  const paymentReportId = row.payment_report_id == null ? null : positiveMovementId(row.payment_report_id);
  if (!id || !accountId || amount === null || amount < 0
    || (row.movement_group_id != null && typeof row.movement_group_id !== 'string')
    || (groupId && !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(groupId))
    || !['pending', 'confirmed', 'rejected', 'voided'].includes(String(status))
    || (direction !== 'inflow' && direction !== 'outflow')
    || (currency !== 'USD' && currency !== 'VES')
    || typeof row.movement_date !== 'string' || !row.movement_date
    || typeof row.movement_type !== 'string' || !row.movement_type
    || (row.order_id != null && !orderId) || (row.payment_report_id != null && !paymentReportId)) {
    throw new Error('Movimiento no verificable. Actualiza la consulta.');
  }
  return {
    id, accountId, groupId, orderId, paymentReportId, amount, direction, currency,
    status: status as AccountMovementDetail['status'], date: row.movement_date, type: row.movement_type,
    usd: nullableNumber(row.amount_usd_equivalent), rate: nullableNumber(row.exchange_rate_ves_per_usd),
    reference: nullableText(row.reference_code), counterparty: nullableText(row.counterparty_name),
    description: nullableText(row.description), notes: nullableText(row.notes), voidReason: nullableText(row.void_reason),
  };
}

export function movementVoidBlock(rows: AccountMovementDetail[]): string | null {
  if (!rows.length) return 'No se pudo verificar la operación completa.';
  if (rows.every(row => row.status === 'voided')) return 'Esta operación ya está anulada.';
  if (rows.some(row => row.status !== 'confirmed' && row.status !== 'pending')) {
    return 'La operación contiene movimientos anulados o rechazados. Revisa su historial.';
  }
  if (rows.some(row => /^closure-\d+$/.test(row.reference ?? ''))) {
    return 'Corresponde a un cierre. Su anulación se realiza desde la pestaña Cierres de la cuenta.';
  }
  return null;
}

export function movementSnapshot(rows: AccountMovementDetail[]): string {
  return JSON.stringify([...rows].sort((a, b) => a.id - b.id));
}

export function movementReturnHref(accountId: number, requested?: string): string {
  const base = `/app/admin/finanzas/cuentas/${accountId}`;
  if (!requested || requested.length > 1000 || !requested.startsWith(`${base}?`)) return base;
  try {
    const url = new URL(requested, 'https://vivo.invalid');
    if (url.origin !== 'https://vivo.invalid' || url.pathname !== base || url.hash) return base;
    const params = new URLSearchParams();
    for (const key of ['vista', 'desde', 'hasta', 'estado', 'page']) {
      const value = url.searchParams.get(key);
      if (value && value.length <= 32) params.set(key, value);
    }
    return params.size ? `${base}?${params}` : base;
  } catch { return base; }
}
