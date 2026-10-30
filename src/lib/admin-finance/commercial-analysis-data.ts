import 'server-only';
import {requireAdminContext} from '@/lib/auth';
import {addDateKeyDays,getCaracasDateKey} from './period';
import {analysisOrderDate,buildAnalysisRows,summarizeAnalysis,validateAnalysisPeriod,estimateAnalysisCommission,type AnalysisOrder,type AnalysisState,type AnalysisFilters} from './commercial-analysis-model';
import {resolveProductCommissionTerms} from '@/lib/commissions/product-commission-policy';
import {resolveDeliveredCommissionItem} from '@/lib/commissions/delivered-order-commission';
import {loadCommercialCollectionForOrders} from '@/lib/commissions/goal-data';
type Row=Record<string,unknown>;
const check=<T extends {data:unknown;error:{message:string}|null}>(r:T)=>{if(r.error)throw new Error(r.error.message);return r.data};
export async function loadCommercialAnalysis(filters:AnalysisFilters,requested:boolean){
 const {supabase}=await requireAdminContext();
 if(!requested)return null;
 validateAnalysisPeriod(filters);
 const end=addDateKeyDays(filters.to,1);
 const fields='id,status,client_id,created_by_user_id,attributed_advisor_id,created_at,source,fulfillment,total_usd,total_bs_snapshot,extra_fields';
 const base=()=>{
  let q=supabase.from('orders').select(fields).eq('status','delivered');
  if(filters.source!=='all')q=q.eq('source',filters.source);
  if(filters.fulfillment!=='all')q=q.eq('fulfillment',filters.fulfillment);
  if(filters.person)q=filters.personBasis==='creator'?q.eq('created_by_user_id',filters.person):filters.personBasis==='advisor'?q.eq('attributed_advisor_id',filters.person):q.or('created_by_user_id.eq.'+filters.person+',attributed_advisor_id.eq.'+filters.person);
  return q.order('id').range(0,999);
 };
 const results=filters.basis==='created'?[await base().gte('created_at',filters.from+'T00:00:00-04:00').lt('created_at',end+'T00:00:00-04:00')]:await Promise.all([base().gte('extra_fields->schedule->>date',filters.from).lt('extra_fields->schedule->>date',end),base().gte('created_at',filters.from+'T00:00:00-04:00').lt('created_at',end+'T00:00:00-04:00')]);
 const all=results.flatMap(r=>{const rows=check(r) as AnalysisOrder[];if(rows.length>=1000)throw new Error('La consulta supera el límite seguro. Reduce el período o selecciona un vendedor.');return rows});
 const orders=Array.from(new Map(all.filter(o=>analysisOrderDate(o,filters.basis)>=filters.from&&analysisOrderDate(o,filters.basis)<=filters.to).map(o=>[Number(o.id),{...o,id:Number(o.id)}])).values()).filter(o=>Number(o.total_usd)>0.005);
 if(orders.length>1000)throw new Error('Reduce el período o selecciona un vendedor.');
 const ids=orders.map(o=>o.id),clientIds=Array.from(new Set(orders.map(o=>Number(o.client_id)).filter(Boolean)));
 const personIds=Array.from(new Set(orders.flatMap(o=>[o.created_by_user_id,o.attributed_advisor_id]).filter(Boolean))) as string[];
 const names=new Map<string,string>(),clients=new Map<number,string>(),states:AnalysisState[]=[];
 for(let i=0;i<personIds.length;i+=100){const rows=check(await supabase.from('profiles').select('id,full_name').in('id',personIds.slice(i,i+100))) as Row[];rows.forEach(r=>names.set(String(r.id),String(r.full_name||'Sin nombre')))}
 const clientRows:Row[]=[];
 for(let i=0;i<clientIds.length;i+=100){const rows=check(await supabase.from('clients').select('id,full_name,client_type,created_at').in('id',clientIds.slice(i,i+100))) as Row[];clientRows.push(...rows);rows.forEach(r=>clients.set(Number(r.id),String(r.full_name||'Cliente')))}
 for(let i=0;i<ids.length;i+=100){const rows=check(await supabase.rpc('get_orders_financial_state',{p_order_ids:ids.slice(i,i+100),p_operation_date:null,p_active_bs_rate:null})) as AnalysisState[];if(!Array.isArray(rows))throw new Error('Saldos no disponibles.');states.push(...rows)}
 const rows=buildAnalysisRows(orders,states,filters,names,clients);
 let collection=null,newClients:null|{own:number;assigned:number;other:number}=null,commissionUsd:number|null=null;
 if(filters.details==='payments'){
  if(orders.length>500)throw new Error('Para explorar pagos, selecciona hasta 500 órdenes por período o vendedor.');
  collection=await loadCommercialCollectionForOrders({supabase,orders:rows.map(r=>({orderId:r.id,orderNumber:String(r.id),clientName:r.client,deliveryDate:r.date,totalUsd:r.totalUsd,confirmedPaidUsd:r.paidUsd,pendingUsd:r.pendingUsd})),cutoffDate:getCaracasDateKey(new Date())});
 }
 if(filters.details==='clients'){
  const firstByClient=new Map<number,number>();
  for(let i=0;i<clientIds.length;i+=100){
   const history:Row[]=[];
   for(let page=0;page<20;page++){
    const result=await supabase.from('orders').select('id,client_id,created_at').in('client_id',clientIds.slice(i,i+100)).neq('status','cancelled').order('created_at').order('id').range(page*500,page*500+499);
    const portion=check(result) as Row[];history.push(...portion);
    if(portion.length<500)break;
    if(page===19)throw new Error('El historial de clientes seleccionado es muy amplio. Filtra por vendedor o un período menor.');
   }
   history.forEach(r=>{const id=Number(r.client_id);if(!firstByClient.has(id))firstByClient.set(id,Number(r.id))});
  }
  newClients={own:0,assigned:0,other:0};
  const newIds=new Set(orders.filter(o=>firstByClient.get(Number(o.client_id))===o.id).map(o=>Number(o.client_id)));
  clientRows.filter(c=>newIds.has(Number(c.id))&&Date.parse(String(c.created_at))>=Date.parse('2026-06-02T00:00:00-04:00')).forEach(c=>{const kind=String(c.client_type);if(kind==='own')newClients!.own++;else if(kind==='assigned')newClients!.assigned++;else newClients!.other++});
 }
 if(filters.details==='commissions'){
  commissionUsd=0;
  for(let i=0;i<ids.length;i+=50){
   const chunk=ids.slice(i,i+50);
   const [itemResult,adjustmentResult]=await Promise.all([supabase.from('order_items').select('id,order_id,product_id,qty,line_total_usd,unit_price_usd_snapshot').in('order_id',chunk).order('id').range(0,999),supabase.from('order_admin_adjustments').select('order_id,order_item_id,payload,created_at,id').in('order_id',chunk).order('created_at',{ascending:false}).order('id',{ascending:false}).range(0,999)]);
   const items=check(itemResult) as Row[],adjustments=check(adjustmentResult) as Row[];
   if(items.length>=1000||adjustments.length>=1000)throw new Error('Reduce la consulta de comisiones; faltaría parte del desglose.');
   const productIds=Array.from(new Set(items.map(r=>Number(r.product_id)).filter(Boolean)));
   const products=productIds.length?check(await supabase.from('products').select('id,commission_mode,commission_value,extra_fields').in('id',productIds)) as Row[]:[];
   const productById=new Map(products.map(r=>[Number(r.id),r]));
   for(const order of orders.filter(o=>chunk.includes(o.id))){
    const resolved=items.filter(r=>Number(r.order_id)===order.id).map(item=>{
     const product=productById.get(Number(item.product_id));
     if(!product)throw new Error('Falta un producto para comprobar su regla de comisión.');
     const catalog=resolveProductCommissionTerms({currentMode:product.commission_mode,currentValue:product.commission_value,extraFields:product.extra_fields,referenceDate:analysisOrderDate(order,'scheduled')});
     const terms=resolveDeliveredCommissionItem(catalog,adjustments.filter(a=>Number(a.order_item_id)===Number(item.id)).map(a=>a.payload)).effective;
     const baseUsd=Number(item.line_total_usd??Number(item.qty)*Number(item.unit_price_usd_snapshot));
     if(!Number.isFinite(baseUsd))throw new Error('Precio de línea no disponible.');
     return {baseUsd,terms};
    });
    commissionUsd+=estimateAnalysisCommission(order,resolved,filters.basePct);
   }
  }
  commissionUsd=Math.round(commissionUsd*100)/100;
 }
 return {rows,totals:summarizeAnalysis(rows),people:Array.from(names,([id,name])=>({id,name})).sort((a,b)=>a.name.localeCompare(b.name)),collection,newClients,commissionUsd,asOf:new Date().toISOString()};
}
