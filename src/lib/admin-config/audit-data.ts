import 'server-only';
import {requireAdminContext} from '@/lib/auth';
import {validCollectionDate} from '@/lib/admin-finance/collections-model';
import {addDateKeyDays} from '@/lib/admin-finance/period';
import { requireAtomicConfiguration } from './capabilities';
type Row=Record<string,unknown>;
export async function loadAdminAdjustmentAudit(params:Record<string,string|undefined>){
 const {supabase}=await requireAdminContext();
 const page=Math.max(1,Math.min(10000,Math.trunc(Number(params.page)||1)));
 if(params.consultar!=='1')return {rows:[] as Row[],actors:[] as Row[],hasNext:false,page,queried:false};
 if(params.kind==='configuration'){
  await requireAtomicConfiguration();
  const result=await supabase.rpc('admin_configuration_history_v1',{p_page:page,p_command:null});
  if(result.error)throw new Error('No se pudo consultar el registro de configuración.');
  if(!Array.isArray(result.data))throw new Error('Historial no verificable.');
  return {rows:result.data.slice(0,25) as Row[],actors:[] as Row[],hasNext:result.data.length>25,page,queried:true};
 }
 if(!params.from||!params.to||!validCollectionDate(params.from)||!validCollectionDate(params.to)||params.from>params.to)throw new Error('Selecciona desde y hasta.');
 let q=supabase.from('order_admin_adjustments').select('id,order_id,order_item_id,adjustment_type,reason,notes,payload,created_at,created_by_user_id')
  .gte('created_at',params.from+'T00:00:00-04:00').lt('created_at',addDateKeyDays(params.to,1)+'T00:00:00-04:00').order('created_at',{ascending:false}).order('id',{ascending:false});
 if(params.type){if(!/^[a-z_]{1,80}$/.test(params.type))throw new Error('Tipo inválido.');q=q.eq('adjustment_type',params.type);}
 if(params.order){const id=Number(params.order);if(!Number.isSafeInteger(id)||id<=0)throw new Error('Indica el número corto de orden.');q=q.eq('order_id',id);}
 if(params.actor){if(!/^[a-f0-9-]{36}$/i.test(params.actor))throw new Error('Usuario inválido.');q=q.eq('created_by_user_id',params.actor);}
 const result=await q.range((page-1)*25,page*25);
 if(result.error)throw new Error('No se pudieron consultar los ajustes.');
 const rows=(result.data??[]) as Row[],ids=Array.from(new Set(rows.map(r=>String(r.created_by_user_id)).filter(Boolean)));
 const actors=ids.length?await supabase.from('profiles').select('id,full_name').in('id',ids):{data:[],error:null};
 if(actors.error)throw new Error('No se pudo verificar quién realizó los ajustes.');
 return {rows:rows.slice(0,25),actors:(actors.data??[]) as Row[],hasNext:rows.length>25,page,queried:true};
}
