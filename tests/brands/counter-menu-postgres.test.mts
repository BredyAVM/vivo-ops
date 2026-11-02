import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { menuDocument } from './menu-fixtures.ts';
import { decodeOrderMenuGraph, defaultMenuOrderSelection, quoteMenuOrder, menuQuoteDetailLines, type MenuOrderQuote } from '../../src/lib/brands/order-menu.ts';
import { readMenuStockSnapshot } from '../../src/lib/brands/inventory-menu.ts';

const read = (p: string) => readFileSync(p, 'utf8');
const migration = 'supabase/migrations/20261102143805_counter_muerdeme_configured_sales_v1.sql';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function extract(sql: string, name: string, delimiter = '$function$;') {
  const start = sql.search(new RegExp('create (?:or replace )?function ' + name.replaceAll('.', '\\.') + '\\('));
  assert.notEqual(start, -1, name); const end = sql.indexOf(delimiter, start); assert.notEqual(end, -1, name);
  return sql.slice(start, end + delimiter.length);
}
test('Counter configurable orders use the existing menu, atomic creation and shared physical ledger', async t => {
  const db = new PGlite();
  try {
    await db.exec(read('tests/brands/fixtures/commercial-intake-schema.sql'));
    const inventorySchema = read('tests/brands/fixtures/inventory-menu-schema.sql')
      .replace("alter table public.products alter column id set default nextval('public.test_menu_product_id');", '')
      .replaceAll('add column ', 'add column if not exists ').replace('create domain public.user_role as text;', '');
    await db.exec(inventorySchema);
    await db.exec('grant select on public.products to authenticated');
    await db.exec(`alter table public.products alter column id restart with 1000;
      alter table public.order_items add column if not exists draft_price_agreement_key uuid;
      create function app_private.order_item_reduced_commercial_terms_v1(jsonb,jsonb,numeric)returns boolean language sql as $$select false$$;
      create function app_private.order_item_same_commercial_terms_v1(jsonb,jsonb)returns boolean language sql as $$select false$$;
      create function app_private.order_item_operational_quantity_v1(jsonb,jsonb)returns boolean language sql as $$select false$$;
      create function app_private.apply_agreed_draft_item_v1(public.order_items)returns public.order_items language sql as $$select null::public.order_items$$;
      create table public.test_suspended_products(product_id bigint primary key);
      create function app_private.counter_assert_commercial_products_sellable_v1(timestamptz,bigint[])returns void language plpgsql as $$begin
        if exists(select 1 from public.test_suspended_products where product_id=any($2))then raise exception 'counter_product_suspended';end if;end$$;
      update public.products set inventory_policy='self',inventory_enabled=true,is_inventory_item=true,inventory_configuration_status='ready',units_per_service=25 where id=1;
      insert into public.products(id,name,sku,is_active,type,source_price_amount,source_price_currency,base_price_usd,base_price_bs,inventory_group,inventory_policy,inventory_configuration_status,is_detail_editable)
        values(3,'Coca Cola 1,5 Lts','COCA-TEST',true,'product',2.5,'USD',2.5,2150,'beverages','self','ready',false);
      insert into public.inventory_items(id,name,unit_name,current_stock_units)values(1,'Tequeños','pieza',500),(11,'Hamburguesas','unidad',100),(20,'Coca Cola','botella',100);
      insert into public.product_inventory_links values(1,1,1,25),(3,20,1,1);`);
    for (const file of ['20261028185749_commercial_brand_foundation_v1.sql','20261028193056_muerdeme_menu_drafts_v1.sql','20261029154907_muerdeme_order_configurator_v1.sql']) await db.exec(read('supabase/migrations/' + file));
    await db.exec(read('tests/brands/fixtures/inventory-diagnostics-baseline.sql'));
    await db.exec(read('supabase/migrations/20261029163705_muerdeme_kitchen_inventory_v1.sql'));
    await db.exec(read('supabase/migrations/20261030145549_muerdeme_shared_vivo_drinks_v1.sql'));
    for (const file of ['inventory-ledger-test-support.sql','inventory-routes-existing.sql','inventory-resolution-existing.sql','inventory-commitment-existing.sql','inventory-sale-existing.sql']) await db.exec(read('tests/brands/fixtures/' + file)
      .replaceAll('add column ', 'add column if not exists ').replace('create domain public.user_role as text;', ''));
    const old = read('supabase/migrations/20260727181211_counter_block_7_atomic_direct_sale.sql');
    await db.exec(extract(old, 'public.counter_create_direct_sale').replace('public.counter_create_direct_sale(', 'public.counter_create_direct_sale_without_commercial_guard_v1('));
    await db.exec(extract(read('supabase/migrations/20260911200117_counter_commercial_suspension_guard.sql'), 'public.counter_create_direct_sale', '$$;'));
    await db.exec(extract(read('supabase/migrations/20260822022047_client_primary_advisor_assignment_v1.sql'), 'app_private.rescue_orphan_client_from_live_order_v1'));
    await db.exec(read('supabase/migrations/20261030175530_commercial_channels_clients_v1.sql'));
    await db.exec(read('tests/brands/fixtures/counter-pricing-20261102.sql'));
    await db.exec(`create trigger test_existing_pricing before insert or update on public.order_items for each row execute function public.trg_order_items_set_pricing();
      revoke all on function public.counter_create_direct_sale(uuid,jsonb)from public,anon;
      grant execute on function public.counter_create_direct_sale(uuid,jsonb)to authenticated;`);
    const one = async <T = unknown>(sql: string, args: unknown[] = []) => (await db.query<{ v: T }>(sql, args)).rows[0]?.v;
    const auth = async (n = 1, role = 'authenticated') => { await db.exec('reset role'); await db.query("select set_config('request.jwt.claim.sub',$1,false)", [n ? id(n) : '']); await db.exec('set role ' + role); };
    const sale = (items: unknown[], patch: Record<string, unknown> = {}, key = randomUUID()) => one<{ id: number; clientId: number; sentToKitchen: boolean }>(
      'select public.counter_create_direct_sale($1,$2)as v', [key, { clientName: 'Prueba aislada', clientPhone: '584120099999', fulfillment: 'pickup', salesChannel: 'whatsapp', scheduleAsap: true, paymentMethod: 'pos', paymentCurrency: 'VES', items, ...patch }]);
    const configured = (q: MenuOrderQuote) => ({ productId: q.productId, qty: 1, editableDetailLines: menuQuoteDetailLines(q) });
    const money = (order: number) => one(`select jsonb_build_object('usd',total_usd,'bs',total_bs_snapshot,'pricing',extra_fields->'pricing','source',source,'advisor',attributed_advisor_id,'channel',sales_channel)as v from public.orders where id=$1`, [order]);
    await auth(5);
    const baselineSale = await sale([{ productId: 1, qty: 2 }, { productId: 2, qty: 1 }], { hasInvoice: true, invoiceTaxPct: '16' });
    const beforeMoney = await money(baselineSale.id);
    await db.exec('reset role');
    const beforeClients = await db.query('select id,client_type,primary_advisor_id from public.clients order by id');
    const beforeProducts = await db.query('select * from public.products order by id');
    const beforePayments = await db.query('select * from public.order_payments');
    const beforeClosures = await db.query('select * from public.advisor_commission_closures');
    await db.exec(read(migration));
    await t.test('installation leaves VIVO catalogue, customers, payments, paid closures and preparation state intact', async () => {
      assert.deepEqual(await db.query('select id,client_type,primary_advisor_id from public.clients order by id'), beforeClients);
      assert.deepEqual(await db.query('select * from public.products order by id'), beforeProducts);
      assert.deepEqual(await db.query('select * from public.order_payments'), beforePayments);
      assert.deepEqual(await db.query('select * from public.advisor_commission_closures'), beforeClosures);
      assert.equal(await one("select sales_enabled as v from app_private.commercial_brands where code='muerdeme'"), false);
    });
    await t.test('ordinary VIVO quick sales keep identical USD/VES, tax, channel and attribution results', async () => {
      await auth(5); const order = await sale([{ productId: 1, qty: 2 }, { productId: 2, qty: 1 }], { hasInvoice: true, invoiceTaxPct: '16' });
      assert.deepEqual(await money(order.id), beforeMoney);
    });
    await auth();
    const save = (document: unknown) => one<{ entryId: string }>('select public.admin_muerdeme_menu_save_v1(null,0,$1,$2)as v', [document, randomUUID()]);
    const extra = (await save(menuDocument('extra', 'Tocineta', 0.75))).entryId;
    const burgerDoc = menuDocument('burger', 'Hamburguesa', 5);
    burgerDoc.variants[0].burger!.extras = [{ entryId: extra, variantKey: 'standard', maxQty: 2 }];
    const burger = (await save(burgerDoc)).entryId;
    await one('select public.admin_muerdeme_inventory_recipe_save_v1($1,\'standard\',1,0,$2,$3)as v', [extra, { schemaVersion: 1, mode: 'untracked', note: 'Extra de prueba aislada', lines: [] }, randomUUID()]);
    await one('select public.admin_muerdeme_inventory_recipe_save_v1($1,\'standard\',1,0,$2,$3)as v', [burger, { schemaVersion: 1, mode: 'tracked', note: 'Prueba aislada', lines: [{ inventoryItemId: 11, quantity: 1, ingredientKey: null }] }, randomUUID()]);
    const comboDoc = menuDocument('combo', 'Combo dos hamburguesas', 15);
    comboDoc.comboGroups = [
      { key: 'burgers', label: 'Hamburguesas', kind: 'burger', quantity: 2, choices: [{ entryId: burger, variantKey: 'standard', supplementUsd: 0 }] },
      { key: 'drink', label: 'Bebida', kind: 'drink', quantity: 1, choices: [{ entryId: 'vivo:3', variantKey: 'standard', supplementUsd: 0 }] },
    ];
    const combo = (await save(comboDoc)).entryId;
    const getQuote = async (entry: string, customize?: (s: ReturnType<typeof defaultMenuOrderSelection>) => void) => {
      const graph = decodeOrderMenuGraph(await one('select public.muerdeme_order_menu_graph_v1($1)as v', [entry]));
      const selection = defaultMenuOrderSelection(graph.entries.find(e => e.entryId === entry)!); customize?.(selection);
      return quoteMenuOrder(graph, selection);
    };
    let burgerQuote = await getQuote(burger), comboQuote = await getQuote(combo, s => { s.slots[0].removed = ['sauce']; s.slots[1].extras = [{ entryId: extra, variantKey: 'standard', quantity: 1 }]; });
    await t.test('closed preparation rejects Muérdeme before client creation, without blocking VIVO', async () => {
      await auth(5);
      const search = await one<{ rows: unknown[]; salesEnabled: boolean }>("select public.muerdeme_order_menu_search_v1('',null,1)as v");
      assert.deepEqual(search.rows, []); assert.equal(search.salesEnabled, false);
      await assert.rejects(() => sale([configured(burgerQuote)], { clientPhone: '584120098001' }), /en preparación/);
      await db.exec('reset role'); assert.equal(await one("select count(*)::int as v from public.clients where phone='584120098001'"), 0);
    });
    await db.exec("reset role;update app_private.commercial_brands set sales_enabled=true where code='muerdeme'");
    await t.test('Counter can configure the operational menu without administrative menu-write permissions', async () => {
      await auth(5); burgerQuote = await getQuote(burger); comboQuote = await getQuote(combo, s => { s.slots[0].removed = ['sauce']; s.slots[1].extras = [{ entryId: extra, variantKey: 'standard', quantity: 1 }]; });
      assert.equal(comboQuote.unitUsd, 15.75);
      await assert.rejects(() => save(menuDocument('burger', 'No autorizado', 1)), /admin|Admin|permission|administrador/);
    });
    let mixed: { id: number; clientId: number; sentToKitchen: boolean };
    const exactKey = randomUUID();
    await t.test('one mixed order preserves every burger choice, uses shared drinks and generates no automatic advisor incentive', async () => {
      await auth(5); mixed = await sale([{ productId: 1, qty: 1 }, { productId: 3, qty: 1 }, configured(comboQuote), configured(burgerQuote)], {}, exactKey);
      const header = await one('select jsonb_build_object(\'usd\',total_usd,\'bs\',total_bs_snapshot,\'source\',source,\'advisor\',attributed_advisor_id,\'channel\',sales_channel,\'status\',status)as v from public.orders where id=$1', [mixed.id]);
      assert.deepEqual(header, { usd: 37.25, bs: 32035, source: 'walk_in', advisor: null, channel: 'whatsapp', status: 'confirmed' });
      assert.equal(mixed.sentToKitchen, true);
      const items = await db.query<{notes:string;line_total_usd:string}>('select * from public.order_items where order_id=$1 order by id', [mixed.id]);
      assert.equal(items.rows.length, 4);
      assert.ok(items.rows[2].notes.includes('Sin Salsa')); assert.ok(items.rows[2].notes.includes('Tocineta'));
      assert.equal(items.rows[2].line_total_usd, '15.75');
      assert.equal(readMenuStockSnapshot(items.rows[2].notes)!.status, 'ready');
      assert.equal(await one('select client_type as v from public.clients where id=$1', [mixed.clientId]), 'direct');
    });
    await t.test('dispatch aggregates Muérdeme plus standalone VIVO stock once, and retry cannot double-consume', async () => {
      await db.exec('reset role');
      const diag = await one<{lines:Array<{inventory_item_id:number;quantity_units:number}>}>('select app_private.inventory_order_sale_diagnostics_v1($1)as v', [mixed.id]);
      assert.deepEqual(diag.lines.map(l => [l.inventory_item_id, l.quantity_units]), [[1, 25], [11, 3], [20, 2]]);
      const operation = randomUUID();
      // The existing pickup completion command stamps its operator before
      // invoking this unchanged physical ledger function.
      await db.query("update public.orders set status='delivered',last_modified_by=$2 where id=$1", [mixed.id,id(5)]);
      await auth(5);
      await one('select public.inventory_commit_order_sale_v1($1,$2,null)as v', [operation, mixed.id]);
      await one('select public.inventory_commit_order_sale_v1($1,$2,null)as v', [operation, mixed.id]);
      await db.exec('reset role');
      assert.deepEqual((await db.query<{id:number;current_stock_units:string}>('select id,current_stock_units from public.inventory_items order by id')).rows
        .map(row => [row.id,Number(row.current_stock_units)]), [[1,475],[11,97],[20,98]]);
    });
    await t.test('forged prices, missing configuration, bulk quantity and inactive VIVO fail without partial orders', async () => {
      await auth(5);
      for (const patch of [
        { ...configured(burgerQuote), qty: 2 },
        { ...configured(burgerQuote), productId: 1 },
        { productId: burgerQuote.productId, qty: 1 },
        { ...configured(burgerQuote), editableDetailLines: menuQuoteDetailLines({ ...burgerQuote, unitUsd: 0.01 }) },
      ]) await assert.rejects(() => sale([patch], { clientPhone: '584120098002' }));
      await db.exec('reset role'); assert.equal(await one("select count(*)::int as v from public.clients where phone='584120098002'"), 0);
      await db.exec('update public.products set is_active=false where id=2'); await auth(5);
      await assert.rejects(() => sale([{ productId: 2, qty: 1 }]), /counter_product_unavailable/);
    });
    await t.test('shared VIVO drink suspension rolls back the entire configured sale', async () => {
      await db.exec('reset role;insert into public.test_suspended_products values(3)'); await auth(6);
      await assert.rejects(() => sale([configured(comboQuote)], { clientPhone: '584120098003' }), /counter_product_suspended/);
      await db.exec('reset role'); assert.equal(await one("select count(*)::int as v from public.clients where phone='584120098003'"), 0);
      await db.exec('delete from public.test_suspended_products');
    });
    await t.test('missing recipes and stale prices reject before client creation instead of silently changing the quote', async () => {
      await db.exec("reset role;update app_private.commercial_brands set sales_enabled=false where code='muerdeme'");
      await auth();
      const unprepared = (await save(menuDocument('burger', 'Sin receta', 5))).entryId;
      await db.exec("reset role;update app_private.commercial_brands set sales_enabled=true where code='muerdeme'");
      await auth(5);
      const unpreparedQuote = await getQuote(unprepared);
      await assert.rejects(() => sale([configured(unpreparedQuote)], { clientPhone: '584120098004' }), /preparación e inventario/);
      await db.exec("reset role;update app_private.commercial_brands set sales_enabled=false where code='muerdeme'");
      await auth();
      await one('select public.admin_muerdeme_menu_save_v1($1,1,$2,$3)as v', [burger, { ...burgerDoc, variants: [{ ...burgerDoc.variants[0], priceUsd: 6 }] }, randomUUID()]);
      await db.exec("reset role;update app_private.commercial_brands set sales_enabled=true where code='muerdeme'");
      await auth(5);
      await assert.rejects(() => sale([configured(burgerQuote)], { clientPhone: '584120098004' }), /menú|cambi|actualiz/i);
      await assert.rejects(() => one('select app_private.counter_muerdeme_item_v1($1)as v', [configured(burgerQuote)]), /permission denied/);
      await db.exec('reset role'); assert.equal(await one("select count(*)::int as v from public.clients where phone='584120098004'"), 0);
    });
    await t.test('an identical receipt replays after closure; a changed request cannot reuse it', async () => {
      await db.exec("reset role;update app_private.commercial_brands set sales_enabled=false where code='muerdeme'"); await auth(5);
      assert.deepEqual(await sale([{ productId: 1, qty: 1 }, { productId: 3, qty: 1 }, configured(comboQuote), configured(burgerQuote)], {}, exactKey), mixed);
      await assert.rejects(() => sale([configured(comboQuote)], {}, exactKey), /idempotency_key_reused/);
      await auth(0, 'anon'); await assert.rejects(() => sale([configured(comboQuote)]), /permission denied/);
      await auth(3); await assert.rejects(() => sale([configured(comboQuote)]), /activo|inactivo/);
      await db.exec('reset role');
      assert.deepEqual(await db.query('select * from public.order_payments'), beforePayments);
      assert.deepEqual(await db.query('select * from public.advisor_commission_closures'), beforeClosures);
    });
  } finally { await db.close(); }
});
