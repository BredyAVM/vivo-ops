import type { ApprovedPriceLine } from './approved-price-preservation';
import { preservedApprovedPriceSnapshot } from './approved-price-preservation.ts';

/**
 * Opening an editor is not a new quotation. All roles retain the certified
 * snapshots of an unchanged line, including Admin. Never infer Bs from rounded
 * USD, and never treat a copied/new line as evidence of an old agreement.
 * Quantity increases and explicit repricing are separate commercial decisions.
 */
export function preservedUnchangedPriceSnapshot(next: ApprovedPriceLine, previous?: ApprovedPriceLine) {
  if (!previous || next.qty !== previous.qty) return null;
  if (previous.adminPriceOverrideUsd != null) return preservedApprovedPriceSnapshot(next, previous);
  if (next.crmPlayMemberId || previous.crmPlayMemberId ||
    next.crmPlayBenefitId || previous.crmPlayBenefitId ||
    next.crmPlayBenefitUpgradeId || previous.crmPlayBenefitUpgradeId) return null;
  return preservedOperationalSnapshot(next, previous);
}

/** Operational quantities do not renegotiate the prices of retained products. */
export function preservedOperationalSnapshot(next: ApprovedPriceLine, previous?: ApprovedPriceLine) {
  if (!previous || !previous.orderItemId || next.orderItemId !== previous.orderItemId ||
    next.productId !== previous.productId || next.sourcePriceCurrency !== previous.sourcePriceCurrency ||
    next.sourcePriceAmount !== previous.sourcePriceAmount || next.adminPriceOverrideUsd != null ||
    previous.adminPriceOverrideUsd != null || next.crmPlayMemberId || previous.crmPlayMemberId ||
    !Number.isFinite(next.qty) || next.qty <= 0 || previous.qty <= 0) return null;
  const values = [previous.unitPriceUsdSnapshot, previous.unitPriceBsSnapshot, previous.lineTotalUsd, previous.lineTotalBsSnapshot];
  if (values.some(value => value == null || !Number.isFinite(value) || value < 0)) return null;
  return {
    unitUsd: previous.unitPriceUsdSnapshot,
    unitBs: previous.unitPriceBsSnapshot!,
    lineUsd: next.qty === previous.qty ? previous.lineTotalUsd : Math.round(previous.unitPriceUsdSnapshot * next.qty * 100) / 100,
    lineBs: next.qty === previous.qty ? previous.lineTotalBsSnapshot! : Math.round(previous.unitPriceBsSnapshot! * next.qty * 100) / 100,
  };
}

export function requiresProtectedPriceAuthorization(input: {
  isAdmin: boolean; isPriceProtected: boolean; commercialTermsChanged: boolean;
}) {
  return !input.isAdmin && input.isPriceProtected && input.commercialTermsChanged;
}
