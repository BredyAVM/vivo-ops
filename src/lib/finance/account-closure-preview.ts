import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { validClosureCut } from './account-closure-model';

// Both panels use the same database projection that the atomic command
// recalculates when saving. No API pagination or second browser-side formula.
export async function loadAccountClosurePreview(supabase: SupabaseClient, input: {
  moneyAccountId: number; closureDate: string; closureTime?: string | null;
}) {
  const cut = { ...input, closureTime: input.closureTime?.trim() || '23:59' };
  if (!validClosureCut(cut)) throw new Error('Indica cuenta, fecha y hora válidas.');
  const closureAt = new Date(`${cut.closureDate}T${cut.closureTime.length === 5 ? cut.closureTime + ':00' : cut.closureTime}-04:00`).toISOString();
  const { data, error } = await supabase.rpc('preview_account_closure_v2', { p_account_id: cut.moneyAccountId, p_at: closureAt });
  if (error) throw new Error(error.message);
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Vista previa incompleta.');
  const amount = (v: unknown) => {
    if ((typeof v !== 'number' && typeof v !== 'string') || !String(v).trim() || !Number.isFinite(Number(v))) throw new Error('Importe incompleto.');
    return Number(v);
  };
  if (Number(data.moneyAccountId) !== cut.moneyAccountId || data.closureDate !== cut.closureDate
    || Date.parse(data.closureAt) !== Date.parse(closureAt) || !['USD', 'VES'].includes(data.currencyCode)) throw new Error('Corte inconsistente.');
  return { moneyAccountId: cut.moneyAccountId, closureDate: cut.closureDate, closureAt,
    expectedAmount: amount(data.expectedAmount), expectedAmountUsd: amount(data.expectedAmountUsd), currencyCode: String(data.currencyCode) };
}
