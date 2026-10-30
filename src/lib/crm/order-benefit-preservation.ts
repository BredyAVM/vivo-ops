import type { AdvisorCrmOrderContext } from './advisor-order-context-types';

export type DraftCrmBenefit = {
  playMemberId: number;
  playBenefitId: number;
  playBenefitUpgradeId: number | null;
  eligibleUnitPriceUsd: number;
  catalogSourceCurrency: 'USD' | 'VES';
  catalogSourceAmount: number;
  redemptionStatus?: 'reserved' | 'redeemed' | null;
};

const invalidBenefit = () => new Error('No se pudo recuperar el vínculo de la jugada. Revisa el obsequio antes de guardar; no se convertirá automáticamente en una venta.');
const positiveId = (value: unknown) => Number.isSafeInteger(value) && Number(value) > 0;

/** A restored reference is not authority to give a gift: the server still validates it. */
export function readDraftCrmBenefit(value: unknown): DraftCrmBenefit | undefined {
  if (value == null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) throw invalidBenefit();
  const row = value as Record<string, unknown>;
  if (!positiveId(row.playMemberId) || !positiveId(row.playBenefitId)
    || (row.playBenefitUpgradeId != null && !positiveId(row.playBenefitUpgradeId))
    || typeof row.eligibleUnitPriceUsd !== 'number' || !Number.isFinite(row.eligibleUnitPriceUsd) || row.eligibleUnitPriceUsd < 0
    || !['USD', 'VES'].includes(String(row.catalogSourceCurrency))
    || typeof row.catalogSourceAmount !== 'number' || !Number.isFinite(row.catalogSourceAmount) || row.catalogSourceAmount < 0) {
    throw invalidBenefit();
  }
  return {
    playMemberId: Number(row.playMemberId), playBenefitId: Number(row.playBenefitId),
    playBenefitUpgradeId: row.playBenefitUpgradeId == null ? null : Number(row.playBenefitUpgradeId),
    eligibleUnitPriceUsd: row.eligibleUnitPriceUsd,
    catalogSourceCurrency: row.catalogSourceCurrency as 'USD' | 'VES', catalogSourceAmount: row.catalogSourceAmount,
    // A saved draft cannot claim a reservation/delivery that belongs to an order.
  };
}

export function savedDraftCrmMemberId(items: unknown): number | null {
  if (!Array.isArray(items)) return null;
  const ids = new Set(items.flatMap(item => {
    const benefit = readDraftCrmBenefit(item?.crm_benefit);
    return benefit ? [benefit.playMemberId] : [];
  }));
  if (ids.size > 1) throw invalidBenefit();
  return ids.values().next().value ?? null;
}

/** Resolve the exact saved gift/upgrade against current, authorized membership. */
export function restoreDraftCrmItems<T extends { product_id: number; qty: number; crm_benefit?: DraftCrmBenefit }>(
  items: T[], context: AdvisorCrmOrderContext | null,
): T[] {
  return items.map(item => {
    const saved = item.crm_benefit;
    if (!saved) return item;
    if (!context || saved.playMemberId !== context.playMemberId) throw invalidBenefit();
    const benefit = context.benefits.find(b => b.playBenefitId === saved.playBenefitId);
    const upgrade = saved.playBenefitUpgradeId == null ? null
      : benefit?.upgrades.find(u => u.id === saved.playBenefitUpgradeId);
    if (!benefit || (saved.playBenefitUpgradeId != null && !upgrade)
      || item.product_id !== (upgrade?.productId ?? benefit.productId)
      || Math.abs(item.qty - (upgrade?.quantity ?? benefit.quantity)) > 0.000001) throw invalidBenefit();
    return { ...item, crm_benefit: { ...saved,
      eligibleUnitPriceUsd: (upgrade?.customerDifferenceUsd ?? 0) / item.qty } };
  });
}
