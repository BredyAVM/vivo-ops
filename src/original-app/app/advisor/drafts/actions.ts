'use server';

import { revalidatePath } from 'next/cache';
import { requireAuthContext } from '@/lib/auth';
import { readEventBudgetPayload } from '@/lib/events/event-budget';

export async function archiveAdvisorOrderDraftAction(draftIdInput: number) { throw new Error('All business actions are disabled in the CPU benchmark.'); }
