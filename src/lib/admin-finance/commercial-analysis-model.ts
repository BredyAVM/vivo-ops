import {getOrderCommercialNetUsd,getOrderMoneySnapshot,type OrderMoneySource} from '../orders/order-money.ts';
import {validCollectionDate} from './collections-model.ts';
import {getCaracasDateKey} from './period.ts';
import type {OrderCommissionTerms} from '../commissions/order-commission-terms.ts';
export type AnalysisFilters={from:string;to:string;source:'all'|'advisor'|'master'|'walk_in';fulfillment:'all'|'pickup'|'delivery';person:string;personBasis:'either'|'creator'|'advisor';basis:'scheduled'|'created';basePct:number;details:'none'|'payments'|'clients'|'commissions';page:number};
export type AnalysisOrder=OrderMoneySource&{id:number;status:string;client_id:number|null;created_by_user_id:string|null;attributed_advisor_id:string|null;created_at:string;source:string;fulfillment:string;extra_fields?:OrderMoneySource['extra_fields']&{schedule?:{date?:string|null}|null}};
export type AnalysisState={order_id:number;confirmed_paid_usd:number|string;pending_usd:number|string;total_usd:number|string};
export type AnalysisRow={id:number;client:string;personId:string;personName:string;source:string;fulfillment:string;date:string;netUsd:number;totalUsd:number;paidUsd:number;pendingUsd:number};
export function analysisFilters(params:Record<string,string|string[]|undefined>):AnalysisFilters {
 const first=(key:string)=>String(Array.isArray(params[key])?params[key][0]:params[key]??'');
 const pick=<T extends string>(key:string,allowed:readonly T[],fallback:T)=>allowed.includes(first(key) as T)?first(key) as T:fallback;
 const from=first('from'),to=first('to'),person=first('person');
 if((from&&!validCollectionDate(from))||(to&&!validCollectionDate(to))||(from&&to&&from>to))throw new Error('Revisa desde y hasta.');
 if(person&&!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(person))throw new Error('Vendedor inválido.');
 const pct=Number(first('basePct')||0),page=Number(first('page')||1);
 if(!Number.isFinite(pct)||pct<0||pct>100)throw new Error('El porcentaje debe estar entre 0 y 100.');
 return {from,to,person,source:pick('source',['all','advisor','master','walk_in'],'all'),fulfillment:pick('fulfillment',['all','pickup','delivery'],'all'),personBasis:pick('personBasis',['either','creator','advisor'],'either'),basis:pick('basis',['scheduled','created'],'scheduled'),basePct:pct,details:pick('details',['none','payments','clients','commissions'],'none'),page:Number.isSafeInteger(page)?Math.max(1,Math.min(10000,page)):1};
}
export function validateAnalysisPeriod(filters:AnalysisFilters) {
 if(!validCollectionDate(filters.from)||!validCollectionDate(filters.to)||filters.from>filters.to)throw new Error('Selecciona un período antes de consultar.');
 if((Date.parse(filters.to)-Date.parse(filters.from))/86400000>366)throw new Error('Consulta períodos de hasta un año; divide los períodos mayores.');
}
export function analysisOrderDate(row:AnalysisOrder,basis:AnalysisFilters['basis']) {
 const scheduled=row.extra_fields?.schedule?.date;
 return basis==='scheduled'&&typeof scheduled==='string'&&validCollectionDate(scheduled)?scheduled:getCaracasDateKey(new Date(row.created_at));
}
function finite(value:unknown){if(value===null||value===undefined||String(value).trim()==='')throw new Error('Importe no disponible.');const n=Number(value);if(!Number.isFinite(n))throw new Error('Importe inválido.');return n;}
export function buildAnalysisRows(orders:AnalysisOrder[],states:AnalysisState[],filters:AnalysisFilters,names:Map<string,string>,clients:Map<number,string>) {
 const ids=new Set(orders.map(o=>o.id)),seen=new Set<number>();
 for(const s of states){const id=Number(s.order_id);if(!Number.isSafeInteger(id)||!ids.has(id)||seen.has(id))throw new Error('Respuesta financiera duplicada o fuera de la selección.');seen.add(id);}
 const byId=new Map(states.map(s=>[Number(s.order_id),s]));
 return orders.filter(o=>o.status==='delivered'&&Number(o.total_usd)>0.005).map((o):AnalysisRow=>{
  const s=byId.get(o.id);if(!s)throw new Error('Falta verificar el saldo de una orden; no se muestran totales parciales.');
  const personId=o.attributed_advisor_id||o.created_by_user_id||'unknown';
  return {id:o.id,client:clients.get(Number(o.client_id))||'Cliente',personId,personName:names.get(personId)||'Sin responsable',source:o.source,fulfillment:o.fulfillment,date:analysisOrderDate(o,filters.basis),netUsd:getOrderCommercialNetUsd(o),totalUsd:finite(s.total_usd),paidUsd:finite(s.confirmed_paid_usd),pendingUsd:finite(s.pending_usd)};
 });
}
export function summarizeAnalysis(rows:AnalysisRow[]){
 const cents=(key:'netUsd'|'paidUsd'|'pendingUsd')=>Math.round(rows.reduce((sum,r)=>sum+Math.round(r[key]*100),0))/100;
 const netUsd=cents('netUsd');
 return {closures:rows.length,netUsd,paidUsd:cents('paidUsd'),pendingUsd:cents('pendingUsd'),averageUsd:rows.length?Math.round(netUsd/rows.length*100)/100:0};
}
export function estimateAnalysisCommission(order:AnalysisOrder,items:{baseUsd:number;terms:OrderCommissionTerms}[],basePct:number){
 const net=getOrderCommercialNetUsd(order),snapshot=getOrderMoneySnapshot(order);
 const fixed=items.find(i=>i.terms.mode==='fixed_order');
 if(fixed)return net*(Number(fixed.terms.value||0)/100);
 const factor=snapshot.subtotalUsd>0?snapshot.subtotalAfterDiscountUsd/snapshot.subtotalUsd:1;
 return items.length?items.reduce((sum,i)=>sum+Math.max(0,i.baseUsd*factor)*(i.terms.mode==='none'?0:i.terms.mode==='fixed_item'?Number(i.terms.value||0)/100:basePct/100),0):net*basePct/100;
}
