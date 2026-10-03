import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const db = new PGlite();
const migration = await readFile(new URL('../../supabase/migrations/20261003151824_delivered_order_customer_prices.sql', import.meta.url), 'utf8');
const actor = '00000000-0000-0000-0000-000000000001';
const stamp = '2026-10-03T10:00:00Z';
const operation = '00000000-0000-0000-0000-000000000002';
await db.exec(`
create role anon; create role authenticated; create schema auth; create schema app_private;
create function auth.uid() returns uuid language sql as $$select nullif(current_setting('test.uid',true),'')::uuid$$;
create function auth.jwt() returns jsonb language sql as $$select '{"role":"authenticated"}'::jsonb$$;
create function has_role(text) returns boolean language sql as $$select coalesce(current_setting('test.admin',true),'false')='true'$$;
create function is_admin() returns boolean language sql as $$select public.has_role('admin')$$;
create function is_master_or_admin() returns boolean language sql as $$select public.has_role('admin')$$;
create table orders(id bigint primary key, status text, source text, client_id bigint, attributed_advisor_id uuid, created_at timestamptz, last_modified_at timestamptz, last_modified_by uuid, total_usd numeric, total_bs_snapshot numeric,extra_fields jsonb);
create table products(id bigint primary key,name text,sku text,type text,is_active boolean,base_price_usd numeric,base_price_bs numeric,source_price_currency text,source_price_amount numeric,extra_fields jsonb);
create table order_items(id bigint primary key,order_id bigint,product_id bigint,qty numeric,product_name_snapshot text,sku_snapshot text,notes text,unit_price_usd_snapshot numeric,line_total_usd numeric,unit_price_bs_snapshot numeric,line_total_bs_snapshot numeric,pricing_origin_currency text,pricing_origin_amount numeric,pricing_fx_rate_snapshot numeric,admin_price_override_usd numeric,admin_price_override_reason text,admin_price_override_by_user_id uuid,admin_price_override_at timestamptz,override_unit_price_usd numeric,override_reason text,override_approved_by uuid,override_approved_at timestamptz,crm_play_member_id bigint,crm_play_benefit_id bigint,crm_play_benefit_upgrade_id bigint);
create table advisor_commission_periods(id bigint primary key,date_from date,date_to date,status text);
create table advisor_commission_closures(id bigint primary key,period_id bigint,advisor_user_id uuid,status text,closed_at timestamptz,paid_at timestamptz,snapshot jsonb);
create table money_movements(id bigint primary key,status text,direction text,movement_type text,description text,amount numeric);
create table payment_reports(id bigint,amount numeric,status text);
create table inventory_movements(id bigint,qty numeric);
create table client_fund_movements(id bigint,amount numeric);
create table order_admin_adjustments(id bigint generated always as identity primary key,order_id bigint,order_item_id bigint,adjustment_type text,reason text,payload jsonb,created_by_user_id uuid,created_at timestamptz);
create function get_order_financial_state(bigint,date,numeric) returns table(delivery_reference_date date) language sql as $$select '2026-10-03'::date$$;
grant usage on schema public,auth to authenticated;
grant select,update on orders,order_items,advisor_commission_periods,advisor_commission_closures to authenticated;
grant select on products,money_movements,order_admin_adjustments to authenticated;
grant insert on order_admin_adjustments to authenticated;
grant usage on sequence order_admin_adjustments_id_seq to authenticated;
`);
await db.exec(migration);
// Same CRM guard as production: inactive delivered products must remain editable
// only through monetary columns; benefits and structural attributes stay protected.
await db.exec('create trigger crm_order_items_guard before insert or update on order_items for each row execute function app_private.crm_order_item_guard_v1()');
await db.exec('alter table orders add column is_price_locked boolean default false; create function is_master() returns boolean language sql as $$select false$$');
await db.exec(await readFile(new URL('./fixtures/delivered-pricing-triggers.sql',import.meta.url),'utf8'));

