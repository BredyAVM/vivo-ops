import 'server-only';
import { requireAdminContext } from '@/lib/auth';
import { isDefinitiveTransferRejection, parseMoneyTransferReceipt, validTransferRequestId,
  type MoneyTransferInput, type MoneyTransferResult } from './money-transfer-model';

export async function executeMoneyTransfer(input: MoneyTransferInput): Promise<MoneyTransferResult> {
  const { supabase } = await requireAdminContext();
  if (!validTransferRequestId(input?.requestId)) return { status: 'rejected', message: 'Actualiza la pantalla antes de registrar el traspaso.' };
  const { requestId, ...command } = input;
  try {
    const { data, error } = await supabase.rpc('create_money_transfer_v1', { p_request_id: requestId, p_input: command });
    if (error) return {
      status: isDefinitiveTransferRejection(error.code) ? 'rejected' : 'uncertain',
      message: isDefinitiveTransferRejection(error.code) ? error.message : 'No se pudo comprobar el resultado. Reintenta este mismo envío para evitar duplicados.',
    };
    const receipt = parseMoneyTransferReceipt(data, input);
    return receipt ? { status: 'confirmed', receipt } : { status: 'uncertain', message: 'No se pudo verificar el comprobante. Reintenta sin cambiar los datos.' };
  } catch {
    return { status: 'uncertain', message: 'Se interrumpió la conexión. Reintenta este mismo envío para comprobar su resultado.' };
  }
}
