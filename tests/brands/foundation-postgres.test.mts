import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const migration = readFileSync('supabase/migrations/20261028185749_commercial_brand_foundation_v1.sql', 'utf8');
const fixture = readFileSync('tests/brands/fixtures/foundation-schema.sql', 'utf8');
const admin = '00000000-0000-4000-8000-000000000001';
const advisor = '00000000-0000-4000-8000-000000000002';
const inactive = '00000000-0000-4000-8000-000000000003';
const master = '00000000-0000-4000-8000-000000000004';
const operation = '00000000-0000-4000-8000-000000000010';

test('brand foundation preserves VIVO and enforces preparation settings in real PostgreSQL', async t => {
  const db = new PGlite();
  try {
    await db.exec(fixture);
    const legacySnapshot = async () => {
      await db.exec('reset role');
      const snapshot: unknown[] = [];
      for (const table of ['products', 'clients', 'orders', 'order_items', 'order_payments', 'advisor_commission_closures']) {
        snapshot.push((await db.query(`select to_jsonb(t) as row from public.${table} t order by id`)).rows);
      }
      return snapshot;
    };
    const before = await legacySnapshot();
    await db.exec(migration);
    const auth = async (id: string, role = 'authenticated') => {
      await db.exec('reset role');
      await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id]);
      await db.exec(`set role ${role}`);
    };
    const read = async (includeCatalog = false, brand: string | null = null, query = '', page = 1) =>
      (await db.query<{ v: { brands: { code: string; salesEnabled: boolean; incentivePolicy: { revision: number; firstOrderUsd: number; recurrentOrderUsd: number } | null }[]; catalog: { id: number; amount: number; currency: string; brandCode: string }[]; hasNext: boolean } }>(
        'select public.admin_commercial_foundation_read_v1($1,$2,$3,$4) as v', [includeCatalog, brand, query, page],
      )).rows[0].v;
    const save = async (first = '0.40', recurrent = '0.25', expected = 1, id = operation) =>
      (await db.query('select public.admin_commercial_incentive_draft_save_v1($1,$2,$3,$4) as v', [first, recurrent, expected, id])).rows;

    await t.test('installation changes no legacy products, clients, stock, orders, payments or paid closures', async () => {
      assert.deepEqual(await legacySnapshot(), before);
    });
    await t.test('anonymous, service role, inactive admin, master and advisor cannot execute administration', async () => {
      for (const [id, role, expected] of [
        ['', 'anon', /permission denied/], [admin, 'service_role', /permission denied/],
        ['', 'authenticated', /administrador activo/], [advisor, 'authenticated', /administrador activo/],
        [master, 'authenticated', /administrador activo/], [inactive, 'authenticated', /administrador activo/],
      ] as const) {
        await auth(id, role);
        await assert.rejects(() => read(), expected);
        await assert.rejects(() => save(), expected);
      }
      await auth(advisor);
      assert.equal((await db.query('select * from app_private.commercial_brands')).rows.length, 0);
      assert.equal((await db.query('select * from app_private.commercial_client_relationships')).rows.length, 0);
    });
    await t.test('VIVO is operational and Muérdeme remains disabled with separate fixed USD settings', async () => {
      await auth(admin);
      const result = await read();
      const vivo = result.brands.find(b => b.code === 'vivo')!;
      const muerdeme = result.brands.find(b => b.code === 'muerdeme')!;
      assert.equal(vivo.salesEnabled, true);
      assert.equal(vivo.incentivePolicy, null);
      assert.equal(muerdeme.salesEnabled, false);
      assert.equal(muerdeme.incentivePolicy?.firstOrderUsd, 0.3);
      assert.equal(muerdeme.incentivePolicy?.recurrentOrderUsd, 0.2);
      assert.deepEqual(result.catalog, []);
    });
    await t.test('opening brand settings never requires a catalogue read', async () => {
      await db.exec('reset role; revoke select on public.products from authenticated');
      await auth(admin);
      assert.equal((await read()).brands.length, 2);
      await assert.rejects(() => read(true), /permission denied for table products/);
      await db.exec('reset role; grant select on public.products to authenticated');
    });
    await t.test('catalogue is paginated, searchable, and retains exact native VIVO prices', async () => {
      await auth(admin);
      const first = await read(true);
      const second = await read(true, null, '', 2);
      assert.equal(first.catalog.length, 25);
      assert.equal(first.hasNext, true);
      assert.equal(second.catalog.length, 7);
      assert.equal(second.hasNext, false);
      assert.equal(new Set([...first.catalog, ...second.catalog].map(p => p.id)).size, 32);
      assert.ok([...first.catalog, ...second.catalog].every(p => p.brandCode === 'vivo'));
      assert.deepEqual((await read(true, 'vivo', 'TEQUEÑOS')).catalog.map(p => [p.amount, p.currency]), [[11500, 'VES']]);
      assert.deepEqual((await read(true, 'muerdeme')).catalog, []);
      for (const [brand, query, page] of [['other', '', 1], [null, 'a'.repeat(101), 1], [null, '', 0]] as const) {
        await assert.rejects(() => read(true, brand, query, page), /Filtros de marcas inválidos/);
      }
    });
    await t.test('API permissions cannot enable sales, assign brands or change customer ownership', async () => {
      await auth(admin);
      await assert.rejects(() => db.query("update app_private.commercial_brands set sales_enabled=true where code='muerdeme'"), /permission denied/);
      await assert.rejects(() => db.query("insert into app_private.commercial_product_brands(product_id,brand_code) values(1,'muerdeme')"), /permission denied/);
      await assert.rejects(() => db.query("insert into app_private.commercial_client_relationships(client_id,brand_code,acquisition_channel) values(1,'muerdeme','direct_phone')"), /permission denied/);
    });
    await t.test('saving creates an immutable version and the identical retry creates no second record', async () => {
      await auth(admin);
      const result = await save();
      assert.deepEqual(await save(), result);
      assert.deepEqual(result, [{ v: { revision: 2, status: 'draft' } }]);
      const rows = (await db.query<{ revision: number; first_order_usd: string; recurrent_order_usd: string; actor_id: string | null }>(
        'select revision,first_order_usd,recurrent_order_usd,actor_id from app_private.commercial_incentive_policy_revisions order by revision',
      )).rows;
      assert.equal(rows.length, 2);
      assert.equal(Number(rows[0].first_order_usd), 0.3);
      assert.equal(Number(rows[0].recurrent_order_usd), 0.2);
      assert.equal(rows[1].actor_id, admin);
      await assert.rejects(() => db.query('delete from app_private.commercial_incentive_policy_revisions'), /permission denied/);
      await assert.rejects(() => db.query('update app_private.commercial_incentive_policy_revisions set first_order_usd=0'), /permission denied/);
    });
    await t.test('stale edits and reuse of the same request with different values are rejected', async () => {
      await auth(admin);
      await assert.rejects(() => save('0.50'), /otros datos/);
      await assert.rejects(() => save('0.40', '0.25', 1, '00000000-0000-4000-8000-000000000011'), /configuración cambió/);
    });
    await t.test('invalid money is rejected without truncation and zero is accepted explicitly', async () => {
      await auth(admin);
      for (const amount of ['0.295', '-0.01', 'NaN', 'Infinity', '1000000000']) {
        await assert.rejects(() => save(amount, '0.20', 2), /importes en USD válidos/);
      }
      await save('0', '0', 2, '00000000-0000-4000-8000-000000000012');
      const policy = (await read()).brands.find(b => b.code === 'muerdeme')!.incentivePolicy!;
      assert.equal(policy.firstOrderUsd, 0);
      assert.equal(policy.recurrentOrderUsd, 0);
    });
    await t.test('changes leave every legacy financial and customer record intact', async () => {
      assert.deepEqual(await legacySnapshot(), before);
    });
  } finally { await db.close(); }
});
