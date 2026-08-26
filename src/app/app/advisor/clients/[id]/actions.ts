'use server';

import { revalidatePath } from 'next/cache';
import { isAdvisorRole, isMasterOrAdminRole, requireAuthContext } from '@/lib/auth';

export type PlayFollowUpAction =
  | 'contact'
  | 'follow_up'
  | 'responded'
  | 'accepted'
  | 'converted'
  | 'not_interested'
  | 'unreachable'
  | 'not_applicable'
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
  'accepted',
  'converted',
  'not_interested',
  'unreachable',
  'not_applicable',
  'closed',
  'note',
]);

function successMessage(action: PlayFollowUpAction) {
  const messages: Record<PlayFollowUpAction, string> = {
    contact: 'Contacto registrado.',
    follow_up: 'Próximo seguimiento programado.',
    responded: 'Respuesta registrada.',
    accepted: 'Interés del cliente registrado.',
    converted: 'Resultado convertido registrado.',
    not_interested: 'Resultado guardado como no interesado.',
    unreachable: 'Intento sin respuesta registrado.',
    not_applicable: 'Cliente marcado como no aplicable.',
    closed: 'Seguimiento cerrado.',
    note: 'Nota agregada al historial.',
  };

  return messages[action];
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

    const { data, error } = await ctx.supabase.rpc('crm_record_play_member_action_v1', {
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
  playBenefitId: number;
}) {
  try {
    const ctx = await requireAuthContext();
    if (!isAdvisorRole(ctx.roles) && !isMasterOrAdminRole(ctx.roles)) {
      return { ok: false as const, message: 'No tienes permiso para seleccionar este beneficio.' };
    }

    const playMemberId = Math.trunc(Number(input.playMemberId));
    const playBenefitId = Math.trunc(Number(input.playBenefitId));
    if (playMemberId <= 0 || playBenefitId <= 0) {
      return { ok: false as const, message: 'Selecciona una alternativa válida.' };
    }

    const { data, error } = await ctx.supabase.rpc('crm_select_play_benefit_v1', {
      p_play_member_id: playMemberId,
      p_play_benefit_id: playBenefitId,
    });
    if (error) return { ok: false as const, message: error.message };

    const result = data as { client_id?: number | string } | null;
    const clientId = Number(result?.client_id);
    revalidatePath('/app/advisor/plays');
    if (Number.isFinite(clientId) && clientId > 0) {
      revalidatePath(`/app/advisor/clients/${Math.trunc(clientId)}`);
    }

    return { ok: true as const, message: 'Beneficio seleccionado. Este cliente solo podrá usar esta alternativa.' };
  } catch (error) {
    return {
      ok: false as const,
      message: error instanceof Error ? error.message : 'No se pudo seleccionar el beneficio.',
    };
  }
}
