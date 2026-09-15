export type ReconciliationInput = {
  requestId: string; itemId: number; mode: 'note_only' | 'existing' | 'income' | 'expense' | 'fee' | 'adjustment';
  amount: number; note: string; fingerprint: string; movementId?: number | null; movementFingerprint?: string | null;
  movementDate?: string | null; rate?: number | null; reference?: string; evidenceConfirmed?: boolean;
};
export type ReconciliationReceipt = { requestId: string; itemId: number; accountId: number; amount: number; currency: 'USD' | 'VES'; remaining: number; residualItemId: number | null; movementId: number | null; movementCreated: boolean; replayed: boolean; voided?: boolean };
export type ReconciliationResult = { status: 'confirmed'; receipt: ReconciliationReceipt } | { status: 'rejected' | 'uncertain'; message: string };
export type ReconciliationDetail = {
  item: { id: number; money_account_id: number; amount: number; currency_code: 'USD' | 'VES'; direction: 'surplus' | 'shortage'; description: string; operation_date: string | null; status: 'open' | 'resolved' | 'voided'; resolution_notes: string | null; source_kind: string; source_id: number | null };
  fingerprint: string; coveredAt: string | null;
  candidates: Array<{ id: number; movement_date: string; amount: number; available: number; fingerprint: string; reference_code: string | null; description: string | null; counterparty_name: string | null; order_id: number | null }>;
  history: Array<{ request_id: string; mode: string; amount: number; created_at: string; created_by_user_id: string; actor_name?:string|null; void_actor_name?:string|null; money_movement_id: number | null; movement_created: boolean; voided_at: string | null; void_reason: string | null; result: ReconciliationReceipt }>;
};
export const reconciliationModes = { note_only: 'Explicar sin movimiento', existing: 'Vincular movimiento existente', income: 'Registrar ingreso faltante', expense: 'Registrar egreso faltante', fee: 'Registrar comisión bancaria', adjustment: 'Registrar ajuste formal' } as const;
export function validReconciliationInput(input: ReconciliationInput) {
  return /^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/i.test(input.requestId) && Number.isSafeInteger(input.itemId) && input.itemId>0
    && Object.hasOwn(reconciliationModes,input.mode) && Number.isFinite(input.amount) && input.amount>0 && input.amount<=1e12
    && Math.abs(input.amount*100-Math.round(input.amount*100))<0.00001 && /^[\da-f]{32}$/i.test(input.fingerprint)
    && typeof input.note==='string' && input.note.trim().length>=6 && input.note.length<=2000;
}
export function parseReconciliationDetail(value: unknown): ReconciliationDetail | null {
  if (value===null) return null;
  if (!value || typeof value!=='object') throw new Error('Respuesta de conciliación inválida.');
  const data=value as ReconciliationDetail;
  if (!data.item || !Number.isSafeInteger(data.item.id) || !Number.isFinite(data.item.amount) || !['USD','VES'].includes(data.item.currency_code)
    || !['open','resolved','voided'].includes(data.item.status) || !/^[\da-f]{32}$/i.test(data.fingerprint) || !Array.isArray(data.candidates) || !Array.isArray(data.history)) throw new Error('Respuesta de conciliación incompleta.');
  for (const row of data.candidates) if (!Number.isSafeInteger(row.id) || !Number.isFinite(row.amount) || !Number.isFinite(row.available) || !/^[\da-f]{32}$/i.test(row.fingerprint)) throw new Error('Movimiento de conciliación inválido.');
  return data;
}
export function parseReconciliationReceipt(value: unknown,input: ReconciliationInput): ReconciliationReceipt {
  const row=value as ReconciliationReceipt;
  if (!row || row.requestId!==input.requestId || row.itemId!==input.itemId || row.amount!==input.amount || !Number.isFinite(row.remaining) || row.remaining<0
    || !['USD','VES'].includes(row.currency) || typeof row.replayed!=='boolean' || typeof row.movementCreated!=='boolean') throw new Error('Comprobante no verificable.');
  return row;
}
