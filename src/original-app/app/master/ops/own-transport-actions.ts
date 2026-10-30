'use server';

import { revalidatePath } from 'next/cache';
import { requireMasterOrAdminContext } from '@/lib/auth';

export async function assignOwnTransportAction(input: {
  orderId: number; name: string; phone: string; notes: string; operationId: string;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }
