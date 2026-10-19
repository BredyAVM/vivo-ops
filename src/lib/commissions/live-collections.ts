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

type CollectionReadOptions = { preliminaryClosureIds?: readonly number[] };
export type CommissionCollectionRead = {
  collections: Map<number, CommissionLiveCollection>;
  errors: Map<number, string>;
};

function validateCollection(row: Record<string, unknown>, preliminary: boolean) {
  if (typeof row.supported !== 'boolean' || typeof row.checkedAt !== 'string' || !Number.isFinite(Date.parse(row.checkedAt))) {
    throw new Error('La respuesta de cobranza no se pudo verificar.');
  }
  if (!row.supported) return;
  // A generated preliminary may temporarily contain a signed proposal. It is
  // not an agreement or a payout limit. Actual availability must stay >= 0.
  const amounts = ['agreedPayableUsd','paidUsd','customerDebtUsd','carriedCommissionUsd','priorAdvisorDebtUsd',
    'creditUsd','payableUsd','pendingUsd','retainedUsd','remainingCreditUsd','advisorDebtUsd','overpaidUsd'];
  if (amounts.some((key) => typeof row[key] !== 'number' || !Number.isFinite(row[key])
      || (Number(row[key]) < 0 && !(key === 'agreedPayableUsd' && preliminary)))
    || !Array.isArray(row.orders) || row.orders.some((order: CommissionLiveOrder) => !order || !Number.isSafeInteger(order.orderId)
      || [order.pendingUsd,order.totalUsd,order.confirmedPaidUsd].some((amount) => typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0))) {
    throw new Error('Los importes de cobranza no se pudieron verificar.');
  }
}

async function readCollectionBatch(supabase: SupabaseClient, closureIds: number[], options: CollectionReadOptions): Promise<CommissionCollectionRead> {
  const collections = new Map<number, CommissionLiveCollection>();
  const errors = new Map<number, string>();
  if (!closureIds.length) return { collections, errors };
  if (closureIds.length > 100 || closureIds.some((id) => !Number.isSafeInteger(id) || id <= 0)) throw new Error('Consulta de liquidaciones inválida.');
  const { data, error } = await supabase.rpc('advisor_commission_collections_v1', { p_closure_ids: closureIds });
  if (error || !Array.isArray(data)) throw new Error(error?.message || 'No se pudo verificar la cobranza actual.');
  const requested = new Set(closureIds);
  const preliminary = new Set(options.preliminaryClosureIds);
  const grouped = new Map<number, Record<string, unknown>[]>();
  for (const row of data) {
    if (!row || typeof row !== 'object' || !Number.isSafeInteger(row.closureId) || !requested.has(row.closureId)) {
      throw new Error('La respuesta de cobranza no se pudo verificar.');
    }
    grouped.set(row.closureId, [...(grouped.get(row.closureId) ?? []), row]);
  }
  for (const id of requested) {
    const rows = grouped.get(id) ?? [];
    if (rows.length !== 1) {
      errors.set(id, rows.length ? 'La consulta de cobranza contiene duplicados.' : 'La consulta de cobranza está incompleta.');
      continue;
    }
    try {
      validateCollection(rows[0], preliminary.has(id));
      collections.set(id, rows[0] as CommissionLiveCollection);
    } catch (error) {
      errors.set(id, error instanceof Error ? error.message : 'No se pudo verificar esta cobranza.');
    }
  }
  return { collections, errors };
}

// Mutation workflows remain strict: no write may proceed on a partial read.
export async function loadCommissionLiveCollections(supabase: SupabaseClient, closureIds: number[], options: CollectionReadOptions = {}) {
  const result = await readCollectionBatch(supabase, closureIds, options);
  if (result.errors.size) throw new Error([...result.errors.values()][0]);
  return result.collections;
}

// Display-only isolation. An RPC exception from one closure must not erase the
// verified balances of its peers. Retry individually, at most four in flight.
export async function loadCommissionLiveCollectionResults(supabase: SupabaseClient, closureIds: number[], options: CollectionReadOptions = {}): Promise<CommissionCollectionRead> {
  if (closureIds.length > 100 || closureIds.some((id) => !Number.isSafeInteger(id) || id <= 0)) throw new Error('Consulta de liquidaciones inválida.');
  try { return await readCollectionBatch(supabase, closureIds, options); }
  catch (error) {
    const collections = new Map<number, CommissionLiveCollection>();
    const errors = new Map<number, string>();
    const ids = [...new Set(closureIds)];
    if (ids.length === 1) {
      errors.set(ids[0], error instanceof Error ? error.message : 'No se pudo verificar esta cobranza.');
      return { collections, errors };
    }
    for (let offset = 0; offset < ids.length; offset += 4) {
      await Promise.all(ids.slice(offset, offset + 4).map(async (id) => {
        try {
          const result = await readCollectionBatch(supabase, [id], options);
          for (const [key, value] of result.collections) collections.set(key, value);
          for (const [key, value] of result.errors) errors.set(key, value);
        } catch (error) {
          errors.set(id, error instanceof Error ? error.message : 'No se pudo verificar esta cobranza.');
        }
      }));
    }
    return { collections, errors };
  }
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
