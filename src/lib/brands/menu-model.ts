export const menuKinds = ['burger', 'extra', 'fries', 'drink', 'combo'] as const;
export type MenuKind = typeof menuKinds[number];
export const menuKindLabels: Record<MenuKind, string> = {
  burger: 'Hamburguesa', extra: 'Extra', fries: 'Papas', drink: 'Bebida', combo: 'Combo',
};
export const menuRoot = '/app/admin/negocio/marcas/muerdeme/catalogo';
export type MenuReference = { entryId: string; variantKey: string };
export type MenuBurger = {
  pattyCount: 1 | 2;
  ingredients: { key: string; label: string; removable: boolean }[];
  extras: (MenuReference & { maxQty: number })[];
  includedFries: (MenuReference & { quantity: number }) | null;
};
export type MenuVariant = { key: string; label: string; priceUsd: number | null; burger: MenuBurger | null };
export type MenuComboGroup = {
  key: string; label: string; kind: 'burger' | 'fries' | 'drink'; quantity: number;
  choices: (MenuReference & { supplementUsd: number })[];
};
export type MenuDocument = {
  schemaVersion: 1; kind: MenuKind; name: string; archived: boolean;
  /** Absent/null inherits the order policy; zero explicitly disables this combo's incentive. */
  comboIncentiveUsd?: number | null;
  variants: MenuVariant[];
  comboGroups: MenuComboGroup[];
  friesUpgrades: { fromKey: string; toKey: string; supplementUsd: number }[];
};
export type MenuEntry = { entryId: string; revision: number; document: MenuDocument; updatedAt: string };
export type MenuLookup = {
  entryId: string; name: string; kind: MenuKind; archived: boolean;
  variants: { key: string; label: string; priceUsd: number | null; hasFries: boolean }[];
};
export type MenuListItem = {
  entryId: string; revision: number; name: string; kind: MenuKind;
  archived: boolean; variantCount: number; missingPrices: number; updatedAt: string;
};
export type MenuEditorData = { entry: MenuEntry | null; lookups: MenuLookup[]; lookupHasMore: boolean };
export const isMenuId = (value: unknown): value is string => typeof value === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
export const isMenuKind = (value: unknown): value is MenuKind => menuKinds.includes(value as MenuKind);
const keyValid = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(value);
const textValid = (value: unknown, max = 100): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const integer = (value: unknown, max = 100): value is number => Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= max;
const priceValid = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
  && value >= 0 && value < 1e9 && Number(value.toFixed(2)) === value;
function check(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); }
function object(value: unknown, keys: string[]): Record<string, unknown> {
  check(value && typeof value === 'object' && !Array.isArray(value), 'La configuración está incompleta.');
  const result = value as Record<string, unknown>;
  check(Object.keys(result).length === keys.length && Object.keys(result).every(k => keys.includes(k)), 'La configuración contiene campos no admitidos.');
  return result;
}
function array(value: unknown, max: number): unknown[] {
  check(Array.isArray(value) && value.length <= max, 'La configuración supera el límite de opciones.'); return value;
}
function unique(values: unknown[], message: string) { check(new Set(values).size === values.length, message); }
function reference(value: unknown, extraKeys: string[]) {
  const ref = object(value, ['entryId', 'variantKey', ...extraKeys]);
  check(isMenuId(ref.entryId) && keyValid(ref.variantKey), 'Selecciona una presentación válida para vincular.'); return ref;
}

