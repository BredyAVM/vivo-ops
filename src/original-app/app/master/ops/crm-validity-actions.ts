'use server';

import { revalidatePath } from 'next/cache';
import { requireAdminContext, requireMasterOrAdminContext } from '@/lib/auth';

export type CrmOrderValidity = {
  memberId: number; playName: string; playStatus: string; scheduledOn: string | null;
  endsOn: string | null; fingerprint: string; authorizedThrough: string | null;
  reason: string | null; approvedAt: string | null; approvedBy: string | null;
  eligible: boolean; exceptionValid: boolean; canAuthorize: boolean;
  authorizationRoleAllowed: boolean;
};

export async function loadCrmOrderValidityAction(orderId: number) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function authorizeCrmOrderValidityAction(input: {
  requestId: string; orderId: number; memberId: number; fingerprint: string;
  authorizedThrough: string; reason: string;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }
