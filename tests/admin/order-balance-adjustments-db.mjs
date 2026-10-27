// Actual installed PostgreSQL routines; synthetic records in memory, never production.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { getOrderCommercialNetUsd } from '../../src/lib/orders/order-money.ts';

const read = path => readFileSync(new URL('../../'+path,import.meta.url),'utf8').replaceAll('\r\n','\n');
const db=new PGlite();
const execute=db.exec.bind(db);
db.exec=async sql=>{try{return await execute(sql);}catch(error){throw new Error(`${error.message}\n${String(error.where??'').slice(-800)}`);}};
const actor='00000000-0000-0000-0000-000000000001';
await db.exec(read('tests/pricing/native-usd-collection-db.mjs').match(/await db.exec\(`([\s\S]*?)`\);/)[1]);
// Reuse the existing isolated financial schema, not mocks of the payment routines.
await db.exec(read('tests/admin/payment-rate-protection-db.mjs').match(/await db.exec\(`([\s\S]*?)`\);/)[1].replaceAll('${actor}',actor));
await db.exec(`
 alter table orders add column last_modified_at timestamptz,add column last_modified_by uuid;
 alter table money_movements add column reviewed_at timestamptz,add column reviewed_by_user_id uuid,
   add column voided_at timestamptz,add column voided_by_user_id uuid,add column void_reason text;
 alter table client_fund_movements add column id bigint generated always as identity primary key,
   add column client_id bigint,add column payment_report_id bigint,add column currency_code text,
   add column amount numeric,add column money_account_id bigint,add column notes text,add column created_by_user_id uuid;
 create table order_admin_adjustments(id bigint generated always as identity primary key,order_id bigint,order_item_id bigint,
   adjustment_type text,reason text,notes text,payload jsonb,created_by_user_id uuid,created_at timestamptz default statement_timestamp());
 create table financial_void_operations(root_movement_id bigint primary key,movement_group_id uuid,created_by uuid,reason text,result jsonb);
 create table commission_payment_operations(payment_movement_id bigint,fee_movement_id bigint);
 create table order_change_obligations(command_idempotency_key uuid);
 create table advisor_commission_closures(id bigint primary key,status text,snapshot jsonb,gross_commission_usd numeric);
 insert into advisor_commission_closures values(1,'paid','{"orders":[{"orderId":1,"commissionUsd":7.61}]}',7.61);
 create function app_private.void_money_transfer_v1(bigint,uuid,text) returns jsonb language sql as $$select null::jsonb$$;
 -- These scenarios are order payments, never transfers or fund payouts.
 create function app_private.void_client_fund_payout_v1(uuid,text) returns jsonb language sql as $$select null::jsonb$$;
`);
const precision=read('supabase/migrations/20260915001157_order_collection_precision_v1.sql');
await db.exec(precision.slice(precision.indexOf('create function app_private.collection_payment_allocation_v1'),precision.indexOf('-- Uses only immutable order snapshots')));
await db.exec(read('tests/pricing/fixtures/native-usd-financial-functions.sql'));
await db.exec(read('supabase/migrations/20261009182000_native_usd_order_collection_policy.sql'));
await db.exec('update app_private.usd_catalog_cutover_v1 set activated_at=statement_timestamp()');
await db.exec(read('tests/admin/fixtures/payment-rate-installed-routines.sql'));
await db.exec(read('tests/admin/fixtures/payment-rate-confirmation-routines.sql'));
await db.exec('create trigger capture_order_payment_precision before insert or update of status on money_movements for each row execute function app_private.capture_order_payment_precision_v1()');
await db.exec(read('supabase/migrations/20261021194952_payment_quote_rate_protection.sql'));
await db.exec(read('supabase/migrations/20261021195103_payment_quote_rpc_boundaries.sql'));
await db.exec(read('tests/admin/fixtures/balance-adjustment-installed-routines.sql'));
await db.exec(read('tests/admin/fixtures/balance-adjustment-aux-routines.sql'));
let sequence=100;
const order=async(total=14,rate=800,legacy=false)=>{
 const id=++sequence;
 await db.query(`insert into orders(id,order_number,status,client_id,created_by_user_id,attributed_advisor_id,total_usd,total_bs_snapshot,extra_fields)
 values($1,$1::bigint::text,'created',1,auth.uid(),auth.uid(),$2,$2::numeric*$3::numeric,
 jsonb_build_object('pricing',jsonb_build_object('total_usd',$2::numeric,'total_bs',$2::numeric*$3::numeric,'fx_rate',$3::numeric,
 'subtotal_after_discount_usd',$2::numeric),'schedule',jsonb_build_object('date','2026-10-27')))`,[id,total,rate]);
 await db.query(`insert into order_items(id,order_id,product_id,qty,pricing_origin_currency,line_total_bs_snapshot,line_total_usd,pricing_fx_rate_snapshot)
 values($1,$1,5,1,'USD',$2::numeric*$3::numeric,$2,$3)`,[id,total,rate]);
 if(legacy) await db.query('delete from app_private.native_usd_orders_v1 where order_id=$1',[id]);
 return id;
};
const state=async(id,rate=900)=> (await db.query('select * from get_order_financial_state($1,current_date,$2)',[id,rate])).rows[0];
const record=async(id)=>(await db.query('select * from orders where id=$1',[id])).rows[0];
const pay=async(id,amount,currency='USD',rate=900)=>Number((await db.query(`insert into money_movements(order_id,status,direction,movement_type,
 currency_code,amount,amount_usd_equivalent,exchange_rate_ves_per_usd,movement_date)
 values($1,'confirmed','inflow','order_payment',$2,$3,round($3::numeric/case when $2='USD' then 1 else $4::numeric end,2),
 case when $2='USD' then null else $4::numeric end,current_date) returning id`,[id,currency,amount,rate])).rows[0].id);
