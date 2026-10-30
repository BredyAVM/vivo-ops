export type BenefitRecurrenceMode = 'once' | 'daily';
export type BenefitFulfillment = 'any' | 'pickup' | 'delivery_zone_1';

export function isDeliveryProduct(name: string | null | undefined, sku?: string | null) {
  return /delivery/i.test(name ?? '') || /(?:^|_)DEL(?:IV)?(?:_|$)/i.test(sku ?? '');
}

export function countsTowardCrmMinimum(input: {
  productName?: string | null;
  sku?: string | null;
  isCrmBenefit?: boolean;
  lineUsd: number;
}) {
  return !input.isCrmBenefit && input.lineUsd > 0 && !isDeliveryProduct(input.productName, input.sku);
}

export function dailyBenefitConflict(
  uses: Array<{ day: string; orderId: number }>, day: string, editingOrderId?: number | null,
) {
  return uses.find((use) => use.day === day && use.orderId !== editingOrderId) ?? null;
}