async function reset() {
  await db.exec(`reset role; truncate orders,products,order_items,advisor_commission_periods,advisor_commission_closures,money_movements,payment_reports,inventory_movements,client_fund_movements,order_admin_adjustments restart identity;
    set test.uid='${actor}'; set test.admin='true';
    insert into products values(1,'Producto','SKU','simple',true,5,4300,'USD',5,'{}'),(2,'Delivery','DEL','simple',true,3,2580,'USD',3,'{}');
    insert into orders values(1,'delivered','advisor',1,'${actor}','2026-10-03','${stamp}',null,13,11180,'{"pricing":{"fx_rate":860,"total_usd":13,"total_bs":11180},"schedule":{"date":"2026-10-03"},"payment":{"client_fund_used_usd":1}}',false);
    insert into order_items(id,order_id,product_id,qty,product_name_snapshot,sku_snapshot,notes,unit_price_usd_snapshot,line_total_usd,unit_price_bs_snapshot,line_total_bs_snapshot,pricing_origin_currency,pricing_origin_amount,pricing_fx_rate_snapshot) values(1,1,1,2,'Producto','SKU','Detalle',5,10,4300,8600,'USD',5,860),(2,1,2,1,'Delivery','DEL',null,3,3,2580,2580,'USD',3,860);
    insert into advisor_commission_periods values(1,'2026-09-28','2026-10-04','open');
    insert into advisor_commission_closures values(1,1,'${actor}','preliminary',null,null,'{"orders":[{"orderId":1}]}');
    insert into money_movements values(1,'confirmed','inflow','order_payment','Pago original',20);
    insert into payment_reports values(1,20,'confirmed'); insert into inventory_movements values(1,-2); insert into client_fund_movements values(1,1);
  `);
}
async function save(changes=[{itemId:1,unitPriceUsd:4}], expected=stamp, op=operation, reason='Corrección de precio') {
  return (await db.query('select save_delivered_order_prices_v1($1,$2,$3,$4,$5) result',[1,expected,op,JSON.stringify(changes),reason])).rows[0].result;
}
async function snapshot() { return (await db.query("select jsonb_build_object('money',(select jsonb_agg(m) from money_movements m),'reports',(select jsonb_agg(r) from payment_reports r),'inventory',(select jsonb_agg(i) from inventory_movements i),'fund',(select jsonb_agg(f) from client_fund_movements f)) data")).rows[0].data; }

