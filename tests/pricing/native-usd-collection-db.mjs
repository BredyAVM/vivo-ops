// Isolated PostgreSQL exercising the installed financial functions and new migration.
// No production writes, credentials or real orders.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const db=new PGlite();
const read=path=>readFileSync(new URL('../../'+path,import.meta.url),'utf8');
await db.exec(`
create schema auth; create schema app_private;
create role anon; create role authenticated; create role service_role;
create function auth.uid() returns uuid language sql as $$select nullif(current_setting('test.uid',true),'')::uuid$$;
create function auth.role() returns text language sql as $$select 'authenticated'::text$$;
create function public.has_role(text) returns boolean language sql as $$select current_setting('test.role',true)=$1$$;
create function public.is_master_or_admin() returns boolean language sql as $$select public.has_role('admin') or public.has_role('master')$$;
create table orders(id bigint primary key,order_number text,status text,client_id bigint,created_by_user_id uuid,
  attributed_advisor_id uuid,total_usd numeric,total_bs_snapshot numeric,extra_fields jsonb);
create table advisor_order_drafts(id bigint primary key,advisor_user_id uuid,client_id bigint,status text,
  payload jsonb,converted_order_id bigint,converted_at timestamptz);
create table order_items(id bigint primary key,order_id bigint,pricing_origin_currency text,
  line_total_bs_snapshot numeric,line_total_usd numeric,override_unit_price_usd numeric,admin_price_override_usd numeric);
create table exchange_rates(id bigint,is_active boolean,effective_at timestamptz,rate_bs_per_usd numeric);
create table money_movements(id bigint primary key,order_id bigint,status text,direction text,movement_type text,
  currency_code text,amount numeric,amount_usd_equivalent numeric,exchange_rate_ves_per_usd numeric,
  movement_date date,movement_group_id uuid);
create table payment_reports(id bigint,order_id bigint,status text,operation_date date,created_at timestamptz,
  reported_currency_code text,reported_amount numeric,reported_amount_usd_equivalent numeric);
create table payment_confirmation_operations(report_id bigint,movement_id bigint,order_id bigint,movement_group_id uuid,request jsonb);
create table counter_command_receipts(order_id bigint,command_type text,idempotency_key uuid,status text,created_at timestamptz);
create table client_fund_movements(order_id bigint,amount_usd numeric,movement_type text,reason_code text,created_at timestamptz,movement_group_id uuid);
create table client_fund_payout_operations(order_id bigint,difference_usd numeric,voided_at timestamptz);
create table delivery_debt_allocations(order_id bigint,rounding_usd numeric,reversed_at timestamptz);
create table order_collection_precision_enrollments(order_id bigint primary key,created_by uuid);
create table order_payment_precision_allocations(movement_id bigint primary key,order_id bigint,applied_usd numeric,
  cash_equivalent_usd numeric,rounding_usd numeric,pending_before_usd numeric,pending_before_bs numeric,
  native_amount numeric,currency_code text,coverage_rate numeric,operation_date date,created_by uuid);
create table app_private.advisor_draft_price_agreements_v1(draft_id bigint,line_key text,advisor_user_id uuid,client_id bigint,terms jsonb);
create table app_private.draft_conversion_price_context_v1(order_id bigint,line_key text,transaction_id bigint,terms jsonb);
select set_config('test.uid','00000000-0000-0000-0000-000000000001',false);
select set_config('test.role','admin',false);
insert into exchange_rates values(1,true,'2026-10-09',900);
`);
const precision=read('supabase/migrations/20260915001157_order_collection_precision_v1.sql');
await db.exec(precision.slice(precision.indexOf('create function app_private.collection_payment_allocation_v1'),precision.indexOf('-- Uses only immutable order snapshots')));
await db.exec(read('tests/pricing/fixtures/native-usd-financial-functions.sql'));
await db.exec(`create trigger capture_order_payment_precision before insert or update of status on money_movements
  for each row execute function app_private.capture_order_payment_precision_v1();`);
