'use server';

import { requireCounterOperatorContext } from '@/lib/auth';
import {
  loadCounterActiveQueueRead,
  loadCounterCashSnapshotRead,
  loadCounterCatalogRead,
  loadCounterOrderDetailRead,
  loadCounterPendingSettlementsRead,
  type CounterPendingSettlementCursor,
} from './read-model';

export async function refreshCounterQueueAction() {
  const ctx = await requireCounterOperatorContext();
  return loadCounterActiveQueueRead(ctx.supabase);
}

export async function loadCounterOrderDetailAction(input: { orderId: number }) {
  const ctx = await requireCounterOperatorContext();
  const orderId = Math.trunc(Number(input.orderId || 0));
  if (!Number.isFinite(orderId) || orderId <= 0) {
    throw new Error('La orden indicada no es valida.');
  }
  return loadCounterOrderDetailRead(ctx.supabase, orderId);
}

export async function loadCounterCatalogAction() {
  const ctx = await requireCounterOperatorContext();
  return loadCounterCatalogRead(ctx.supabase);
}

export async function loadCounterCashSnapshotAction() {
  const ctx = await requireCounterOperatorContext();
  return loadCounterCashSnapshotRead(ctx.supabase);
}

export async function loadCounterPendingSettlementsAction(input: {
  cursor?: CounterPendingSettlementCursor | null;
} = {}) {
  const ctx = await requireCounterOperatorContext();
  return loadCounterPendingSettlementsRead(ctx.supabase, input.cursor ?? null);
}
