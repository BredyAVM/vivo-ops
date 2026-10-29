import {hasMenuOrderDetails} from './order-menu.ts';
export type MuerdemeIncentive = {orderId:number;orderNumber:string;advisorId:string;policyRevision:number;
 purchaseKind:'first'|'recurrent';amountUsd:number;status:'ready';deliveryDate:string};
export type MuerdemeIncentiveSnapshot = {version:1;totalUsd:number;rows:MuerdemeIncentive[]};
const cents=(v:number)=>Math.round((v+Number.EPSILON)*100);
export function isMuerdemeCommissionLine(item:{notes?:string|null;product?:unknown}){
 const product=Array.isArray(item.product)?item.product[0]:item.product;
 return hasMenuOrderDetails(item.notes)||(product as {extra_fields?:{commercial_brand?:string}}|null)?.extra_fields?.commercial_brand==='muerdeme';
}
export function readMuerdemeIncentiveSnapshot(snapshot:unknown):MuerdemeIncentiveSnapshot{
 const raw=(snapshot as {muerdeme_incentives?:unknown}|null)?.muerdeme_incentives;
 if(raw==null)return{version:1,totalUsd:0,rows:[]};
 const value=raw as MuerdemeIncentiveSnapshot;
 if(value.version!==1||!Array.isArray(value.rows)||value.rows.length>500||!Number.isFinite(value.totalUsd)||value.totalUsd<0)throw new Error('El desglose de estímulos está incompleto.');
 const seen=new Set<number>();
 for(const row of value.rows){
  if(!Number.isSafeInteger(row.orderId)||row.orderId<=0||seen.has(row.orderId)||typeof row.orderNumber!=='string'
   ||typeof row.advisorId!=='string'||!row.advisorId||!Number.isSafeInteger(row.policyRevision)||row.policyRevision<1
   ||!['first','recurrent'].includes(row.purchaseKind)||row.status!=='ready'||!/^\d{4}-\d{2}-\d{2}$/.test(row.deliveryDate)
   ||!Number.isFinite(row.amountUsd)||row.amountUsd<0||row.amountUsd>=1e9||Math.abs(row.amountUsd*100-cents(row.amountUsd))>1e-5)throw new Error('El detalle de un estímulo es inválido.');
  seen.add(row.orderId);
 }
 if(cents(value.totalUsd)!==value.rows.reduce((sum,r)=>sum+cents(r.amountUsd),0))throw new Error('El total de estímulos no coincide con los pedidos.');
 return value;
}
export function applyMuerdemeIncentives<T extends {advisor_user_id:string;gross_commission_usd:number;payable_usd:number;
 snapshot:{totals:{grossCommissionUsd:number;payableUsd:number}}}>(closures:T[],rows:MuerdemeIncentive[]):T[]{
 const checked=readMuerdemeIncentiveSnapshot({muerdeme_incentives:{version:1,totalUsd:rows.reduce((s,r)=>s+cents(r.amountUsd),0)/100,rows}});
 return closures.map(closure=>{
  const related=checked.rows.filter(row=>row.advisorId===closure.advisor_user_id),previous=readMuerdemeIncentiveSnapshot(closure.snapshot).totalUsd;if(!related.length&&!previous)return closure;
  const totalUsd=related.reduce((s,r)=>s+cents(r.amountUsd),0)/100;
  const gross=(cents(closure.gross_commission_usd)-cents(previous)+cents(totalUsd))/100,payable=(cents(closure.payable_usd)-cents(previous)+cents(totalUsd))/100;
  return{...closure,gross_commission_usd:gross,payable_usd:payable,snapshot:{...closure.snapshot,
   totals:{...closure.snapshot.totals,grossCommissionUsd:gross,payableUsd:payable},muerdeme_incentives:{version:1,totalUsd,rows:related}}};
 });
}
