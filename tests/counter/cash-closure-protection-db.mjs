// Isolated PostgreSQL only. No production credentials or writes.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
let PGlite;
try { ({ PGlite } = await import('@electric-sql/pglite')); }
catch { ({ PGlite } = await import('../../outputs/crm-auto-link-test-runtime/node_modules/@electric-sql/pglite/dist/index.js')); }
const db = new PGlite();
const read = path => readFileSync(new URL('../../' + path, import.meta.url), 'utf8');
await db.exec(`
create schema app_private; create schema auth;
create role anon; create role authenticated; create role service_role;
create type user_role as enum ('admin','counter','master');
create function auth.uid() returns uuid language sql as $$select '00000000-0000-0000-0000-000000000001'::uuid$$;
create function public.has_role(text) returns boolean language sql as $$select true$$;
create function public.is_master_or_admin() returns boolean language sql as $$select true$$;
create function public.is_counter_direct_money_account(bigint) returns boolean language sql as $$select true$$;
create function public.counter_amount_usd(text,numeric,numeric) returns numeric language sql as $$select case when $1='USD' then $2 else round($2/$3,2) end$$;
create function app_private.reconciled_observed_amount_v1(bigint,numeric,timestamptz,timestamptz,boolean default false) returns numeric language sql as $$select $2$$;
create function public.counter_claim_command(uuid,text,bigint,bigint,jsonb) returns table(existing_result jsonb,receipt_id bigint) language sql as $$select null::jsonb,1::bigint$$;
create function public.counter_complete_command(bigint,jsonb) returns jsonb language sql as $$select $2$$;
`);
await db.exec(read('tests/counter/fixtures/cash-closure-functions.sql'));
await db.exec(`
create function public.void_account_closure_v1(bigint,text) returns jsonb language sql as $$select app_private.void_account_closure_v1($1,$2)$$;
insert into money_accounts(id,name,currency_code,account_kind,is_active) values (7,'Caja prueba USD','USD','cash',true),(8,'Caja prueba VES','VES','cash',true),(9,'Banco','USD','bank',true);
insert into money_account_closure_profiles(money_account_id,closure_kind,requires_zero_difference,allows_classified_difference,baseline_required) values(7,'cash',true,false,true),(8,'cash',true,false,true);
insert into money_account_payment_rules(money_account_id,role,payment_method_code,can_confirm_payment,is_active) values(7,'counter','cash_usd',true,true),(8,'counter','cash_ves',true,true);
insert into user_roles values(auth.uid(),'admin',now());
insert into money_account_closure_baselines(money_account_id,baseline_date,baseline_at,counted_amount,counted_amount_usd,status) values(7,'2020-01-01','2020-01-01 20:00Z',79,79,'active'),(8,'2020-01-01','2020-01-01 20:00Z',1000,10,'active');
insert into money_movements(id,money_account_id,movement_date,created_at,confirmed_at,status,direction,movement_type,currency_code,amount,amount_usd_equivalent,order_id) values
 (10,7,'2020-01-02','2020-01-02 17:00Z','2020-01-02 17:00Z','confirmed','outflow','change_given','USD',10,10,1),
 (11,7,'2020-01-02','2020-01-02 20:00Z','2020-01-02 20:00Z','confirmed','inflow','order_payment','USD',40,40,1),
 (12,8,'2020-01-02','2020-01-02 17:00Z','2020-01-02 17:00Z','confirmed','inflow','order_payment','VES',100,1,2);
insert into money_account_closures(id,money_account_id,closure_date,closure_at,created_at,counted_amount,expected_amount,difference_amount,counted_amount_usd,expected_amount_usd,difference_amount_usd,currency_code,status)
 values(20,7,'2020-01-02','2020-01-02 19:04Z','2020-01-02 19:05Z',69,69,0,69,69,0,'USD','recorded'),(21,8,'2020-01-02','2020-01-02 19:04Z','2020-01-02 19:05Z',1100,1100,0,11,11,0,'VES','recorded');
create table orders(id bigint,total numeric,debt numeric);
insert into orders values(1,30.5,0.5);
`);
const original = (await db.query('select jsonb_agg(to_jsonb(m) order by id) snapshot from money_movements m')).rows[0].snapshot;
const migration = read('supabase/migrations/20261030203717_cash_closed_period_protection.sql');
await db.exec(migration);
let checks = 0;
async function rejected(sql, pattern = /cierre/i) {
  await assert.rejects(db.exec(sql), pattern); checks++;
}
for (const set of ["amount=9.5", "amount_usd_equivalent=9.5", "status='voided'", "money_account_id=9", "movement_date='2020-01-03'", "confirmed_at='2020-01-03'", "currency_code='VES'", "direction='inflow'"]) {
  await rejected(`update money_movements set ${set} where id=10`);
}
await rejected('delete from money_movements where id=10');
await rejected('update money_movements set amount=101 where id=12');
await rejected("update money_movements set confirmed_at='2020-01-02 18:00Z' where id=11");
await rejected("insert into money_movements(money_account_id,movement_date,created_at,confirmed_at,status,amount) values(7,'2020-01-01',now(),now(),'confirmed',2)");
assert.deepEqual((await db.query('select jsonb_agg(to_jsonb(m) order by id) snapshot from money_movements m')).rows[0].snapshot, original);
assert.equal(Number((await db.query('select debt from orders where id=1')).rows[0].debt), 0.5);
checks += 2;
await db.exec("update money_movements set notes='Nota sin cambio de dinero' where id=10");
await db.exec("update money_movements set amount=40,amount_usd_equivalent=40 where id=11");
checks += 2;
const balance = async () => Number((await db.query("select (a->>'balance')::numeric balance from jsonb_array_elements(counter_read_cash_snapshot()) a where a->>'accountId'='7'")).rows[0].balance);
assert.equal(await balance(),109); checks++;
await rejected("insert into money_account_closures(money_account_id,closure_date,closure_at,created_at,counted_amount,expected_amount,expected_amount_usd,currency_code,status) values(7,'2020-01-02','2020-01-02 20:30Z',now(),109.5,109.5,109.5,'USD','recorded')", /saldo cambió/);
await db.exec('begin');
await db.exec('update orders set debt=0 where id=1');
await rejected("update money_movements set status='voided' where id=10");
await db.exec('rollback');
assert.equal(Number((await db.query('select debt from orders where id=1')).rows[0].debt),0.5); checks++;
await rejected('update money_account_closures set counted_amount=69.5 where id=20');
await rejected('delete from money_account_closures where id=20');
await rejected("update money_account_closures set status='rejected' where id=20", /auditoría/);
assert.equal((await db.query('select status from money_account_closures where id=20')).rows[0].status,'recorded'); checks++;
await db.exec("select counter_close_money_account('00000000-0000-0000-0000-000000000010',7,'2020-01-02 21:00Z',109,null,'Cierre prueba',null)");
await rejected("select void_account_closure_v1(20,'Corrección de prueba')", /posteriores/);
const last = (await db.query("select id from money_account_closures where money_account_id=7 order by closure_at desc limit 1")).rows[0].id;
await db.exec(`select void_account_closure_v1(${last},'Corrección de prueba')`);
await rejected('update money_movements set amount=9.5 where id=10');
await db.exec("select void_account_closure_v1(20,'Corrección de prueba')");
await db.exec("select void_account_closure_v1(20,'Corrección de prueba')");
assert.equal(Number((await db.query('select count(*) n from account_closure_reversals where closure_id=20')).rows[0].n),1); checks++;
await db.exec('update money_movements set amount=9.5,amount_usd_equivalent=9.5 where id=10');
assert.equal(await balance(),109.5); checks++;
await db.exec("select counter_close_money_account('00000000-0000-0000-0000-000000000011',7,'2020-01-02 22:00Z',109.5,null,'Cierre corregido',null)");
assert.equal(await balance(),109.5); checks++;
assert.equal(Number((await db.query('select count(*) n from money_movements')).rows[0].n),3);
assert.equal(Number((await db.query('select debt from orders where id=1')).rows[0].debt),0.5);
checks += 2;
console.log(`PASS ${checks} closure protection checks: USD/VES, correction, void, delete, old insert, metadata, canonical cut, audited reversal, repeat, no duplicate ledger, no order writes.`);
await db.close();
