'use server';

// Shared financial command boundary; Admin pages contain no business queries.

import { revalidatePath } from 'next/cache';
import { requireAdminContext } from '@/lib/auth';
import { getOrderLineTotalBs, getOrderLineTotalUsd, getOrderMoneySnapshot, roundOrderMoney } from '@/lib/orders/order-money';
import { validateDeliveredPriceChanges, type DeliveredPriceChange } from '@/lib/orders/delivered-order-prices';
import { loadDeliveredOrderCommissionEditor, refreshDeliveredOrderPriceCommissions } from '@/app/app/commissions/order-actions';

function message(error: unknown) { return error instanceof Error ? error.message : 'No se pudo ajustar el precio.'; }

export async function loadDeliveredOrderPriceEditor(orderId: number) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function saveDeliveredOrderPriceEditor(input: { orderId: number; lastModifiedAt: string | null; operationId: string; reason: string; changes: DeliveredPriceChange[] }) { throw new Error('All business actions are disabled in the CPU benchmark.'); }
