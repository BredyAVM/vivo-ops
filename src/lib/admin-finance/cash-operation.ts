export type CashOperationInput={requestId:string;direction:'inflow'|'outflow';moneyAccountId:number;amount:number;feeAmount:number;movementDate:string;exchangeRateVesPerUsd:number|null;referenceCode:string;counterpartyName:string;description:string;notes:string};
export type CashOperationReceipt={requestId:string;movementId:number;feeMovementId:number|null;accountId:number;amount:number;feeAmount:number;currency:'USD'|'VES';totalUsd:number;replayed:boolean;currentStatus:string};
export type CashOperationResult={status:'confirmed';receipt:CashOperationReceipt}|{status:'rejected'|'uncertain';message:string};
export function validCashOperation(input:CashOperationInput) {
  const money=(v:number)=>Number.isFinite(v)&&v>=0&&v<=1e9&&Math.abs(v*100-Math.round(v*100))<0.00001;
  return /^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/i.test(input.requestId)&&Number.isSafeInteger(input.moneyAccountId)&&input.moneyAccountId>0
    && ['inflow','outflow'].includes(input.direction)&&money(input.amount)&&input.amount>0&&money(input.feeAmount)
    && (input.direction==='outflow'||input.feeAmount===0)&&typeof input.description==='string'&&input.description.trim().length>0&&input.description.length<=240;
}
export function parseCashReceipt(value:unknown,input:CashOperationInput):CashOperationReceipt {
  const r=value as CashOperationReceipt;
  if(!r||r.requestId!==input.requestId||r.accountId!==input.moneyAccountId||r.amount!==input.amount||r.feeAmount!==input.feeAmount
    ||!Number.isSafeInteger(r.movementId)||r.movementId<=0||!Number.isFinite(r.totalUsd)||typeof r.replayed!=='boolean'||!['USD','VES'].includes(r.currency)) throw new Error('Comprobante no verificable.');
  return r;
}
