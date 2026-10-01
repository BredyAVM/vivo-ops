import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { prepareEditorCommissionFields, readEditorCommissionFields } from '../../src/app/app/master/ops/order-editor-commission.ts';

const catalog = { commission_mode: 'fixed_item', commission_value: 4, extra_fields: {
  commission_schedule_v1: [{ effective_from: '2026-09-01', mode: 'fixed_item', value: 3 }],
} };
const override = { commissionInheritedMode: 'fixed_item' as const, commissionInheritedValue: 3,
  adminCommissionOverrideMode: 'fixed_item' as const, adminCommissionOverrideValue: 8,
  adminCommissionOverrideReason: 'Convenio vigente', adminCommissionOverrideChanged: false };

test('uses the dated catalogue and event/admin precedence, scoped to this item', () => {
  const loaded = readEditorCommissionFields(catalog, '2026-10-01', [
    { order_item_id: 11, payload: { kind: 'order_commission_terms', action: 'set', commission_mode: 'fixed_item', commission_value: 8 }, reason: 'Convenio vigente' },
    { order_item_id: 11, payload: { kind: 'event_commercial_terms', commission_mode: 'fixed_order', commission_value: 6 } },
    { order_item_id: 12, payload: { kind: 'order_commission_terms', commission_mode: 'none' } },
  ], 11);
  assert.equal(loaded.commissionInheritedMode, 'fixed_order');
  assert.equal(loaded.commissionInheritedValue, 6);
  assert.equal(loaded.commissionInheritedSource, 'event');
  assert.equal(loaded.adminCommissionOverrideValue, 8);
});
test('a clear never revives an older administrative override', () => {
  const loaded = readEditorCommissionFields(catalog, '2026-10-01', [
    { order_item_id: 11, payload: { kind: 'order_commission_terms', action: 'clear' } },
    { order_item_id: 11, payload: { kind: 'order_commission_terms', commission_mode: 'none' } },
  ], 11);
  assert.equal(loaded.adminCommissionOverrideMode, null);
  assert.equal(loaded.commissionInheritedValue, 3);
});
test('rejects forged Master overrides and removals before saving', () => {
  assert.throws(() => prepareEditorCommissionFields(override, {}, false), /Solo admin/);
  assert.throws(() => prepareEditorCommissionFields({ adminCommissionOverrideMode: null, adminCommissionOverrideChanged: true }, override, false), /Solo admin/);
  assert.deepEqual(prepareEditorCommissionFields({}, override, false), {});
});
test('an omitted commission preserves existing terms rather than clearing them', () => {
  assert.deepEqual(prepareEditorCommissionFields({}, override, true), {});
});
test('ignores forged inherited terms, change flag and reason on an unchanged override', () => {
  const result = prepareEditorCommissionFields({ ...override, commissionInheritedValue: 99,
    adminCommissionOverrideReason: 'Forged', adminCommissionOverrideChanged: true }, override, true);
  assert.equal(result.commissionInheritedValue, 3);
  assert.equal(result.adminCommissionOverrideReason, 'Convenio vigente');
  assert.equal(result.adminCommissionOverrideChanged, false);
});
test('derives a change server-side even if the client change flag is false', () => {
  const result = prepareEditorCommissionFields({ ...override, adminCommissionOverrideValue: 10,
    adminCommissionOverrideReason: 'Acuerdo de octubre' }, override, true);
  assert.equal(result.adminCommissionOverrideChanged, true);
  assert.equal(result.adminCommissionOverrideValue, 10);
});
test('requires a reason to set or remove a commission', () => {
  assert.throws(() => prepareEditorCommissionFields({ adminCommissionOverrideMode: 'none' }, {}, true), /motivo/);
  assert.throws(() => prepareEditorCommissionFields({ adminCommissionOverrideMode: null }, override, true), /motivo/);
  const cleared = prepareEditorCommissionFields({ adminCommissionOverrideMode: null,
    adminCommissionOverrideReason: 'Volver al catálogo' }, override, true);
  assert.equal(cleared.adminCommissionOverrideMode, null);
  assert.equal(cleared.adminCommissionOverrideChanged, true);
});
test('validates percentages without clamping an invalid value', () => {
  for (const value of [-1, 101, NaN, null]) {
    assert.throws(() => prepareEditorCommissionFields({ adminCommissionOverrideMode: 'fixed_item',
      adminCommissionOverrideValue: value, adminCommissionOverrideReason: 'Prueba' }, {}, true));
  }
  for (const value of [0, 100, 6.75]) {
    assert.equal(prepareEditorCommissionFields({ adminCommissionOverrideMode: 'fixed_item',
      adminCommissionOverrideValue: value, adminCommissionOverrideReason: 'Acuerdo' }, {}, true).adminCommissionOverrideValue, value);
  }
});
test('commission changes do not contain any price, payment or inventory writes', () => {
  const result = prepareEditorCommissionFields({ adminCommissionOverrideMode: 'none', adminCommissionOverrideReason: 'Sin comisión' }, {}, true);
  assert.ok(Object.keys(result).every((key) => key.includes('Commission') || key.startsWith('commission')));
});
test('shared save preserves omitted audited commission terms on replaced item ids', () => {
  const source = readFileSync(new URL('../../src/app/app/master/dashboard/actions.ts', import.meta.url), 'utf8');
  assert.match(source, /!Object.hasOwn\(item, 'adminCommissionOverrideMode'\) && previousAdminAdjustment[\s\S]*?commissionAdjustmentRebinds.push/);
});
test('commercial controls are admin-only and opened on demand', () => {
  const client = readFileSync(new URL('../../src/components/orders/OrdersWorkspaceClient.tsx', import.meta.url), 'utf8');
  const editor = readFileSync(new URL('../../src/app/app/master/ops/MasterOpsOrderEditor.tsx', import.meta.url), 'utf8');
  assert.match(client, /isAdmin && canEditMasterOpsOrder\(order\)[\s\S]*?Precios y comisiones/);
  assert.match(client, /editingOrderId !== null \? <MasterOpsOrderEditor/);
  assert.match(editor, /prepareEditorCommissionFields\(item, originalItemsById/);
  assert.match(editor, /Precio \/ comisión/);
});
