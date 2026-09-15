import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';

const directory = new URL('../../supabase/migrations/', import.meta.url);
const name = readdirSync(directory).find((name) => name.endsWith('_order_collection_precision_v1.sql'));
assert.ok(name);
const migration = readFileSync(new URL(name, directory), 'utf8');
const fixture = readFileSync(new URL('./order-collection-precision.rollback.sql', import.meta.url), 'utf8');

test('only a strictly subcent residual is forgiven after actual payment allocation', () => {
  assert.match(migration, /v_remaining > 0 and v_remaining < 0\.01/);
  assert.doesNotMatch(migration, /v_remaining <= 0\.01/);
  assert.match(fixture, /one full cent remains collectible/);
  assert.match(fixture, /nine tenths of a cent closes automatically/);
});

test('precision is derived from historical source snapshots, never the current catalog', () => {
  const helper = migration.slice(migration.indexOf('create function public.order_collection_precision_basis_v1'), migration.indexOf('CREATE OR REPLACE FUNCTION public.get_order_financial_state'));
  assert.match(helper, /line_total_bs_snapshot\/nullif\(o.fx,0\)/);
  assert.match(helper, /else i.line_total_usd end/);
  assert.doesNotMatch(helper, /public\.products|public\.exchange_rates/);
  assert.match(helper, /override_unit_price_usd is null/);
  assert.match(helper, /header_usd=0 and header_bs=0 then 0/);
});

test('applied credit and rounding are separate from cash and only confirmed movements count', () => {
  assert.match(migration, /applied_usd-a.cash_equivalent_usd/);
  assert.match(migration, /m.status='confirmed'/);
  assert.match(migration, /rounding_usd numeric not null/);
  assert.doesNotMatch(migration, /update public\.money_movements set amount/i);
  assert.match(fixture, /bank and accounting equivalents unchanged/);
});

test('history is grandfathered and allocations are atomic and uniquely linked', () => {
  assert.match(migration, /not exists\(select 1 from public.money_movements m where m.order_id=p_order_id\)/);
  assert.match(migration, /movement_id bigint primary key references public.money_movements\(id\) deferrable initially deferred/);
  assert.match(migration, /for update of o/);
  assert.match(fixture, /no silent historical enrollment/);
  assert.match(fixture, /one allocation per confirmed movement/);
});

test('both write paths capture precision and voids retain immutable evidence', () => {
  assert.match(migration, /before insert or update of status on public.money_movements/);
  assert.match(migration, /new.exchange_rate_ves_per_usd,new.movement_date,new.payment_report_id/);
  assert.match(fixture, /public\.confirm_payment_report_atomic_v1/);
  assert.match(fixture, /public\.counter_apply_order_payments/);
  assert.match(fixture, /void also reverses rounding closure/);
});

test('new data has RLS, order-scoped reads and no direct application mutations', () => {
  for (const table of ['order_collection_precision_enrollments', 'order_payment_precision_allocations']) {
    assert.match(migration, new RegExp(`alter table public\\.${table} enable row level security`));
    assert.match(migration, new RegExp(`o.id=${table}.order_id`));
  }
  assert.match(migration, /from public, anon, authenticated/);
  assert.match(migration, /security invoker set search_path = ''/);
  assert.match(fixture, /anonymous precision access denied/);
});

test('SQL regression suite covers source currencies, FX changes and systematic exact quotes', () => {
  for (const coverage of ['mixed currency order', 'individually rounded USD lines', 'USD origin is never recovered',
    'prior VES payment remains valued', 'no fictional cent stored', 'for i in 1..2000 loop', 'set constraints all immediate']) {
    assert.ok(fixture.includes(coverage), coverage);
  }
});
