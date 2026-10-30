import 'server-only';
import {requireAdminContext} from '@/lib/auth';
type Row=Record<string,unknown>;
export async function loadAdminClientProfile(id:number,consult:boolean,readHistory=false){
 const {supabase}=await requireAdminContext();
 if(!Number.isSafeInteger(id)||id<=0)throw new Error('Cliente inválido.');
 const {data:client,error}=await supabase.from('clients').select('id,full_name,phone,client_type,is_active,fund_balance_usd,primary_advisor_id').eq('id',id).maybeSingle();
 if(error)throw new Error(error.message);
 if(!client)return null;
 let classificationHistory:Row[]|null=null;
 if(readHistory){
  const result=await supabase.rpc('read_client_commercial_type_history_v1',{p_client_id:id});
  if(result.error)throw new Error(result.error.message);
  if(!Array.isArray(result.data))throw new Error('No se pudo verificar el historial de clasificación.');
  classificationHistory=result.data as Row[];
 }
 if(!consult)return {client,commercial:null as Row|null,classificationHistory};
 const result=await supabase.rpc('crm_master_client_profile_v1',{p_client_id:id,p_purchase_window:6,p_recent_limit:10});
 if(result.error)throw new Error(result.error.message);
 if(!result.data||typeof result.data!=='object'||Array.isArray(result.data)||Number(result.data.client_id)!==id)throw new Error('La ficha comercial no se pudo verificar.');
 return {client,commercial:result.data as Row,classificationHistory};
}
