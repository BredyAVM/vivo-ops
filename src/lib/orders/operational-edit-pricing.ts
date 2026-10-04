import type { ApprovedPriceLine } from './approved-price-preservation';

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
