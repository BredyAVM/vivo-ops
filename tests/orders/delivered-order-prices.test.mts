import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateDeliveredPriceChanges } from '../../src/lib/orders/delivered-order-prices.ts';

test('unit price validation: zero is valid; precision, duplicates and invalid amounts are rejected',()=>{
  assert.deepEqual(validateDeliveredPriceChanges([{itemId:1,unitPriceUsd:0}],'Corrección'),[{itemId:1,unitPriceUsd:0}]);
  for(const price of [-1,NaN,Infinity,0.001])assert.throws(()=>validateDeliveredPriceChanges([{itemId:1,unitPriceUsd:price}],'Corrección'));
  assert.throws(()=>validateDeliveredPriceChanges([{itemId:1,unitPriceUsd:2},{itemId:1,unitPriceUsd:3}],'Corrección'));
  assert.throws(()=>validateDeliveredPriceChanges([{itemId:1,unitPriceUsd:2}],''));
});
test('delivered price entry is admin-only and loads on click, not during rendering',()=>{
  const workspace=readFileSync(new URL('../../src/components/orders/OrdersWorkspaceClient.tsx',import.meta.url),'utf8');
  const ui=readFileSync(new URL('../../src/components/orders/DeliveredOrderPriceEditor.tsx',import.meta.url),'utf8');
  const action=readFileSync(new URL('../../src/app/app/admin/orders/price-actions.ts',import.meta.url),'utf8');
  assert.match(workspace,/isAdmin && order.status === "delivered"[\s\S]*?<DeliveredOrderPriceEditor/);
  assert.match(ui,/async function open\(\)[\s\S]*?loadDeliveredOrderPriceEditor\(orderId\)/);
  assert.doesNotMatch(ui,/useEffect/);assert.match(ui,/Precio unitario \(USD\)/);assert.match(ui,/formatOrderDisplayNumber\(orderId\)/);
  assert.equal((action.match(/await requireAdminContext\(\)/g)??[]).length,2);
  assert.doesNotMatch(action,/updateOrderAction|InventoryDeductions|service_role/);
});
