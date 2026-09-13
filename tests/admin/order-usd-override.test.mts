import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import { calculateOrderLineSnapshot, calculateOrderTotalsSnapshot } from '../../src/lib/pricing/order-snapshots.ts';

const migrationName = readdirSync(new URL('../../supabase/migrations/', import.meta.url))
  .find((name) => name.endsWith('_admin_usd_order_override_snapshot_fix.sql'));
assert.ok(migrationName);
const migration = readFileSync(new URL(`../../supabase/migrations/${migrationName}`, import.meta.url), 'utf8');
const overrideStart = migration.indexOf('-- Modern administrative USD overrides');
const override = migration.slice(overrideStart);

test('explicit USD source and legacy override input produce identical authorized snapshots', () => {
  const fromUsdSource = calculateOrderLineSnapshot({
    sourceCurrency: 'USD', sourceAmount: 9, quantity: 3, fxRate: 100,
  });
  const fromOverride = calculateOrderLineSnapshot({
    sourceCurrency: 'VES', sourceAmount: 1500, quantity: 3, fxRate: 100, overrideUnitUsd: 9,
  });
  assert.deepEqual(fromUsdSource, { unitUsd: 9, lineUsd: 27, unitBs: 900, lineBs: 2700 });
  assert.deepEqual(fromOverride, fromUsdSource);
});

test('new effective FX, discount and tax keep the two totals independently rounded', () => {
  const line = calculateOrderLineSnapshot({ sourceCurrency: 'USD', sourceAmount: 9, quantity: 3, fxRate: 125 });
  const total = calculateOrderTotalsSnapshot({ subtotalUsd: line.lineUsd, subtotalBs: line.lineBs, discountPct: 10, invoiceTaxPct: 16 });
  assert.equal(total.totalUsd, 28.19);
  assert.equal(total.totalBs, 3523.5);
});

test('zero override and upward override do not fall back to catalog', () => {
  for (const price of [0, 20]) {
    const line = calculateOrderLineSnapshot({ sourceCurrency: 'USD', sourceAmount: price, quantity: 3, fxRate: 100, fallbackUnitUsd: 15 });
    assert.equal(line.unitUsd, price);
    assert.equal(line.lineUsd, price * 3);
  }
});

test('VES line-level rounding is not replaced by multiplication of rounded unit USD', () => {
  const line = calculateOrderLineSnapshot({ sourceCurrency: 'VES', sourceAmount: 1, quantity: 3, fxRate: 7 });
  assert.equal(line.unitUsd, .14);
  assert.equal(line.lineUsd, .43);
});

test('trigger corrects the final writer after its historical catalog assignment', () => {
  assert.ok(overrideStart > migration.indexOf('new.unit_price_usd_snapshot := v_product.base_price_usd;'));
  assert.match(override, /new\.unit_price_usd_snapshot := pg_catalog\.round\(new\.admin_price_override_usd, 2\)/);
  assert.match(override, /new\.line_total_usd := pg_catalog\.round/);
  assert.match(override, /new\.pricing_origin_currency = 'USD'/);
});

test('override authority is checked from the caller, not user-supplied approval metadata', () => {
  assert.match(override, /if not public\.is_admin\(\) then[\s\S]*errcode = '42501'/);
  assert.ok(override.indexOf('public.is_admin()') < override.indexOf('new.unit_price_usd_snapshot :='));
  assert.match(override, /new\.admin_price_override_by_user_id := auth\.uid\(\)/);
  assert.match(override, /admin_price_override_usd::text in \('NaN', 'Infinity', '-Infinity'\)/);
  assert.match(override, /btrim\(new\.admin_price_override_reason\)/);
});

test('CRM, counter and legacy pricing keep their dedicated paths and precedence', () => {
  assert.match(override, /if not v_is_crm_item\s+and not v_is_counter_direct_sale/);
  assert.match(override, /coalesce\(new\.override_unit_price_usd, new\.unit_price_usd_snapshot\)/);
  assert.ok(migration.indexOf('if v_is_crm_item then') < overrideStart);
  assert.ok(migration.indexOf('if v_is_counter_direct_sale then') < overrideStart);
  assert.match(migration, /v_product\.source_price_amount \* coalesce\(new\.qty, 0\) \/ v_fx_rate/);
});

test('migration does not backfill real orders, alter FX, grant privileges or add a definer', () => {
  assert.match(migration, /SET search_path TO ''/);
  assert.doesNotMatch(migration, /security definer|grant\s|update public\.(orders|order_items)/i);
  assert.doesNotMatch(override, /new\.(unit_price_bs_snapshot|line_total_bs_snapshot) :=/);
});

test('SQL integration test covers atomic saves, permission failures and cleanup', () => {
  const fixture = readFileSync(new URL('./order-usd-override.rollback.sql', import.meta.url), 'utf8');
  assert.match(fixture, /public\.update_order_core_atomic_v1/);
  assert.match(fixture, /failed save must preserve every original item/);
  assert.match(fixture, /advisor override unexpectedly accepted/);
  assert.match(fixture, /exception when sqlstate 'ZX001'/);
  assert.match(fixture, /fixture must be rolled back/);
});
