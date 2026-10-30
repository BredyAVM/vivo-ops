'use server';

import { requireCounterOperatorContext } from '@/lib/auth';
import {
  loadCounterActiveQueueRead,
  loadCounterCashMovementsRead,
  loadCounterCashSnapshotRead,
  loadCounterCatalogRead,
  loadCounterDeliverySettlementDetailRead,
  loadCounterOrderDetailRead,
  loadCounterPaymentQuoteRead,
  loadCounterPendingSettlementsRead,
  type CounterPendingSettlementCursor,
} from './read-model';
import type { CounterCashMovementCursor } from './CounterClient';

export async function refreshCounterQueueAction() { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function loadCounterOrderDetailAction(input: { orderId: number }) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function loadCounterPaymentQuoteAction(input: {
  orderId: number;
  operationDate: string;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function loadCounterCatalogAction() { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function loadCounterCashSnapshotAction() { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function loadCounterCashMovementsAction(input: {
  moneyAccountId: number;
  cursor?: CounterCashMovementCursor | null;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function loadCounterPendingSettlementsAction(input: {
  cursor?: CounterPendingSettlementCursor | null;
} = {}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function loadCounterDeliverySettlementDetailAction(input: {
  settlementId?: number | null;
  orderId?: number | null;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }
