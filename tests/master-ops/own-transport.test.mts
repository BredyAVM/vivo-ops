import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readOwnTransport } from '../../src/lib/orders/own-transport.ts';
const read=(p:string)=>readFileSync(new URL('../../'+p,import.meta.url),'utf8');
test('own transport presentation requires explicit zero/source/version and does not classify ordinary zero delivery',()=>{
 const delivery={cost_usd:0,cost_source:'own_transport_v1',own_transport:{version:1,name:' Bredy ',phone:' 04140000000 '}};
 assert.deepEqual(readOwnTransport({delivery}),{name:'Bredy',phone:'04140000000'});
 for(const value of [null,{}, {delivery:{...delivery,cost_usd:null}}, {delivery:{...delivery,cost_usd:1}},
  {delivery:{...delivery,cost_source:'external_partner_manual_v1'}},{delivery:{...delivery,own_transport:{version:0,name:'Bredy'}}}]) assert.equal(readOwnTransport(value),null);
});
test('Master form requires a name, states unchanged customer charge and retains operation key for retries',()=>{
 const ui=read('src/components/orders/OrdersWorkspaceClient.tsx');
 assert.match(ui,/Transporte propio · sin pago por viaje/);
 assert.match(ui,/ownTransportRequest.current \?\?= crypto.randomUUID\(\)/);
 assert.match(ui,/fieldset disabled=\{busy\}/);
 assert.match(ui,/No cambia el delivery cobrado al cliente/);
 assert.match(ui,/debe rendirlo normalmente/);
 const action=read('src/app/app/master/ops/own-transport-actions.ts');
 assert.match(action,/requireMasterOrAdminContext\(\)/);assert.match(action,/assign_own_transport_v1/);
 assert.doesNotMatch(action,/service_role|money_movements|payment_reports|\/master\/dashboard/);
});
