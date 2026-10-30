import { isMenuId, isMenuReferenceId, isVivoDrinkRef, parseMenuDocument, type MenuDocument, type MenuEntry, type MenuReference, type MenuVariant } from './menu-model.ts';

export const MUERDEME_DETAIL_PREFIX = '@muerdeme|';
export type OrderMenuEntry = MenuEntry & { productId: number | null;
  sharedStock?: { revision:number;lines: {inventoryItemId:number;name:string;unitName:string;quantity:number}[] } };
export type OrderMenuGraph = { salesEnabled: boolean; entries: OrderMenuEntry[] };
export type MenuUnitChoice = MenuReference & {
  removed: string[]; extras: (MenuReference & { quantity: number })[]; friesUpgrade: string | null;
};
export type MenuOrderSelection = MenuUnitChoice & {
  slots: (MenuUnitChoice & { groupKey: string; position: number })[];
};
export type MenuOrderQuote = {
  version: 1; brand: 'muerdeme'; productId: number; title: string; unitUsd: number;
  selection: MenuOrderSelection; revisions: Record<string, number>; detailLines: string[];
};
const check: (ok: unknown, message: string) => asserts ok = (ok, message) => { if (!ok) throw new Error(message); };
function record(value: unknown, keys: string[]) {
  check(value && typeof value === 'object' && !Array.isArray(value), 'La configuración del pedido está incompleta.');
  const row = value as Record<string, unknown>;
  check(Object.keys(row).length === keys.length && Object.keys(row).every(k => keys.includes(k)), 'Hay opciones del pedido no admitidas.');
  return row;
}
const unitKeys = ['entryId', 'variantKey', 'removed', 'extras', 'friesUpgrade'];
function parseUnit(value: unknown, additional: string[] = []): MenuUnitChoice & Record<string, unknown> {
  const row = record(value, [...unitKeys, ...additional]);
  check(isMenuReferenceId(row.entryId) && typeof row.variantKey === 'string' && /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(row.variantKey)
    && (!isVivoDrinkRef(row.entryId) || row.variantKey === 'standard'), 'Selecciona una presentación válida.');
  check(Array.isArray(row.removed) && row.removed.length <= 40 && row.removed.every(v => typeof v === 'string' && v.length <= 64)
    && new Set(row.removed).size === row.removed.length, 'Revisa los ingredientes retirados.');
  check(Array.isArray(row.extras) && row.extras.length <= 40, 'Revisa los extras.');
  for (const raw of row.extras) {
    const extra = record(raw, ['entryId', 'variantKey', 'quantity']);
    check(isMenuId(extra.entryId) && typeof extra.variantKey === 'string' && extra.variantKey.length <= 64
      && Number.isSafeInteger(extra.quantity) && Number(extra.quantity) >= 1 && Number(extra.quantity) <= 20, 'Revisa la cantidad del extra.');
  }
  check(new Set(row.extras.map(e => `${e.entryId}:${e.variantKey}`)).size === row.extras.length, 'Hay extras duplicados.');
  check(row.friesUpgrade === null || (typeof row.friesUpgrade === 'string' && row.friesUpgrade.length <= 64), 'Revisa la ampliación de papas.');
  return row as MenuUnitChoice & Record<string, unknown>;
}
export function parseMenuOrderSelection(value: unknown): MenuOrderSelection {
  const row = parseUnit(value, ['slots']);
  check(isMenuId(row.entryId), 'Las bebidas VIVO vendidas aparte se añaden desde el catálogo habitual.');
  check(Array.isArray(row.slots) && row.slots.length <= 100, 'Revisa los componentes del combo.');
  for (const slot of row.slots) {
    const unit = parseUnit(slot, ['groupKey', 'position']);
    check(typeof unit.groupKey === 'string' && unit.groupKey.length <= 64 && Number.isSafeInteger(unit.position)
      && Number(unit.position) >= 0 && Number(unit.position) < 50, 'Revisa cada unidad del combo.');
  }
  check(new Set(row.slots.map(s => `${s.groupKey}:${s.position}`)).size === row.slots.length, 'Hay unidades duplicadas en el combo.');
  return row as MenuOrderSelection;
}
export function decodeOrderMenuGraph(value: unknown): OrderMenuGraph {
  const row = record(value, ['version', 'salesEnabled', 'entries']);
  check(row.version === 'muerdeme-order-menu-v1' && typeof row.salesEnabled === 'boolean'
    && Array.isArray(row.entries) && row.entries.length <= 201, 'No se pudo verificar el menú.');
  return { salesEnabled: row.salesEnabled, entries: row.entries.map(raw => {
    const shared = isVivoDrinkRef((raw as {entryId?:unknown}|null)?.entryId);
    const entry = record(raw, ['entryId', 'revision', 'document', 'updatedAt', 'productId', ...(shared ? ['sharedStock'] : [])]);
    check(isMenuReferenceId(entry.entryId) && Number.isSafeInteger(entry.revision) && Number(entry.revision) > 0
      && typeof entry.updatedAt === 'string' && Number.isFinite(Date.parse(entry.updatedAt))
      && (entry.productId === null || (Number.isSafeInteger(entry.productId) && Number(entry.productId) > 0)), 'El menú está incompleto.');
    const document=parseMenuDocument(entry.document);
    if(shared){
      const stock=entry.sharedStock as OrderMenuEntry['sharedStock'];
      check(document.kind==='drink' && entry.productId===Number(String(entry.entryId).slice(5))
        && stock && Number.isSafeInteger(stock.revision) && stock.revision>0 && Array.isArray(stock.lines) && stock.lines.length>0 && stock.lines.length<=80
        && stock.lines.every(l=>Number.isSafeInteger(l.inventoryItemId)&&l.inventoryItemId>0&&typeof l.name==='string'&&typeof l.unitName==='string'
          && Number.isFinite(l.quantity)&&l.quantity>0&&l.quantity<1e9),'El inventario de la bebida VIVO está incompleto.');
    }
    return { entryId: entry.entryId, revision: Number(entry.revision), updatedAt: entry.updatedAt,
      productId: entry.productId as number | null, document, ...(shared ? {sharedStock:entry.sharedStock as OrderMenuEntry['sharedStock']} : {}) };
  }) };
}
export function menuUnit(entryId: string, variantKey: string): MenuUnitChoice {
  return { entryId, variantKey, removed: [], extras: [], friesUpgrade: null };
}
export function defaultMenuOrderSelection(entry: OrderMenuEntry, variantKey = entry.document.variants[0]?.key): MenuOrderSelection {
  return { ...menuUnit(entry.entryId, variantKey), slots: entry.document.comboGroups.flatMap(group =>
    Array.from({ length: group.quantity }, (_, position) => ({
      ...menuUnit(group.choices[0].entryId, group.choices[0].variantKey), groupKey: group.key, position,
    }))) };
}

