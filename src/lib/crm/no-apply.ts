export const NO_APPLY_REASONS = {
  duplicate: 'Cliente duplicado',
  wrong_assignment: 'Asignación incorrecta',
  criteria_mismatch: 'No cumple las condiciones',
  do_not_contact: 'Solicitó no recibir propuestas',
  other: 'Otro motivo verificable',
} as const;

export type NoApplyReason = keyof typeof NO_APPLY_REASONS;
export type NoApplyRequest = {
  id: number;
  play_member_id: number;
  status: 'pending' | 'approved' | 'rejected';
  reason_code: NoApplyReason;
  justification: string;
  requested_at: string;
  review_note: string | null;
  reviewed_at: string | null;
};

export function isEvaluablePlayMember(member: { workflow_status: string }) {
  return member.workflow_status !== 'removed';
}
