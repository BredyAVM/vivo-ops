export type OrderMoneySource = {
  total_usd?: number | string | null;
  total_bs_snapshot?: number | string | null;
  extra_fields?: {
    pricing?: {
      fx_rate?: number | string | null;
      subtotal_usd?: number | string | null;
      subtotal_bs?: number | string | null;
      discount_enabled?: boolean | null;
      discount_pct?: number | string | null;
      discount_amount_usd?: number | string | null;
      discount_amount_bs?: number | string | null;
      subtotal_after_discount_usd?: number | string | null;
      subtotal_after_discount_bs?: number | string | null;
      invoice_tax_pct?: number | string | null;
      invoice_tax_amount_usd?: number | string | null;
      invoice_tax_amount_bs?: number | string | null;
      total_usd?: number | string | null;
      total_bs?: number | string | null;
    } | null;
  } | null;
};

export type OrderLineMoneySource = {
  qty?: number | string | null;
  unit_price_usd_snapshot?: number | string | null;
  line_total_usd?: number | string | null;
  unit_price_bs_snapshot?: number | string | null;
  line_total_bs_snapshot?: number | string | null;
};

export type OrderMoneySnapshot = {
  fxRate: number;
  subtotalUsd: number;
  subtotalBs: number;
  discountEnabled: boolean;
  discountPct: number;
  discountAmountUsd: number;
  discountAmountBs: number;
  subtotalAfterDiscountUsd: number;
  subtotalAfterDiscountBs: number;
  hasInvoice: boolean;
  invoiceTaxPct: number;
  invoiceTaxAmountUsd: number;
  invoiceTaxAmountBs: number;
  totalUsd: number;
  totalBs: number;
};

export function toOrderMoneyNumber(value: unknown, fallback = 0) {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : fallback;
}

export function roundOrderMoney(value: unknown) {
  return Number(toOrderMoneyNumber(value, 0).toFixed(2));
}

export function getOrderMoneySnapshot(order: OrderMoneySource): OrderMoneySnapshot {
  const pricing = order.extra_fields?.pricing ?? {};
  const totalUsd = roundOrderMoney(
    toOrderMoneyNumber(pricing.total_usd, toOrderMoneyNumber(order.total_usd, 0))
  );
  const totalBs = roundOrderMoney(
    toOrderMoneyNumber(pricing.total_bs, toOrderMoneyNumber(order.total_bs_snapshot, 0))
  );
  const fxRate = toOrderMoneyNumber(
    pricing.fx_rate,
    totalUsd > 0 && totalBs > 0 ? totalBs / totalUsd : 0
  );

  const invoiceTaxAmountUsd = roundOrderMoney(pricing.invoice_tax_amount_usd);
  const invoiceTaxAmountBs = roundOrderMoney(pricing.invoice_tax_amount_bs);
  const invoiceTaxPct = toOrderMoneyNumber(pricing.invoice_tax_pct, 0);
  const discountAmountUsd = roundOrderMoney(pricing.discount_amount_usd);
  const discountAmountBs = roundOrderMoney(pricing.discount_amount_bs);
  const discountPct = toOrderMoneyNumber(pricing.discount_pct, 0);
  const subtotalAfterDiscountUsd = roundOrderMoney(
    toOrderMoneyNumber(
      pricing.subtotal_after_discount_usd,
      Math.max(0, totalUsd - invoiceTaxAmountUsd)
    )
  );
  const subtotalAfterDiscountBs = roundOrderMoney(
    toOrderMoneyNumber(
      pricing.subtotal_after_discount_bs,
      Math.max(0, totalBs - invoiceTaxAmountBs)
    )
  );
  const subtotalUsd = roundOrderMoney(
    toOrderMoneyNumber(pricing.subtotal_usd, subtotalAfterDiscountUsd + discountAmountUsd)
  );
  const subtotalBs = roundOrderMoney(
    toOrderMoneyNumber(pricing.subtotal_bs, subtotalAfterDiscountBs + discountAmountBs)
  );

  return {
    fxRate,
    subtotalUsd,
    subtotalBs,
    discountEnabled: Boolean(pricing.discount_enabled) || discountAmountUsd > 0 || discountAmountBs > 0,
    discountPct,
    discountAmountUsd,
    discountAmountBs,
    subtotalAfterDiscountUsd,
    subtotalAfterDiscountBs,
    hasInvoice: invoiceTaxPct > 0 && (invoiceTaxAmountUsd > 0 || invoiceTaxAmountBs > 0),
    invoiceTaxPct,
    invoiceTaxAmountUsd,
    invoiceTaxAmountBs,
    totalUsd,
    totalBs,
  };
}

export function getOrderLineTotalUsd(item: OrderLineMoneySource) {
  const qty = toOrderMoneyNumber(item.qty, 0);
  return roundOrderMoney(
    toOrderMoneyNumber(
      item.line_total_usd,
      toOrderMoneyNumber(item.unit_price_usd_snapshot, 0) * qty
    )
  );
}

export function getOrderLineTotalBs(item: OrderLineMoneySource, fxRate = 0) {
  const qty = toOrderMoneyNumber(item.qty, 0);
  const storedLineBs = toOrderMoneyNumber(item.line_total_bs_snapshot, Number.NaN);
  if (Number.isFinite(storedLineBs)) return roundOrderMoney(storedLineBs);

  const unitBs = toOrderMoneyNumber(item.unit_price_bs_snapshot, Number.NaN);
  if (Number.isFinite(unitBs)) return roundOrderMoney(unitBs * qty);

  return fxRate > 0 ? roundOrderMoney(getOrderLineTotalUsd(item) * fxRate) : 0;
}