/** Pure calculation for the UI. The database independently validates the same selection at save time. */
export function quoteMenuOrder(graph: OrderMenuGraph, raw: unknown): MenuOrderQuote {
  const selection = parseMenuOrderSelection(raw);
  const byId = new Map(graph.entries.map(entry => [entry.entryId, entry]));
  const revisions: Record<string, number> = {};
  const resolve = (ref: MenuReference, kind?: MenuDocument['kind']) => {
    const entry = byId.get(ref.entryId);
    check(entry && !entry.document.archived && (!kind || entry.document.kind === kind), 'Una opción del menú ya no está disponible. Vuelve a consultar.');
    const variant = entry.document.variants.find(v => v.key === ref.variantKey);
    check(variant, 'Una presentación ya no está disponible. Vuelve a consultar.');
    revisions[entry.entryId] = entry.revision;
    return { entry, variant };
  };
  const cents = (price: number | null) => { check(price !== null, 'Falta definir el precio en USD.'); return Math.round(price * 100); };
  const { entry: root, variant: rootVariant } = resolve(selection);
  check(root.document.kind !== 'extra' && root.productId, 'Guarda este producto en el catálogo para prepararlo para pedidos.');
  const details: string[] = [];
  const label = (entry: OrderMenuEntry, variant: MenuVariant) => `${entry.document.name} · ${variant.label}`;
  const upgradeFries = (entry: OrderMenuEntry, variant: MenuVariant, upgrade: string | null, quantity: number) => {
    if (!upgrade) return { amount: 0, text: label(entry, variant) };
    const rule = entry.document.friesUpgrades.find(u => u.fromKey === variant.key && u.toKey === upgrade);
    check(rule, 'Esta ampliación de papas no está permitida.');
    const target = resolve({ entryId: entry.entryId, variantKey: upgrade }, 'fries');
    return { amount: cents(rule.supplementUsd) * quantity, text: label(target.entry, target.variant) };
  };
  const configureUnit = (unit: MenuUnitChoice, prefix: string) => {
    const { entry, variant } = resolve(unit);
    let amount = 0;
    details.push(`${prefix}${label(entry, variant)}`);
    if (entry.document.kind === 'burger') {
      const burger = variant.burger!;
      for (const key of unit.removed) {
        const ingredient = burger.ingredients.find(i => i.key === key);
        check(ingredient?.removable, 'No se puede retirar ese ingrediente de esta presentación.');
        details.push(`  Sin ${ingredient.label}`);
      }
      for (const extra of unit.extras) {
        const allowed = burger.extras.find(e => e.entryId === extra.entryId && e.variantKey === extra.variantKey);
        check(allowed && extra.quantity <= allowed.maxQty, 'El extra o su cantidad no están permitidos.');
        const component = resolve(extra, 'extra');
        const extraAmount = cents(component.variant.priceUsd) * extra.quantity;
        amount += extraAmount;
        details.push(`  Extra: ${extra.quantity} ${label(component.entry, component.variant)} · USD ${(extraAmount / 100).toFixed(2)}`);
      }
      if (burger.includedFries) {
        const fries = resolve(burger.includedFries, 'fries');
        const upgraded = upgradeFries(fries.entry, fries.variant, unit.friesUpgrade, burger.includedFries.quantity);
        amount += upgraded.amount;
        details.push(`  Incluye: ${burger.includedFries.quantity} ${upgraded.text}${upgraded.amount ? ` · Ampliación USD ${(upgraded.amount / 100).toFixed(2)}` : ''}`);
      } else check(unit.friesUpgrade === null, 'Esta hamburguesa no incluye papas para agrandar.');
    } else {
      check(!unit.removed.length && !unit.extras.length, 'Solo una hamburguesa admite ingredientes y extras.');
      if (entry.document.kind === 'fries') {
        const upgraded = upgradeFries(entry, variant, unit.friesUpgrade, 1);
        amount += upgraded.amount;
        if (unit.friesUpgrade) details.push(`  Ampliar a ${upgraded.text} · USD ${(upgraded.amount / 100).toFixed(2)}`);
      } else check(unit.friesUpgrade === null, 'Solo las papas admiten esta ampliación.');
    }
    return amount;
  };
  let total = cents(rootVariant.priceUsd);
  if (root.document.kind === 'combo') {
    check(!selection.removed.length && !selection.extras.length && selection.friesUpgrade === null, 'Configura cada hamburguesa dentro del combo.');
    check(selection.slots.length === root.document.comboGroups.reduce((sum, g) => sum + g.quantity, 0), 'Faltan unidades del combo.');
    for (const group of root.document.comboGroups) for (let position = 0; position < group.quantity; position++) {
      const slot = selection.slots.find(s => s.groupKey === group.key && s.position === position);
      check(slot, 'Falta elegir una unidad del combo.');
      const choice = group.choices.find(c => c.entryId === slot.entryId && c.variantKey === slot.variantKey);
      check(choice, 'La presentación elegida no pertenece a este combo.');
      resolve(slot, group.kind);
      total += cents(choice.supplementUsd) + configureUnit(slot, `${group.label} ${position + 1}: `);
      if (choice.supplementUsd) details.push(`  Suplemento USD ${choice.supplementUsd.toFixed(2)}`);
    }
  } else {
    check(selection.slots.length === 0, 'Este producto no admite componentes de combo.');
    total += configureUnit(selection, '');
  }
  check(Number.isSafeInteger(total) && total >= 0 && total < 1e11, 'El importe del producto supera el límite permitido.');
  return { version: 1, brand: 'muerdeme', productId: root.productId!, title: `Muérdeme · ${label(root, rootVariant)}`,
    unitUsd: total / 100, selection, revisions, detailLines: details };
}
export function menuQuoteDetailLines(quote: MenuOrderQuote) {
  return [...quote.detailLines, MUERDEME_DETAIL_PREFIX + JSON.stringify(quote)];
}
export function readMenuOrderQuote(lines: string[] | string | null | undefined): MenuOrderQuote | null {
  const markers = (Array.isArray(lines) ? lines : String(lines ?? '').split('\n')).filter(l => l.startsWith(MUERDEME_DETAIL_PREFIX));
  if (!markers.length) return null;
  check(markers.length === 1 && markers[0].length <= 45000, 'La configuración de Muérdeme está duplicada o es demasiado extensa.');
  const quote = record(JSON.parse(markers[0].slice(MUERDEME_DETAIL_PREFIX.length)), ['version', 'brand', 'productId', 'title', 'unitUsd', 'selection', 'revisions', 'detailLines']);
  check(quote.version === 1 && quote.brand === 'muerdeme' && Number.isSafeInteger(quote.productId) && Number(quote.productId) > 0
    && typeof quote.title === 'string' && typeof quote.unitUsd === 'number' && Number.isFinite(quote.unitUsd)
    && quote.unitUsd >= 0 && typeof quote.revisions === 'object' && quote.revisions !== null
    && Array.isArray(quote.detailLines) && quote.detailLines.every(l => typeof l === 'string'), 'La configuración guardada no está completa.');
  parseMenuOrderSelection(quote.selection);
  return quote as MenuOrderQuote;
}
export function hasMenuOrderDetails(lines: string[] | string | null | undefined) {
  return (Array.isArray(lines) ? lines : String(lines ?? '').split('\n')).some(line => line.startsWith(MUERDEME_DETAIL_PREFIX));
}
