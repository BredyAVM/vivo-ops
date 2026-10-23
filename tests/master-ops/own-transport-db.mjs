import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync,readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
const read=p=>readFileSync(new URL('../../'+p,import.meta.url),'utf8');
const migration=readdirSync(new URL('../../supabase/migrations/',import.meta.url)).find(p=>p.endsWith('_own_transport_without_trip_pay.sql'));
const master='00000000-0000-0000-0000-000000000001';
const advisor='00000000-0000-0000-0000-000000000002';
const driver='00000000-0000-0000-0000-000000000003';

test('own transport: installed assignment/dispatch/completion routines, isolated PostgreSQL',async t=>{
 const db=new PGlite();
 const rows=async(sql,args=[])=>(await db.query(sql,args)).rows;
 const actor=async(role)=>db.query("select set_config('test.role',$1,false)",[role]);
 const assign=async(id,key=crypto.randomUUID(),name='Bredy',phone=null,notes=null)=>(await rows('select assign_own_transport_v1($1,$2,$3,$4,$5::uuid) result',[id,name,phone,notes,key]))[0].result;
 const seed=async(status='ready',fulfillment='delivery')=>(await rows("insert into orders(order_number,source,fulfillment,status,client_id,attributed_advisor_id,total_usd,total_bs_snapshot,notes,extra_fields) values('FIXTURE','advisor',$1,$2,1,$3,25,22500,'Nota para cliente','{\"pricing\":{\"total_usd\":25,\"fx_rate\":900},\"payment\":{\"method\":\"pending\"},\"unrelated\":true}') returning id",[fulfillment,status,advisor]))[0].id;
 try {
  await db.exec(`create role anon; create role authenticated; create role service_role;
   create schema app_private; create schema auth;
   create function auth.uid() returns uuid language sql stable as $$select '${master}'::uuid$$;
   create function public.has_role(text) returns boolean language sql stable as $$select $1=current_setting('test.role',true)$$;
   create function public.is_master_or_admin() returns boolean language sql stable as $$select current_setting('test.role',true) in ('master','admin')$$;
   create function public.is_admin() returns boolean language sql stable as $$select current_setting('test.role',true)='admin'$$;
   create function close_assign_driver_tasks(bigint,uuid) returns void language plpgsql as $$begin return; end$$;
   create type public.delivery_mode as enum('pickup','internal','external');
   create type public.order_status as enum('created','queued','confirmed','in_kitchen','ready','out_for_delivery','delivered','cancelled');
   create type public.currency_code as enum('USD','VES');`);
  const schema=read('tests/rewards/fixtures/redemption-installed-routines.sql');
  await db.exec(schema.slice(0,schema.indexOf('CREATE OR REPLACE FUNCTION')));
  await db.exec(`
   create table profiles(id uuid primary key,full_name text);
   create table user_roles(user_id uuid,role text);
   insert into profiles values('${master}','Master'),('${advisor}','Advisor'),('${driver}','Driver');
   insert into user_roles values('${master}','admin');
   create table delivery_partners(id bigint primary key,name text,is_active boolean default true,whatsapp_phone text);
   insert into delivery_partners values(1,'External company',true,null);
   create table delivery_partner_rates(id bigint,partner_id bigint,is_active boolean,km_from numeric,km_to numeric,price_usd numeric);
   create table order_events(id bigint generated always as identity,order_id bigint,event text,performed_by uuid,meta jsonb,created_at timestamptz default now());
   create table order_timeline_events(id bigint generated always as identity,order_id bigint,order_number text,event_type text,event_group text,title text,message text,severity text,actor_user_id uuid,payload jsonb default '{}',created_at timestamptz default now());
   create table order_timeline_event_recipients(event_id bigint,target_role text,target_user_id uuid,requires_action boolean);
   create table money_movements(id bigint,movement_date date,status text,order_id bigint,amount numeric);
   create table payment_reports(id bigint,order_id bigint,amount numeric);
   create table client_fund_movements(id bigint,order_id bigint,amount numeric);
   create table delivery_service_payment_items(order_id bigint,payment_id uuid,cost_usd numeric);
   create table delivery_service_payments(request_id uuid,money_movement_id bigint,result jsonb);
   create table delivery_trips(order_id bigint,paid_at timestamptz);
   create table delivery_settlements(id bigint generated always as identity,order_id bigint unique,status text,delivery_mode public.delivery_mode,
     responsible_user_id uuid,responsible_partner_id bigint,responsible_name text, responsible_phone text,
     dispatched_by_user_id uuid,dispatched_at timestamptz,notes text,collection_finalized_by_user_id uuid,collection_finalized_at timestamptz,updated_at timestamptz,
     check((delivery_mode='internal' and responsible_user_id is not null) or (delivery_mode='external' and (responsible_partner_id is not null or btrim(responsible_name)<>''))));
   create table delivery_settlement_entries(id bigint generated always as identity,settlement_id bigint,entry_type text,currency_code public.currency_code,amount numeric,
     exchange_rate_ves_per_usd numeric,amount_usd_equivalent numeric,reference_code text,notes text,created_by_user_id uuid);
   create table counter_command_receipts(id bigint generated always as identity primary key,key uuid unique,payload jsonb);
   create function counter_claim_command(uuid,text,bigint,bigint,jsonb) returns table(receipt_id bigint,existing_result jsonb) language plpgsql as $$
    begin return query select id,payload from public.counter_command_receipts where key=$1;
    if not found then return query insert into public.counter_command_receipts(key) values($1) returning id,null::jsonb; end if; end$$;
   create function counter_complete_command(bigint,jsonb) returns jsonb language plpgsql as $$begin update public.counter_command_receipts set payload=$2 where id=$1; return $2; end$$;
   create function counter_refresh_delivery_settlement_status(bigint,uuid) returns text language plpgsql as $$begin return 'open'; end$$;
   create function counter_amount_usd(public.currency_code,numeric,numeric) returns numeric language sql as $$select case when $1='VES' then $2/$3 else $2 end$$;
   insert into clients(id,full_name) values(1,'Fixture client');
   grant usage on schema public,app_private,auth to authenticated;
   grant select,insert,update on all tables in schema public to authenticated;
   grant usage,select on all sequences in schema public to authenticated;`);
  await db.exec(read('tests/master-ops/fixtures/own-transport-installed.sql'));
  await db.exec(read('tests/master-ops/fixtures/own-transport-correction.sql'));
  await db.exec(`create trigger orders_delivery_mode_guard before insert or update on orders for each row execute function trg_orders_delivery_mode_guard();
    create trigger orders_external_partner_guard before insert or update on orders for each row execute function trg_orders_external_partner_guard();`);
  await db.exec(read('supabase/migrations/'+migration));
  await actor('master');
  await t.test('assigns a name and explicit zero without altering customer terms or ledgers',async()=>{
   const id=await seed('in_kitchen');
   await db.query('insert into order_items(order_id,qty,line_total_usd) values($1,1,25)',[id]);
   await db.query('insert into money_movements values(1,current_date,\'confirmed\',$1,10)',[id]);
   const before=(await rows('select total_usd,total_bs_snapshot,notes,extra_fields from orders where id=$1',[id]))[0];
   const result=await assign(id,crypto.randomUUID(),'  Bredy  ','04140000000','Personal por hora');assert.equal(result.ok,true);
   const o=(await rows('select *,is_own_transport_v1(orders) own from orders where id=$1',[id]))[0];
   assert.equal(o.own,true);assert.equal(o.external_driver_name,'Bredy');assert.equal(o.external_partner_id,null);assert.equal(o.internal_driver_user_id,null);
   assert.equal(o.extra_fields.delivery.cost_usd,0);assert.equal(o.total_usd,before.total_usd);assert.equal(o.total_bs_snapshot,before.total_bs_snapshot);
   assert.equal(o.notes,before.notes);assert.deepEqual(o.extra_fields.pricing,before.extra_fields.pricing);assert.deepEqual(o.extra_fields.payment,before.extra_fields.payment);
   assert.equal((await rows('select count(*)::int n from money_movements'))[0].n,1);
   assert.equal((await rows('select count(*)::int n from delivery_service_payment_items'))[0].n,0);
   assert.equal((await rows("select count(*)::int n from order_timeline_events where order_id=$1 and event_type='own_transport_assigned'",[id]))[0].n,1);
  });
  await t.test('request replay returns one receipt even after delivery; different payload/key cannot overwrite',async()=>{
   const id=await seed();const key=crypto.randomUUID();await assign(id,key);
   assert.equal((await assign(id,key)).replayed,true);
   await assert.rejects(()=>assign(id,key,'Another person'),/otra asignación/);
   await assert.rejects(()=>assign(id),/ya tiene responsable/);
   await db.query('select out_for_delivery($1)',[id]);await db.query('select mark_delivered($1)',[id]);
   assert.equal((await assign(id,key)).replayed,true);
   assert.equal((await rows("select count(*)::int n from order_events where order_id=$1 and event='own_transport_assigned'",[id]))[0].n,1);
  });
  await t.test('shared dispatch/complete works and requires a real own marker rather than a loose name',async()=>{
   const id=await seed();await assign(id);await db.query('select counter_dispatch_order($1,20)',[id]);
   assert.equal((await rows('select status from orders where id=$1',[id]))[0].status,'out_for_delivery');
   await db.query('select mark_delivered($1)',[id]);
   const invalid=await seed();await db.query("update orders set delivery_mode='external',external_driver_name='Only a name' where id=$1",[invalid]);
   await assert.rejects(()=>db.query('select out_for_delivery($1)',[invalid]),/no external partner/);
  });
  await t.test('Counter dispatch stores custodian name and expected cash independently of trip pay',async()=>{
   const id=await seed();await assign(id,crypto.randomUUID(),'Hourly employee','04140000001');await actor('counter');
   const expected=[{line_key:'customer-cash',currency_code:'USD',amount:25}]; const key=crypto.randomUUID();
   const dispatch=async()=>(await rows('select counter_dispatch_delivery_block2($1::uuid,$2,20,$3::jsonb) result',[key,id,JSON.stringify(expected)]))[0].result;
   const result=await dispatch();assert.equal(result.ok,true);await dispatch();
   const s=(await rows('select * from delivery_settlements where order_id=$1',[id]))[0];
   assert.equal(s.responsible_name,'Hourly employee');assert.equal(s.responsible_partner_id,null);assert.equal(s.responsible_user_id,null);
   assert.equal((await rows('select count(*)::int n from delivery_settlement_entries where settlement_id=$1',[s.id]))[0].n,1);
   assert.equal((await rows('select amount from delivery_settlement_entries where settlement_id=$1',[s.id]))[0].amount,'25.00');
   assert.equal(s.collection_finalized_at,null);
   await actor('master');await db.query('select mark_delivered($1)',[id]);
   assert.equal((await rows('select collection_finalized_at from delivery_settlements where id=$1',[s.id]))[0].collection_finalized_at,null);
  });
  await t.test('blocks unauthorized assignment/metadata changes, bad names, closed/pickup orders and active custody',async()=>{
   const id=await seed();
   for(const role of ['advisor','counter','driver','']){await actor(role);await assert.rejects(()=>assign(id),/Solo Máster/);}
   await actor('master');await assert.rejects(()=>assign(id,crypto.randomUUID(),' '),/quién lleva/);
   for(const [status,fulfillment] of [['created','delivery'],['queued','delivery'],['out_for_delivery','pickup'],['cancelled','delivery'],['ready','pickup']]) {
    const bad=await seed(status,fulfillment);await assert.rejects(()=>assign(bad),/antes de su salida/);
   }
   await assign(id);await actor('advisor');
   await assert.rejects(()=>db.query("update orders set extra_fields=extra_fields #- '{delivery,own_transport}' where id=$1",[id]),/Solo Máster/);
   await actor('master');await assert.rejects(()=>db.query("update orders set extra_fields=jsonb_set(extra_fields,'{delivery,cost_usd}','1') where id=$1",[id]),/remuneración cero/);
   assert.equal((await rows("select extra_fields#>>'{delivery,cost_usd}' cost from orders where id=$1",[id]))[0].cost,'0');
   assert.equal((await rows("select has_function_privilege('anon','assign_own_transport_v1(bigint,text,text,text,uuid)','execute') allowed"))[0].allowed,false);
   const custody=await seed();await db.query("insert into delivery_settlements(order_id,status,delivery_mode,responsible_name) values($1,'not_required','external','Assigned custodian')",[custody]);
   await assert.rejects(()=>assign(custody),/custodia o un pago/);
   const paid=await seed();await db.query('insert into delivery_service_payment_items(order_id) values($1)',[paid]);
   await assert.rejects(()=>assign(paid),/custodia o un pago/);
  });
  await t.test('authenticated Master can execute the invoker command without a privileged server key',async()=>{
   await actor('master');const id=await seed();await db.exec('set role authenticated');
   try{assert.equal((await assign(id)).ok,true);}finally{await db.exec('reset role');}
  });
  await t.test('clearing/reassigning before departure removes own subtype; internal/external flows remain available',async()=>{
   const id=await seed();await assign(id);await db.query("select clear_delivery_assignment($1,'Cambio responsable')",[id]);
   assert.equal((await rows('select is_own_transport_v1(orders) own from orders where id=$1',[id]))[0].own,false);
   await assign(id);await db.query('select assign_internal_driver($1,$2::uuid)',[id,driver]);
   assert.equal((await rows("select extra_fields#>'{delivery,own_transport}' own from orders where id=$1",[id]))[0].own,null);
   await db.query('select out_for_delivery($1)',[id]);await db.query('select mark_delivered($1)',[id]);
   const external=await seed();await assign(external);await db.query("select assign_delivery_with_cost_v1($1,'external',null,1,null,null,2.5)",[external]);
   await db.query('select out_for_delivery($1)',[external]);await db.query('select mark_delivered($1)',[external]);
  });
  await t.test('pickup conversion drops transport subtype without adjusting customer money',async()=>{
   const id=await seed();await assign(id);
   await db.query("update orders set fulfillment='pickup' where id=$1",[id]);
   const o=(await rows('select delivery_mode,external_driver_name,extra_fields,total_usd from orders where id=$1',[id]))[0];
   assert.equal(o.delivery_mode,null);assert.equal(o.external_driver_name,null);
   assert.equal(o.extra_fields.delivery.own_transport,undefined);assert.equal(o.total_usd,'25');
  });
  await t.test('authorized historical correction can replace own assignment with a paid provider',async()=>{
   await actor('admin');const id=await seed();await assign(id);
   await db.query('select out_for_delivery($1)',[id]);await db.query('select mark_delivered($1)',[id]);
   await db.query("select correct_delivered_delivery_v1($1,'external',null,1,null,5,3,'Corrección administrativa autorizada')",[id]);
   const o=(await rows('select extra_fields,external_partner_id from orders where id=$1',[id]))[0];
   assert.equal(o.external_partner_id,1);assert.equal(o.extra_fields.delivery.own_transport,undefined);
   assert.equal(o.extra_fields.delivery.cost_usd,3);await actor('master');
  });
  await t.test('own deliveries never enter the provider-payables relation',async()=>{
   await actor('admin');
   const result=(await rows('select admin_delivery_services_v1(current_date-1,current_date+1) data'))[0].data;
   const ownIds=(await rows('select id from orders where is_own_transport_v1(orders)')).map(o=>o.id);
   assert.equal(result.rows.some(o=>ownIds.includes(o.id)),false);
   assert.ok(result.rows.length>0,'normal provider services remain visible');
  });
  await t.test('late event failure rolls back assignment and zero snapshot; inserts cannot forge own metadata',async()=>{
   await actor('master');const id=await seed();
   await db.exec(`create function fail_own_event() returns trigger language plpgsql as $$begin if new.order_id=${id} then raise exception 'Injected audit failure'; end if;return new;end$$;
    create trigger fail_own_event before insert on order_timeline_events for each row execute function fail_own_event();`);
   await assert.rejects(()=>assign(id),/Injected audit failure/);
   assert.equal((await rows('select external_driver_name from orders where id=$1',[id]))[0].external_driver_name,null);
   assert.equal((await rows('select count(*)::int n from order_events where order_id=$1',[id]))[0].n,0);
   await assert.rejects(()=>db.query("insert into orders(extra_fields) values('{\"delivery\":{\"own_transport\":{\"version\":1}}}')"),/desde la orden ya creada/);
  });
 }finally{await db.close();}
});
