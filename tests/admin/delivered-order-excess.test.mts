import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { canResolveOperationalOrderExcess } from "../../src/lib/orders/order-excess-policy.ts";

const migration = readFileSync("supabase/migrations/20261021190725_delivered_order_excess_admin_resolution.sql", "utf8");
const repair = readFileSync("supabase/repairs/order_3435_quote_coverage.sql", "utf8");
const actor = "00000000-0000-4000-8000-000000000001";

test("delivered excess is available to Admin without expanding Master's scope", () => {
  for (const status of ["created", "queued", "confirmed", "in_kitchen", "ready"]) {
    assert.equal(canResolveOperationalOrderExcess(status, false), true);
  }
  assert.equal(canResolveOperationalOrderExcess("delivered", true), true);
  assert.equal(canResolveOperationalOrderExcess("delivered", false), false);
  for (const status of ["cancelled", "out_for_delivery", "missing_items", "unknown"]) {
    assert.equal(canResolveOperationalOrderExcess(status, true), false);
  }
  const ui = readFileSync("src/components/orders/OrdersWorkspaceClient.tsx", "utf8");
  assert.match(ui, /activeTab === "pagos" &&\s*canResolveOperationalOrderExcess\(order.status, isAdmin\)/);
  assert.match(ui, /Saldo a favor de la orden:/);
});

