import { isMenuId, isVivoDrinkRef, type MenuDocument, type MenuVariant } from './menu-model.ts';
import { type MenuOrderQuote, type MenuUnitChoice, type OrderMenuGraph } from './order-menu.ts';

export const MUERDEME_STOCK_PREFIX = '@muerdeme-stock|';
export type MenuStockLine = { inventoryItemId: number; quantity: number; ingredientKey: string | null };
export type MenuStockRecipe = { schemaVersion: 1; mode: 'tracked' | 'untracked' | 'components'; note: string; lines: MenuStockLine[] };
export type MenuStockRevision = { entryId: string; variantKey: string; revision: number; signature: unknown; document: MenuStockRecipe };
export type MenuStockItem = { id: number; name: string; unitName: string; currentStock: number; eligible: boolean };
export type MenuKitchenUnit = { kind: 'burger' | 'fries' | 'drink'; label: string; quantity: number; removed: string[]; extras: string[]; slot: string };
export type MenuStockSnapshot = {
  certificateId?: string;
  version: 1; entryId: string; productId: number; status: 'ready' | 'pending';
  recipeRevisions: Record<string, number>; issues: string[];
  lines: { inventoryItemId: number; name: string; unitName: string; quantity: number }[]; kitchen: MenuKitchenUnit[];
};
export const stockRoot = '/app/admin/negocio/marcas/muerdeme/catalogo';
const check: (ok: unknown, message: string) => asserts ok = (ok, message) => { if (!ok) throw new Error(message); };
const obj = (value: unknown) => { check(value && typeof value === 'object' && !Array.isArray(value), 'La receta está incompleta.'); return value as Record<string, unknown>; };
export function parseMenuStockRecipe(value: unknown, kind: MenuDocument['kind'], variant: MenuVariant): MenuStockRecipe {
  const row = obj(value);
  check(Object.keys(row).length === 4 && ['schemaVersion','mode','note','lines'].every(k => k in row)
    && row.schemaVersion === 1 && ['tracked','untracked','components'].includes(String(row.mode)), 'Revisa la modalidad de consumo.');
  check(typeof row.note === 'string' && row.note.length <= 300 && Array.isArray(row.lines) && row.lines.length <= 80, 'Revisa la nota y los insumos de la receta.');
  if (row.mode === 'components') check(kind === 'combo' && !row.lines.length, 'Solo un combo puede obtener su consumo de los componentes.');
  if (row.mode === 'untracked') check(row.note.trim().length >= 4 && !row.lines.length, 'Indica por qué esta presentación no mueve inventario.');
  if (row.mode === 'tracked') check(row.lines.length > 0, 'Añade al menos un insumo y su cantidad.');
  const keys = new Set<string>();
  for (const raw of row.lines) {
    const line = obj(raw);
    check(Object.keys(line).length === 3 && ['inventoryItemId','quantity','ingredientKey'].every(k => k in line)
      && Number.isSafeInteger(line.inventoryItemId) && Number(line.inventoryItemId) > 0
      && typeof line.quantity === 'number' && Number.isFinite(line.quantity) && line.quantity > 0 && line.quantity < 1e9
      && Number(line.quantity.toFixed(6)) === line.quantity, 'Selecciona un insumo y una cantidad positiva de hasta seis decimales.');
    check(line.ingredientKey === null || (kind === 'burger' && typeof line.ingredientKey === 'string'
      && variant.burger?.ingredients.some(i => i.key === line.ingredientKey)), 'El ingrediente no pertenece a esta presentación.');
    const key = `${line.inventoryItemId}:${line.ingredientKey ?? ''}`;
    check(!keys.has(key), 'Ese insumo e ingrediente ya están relacionados.'); keys.add(key);
  }
  return row as unknown as MenuStockRecipe;
}
export function menuStockSignature(kind: MenuDocument['kind'], variant: MenuVariant) {
  return { kind, key: variant.key, pattyCount: variant.burger?.pattyCount ?? null,
    ingredients: [...(variant.burger?.ingredients ?? [])].map(i => ({ key: i.key, label: i.label })).sort((a,b) => a.key<b.key?-1:a.key>b.key?1:0) };
}
const sameSignature = (a: unknown,b: unknown) => {
  const stable = (v: unknown): string => {
    if (Array.isArray(v)) return '['+v.map(stable).join(',')+']';
    if (v && typeof v === 'object') return '{'+Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>JSON.stringify(k)+':'+stable(x)).join(',')+'}';
    return JSON.stringify(v);
  };
  return stable(a) === stable(b);
};
/** Quantity-only operational recipe; prices and financial terms never enter this calculation. */
export function buildMenuStockSnapshot(graph: OrderMenuGraph, quote: MenuOrderQuote, recipes: MenuStockRevision[], items: MenuStockItem[]): MenuStockSnapshot {
  const byId = new Map(graph.entries.map(e => [e.entryId,e]));
  const stocks = new Map(items.map(i => [i.id,i]));
  const totals = new Map<number,number>(); const issues = new Set<string>();
  const recipeRevisions: Record<string,number> = {}; const kitchen: MenuKitchenUnit[] = [];
  const consume = (unit: MenuUnitChoice, quantity: number) => {
    const entry = byId.get(unit.entryId), variant = entry?.document.variants.find(v => v.key === unit.variantKey);
    if (!entry || !variant) { issues.add('Falta una presentación de la configuración.'); return; }
    if(isVivoDrinkRef(entry.entryId)){
      if(!entry.sharedStock?.lines.length){issues.add(`Revisar inventario VIVO: ${entry.document.name}.`);return;}
      recipeRevisions[`${entry.entryId}:${variant.key}`]=entry.sharedStock.revision;
      for(const line of entry.sharedStock.lines){
        const stock=stocks.get(line.inventoryItemId);
        if(!stock?.eligible){issues.add(`La bebida ${entry.document.name} no está habilitada para consumo por venta.`);continue;}
        const value=(totals.get(stock.id)??0)+line.quantity*quantity;
        if(!Number.isFinite(value)||value>=1e9){issues.add('El consumo supera el límite permitido.');continue;}
        totals.set(stock.id,value);
      }
      return;
    }
    const recipe = recipes.find(r => r.entryId === unit.entryId && r.variantKey === unit.variantKey);
    if (!recipe && entry.document.kind === 'combo') { recipeRevisions[`${unit.entryId}:${unit.variantKey}`] = 0; return; }
    if (!recipe || !sameSignature(recipe.signature, menuStockSignature(entry.document.kind,variant))) {
      issues.add(`Revisar consumo: ${entry.document.name} · ${variant.label}.`); return;
    }
    recipeRevisions[`${unit.entryId}:${unit.variantKey}`] = recipe.revision;
    for (const line of recipe.document.lines) {
      if (line.ingredientKey && unit.removed.includes(line.ingredientKey)) continue;
      const stock = stocks.get(line.inventoryItemId);
      if (!stock?.eligible) { issues.add(`El insumo de ${entry.document.name} ya no está habilitado para consumo por venta.`); continue; }
      const value = (totals.get(stock.id) ?? 0) + line.quantity * quantity;
      if (!Number.isFinite(value) || value >= 1e9) { issues.add('El consumo supera el límite permitido.'); continue; }
      totals.set(stock.id, value);
    }
  };
  const unit = (choice: MenuUnitChoice, slot: string, quantity = 1) => {
    const entry = byId.get(choice.entryId), variant = entry?.document.variants.find(v => v.key === choice.variantKey);
    if (!entry || !variant) { issues.add('Falta una presentación de la configuración.'); return; }
    if (entry.document.kind === 'fries' && choice.friesUpgrade) {
      unit({ ...choice, variantKey: choice.friesUpgrade, friesUpgrade: null },slot,quantity); return;
    }
    consume(choice,quantity);
    if (entry.document.kind === 'burger' || entry.document.kind === 'fries' || entry.document.kind === 'drink') kitchen.push({
      kind: entry.document.kind, label: `${entry.document.name} · ${variant.label}`, quantity, slot,
      removed: choice.removed.map(key => variant.burger?.ingredients.find(i => i.key === key)?.label ?? key),
      extras: choice.extras.map(extra => { const e = byId.get(extra.entryId); return `${extra.quantity} ${e?.document.name} · ${e?.document.variants.find(v=>v.key===extra.variantKey)?.label}`; }),
    });
    for (const extra of choice.extras) consume({ ...extra, removed: [], extras: [], friesUpgrade: null },extra.quantity * quantity);
    const fries = variant.burger?.includedFries;
    if (fries) unit({ ...fries, variantKey: choice.friesUpgrade ?? fries.variantKey, removed: [], extras: [], friesUpgrade: null },slot ? `${slot} · Papas incluidas` : 'Papas incluidas', fries.quantity * quantity);
  };
  const root = byId.get(quote.selection.entryId);
  if (root?.document.kind === 'combo') {
    consume(quote.selection,1);
    for (const slot of quote.selection.slots) {
      const group = root.document.comboGroups.find(g => g.key === slot.groupKey);
      unit(slot,`${group?.label ?? slot.groupKey} ${slot.position+1}`);
    }
  } else unit(quote.selection,'');
  const lines = [...totals].sort(([a],[b])=>a-b).map(([id,quantity])=>({ inventoryItemId:id, name:stocks.get(id)!.name,
    unitName:stocks.get(id)!.unitName, quantity:Number(quantity.toFixed(6)) }));
  return { version:1, entryId:quote.selection.entryId, productId:quote.productId, status:issues.size?'pending':'ready',
    recipeRevisions, issues:[...issues].sort(), lines:issues.size?[]:lines, kitchen };
}
export function readMenuStockSnapshot(notes: string | null | undefined): MenuStockSnapshot | null {
  const lines = String(notes ?? '').split('\n').map(l=>l.trim()).filter(l=>l.startsWith(MUERDEME_STOCK_PREFIX));
  if (!lines.length) return null;
  check(lines.length === 1 && lines[0].length < 120000, 'El consumo guardado está incompleto.');
  const row = obj(JSON.parse(lines[0].slice(MUERDEME_STOCK_PREFIX.length)));
  check(row.version === 1 && isMenuId(row.entryId) && Number.isSafeInteger(row.productId) && Number(row.productId)>0
    && (row.certificateId === undefined || isMenuId(row.certificateId))
    && ['ready','pending'].includes(String(row.status)) && Array.isArray(row.issues) && row.issues.every(i=>typeof i==='string')
    && Array.isArray(row.lines) && row.lines.length<=300 && Array.isArray(row.kitchen) && row.kitchen.length<=300, 'El consumo guardado está incompleto.');
  for (const raw of row.kitchen) {
    const unit=obj(raw);check(['burger','fries','drink'].includes(String(unit.kind)) && typeof unit.label==='string' && typeof unit.slot==='string'
      && typeof unit.quantity==='number' && unit.quantity>0 && unit.quantity<=100
      && Array.isArray(unit.removed) && unit.removed.every(i=>typeof i==='string') && Array.isArray(unit.extras) && unit.extras.every(i=>typeof i==='string'),'La preparación guardada está incompleta.');
  }
  for (const raw of row.lines) { const line=obj(raw);check(Number.isSafeInteger(line.inventoryItemId) && Number(line.inventoryItemId)>0
    && typeof line.quantity==='number' && Number.isFinite(line.quantity) && line.quantity>0
    && typeof line.name==='string' && typeof line.unitName==='string','El consumo guardado contiene cantidades inválidas.'); }
  return row as unknown as MenuStockSnapshot;
}
