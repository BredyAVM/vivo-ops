'use server';
import { requireAdminContext } from '@/lib/auth';
import { resolveReconciliation, undoReconciliation } from '@/lib/admin-finance/account-operation-reads';
import { revalidatePath } from 'next/cache';
import { isDefinitiveTransferRejection } from '@/lib/finance/money-transfer-model';
import { parseReconciliationReceipt, validReconciliationInput, type ReconciliationInput, type ReconciliationResult } from '@/lib/admin-finance/reconciliation';
export async function resolveAdminReconciliation(input: ReconciliationInput): Promise<ReconciliationResult> {
  const { supabase }=await requireAdminContext();
  if (!validReconciliationInput(input)) return {status:'rejected',message:'Revisa el importe y la explicación de la diferencia.'};
  const {requestId,...payload}=input;
  try {
    const {data,error}=await resolveReconciliation(supabase,requestId,payload);
    if (error) {
      if (isDefinitiveTransferRejection(error.code)) return {status:'rejected',message:error.message};
      throw error;
    }
    const receipt=parseReconciliationReceipt(data,input);
    try { revalidatePath('/app','layout'); } catch { /* Saved receipt remains authoritative. */ }
    return {status:'confirmed',receipt};
  } catch { return {status:'uncertain',message:'No se pudo comprobar el resultado. Reintenta el mismo envío.'}; }
}
export async function undoAdminReconciliation(requestId: string,reason: string) {
  const {supabase}=await requireAdminContext();
  const {error}=await undoReconciliation(supabase,requestId,reason);
  if(error) throw new Error(error.message);
  revalidatePath('/app','layout');
}
