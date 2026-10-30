import type { SupabaseClient } from '@supabase/supabase-js';

export type MoneyAccountBalanceSnapshot = {
  moneyAccountId: number; currencyCode: 'USD' | 'VES'; balanceNative: number; balanceUsd: number;
  anchorKind: 'closure' | 'baseline' | 'none'; anchorDate: string | null; anchorAt: string | null;
  anchorAmount: number; calculatedAt: string;
};

// Session/RLS-aware bridge: Master and Admin read the same canonical projection.
export async function loadMoneyAccountBalanceSnapshots(
  supabase: SupabaseClient, options: { moneyAccountIds?: number[] } = {}
): Promise<MoneyAccountBalanceSnapshot[]> {
  const ids = options.moneyAccountIds;
  if (ids?.some(id => !Number.isSafeInteger(id) || id <= 0)) throw new Error('Cuenta inválida.');
  if (ids?.length === 0) return [];
  const { data, error } = await supabase.rpc('account_balance_snapshots_v2', { p_account_ids: ids ? [...new Set(ids)] : null });
  if (error) throw new Error(error.message);
  if (!Array.isArray(data)) throw new Error('Saldos no disponibles.');
  const amount = (v: unknown) => {
    if ((typeof v !== 'number' && typeof v !== 'string') || !String(v).trim() || !Number.isFinite(Number(v))) throw new Error('Saldo incompleto.');
    return Number(v);
  };
  return data.map(row => {
    if (!row || !Number.isSafeInteger(Number(row.moneyAccountId)) || Number(row.moneyAccountId) < 1
      || !['USD', 'VES'].includes(row.currencyCode) || !['closure', 'baseline', 'none'].includes(row.anchorKind)
      || !Number.isFinite(Date.parse(row.calculatedAt))) throw new Error('Saldo inconsistente.');
    return { ...row, moneyAccountId: Number(row.moneyAccountId), balanceNative: amount(row.balanceNative),
      balanceUsd: amount(row.balanceUsd), anchorAmount: amount(row.anchorAmount) } as MoneyAccountBalanceSnapshot;
  });
}
