import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { adminMovementHref, adminMovementHistoryHref, resolveAdminMovementContext } from '../../src/lib/admin-finance/movement-navigation.ts';

const accounts = [{ id: 1, isActive: true }, { id: 2, isActive: false }];
test('income and expense links preserve the selected account and do not submit operations', () => {
  assert.equal(adminMovementHref('outflow', 1), '/app/admin/finanzas/cuentas/movimiento?tipo=outflow&cuenta=1');
  assert.equal(adminMovementHref('inflow'), '/app/admin/finanzas/cuentas/movimiento?tipo=inflow');
  assert.equal(resolveAdminMovementContext({ cuenta: '1', tipo: 'outflow' }, accounts).accountId, 1);
  assert.equal(resolveAdminMovementContext({}, accounts).invalidAccount, false);
});
test('unavailable accounts never silently select a different account', () => {
  for (const cuenta of ['2', '999', '0', '-1', '1.5', 'NaN', 'Infinity', '']) {
    assert.equal(resolveAdminMovementContext({ cuenta }, accounts).invalidAccount, true, cuenta);
    assert.equal(resolveAdminMovementContext({ cuenta }, accounts).accountId, null, cuenta);
  }
});
test('history opens the submitted account and date, not a currently selected filter', () => {
  assert.equal(adminMovementHistoryHref(1, '2026-09-12'), '/app/admin/finanzas/cuentas/1?vista=movements&desde=2026-09-12&hasta=2026-09-12');
});

const state={roles:['admin'] as string[],calls:[] as Array<{name:string;params:Record<string,unknown>}>,invalidations:[] as string[],error:null as {code:string;message:string}|null,badReceipt:false};
const requestId='11111111-1111-4111-8111-111111111111';
const input={requestId,direction:'outflow' as const,moneyAccountId:1,amount:5,feeAmount:0,movementDate:'2026-09-15',exchangeRateVesPerUsd:null,referenceCode:'',counterpartyName:'',description:'Compra caja chica',notes:''};
const supabase={async rpc(name:string,params:Record<string,unknown>){
  state.calls.push({name,params});const p=params.p_input as typeof input;
  return {error:state.error,data:state.badReceipt?{}:{requestId:params.p_request_id,movementId:99,feeMovementId:p.feeAmount?100:null,accountId:p.moneyAccountId,amount:p.amount,feeAmount:p.feeAmount,currency:p.exchangeRateVesPerUsd?'VES':'USD',totalUsd:10.2,replayed:false,currentStatus:'confirmed'}};
}};
Reflect.set(globalThis,'__cashActionTest',{context(){if(!state.roles.includes('admin'))throw new Error('No autorizado');return {supabase,user:{id:'test-admin'},roles:state.roles};},revalidate(path:string){state.invalidations.push(path);}});
const nodeModule=await import('node:module');
const registerHooks=Reflect.get(nodeModule,'registerHooks');
registerHooks({resolve(specifier:string,context:unknown,next:(s:string,c:unknown)=>unknown){
  if(specifier==='server-only')return {url:'data:text/javascript,export {};',shortCircuit:true};
  const mocks:Record<string,string>={'@/lib/auth':'export async function requireAdminContext(){return globalThis.__cashActionTest.context();}','next/cache':'export function revalidatePath(p){globalThis.__cashActionTest.revalidate(p);}'};
  if(mocks[specifier])return {url:'data:text/javascript,'+encodeURIComponent(mocks[specifier]),shortCircuit:true};
  return next(specifier.startsWith('@/')?new URL('../../src/'+specifier.slice(2)+'.ts',import.meta.url).href:specifier,context);
}});
const {createAdminMoneyMovementAction}=await import('../../src/app/app/admin/finanzas/cuentas/movimiento/actions.ts');
function reset(){state.roles=['admin'];state.calls=[];state.invalidations=[];state.error=null;state.badReceipt=false;}
test('Admin sends principal and fee in one canonical operation and preserves request identity',async()=>{
  reset();const result=await createAdminMoneyMovementAction(input);assert.equal(result.status,'confirmed');
  assert.equal(state.calls.length,1);assert.equal(state.calls[0].name,'create_admin_cash_operation_v1');
  assert.equal(state.calls[0].params.p_request_id,requestId);
  assert.deepEqual(state.calls[0].params.p_input,(({requestId,...rest})=>rest)(input));
  assert.ok(state.invalidations.includes('/app'));
});
test('anonymous, advisor and Master rejected before any command',async()=>{
  for(const roles of [[],['advisor'],['master']]){reset();state.roles=roles;await assert.rejects(createAdminMoneyMovementAction(input),/No autorizado/);assert.equal(state.calls.length,0);}
});
test('native VES amount, fee and chosen rate are passed without converting or dropping them',async()=>{
  reset();const result=await createAdminMoneyMovementAction({...input,amount:1000,feeAmount:20,exchangeRateVesPerUsd:100});
  assert.equal(result.status,'confirmed');if(result.status==='confirmed')assert.equal(result.receipt.totalUsd,10.2);
  const payload=state.calls[0].params.p_input as typeof input;assert.equal(payload.amount,1000);assert.equal(payload.feeAmount,20);assert.equal(payload.exchangeRateVesPerUsd,100);
});
test('income cannot silently discard a supplied fee and invalid cents never reach SQL',async()=>{
  for(const changed of [{direction:'inflow' as const,feeAmount:50},{amount:-1},{amount:0.001},{amount:NaN}]){reset();assert.equal((await createAdminMoneyMovementAction({...input,...changed})).status,'rejected');assert.equal(state.calls.length,0);}
});
test('database rejections and uncertain outcomes remain distinguishable',async()=>{
  reset();state.error={code:'22023',message:'Cuenta inactiva'};let result=await createAdminMoneyMovementAction(input);assert.equal(result.status,'rejected');
  reset();state.error={code:'08006',message:'Connection lost'};result=await createAdminMoneyMovementAction(input);assert.equal(result.status,'uncertain');
  reset();state.badReceipt=true;result=await createAdminMoneyMovementAction(input);assert.equal(result.status,'uncertain');assert.equal(state.invalidations.length,0);
});
test('Admin form persists input before sending and protects uncertain attempts',()=>{
  const form=readFileSync(new URL('../../src/app/app/admin/finanzas/cuentas/movimiento/AdminMovementForm.tsx',import.meta.url),'utf8');
  assert.ok(form.indexOf('saveFinancialAttempt(userId')<form.indexOf('await createAdminMoneyMovementAction(input)'));
  assert.match(form,/saved\?\?attempt.current/);assert.match(form,/result\?\.status==='uncertain'/);
});
