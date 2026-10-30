export type AccountClosureInput = {
  requestId: string; moneyAccountId: number; closureDate: string; closureTime: string;
  countedAmount: number; exchangeRateVesPerUsd: number | null; reason: string; notes: string;
};
export type AccountClosureReceipt = {
  closureId: number; reconciliationItemId: number | null; expectedAmount: number;
  expectedAmountUsd: number; differenceAmount: number; replayed: boolean;
};
export type AccountClosureResult = { status: 'confirmed'; receipt: AccountClosureReceipt }
  | { status: 'rejected' | 'uncertain'; message: string };
export function validClosureCut(input: Pick<AccountClosureInput, 'moneyAccountId' | 'closureDate' | 'closureTime'>) {
  return Number.isSafeInteger(input?.moneyAccountId) && input.moneyAccountId > 0
    && /^\d{4}-\d{2}-\d{2}$/.test(input.closureDate) && Number.isFinite(Date.parse(`${input.closureDate}T00:00:00Z`))
    && new Date(`${input.closureDate}T00:00:00Z`).toISOString().slice(0, 10) === input.closureDate
    && /^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$/.test(input.closureTime);
}
export function validClosureInput(input: AccountClosureInput) {
  return validClosureCut(input) && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.requestId)
    && Number.isFinite(input.countedAmount) && input.countedAmount >= 0 && input.countedAmount <= 1e9
    && Math.abs(input.countedAmount * 100 - Math.round(input.countedAmount * 100)) < 0.00001
    && (input.exchangeRateVesPerUsd === null || (Number.isFinite(input.exchangeRateVesPerUsd) && input.exchangeRateVesPerUsd > 0))
    && typeof input.reason === 'string' && input.reason.length <= 500 && typeof input.notes === 'string' && input.notes.length <= 2000;
}
export function readClosureReceipt(value: unknown, input: AccountClosureInput): AccountClosureReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Comprobante incompleto.');
  const r = value as Record<string, unknown>;
  const num = (v: unknown) => { if ((typeof v !== 'number' && typeof v !== 'string') || !String(v).trim() || !Number.isFinite(Number(v))) throw new Error('Importe incompleto.'); return Number(v); };
  const id = (v: unknown) => { const n = num(v); if (!Number.isSafeInteger(n) || n < 1) throw new Error('Identificador inválido.'); return n; };
  const expected = num(r.expectedAmount), difference = num(r.differenceAmount);
  if (typeof r.replayed !== 'boolean' || Math.abs(input.countedAmount - expected - difference) > 0.011) throw new Error('Comprobante inconsistente.');
  return { closureId: id(r.closureId), reconciliationItemId: r.reconciliationItemId === null ? null : id(r.reconciliationItemId),
    expectedAmount: expected, expectedAmountUsd: num(r.expectedAmountUsd), differenceAmount: difference, replayed: r.replayed };
}
