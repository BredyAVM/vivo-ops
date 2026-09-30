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

export async function loadCrmOrderMinimumAction(orderId: number): Promise<CrmOrderMinimum[]> {
  const { supabase } = await requireMasterOrAdminContext();
  const { data, error } = await supabase.rpc('crm_read_order_minimum_v1', { p_order_id: orderId });
  if (error) throw new Error(error.message);
  return (data ?? []) as CrmOrderMinimum[];
}

export async function authorizeCrmOrderMinimumAction(input: {
  requestId: string;
  orderId: number;
  memberId: number;
  fingerprint: string;
  expectedCommercialUsd: number;
  minimumAuthorizedUsd: number;
  reason: string;
}) {
  try {
    const { supabase } = await requireAdminContext();
    const { error } = await supabase.rpc('crm_authorize_order_minimum_v1', {
      p_request_id: input.requestId,
      p_order_id: input.orderId,
      p_member_id: input.memberId,
      p_fingerprint: input.fingerprint,
      p_expected_commercial_usd: input.expectedCommercialUsd,
      p_minimum_authorized_usd: input.minimumAuthorizedUsd,
      p_reason: input.reason.trim(),
    });
    if (error) throw new Error(error.message);
    revalidatePath('/app/master/ops');
    revalidatePath('/app/counter');
    return { ok: true as const };
  } catch (error) {
    return { ok: false as const, message: error instanceof Error ? error.message : 'No se pudo autorizar la excepción.' };
  }
}
