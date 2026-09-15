import assert from 'node:assert/strict';
import test from 'node:test';
import {validReconciliationInput,parseReconciliationReceipt,parseReconciliationDetail,type ReconciliationInput} from '../../src/lib/admin-finance/reconciliation.ts';
import {validCashOperation} from '../../src/lib/admin-finance/cash-operation.ts';
import {saveFinancialAttempt,readFinancialAttempt,clearFinancialAttempt} from '../../src/lib/finance/financial-attempt-storage.ts';
const input:ReconciliationInput={requestId:'11111111-1111-4111-8111-111111111111',itemId:1,mode:'existing',amount:1,note:'Evidencia bancaria',fingerprint:'a'.repeat(32)};
test('reconciliation preserves native cents; rejects zero, negatives, precision and nonfinite values',()=>{
  assert.equal(validReconciliationInput({...input,amount:0.01}),true);
  for(const amount of [0,-1,NaN,Infinity,0.001])assert.equal(validReconciliationInput({...input,amount}),false);
  assert.equal(validReconciliationInput({...input,fingerprint:'old'}),false);
});
test('receipt must belong to exact request, item and amount',()=>{
  const receipt={requestId:input.requestId,itemId:1,accountId:3,amount:1,currency:'VES',remaining:0.01,residualItemId:2,movementId:10,movementCreated:false,replayed:true};
  assert.equal(parseReconciliationReceipt(receipt,input).remaining,0.01);
  for(const change of [{amount:2},{itemId:2},{requestId:'other'},{remaining:-1},{currency:'EUR'}])assert.throws(()=>parseReconciliationReceipt({...receipt,...change},input));
});
test('invalid reads fail visibly instead of inventing an empty balance',()=>{
  assert.equal(parseReconciliationDetail(null),null);
  for(const value of [{},{item:{}},{item:{id:1,amount:'10'}}])assert.throws(()=>parseReconciliationDetail(value));
});
test('pending attempt survives a reload read, remains user-scoped, and clears only explicitly',()=>{
  const data=new Map<string,string>();Reflect.set(globalThis,'sessionStorage',{setItem:(k:string,v:string)=>data.set(k,v),getItem:(k:string)=>data.get(k)??null,removeItem:(k:string)=>data.delete(k)});
  saveFinancialAttempt('admin-a','reconciliation',input);
  assert.deepEqual(readFinancialAttempt('admin-a','reconciliation'),input);
  assert.equal(readFinancialAttempt('admin-b','reconciliation'),null);
  assert.equal(readFinancialAttempt('admin-a','closure'),null);
  clearFinancialAttempt('admin-a','reconciliation');assert.equal(readFinancialAttempt('admin-a','reconciliation'),null);
});
test('cash input requires a stable identity and does not round an invalid cash amount',()=>{
  const cash={requestId:input.requestId,direction:'outflow' as const,moneyAccountId:1,amount:10,feeAmount:0.01,movementDate:'2026-09-15',exchangeRateVesPerUsd:null,referenceCode:'',counterpartyName:'',description:'Caja chica',notes:''};
  assert.equal(validCashOperation(cash),true);assert.equal(validCashOperation({...cash,amount:10.005}),false);assert.equal(validCashOperation({...cash,requestId:''}),false);
});
