import { isMenuId, type MenuDocument, type MenuVariant } from './menu-model';

export type MenuChanges = {
  labels: string[];
  prices: Array<{ key: string; label: string; before: number | null; after: number | null; added: boolean; removed: boolean }>;
  recipeReview: string[];
};
export type MenuHistory = { entryId: string; name: string; page: number; hasNext: boolean; rows: Array<{
  revision: number; name: string; actor: string; note: string | null; createdAt: string; changes: MenuChanges;
}> };
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)])) : value;
const same = (a: unknown, b: unknown) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const signature = (kind: string, variant: MenuVariant) => ({ kind, key: variant.key,
  pattyCount: variant.burger?.pattyCount ?? null,
  ingredients: (variant.burger?.ingredients ?? []).map(({ key, label }) => ({ key, label }))
    .sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
});

/** Local preview only. The database independently calculates persisted history. */
export function menuChanges(before: MenuDocument | null, after: MenuDocument): MenuChanges {
  const keys = [...new Set([...(before?.variants.map(v => v.key) ?? []), ...after.variants.map(v => v.key)])].sort();
  const variants = keys.map(key => ({ key, a: before?.variants.find(v => v.key === key), b: after.variants.find(v => v.key === key) }));
  const labels: string[] = [];
  if (!before) labels.push('Carga inicial');
  if (before && before.name !== after.name) labels.push('Nombre');
  if (before && before.archived !== after.archived) labels.push('Estado');
  if (variants.some(({ a, b }) => !a || !b || a.label !== b.label)) labels.push('Presentaciones');
  if (variants.some(({ a, b }) => a?.priceUsd !== b?.priceUsd)) labels.push('Precios USD');
  if (variants.some(({ a, b }) => !same(a?.burger, b?.burger))) labels.push('Configuración de hamburguesas');
  if (!same(before?.comboGroups ?? [], after.comboGroups)) labels.push('Composición y suplementos del combo');
  if (!same(before?.friesUpgrades ?? [], after.friesUpgrades)) labels.push('Ampliaciones de papas');
  if ((before?.comboIncentiveUsd ?? null) !== (after.comboIncentiveUsd ?? null)) labels.push('Estímulo fijo USD');
  return { labels,
    prices: variants.filter(({ a, b }) => !a || !b || a.priceUsd !== b.priceUsd).map(({ key, a, b }) => ({
      key, label: b?.label ?? a!.label, before: a?.priceUsd ?? null, after: b?.priceUsd ?? null, added: !a, removed: !b,
    })),
    recipeReview: variants.filter(({ a, b }) => b && after.kind !== 'combo' && (!a || !same(signature(after.kind, a), signature(after.kind, b))))
      .map(({ b }) => b!.label),
  };
}

export function decodeMenuHistory(value: unknown): MenuHistory {
  const fail = () => { throw new Error('El historial del producto está incompleto.'); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const data = value as MenuHistory;
  const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;
  const money = (v: unknown) => v === null || typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 1e9 && Number(v.toFixed(2)) === v;
  if (!isMenuId(data.entryId) || !text(data.name, 120) || !Number.isSafeInteger(data.page) || data.page < 1 || data.page > 10000
    || typeof data.hasNext !== 'boolean' || !Array.isArray(data.rows) || data.rows.length > 25) return fail();
  let previous = Infinity;
  for (const row of data.rows) {
    if (!row || !Number.isSafeInteger(row.revision) || row.revision < 1 || row.revision >= previous || !text(row.name, 120)
      || !text(row.actor, 200) || !(row.note === null || text(row.note, 300)) || !text(row.createdAt, 80) || !Number.isFinite(Date.parse(row.createdAt))) return fail();
    previous = row.revision;
    const changes = row.changes;
    if (!changes || !Array.isArray(changes.labels) || changes.labels.length > 10 || changes.labels.some(s => !text(s, 100))
      || !Array.isArray(changes.recipeReview) || changes.recipeReview.length > 20 || changes.recipeReview.some(s => !text(s, 100))
      || !Array.isArray(changes.prices) || changes.prices.length > 40) return fail();
    for (const price of changes.prices) if (!price || !text(price.key, 64) || !text(price.label, 100) || !money(price.before) || !money(price.after)
      || typeof price.added !== 'boolean' || typeof price.removed !== 'boolean' || price.added && price.removed) return fail();
  }
  return data;
}
