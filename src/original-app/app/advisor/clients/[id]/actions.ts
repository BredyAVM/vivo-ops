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
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function recordClientPlayFollowUpAction(input: RecordPlayFollowUpInput) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function selectClientPlayBenefitAction(input: {
  playMemberId: number;
  playBenefitIds: number[];
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }
