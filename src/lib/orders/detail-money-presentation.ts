export type DetailPriceCurrency = 'USD' | 'VES';

type DetailPriceLine = {
  pricingOriginCurrency?: DetailPriceCurrency | null;
  lineTotalBs?: number | null;
  priceBs: number;
  qty: number;
};

/** Presentation only: never infer an order's financial policy from catalog or date. */
export function orderDetailLineCurrency(line: DetailPriceLine, collectionMode?: string | null): DetailPriceCurrency {
  return collectionMode === 'native_usd' || line.pricingOriginCurrency === 'USD' ? 'USD' : 'VES';
}

export function orderDetailPrimaryCurrency(lines: DetailPriceLine[], collectionMode?: string | null): DetailPriceCurrency {
  if (collectionMode === 'native_usd') return 'USD';
  return lines.length > 0 && lines.every((line) => line.pricingOriginCurrency === 'USD') ? 'USD' : 'VES';
}

/** Prefer the exact stored line total, including zero, over rounded unit × quantity. */
export function orderDetailLineBs(line: DetailPriceLine): number {
  return line.lineTotalBs != null && Number.isFinite(line.lineTotalBs)
    ? line.lineTotalBs : line.qty * line.priceBs;
}

export type DetailCollectionSnapshot = {
  pendingBs?: number | null;
  paymentCollectionMode?: string | null;
  paymentStateOperationDate?: string | null;
};

/** Reuse the certified balance only for its own operation date; no conversion here. */
export function orderDetailCollectionSnapshot(input: DetailCollectionSnapshot, operationDate?: string | null) {
  if (operationDate && input.paymentStateOperationDate !== operationDate) return null;
  if (input.pendingBs == null || !Number.isFinite(input.pendingBs) || input.pendingBs < 0) return null;
  const mode = input.paymentCollectionMode;
  if (mode !== 'native_usd' && mode !== 'post_delivery_usd' && mode !== 'snapshot_quote' && mode !== 'closed') return null;
  return {
    pendingBs: input.pendingBs,
    mode,
    label: mode === 'snapshot_quote' ? 'Por cobrar en Bs · monto acordado' : 'Por cobrar en Bs · tasa vigente',
    operationDate: input.paymentStateOperationDate ?? null,
  };
}
