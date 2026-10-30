// Isolated PostgreSQL only: never connects to production or registers real cash.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
let PGlite;
try { ({ PGlite } = await import('@electric-sql/pglite')); }
catch { ({ PGlite } = await import('../../outputs/crm-auto-link-test-runtime/node_modules/@electric-sql/pglite/dist/index.js')); }
const db = new PGlite();
const read = path => readFileSync(new URL('../../'+path,import.meta.url),'utf8');
await db.exec(`
create schema app_private;
create table orders(id bigint primary key,order_number text,status text,total_usd numeric,total_bs_snapshot numeric,extra_fields jsonb);
create table money_movements(id bigint primary key,order_id bigint,status text,direction text,movement_type text,currency_code text,amount numeric,amount_usd_equivalent numeric,movement_group_id uuid);
create table payment_reports(id bigint,order_id bigint,status text,operation_date date,created_at timestamptz,reported_currency_code text,reported_amount numeric,reported_amount_usd_equivalent numeric);
create table payment_confirmation_operations(report_id bigint,movement_id bigint,order_id bigint,movement_group_id uuid,request jsonb);
create table counter_command_receipts(order_id bigint,command_type text,idempotency_key uuid,status text,created_at timestamptz);
create table client_fund_movements(order_id bigint,amount_usd numeric,movement_type text,reason_code text,created_at timestamptz,movement_group_id uuid);
create table client_fund_payout_operations(order_id bigint,difference_usd numeric,voided_at timestamptz);
create table delivery_settlements(id bigint,order_id bigint,status text);
create table delivery_settlement_entries(settlement_id bigint,money_movement_id bigint,entry_type text);
create table exchange_rates(is_active boolean,effective_at timestamptz,rate_bs_per_usd numeric);
create table order_balance_adjustments_v1(order_id bigint,kind text,amount_usd numeric,supporting_movement_ids bigint[]);
create function app_private.order_uses_current_usd_v1(bigint) returns boolean language sql as $$select false$$;
create function public.order_collection_precision_basis_v1(bigint) returns table(total_precise_usd numeric,paid_delta_usd numeric) language sql as $$select null::numeric,null::numeric where false$$;
`);
const source=read(process.argv[2] || 'tests/pricing/fixtures/native-usd-financial-functions.sql');
for(const name of ['get_order_financial_state_block3','get_order_financial_state']) {
  const start=source.indexOf('CREATE OR REPLACE FUNCTION public.'+name+'(');
  assert.ok(start>=0,name);
  await db.exec(source.slice(start,source.indexOf('$function$',source.indexOf('AS $function$',start)+13)+10)+';');
}
await db.exec(`
insert into orders values(1,'test','delivered',30.50,27122.43,'{"pricing":{"total_usd":30.50,"total_bs":27122.43,"fx_rate":889.26},"delivery":{"completed_at":"2026-10-30T18:00:00Z"}}');
insert into money_movements values(1,1,'confirmed','outflow','change_given','USD',10,10,null),(2,1,'confirmed','inflow','order_payment','USD',40,40,null);
insert into payment_reports values(1,1,'confirmed','2026-10-30','2026-10-30','USD',40,40);
insert into delivery_settlements values(1,1,'open');
insert into delivery_settlement_entries values(1,1,'cash_change_out');
`);
const state=async()=> (await db.query("select * from get_order_financial_state(1,'2026-10-30',889.26)")).rows[0];
assert.equal(Number((await state()).pending_usd),0,'reproduce lost debt before fix');
const migration=read('supabase/migrations/20261030194122_delivery_change_snapshot_debt.sql');
await db.exec(migration);
assert.equal(Number((await state()).pending_usd),0.5);
assert.equal(Number((await state()).confirmed_paid_usd),30);
assert.equal(Number((await state()).pending_bs),444.63);
assert.equal((await state()).payment_status,'partial');
await db.exec("update delivery_settlements set status='settled'");
assert.equal(Number((await state()).pending_usd),0.5,'closing custody cannot close customer debt');
await db.exec(migration);
assert.equal(Number((await state()).pending_usd),0.5,'idempotent migration');
await db.exec("insert into delivery_settlement_entries values(1,1,'cash_change_out')");
assert.equal(Number((await state()).pending_usd),0.5,'one movement counted once');
await db.exec("update money_movements set amount=9.5,amount_usd_equivalent=9.5 where id=1");
assert.equal(Number((await state()).pending_usd),0,'exact net payment closes');
await db.exec("update money_movements set status='voided' where id=1");
assert.equal(Number((await state()).overpaid_usd),9.5,'voided change excluded');
await db.exec("delete from money_movements; delete from payment_reports; insert into money_movements values(3,1,'confirmed','inflow','order_payment','VES',27122.43,30.49,null); insert into payment_reports values(2,1,'confirmed','2026-10-30','2026-10-30','VES',27122.43,30.49)");
assert.equal(Number((await state()).pending_usd),0,'native exact Bs still closes rounding residue');
const advisor=read('src/app/app/advisor/payments/page.tsx');
assert.match(advisor,/get_orders_financial_state/);
assert.match(advisor,/order\.status === 'delivered' && order\.reportableBalanceUsd > 0\.005/);
await db.close();
console.log('PASS: actual change debt, settled custody, native Bs, voids, duplicates, advisor collection filter and idempotence');
