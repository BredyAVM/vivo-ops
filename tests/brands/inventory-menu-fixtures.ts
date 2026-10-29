import { orderMenuGraph, ids } from './order-menu-fixtures.ts';
import { menuStockSignature, type MenuStockItem, type MenuStockRevision } from '../../src/lib/brands/inventory-menu.ts';
import type { OrderMenuGraph } from '../../src/lib/brands/order-menu.ts';
export { ids, orderMenuGraph };
export const stocks: MenuStockItem[] = [
 {id:1,name:'Ensayo Pan',unitName:'pieza',currentStock:100,eligible:true},
 {id:2,name:'Ensayo Carne',unitName:'kg',currentStock:50,eligible:true},
 {id:3,name:'Ensayo Salsa',unitName:'litro',currentStock:5,eligible:true},
 {id:4,name:'Ensayo Tocineta',unitName:'kg',currentStock:10,eligible:true},
 {id:5,name:'Ensayo Papas',unitName:'kg',currentStock:50,eligible:true},
 {id:6,name:'Ensayo Bebida',unitName:'botella',currentStock:100,eligible:true},
];
export function stockRecipes(graph:OrderMenuGraph):MenuStockRevision[]{
 return graph.entries.filter(e=>e.document.kind!=='combo').flatMap(entry=>entry.document.variants.map(variant=>({
  entryId:entry.entryId,variantKey:variant.key,revision:1,signature:menuStockSignature(entry.document.kind,variant),
  document:{schemaVersion:1,mode:'tracked',note:'Ensayo; cantidades ficticias para pruebas',lines:
   entry.document.kind==='burger'?[{inventoryItemId:1,quantity:1,ingredientKey:null},{inventoryItemId:2,quantity:variant.burger!.pattyCount*0.1,ingredientKey:null},{inventoryItemId:3,quantity:0.02,ingredientKey:'sauce'}]:
   [{inventoryItemId:entry.document.kind==='extra'?4:entry.document.kind==='fries'?5:6,quantity:entry.document.kind==='extra'?0.025:entry.document.kind==='fries'?(variant.key==='large'?0.2:0.1):1,ingredientKey:null}]}
 })));
}
