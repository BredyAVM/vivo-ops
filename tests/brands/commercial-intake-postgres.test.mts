import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';

const migration = 'supabase/migrations/20261030175530_commercial_channels_clients_v1.sql';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const read = (p: string) => readFileSync(p, 'utf8');
function extractFunction(sql: string, name: string) {
  const start = sql.indexOf('create or replace function ' + name + '(');
  assert.notEqual(start, -1, name);
  const end = sql.indexOf('$function$;', start);
  assert.notEqual(end, -1, name);
  return sql.slice(start, end + '$function$;'.length);
}

test('commercial intake preserves VIVO and records channels and direct clients atomically', async t => {
  const db = new PGlite();
  try {
    await db.exec(read('tests/brands/fixtures/commercial-intake-schema.sql'));
    const oldCounter = read('supabase/migrations/20260727181211_counter_block_7_atomic_direct_sale.sql');
    await db.exec(extractFunction(oldCounter, 'public.counter_create_direct_sale').replace(
      'public.counter_create_direct_sale(', 'public.counter_create_direct_sale_without_commercial_guard_v1('));
    await db.exec(extractFunction(oldCounter, 'public.trg_order_items_set_pricing'));
    await db.exec(`create trigger test_existing_pricing before insert or update on public.order_items for each row execute function public.trg_order_items_set_pricing();
      revoke all on function public.counter_create_direct_sale_without_commercial_guard_v1(uuid,jsonb)from public,anon;
      grant execute on function public.counter_create_direct_sale_without_commercial_guard_v1(uuid,jsonb)to authenticated;`);
    const assignment = read('supabase/migrations/20260822022047_client_primary_advisor_assignment_v1.sql');
    await db.exec(extractFunction(assignment, 'app_private.rescue_orphan_client_from_live_order_v1'));
    await db.exec(`create trigger test_existing_advisor_rescue after insert or update of attributed_advisor_id,status on public.orders
      for each row execute function app_private.rescue_orphan_client_from_live_order_v1();`);
    const auth = async (n = 1, role = 'authenticated') => {
      await db.exec('reset role');
      await db.query("select set_config('request.jwt.claim.sub',$1,false)", [n ? id(n) : '']);
      await db.exec('set role ' + role);
    };
    const one = async <T = unknown>(sql: string, args: unknown[] = []) => (await db.query<{ v: T }>(sql, args)).rows[0]?.v;
    const sale = (payload: Record<string, unknown>, key = randomUUID()) => one<{ id: number; clientId: number; clientCreated: boolean; sentToKitchen: boolean }>(
      'select public.counter_create_direct_sale_without_commercial_guard_v1($1,$2)as v', [key, payload]);
    const payload = (phone: string, patch: Record<string, unknown> = {}) => ({
      clientName: 'Cliente de prueba', clientPhone: phone, clientType: 'own', scheduleAsap: true,
      fulfillment: 'pickup', paymentMethod: 'pos', paymentCurrency: 'VES',
      items: [{ productId: 1, qty: 2 }, { productId: 2, qty: 1 }], ...patch,
    });
    const money = (order: number) => one(`select jsonb_build_object('usd',o.total_usd,'bs',o.total_bs_snapshot,'status',o.status,'source',o.source,
      'attributed',o.attributed_advisor_id,'pricing',o.extra_fields->'pricing','items',(select jsonb_agg(jsonb_build_array(product_id,qty,line_total_usd,line_total_bs_snapshot,pricing_origin_currency,pricing_origin_amount)order by id)from public.order_items where order_id=o.id))as v from public.orders o where o.id=$1`, [order]);
    await auth(5);
    const oldSale = await sale(payload('584120009000', { hasInvoice: true, invoiceTaxPct: '16' }));
    const oldMoney = await money(oldSale.id);
    await db.exec('reset role');
    const historicalClients = await db.query('select * from public.clients order by id');
    const historicalOrders = await one("select jsonb_agg(to_jsonb(o)order by id)as v from public.orders o");
    const paid = await db.query('select * from public.advisor_commission_closures');
    const payments = await db.query('select * from public.order_payments');
    await db.exec(read(migration));

    await t.test('installation leaves all existing classifications, advisors, orders and paid history untouched', async () => {
      assert.deepEqual(await db.query('select * from public.clients order by id'), historicalClients);
      assert.deepEqual(await one("select jsonb_agg(to_jsonb(o)-'sales_channel'order by id)as v from public.orders o"), historicalOrders);
      assert.equal(await one('select count(*)::int as v from public.orders where sales_channel is not null'), 0);
      assert.deepEqual(await db.query('select * from public.advisor_commission_closures'), paid);
      assert.deepEqual(await db.query('select * from public.order_payments'), payments);
      assert.equal(await one('select count(*)::int as v from app_private.client_commercial_type_history_v1'), 0);
    });
    await t.test('real Counter command returns identical mixed-currency VIVO prices and tax before and after', async () => {
      await auth(5);
      const created = await sale(payload('584120009001', { hasInvoice: true, invoiceTaxPct: '16' }));
      assert.deepEqual(await money(created.id), oldMoney);
      assert.equal(await one('select client_type as v from public.clients where id=$1', [created.clientId]), 'direct');
      assert.equal(await one('select sales_channel as v from public.orders where id=$1', [created.id]), 'in_person');
      assert.equal(created.sentToKitchen, true);
      await db.exec('reset role');
      assert.deepEqual(await db.query('select * from public.order_payments'), payments);
      assert.deepEqual(await db.query('select * from public.advisor_commission_closures'), paid);
    });
    await t.test('both cashiers can take either channel with one shared customer identity', async () => {
      let client: number | null = null;
      for (const operator of [5, 6]) for (const channel of ['in_person', 'whatsapp']) {
        await auth(operator);
        const created = await sale(payload('584120009002', { salesChannel: channel }));
        if (client === null) client = created.clientId;
        assert.equal(created.clientId, client);
        assert.equal(await one('select sales_channel as v from public.orders where id=$1', [created.id]), channel);
        assert.equal(await one<string>('select created_by_user_id::text as v from public.orders where id=$1', [created.id]), id(operator));
      }
      await db.exec('reset role');
      assert.equal(await one('select count(*)::int as v from public.clients where phone=$1', ['584120009002']), 1);
      assert.equal(await one('select count(*)::int as v from app_private.client_commercial_type_history_v1 where client_id=$1', [client]), 1);
    });
    await t.test('existing own, assigned, legacy and unclassified clients retain type and advisor on both channels', async () => {
      await auth(5);
      for (let client = 1; client <= 4; client++) for (const channel of ['in_person', 'whatsapp']) {
        const before = await one('select jsonb_build_array(client_type,primary_advisor_id)as v from public.clients where id=$1', [client]);
        const created = await sale(payload('58412000000' + client, { clientId: client, clientType: 'direct', salesChannel: channel }));
        assert.equal(created.clientCreated, false);
        assert.deepEqual(await one('select jsonb_build_array(client_type,primary_advisor_id)as v from public.clients where id=$1', [client]), before);
      }
    });
    await t.test('retry does not duplicate orders, clients or history; changing the channel requires a new request', async () => {
      await auth(5);
      const key = randomUUID(), input = payload('584120009003', { salesChannel: 'whatsapp' });
      const first = await sale(input, key);
      assert.deepEqual(await sale(input, key), first);
      await assert.rejects(() => sale({ ...input, salesChannel: 'in_person' }, key), /idempotency_key_reused/);
      await db.exec('reset role');
      assert.equal(await one('select count(*)::int as v from public.orders where client_id=$1', [first.clientId]), 1);
      assert.equal(await one('select count(*)::int as v from app_private.client_commercial_type_history_v1 where client_id=$1', [first.clientId]), 1);
    });
    await t.test('a late invalid item rolls back direct client creation, audit, order and receipt together', async () => {
      await auth(5);
      await assert.rejects(() => sale(payload('584120009004', { items: [{ productId: 999999, qty: 1 }] })), /counter_product_unavailable/);
      await db.exec('reset role');
      assert.equal(await one("select count(*)::int as v from public.clients where phone='584120009004'"), 0);
    });
    await t.test('scheduled Counter sales retain the existing agenda instead of being cooked immediately', async () => {
      await auth(6);
      const created = await sale(payload('584120009005', { salesChannel: 'whatsapp', scheduleAsap: false, scheduledDate: '2099-01-01', scheduledTime: '12:00' }));
      assert.equal(created.sentToKitchen, false);
      assert.equal(await one('select status::text as v from public.orders where id=$1', [created.id]), 'created');
      assert.equal(await one('select sales_channel as v from public.orders where id=$1', [created.id]), 'whatsapp');
    });
    await t.test('manual referral converts only Direct to Assigned, with actor, before and after in private history', async () => {
      await auth(5);
      const created = await sale(payload('584120009006', { salesChannel: 'whatsapp' }));
      await auth(2);
      await assert.rejects(() => db.query('update public.clients set primary_advisor_id=$1 where id=$2', [id(2), created.clientId]), /requieren Master/);
      await auth(5);
      await assert.rejects(() => db.query("update public.clients set client_type='own'where id=$1", [created.clientId]), /requieren Master/);
      await auth(4);
      await db.query('update public.clients set primary_advisor_id=$1 where id=$2', [id(2), created.clientId]);
      assert.equal(await one('select client_type as v from public.clients where id=$1', [created.clientId]), 'assigned');
      const history = await db.query('select previous_type,new_type,actor_id,previous_advisor_id,new_advisor_id from app_private.client_commercial_type_history_v1 where client_id=$1 order by id', [created.clientId]);
      assert.deepEqual(history.rows[1], { previous_type: 'direct', new_type: 'assigned', actor_id: id(4), previous_advisor_id: null, new_advisor_id: id(2) });
      // A second save is not another classification change.
      await db.query('update public.clients set primary_advisor_id=$1 where id=$2', [id(2), created.clientId]);
      assert.equal(await one('select count(*)::int as v from app_private.client_commercial_type_history_v1 where client_id=$1', [created.clientId]), 2);
    });
    await t.test('later advisor orders cannot automatically take a Direct customer; old VIVO orphan rescue still works', async () => {
      await auth(5);
      const direct = await sale(payload('584120009007'));
      await auth(1);
      await db.query("insert into public.orders(client_id,attributed_advisor_id,source,status)values($1,$2,'advisor','created')", [direct.clientId, id(2)]);
      assert.equal(await one('select primary_advisor_id as v from public.clients where id=$1', [direct.clientId]), null);
      await db.query("insert into public.orders(client_id,attributed_advisor_id,source,status)values(3,$1,'advisor','created')", [id(2)]);
      assert.equal(await one('select primary_advisor_id::text as v from public.clients where id=3'), id(2));
      assert.equal(await one('select client_type as v from public.clients where id=3'), 'legacy');
    });
    await t.test('channel metadata does not grant approval authority and edits cannot rewrite recorded channels or history', async () => {
      await auth(2);
      await assert.rejects(() => db.exec("insert into public.orders(source,status,sales_channel)values('advisor','created','whatsapp')"), /requiere permisos/);
      await db.exec("insert into public.orders(source,status)values('advisor','created')");
      assert.equal(await one("select count(*)::int as v from public.orders where source='advisor'and sales_channel='advisor'and status='created'"), 3);
      await auth(1);
      await assert.rejects(() => db.exec("update public.orders set sales_channel='whatsapp'where id=1"), /no se cambia/);
      await db.exec("update public.orders set notes='Edición sin reclasificar'where id=1");
      assert.equal(await one('select sales_channel as v from public.orders where id=1'), null);
      await db.exec("insert into public.orders(source,status,sales_channel)values('master','created','whatsapp')");
      assert.equal(await one("select status::text as v from public.orders where source='master'order by id desc limit 1"), 'created');
    });
    await t.test('anonymous, inactive staff and forged history writes are rejected', async () => {
      await auth(0, 'anon');
      await assert.rejects(() => sale(payload('584120009010')), /permission denied/);
      await auth(2);
      await assert.rejects(() => sale(payload('584120009010')), /counter_access_denied/);
      assert.equal(await one('select count(*)::int as v from app_private.client_commercial_type_history_v1'), 0);
      await assert.rejects(() => db.exec("insert into app_private.client_commercial_type_history_v1(client_id,new_type)values(1,'own')"), /permission denied/);
      await auth(3);
      await assert.rejects(() => sale(payload('584120009010')), /Usuario inactivo/);
      await auth(5);
      await assert.rejects(() => sale(payload('584120009010', { salesChannel: 'advisor' })), /Selecciona Presencial o WhatsApp/);
      await db.exec('reset role');
      assert.deepEqual(await db.query('select * from public.advisor_commission_closures'), paid);
      assert.deepEqual(await db.query('select * from public.order_payments'), payments);
    });
  } finally { await db.close(); }
});