test('delivered prices: atomic, authorized, customer-only adjustment', async(t)=>{
  try {
    await t.test('uses existing authenticated grants and preserves stock, payments, delivery, item IDs and unrelated metadata',async()=>{
      await reset(); const before=await snapshot(); await db.exec('set role authenticated');
      const result=await save(); assert.equal(result.totalUsd,11);assert.equal(result.totalBs,9460);assert.deepEqual(result.closures,[{id:1,periodId:1}]);
      await db.exec('reset role'); assert.deepEqual(await snapshot(),before);
      const order=(await db.query('select * from orders')).rows[0];assert.equal(order.status,'delivered');assert.equal(order.extra_fields.payment.client_fund_used_usd,1);
      const item=(await db.query('select * from order_items where id=1')).rows[0];assert.equal(item.qty,'2');assert.equal(item.notes,'Detalle');assert.equal(item.admin_price_override_usd,'4');
      const audit=(await db.query('select * from order_admin_adjustments')).rows[0];assert.equal(audit.created_by_user_id,actor);assert.equal(audit.payload.before.total_usd,13);assert.equal(audit.payload.after.total_usd,11);
    });
    await t.test('retry returns the same result; edited payload cannot reuse the operation',async()=>{
      await reset(); const first=await save();assert.deepEqual(await save(),first);assert.equal((await db.query('select count(*) n from order_admin_adjustments')).rows[0].n,1);
      await assert.rejects(save([{itemId:1,unitPriceUsd:6}]),/otro ajuste/);
    });
    await t.test('discount and tax are recomputed; delivery customer price is also editable',async()=>{
      await reset();await db.exec(`update orders set extra_fields=jsonb_set(extra_fields,'{pricing}',extra_fields->'pricing'||'{"discount_enabled":true,"discount_pct":10,"invoice_tax_pct":16}')`);
      const result=await save([{itemId:2,unitPriceUsd:5}]);assert.equal(result.totalUsd,15.66);assert.equal(result.totalBs,13467.6);
    });
    await t.test('VES-origin lines become explicit authorized USD prices; same stored FX, not current catalog',async()=>{
      await reset();await db.exec("update order_items set pricing_origin_currency='VES',pricing_origin_amount=4300 where id=1");
      const result=await save([{itemId:1,unitPriceUsd:5.25}]);assert.equal(result.totalUsd,13.5);assert.equal(result.totalBs,11610);
      const row=(await db.query('select * from order_items where id=1')).rows[0];assert.equal(row.pricing_origin_currency,'USD');assert.equal(row.pricing_origin_amount,'5.25');
    });
    await t.test('inactive historic products permit only price correction',async()=>{
      await reset();await db.exec('update products set is_active=false where id=1');assert.equal((await save()).totalUsd,11);
      await assert.rejects(db.exec('update order_items set qty=3 where id=1'),/disponible/);
    });
    for(const [label,sql,pattern] of [
      ['master/advisor',"set test.admin='false'",/administración/],['anonymous','set role anon',/permission denied/],
      ['missing identity',"set test.uid=''",/administración/],['closed period',"update advisor_commission_periods set status='closed'",/cerrado/],
      ['paid commission',"update advisor_commission_closures set paid_at=now()",/liquidación/i],
      ['confirmed conformity',`update advisor_commission_closures set snapshot=snapshot||'{"commissionWorkflow":{"conformity":{"status":"confirmed"}}}'`,/liquidación/i],
      ['cancelled order',"update orders set status='cancelled'",/entregados/],['event extension',`update orders set extra_fields=extra_fields||'{"event_extension":{}}'`,/presupuesto/],
      ['zero rate',`update orders set extra_fields=jsonb_set(extra_fields,'{pricing,fx_rate}','0')`,/tasa/],
      ['CRM benefit',"alter table order_items disable trigger crm_order_items_guard; update order_items set crm_play_member_id=1 where id=1",/jugada/],
      ['gift',`update products set source_price_amount=0,extra_fields='{"catalog_access_scope":"advisor_gift"}' where id=1`,/obsequio/],
    ]) await t.test(`rejects ${label} without writes`,async()=>{await reset();await db.exec(sql);await assert.rejects(save(),pattern);await db.exec('reset role; alter table order_items enable trigger crm_order_items_guard');assert.equal((await db.query('select count(*) n from order_admin_adjustments')).rows[0].n,0);});
    for(const [label,changes] of [
      ['foreign item',[{itemId:100,unitPriceUsd:4}]],['duplicate',[{itemId:1,unitPriceUsd:4},{itemId:1,unitPriceUsd:5}]],
      ['negative',[{itemId:1,unitPriceUsd:-1}]],['excess precision',[{itemId:1,unitPriceUsd:4.001}]],
      ['invalid second item',[{itemId:1,unitPriceUsd:4},{itemId:100,unitPriceUsd:5}]],
    ])await t.test(`${label} rolls back the complete adjustment`,async()=>{await reset();await assert.rejects(save(changes));assert.equal((await db.query('select total_usd from orders')).rows[0].total_usd,'13');assert.equal((await db.query('select line_total_usd from order_items where id=1')).rows[0].line_total_usd,'10');});
    await t.test('stale editor is rejected',async()=>{await reset();await assert.rejects(save(undefined,'2026-10-02'),/pedido cambió/);});
  } finally {await db.close();}
});
