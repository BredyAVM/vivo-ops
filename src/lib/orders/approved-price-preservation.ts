/** Existing approval is evidence, not permission to grant a new special price. */
export const APPROVED_PRICE_CHANGE_MESSAGE =
  'Solo Administración puede cambiar un precio especial o trasladarlo a otro producto. Puedes retirar productos o cambiar cantidades conservando sus precios autorizados.';

type Numeric = number | string | null;
export type ApprovedPriceLine = {
  orderItemId?: number | null;
  productId: number;
  qty: number;
  sourcePriceCurrency: string;
  sourcePriceAmount: number;
  adminPriceOverrideUsd: number | null;
  adminPriceOverrideReason: string | null;
  editableDetailLines: string[];
  crmPlayMemberId?: number | null;
  crmPlayBenefitId?: number | null;
  crmPlayBenefitUpgradeId?: number | null;
  unitPriceUsdSnapshot: number;
  lineTotalUsd: number;
  unitPriceBsSnapshot?: number | null;
  lineTotalBsSnapshot?: number | null;
  pricingFxRateSnapshot?: number | null;
};

export type StoredApprovedPriceLine = {
  id: Numeric;
  product_id: Numeric;
  qty: Numeric;
  pricing_origin_currency: string | null;
  pricing_origin_amount: Numeric;
  admin_price_override_usd: Numeric;
  admin_price_override_reason: string | null;
  notes: string | null;
  crm_play_member_id?: Numeric;
  crm_play_benefit_id?: Numeric;
  crm_play_benefit_upgrade_id?: Numeric;
  unit_price_usd_snapshot: Numeric;
  line_total_usd: Numeric;
  unit_price_bs_snapshot: Numeric;
  line_total_bs_snapshot: Numeric;
  pricing_fx_rate_snapshot?: Numeric;
};

export function storedApprovedPriceLine(row: StoredApprovedPriceLine): ApprovedPriceLine {
  return {
    orderItemId: Number(row.id), productId: Number(row.product_id), qty: Number(row.qty),
    sourcePriceCurrency: row.pricing_origin_currency ?? '', sourcePriceAmount: Number(row.pricing_origin_amount),
    adminPriceOverrideUsd: row.admin_price_override_usd == null ? null : Number(row.admin_price_override_usd),
    adminPriceOverrideReason: row.admin_price_override_reason,
    editableDetailLines: (row.notes ?? '').split('\n'),
    crmPlayMemberId: row.crm_play_member_id == null ? null : Number(row.crm_play_member_id),
    crmPlayBenefitId: row.crm_play_benefit_id == null ? null : Number(row.crm_play_benefit_id),
    crmPlayBenefitUpgradeId: row.crm_play_benefit_upgrade_id == null ? null : Number(row.crm_play_benefit_upgrade_id),
    unitPriceUsdSnapshot: row.unit_price_usd_snapshot == null ? Number.NaN : Number(row.unit_price_usd_snapshot),
    lineTotalUsd: row.line_total_usd == null ? Number.NaN : Number(row.line_total_usd),
    unitPriceBsSnapshot: row.unit_price_bs_snapshot == null ? null : Number(row.unit_price_bs_snapshot),
    lineTotalBsSnapshot: row.line_total_bs_snapshot == null ? null : Number(row.line_total_bs_snapshot),
    pricingFxRateSnapshot: row.pricing_fx_rate_snapshot == null ? null : Number(row.pricing_fx_rate_snapshot),
  };
}

function detailSignature(lines: string[]) {
  return JSON.stringify(lines.map((line) => line.trim()).filter(Boolean).sort());
}

export function hasUnauthorizedPriceChange(next: ApprovedPriceLine[], previous: ApprovedPriceLine[], operational = false) {
  const byId = new Map(previous.map((item) => [item.orderItemId, item]));
  return next.some((item) => item.adminPriceOverrideUsd != null &&
    !preservedApprovedPriceSnapshot(item, byId.get(item.orderItemId), operational)) ||
    previous.some((item) => item.adminPriceOverrideUsd != null &&
      !(operational && !item.crmPlayMemberId && !next.some(candidate => candidate.orderItemId === item.orderItemId)) &&
      !next.some((candidate) => preservedApprovedPriceSnapshot(candidate, item, operational)));
}

/** Compare approved terms by persisted identity; never trust browser approval metadata or totals. */
export function preservedApprovedPriceSnapshot(next: ApprovedPriceLine, previous?: ApprovedPriceLine, operational = false) {
  if (!previous || previous.adminPriceOverrideUsd == null || !previous.orderItemId ||
    next.orderItemId !== previous.orderItemId || next.productId !== previous.productId ||
    (next.qty !== previous.qty && (!operational || previous.crmPlayMemberId)) || next.sourcePriceCurrency !== previous.sourcePriceCurrency ||
    next.sourcePriceAmount !== previous.sourcePriceAmount ||
    next.adminPriceOverrideUsd !== previous.adminPriceOverrideUsd ||
    (next.adminPriceOverrideReason ?? '').trim() !== (previous.adminPriceOverrideReason ?? '').trim() ||
    (next.crmPlayMemberId ?? null) !== (previous.crmPlayMemberId ?? null) ||
    (next.crmPlayBenefitId ?? null) !== (previous.crmPlayBenefitId ?? null) ||
    (next.crmPlayBenefitUpgradeId ?? null) !== (previous.crmPlayBenefitUpgradeId ?? null) ||
    detailSignature(next.editableDetailLines) !== detailSignature(previous.editableDetailLines)) return null;
  const values = [previous.unitPriceUsdSnapshot, previous.lineTotalUsd, previous.unitPriceBsSnapshot, previous.lineTotalBsSnapshot];
  if (values.some((value) => value == null || !Number.isFinite(value) || value < 0)) return null;
  if (!Number.isFinite(next.qty) || next.qty <= 0 || previous.qty <= 0) return null;
  return {
    unitUsd: previous.unitPriceUsdSnapshot,
    lineUsd: next.qty === previous.qty ? previous.lineTotalUsd : Math.round(previous.lineTotalUsd / previous.qty * next.qty * 100) / 100,
    unitBs: previous.unitPriceBsSnapshot!,
    lineBs: next.qty === previous.qty ? previous.lineTotalBsSnapshot! : Math.round(previous.unitPriceBsSnapshot! * next.qty * 100) / 100,
  };
}
