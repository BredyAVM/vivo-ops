'use server';

import { revalidatePath } from 'next/cache';
import { requireAuthContext } from '@/lib/auth';
import { redirectInWorkspace } from '@/lib/navigation/workspace-server';
import { readAdvisorCommissionSettlementSnapshot } from '@/lib/commissions/closure-snapshot';
import { recalculateAdvisorCommissionSettlementsForGoal } from './actions';

export async function transferCommissionCollectionAction(formData: FormData) { throw new Error('All business actions are disabled in the CPU benchmark.'); }
