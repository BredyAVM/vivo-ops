'use server';

import { revalidatePath } from 'next/cache';
import { requireAdminContext, requireMasterOrAdminContext } from '@/lib/auth';

export type CrmOrderMinimum = {
  memberId: number;
  playName: string;
  requiredUsd: number;
  commercialUsd: number;
  fingerprint: string;
  authorizedFloorUsd: number | null;
  reason: string | null;
  approvedAt: string | null;
  approvedBy: string | null;
  eligible: boolean;
};

export async function loadCrmOrderMinimumAction(orderId: number): Promise<CrmOrderMinimum[]> { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function authorizeCrmOrderMinimumAction(input: {
  requestId: string;
  orderId: number;
  memberId: number;
  fingerprint: string;
  expectedCommercialUsd: number;
  minimumAuthorizedUsd: number;
  reason: string;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }
