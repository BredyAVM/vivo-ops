import type { CounterDeliveryCashLine, CounterDeliverySettlementDetail, CounterDeliveryValueLine } from './delivery-contract';

const cents = (amount: number) => Math.round(amount * 100);

/** Adapt one physical receipt to the existing atomic return command, not a new payment. */
export function buildSingleCaptureReturn(
  detail: CounterDeliverySettlementDetail,
  cashReturnLines: CounterDeliveryCashLine[]
) {
  const customerCollectionLines: CounterDeliveryValueLine[] = [];
  const currencies = new Set([
    ...detail.currencyBreakdown.map((item) => item.currencyCode),
    ...cashReturnLines.map((item) => item.currencyCode),
  ]);
  let complete = currencies.size > 0;
  for (const code of currencies) {
    const prior = detail.currencyBreakdown.find((item) => item.currencyCode === code);
    let alreadyDeclared = Math.max(0, cents(prior?.customerCollection ?? 0) - cents(prior?.cashReturned ?? 0));
    const lines = cashReturnLines.filter((line) => line.currencyCode === code);
    for (const line of lines) {
      if (!Number.isFinite(line.amount) || line.amount <= 0) throw new Error('Indica un monto válido para el retorno.');
      const covered = Math.min(alreadyDeclared, cents(line.amount));
      alreadyDeclared -= covered;
      const newCollection = cents(line.amount) - covered;
      if (newCollection > 0) {
        if (detail.collectionFinalizedAt) throw new Error('El monto supera el retorno pendiente. Revisa el importe antes de continuar.');
        customerCollectionLines.push({ ...line, lineKey: `collected-${line.lineKey}`, amount: newCollection / 100 });
      }
    }
    const returned = cents(prior?.cashReturned ?? 0) + lines.reduce((sum, line) => sum + cents(line.amount), 0);
    if (returned < Math.max(cents(prior?.expectedCollection ?? 0), cents(prior?.customerCollection ?? 0))) complete = false;
  }
  return {
    cashReturnLines,
    customerCollectionLines,
    collectionFinal: !detail.collectionFinalizedAt && complete,
  };
}
