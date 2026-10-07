import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getOrderItemDisplayGroup,
  groupOrderItemsByPriority,
  sortOrderItemsByPriority,
} from '../../src/lib/orders/order-item-priority.ts';

function permutations<T>(values: T[]): T[][] {
  if (values.length < 2) return [values];
  return values.flatMap((value, index) => permutations(values.filter((_, i) => i !== index))
    .map((rest) => [value, ...rest]));
}

test('every insertion order shows main food, standalone products, sauces, beverages, delivery', () => {
  const items = [
    { id: 1, productName: 'Mini Tequenos', productType: 'service', price: 12 },
    { id: 2, productName: 'Dondys', productType: 'product', price: 3 },
    { id: 3, productName: 'Mostaza miel', productType: 'product', price: 1 },
    { id: 4, productName: 'Pepsi', productType: 'product', price: 2 },
    { id: 5, productName: 'Delivery Zona 2', productType: 'product', price: 4 },
  ];
  for (const input of permutations(items)) {
    const original = [...input];
    const output = sortOrderItemsByPriority(input, (item) => item);
    assert.deepEqual(output.map((item) => item.id), [1, 2, 3, 4, 5]);
    assert.deepEqual(output.map((item) => item.price), [12, 3, 1, 2, 4]);
    assert.deepEqual(input, original);
    for (const item of output) assert.equal(item, items.find((source) => source.id === item.id));
  }
});

test('catalog families classify unfamiliar names and explicit delivery wins', () => {
  assert.equal(getOrderItemDisplayGroup({ productName: 'Marca especial', inventoryGroup: 'beverages' }), 'beverages');
  assert.equal(getOrderItemDisplayGroup({ productName: 'Preparacion especial', inventoryGroup: 'sauces' }), 'sauces');
  assert.equal(getOrderItemDisplayGroup({ productName: 'Salsa especial', inventoryGroup: 'fried' }), 'products');
  assert.equal(getOrderItemDisplayGroup({ productName: 'Zona 1', isDelivery: true }), 'delivery');
  assert.equal(getOrderItemDisplayGroup({ productName: 'Zona 2', internalRiderPayUsd: 1 }), 'delivery');
});

test('combos mentioning sauces and beverages remain main products', () => {
  assert.equal(getOrderItemDisplayGroup({ productName: 'Combo con salsa y Pepsi', productType: 'combo' }), 'combos');
  assert.equal(getOrderItemDisplayGroup({ productName: 'Servicio con salsa', productType: 'service' }), 'services');
  assert.equal(getOrderItemDisplayGroup({ productName: 'Obsequio con refresco', productType: 'gambit' }), 'gifts');
});

test('stable display entries preserve original pricing indexes and grouped labels', () => {
  const items = [
    { productName: 'Delivery' },
    { productName: 'Pepsi 2 Lts' },
    { productName: 'Tequenos' },
    { productName: 'Tequenos queso' },
    { productName: 'Salsa tartara' },
  ];
  const snapshots = [10, 20, 30, 40, 50];
  const sorted = sortOrderItemsByPriority(items.map((item, index) => ({ item, index })), ({ item }) => item);
  assert.deepEqual(sorted.map(({ index }) => snapshots[index]), [30, 40, 50, 20, 10]);
  assert.deepEqual(groupOrderItemsByPriority(items, (item) => item).map((group) => group.label),
    ['Productos', 'Salsas', 'Bebidas', 'Delivery']);
});
