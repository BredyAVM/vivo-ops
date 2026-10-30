'use server';

import { revalidatePath } from 'next/cache';
import { requireAdminContext } from '@/lib/auth';
import { voidFinancialMovementAction } from '@/app/app/master/dashboard/actions';
import { readAccountMovementDetail } from './movement-detail-data';
import { movementVoidBlock, positiveMovementId } from './movement-detail-model';

export async function voidAccountMovementAction(input: {
  accountId: number; movementId: number; fingerprint: string; reason: string;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }
