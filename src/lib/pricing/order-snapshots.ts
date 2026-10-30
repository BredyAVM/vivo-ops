export type PricingCurrency = 'VES' | 'USD';

export type OrderLineSnapshotInput = {
  sourceCurrency: PricingCurrency;
  sourceAmount: number;
  quantity: number;
  fxRate: number;
  overrideUnitUsd?: number | null;
  fallbackUnitUsd?: number | null;
};

export type OrderLineSnapshot = {
  unitUsd: number;
  lineUsd: number;
  unitBs: number;
  lineBs: number;
};

export type OrderTotalsSnapshotInput = {
  subtotalUsd: number;
  subtotalBs: number;
  discountPct?: number | null;
  invoiceTaxPct?: number | null;
};

export type OrderTotalsSnapshot = {
  discountAmountUsd: number;
  discountAmountBs: number;
  subtotalAfterDiscountUsd: number;
  subtotalAfterDiscountBs: number;
  invoiceTaxAmountUsd: number;
  invoiceTaxAmountBs: number;
  totalUsd: number;
  totalBs: number;
};

function toSafeNumber(value: unknown, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function roundMoney(value: number) {
  return Number(toSafeNumber(value, 0).toFixed(2));
}

export function calculateOrderLineSnapshot(input: OrderLineSnapshotInput): OrderLineSnapshot {
  const sourceAmount = Math.max(0, toSafeNumber(input.sourceAmount, 0));
  const quantity = Math.max(0, toSafeNumber(input.quantity, 0));
  const fxRate = Math.max(0, toSafeNumber(input.fxRate, 0));
  const overrideUnitUsd =
    input.overrideUnitUsd == null ? null : Math.max(0, toSafeNumber(input.overrideUnitUsd, 0));

  if (overrideUnitUsd != null) {
    const lineUsd = roundMoney(overrideUnitUsd * quantity);
    const unitBs = fxRate > 0 ? roundMoney(overrideUnitUsd * fxRate) : 0;
    return {
      unitUsd: roundMoney(overrideUnitUsd),
      lineUsd,
      unitBs,
      lineBs: fxRate > 0 ? roundMoney(lineUsd * fxRate) : 0,
    };
  }

  if (input.sourceCurrency === 'VES') {
    const unitBs = roundMoney(sourceAmount);
    const lineBs = roundMoney(unitBs * quantity);
    const unitUsd =
      fxRate > 0 ? roundMoney(unitBs / fxRate) : roundMoney(toSafeNumber(input.fallbackUnitUsd, 0));
    return {
      unitUsd,
      lineUsd: fxRate > 0 ? roundMoney(lineBs / fxRate) : roundMoney(unitUsd * quantity),
      unitBs,
      lineBs,
    };
  }

  const unitUsd = roundMoney(sourceAmount);
  const lineUsd = roundMoney(unitUsd * quantity);
  return {
    unitUsd,
    lineUsd,
    unitBs: fxRate > 0 ? roundMoney(unitUsd * fxRate) : 0,
    lineBs: fxRate > 0 ? roundMoney(lineUsd * fxRate) : 0,
  };
}

export function calculateOrderTotalsSnapshot(input: OrderTotalsSnapshotInput): OrderTotalsSnapshot {
  const subtotalUsd = Math.max(0, toSafeNumber(input.subtotalUsd, 0));
  const subtotalBs = Math.max(0, toSafeNumber(input.subtotalBs, 0));
  const discountPct = Math.max(0, Math.min(100, toSafeNumber(input.discountPct, 0)));
  const invoiceTaxPct = Math.max(0, toSafeNumber(input.invoiceTaxPct, 0));

  const discountAmountUsd = roundMoney(subtotalUsd * (discountPct / 100));
  const discountAmountBs = roundMoney(subtotalBs * (discountPct / 100));
  const subtotalAfterDiscountUsd = roundMoney(Math.max(0, subtotalUsd - discountAmountUsd));
  const subtotalAfterDiscountBs = roundMoney(Math.max(0, subtotalBs - discountAmountBs));
  const invoiceTaxAmountUsd = roundMoney(subtotalAfterDiscountUsd * (invoiceTaxPct / 100));
  const invoiceTaxAmountBs = roundMoney(subtotalAfterDiscountBs * (invoiceTaxPct / 100));

  return {
    discountAmountUsd,
    discountAmountBs,
    subtotalAfterDiscountUsd,
    subtotalAfterDiscountBs,
    invoiceTaxAmountUsd,
    invoiceTaxAmountBs,
    totalUsd: roundMoney(subtotalAfterDiscountUsd + invoiceTaxAmountUsd),
    totalBs: roundMoney(subtotalAfterDiscountBs + invoiceTaxAmountBs),
  };
}
