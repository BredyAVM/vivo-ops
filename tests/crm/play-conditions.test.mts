import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPlayConditions, playValidityLabel, playLastDayLabel, type PlayConditionsDefinition, type PlayConditionsBenefit } from '../../src/lib/crm/play-conditions.ts';

const play: PlayConditionsDefinition = {
  starts_at:'2026-10-01T04:00:00Z',ends_at:'2026-11-01T03:59:59.999Z',status:'active',
  benefit_selection_mode:'single',purchase_requirement_mode:'none',minimum_order_amount_usd:null,
  benefit_recurrence_mode:'once',benefit_fulfillment:'any',
};
const benefit: PlayConditionsBenefit = {id:1,name:'Single Pack (6 und) + salsa',quantity:1,benefitValueUsd:4,advisorCostUsd:1.5,upgrades:[]};
const values = (p: PlayConditionsDefinition, options=[benefit]) => Object.fromEntries(buildPlayConditions(p,options).map(row=>[row.label,row.value]));

test('ordinary gift has six concise rules and does not imply free credit or arbitrary swaps',()=>{
  const rows=values(play);
  assert.equal(Object.keys(rows).length,6);
  assert.equal(rows.Obsequio,'1 × Single Pack (6 und) + salsa');
  assert.equal(rows['Compra mínima'],'Sin compra requerida');
  assert.match(rows['Uso permitido'],/Una vez por cliente/);
  assert.match(rows['Cambios y ampliaciones'],/Sin ampliaciones.*no se cambia por saldo/);
});
test('Focus explains one per DELIVERY day, repetition, products-only minimum and channel',()=>{
  const p={...play,benefit_recurrence_mode:'daily' as const,purchase_requirement_mode:'minimum_order' as const,minimum_order_amount_usd:10,benefit_fulfillment:'pickup' as const};
  const rows=values(p);
  assert.match(rows['Uso permitido'],/1 por cliente y día de entrega.*repetible/);
  assert.match(rows['Compra mínima'],/\$10.00 en productos.*sin delivery ni obsequios/);
  assert.equal(rows.Entrega,'Solo retiro en el local');
  assert.match(values({...p,benefit_fulfillment:'delivery_zone_1'}).Entrega,/Delivery zona 1.*confirmar/);
});
test('only configured upgrades authorize using the benefit toward a larger product',()=>{
  const options=[{...benefit,upgrades:[{id:2,name:'Single Pack (8 und)',customerDifferenceUsd:2}]}];
  assert.match(values(play,options)['Cambios y ampliaciones'],/Solo opciones autorizadas.*cliente paga la diferencia/);
  assert.equal(values(play,[]).Obsequio,'Pendiente de configurar');
});
test('multiple choices and combinations remain distinct',()=>{
  const options=[benefit,{...benefit,id:2,name:'Delivery'}];
  assert.equal(values(play,options).Obsequio,'Elige 1 de 2 beneficios');
  assert.equal(values({...play,benefit_selection_mode:'multiple'},options).Obsequio,'Puede combinar hasta 2 beneficios');
});
test('inclusive day in Caracas is shown correctly, including exclusive-midnight legacy data',()=>{
  assert.match(playValidityLabel(play),/31.*oct.*2026/);
  assert.match(playLastDayLabel('2026-11-01T04:00:00Z'),/31.*oct/);
  assert.match(playLastDayLabel('2026-10-31'),/31.*oct/);
  assert.equal(playLastDayLabel(null),'durante esta jugada');
  assert.equal(playValidityLabel({...play,starts_at:null,ends_at:null}),'Sin período definido');
});
