import assert from 'node:assert/strict';
import test from 'node:test';
import {
  inventoryDisplayText,
  inventoryUnitLabel,
  repairInventoryDisplayData,
} from '../../src/app/app/inventory/display.ts';

test('uses unidades instead of pieza or piezas in inventory copy', () => {
  assert.equal(inventoryDisplayText('25 piezas crudas'), '25 unidades crudas');
  assert.equal(inventoryDisplayText('Pieza cruda apartada'), 'Unidad cruda apartada');
});

test('shows UND for piece and unit aliases without changing other units', () => {
  assert.equal(inventoryUnitLabel('pieza'), 'UND');
  assert.equal(inventoryUnitLabel('unidades'), 'UND');
  assert.equal(inventoryUnitLabel('kg'), 'kg');
  assert.equal(inventoryUnitLabel('', 'unidad base'), 'unidad base');
});

test('normalizes unit fields throughout inventory workspaces', () => {
  assert.deepEqual(
    repairInventoryDisplayData({
      unit_name: 'pieza',
      output_unit_name: 'unidad',
      notes: 'Consume 10 piezas crudas',
    }),
    {
      unit_name: 'UND',
      output_unit_name: 'UND',
      notes: 'Consume 10 unidades crudas',
    },
  );
});
