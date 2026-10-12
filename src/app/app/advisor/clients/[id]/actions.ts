'use server';

import { revalidatePath } from 'next/cache';
import { isAdvisorRole, isMasterOrAdminRole, requireAuthContext } from '@/lib/auth';
import { NO_APPLY_REASONS, type NoApplyReason } from '@/lib/crm/no-apply';

export type PlayFollowUpAction =
  | 'contact'
  | 'follow_up'
  | 'responded'
  | 'launched'
  | 'accepted'
  | 'converted'
  | 'not_interested'
  | 'unreachable'
  | 'closed'
  | 'note';

type RecordPlayFollowUpInput = {
  playMemberId: number;
  action: PlayFollowUpAction;
  note?: string | null;
  followUpAt?: string | null;
  channel?: 'whatsapp' | 'call' | 'in_person' | 'other' | null;
};

const allowedActions = new Set<PlayFollowUpAction>([
  'contact',
  'follow_up',
  'responded',
  'launched',
  'accepted',
  'converted',
  'not_interested',
  'unreachable',
  'closed',
  'note',
]);

function successMessage(action: PlayFollowUpAction) {
  const messages: Record<PlayFollowUpAction, string> = {
    contact: 'Contacto inicial registrado.',
    follow_up: 'Próximo seguimiento programado.',
    responded: 'Respuesta al saludo registrada.',
    launched: 'Jugada marcada como lanzada.',
    accepted: 'Interés del cliente registrado.',
    converted: 'Resultado convertido registrado.',
    not_interested: 'Resultado guardado como no interesado.',
    unreachable: 'Intento sin respuesta registrado.',
    closed: 'Seguimiento cerrado.',
    note: 'Nota agregada al historial.',
  };

  return messages[action];
}

export async function requestClientPlayNoApplyAction(input: {
  playMemberId: number;
  reasonCode: NoApplyReason;
  justification: string;
}) {
  try {
    const ctx = await requireAuthContext();
    if (!isAdvisorRole(ctx.roles)) return { ok: false, message: 'Solo el asesor asignado puede solicitarlo.' };
    const memberId = Number(input.playMemberId);
    const justification = String(input.justification ?? '').trim();
    if (!Number.isSafeInteger(memberId) || memberId <= 0
      || !Object.hasOwn(NO_APPLY_REASONS, input.reasonCode)
      || justification.length < 10 || justification.length > 1000) {
      return { ok: false, message: 'Selecciona un motivo y justifícalo en 10 a 1000 caracteres.' };
    }
    const { data, error } = await ctx.supabase.rpc('crm_request_play_no_apply_v1', {
      p_play_member_id: memberId, p_reason_code: input.reasonCode, p_justification: justification,
    });
    if (error) return { ok: false, message: error.message };
    revalidatePath('/app/advisor/plays');
    revalidatePath('/app/master/plays');
    revalidatePath('/app/admin/jugadas');
    const clientId = Number((data as { client_id?: number } | null)?.client_id);
    if (clientId > 0) revalidatePath(`/app/advisor/clients/${clientId}`);
    return { ok: true, message: 'Solicitud enviada al administrador. Sigue contando hasta que se apruebe.' };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : 'No se pudo enviar la solicitud.' };
  }
}

export async function recordClientPlayFollowUpAction(input: RecordPlayFollowUpInput) {
  try {
    const ctx = await requireAuthContext();
    if (!isAdvisorRole(ctx.roles) && !isMasterOrAdminRole(ctx.roles)) {
      return { ok: false as const, message: 'No tienes permiso para registrar este seguimiento.' };
    }

    const playMemberId = Math.trunc(Number(input.playMemberId));
    if (!Number.isFinite(playMemberId) || playMemberId <= 0) {
      return { ok: false as const, message: 'La participación de la jugada no es válida.' };
    }

    if (!allowedActions.has(input.action)) {
      return { ok: false as const, message: 'La acción de seguimiento no es válida.' };
    }

    const note = String(input.note || '').trim().slice(0, 2000) || null;
    const followUpAt = String(input.followUpAt || '').trim() || null;
    if (followUpAt && Number.isNaN(Date.parse(followUpAt))) {
      return { ok: false as const, message: 'La fecha del próximo seguimiento no es válida.' };
    }

    const { data, error } = await ctx.supabase.rpc('crm_record_play_member_action_v3', {
      p_play_member_id: playMemberId,
      p_action: input.action,
      p_note: note,
      p_follow_up_at: followUpAt,
      p_channel: input.channel || null,
    });

    if (error) {
      return { ok: false as const, message: error.message };
    }

    const result = data as { client_id?: number | string } | null;
    const clientId = Number(result?.client_id);

    revalidatePath('/app/advisor/plays');
    revalidatePath('/app/advisor/clients');
    if (Number.isFinite(clientId) && clientId > 0) {
      revalidatePath(`/app/advisor/clients/${Math.trunc(clientId)}`);
    }

    return { ok: true as const, message: successMessage(input.action) };
  } catch (error) {
    return {
      ok: false as const,
      message: error instanceof Error ? error.message : 'No se pudo guardar el seguimiento.',
    };
  }
}

export async function selectClientPlayBenefitAction(input: {
  playMemberId: number;
  playBenefitIds: number[];
}) {
  try {
    const ctx = await requireAuthContext();
    if (!isAdvisorRole(ctx.roles) && !isMasterOrAdminRole(ctx.roles)) {
      return { ok: false as const, message: 'No tienes permiso para seleccionar este beneficio.' };
    }

    const playMemberId = Math.trunc(Number(input.playMemberId));
    const playBenefitIds = Array.from(new Set(
      (Array.isArray(input.playBenefitIds) ? input.playBenefitIds : [])
        .map((value) => Math.trunc(Number(value)))
        .filter((value) => value > 0)
    ));
    if (playMemberId <= 0 || playBenefitIds.length === 0) {
      return { ok: false as const, message: 'Selecciona al menos un beneficio válido.' };
    }

    const { data, error } = await ctx.supabase.rpc('crm_set_play_benefits_v2', {
      p_play_member_id: playMemberId,
      p_play_benefit_ids: playBenefitIds,
    });
    if (error) return { ok: false as const, message: error.message };

    const result = data as { client_id?: number | string } | null;
    const clientId = Number(result?.client_id);
    revalidatePath('/app/advisor/plays');
    if (Number.isFinite(clientId) && clientId > 0) {
      revalidatePath(`/app/advisor/clients/${Math.trunc(clientId)}`);
    }

    return {
      ok: true as const,
      message: playBenefitIds.length === 1
        ? 'Beneficio seleccionado para este cliente.'
        : `${playBenefitIds.length} beneficios seleccionados para este cliente.`,
    };
  } catch (error) {
    return {
      ok: false as const,
      message: error instanceof Error ? error.message : 'No se pudo seleccionar el beneficio.',
    };
  }
}
