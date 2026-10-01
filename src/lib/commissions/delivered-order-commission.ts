import {
  ORDER_COMMISSION_TERMS_KIND,
  parseOrderCommissionAdjustmentPayload,
  validateOrderCommissionTerms,
  type OrderCommissionTerms,
} from './order-commission-terms.ts';

export type DeliveredCommissionChange = {
  itemId: number;
  action: 'set' | 'clear';
  mode?: string;
  value?: number | null;
};

// Rows must be ordered newest first, just like the closure generator.
export function resolveDeliveredCommissionItem(
  catalog: OrderCommissionTerms,
  payloads: unknown[],
) {
  const parsed = payloads.map(parseOrderCommissionAdjustmentPayload).filter((row) => row != null);
  const admin = parsed.find((row) => row.kind === ORDER_COMMISSION_TERMS_KIND);
  const event = parsed.find((row) => row.kind !== ORDER_COMMISSION_TERMS_KIND)?.terms;
  const inherited = event ?? catalog;
  return { inherited, override: admin?.terms ?? null, effective: admin?.terms ?? inherited };
}

export function validateDeliveredCommissionChanges(changes: DeliveredCommissionChange[], reason: string) {
  if (!reason.trim() || reason.trim().length > 500) throw new Error('Indica un motivo de hasta 500 caracteres.');
  if (!Array.isArray(changes) || changes.length === 0 || changes.length > 200) throw new Error('Selecciona entre 1 y 200 productos para ajustar.');
  const ids = new Set<number>();
  return changes.map((row) => {
    if (!Number.isSafeInteger(row.itemId) || row.itemId <= 0 || ids.has(row.itemId)) throw new Error('El producto del ajuste no es válido o está repetido.');
    ids.add(row.itemId);
    if (row.action === 'clear') return { itemId: row.itemId, action: 'clear' as const };
    if (row.action !== 'set') throw new Error('La acción de comisión no es válida.');
    const terms = validateOrderCommissionTerms(row.mode, row.value);
    return { itemId: row.itemId, action: 'set' as const, ...terms };
  });
}