const makeOrder=async(id,total=14,currency='USD',bs=11200,fx=800)=>{
  await db.query(`insert into orders values($1,$1::bigint::text,'created',1,auth.uid(),auth.uid(),$2,$3,
    jsonb_build_object('pricing',jsonb_build_object('total_usd',$2::numeric,'total_bs',$3::numeric,'fx_rate',$4::numeric),'schedule',jsonb_build_object('date','2026-10-12')))`,[id,total,bs,fx]);
  await db.query(`insert into order_items values($1,$1,$2,$3,$4,null,null)`,[id,currency,bs,total]);
};
const state=async(id,rate=900,date='2026-10-09')=>{
  const row=(await db.query('select * from get_order_financial_state($1,$2::date,$3::numeric)',[id,date,rate])).rows[0];
  return Object.fromEntries(Object.entries(row).map(([key,value])=>[key,
    typeof value==='string' && /^\d+(\.\d+)?$/.test(value) ? String(Number(value)) : value]));
};
const pay=async(id,order,amount,currency='USD',rate=900)=>{
  await db.query(`insert into money_movements values($1,$2,'confirmed','inflow','order_payment',$3,$4,
    round($4::numeric/case when $3='USD' then 1 else $5::numeric end,2),$5,'2026-10-09',null)`,[id,order,currency,amount,rate]);
};
await makeOrder(1); await makeOrder(2,14,'VES');
await pay(10,1,5);
const legacy=[await state(1),await state(2),await state(1,900,'2026-10-13')];
await db.exec(read('supabase/migrations/20261009182000_native_usd_order_collection_policy.sql'));
assert.deepEqual([await state(1),await state(2),await state(1,900,'2026-10-13')],legacy,'inactive migration leaves all legacy output columns identical');
await makeOrder(3); assert.equal((await state(3)).collection_mode,'snapshot_quote');
await db.exec(`update app_private.usd_catalog_cutover_v1 set activated_at=statement_timestamp();`);
await makeOrder(4);
assert.equal((await state(4)).pending_bs,'12600');
assert.equal((await state(4)).collection_mode,'native_usd');
await pay(11,4,5);
assert.equal((await state(4)).pending_usd,'9');
assert.equal((await state(4)).pending_bs,'8100');
assert.equal((await state(4,1000)).pending_bs,'9000');
assert.equal((await state(4,700)).pending_bs,'6300');
assert.equal((await state(4,null)).pending_bs,'8100','null FX resolves the active rate for new orders only');
assert.equal((await state(4,0)).pending_bs,null,'missing invalid explicit FX cannot masquerade as a zero quote');
await makeOrder(5); await pay(12,5,4000,'VES',800);
assert.equal((await state(5)).pending_usd,'9','historical VES credit stays USD5 after FX changes');
assert.equal((await state(5)).pending_bs,'8100');
await pay(13,5,8100,'VES',900);
assert.equal((await state(5,1000)).pending_usd,'0');
assert.equal((await state(5,1000)).overpaid_usd,'0');
assert.equal((await db.query('select coverage_rate from order_payment_precision_allocations where movement_id=13')).rows[0].coverage_rate,'900');
await pay(19,5,900,'VES',900);
assert.equal((await state(5)).overpaid_usd,'1','even after closure an extra VES payment uses its actual payment rate');
await db.exec(`update money_movements set status='voided' where id=19;`);
await db.exec(`update money_movements set status='voided' where id=13;`);
assert.equal((await state(5,1000)).pending_bs,'9000','void restores the USD credit, not old Bs');
await makeOrder(6); await pay(14,6,11200,'VES',900);
assert.ok(Number((await state(6)).pending_usd)>1.5,'old Bs snapshot cannot close a new USD invoice');
await makeOrder(7); await pay(15,7,20);
await db.exec(`insert into money_movements values(16,7,'confirmed','outflow','change_given','USD',6,6,900,'2026-10-09',null);`);
assert.equal((await state(7)).pending_usd,'0'); assert.equal((await state(7)).overpaid_usd,'0');
await makeOrder(8,2.01,'USD',1608); await pay(17,8,2);
assert.equal((await state(8)).pending_usd,'0.01','a full cent remains payable');
await makeOrder(9,2.01,'USD',1608); await pay(18,9,1801,'VES',900);
assert.equal((await state(9)).pending_usd,'0','subcent residual closes through an audited allocation');
assert.deepEqual([await state(1),await state(2),await state(1,900,'2026-10-13')],legacy,'activation does not reinterpret existing orders, even old USD ones');
await db.exec(`insert into advisor_order_drafts values(1,auth.uid(),1,'draft','{}',null,null);`);
await db.exec(`delete from app_private.native_usd_drafts_v1 where draft_id=1;`); // synthetic pre-cutover draft
await makeOrder(20); await db.exec(`delete from order_items where order_id=20; select set_config('test.role','advisor',false);
  select app_private.reserve_draft_conversion_prices_v1(20,1,'[]');`);
assert.equal((await state(20)).collection_mode,'snapshot_quote','certified old draft conversion retains its collection rule');
await db.exec(`insert into advisor_order_drafts values(2,auth.uid(),1,'draft','{}',null,null);`);
await makeOrder(21); await db.exec(`delete from order_items where order_id=21; select app_private.reserve_draft_conversion_prices_v1(21,2,'[]');`);
assert.equal((await state(21)).collection_mode,'native_usd','new draft keeps the fixed USD/current FX rule');
await db.exec(`select set_config('test.uid','00000000-0000-0000-0000-000000000002',false);`);
assert.equal((await db.query('select app_private.order_uses_current_usd_v1(4) as allowed')).rows[0].allowed,false,'other advisor cannot read private policy');
for(const table of ['usd_catalog_cutover_v1','native_usd_orders_v1','native_usd_drafts_v1']){
  assert.equal((await db.query('select relrowsecurity from pg_class where relname=$1',[table])).rows[0].relrowsecurity,true);
  assert.equal((await db.query(`select has_table_privilege('authenticated',$1,'INSERT') as allowed`,['app_private.'+table])).rows[0].allowed,false);
}
assert.equal((await db.query(`select has_function_privilege('anon','app_private.order_uses_current_usd_v1(bigint)','EXECUTE') as allowed`)).rows[0].allowed,false);
console.log('Native USD collection passed (legacy, partial payments, FX, void, change, subcent, drafts and permissions).');
await db.close();
