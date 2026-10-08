export type PurchasedProductMode = 'any' | 'all';
export type PurchasedProductInput = {
  purchasedProductIds?: number[];
  purchasedProductMode?: PurchasedProductMode;
};

export function purchasedProductRules(input: PurchasedProductInput) {
  const values = input.purchasedProductIds ?? [];
  if (!Array.isArray(values) || values.length > 50 || values.some(id => !Number.isSafeInteger(id) || id <= 0)) {
    throw new Error('Selecciona hasta 50 productos válidos para filtrar el historial.');
  }
  const mode = input.purchasedProductMode ?? 'any';
  if (mode !== 'any' && mode !== 'all') throw new Error('Selecciona cualquiera o todos los productos.');
  return { purchased_product_ids: [...new Set(values)], purchased_product_mode: mode };
}
