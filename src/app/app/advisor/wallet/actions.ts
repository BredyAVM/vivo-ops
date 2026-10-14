'use server';
import {revalidatePath} from 'next/cache';
import {requireAuthContext} from '@/lib/auth';
import {UUID_PATTERN} from '@/lib/rewards/wallet-model';
export async function applyRewardDebtAction(grantId:number,closureId:number,amount:number,token:string) {
  try{
    const ctx=await requireAuthContext();
    if(![grantId,closureId].every(id=>Number.isSafeInteger(id)&&id>0)||!Number.isFinite(amount)||amount<=0||!UUID_PATTERN.test(token))return {ok:false,message:'Solicitud inválida.'};
    const {error}=await ctx.supabase.rpc('reward_apply_debt_v1',{p_grant:grantId,p_closure:closureId,p_amount:amount,p_token:token});
    if(error)return {ok:false,message:error.message};
    revalidatePath('/app/advisor/wallet');revalidatePath('/app/admin/premios');revalidatePath('/app/commissions');revalidatePath('/app/advisor/commissions');
    return {ok:true,message:'Crédito aplicado una sola vez a tu deuda. No se registró un pago en caja.'};
  }catch(e){return {ok:false,message:e instanceof Error?e.message:'No se pudo aplicar el crédito.'};}
}