const close=async(id,amount,key=randomUUID(),notes='No se cobrará este remanente')=>(await db.query('select close_order_balance_difference_v1($1,$2,$3,$4) v',[key,id,amount,notes])).rows[0].v;
const report=async(id,amount,currency='USD',rate=900)=>Number((await db.query(`insert into payment_reports(order_id,status,operation_date,
 reported_currency_code,reported_amount,reported_amount_usd_equivalent,reported_exchange_rate_ves_per_usd,reported_money_account_id,created_by_user_id)
 values($1,'pending',current_date,$2,$3,round($3::numeric/case when $2='USD' then 1 else $4::numeric end,2),
 case when $2='USD' then null else $4::numeric end,case when $2='USD' then 2 else 1 end,auth.uid()) returning id`,[id,currency,amount,rate])).rows[0].id);
const confirm=async(r,amount,handling='close_difference',currency='USD',rate=900)=>(await db.query(`select app_private.confirm_payment_report_atomic_v1($1) v`,[JSON.stringify({
 reportId:r,accountId:currency==='USD'?2:1,currency,amount,rate:currency==='USD'?null:rate,
 date:'2026-10-27',handling,changeLines:[],notes:'El cliente cede voluntariamente el cambio',requireExplicitHandling:true,
})])).rows[0].v;
const voidPayment=async(m)=>(await db.query("select void_financial_movement_v1($1,null,'Corrección del pago registrado') v",[m])).rows[0].v;

const historical=await order(14,800,true); await pay(historical,13.98);
await db.query(`update orders set total_usd=13.98,extra_fields=jsonb_set(extra_fields,'{pricing,total_usd}','13.98') where id=$1`,[historical]);
const historicalOrder=await record(historical),historicalState=await state(historical);
const legacyGain=await order();const legacyReport=await report(legacyGain,14.5);
const legacyReceipt=await confirm(legacyReport,14.5),legacyGainBefore=await record(legacyGain),legacyGainState=await state(legacyGain);
const paidClosures=(await db.query("select * from advisor_commission_closures where status='paid'")).rows;
await db.exec(read('supabase/migrations/20261027134835_separate_order_balance_adjustments.sql'));

