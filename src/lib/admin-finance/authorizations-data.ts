import 'server-only';
import { requireAdminContext } from '@/lib/auth';
import { parseAuthorizationQueue, parseExpenseReview, parseExpenseDecision, type AuthorizationKind, type ExpenseDecisionResult } from './authorizations-model';

export async function loadAuthorizations(kind: AuthorizationKind, page: number) {
  const { supabase } = await requireAdminContext();
  const { data, error } = await supabase.rpc('admin_authorizations_v1', { p_kind: kind, p_page: page });
  if (error) throw new Error('No se pudieron consultar las autorizaciones. Intenta actualizar la página.');
  return parseAuthorizationQueue(data);
}
export async function loadExpenseReview(movementId: number) {
  const { supabase } = await requireAdminContext();
  const { data, error } = await supabase.rpc('admin_expense_review_v1', { p_movement_id: movementId });
  if (error) throw new Error('No se pudo consultar este movimiento.');
  return parseExpenseReview(data);
}
export async function decideExpense(input: { movementId: number; snapshot: string; decision: 'approve' | 'reject'; reason: string }): Promise<ExpenseDecisionResult> {
  const { supabase } = await requireAdminContext();
  if (!Number.isSafeInteger(input.movementId) || input.movementId <= 0 || !/^[a-f0-9]{32}$/.test(input.snapshot)
    || !['approve', 'reject'].includes(input.decision) || typeof input.reason !== 'string'
    || (input.decision === 'reject' && (!input.reason.trim() || input.reason.length > 800))) {
    return { status: 'error', message: 'Revisión inválida. Para rechazar, indica el motivo (máximo 800 caracteres).' };
  }
  try {
    const { data, error } = await supabase.rpc('decide_admin_expense_v1', { p_movement_id: input.movementId,
      p_snapshot: input.snapshot, p_decision: input.decision, p_reason: input.reason.trim() || null });
    if (error) {
      if (/^(22|23)|^42501$|^P0001$/.test(error.code ?? '')) return { status: 'error', message: error.message };
      throw new Error('Resultado no confirmado.');
    }
    return parseExpenseDecision(data, input.movementId, input.decision);
  } catch {
    return { status: 'uncertain', message: 'No se pudo confirmar el resultado. Actualiza la revisión: si ya se resolvió, verás su estado sin repetir la operación.' };
  }
}
