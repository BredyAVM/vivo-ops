/** User-approved price proposal, 2026-10-09. This module never activates prices or writes orders. */
export type CatalogTransitionPrice = { previousCurrency: 'USD' | 'VES'; previousAmount: number; nextUsd: number };
export const USD_CATALOG_PRICE_PROPOSAL: Readonly<Record<string, CatalogTransitionPrice>> = Object.freeze({
  'MM_2OZ': { previousCurrency: 'VES', previousAmount: 1150, nextUsd: 1.5 },
  'MM_5OZ': { previousCurrency: 'VES', previousAmount: 2300, nextUsd: 3 },
  'BOMB_C_25': { previousCurrency: 'VES', previousAmount: 11500, nextUsd: 14 },
  'BOMB_F_25': { previousCurrency: 'VES', previousAmount: 11500, nextUsd: 14 },
  'BOMB_PF_25': { previousCurrency: 'VES', previousAmount: 11500, nextUsd: 14 },
  'CACH_C_20': { previousCurrency: 'VES', previousAmount: 11500, nextUsd: 14 },
  'CACH_F_20': { previousCurrency: 'VES', previousAmount: 11500, nextUsd: 14 },
  'CACH_PF_20': { previousCurrency: 'VES', previousAmount: 11500, nextUsd: 14 },
  'CHIN_1500': { previousCurrency: 'VES', previousAmount: 2300, nextUsd: 2.5 },
  'CHIN_2000': { previousCurrency: 'VES', previousAmount: 2875, nextUsd: 3.5 },
  'COKE_1000': { previousCurrency: 'VES', previousAmount: 1725, nextUsd: 2 },
  'COKE_1500': { previousCurrency: 'VES', previousAmount: 2300, nextUsd: 2.5 },
  'COKE_1500MAYOR': { previousCurrency: 'USD', previousAmount: 6.72, nextUsd: 6.72 },
  'COKE_2000': { previousCurrency: 'VES', previousAmount: 2875, nextUsd: 3.5 },
  'COKE_LAT': { previousCurrency: 'VES', previousAmount: 1150, nextUsd: 1.5 },
  'COKE_ZERO_1000': { previousCurrency: 'VES', previousAmount: 1725, nextUsd: 2 },
  'COKE_ZERO_2000': { previousCurrency: 'VES', previousAmount: 2300, nextUsd: 2.5 },
  'BABYMIX_F_25': { previousCurrency: 'VES', previousAmount: 12650, nextUsd: 15 },
  'BABYMIX_F_25A': { previousCurrency: 'VES', previousAmount: 12650, nextUsd: 15 },
  'RUMBAMIX_F_76': { previousCurrency: 'VES', previousAmount: 34500, nextUsd: 40 },
  'RUMBAMIX_F_76A': { previousCurrency: 'VES', previousAmount: 34500, nextUsd: 40 },
  'SEXYMIX_F_50': { previousCurrency: 'VES', previousAmount: 23000, nextUsd: 28 },
  'SEXYMIX_F_50A': { previousCurrency: 'VES', previousAmount: 23000, nextUsd: 28 },
  'DEL_Z1': { previousCurrency: 'VES', previousAmount: 2300, nextUsd: 2.5 },
  'DEL_Z2': { previousCurrency: 'VES', previousAmount: 3450, nextUsd: 4 },
  'DEL_Z3': { previousCurrency: 'VES', previousAmount: 4600, nextUsd: 5 },
  'DEL_Z4': { previousCurrency: 'VES', previousAmount: 5750, nextUsd: 6.5 },
  'DEL_Z5': { previousCurrency: 'VES', previousAmount: 6900, nextUsd: 8 },
  'DEL_Z6': { previousCurrency: 'VES', previousAmount: 8050, nextUsd: 9.5 },
  'DEL_Z7': { previousCurrency: 'VES', previousAmount: 9200, nextUsd: 10.5 },
  'DONDY_1': { previousCurrency: 'VES', previousAmount: 1150, nextUsd: 1.5 },
  'DONDY_6': { previousCurrency: 'VES', previousAmount: 6900, nextUsd: 8 },
  'EMP_C_20': { previousCurrency: 'VES', previousAmount: 11500, nextUsd: 14 },
  'EMP_F_20': { previousCurrency: 'VES', previousAmount: 11500, nextUsd: 14 },
  'EMP_PF_20': { previousCurrency: 'VES', previousAmount: 11500, nextUsd: 14 },
  'FANTA_15LT': { previousCurrency: 'VES', previousAmount: 2300, nextUsd: 2.5 },
  'FRESC_1500': { previousCurrency: 'VES', previousAmount: 2300, nextUsd: 2.5 },
  'FRESC_2000': { previousCurrency: 'VES', previousAmount: 2875, nextUsd: 3.5 },
  'JDV_1500': { previousCurrency: 'VES', previousAmount: 2300, nextUsd: 2.5 },
  'LIP_DUR_1500': { previousCurrency: 'VES', previousAmount: 5175, nextUsd: 6 },
  'LIP_LIM_1500': { previousCurrency: 'VES', previousAmount: 5175, nextUsd: 6 },
  'MALTA_LAT': { previousCurrency: 'VES', previousAmount: 1150, nextUsd: 1.5 },
  'MAND_C_25': { previousCurrency: 'VES', previousAmount: 11500, nextUsd: 14 },
  'MAND_F_25': { previousCurrency: 'VES', previousAmount: 11500, nextUsd: 14 },
  'MAND_PF_25': { previousCurrency: 'VES', previousAmount: 11500, nextUsd: 14 },
  'MINI_TEQ_C_25': { previousCurrency: 'VES', previousAmount: 11500, nextUsd: 14 },
  'MINI_TEQ_F_25': { previousCurrency: 'VES', previousAmount: 11500, nextUsd: 14 },
  'MINI_TEQ_PF_25': { previousCurrency: 'VES', previousAmount: 11500, nextUsd: 14 },
  'MIX_BOMB_MAND_F_24': { previousCurrency: 'VES', previousAmount: 11500, nextUsd: 14 },
  'MIX_CACH_BOMB_F_22': { previousCurrency: 'VES', previousAmount: 11500, nextUsd: 14 },
  'MIX_CACH_EMP_F_20': { previousCurrency: 'VES', previousAmount: 11500, nextUsd: 14 },
  'MIX_CACH_MAND_F_22': { previousCurrency: 'VES', previousAmount: 11500, nextUsd: 14 },
  'MIX_EMP_BOMB_F_22': { previousCurrency: 'VES', previousAmount: 11500, nextUsd: 14 },
  'MIX_EMP_MAND_F_22': { previousCurrency: 'VES', previousAmount: 11500, nextUsd: 14 },
  'MIX_MTEQ_BOMB_F_24': { previousCurrency: 'VES', previousAmount: 11500, nextUsd: 14 },
  'MIX_MTEQ_CACH_F_22': { previousCurrency: 'VES', previousAmount: 11500, nextUsd: 14 },
  'MIX_MTEQ_EMP_F_22': { previousCurrency: 'VES', previousAmount: 11500, nextUsd: 14 },
  'MIX_MTEQ_MAND_F_24': { previousCurrency: 'VES', previousAmount: 11500, nextUsd: 14 },
  'PEPSI_1000': { previousCurrency: 'VES', previousAmount: 1725, nextUsd: 2 },
  'PEPSI_1500': { previousCurrency: 'VES', previousAmount: 2300, nextUsd: 2.5 },
  'PEPSI_2000': { previousCurrency: 'VES', previousAmount: 2875, nextUsd: 3.5 },
  'PEPSI_LAT': { previousCurrency: 'VES', previousAmount: 1150, nextUsd: 1.5 },
  'SAL_TAR_1OZ': { previousCurrency: 'VES', previousAmount: 575, nextUsd: 1 },
  'SAL_TAR_2OZ': { previousCurrency: 'VES', previousAmount: 1150, nextUsd: 1.5 },
  'SAL_TAR_5OZ': { previousCurrency: 'VES', previousAmount: 2300, nextUsd: 3 },
  'SAL_TAR_GALON': { previousCurrency: 'USD', previousAmount: 35, nextUsd: 35 },
  'SINGLE_10': { previousCurrency: 'VES', previousAmount: 5750, nextUsd: 6.5 },
  'SINGLE_6': { previousCurrency: 'VES', previousAmount: 3450, nextUsd: 4 },
  'SINGLE_8': { previousCurrency: 'VES', previousAmount: 4600, nextUsd: 5.5 },
  'TEQREG_C_5': { previousCurrency: 'VES', previousAmount: 4025, nextUsd: 5 },
  'TEQREG_F_5': { previousCurrency: 'VES', previousAmount: 4025, nextUsd: 5 },
  'TEQREG_PF_5': { previousCurrency: 'VES', previousAmount: 4025, nextUsd: 5 },
  'VIVOBOX_6': { previousCurrency: 'VES', previousAmount: 6900, nextUsd: 8 },
  'VIVOBOX_XL_8': { previousCurrency: 'VES', previousAmount: 8050, nextUsd: 9.5 },
  'VIVOBOX_XXL_10': { previousCurrency: 'VES', previousAmount: 9200, nextUsd: 10.5 },
  'YUK_MAN_1500': { previousCurrency: 'VES', previousAmount: 5175, nextUsd: 6 },
  'YUK_NAR_1500': { previousCurrency: 'VES', previousAmount: 5175, nextUsd: 6 },
  'YUK_PER_1500': { previousCurrency: 'VES', previousAmount: 5175, nextUsd: 6 },
  'YUKYPACK': { previousCurrency: 'VES', previousAmount: 1150, nextUsd: 1.5 },
});