test('separate balance adjustments — real PostgreSQL',async t=>{
 try {
  await t.test('install leaves every historical price, balance and paid closure untouched',async()=>{
   assert.deepEqual(await record(historical),historicalOrder); assert.deepEqual(await state(historical),historicalState);
   assert.deepEqual(await record(legacyGain),legacyGainBefore);assert.deepEqual(await state(legacyGain),legacyGainState);
   assert.deepEqual((await db.query("select * from advisor_commission_closures where status='paid'")).rows,paidClosures);
   assert.equal((await db.query('select count(*) n from order_balance_adjustments_v1')).rows[0].n,0);
  });
  await t.test('legacy price-changing gain still reverses through its original recorded audit, not the new ledger',async()=>{
   assert.equal(Number((await record(legacyGain)).total_usd),14.5);
   await voidPayment(legacyReceipt.movementId);
   assert.equal(Number((await record(legacyGain)).total_usd),14);
   assert.equal(Number((await state(legacyGain)).pending_usd),14);
   assert.equal(Number((await db.query('select count(*) n from order_balance_adjustments_v1 where order_id=$1',[legacyGain])).rows[0].n),0);
  });
  await t.test('forgiving USD0.02 keeps USD14 sale, cash13.98 and commission unchanged; retry is once',async()=>{
   const id=await order(),m=await pay(id,13.98),before=await record(id),key=randomUUID();
   const first=await close(id,0.02,key),retry=await close(id,0.02,key),s=await state(id);
   assert.equal(first.adjustmentId,retry.adjustmentId); assert.equal(retry.replayed,true);
   assert.deepEqual(await record(id),before);assert.equal(Number(s.pending_usd),0);assert.equal(Number(s.pending_bs),0);
   assert.equal(Number(s.total_usd),14);assert.equal(Number(s.confirmed_paid_usd),13.98);
   assert.equal(getOrderCommercialNetUsd(await record(id))*0.05,getOrderCommercialNetUsd(before)*0.05);
   assert.equal(Number((await db.query('select amount from money_movements where id=$1',[m])).rows[0].amount),13.98);
   assert.equal(Number((await db.query('select count(*) n from order_balance_adjustments_v1 where order_id=$1',[id])).rows[0].n),1);
   await assert.rejects(close(id,0.02,key,'Otro motivo'),/otros datos/);
   await assert.rejects(close(id,0.02),/saldo cambió/);
   await voidPayment(m);assert.equal(Number((await state(id)).pending_usd),14);
   await assert.rejects(close(id,0.02,key),/anuló un movimiento/);
   assert.deepEqual(await record(id),before,'void never rewrites the price or sale metadata');
  });
  await t.test('a waiver never masks a later authorized increase or an additional payment',async()=>{
   const id=await order();await pay(id,13.98);await close(id,0.02);
   await db.query(`update orders set total_usd=15,total_bs_snapshot=12000,extra_fields=jsonb_set(jsonb_set(extra_fields,'{pricing,total_usd}','15'),'{pricing,total_bs}','12000') where id=$1`,[id]);
   await db.query('update order_items set line_total_usd=15,line_total_bs_snapshot=12000 where order_id=$1',[id]);
   assert.equal(Number((await state(id)).pending_usd),1);assert.equal(Number((await state(id,1000)).pending_bs),1000);
   for(const invalidRate of [0,-1,'NaN','Infinity']) assert.equal((await state(id,invalidRate)).pending_bs,null);
   await pay(id,1);assert.equal(Number((await state(id)).pending_usd),0);
   await pay(id,0.5);assert.equal(Number((await state(id)).overpaid_usd),0.5);
  });
  await t.test('voiding an independent change movement also deactivates the waiver based on it',async()=>{
   const id=await order();await pay(id,20);
   const change=Number((await db.query(`insert into money_movements(order_id,status,direction,movement_type,currency_code,
     amount,amount_usd_equivalent,movement_date) values($1,'confirmed','outflow','change_given','USD',6.02,6.02,current_date) returning id`,[id])).rows[0].id);
   assert.equal(Number((await state(id)).pending_usd),0.02);await close(id,0.02);
   assert.equal(Number((await state(id)).pending_usd),0);
   await voidPayment(change);assert.equal(Number((await state(id)).overpaid_usd),6);
   assert.equal(Number((await record(id)).total_usd),14);
  });
  await t.test('ceded change at confirmation is separate, exact, idempotent and cash/bank unchanged',async()=>{
   const id=await order(),r=await report(id,14.5),before=await record(id),fundBefore=(await db.query('select fund_balance_usd from clients where id=1')).rows[0].fund_balance_usd;
   const first=await confirm(r,14.5),again=await confirm(r,14.5),s=await state(id);
   assert.equal(first.movementId,again.movementId);assert.equal(again.replayed,true);
   assert.equal(Number(s.total_usd),14);assert.equal(Number(s.confirmed_paid_usd),14.5);assert.equal(Number(s.overpaid_usd),0);
   assert.deepEqual(await record(id),before);assert.equal((await db.query('select fund_balance_usd from clients where id=1')).rows[0].fund_balance_usd,fundBefore);
   assert.equal(Number((await db.query('select count(*) n from money_movements where order_id=$1',[id])).rows[0].n),1);
   assert.equal(Number((await db.query('select amount_usd from order_balance_adjustments_v1 where order_id=$1',[id])).rows[0].amount_usd),0.5);
   await db.query(`update orders set total_usd=15,extra_fields=jsonb_set(extra_fields,'{pricing,total_usd}','15') where id=$1`,[id]);
   await db.query('update order_items set line_total_usd=15 where order_id=$1',[id]);
   await voidPayment(first.movementId);assert.equal(Number((await state(id)).pending_usd),15,'void respects the later price, not the old close snapshot');
   assert.equal(Number((await record(id)).total_usd),15);
  });
  await t.test('USD and VES rates preserve sale and cash through both kinds of waiver',async()=>{
   for(const rate of [800,900,1000]) {
    const id=await order();await pay(id,Number((13.98*rate).toFixed(2)),'VES',rate);
    const before=await record(id);await close(id,0.02);assert.equal(Number((await state(id,rate+100)).pending_bs),0);assert.deepEqual(await record(id),before);
    const id2=await order(),amount=Number((14.5*rate).toFixed(2)),r=await report(id2,amount,'VES',rate);
    const before2=await record(id2);const result=await confirm(r,amount,'close_difference','VES',rate);
    assert.equal(Number((await state(id2,rate+100)).overpaid_usd),0);assert.deepEqual(await record(id2),before2);
    assert.equal(Number((await db.query('select amount from money_movements where id=$1',[result.movementId])).rows[0].amount),amount);
   }
  });
  await t.test('counter waives an already stored order remainder without creating cash or reducing another fund',async()=>{
   const id=await order(),r=await report(id,14.5);await confirm(r,14.5,'store_fund');const before=await record(id);
   await db.exec("set test.role='counter'");const key=randomUUID();
   const call=()=>db.query('select counter_waive_order_change($1,$2,0.5,null) v',[key,id]);
   const first=(await call()).rows[0].v,again=(await call()).rows[0].v;
   assert.equal(first.adjustment_id,again.adjustment_id);assert.equal(Number((await state(id)).overpaid_usd),0);
   assert.deepEqual(await record(id),before);assert.equal(Number((await db.query('select count(*) n from money_movements where order_id=$1',[id])).rows[0].n),1);
   assert.equal(Number((await db.query('select fund_balance_usd from clients where id=1')).rows[0].fund_balance_usd),0);
   await db.exec("set test.role='admin'");
  });
  await t.test('limits, stale balances, cancelled orders, anonymous and non-admin callers fail closed',async()=>{
   const id=await order();await pay(id,13.95);
   await assert.rejects(close(id,0.04),/saldo cambió/);await assert.rejects(close(id,0.5),/límite/);
   await db.exec("set test.role='advisor'");await assert.rejects(close(id,0.05),/Solo Administración/);
   await db.exec("set test.role='master'");await assert.rejects(close(id,0.05),/Solo Administración/);
   await db.exec("set test.role='admin'");await db.query("update orders set status='cancelled' where id=$1",[id]);
   await assert.rejects(close(id,0.05),/cancelada/);
   await db.exec('set role anon');await assert.rejects(db.query('select close_order_balance_difference_v1($1,$2,0.05,null)',[randomUUID(),id]),/permission denied/);
   await db.exec('reset role;set role authenticated');
   await assert.rejects(db.query('insert into order_balance_adjustments_v1(request_id) values($1)',[randomUUID()]),/permission denied/);
   await assert.rejects(db.query('select app_private.record_order_balance_adjustment_v1($1,$2,\'shortfall_waived\',0.05,\'admin_shortfall\',\'forged\')',[randomUUID(),id]),/permission denied/);
   await db.exec('reset role');
  });
  await t.test('old application tabs cannot change the price through the retired closure action',async()=>{
   const id=await order();await pay(id,13.98);
   await assert.rejects(db.query(`update orders set total_usd=13.98,extra_fields=jsonb_set(extra_fields,'{payment}',
     '{"rounding_close":{"closed_balance_usd":0.02}}') where id=$1`,[id]),/cerrar un saldo ya no puede modificar/);
   assert.equal(Number((await record(id)).total_usd),14);
  });
  await t.test('paid closures stay byte-for-byte unchanged after all operations',async()=>{
   assert.deepEqual((await db.query("select * from advisor_commission_closures where status='paid'")).rows,paidClosures);
  });
  await t.test('a late audit failure rolls back the adjustment and cash/payment confirmation together',async()=>{
   await db.exec(`create function app_private.test_balance_audit_failure() returns trigger language plpgsql as $$begin
    if current_setting('test.balance_fail',true)='on' then raise exception 'synthetic audit failure'; end if;return new;end$$;
    create trigger test_balance_audit_failure before insert on order_timeline_events for each row execute function app_private.test_balance_audit_failure();`);
   const id=await order();await pay(id,13.98);const before=await record(id);
   await db.exec("set test.balance_fail='on'");await assert.rejects(close(id,0.02),/synthetic audit failure/);
   assert.deepEqual(await record(id),before);assert.equal(Number((await state(id)).pending_usd),0.02);
   assert.equal(Number((await db.query('select count(*) n from order_balance_adjustments_v1 where order_id=$1',[id])).rows[0].n),0);
   const id2=await order(),r=await report(id2,14.5);await assert.rejects(confirm(r,14.5),/synthetic audit failure/);
   assert.equal(Number((await db.query('select count(*) n from money_movements where order_id=$1',[id2])).rows[0].n),0);
   assert.equal((await db.query('select status from payment_reports where id=$1',[r])).rows[0].status,'pending');
   assert.equal(Number((await db.query('select count(*) n from order_admin_adjustments where order_id=$1',[id2])).rows[0].n),0);
   await db.exec("set test.balance_fail='off'");await close(id,0.02);await confirm(r,14.5);
  });
  await t.test('authorized authenticated Admin can execute but an unrelated Advisor cannot read the adjustment',async()=>{
   const id=await order();await pay(id,13.98);
   await db.exec('grant select on orders to authenticated;set role authenticated');
   await close(id,0.02);
   assert.equal(Number((await db.query('select count(*) n from order_balance_adjustments_v1 where order_id=$1',[id])).rows[0].n),1);
   await db.exec("set test.role='advisor';set test.uid='00000000-0000-0000-0000-000000000002'");
   assert.equal(Number((await db.query('select count(*) n from order_balance_adjustments_v1 where order_id=$1',[id])).rows[0].n),0);
   await db.exec("set test.uid='"+actor+"'");
   assert.equal(Number((await db.query('select count(*) n from order_balance_adjustments_v1 where order_id=$1',[id])).rows[0].n),1);
   await db.exec("reset role;set test.role='admin'");
  });
 } finally {await db.close();}
});
