import type { SupabaseClient } from '@supabase/supabase-js';

export type CommissionLiveOrder = {
  orderId: number; clientName: string; deliveryDate: string | null; totalUsd: number;
  billedUsd: number; confirmedPaidUsd: number; pendingUsd: number; paymentStatus: string;
};
export type CommissionLiveCollection = {
  closureId: number; supported: boolean; checkedAt: string; agreedPayableUsd: number;
  paidUsd: number; customerDebtUsd: number; carriedCommissionUsd: number; priorAdvisorDebtUsd: number;
  creditUsd: number; payableUsd: number; pendingUsd: number; retainedUsd: number; remainingCreditUsd: number;
  advisorDebtUsd: number; overpaidUsd: number; orders: CommissionLiveOrder[];
  transferredToClosureId: number | null; transferredCreditUsd: number | null; transferredAt: string | null;
  incomingTransferCount: number;
};

export async function loadCommissionLiveCollections(supabase: SupabaseClient, closureIds: number[]) {
  if (closureIds.length === 0) return new Map<number, CommissionLiveCollection>();
  const { data, error } = await supabase.rpc('advisor_commission_collections_v1', { p_closure_ids: closureIds });
  if (error || !Array.isArray(data)) throw new Error(error?.message || 'No se pudo verificar la cobranza actual.');
  const result = new Map<number, CommissionLiveCollection>();
  for (const row of data) {
    if (!row || typeof row !== 'object' || !Number.isSafeInteger(row.closureId)
      || typeof row.supported !== 'boolean' || typeof row.checkedAt !== 'string' || !Number.isFinite(Date.parse(row.checkedAt))) {
      throw new Error('La respuesta de cobranza no se pudo verificar.');
    }
    if (row.supported) {
      const amounts = ['agreedPayableUsd','paidUsd','customerDebtUsd','carriedCommissionUsd','priorAdvisorDebtUsd',
        'creditUsd','payableUsd','pendingUsd','retainedUsd','remainingCreditUsd','advisorDebtUsd','overpaidUsd'];
      if (amounts.some((key) => typeof row[key] !== 'number' || !Number.isFinite(row[key]) || row[key] < 0)
        || !Array.isArray(row.orders) || row.orders.some((order: CommissionLiveOrder) => !Number.isSafeInteger(order.orderId)
          || [order.pendingUsd,order.totalUsd,order.confirmedPaidUsd].some((amount) => typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0))) {
        throw new Error('Los importes de cobranza no se pudieron verificar.');
      }
    }
    result.set(row.closureId, row as CommissionLiveCollection);
  }
  if (result.size !== new Set(closureIds).size) throw new Error('La consulta de cobranza está incompleta.');
  return result;
}

export function mergeCommissionLiveOrders<T extends { orderId?: number | string | null }>(
  originals: T[], live: CommissionLiveOrder[],
) : Array<Partial<T> & CommissionLiveOrder> {
  const byId = new Map(originals.map((order) => [Number(order.orderId), order]));
  return live.map((order) => {
    const original = byId.get(order.orderId);
    return { ...original, ...order,
      // A customer's invoice amount is not the commission's net billing base.
      billedUsd: original && 'billedUsd' in original && Number.isFinite(Number(original.billedUsd)) ? Number(original.billedUsd) : order.billedUsd,
    } as Partial<T> & CommissionLiveOrder;
  });
}
