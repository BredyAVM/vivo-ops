import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const sql = read('supabase/migrations/20260918124833_gambit_application_modes.sql');

test('reuses the catalog scope and existing RPCs without changing any catalog row globally', () => {
  assert.doesNotMatch(sql, /create table|alter table|add column/i);
  assert.match(sql, /inventory_update_product_identity_v1/);
  assert.match(sql, /inventory_save_catalog_draft_v1/);
  assert.match(sql, /Solo administración puede modificar productos/);
  assert.match(sql, /catalog_access_scope/);
  assert.doesNotMatch(sql, /where sku in/i);
});

test('both modes never bypass linked CRM validation or force paid gambits to be gifts', () => {
  assert.match(sql, /if not is_crm_item then/);
  assert.match(sql, /in \('advisor_gift', 'advisor_gift_only'\) then/);
  assert.match(sql, /product_row.source_price_amount, product_row.base_price_usd, 0\) = 0 then/);
  assert.match(sql, /is distinct from expected_product_id/);
  assert.match(sql, /if not is_existing_redemption then\s+if .*\('advisor_gift_only', 'gambit_disabled', 'admin_internal'\)/);
  assert.match(sql, /member_row.client_id is distinct from order_row.client_id/);
  assert.match(sql, /member_row.play_status <> 'active'/);
  assert.match(sql, /public.has_role\('counter'\) and order_row.source = 'walk_in'/);
});

test('Master keeps CRM products loaded but filters only the discretionary search', () => {
  const loader = read('src/app/app/master/ops/actions.ts');
  const editor = read('src/app/app/master/ops/MasterOpsOrderEditor.tsx');
  assert.match(loader, /discretionaryAllowed: !isCrmOnlyCatalogProduct\(product\)/);
  assert.match(editor, /item.isActive && item.discretionaryAllowed !== false/);
  assert.match(editor, /catalogById.get\(choice.productId\)/);
  assert.match(read('src/app/app/master/dashboard/actions.ts'), /code: 'gambit_application_rejected'/);
});

test('creation and editing share both checkboxes and persist the scope', () => {
  for (const file of ['InventoryAdministrationClient.tsx', 'InventoryConfiguratorClient.tsx']) {
    assert.match(read(`src/app/app/inventory/configure/${file}`), /<GambitApplicationFields/);
  }
  const fields = read('src/app/app/inventory/configure/GambitApplicationFields.tsx');
  assert.match(fields, /A discreción del asesor/);
  assert.match(fields, /Mediante una jugada del CRM/);
  assert.match(read('src/app/app/inventory/actions.ts'), /catalog_access_scope: input.catalogAccessScope/);
});
