import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { normalizeOrderDetailForSave, persistableOrderDetailLines, type DetailComponent } from '../../src/lib/orders/order-detail-persistence.ts';

const pack = { id: 61, name: 'Single Pack (6 und)', inventory_policy: 'components', is_detail_editable: true, detail_units_limit: 6 };
const components: DetailComponent[] = [
  { component_product_id: 5, component_mode: 'selectable', quantity: 1, is_required: true, counts_toward_detail_limit: true, name: 'Mini Tequeños Fritos' },
  { component_product_id: 8, component_mode: 'selectable', quantity: 1, is_required: true, counts_toward_detail_limit: true, name: 'Empanadas Fritas' },
  { component_product_id: 2, component_mode: 'fixed', quantity: 1, is_required: false, counts_toward_detail_limit: false, name: 'Salsa Tártara 1oz' },
];
const selected = ['6 Mini Tequeños Fritos', '@sel|5|6', '1 Salsa Tártara 1oz', '@sel|2|1'];
const normalize = (lines: string[], qty = 1) => normalizeOrderDetailForSave(pack, qty, lines, components);

function exportedFunctionBlock(source: string, name: string) {
  const start = source.indexOf(`export async function ${name}`);
  assert.notEqual(start, -1, `${name} must exist`);
  const next = source.indexOf('\nexport async function ', start + 1);
  return source.slice(start, next === -1 ? source.length : next);
}

