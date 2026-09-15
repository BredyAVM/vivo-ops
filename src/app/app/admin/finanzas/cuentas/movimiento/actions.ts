'use server';

import { revalidatePath } from 'next/cache';
import { requireAdminContext } from '@/lib/auth';
import { createCashOperation } from '@/lib/admin-finance/account-operation-reads';
import {isDefinitiveTransferRejection} from '@/lib/finance/money-transfer-model';
import {parseCashReceipt,validCashOperation,type CashOperationInput,type CashOperationResult} from '@/lib/admin-finance/cash-operation';

export async function createAdminMoneyMovementAction(input:CashOperationInput):Promise<CashOperationResult> {
  const {supabase}=await requireAdminContext();
  if(!validCashOperation(input))return {status:'rejected',message:'Revisa cuenta, motivo e importes con máximo dos decimales.'};
  const {requestId,...payload}=input;
  try {
    const {data,error}=await createCashOperation(supabase,requestId,payload);
    if(error){if(isDefinitiveTransferRejection(error.code))return {status:'rejected',message:error.message};throw error;}
    const receipt=parseCashReceipt(data,input);
    try{revalidatePath('/app','layout');}catch{/* Receipt is authoritative even if refresh fails. */}
    return {status:'confirmed',receipt};
  }catch{return {status:'uncertain',message:'No se pudo comprobar el resultado. Reintenta el mismo envío.'};}
}
