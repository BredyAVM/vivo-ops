import 'server-only';
import { requireAdminContext } from '@/lib/auth';
import { readClosureReceipt, validClosureInput, type AccountClosureInput, type AccountClosureResult } from './account-closure-model';
export async function executeAdminAccountClosure(input: AccountClosureInput): Promise<AccountClosureResult> {
  const { supabase } = await requireAdminContext();
  if (!validClosureInput(input)) return { status: 'rejected', message: 'Revisa la cuenta, fecha, hora, monto contado y tasa.' };
  const { requestId, ...command } = input;
  try {
    const { data, error } = await supabase.rpc('create_account_closure_v1', { p_request_id: requestId, p_input: command });
    if (error) {
      if (/^(22|23)|^42501$|^P0001$/.test(error.code ?? '')) return { status: 'rejected', message: error.message };
      throw new Error('Resultado no confirmado.');
    }
    return { status: 'confirmed', receipt: readClosureReceipt(data, input) };
  } catch { return { status: 'uncertain', message: 'No se pudo comprobar el resultado. Reintenta el mismo envío, sin cambiar los datos.' }; }
}