export function parseMenuDocument(value: unknown): MenuDocument {
  const keys = ['schemaVersion', 'kind', 'name', 'archived', 'variants', 'comboGroups', 'friesUpgrades'];
  const doc = object(value, value && typeof value === 'object' && 'comboIncentiveUsd' in value ? [...keys, 'comboIncentiveUsd'] : keys);
  check(doc.schemaVersion === 1 && isMenuKind(doc.kind), 'Selecciona un tipo de producto válido.');
  if ('comboIncentiveUsd' in doc) check(doc.kind === 'combo' && (doc.comboIncentiveUsd === null || priceValid(doc.comboIncentiveUsd)),
    'Solo los combos admiten un estímulo fijo en USD, con hasta dos decimales; cero significa sin estímulo.');
  check(textValid(doc.name, 120) && typeof doc.archived === 'boolean', 'Escribe un nombre de producto de hasta 120 caracteres.');
  const variants = array(doc.variants, 20);
  check(variants.length > 0, 'Añade al menos una presentación.');
  const variantKeys: string[] = [];
  for (const raw of variants) {
    const variant = object(raw, ['key', 'label', 'priceUsd', 'burger']);
    check(keyValid(variant.key) && textValid(variant.label), 'Cada presentación necesita un nombre.');
    check(variant.priceUsd === null || priceValid(variant.priceUsd), 'Revisa los precios en USD; se admiten hasta dos decimales o precio pendiente.');
    variantKeys.push(variant.key);
    if (doc.kind !== 'burger') { check(variant.burger === null, 'Solo las hamburguesas llevan esa configuración.'); continue; }
    const burger = object(variant.burger, ['pattyCount', 'ingredients', 'extras', 'includedFries']);
    check(burger.pattyCount === 1 || burger.pattyCount === 2, 'Selecciona hamburguesa simple o doble.');
    const ingredients = array(burger.ingredients, 40).map(rawIngredient => {
      const ingredient = object(rawIngredient, ['key', 'label', 'removable']);
      check(keyValid(ingredient.key) && textValid(ingredient.label, 80) && typeof ingredient.removable === 'boolean', 'Revisa los ingredientes y cuáles se pueden retirar.');
      return ingredient.key;
    });
    unique(ingredients, 'Hay un ingrediente duplicado en la presentación.');
    const extras = array(burger.extras, 40).map(rawExtra => {
      const extra = reference(rawExtra, ['maxQty']);
      check(integer(extra.maxQty, 20), 'La cantidad máxima de un extra debe estar entre 1 y 20.');
      return `${extra.entryId}:${extra.variantKey}`;
    });
    unique(extras, 'Hay un extra duplicado en la presentación.');
    if (burger.includedFries !== null) {
      const fries = reference(burger.includedFries, ['quantity']);
      check(integer(fries.quantity, 20), 'Revisa las porciones de papas incluidas.');
    }
  }
  unique(variantKeys, 'Hay presentaciones duplicadas.');
  const groups = array(doc.comboGroups, 12);
  check(doc.kind === 'combo' || groups.length === 0, 'Solo un combo puede llevar grupos de productos.');
  let slots = 0;
  const groupKeys = groups.map(rawGroup => {
    const group = object(rawGroup, ['key', 'label', 'kind', 'quantity', 'choices']);
    check(keyValid(group.key) && textValid(group.label) && ['burger', 'fries', 'drink'].includes(String(group.kind)), 'Revisa el nombre y tipo del grupo del combo.');
    check(integer(group.quantity, 50), 'La cantidad de un grupo debe estar entre 1 y 50.');
    slots += group.quantity;
    const choices = array(group.choices, 50).map(rawChoice => {
      const choice = reference(rawChoice, ['supplementUsd']);
      check(priceValid(choice.supplementUsd), 'Revisa el suplemento en USD de cada opción del combo.');
      return `${choice.entryId}:${choice.variantKey}`;
    });
    unique(choices, 'Hay una opción repetida dentro del grupo del combo.');
    return group.key;
  });
  check(slots <= 100, 'Un combo admite hasta 100 unidades configurables.');
  unique(groupKeys, 'Hay grupos duplicados en el combo.');
  const upgrades = array(doc.friesUpgrades, 50);
  check(doc.kind === 'fries' || upgrades.length === 0, 'Solo las papas llevan ampliaciones de tamaño.');
  unique(upgrades.map(rawUpgrade => {
    const upgrade = object(rawUpgrade, ['fromKey', 'toKey', 'supplementUsd']);
    check(upgrade.fromKey !== upgrade.toKey && variantKeys.includes(String(upgrade.fromKey))
      && variantKeys.includes(String(upgrade.toKey)) && priceValid(upgrade.supplementUsd), 'Revisa el origen, destino y suplemento de la ampliación de papas.');
    return `${upgrade.fromKey}:${upgrade.toKey}`;
  }), 'Hay una ampliación de papas duplicada.');
  const refs = menuReferences(doc as unknown as MenuDocument);
  check(new Set(refs.map(ref => ref.entryId)).size <= 100, 'Un producto admite hasta 100 productos vinculados.');
  check(JSON.stringify(doc).length <= 60000, 'La configuración es demasiado extensa.');
  return doc as unknown as MenuDocument;
}

export function newMenuDocument(kind: MenuKind): MenuDocument {
  return {
    schemaVersion: 1, kind, name: '', archived: false,
    variants: [{ key: 'standard', label: kind === 'burger' ? 'Simple' : 'Normal', priceUsd: null,
      burger: kind === 'burger' ? { pattyCount: 1, ingredients: [], extras: [], includedFries: null } : null }],
    comboGroups: [], friesUpgrades: [],
  };
}

