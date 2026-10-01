// Run with PGLITE_MODULE_PATH pointing to an installed @electric-sql/pglite module.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const modulePath = process.env.PGLITE_MODULE_PATH;
if (!modulePath) throw new Error('Set PGLITE_MODULE_PATH to @electric-sql/pglite/dist/index.js');
const { PGlite } = await import(pathToFileURL(modulePath).href);
const db = new PGlite();
const migration = await readFile(new URL('../../supabase/migrations/20261001162624_delivered_order_commission_adjustments.sql', import.meta.url), 'utf8');
const advisor = '00000000-0000-0000-0000-000000000001';
const stamp = '2026-10-01T10:00:00Z';
await db.exec(`
create role anon; create role authenticated;
create schema auth;
create function auth.uid() returns uuid language sql as $$select nullif(current_setting('test.uid', true), '')::uuid$$;
create function public.has_role(text) returns boolean language sql as $$select current_setting('test.admin', true) = 'true'$$;
create table public.orders(id bigint primary key, attributed_advisor_id uuid, status text, created_at timestamptz, last_modified_at timestamptz, last_modified_by uuid, total_usd numeric, extra_fields jsonb);
create table public.products(id bigint primary key, commission_mode text, commission_value numeric, extra_fields jsonb);
create table public.order_items(id bigint primary key, order_id bigint, product_id bigint, product_name_snapshot text, qty numeric, line_total_usd numeric);
create table public.advisor_commission_periods(id bigint primary key, date_from date, date_to date, status text);
create table public.advisor_commission_closures(id bigint primary key, period_id bigint, advisor_user_id uuid, status text, closed_at timestamptz, paid_at timestamptz, snapshot jsonb);
create table public.money_movements(id bigint primary key, status text, direction text, movement_type text, description text, amount_usd_equivalent numeric);
create table public.order_admin_adjustments(id bigint generated always as identity primary key, order_id bigint, order_item_id bigint, adjustment_type text, reason text, payload jsonb, created_by_user_id uuid, created_at timestamptz);
create function public.get_order_financial_state(bigint,date,numeric) returns table(delivery_reference_date date) language sql as $$select '2026-09-20'::date$$;
grant usage on schema public,auth to authenticated;
grant select,update on public.orders, public.advisor_commission_closures,public.advisor_commission_periods to authenticated;
grant select on public.products,public.order_items,public.money_movements,public.order_admin_adjustments to authenticated;
grant insert on public.order_admin_adjustments to authenticated;
grant usage on sequence public.order_admin_adjustments_id_seq to authenticated;
`);
await db.exec(migration);

async function reset() {
  await db.exec(`reset role; truncate orders,products,order_items,advisor_commission_periods,advisor_commission_closures,money_movements,order_admin_adjustments restart identity;
    set test.uid='${advisor}'; set test.admin='true';
    insert into orders values(1,'${advisor}','delivered','2026-09-01','${stamp}',null,50,'{"schedule":{"date":"2026-09-01"}}');
    insert into products values(1,'default',null,'{"commission_schedule_v1":[{"effective_from":"2026-09-16","mode":"fixed_item","value":5}]}'),(2,'default',null,'{}');
    insert into order_items values(1,1,1,'Bebida',1,20),(2,1,2,'Producto',1,30),(3,2,1,'Otra orden',1,9);
    insert into advisor_commission_periods values(1,'2026-09-16','2026-09-30','open');
    insert into advisor_commission_closures values(1,1,'${advisor}','preliminary',null,null,'{"orders":[{"orderId":1}]}');`);
}
const change = (itemId = 1, mode = 'fixed_item', value = 4) => ({ itemId, action: 'set', mode, value });
async function save(changes = [change()], expected = stamp, reason = 'Acuerdo comercial') {
  return db.query('select public.save_delivered_order_commissions_v1($1,$2,$3,$4) result', [1, expected, JSON.stringify(changes), reason]);
}

