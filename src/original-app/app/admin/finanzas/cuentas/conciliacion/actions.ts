'use server';
import { requireAdminContext } from '@/lib/auth';
import { resolveReconciliation, undoReconciliation } from '@/lib/admin-finance/account-operation-reads';
import { revalidatePath } from 'next/cache';
import { isDefinitiveTransferRejection } from '@/lib/finance/money-transfer-model';
import { parseReconciliationReceipt, validReconciliationInput, type ReconciliationInput, type ReconciliationResult } from '@/lib/admin-finance/reconciliation';
export async function resolveAdminReconciliation(input: ReconciliationInput): Promise<ReconciliationResult> { throw new Error('All business actions are disabled in the CPU benchmark.'); }
export async function undoAdminReconciliation(requestId: string,reason: string) { throw new Error('All business actions are disabled in the CPU benchmark.'); }
