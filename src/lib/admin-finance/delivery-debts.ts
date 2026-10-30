import { validDeliveryDate } from './delivery-model.ts';

export type DeliveryDebt = {
  id: string; responsibleKey: string; responsible: string; date: string;
  kind: 'loan' | 'other' | 'order'; concept: string; original: number; balance: number; balancePrecise: number; deducted: number;
  orderId: number | null; client: string | null; voided: boolean; voidReason: string | null; fingerprint: string;
  history: { paymentId: string; amount: number; reversed: boolean }[];
};
export type DeliveryDebtInput = {
  responsibleKey: string; date: string; kind: DeliveryDebt['kind']; concept: string; amount: number;
  orderId: number | null; clientId: number | null; confirmed: boolean;
};
export type DeliveryDeduction = { id: string; fingerprint: string; amount: number };
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const money = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0
  && n <= 999999999.99 && Math.abs(Math.round(n * 100) - n * 100) < 0.00001;
export function parseDeliveryDebts(value: unknown, to: string): DeliveryDebt[] {
  const data = value as { version?: unknown; to?: unknown; rows?: unknown } | null;
  if (!data || data.version !== 1 || data.to !== to || !Array.isArray(data.rows) || data.rows.length > 5000)
    throw new Error('Consulta de deudas incompleta.');
  const rows = data.rows.map((d: DeliveryDebt) => {
    if (!d || !uuid.test(d.id) || !/^(internal:[a-f0-9-]{36}|external:[1-9][0-9]*)$/i.test(d.responsibleKey)
      || typeof d.responsible !== 'string' || typeof d.concept !== 'string' || !validDeliveryDate(d.date) || d.date > to
      || !['loan', 'other', 'order'].includes(d.kind) || !money(d.original) || d.original <= 0 || !money(d.balance) || !money(d.deducted)
      || typeof d.balancePrecise !== 'number' || !Number.isFinite(d.balancePrecise) || d.balancePrecise < 0 || Math.round(d.balancePrecise * 100) !== Math.round(d.balance * 100)
      || typeof d.voided !== 'boolean' || !/^[a-f0-9]{32}$/.test(d.fingerprint)
      || (d.kind === 'order' ? !Number.isSafeInteger(d.orderId) || Number(d.orderId) <= 0 : d.orderId !== null)
      || !Array.isArray(d.history) || d.history.some(h => !uuid.test(h.paymentId) || !money(h.amount) || h.amount <= 0 || typeof h.reversed !== 'boolean'))
      throw new Error('Deuda de delivery inválida.');
    return d;
  });
  if (new Set(rows.map(d => d.id)).size !== rows.length) throw new Error('Deudas duplicadas.');
  return rows;
}
export function deliveryDeductionPlan(debts: DeliveryDebt[], chosen: Record<string, string>, gross: number) {
  const deductions: DeliveryDeduction[] = [];
  let cents = 0;
  let error = '';
  for (const [id, value] of Object.entries(chosen)) {
    const amount = value.trim() === '' ? 0 : Number(value);
    const d = debts.find(row => row.id === id);
    if (!money(amount) || !d || d.voided || amount > d.balance) { error = 'Revisa los descuentos: no pueden superar la deuda ni tener más de dos decimales.'; break; }
    if (amount > 0) { deductions.push({ id, fingerprint: d.fingerprint, amount }); cents += Math.round(amount * 100); }
  }
  if (deductions.length > 100) error = 'Selecciona un máximo de 100 deudas por liquidación.';
  if (cents > Math.round(gross * 100)) error = 'Los descuentos superan lo ganado. Reduce el importe para conservar el resto de la deuda.';
  const remainingCents = debts.filter(d => !d.voided).reduce((sum, d) => {
    const amount = deductions.find(x => x.id === d.id)?.amount ?? 0;
    const remainder = d.balancePrecise - amount;
    // Same subcent boundary as the server's canonical collection allocation.
    return sum + (amount > 0 && remainder < 0.01 - 1e-10 ? 0 : Math.max(0, Math.round((d.balancePrecise - amount) * 100)));
  }, 0);
  return { deductions, discount: cents / 100, net: Math.max(0, Math.round(gross * 100) - cents) / 100,
    remaining: remainingCents / 100, error };
}
