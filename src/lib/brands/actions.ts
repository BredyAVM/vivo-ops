'use server';

import { revalidatePath } from 'next/cache';
import { requireAdminContext } from '@/lib/auth';
import { parseIncentiveUsd } from './model';

export type BrandIncentiveState = { ok: boolean; message: string };

export async function saveBrandIncentiveDraft(
  _previous: BrandIncentiveState, form: FormData,
): Promise<BrandIncentiveState> { throw new Error('All business actions are disabled in the CPU benchmark.'); }
