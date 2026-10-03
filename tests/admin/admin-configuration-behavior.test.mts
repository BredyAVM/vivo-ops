import test from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const state={roles:['admin'],ready:false,calls:[] as {name:string;params?:unknown}[], tables:[] as {table:string;method:string;args:unknown[]}[],data:{} as Record<string,unknown>,rpcError:null as {message:string}|null,authCreates:0,authDeletes:[] as string[]};
const supabase={
 from(table:string){
  const query:Record<string,unknown>={};
  const answer=()=>({data:state.data[table]??[],error:null});
  for(const method of ['select','eq','in','order','range','limit','gte','lt','upsert','update'])query[method]=(...args:unknown[])=>{state.tables.push({table,method,args});return query};
  query.maybeSingle=async()=>{const r=answer();return {...r,data:Array.isArray(r.data)?r.data[0]??null:r.data}};
  query.single=query.maybeSingle;
  query.then=(resolve:(r:unknown)=>unknown)=>Promise.resolve(answer()).then(resolve);
  return query;
 },
 async rpc(name:string,params?:unknown){
  state.calls.push({name,params});
  if(name==='admin_configuration_capabilities_v1')return {data:state.ready?{version:'admin-configuration-v1',atomic:true}:null,error:state.ready?null:{message:'function missing'}};
  return {data:[],error:state.rpcError};
 },
 auth:{admin:{
  async createUser(){state.authCreates++;return {data:{user:{id:'fresh-created-user'}},error:null}},
  async deleteUser(id:string){state.authDeletes.push(id);return {error:null}}
 }},
};
const context=()=>{if(!state.roles.includes('admin'))throw new Error('No autorizado');return {supabase,user:{id:'current-admin'},roles:state.roles}};
const masterContext=()=>{if(!state.roles.some(r=>r==='admin'||r==='master'))throw new Error('No autorizado');return {supabase,user:{id:'current-admin'},roles:state.roles}};
Reflect.set(globalThis,'__configurationBehavior',{context,masterContext,supabase});
registerHooks({resolve(specifier,context,next){
 const mocks:Record<string,string>={
  'server-only':'export{};',
  '@/lib/auth':'export async function requireAdminContext(){return globalThis.__configurationBehavior.context()} export async function requireMasterOrAdminContext(){return globalThis.__configurationBehavior.masterContext()}',
  'next/cache':'export function revalidatePath(){} export function updateTag(){}',
  '@supabase/supabase-js':'export function createClient(){return globalThis.__configurationBehavior.supabase}',
  '@/lib/search/client-search':'export async function searchClientSummaries(){throw new Error("Unexpected client history")}',
 };
 if(mocks[specifier])return {url:'data:text/javascript,'+encodeURIComponent(mocks[specifier]),shortCircuit:true};
 if(specifier.startsWith('@/'))return next(new URL('../../src/'+specifier.slice(2)+'.ts',import.meta.url).href,context);
 if(specifier.startsWith('.')&&!/\.[a-z]+$/.test(specifier)&&context.parentURL){
  const candidate=new URL(specifier+'.ts',context.parentURL);if(existsSync(fileURLToPath(candidate)))return next(candidate.href,context);
 }
 return next(specifier,context);
}});
const {loadConfiguration}=await import('../../src/lib/admin-config/data.ts');
const {saveConfigurationAction}=await import('../../src/lib/admin-config/form-actions.ts');
const commands=await import('../../src/lib/admin-config/canonical-actions.ts');
function reset(){state.roles=['admin'];state.ready=false;state.calls=[];state.tables=[];state.data={};state.rpcError=null;state.authCreates=0;state.authDeletes=[];}
function form(values:Record<string,string>){const f=new FormData();for(const [k,v]of Object.entries(values))f.set(k,v);return f;}
const account={name:'Caja prueba',currencyCode:'USD' as const,accountKind:'cash' as const,institutionName:'',ownerName:'',notes:'',isActive:true,operationId:'11111111-1111-4111-8111-111111111111'};