export type CatalogProposalProduct = {
  sku: string | null; isActive: boolean; amount: number; currency: 'USD' | 'VES'; productType: string;
};
export type CatalogProposalResult =
  | { kind: 'proposed'; amountUsd: number }
  | { kind: 'zero'; amountUsd: 0 }
  | { kind: 'inactive' | 'recalculate_play' | 'unmapped' | 'changed_since_audit'; amountUsd: null };

/** Match explicit catalog identities and audited previous prices; never infer a new price from a name. */
export function proposedCatalogUsdPrice(product: CatalogProposalProduct): CatalogProposalResult {
  if (!Number.isFinite(product.amount) || product.amount < 0) throw new Error('Precio de origen inválido.');
  if (!product.isActive) return { kind: 'inactive', amountUsd: null };
  if (product.amount === 0) return { kind: 'zero', amountUsd: 0 };
  if (product.productType === 'gambit') return { kind: 'recalculate_play', amountUsd: null };
  const entry = product.sku && Object.hasOwn(USD_CATALOG_PRICE_PROPOSAL, product.sku)
    ? USD_CATALOG_PRICE_PROPOSAL[product.sku] : null;
  if (!entry) return { kind: 'unmapped', amountUsd: null };
  if (entry.previousCurrency !== product.currency || Math.abs(entry.previousAmount - product.amount) > 0.000001) {
    return { kind: 'changed_since_audit', amountUsd: null };
  }
  return { kind: 'proposed', amountUsd: entry.nextUsd };
}

