'use server';

import { requireAdminContext, requireAuthContext } from '@/lib/auth';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { isMenuId, isMenuReferenceId, menuRoot, parseMenuDocument, type MenuDocument } from './menu-model';
import { parseMenuOrderSelection } from './order-menu';
import { parseMenuStockRecipe, readMenuStockSnapshot, MUERDEME_STOCK_PREFIX, type MenuStockRecipe, type MenuStockItem } from './inventory-menu';

export type MenuStockEditorData = {
  entryId:string;menuRevision:number;menu:MenuDocument;variantKey:string;
  recipe:null|{revision:number;document:MenuStockRecipe;updatedAt:string;signatureMatches:boolean};items:MenuStockItem[];hasMore:boolean;
};
export async function loadMuerdemeStockEditor(entryId:string,variantKey:string|null,query=''):Promise<MenuStockEditorData|null>{
 const {supabase}=await requireAdminContext();
 if(!isMenuId(entryId)||(variantKey!==null&&!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(variantKey))||typeof query!=='string'||query.length>100)throw new Error('Revisa la presentación y la búsqueda.');
 const {data,error}=await supabase.rpc('admin_muerdeme_inventory_recipe_read_v1',{p_entry_id:entryId,p_variant_key:variantKey,p_query:query.trim()});
 if(error?.code==='P0002')return null;
 if(error||!data||data.entryId!==entryId||!Number.isSafeInteger(data.menuRevision)||data.menuRevision<1
  ||!Array.isArray(data.items)||data.items.length>200||typeof data.hasMore!=='boolean')throw new Error('No se pudo consultar la preparación.');
 const menu=parseMenuDocument(data.menu);const variant=menu.variants.find(v=>v.key===data.variantKey);
 if(!variant)throw new Error('La presentación ya no existe.');
 const recipe=data.recipe as MenuStockEditorData['recipe'];
 if(recipe){
  if(!Number.isSafeInteger(recipe.revision)||recipe.revision<1||typeof recipe.signatureMatches!=='boolean'
    ||!Number.isFinite(Date.parse(recipe.updatedAt)))throw new Error('La receta recibida está incompleta.');
  if(recipe.signatureMatches)parseMenuStockRecipe(recipe.document,menu.kind,variant);
  else{
   // Retain stale ingredient links visibly so the administrator can repair them.
   parseMenuStockRecipe({...recipe.document,lines:recipe.document.lines.map(l=>({...l,ingredientKey:null}))},menu.kind,variant);
   if(recipe.document.lines.some(l=>l.ingredientKey!==null&&(typeof l.ingredientKey!=='string'||l.ingredientKey.length>64)))throw new Error('Revisa los ingredientes de la receta anterior.');
  }
 }
 const items=data.items as MenuStockItem[];
 if(items.some(i=>!Number.isSafeInteger(i.id)||i.id<=0||typeof i.name!=='string'||typeof i.unitName!=='string'
  ||typeof i.currentStock!=='number'||!Number.isFinite(i.currentStock)||typeof i.eligible!=='boolean'))throw new Error('La consulta de inventario está incompleta.');
 return {entryId,menuRevision:data.menuRevision,menu,variantKey:variant.key,recipe,items,hasMore:data.hasMore};
}
export async function saveMuerdemeStockRecipe(_previous:{error:string},form:FormData):Promise<{error:string}>{
 let destination='';
 try{
  const {supabase}=await requireAdminContext();const id=String(form.get('entryId')??'');const variantKey=String(form.get('variantKey')??'');
  const raw=form.get('document');const operation=String(form.get('operationId')??'');
  const expected=Number(form.get('revision'));const menuRevision=Number(form.get('menuRevision'));
  if(!isMenuId(id)||!isMenuId(operation)||!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(variantKey)
   ||typeof raw!=='string'||raw.length>24000||!Number.isSafeInteger(expected)||expected<0||!Number.isSafeInteger(menuRevision)||menuRevision<1)throw new Error('Vuelve a abrir la presentación antes de guardar.');
  const current=await loadMuerdemeStockEditor(id,variantKey);
  if(!current||current.menuRevision!==menuRevision)throw new Error('La configuración cambió. Vuelve a consultar antes de guardar.');
  const document=parseMenuStockRecipe(JSON.parse(raw),current.menu.kind,current.menu.variants.find(v=>v.key===variantKey)!);
  const {data,error}=await supabase.rpc('admin_muerdeme_inventory_recipe_save_v1',{p_entry_id:id,p_variant_key:variantKey,p_menu_revision:menuRevision,p_expected_revision:expected,p_document:document,p_operation_id:operation});
  if(error)throw new Error(error.code==='40001'?'La configuración cambió. Vuelve a consultar.':error.code==='22023'?error.message:'No se pudo guardar el consumo. Consulta la presentación antes de reintentar.');
  if(data?.revision!==expected+1)throw new Error('No se pudo comprobar el guardado. Vuelve a consultar.');
  destination=`${menuRoot}/${id}/inventario?`+new URLSearchParams({presentacion:variantKey,guardado:'1',returnTo:`${menuRoot}/${id}`});
  revalidatePath(`${menuRoot}/${id}/inventario`);
 }catch(error){return{error:error instanceof Error?error.message:'No se pudo guardar la receta.'};}
 redirect(destination);
}
export async function previewMuerdemePreparation(selection:unknown,revisions:Record<string,number>){
 const {supabase,roles}=await requireAuthContext();
 if(!roles.some(r=>['admin','master','advisor'].includes(r)))throw new Error('Requiere permisos de ventas.');
 const parsed=parseMenuOrderSelection(selection);
 if(!revisions||typeof revisions!=='object'||Array.isArray(revisions)||Object.keys(revisions).length>201
  ||Object.entries(revisions).some(([id,r])=>!isMenuReferenceId(id)||!Number.isSafeInteger(r)||r<1))throw new Error('Vuelve a consultar el producto.');
 const {data,error}=await supabase.rpc('muerdeme_inventory_preview_v1',{p_selection:parsed,p_revisions:revisions,p_order_id:null,p_certificate_id:null});
 if(error)throw new Error(error.code==='40001'||error.code==='22023'?error.message:'No se pudo consultar la preparación e inventario.');
 const snapshot=readMenuStockSnapshot(MUERDEME_STOCK_PREFIX+JSON.stringify(data?.snapshot));
 if(!snapshot||!Array.isArray(data.onHand)||data.onHand.some((i:{inventoryItemId:number;currentStock:number})=>!Number.isSafeInteger(i.inventoryItemId)||!Number.isFinite(i.currentStock)))throw new Error('La consulta de consumo está incompleta.');
 return{snapshot,onHand:data.onHand as {inventoryItemId:number;currentStock:number}[]};
}
