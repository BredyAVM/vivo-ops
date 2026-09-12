import 'server-only';
import { requireAdminContext } from '@/lib/auth';
import { readClosureReceipt, validClosureInput, type AccountClosureInput, type AccountClosureResult } from './account-closure-model';
export async function executeAdminAccountClosure(input: AccountClosureInput): Promise<AccountClosureResult> {
  const { supabase } = await requireAdminContext();
  if (!validClosureInput(input)) return { status: 'rejected', message: 'Revisa la cuenta, fecha, hora, monto contado y tasa.' };
  const { requestId, ...command } = input;
  try {
    // Preserve verification of an existing committed attempt even if account
    // policy subsequently changes. The canonical command validates its owner
    // and exact original payload before replaying the receipt.
    const prior = await supabase.from('account_closure_operations').select('request_id').eq('request_id', requestId).maybeSingle();
    if (prior.error) throw new Error('No se pudo verificar el intento anterior.');
    if (!prior.data) {
      const [account, profile] = await Promise.all([
        supabase.from('money_accounts').select('account_kind,is_active').eq('id', input.moneyAccountId).maybeSingle(),
        supabase.from('money_account_closure_profiles').select('closure_kind').eq('money_account_id', input.moneyAccountId).maybeSingle(),
      ]);
      if (account.error || profile.error) throw new Error('No se pudo verificar la regla de cierre.');
      if (!account.data?.is_active) return { status: 'rejected', message: 'La cuenta no está disponible para un cierre nuevo.' };
      if (![account.data.account_kind, profile.data?.closure_kind].some(k => k === 'cash' || k === 'pos')) {
        return { status: 'rejected', message: 'La conciliación diaria está en revisión: debemos unificar el corte por hora o por día antes de habilitarla aquí. No se registró un cierre nuevo.' };
      }
    }
    const { data, error } = await supabase.rpc('create_account_closure_v1', { p_request_id: requestId, p_input: command });
    if (error) {
      if (/^(22|23)|^42501$|^P0001$/.test(error.code ?? '')) return { status: 'rejected', message: error.message };
      throw new Error('Resultado no confirmado.');
    }
    return { status: 'confirmed', receipt: readClosureReceipt(data, input) };
  } catch { return { status: 'uncertain', message: 'No se pudo comprobar el resultado. Reintenta el mismo envío, sin cambiar los datos.' }; }
}
