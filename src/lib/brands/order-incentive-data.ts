import 'server-only';
import type {SupabaseClient}from'@supabase/supabase-js';
import {readMuerdemeIncentiveSnapshot}from'./order-incentives';
export async function loadMuerdemeCommissionCandidates(supabase:SupabaseClient,periodId:number,advisorIds:string[]){
 const{data,error}=await supabase.rpc('admin_muerdeme_incentive_candidates_v1',{p_period_id:periodId,p_advisor_ids:advisorIds});
 if(error)throw new Error(error.code==='22023'?error.message:'No se pudieron verificar los estímulos por hamburguesas. No se actualizó el cálculo.');
 if(data?.version!==1||!Array.isArray(data.rows))throw new Error('La consulta de estímulos está incompleta.');
 return readMuerdemeIncentiveSnapshot({muerdeme_incentives:{version:1,totalUsd:data.rows.reduce((s:number,r:{amountUsd:number})=>s+Math.round(r.amountUsd*100),0)/100,rows:data.rows}}).rows;
}
