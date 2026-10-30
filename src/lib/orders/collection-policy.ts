export type PaymentCollectionMode = 'closed' | 'snapshot_quote' | 'post_delivery_usd' | 'native_usd';

export function normalizePaymentCollectionMode(value: unknown): PaymentCollectionMode {
  return value === 'snapshot_quote' || value === 'post_delivery_usd' || value === 'native_usd'
    ? value : 'closed';
}

export function paymentCollectionValueRate(quote: {
  collectionMode: PaymentCollectionMode; exchangeRate: number; snapshotRate: number;
}) {
  return quote.collectionMode === 'post_delivery_usd' || quote.collectionMode === 'native_usd'
    ? quote.exchangeRate : quote.snapshotRate || quote.exchangeRate;
}

/** The server's commercial version wins over delivery-date rules for new sales. */
export function paymentCollectionGuidance(nativeUsd: boolean, afterDelivery: boolean) {
  if (nativeUsd) return {
    key: 'native_usd', label: 'Saldo USD · tasa vigente',
    description: 'Los abonos conservan su valor USD; solo lo pendiente se convierte a la tasa vigente.',
  } as const;
  if (afterDelivery) return {
    key: 'post_delivery_usd', label: 'Cobranza dolarizada',
    description: 'La fecha de operacion es posterior a la entrega: el saldo Bs se calcula con la tasa activa.',
  } as const;
  return {
    key: 'snapshot_quote', label: 'Presupuesto snapshot',
    description: 'Se mantiene el monto Bs congelado del presupuesto.',
  } as const;
}
