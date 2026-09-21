// Isolated aggregate contract tests. Canonical financial integration is also
// exercised separately in a production transaction ending in ROLLBACK.
import { PGlite } from '../../outputs/crm-auto-link-test-runtime/node_modules/@electric-sql/pglite/dist/index.js';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const db = new PGlite();
const admin = '00000000-0000-0000-0000-000000000001', advisor = '00000000-0000-0000-0000-000000000002', master = '00000000-0000-0000-0000-000000000003';
await db.exec(`
create role anon; create role authenticated; create role service_role;
create schema auth; create schema app_private;
create table auth.users(id uuid primary key); insert into auth.users values('${admin}'),('${advisor}'),('${master}');
create function auth.uid() returns uuid language sql as $$select nullif(current_setting('test.uid',true),'')::uuid$$;
create table user_roles(user_id uuid,role text); insert into user_roles values('${admin}','admin'),('${advisor}','advisor'),('${master}','master');
create function has_role(text) returns boolean language sql as $$select exists(select 1 from public.user_roles where user_id=auth.uid() and role=$1)$$;
create function is_admin() returns boolean language sql as $$select public.has_role('admin')$$;
create function is_master_or_admin() returns boolean language sql as $$select public.has_role('admin') or public.has_role('master')$$;
create type currency_code as enum('USD','VES');
create table clients(id bigint primary key,full_name text);
insert into clients values(1,'Cliente prueba'),(2,'Otro cliente');
create table orders(id bigint primary key,order_number text,status text,client_id bigint,total_usd numeric,total_bs numeric);
insert into orders values(101,'ORD101','delivered',1,20,2000),(102,'ORD102','ready',1,20,2000),(999,'OTHER','created',2,50,5000);
create table advisor_order_drafts(id bigint primary key,advisor_user_id uuid,converted_order_id bigint,payload jsonb,title text,updated_at timestamptz default '2026-01-01');
insert into advisor_order_drafts(id,advisor_user_id,converted_order_id,payload,title) values(671,'${advisor}',101,'{"event_budget":{"kind":"admin_event_budget"}}','Prueba'),
 (672,'${advisor}',102,'{"event_extension":{"root_id":671,"stage":"approved"}}','Ampliación');
create table money_accounts(id bigint primary key,name text,currency_code currency_code,is_active boolean);
insert into money_accounts values(1,'USD','USD',true),(2,'Bolívares','VES',true),(3,'Inactiva','USD',false);
create table money_account_payment_rules(money_account_id bigint,role text,payment_method_code text,can_report_payment boolean,is_active boolean);
insert into money_account_payment_rules values(1,'advisor','zelle',true,true),(2,'advisor','transfer',true,true);
insert into money_account_payment_rules values(1,'admin','zelle',true,true),(2,'admin','transfer',true,true),(1,'master','zelle',true,true),(2,'master','transfer',true,true);
create table payment_reports(id bigint generated always as identity primary key,order_id bigint,status text,created_by_user_id uuid,
 created_at timestamptz default now(),reported_currency_code currency_code,reported_amount numeric,reported_exchange_rate_ves_per_usd numeric,
 reported_amount_usd_equivalent numeric,reported_money_account_id bigint,reference_code text,payer_name text,notes text,operation_date date,
 confirmed_movement_id bigint);
create table money_movements(id bigint generated always as identity primary key,order_id bigint,payment_report_id bigint,money_account_id bigint,
 status text,direction text,movement_type text,currency_code currency_code,amount numeric,movement_date date,reference_code text,movement_group_id uuid);
create table order_timeline_events(id bigint generated always as identity primary key,order_id bigint,order_number text,event_type text,event_group text,title text,message text,severity text,actor_user_id uuid,payload jsonb);
create table order_timeline_event_recipients(event_id bigint,target_role text,target_user_id uuid,requires_action boolean,read_at timestamptz);
create function normalize_payment_reference_key(text) returns text language sql immutable as $$select nullif(lower(btrim($1)),'')$$;
create function get_order_financial_state(bigint,date default null,numeric default null)
 returns table(order_id bigint,order_status text,pending_usd numeric,pending_bs numeric,pending_reports_count bigint)
 language sql as $$select o.id,o.status,greatest(0,o.total_usd-coalesce(p.paid,0)),greatest(0,o.total_bs-coalesce(p.paid,0)*100),
 (select count(*) from public.payment_reports r where r.order_id=o.id and r.status='pending')
 from public.orders o left join lateral(select sum(case when m.currency_code='USD' then m.amount else m.amount/100 end) paid
 from public.money_movements m where m.order_id=o.id and m.status='confirmed') p on true where o.id=$1$$;
create function app_private.event_workspace_read_v1(p_root_id bigint default null) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare root public.advisor_order_drafts%rowtype;
begin
 if auth.uid() is null or not(public.is_master_or_admin() or public.has_role('advisor')) then raise exception 'Sin acceso'; end if;
 if p_root_id is null then return (select jsonb_agg(x) from (select d.id,
   (select count(*) from public.advisor_order_drafts q where q.payload#>>'{event_extension,stage}' in ('requested','priced')) pending
   from public.advisor_order_drafts d where d.id=671) x); end if;
 select * into root from public.advisor_order_drafts where id=p_root_id;
 if not found or root.payload?'event_extension' or (not public.is_master_or_admin() and root.advisor_user_id<>auth.uid()) then raise exception 'Evento no disponible'; end if;
 return jsonb_build_object('root',jsonb_build_object('converted_order_id',root.converted_order_id),'orders',
   (select jsonb_agg(jsonb_build_object('order_id',o.id)) from public.orders o where o.id=root.converted_order_id
      or o.id in(select q.converted_order_id from public.advisor_order_drafts q where q.payload#>>'{event_extension,root_id}'=root.id::text)));
end $$;
create function confirm_payment_report_atomic_v1(p_input jsonb) returns jsonb language plpgsql as $$
declare r public.payment_reports%rowtype; mid bigint;
begin
 select * into r from public.payment_reports where id=(p_input->>'reportId')::bigint;
 if r.order_id::text=current_setting('test.fail_order',true) then raise exception 'Simulated last allocation failure'; end if;
 if exists(select 1 from public.find_active_payment_duplicate(r.reported_money_account_id,r.operation_date,r.reported_currency_code,r.reported_amount,r.reference_code,r.id)) then raise exception 'Duplicado'; end if;
 insert into public.money_movements(order_id,payment_report_id,money_account_id,status,direction,movement_type,currency_code,amount,movement_date,reference_code,movement_group_id)
 values(r.order_id,r.id,r.reported_money_account_id,'confirmed','inflow','order_payment',r.reported_currency_code,r.reported_amount,r.operation_date,r.reference_code,gen_random_uuid()) returning id into mid;
 update public.payment_reports set status='confirmed',confirmed_movement_id=mid where id=r.id;
 return jsonb_build_object('movementId',mid);
end $$;
create function void_financial_movement_v1(bigint,uuid,text) returns jsonb language plpgsql as $$
begin
 update public.money_movements set status='voided' where id=$1;
 update public.payment_reports set status='rejected',confirmed_movement_id=null where id=(select payment_report_id from public.money_movements where id=$1);
 return '{}'; end $$;
select set_config('test.uid','${admin}',false);
`);
await db.exec(readFileSync(new URL('../../supabase/migrations/20260921145826_event_consolidated_payments_v1.sql', import.meta.url), 'utf8'));
await db.exec(readFileSync(new URL('../../supabase/migrations/20260921151230_event_payment_account_rules_v1.sql', import.meta.url), 'utf8'));
await db.exec(readFileSync(new URL('../../supabase/migrations/20260921151833_event_payment_pending_visibility_v1.sql', import.meta.url), 'utf8'));
const rows = async (sql, args=[]) => (await db.query(sql,args)).rows;
const cmd = async (action,input,root=671) => (await rows('select public.event_payment_command_v1($1,$2,$3) result',[root,action,JSON.stringify(input)]))[0].result;
const role = async uid => rows("select set_config('test.uid',$1,true)",[uid]);
const base = {id:'11111111-1111-4111-8111-111111111111',accountId:1,method:'zelle',currency:'USD',amount:40,rate:null,date:'2026-09-21',reference:'REF-1',bank:'',payer:'Cliente',notes:''};
const report = async (input=base) => { const {allocations} = await cmd('preview',input); const full={...input,allocations}; await cmd('report',full); return full; };
let n=0;
async function check(name,fn) { await db.exec('begin'); try { await fn(); await db.exec('set constraints all immediate'); console.log('PASS '+name); n++; } finally { await db.exec('rollback'); } }
// Error assertions use savepoints so the enclosing scenario can continue.
async function fails(fn,pattern) { await db.exec('savepoint expected_error'); try { await assert.rejects(fn(),pattern); } finally { await db.exec('rollback to expected_error'); } }
await check('advisor previews equal allocations and reports once without recording money',async()=>{await role(advisor);const full=await report();assert.deepEqual(full.allocations,[{order_id:101,amount:20},{order_id:102,amount:20}]);assert.equal((await rows('select count(*) n from money_movements'))[0].n,0);assert.equal((await rows('select count(*) n from payment_reports'))[0].n,0);});
await check('same report retries return same receipt; payload changes conflict',async()=>{const full=await report();assert.equal((await cmd('report',full)).replayed,true);await fails(()=>cmd('report',{...full,notes:'different'}),/otros datos/);});
await check('advisor cannot confirm, reject or void',async()=>{await role(advisor);await report();for(const action of ['confirm','reject','void']) await fails(()=>cmd(action,{id:base.id,reason:'Test reason'}),/Solo Máster/);});
await check('master confirms both equal allocations with same reference, no duplicate revenue',async()=>{await report();await role(master);await cmd('confirm',{id:base.id});assert.equal(Number((await rows("select sum(amount) total from money_movements where status='confirmed'"))[0].total),40);assert.equal((await rows('select count(*) n from payment_reports'))[0].n,2);assert.equal((await rows('select count(*) n from order_timeline_event_recipients where requires_action'))[0].n,0);});
await check('confirmation retry never posts again',async()=>{await report();await cmd('confirm',{id:base.id});assert.equal((await cmd('confirm',{id:base.id})).replayed,true);assert.equal((await rows('select count(*) n from money_movements'))[0].n,2);});
await check('last allocation error rolls back first allocation and reports',async()=>{await report();await rows("select set_config('test.fail_order','102',true)");await fails(()=>cmd('confirm',{id:base.id}),/Simulated/);assert.equal((await rows('select count(*) n from money_movements'))[0].n,0);assert.equal((await rows('select state from event_payment_operations'))[0].state,'pending');});
await check('changed balance requires new distribution and never changes prices',async()=>{await report();await rows('update orders set total_usd=19,total_bs=1900 where id=101');await fails(()=>cmd('confirm',{id:base.id}),/supera el saldo|Cambió el saldo/);assert.equal((await rows('select count(*) n from money_movements'))[0].n,0);});
await check('forged allocations rejected before reporting',async()=>{await fails(()=>cmd('report',{...base,allocations:[{order_id:999,amount:40}]}),/saldos cambiaron/);});
await check('duplicate total receipt rejected even though individual amounts differ',async()=>{await report();assert.equal((await rows("select * from find_active_payment_duplicate(1,'2026-09-21','USD',40,'REF-1')")).length,1);assert.equal((await rows("select * from find_active_payment_duplicate(1,'2026-09-21','USD',20,'REF-1')")).length,0);});
await check('partial void, evidence delete, receipt unlink and amount edits forbidden',async()=>{await report();await cmd('confirm',{id:base.id});const mid=(await rows('select id from money_movements order by id limit 1'))[0].id;await fails(()=>rows(`select void_financial_movement_v1(${mid},null,'Partial void')`),/pago pertenece/);await fails(()=>rows('delete from payment_reports'),/pago pertenece/);await fails(()=>rows('update payment_reports set event_payment_id=null'),/pago pertenece/);await fails(()=>rows('update money_movements set amount=1'),/pago pertenece/);});
await check('master cannot void; admin reverses entire receipt and replay is safe',async()=>{await report();await cmd('confirm',{id:base.id});await role(master);await fails(()=>cmd('void',{id:base.id,reason:'Test reversal'}),/Solo Administración/);await role(admin);await cmd('void',{id:base.id,reason:'Test reversal'});assert.equal((await rows("select count(*) n from money_movements where status='confirmed'"))[0].n,0);assert.equal((await cmd('void',{id:base.id,reason:'Test reversal'})).replayed,true);await fails(()=>cmd('confirm',{id:base.id}),/resuelto/);});
await check('partial payment leaves later order unpaid without overpayment',async()=>{const full=await report({...base,amount:25});assert.deepEqual(full.allocations,[{order_id:101,amount:20},{order_id:102,amount:5}]);await cmd('confirm',{id:base.id});assert.equal(Number((await rows('select pending_usd from get_order_financial_state(102)'))[0].pending_usd),15);});
await check('VES receipt preserves native total and per-order coverage',async()=>{const full=await report({...base,accountId:2,currency:'VES',method:'transfer',bank:'Banco',amount:4000,rate:100});assert.deepEqual(full.allocations,[{order_id:101,amount:2000},{order_id:102,amount:2000}]);await cmd('confirm',{id:base.id});assert.equal(Number((await rows('select sum(amount) total from money_movements'))[0].total),4000);});
await check('overpayment and missing FX rejected',async()=>{await fails(()=>cmd('preview',{...base,amount:41}),/supera el saldo/);await fails(()=>cmd('preview',{...base,currency:'VES',rate:0}),/tasa/);});
await check('advisor account rules and receipt requirements enforced server-side',async()=>{await role(advisor);const {allocations}=await cmd('preview',base);await fails(()=>cmd('report',{...base,allocations,method:'cash_usd'}),/No puedes/);await fails(()=>cmd('report',{...base,allocations,payer:''}),/titular/);await fails(()=>cmd('report',{...base,allocations,reference:''}),/referencia/);await fails(()=>cmd('report',{...base,allocations,accountId:3}),/cuenta activa/);});
await check('unrelated or anonymous actor cannot read or allocate event payments',async()=>{await role('00000000-0000-0000-0000-000000000009');await fails(()=>cmd('preview',base),/Sin acceso/);await fails(()=>rows('select public.event_payment_read_v1(671)'),/Sin acceso/);});
await check('ordinary pending report prevents accidental second allocation',async()=>{await rows("insert into payment_reports(order_id,status) values(101,'pending')");await fails(()=>cmd('preview',base),/pagos pendientes/);});
await check('pending event payment appears in scoped action count and resolves on rejection',async()=>{await report();assert.equal((await rows('select app_private.event_workspace_read_v1() data'))[0].data[0].payment_pending,1);await cmd('reject',{id:base.id,reason:'Transferencia no recibida'});assert.equal((await rows('select app_private.event_workspace_read_v1() data'))[0].data[0].payment_pending,0);assert.equal((await rows('select count(*) n from order_timeline_event_recipients where requires_action'))[0].n,0);});
await check('transient partial state cannot commit',async()=>{await report();await rows("update event_payment_operations set state='confirming'");await fails(()=>db.exec('set constraints all immediate'),/incompleto/);await rows("update event_payment_operations set state='pending'");});
await check('no direct table mutation and no anonymous RPC grants',async()=>{for(const privilege of ['INSERT','UPDATE','DELETE','SELECT'])assert.equal((await rows(`select has_table_privilege('authenticated','public.event_payment_operations','${privilege}') allowed`))[0].allowed,false);assert.equal((await rows("select has_function_privilege('anon','public.event_payment_command_v1(bigint,text,jsonb)','execute') allowed"))[0].allowed,false);});
await check('admin also uses configured account/method pairs',async()=>{const {allocations}=await cmd('preview',base);await fails(()=>cmd('report',{...base,allocations,method:'cash_usd'}),/No puedes/);const data=(await rows('select public.event_payment_read_v1(671) data'))[0].data;assert.deepEqual(data.accounts.find(a=>a.id===1).methods,['zelle']);});
await check('payment activity resurfaces an older event without altering order date',async()=>{await report();assert.equal((await rows("select updated_at>'2026-01-02'::timestamptz fresh from advisor_order_drafts where id=671"))[0].fresh,true);});
console.log(`${n} event payment database checks passed`);
await db.close();