export function menuPendingIssues(doc: MenuDocument): string[] {
  const issues: string[] = [];
  if (doc.variants.some(v => v.priceUsd === null)) issues.push('Completar precios en USD');
  if (doc.kind === 'burger' && doc.variants.some(v => !v.burger?.ingredients.length)) issues.push('Definir ingredientes incluidos');
  if (doc.kind === 'combo' && !doc.comboGroups.some(g => g.kind === 'burger')) issues.push('Definir hamburguesas del combo');
  if (doc.comboGroups.some(g => !g.choices.length)) issues.push('Elegir las opciones de cada grupo');
  return issues;
}

export function menuReferences(doc: MenuDocument): (MenuReference & { kind: MenuKind })[] {
  return [
    ...doc.variants.flatMap(v => v.burger ? [
      ...v.burger.extras.map(e => ({ entryId: e.entryId, variantKey: e.variantKey, kind: 'extra' as const })),
      ...(v.burger.includedFries ? [{ ...v.burger.includedFries, kind: 'fries' as const }] : []),
    ] : []),
    ...doc.comboGroups.flatMap(g => g.choices.map(c => ({ entryId: c.entryId, variantKey: c.variantKey, kind: g.kind }))),
  ];
}

export function assertMenuReferences(doc: MenuDocument, lookups: MenuLookup[]): void {
  const map = new Map(lookups.map(e => [e.entryId, e]));
  for (const ref of menuReferences(doc)) {
    const item = map.get(ref.entryId);
    check(item && !item.archived && item.kind === ref.kind && item.variants.some(v => v.key === ref.variantKey), 'Una opción vinculada no está disponible. Revisa sus presentaciones.');
  }
  if (doc.comboGroups.some(g => g.kind === 'fries' && g.choices.length > 0)) {
    check(!doc.comboGroups.filter(g => g.kind === 'burger').some(g => g.choices.some(c =>
      map.get(c.entryId)?.variants.find(v => v.key === c.variantKey)?.hasFries)),
    'Las hamburguesas seleccionadas ya incluyen papas. Usa hamburguesas solas o retira el grupo adicional de papas.');
  }
}

export function menuMoneyText(value: number | null): string { return value === null ? '' : value.toFixed(2).replace('.', ','); }
export function parseMenuMoney(text: string, allowPending = false): number | null {
  if (text.trim() === '' && allowPending) return null;
  check(/^\d{1,9}(?:[.,]\d{1,2})?$/.test(text.trim()), 'Introduce el monto en USD con hasta dos decimales.');
  const amount = Number(text.trim().replace(',', '.'));
  check(priceValid(amount), 'Introduce un monto válido en USD.'); return amount;
}

export function decodeMenuEditor(value: unknown): MenuEditorData {
  check(value && typeof value === 'object', 'No se pudo leer el catálogo.');
  const data = value as Record<string, unknown>;
  check(data.version === 'muerdeme-menu-v1' && Array.isArray(data.lookups) && data.lookups.length <= 200
    && typeof data.lookupHasMore === 'boolean', 'La consulta del catálogo está incompleta.');
  let entry: MenuEntry | null = null;
  if (data.entry !== null) {
    const raw = object(data.entry, ['entryId', 'revision', 'document', 'updatedAt']);
    check(isMenuId(raw.entryId) && integer(raw.revision, 2147483647)
      && typeof raw.updatedAt === 'string' && Number.isFinite(Date.parse(raw.updatedAt)), 'El producto no se pudo leer.');
    entry = { entryId: raw.entryId, revision: raw.revision, document: parseMenuDocument(raw.document), updatedAt: raw.updatedAt };
  }
  const lookups = data.lookups.map(raw => {
    const row = object(raw, ['entryId', 'kind', 'name', 'archived', 'variants']);
    check(isMenuId(row.entryId) && isMenuKind(row.kind) && textValid(row.name, 120) && typeof row.archived === 'boolean', 'Hay una opción vinculada incompleta.');
    const variants = array(row.variants, 20).map(rawVariant => {
      const v = object(rawVariant, ['key', 'label', 'priceUsd', 'hasFries']);
      check(keyValid(v.key) && textValid(v.label) && (v.priceUsd === null || priceValid(v.priceUsd)) && typeof v.hasFries === 'boolean', 'Hay una presentación vinculada incompleta.');
      return { key: v.key, label: v.label, priceUsd: v.priceUsd as number | null, hasFries: v.hasFries };
    });
    return { entryId: row.entryId, kind: row.kind, name: row.name, archived: row.archived, variants };
  });
  return { entry, lookups, lookupHasMore: data.lookupHasMore };
}
