export type PurchasedProductMode = 'any' | 'all';
export type PurchasedProductScope = 'any_purchase' | 'latest_delivery';
export type PurchasedProductInput = {
  purchasedProductIds?: number[];
  purchasedProductMode?: PurchasedProductMode;
  purchasedProductScope?: PurchasedProductScope;
};

export function purchasedProductRules(input: PurchasedProductInput) {
  const values = input.purchasedProductIds ?? [];
  if (!Array.isArray(values) || values.length > 50 || values.some(id => !Number.isSafeInteger(id) || id <= 0)) {
    throw new Error('Selecciona hasta 50 productos válidos para filtrar el historial.');
  }
  const mode = input.purchasedProductMode ?? 'any';
  if (mode !== 'any' && mode !== 'all') throw new Error('Selecciona cualquiera o todos los productos.');
  const scope = input.purchasedProductScope ?? 'any_purchase';
  if (scope !== 'any_purchase' && scope !== 'latest_delivery') throw new Error('Selecciona dónde buscar los productos: historial o último delivery.');
  return { purchased_product_ids: [...new Set(values)], purchased_product_mode: mode, purchased_product_scope: scope };
}