async function fixture() {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create schema auth; create schema app_private;
    create function auth.uid() returns uuid language sql as $$select nullif(current_setting('test.uid',true),'')::uuid$$;
    create function public.has_role(text) returns boolean language sql as $$select coalesce(current_setting('test.role',true),'')=$1$$;
    create function public.is_master_or_admin() returns boolean language sql as $$select public.has_role('admin') or public.has_role('master')$$;
    create table orders(id bigint primary key,client_id bigint,status text,order_number text,total_usd numeric,total_bs_snapshot numeric,extra_fields jsonb);
    create table clients(id bigint primary key,fund_balance_usd numeric);
    create table money_movements(id bigint primary key,order_id bigint,payment_report_id bigint,money_account_id bigint,direction text,movement_type text,status text,currency_code text,amount numeric,amount_usd_equivalent numeric,exchange_rate_ves_per_usd numeric);
    create table payment_reports(id bigint primary key,order_id bigint,confirmed_movement_id bigint,status text,reported_amount numeric);
    create table order_change_obligations(order_id bigint,status text,amount_usd_equivalent numeric);
    create table client_fund_movements(id bigint generated always as identity primary key,client_id bigint,movement_type text,currency_code text,amount numeric,amount_usd numeric,order_id bigint,payment_report_id bigint,reason_code text,notes text,created_by_user_id uuid);
    create table order_timeline_events(order_id bigint,order_number text,event_type text,event_group text,title text,message text,actor_user_id uuid,payload jsonb);
    create table order_admin_adjustments(id bigint primary key,order_id bigint,payload jsonb);
    create table order_payment_precision_allocations(movement_id bigint primary key,order_id bigint,applied_usd numeric,cash_equivalent_usd numeric,rounding_usd numeric,pending_before_usd numeric,pending_before_bs numeric,native_amount numeric,currency_code text,coverage_rate numeric,operation_date date);
    create function public.get_order_financial_state(bigint,date,numeric)
      returns table(overpaid_usd numeric,pending_usd numeric,confirmed_paid_usd numeric)
      language sql stable as $$ select round(greatest(0,paid-o.total_usd-coalesce((select sum(amount_usd) from public.client_fund_movements where order_id=o.id),0)),2),greatest(0,o.total_usd-paid),round(paid,2)
      from public.orders o cross join lateral (select coalesce((select applied_usd from public.order_payment_precision_allocations where order_id=o.id),95.70) as paid) p where o.id=$1 $$;
    grant usage on schema public,auth to anon,authenticated;
    set test.uid='${actor}'; set test.role='admin';
    insert into orders values(3435,3718,'delivered','short-number-not-used-in-UI',92.80,81838.46,'{"pricing":{"fx_rate":881.88}}');
    insert into clients values(3718,0.99);
    insert into money_movements values(9413,3435,3597,10,'inflow','order_payment','confirmed','VES',84395.92,95.54,883.40);
    insert into payment_reports values(3597,3435,9413,'confirmed',84395.92);
    insert into order_admin_adjustments values(903,3435,'{"before":{"extra_fields":{"pricing":{"total_usd":95.70,"total_bs":84395.92,"fx_rate":881.88}}}}');
  `);
  const previous = readFileSync("supabase/migrations/20261004190450_prehandoff_operational_item_changes.sql", "utf8");
  await db.exec(previous.slice(previous.indexOf("create or replace function public.store_operational_order_excess_v1("), previous.lastIndexOf("commit;")));
  await db.exec(migration);
  return db;
}

test("Postgres excess resolution: privileges, reservations, replay and rollback", async (t) => {
  const db = await fixture();
  const save = async () => (await db.query<{v:{amountUsd:number}}>("select public.store_operational_order_excess_v1(3435,'Corrección de delivery') v")).rows[0].v;
  try {
    await t.test("anon cannot execute; advisors and Master cannot resolve delivered excess", async () => {
      await db.exec("set role anon"); await assert.rejects(save(), /permission denied/);
      await db.exec("reset role; set role authenticated; set test.role='advisor'");
      await assert.rejects(save(), /Solo Máster/);
      await db.exec("set test.role='master'"); await assert.rejects(save(), /resolución operativa/);
      await db.exec("reset role; set test.role='admin'");
      assert.equal((await db.query("select count(*) n from client_fund_movements")).rows[0].n, 0);
    });
    await t.test("Master keeps existing pre-delivery permissions; cancelled and in-transit stay blocked", async () => {
      for (const status of ["cancelled", "out_for_delivery"]) {
        await db.query("update orders set status=$1", [status]); await assert.rejects(save(), /resolución operativa/);
      }
      await db.exec("begin; update orders set status='ready'; set local test.role='master'; set local role authenticated");
      assert.equal((await save()).amountUsd, 2.90); await db.exec("rollback");
      await db.exec("update orders set status='delivered'");
    });
    await t.test("unbacked excess rolls back without partial credits", async () => {
      await db.exec("update money_movements set amount_usd_equivalent=1");
      await assert.rejects(save(), /No se guardó nada/);
      assert.equal((await db.query("select count(*) n from client_fund_movements")).rows[0].n, 0);
      assert.equal((await db.query("select fund_balance_usd from clients")).rows[0].fund_balance_usd, "0.99");
      await db.exec("update money_movements set amount_usd_equivalent=95.54");
    });
    await t.test("Admin credits only the unreserved remainder; retry does not duplicate", async () => {
      await db.exec("insert into order_change_obligations values(3435,'pending',1); insert into money_movements values(9414,3435,null,10,'outflow','withdrawal','pending','USD',0.50,0.50,883.40)");
      const before = (await db.query("select jsonb_agg(m order by id) snapshot from money_movements m")).rows;
      await db.exec("set role authenticated");
      assert.equal((await save()).amountUsd, 1.40); assert.equal((await save()).amountUsd, 0);
      await db.exec("reset role");
      assert.deepEqual((await db.query("select jsonb_agg(m order by id) snapshot from money_movements m")).rows, before);
      assert.equal((await db.query("select count(*) n from client_fund_movements")).rows[0].n, 1);
      assert.equal((await db.query("select payment_report_id from client_fund_movements")).rows[0].payment_report_id, 3597);
      assert.equal((await db.query("select fund_balance_usd from clients")).rows[0].fund_balance_usd, "2.39");
    });
  } finally { await db.close(); }
});

test("#3435 repair covers the agreed quote exactly, preserves cash and is auditable/idempotent", async () => {
  const db = await fixture();
  try {
    const precision = readFileSync("supabase/migrations/20260915001157_order_collection_precision_v1.sql", "utf8");
    await db.exec(precision.slice(precision.indexOf("create function app_private.collection_payment_allocation_v1("), precision.indexOf("revoke all on function app_private.collection_payment_allocation_v1(")));
    await db.exec("insert into order_payment_precision_allocations values(9413,3435,84395.92/883.40,95.54,0,95.70,84541.38,84395.92,'VES',883.40,'2026-10-20')");
    const snapshot = async () => (await db.query("select jsonb_build_object('money',(select jsonb_agg(m) from money_movements m),'reports',(select jsonb_agg(r) from payment_reports r),'orders',(select jsonb_agg(o) from orders o),'clients',(select jsonb_agg(c) from clients c)) snapshot")).rows;
    const before = await snapshot();
    // Refuse changed evidence and roll back the complete operation.
    await db.exec("update money_movements set amount=84395.91");
    await assert.rejects(db.exec(repair), /evidencia.*cambió/); await db.exec("rollback");
    await db.exec("update money_movements set amount=84395.92");
    await db.exec(repair); await db.exec(repair);
    assert.deepEqual(await snapshot(), before);
    const allocation = (await db.query("select * from order_payment_precision_allocations")).rows[0];
    assert.equal(Number(allocation.applied_usd), 95.70); assert.equal(allocation.coverage_rate, "881.88");
    assert.equal(allocation.cash_equivalent_usd, "95.54"); assert.equal(allocation.native_amount, "84395.92");
    assert.equal((await db.query("select overpaid_usd from get_order_financial_state(3435,null,null)")).rows[0].overpaid_usd, "2.90");
    const events = (await db.query("select * from order_timeline_events")).rows;
    assert.equal(events.length, 1); assert.equal(events[0].actor_user_id, null);
    assert.equal((await db.query("select count(*) n from client_fund_movements")).rows[0].n, 0);
  } finally { await db.close(); }
});