test('cold configuration does not read business tables or full histories',async()=>{
 for(const section of ['cuentas','usuarios','clientes','delivery'] as const){reset();const result=await loadConfiguration(section,{});assert.equal(result.queried,false);assert.equal(state.tables.length,0);assert.ok(state.calls.every(c=>c.name==='admin_configuration_capabilities_v1'))}
});
test('explicit account query uses 25-row page plus sentinel and reports unavailable atomic writes',async()=>{
 reset();state.data.money_accounts=Array.from({length:26},(_,i)=>({id:i+1,name:'Cuenta '+i}));const result=await loadConfiguration('cuentas',{consultar:'1',page:'2'});
 assert.equal(result.rows.length,25);assert.equal(result.hasNext,true);assert.equal(result.atomicReady,false);
 assert.deepEqual(state.tables.find(c=>c.method==='range')?.args,[25,50]);assert.ok(!state.tables.some(c=>c.table==='money_movements'));
});
test('selected tariff partner remains selected on subsequent tariff pages',async()=>{
 reset();state.data.delivery_partners=[{id:7,name:'Empresa'}];state.data.delivery_partner_rates=Array.from({length:26},(_,i)=>({id:i}));
 const result=await loadConfiguration('delivery',{id:'7',page:'3'});assert.equal(result.rows.length,1);assert.equal(result.rules.length,25);
 assert.deepEqual(state.tables.find(c=>c.table==='delivery_partners'&&c.method==='range')?.args,[0,0]);
 assert.deepEqual(state.tables.find(c=>c.table==='delivery_partner_rates'&&c.method==='range')?.args,[50,75]);
});
test('anonymous, advisor and Master cannot load configuration or submit new actions',async()=>{
 for(const roles of [[],['advisor'],['master']]){reset();state.roles=roles;await assert.rejects(loadConfiguration('delivery',{consultar:'1'}),/No autorizado/);const result=await saveConfigurationAction({ok:false,message:''},form({command:'partner',name:'No guardar'}));assert.equal(result.ok,false);assert.equal(state.calls.length,0);assert.equal(state.tables.length,0)}
});
test('missing migration blocks server submissions and Auth creation before any write',async()=>{
 reset();const result=await saveConfigurationAction({ok:false,message:''},form({command:'account',name:'Cuenta',currency:'USD',kind:'cash'}));assert.equal(result.ok,false);assert.match(result.message,/pendiente de activación/);
 await assert.rejects(commands.createMoneyAccountAction(account),/pendiente de activación/);
 await assert.rejects(commands.updateMoneyAccountAction({...account,accountId:9}),/pendiente de activación/);
 await assert.rejects(commands.toggleMoneyAccountActiveAction({accountId:9,nextIsActive:false}),/pendiente de activación/);
 await assert.rejects(commands.createDashboardUserAction({email:'test@example.com',password:'secret-test-only',fullName:'Test',isActive:true,receivesCommissions:false,roles:['advisor']}),/pendiente de activación/);
 assert.equal(state.tables.length,0);assert.equal(state.authCreates,0);assert.ok(state.calls.every(c=>c.name==='admin_configuration_capabilities_v1'));
});
test('account configuration sends original native values and stable retry identity in one command',async()=>{
 reset();state.ready=true;await commands.createMoneyAccountAction(account);await commands.createMoneyAccountAction(account);
 const calls=state.calls.filter(c=>c.name==='admin_account_configuration_v1');assert.equal(calls.length,2);assert.deepEqual(calls[0].params,calls[1].params);
 assert.deepEqual(calls[0].params,{p_input:account,p_operation_id:account.operationId});assert.equal(state.tables.length,0);
 assert.equal(state.calls.filter(c=>c.name==='admin_configuration_capabilities_v1').length,2);
});

test('Master baseline uses the session-authorized command without requiring admin configuration access',async()=>{
 reset();state.roles=['master'];await commands.createMoneyAccountBaselineAction({moneyAccountId:9,baselineDate:'2026-09-30',countedAmount:10,exchangeRateVesPerUsd:null,reason:'Test',notes:''});
 assert.deepEqual(state.calls.map(c=>c.name),['admin_account_baseline_v1']);assert.equal(state.tables.length,0);
 reset();state.roles=['advisor'];await assert.rejects(commands.createMoneyAccountBaselineAction({moneyAccountId:9,baselineDate:'2026-09-30',countedAmount:10,exchangeRateVesPerUsd:null,reason:'Test',notes:''}),/No autorizado/);assert.equal(state.calls.length,0);
});

test('account activation delegates a narrow atomic command rather than rewriting account details',async()=>{
 reset();state.ready=true;await commands.toggleMoneyAccountActiveAction({accountId:9,nextIsActive:false});
 const params=state.calls.find(c=>c.name==='admin_account_configuration_v1')?.params as {p_input:unknown;p_operation_id:string};
 assert.deepEqual(params.p_input,{accountId:9,activeOnly:true,isActive:false});assert.match(params.p_operation_id,/^[0-9a-f-]{36}$/);assert.equal(state.tables.length,0);
});
test('account rule normalization preserves effective view, auto confirmation and default review roles',async()=>{
 reset();state.ready=true;await commands.updateMoneyAccountPaymentRulesAction({accountId:9,operationId:account.operationId,rules:[
 {role:'advisor',paymentMethodCode:'transfer',canViewAccount:false,canShareWithClient:false,canReportPayment:true,canConfirmPayment:false,autoConfirmsReport:true,reviewRequired:true,reviewRoles:[],isActive:true},
 {role:'counter',paymentMethodCode:'pos',canViewAccount:false,canShareWithClient:false,canReportPayment:true,canConfirmPayment:false,autoConfirmsReport:false,reviewRequired:true,reviewRoles:[],isActive:true}
 ]});
 const payload=state.calls.find(c=>c.name==='admin_account_rules_v1')?.params as {p_rules:Record<string,unknown>[]};
 assert.equal(payload.p_rules[0].can_view_account,true);assert.equal(payload.p_rules[0].can_confirm_payment,true);assert.equal(payload.p_rules[0].review_required,false);
 assert.deepEqual(payload.p_rules[1].review_roles,['master','admin']);assert.equal(state.tables.length,0);
});
test('failed role configuration cleans up only the newly created Auth ID',async()=>{
 reset();state.ready=true;state.rpcError={message:'Role write failed'};
 const oldUrl=process.env.SUPABASE_URL,oldKey=process.env.SUPABASE_SERVICE_ROLE_KEY;process.env.SUPABASE_URL='https://example.test';process.env.SUPABASE_SERVICE_ROLE_KEY='mock-only';
 try{await assert.rejects(commands.createDashboardUserAction({email:'test@example.com',password:'secret-test-only',fullName:'Test',isActive:true,receivesCommissions:false,roles:['advisor']}),/se revirtió el usuario nuevo/);assert.equal(state.authCreates,1);assert.deepEqual(state.authDeletes,['fresh-created-user'])}
 finally{if(oldUrl===undefined)delete process.env.SUPABASE_URL;else process.env.SUPABASE_URL=oldUrl;if(oldKey===undefined)delete process.env.SUPABASE_SERVICE_ROLE_KEY;else process.env.SUPABASE_SERVICE_ROLE_KEY=oldKey}
});