test('delivered order commission command: atomic, authorized and metadata-only', async (t) => {
  try {
    await t.test('admin saves with existing RLS grants; no prices, delivery or movements change', async () => {
      await reset();
      const before = (await db.query('select to_jsonb(i) row from order_items i order by id')).rows;
      await db.exec('set role authenticated');
      const result = await save();
      assert.equal(result.rows[0].result.updated, 1);
      assert.deepEqual(result.rows[0].result.closures, [{ id: 1, periodId: 1 }]);
      assert.deepEqual((await db.query('select to_jsonb(i) row from order_items i order by id')).rows, before);
      const order = (await db.query('select * from orders')).rows[0];
      assert.equal(order.total_usd, '50'); assert.equal(order.status, 'delivered');
      assert.equal((await db.query('select count(*) n from money_movements')).rows[0].n, 0);
      assert.equal((await db.query('select created_by_user_id,reason from order_admin_adjustments')).rows[0].created_by_user_id, advisor);
    });
    for (const setting of ['set test.admin=\'false\'', 'set test.uid=\'\'']) {
      await t.test(`rejects unauthorized caller: ${setting}`, async () => { await reset(); await db.exec(setting); await assert.rejects(save(), /administración/); });
    }
    await t.test('anonymous cannot execute', async () => { await reset(); await db.exec('set role anon'); await assert.rejects(save(), /permission denied/); });
    await t.test('rejects stale form', async () => { await reset(); await assert.rejects(save([change()], '2026-09-30'), /pedido cambió/); });
    await t.test('rejects non-delivered order', async () => { await reset(); await db.exec("update orders set status='ready'"); await assert.rejects(save(), /entregados/); });
    for (const [label, update] of [
      ['closed period', "update advisor_commission_periods set status='closed'"],
      ['confirmed closure', "update advisor_commission_closures set status='closed'"],
      ['conformity', `update advisor_commission_closures set snapshot=snapshot || '{"commissionWorkflow":{"conformity":{"status":"confirmed"}}}'`],
      ['payment', "insert into money_movements values(1,'confirmed','outflow','expense_payment','Liquidación de comisión · Cierre 1 · Abono',10)"],
      ['reassigned snapshot member', `update orders set attributed_advisor_id=null; update advisor_commission_closures set status='paid'`],
    ]) await t.test(`protects ${label}`, async () => { await reset(); await db.exec(update); await assert.rejects(save(), /cerrado|confirmada/); });
    for (const [label, changes] of [
      ['foreign item', [change(3)]], ['duplicate', [change(),change()]], ['invalid percent', [change(1,'fixed_item',101)]],
      ['conflicting whole-order rates', [change(1,'fixed_order',4),change(2,'fixed_order',5)]],
      ['invalid second row', [change(),change(3)]],
    ]) await t.test(`rejects ${label} with complete rollback`, async () => {
      await reset(); await assert.rejects(save(changes));
      assert.equal((await db.query('select count(*) n from order_admin_adjustments')).rows[0].n, 0);
      assert.equal(new Date((await db.query('select last_modified_at from orders')).rows[0].last_modified_at).toISOString(), new Date(stamp).toISOString());
    });
    await t.test('clear restores event precedence and rejects conflicting inherited whole-order rate', async () => {
      await reset();
      await db.exec(`insert into order_admin_adjustments(order_id,order_item_id,adjustment_type,payload,created_at) values
        (1,1,'other','{"kind":"event_commercial_terms","commission_mode":"fixed_order","commission_value":7}','2026-09-01'),
        (1,1,'other','{"kind":"order_commission_terms","action":"set","commission_mode":"none"}','2026-09-02');`);
      await assert.rejects(save([{ itemId:1,action:'clear' },change(2,'fixed_order',5)]), /dos porcentajes/);
      await save([{ itemId:1,action:'clear' },change(2,'fixed_order',7)]);
      const audit = (await db.query('select payload from order_admin_adjustments where order_item_id=1 order by id desc limit 1')).rows[0].payload;
      assert.equal(audit.action, 'clear'); assert.equal(audit.previous_admin_adjustment.commission_mode, 'none');
    });
    await t.test('requires a reason even through direct RPC', async () => { await reset(); await assert.rejects(save([change()], stamp, ' '), /motivo/); });
  } finally { await db.close(); }
});
