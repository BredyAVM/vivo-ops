import { menuDocument } from './menu-fixtures.ts';
import type { OrderMenuEntry, OrderMenuGraph } from '../../src/lib/brands/order-menu.ts';
export const ids = { burger: '00000000-0000-4000-8000-000000000010', fries: '00000000-0000-4000-8000-000000000011',
  extra: '00000000-0000-4000-8000-000000000012', drink: '00000000-0000-4000-8000-000000000013', combo: '00000000-0000-4000-8000-000000000014' };
export function orderMenuGraph(): OrderMenuGraph {
  const burger=menuDocument('burger','Ensayo Original',5);
  burger.variants[0].burger!.ingredients.push({key:'bread',label:'Pan',removable:false});
  burger.variants[0].burger!.extras=[{entryId:ids.extra,variantKey:'standard',maxQty:2}];
  burger.variants.push({...structuredClone(burger.variants[0]),key:'double',label:'Doble',priceUsd:7});burger.variants[1].burger!.pattyCount=2;
  const fries=menuDocument('fries','Ensayo Papas',2);
  fries.variants.push({key:'large',label:'Grandes',priceUsd:3,burger:null});
  fries.friesUpgrades=[{fromKey:'standard',toKey:'large',supplementUsd:0.75}];
  const combo=menuDocument('combo','Ensayo Combo',15);
  combo.comboGroups=[{key:'burgers',label:'Hamburguesas',kind:'burger',quantity:2,choices:[{entryId:ids.burger,variantKey:'standard',supplementUsd:0},{entryId:ids.burger,variantKey:'double',supplementUsd:0.5}]},
    {key:'fries',label:'Papas',kind:'fries',quantity:2,choices:[{entryId:ids.fries,variantKey:'standard',supplementUsd:0}]},
    {key:'drink',label:'Bebida',kind:'drink',quantity:1,choices:[{entryId:ids.drink,variantKey:'standard',supplementUsd:0}]}];
  return {salesEnabled:false,entries:Object.entries({burger,fries,extra:menuDocument('extra','Ensayo Tocineta',0.75),drink:menuDocument('drink','Ensayo Bebida',2),combo})
    .map(([key,document],i)=>({entryId:ids[key as keyof typeof ids],revision:1,document,productId:document.kind==='extra'?null:1000+i,updatedAt:'2026-10-28T19:00:00Z'} satisfies OrderMenuEntry))};
}
