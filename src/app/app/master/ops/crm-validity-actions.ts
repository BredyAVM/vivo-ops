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

export async function loadCrmOrderValidityAction(orderId: number) {
  const { supabase } = await requireMasterOrAdminContext();
  if (!Number.isSafeInteger(orderId) || orderId <= 0) throw new Error('Orden inválida.');
  const { data, error } = await supabase.rpc('crm_read_order_validity_v1', { p_order_id: orderId });
  if (error) throw new Error(error.message);
  return (data ?? []) as CrmOrderValidity[];
}

export async function authorizeCrmOrderValidityAction(input: {
  requestId: string; orderId: number; memberId: number; fingerprint: string;
  authorizedThrough: string; reason: string;
}) {
  try {
    const { supabase } = await requireAdminContext();
    if (!Number.isSafeInteger(input.orderId) || input.orderId <= 0 ||
      !Number.isSafeInteger(input.memberId) || input.memberId <= 0 ||
      !/^\d{4}-\d{2}-\d{2}$/.test(input.authorizedThrough) ||
      input.reason.trim().length < 10 || input.reason.trim().length > 1000) {
      return { ok: false as const, message: 'Indica una fecha válida y explica el motivo (10 a 1000 caracteres).' };
    }
    const { error } = await supabase.rpc('crm_authorize_order_validity_v1', {
      p_request_id: input.requestId, p_order_id: input.orderId, p_member_id: input.memberId,
      p_fingerprint: input.fingerprint, p_authorized_through: input.authorizedThrough,
      p_reason: input.reason.trim(),
    });
    if (error) throw new Error(error.message);
    for (const path of ['/app/master/ops','/app/master/plays/exceptions','/app/master/dashboard','/app/admin','/app/counter','/app/advisor/orders']) revalidatePath(path);
    return { ok: true as const };
  } catch (error) {
    return { ok: false as const, message: error instanceof Error ? error.message : 'No se pudo autorizar la excepción.' };
  }
}