test('creation retains inventory selections while removing CRM authority text', () => {
  assert.deepEqual(normalize([...selected, '@crm|benefit:fake']), selected);
  assert.deepEqual(persistableOrderDetailLines([' @sel|5|6 ', ' @CRM|play:fake ', 'Para: Ana']), ['@sel|5|6', 'Para: Ana']);
});
test('edit, repeat and draft JSON roundtrips preserve exact choices and quantities', () => {
  const draft = JSON.parse(JSON.stringify({ editable_detail_lines: normalize(selected) }));
  const loaded = persistableOrderDetailLines(draft.editable_detail_lines);
  assert.deepEqual(normalize(loaded), selected);
  assert.deepEqual(normalize(normalize(normalize(loaded))), selected);
});
test('visible summary is generated from IDs, never overrides a different real selection', () => {
  assert.deepEqual(normalize(['6 Mini Tequeños Fritos', '@sel|8|6']), ['6 Empanadas Fritas', '@sel|8|6']);
  assert.throws(() => normalize(['6 Mini Tequeños Fritos', '@sel|5|1']), /tiene 1 de 6/);
});
test('legacy text is recovered only when component names match uniquely', () => {
  assert.deepEqual(normalize(['6 Mini Tequeños Fritos', '1 Salsa Tártara 1oz']), selected);
  assert.throws(() => normalize(['6 Mini Tequeños']), /identificar con seguridad/);
  assert.throws(() => normalizeOrderDetailForSave(pack, 1, ['6 Mini Tequeños Fritos'], [...components, { ...components[0], component_product_id: 99 }]), /identificar con seguridad/);
});
test('incomplete, excessive and malformed selections cannot be saved', () => {
  for (const lines of [[], ['1 Salsa Tártara 1oz'], ['@sel|5|5'], ['@sel|5|7'], ['@sel|5|0'], ['@sel|5|-1'], ['@sel|5|NaN'], ['@sel|5|6', '@sel|5|6'], ['@sel|99|6'], ['@sel|5|6|extra']]) {
    assert.throws(() => normalize(lines), /Abre el detalle/);
  }
  for (const qty of [0, -1, NaN, Infinity]) assert.throws(() => normalize(selected, qty));
});
test('multi-pack and half quantities use total selected pieces, without double multiplication', () => {
  assert.deepEqual(normalize(['@sel|5|12', '@sel|2|2'], 2), ['12 Mini Tequeños Fritos', '@sel|5|12', '2 Salsa Tártara 1oz', '@sel|2|2']);
  assert.deepEqual(normalize(['@sel|5|3'], 0.5), ['3 Mini Tequeños Fritos', '@sel|5|3']);
});
test('required fixed components and optional maxima retain catalog semantics', () => {
  const fixed = [{ ...components[0], component_mode: 'fixed' as const, quantity: 6 }, components[2]];
  assert.deepEqual(normalizeOrderDetailForSave(pack, 2, [], fixed), ['12 Mini Tequeños Fritos', '@sel|5|12']);
  assert.throws(() => normalize(['@sel|5|6', '@sel|2|2']), /supera 1/);
});
test('service notes and preparation metadata remain intact, without granting CRM benefits', () => {
  assert.deepEqual(normalizeOrderDetailForSave({ ...pack, inventory_policy: 'none' }, 1, ['Llamar al llegar', '@crm|benefit:fake'], []), ['Llamar al llegar']);
  const result = normalize(['Para: Ana', '@prep|fried', ...selected]);
  assert.deepEqual(result.slice(0, 2), ['Para: Ana', '@prep|fried']);
  assert.ok(normalize(['2 bolsas separadas', ...selected]).includes('2 bolsas separadas'));
});
test('all advisor persistence paths preserve metadata; display filters are not storage filters', () => {
  const composer = readFileSync(new URL('../../src/app/app/advisor/new/AdvisorOrderComposer.tsx', import.meta.url), 'utf8');
  assert.match(composer, /persistableOrderDetailLines\(row.editable_detail_lines\)/);
  assert.match(composer, /persistableOrderDetailLines\(item.notes.split/);
  assert.match(composer, /notes: validatedDetails\[idx\].join/);
  assert.match(composer, /editableDetailLines: validatedDetails\[idx\]/);
  assert.ok(composer.indexOf('const validatedDetails = await validateAdvisorOrderDetailsAction') < composer.indexOf('const clientId = await ensureClientId();', composer.indexOf('const validatedDetails =')));
  const actions = readFileSync(new URL('../../src/app/app/advisor/new/actions.ts', import.meta.url), 'utf8');
  const replacement = actions.slice(actions.indexOf('export async function replaceAdvisorOrderItemsAction'));
  assert.match(replacement, /normalizeAdvisorItemDetails\(ctx.supabase, input.items\)/);
  assert.match(replacement, /notes: details\[index\].join/);
  assert.doesNotMatch(replacement, /!isInternalOrderDetailLine/);
});

test('CRM benefits stay optional and distinguish reserved from delivered persisted lines', () => {
  const composer = readFileSync(new URL('../../src/app/app/advisor/new/AdvisorOrderComposer.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(composer, /getInitialCrmBenefitIds/);
  assert.match(composer, /el pedido puede continuar sin obsequio/i);
  assert.match(composer, /persistedOrderItemId: Number\(item\.id\)/);
  assert.match(composer, /Beneficio entregado/);
  assert.match(composer, /Reservado/);
  assert.doesNotMatch(composer, /redeemAdvisorCrmPlayBenefitsAction/);
});

test('advisor and master edits use the same atomic order command instead of partial item writes', () => {
  const advisorActions = readFileSync(new URL('../../src/app/app/advisor/new/actions.ts', import.meta.url), 'utf8');
  const advisorReplace = exportedFunctionBlock(advisorActions, 'replaceAdvisorOrderItemsAction');
  assert.match(advisorReplace, /rpc\(\s*['"]update_order_core_atomic_v1['"]/);
  assert.doesNotMatch(advisorReplace, /\.from\(['"]order_items['"]\)\s*\.insert/);
  assert.doesNotMatch(advisorReplace, /\.from\(['"]order_items['"]\)\s*\.delete/);

  const masterActions = readFileSync(new URL('../../src/app/app/master/dashboard/actions.ts', import.meta.url), 'utf8');
  const masterUpdate = exportedFunctionBlock(masterActions, 'updateOrderAction');
  assert.match(masterUpdate, /rpc\(\s*['"]update_order_core_atomic_v1['"] as never/);
  assert.doesNotMatch(masterUpdate, /\.from\(['"]order_items['"]\)\s*\.delete\(\)/);
});

test('the atomic database command preserves redeemed CRM rows and exposes only its authorized wrapper', () => {
  const core = readFileSync(new URL('../../supabase/migrations/20260911234222_order_edit_atomic_core_v1.sql', import.meta.url), 'utf8');
  const wrapper = readFileSync(new URL('../../supabase/migrations/20260911234443_fix_order_edit_atomic_wrapper_execution.sql', import.meta.url), 'utf8');
  assert.match(core, /delete from public\.order_items item[\s\S]*item\.crm_play_member_id is null/);
  assert.match(core, /Un beneficio ya aplicado no puede quitarse/);
  assert.match(core, /pg_advisory_xact_lock/);
  assert.match(wrapper, /security definer/);
  assert.match(wrapper, /grant execute[\s\S]*to authenticated/);
  assert.match(wrapper, /revoke all[\s\S]*from public, anon, service_role/);
});

test('CRM benefits reserve on item creation and become financial only on order delivery', () => {
  const lifecycle = readFileSync(
    new URL('../../supabase/migrations/20260912001929_crm_benefit_reservation_delivery_lifecycle_v1.sql', import.meta.url),
    'utf8',
  );
  assert.match(lifecycle, /status in \('reserved', 'redeemed', 'voided'\)/);
  assert.match(lifecycle, /create trigger crm_order_items_reserve_benefit[\s\S]*after insert on public\.order_items/);
  assert.match(lifecycle, /create trigger orders_finalize_crm_benefits_on_delivery[\s\S]*new\.status = 'delivered'/);
  assert.match(lifecycle, /old\.status = 'reserved' and new\.status = 'redeemed'/);
  assert.match(lifecycle, /crm_order_items_release_reservation[\s\S]*before delete on public\.order_items/);
  assert.match(lifecycle, /redemption\.status = 'reserved'[\s\S]*not exists/);
  assert.match(lifecycle, /status in \('reserved', 'redeemed'\)[\s\S]*order_id <> new\.order_id/);
  assert.match(lifecycle, /update_order_core_atomic_v2/);

  const context = readFileSync(new URL('../../src/lib/crm/advisor-order-context.ts', import.meta.url), 'utf8');
  assert.match(context, /\.eq\('benefit_status', 'available'\)/);
  assert.doesNotMatch(context, /\['available', 'reserved'\]/);
});
