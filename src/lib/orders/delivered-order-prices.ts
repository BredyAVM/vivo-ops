export type DeliveredPriceChange = { itemId: number; unitPriceUsd: number };

export function validateDeliveredPriceChanges(changes: DeliveredPriceChange[], reason: string) {
  if (typeof reason !== 'string' || !reason.trim() || reason.trim().length > 500) throw new Error('Indica un motivo de hasta 500 caracteres.');
  if (!Array.isArray(changes) || changes.length < 1 || changes.length > 200) throw new Error('Selecciona entre 1 y 200 precios para ajustar.');
  const seen = new Set<number>();
  return changes.map((change) => {
    if (!change || !Number.isSafeInteger(change.itemId) || change.itemId <= 0 || seen.has(change.itemId)) throw new Error('El producto no es válido o está repetido.');
    seen.add(change.itemId);
    if (typeof change.unitPriceUsd !== 'number' || !Number.isFinite(change.unitPriceUsd) || change.unitPriceUsd < 0 || change.unitPriceUsd > 9999999999.99 || Math.abs(change.unitPriceUsd * 100 - Math.round(change.unitPriceUsd * 100)) > 0.0001) throw new Error('Indica un precio unitario en USD con hasta dos decimales.');
    return { itemId: change.itemId, unitPriceUsd: change.unitPriceUsd };
  });
}
