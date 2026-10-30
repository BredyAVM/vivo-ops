import test from 'node:test';
import assert from 'node:assert/strict';
import { assertMenuReferences, menuPendingIssues, parseMenuDocument, parseMenuMoney, type MenuLookup } from '../../src/lib/brands/menu-model.ts';
import { menuDocument } from './menu-fixtures.ts';
const burgerId='00000000-0000-4000-8000-000000000011';
const friesId='00000000-0000-4000-8000-000000000012';
const extraId='00000000-0000-4000-8000-000000000013';
const lookup = (entryId:string, kind:MenuLookup['kind'],hasFries=false):MenuLookup => ({
  entryId,kind,name:kind,archived:false,variants:[{key:'standard',label:'Normal',priceUsd:5,hasFries}],
});

test('only combos accept an optional fixed USD incentive; inherited and explicit zero differ',()=>{
  const combo=menuDocument('combo','Combo',15);
  assert.equal(parseMenuDocument(combo).comboIncentiveUsd,undefined);
  for(const amount of[null,0,0.2,0.65])assert.equal(parseMenuDocument({...combo,comboIncentiveUsd:amount}).comboIncentiveUsd,amount);
  for(const amount of[-1,0.123,'0.50',true,undefined])assert.throws(()=>parseMenuDocument({...combo,comboIncentiveUsd:amount}),/estímulo fijo/);
  assert.throws(()=>parseMenuDocument({...menuDocument('burger','Hamburguesa'),comboIncentiveUsd:0.5}),/Solo los combos/);
});
test('each burger presentation retains its ingredients, removable flags and individual extras',()=>{
  const doc=menuDocument('burger','Ensayo hamburguesa');
  doc.variants.push({...structuredClone(doc.variants[0]),key:'double',label:'Doble',priceUsd:7});
  doc.variants[1].burger!.pattyCount=2;
  doc.variants[1].burger!.extras=[{entryId:extraId,variantKey:'standard',maxQty:2}];
  const parsed=parseMenuDocument(doc);
  assert.equal(parsed.variants[0].burger!.extras.length,0);
  assert.equal(parsed.variants[1].burger!.extras.length,1);
  assert.equal(parsed.variants[1].burger!.ingredients.length,2);
  assert.equal(parsed.variants[1].burger!.pattyCount,2);
  assertMenuReferences(parsed,[lookup(extraId,'extra')]);
});
test('fixed and selectable combos preserve their own price and quantity of configurable burgers',()=>{
  const doc=menuDocument('combo','Ensayo combo',15);
  doc.comboGroups=[{key:'burgers',label:'Hamburguesas',kind:'burger',quantity:2,choices:[{entryId:burgerId,variantKey:'standard',supplementUsd:0}]}];
  assertMenuReferences(parseMenuDocument(doc),[lookup(burgerId,'burger')]);
  doc.comboGroups[0].choices.push({entryId:'00000000-0000-4000-8000-000000000014',variantKey:'double',supplementUsd:0});
  assert.equal(parseMenuDocument(doc).variants[0].priceUsd,15);
  assert.equal(doc.comboGroups[0].quantity,2);
  assert.equal(doc.comboGroups[0].choices.length,2);
});
test('included fries and explicit combo fries cannot be silently duplicated',()=>{
  const burger=menuDocument('burger','Ensayo con papas');
  burger.variants[0].burger!.includedFries={entryId:friesId,variantKey:'standard',quantity:1};
  assertMenuReferences(parseMenuDocument(burger),[lookup(friesId,'fries')]);
  const combo=menuDocument('combo','Ensayo combo');
  combo.comboGroups=[{key:'burgers',label:'Hamburguesas',kind:'burger',quantity:2,choices:[{entryId:burgerId,variantKey:'standard',supplementUsd:0}]},
    {key:'fries',label:'Papas',kind:'fries',quantity:2,choices:[{entryId:friesId,variantKey:'standard',supplementUsd:0}]}];
  assert.throws(()=>assertMenuReferences(combo,[lookup(burgerId,'burger',true),lookup(friesId,'fries')]),/ya incluyen papas/);
});
test('fries upgrades carry an explicit USD supplement and never rewrite the base presentation',()=>{
  const doc=menuDocument('fries','Ensayo papas',2);
  doc.variants.push({key:'large',label:'Grandes',priceUsd:3,burger:null});
  doc.friesUpgrades=[{fromKey:'standard',toKey:'large',supplementUsd:0.75}];
  assert.equal(parseMenuDocument(doc).friesUpgrades[0].supplementUsd,0.75);
  assert.equal(doc.variants[0].priceUsd,2);
  doc.friesUpgrades[0].toKey='missing';
  assert.throws(()=>parseMenuDocument(doc),/ampliación/);
});
test('drafts distinguish a pending price from an explicit free price',()=>{
  const doc=menuDocument('drink','Ensayo bebida',null);
  assert.ok(menuPendingIssues(parseMenuDocument(doc)).includes('Completar precios en USD'));
  doc.variants[0].priceUsd=0;
  assert.deepEqual(menuPendingIssues(parseMenuDocument(doc)),[]);
  assert.equal(parseMenuMoney('',true),null);
  assert.equal(parseMenuMoney('0'),0);
  assert.equal(parseMenuMoney('1,25'),1.25);
  assert.throws(()=>parseMenuMoney('1.255'),/dos decimales/);
});
test('foreign kinds, duplicate choices, negative fees and unknown document fields fail closed',()=>{
  const burger=menuDocument('burger','Ensayo hamburguesa');
  burger.variants[0].burger!.extras=[{entryId:friesId,variantKey:'standard',maxQty:1}];
  assert.throws(()=>assertMenuReferences(burger,[lookup(friesId,'fries')]),/opción vinculada/);
  const bad=menuDocument('combo','Ensayo combo');
  bad.comboGroups=[{key:'b',label:'Hamburguesas',kind:'burger',quantity:2,choices:[{entryId:burgerId,variantKey:'standard',supplementUsd:-1}]}];
  assert.throws(()=>parseMenuDocument(bad),/suplemento/);
  assert.throws(()=>parseMenuDocument({...burger,brandCode:'vivo'}),/campos no admitidos/);
  const extra=menuDocument('extra','Ensayo extra');
  extra.variants.push(structuredClone(extra.variants[0]));
  assert.throws(()=>parseMenuDocument(extra),/presentaciones duplicadas/);
});

test('a combo may reference an existing VIVO beverage only in its drink group',()=>{
  const doc=menuDocument('combo','Combo',15);
  doc.comboGroups=[{key:'drink',label:'Bebida',kind:'drink',quantity:1,choices:[{entryId:'vivo:40',variantKey:'standard',supplementUsd:0}]}];
  assertMenuReferences(parseMenuDocument(doc),[lookup('vivo:40','drink')]);
  for(const id of['vivo:0','vivo:040','vivo:-1','vivo:1.5','vivo:9007199254740992']){
    const bad=structuredClone(doc);bad.comboGroups[0].choices[0].entryId=id;
    assert.throws(()=>parseMenuDocument(bad),/presentación válida/);
  }
  doc.comboGroups[0].kind='burger';assert.throws(()=>parseMenuDocument(doc),/presentación válida/);
});
