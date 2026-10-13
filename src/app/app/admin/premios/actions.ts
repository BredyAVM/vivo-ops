'use server';
import { revalidatePath } from 'next/cache';
import { requireAdminContext } from '@/lib/auth';
import { UUID_PATTERN, validateRewardDraft, type RewardDraftInput } from '@/lib/rewards/wallet-model';
export async function saveRewardDraftAction(input: RewardDraftInput, token: string, id?: number, version?: number) {
  try {
    const ctx = await requireAdminContext();
    const errorMessage = validateRewardDraft(input);
    if (errorMessage) return { ok: false, message: errorMessage };
    if (!UUID_PATTERN.test(token) || (id !== undefined && (!Number.isSafeInteger(id) || id <= 0 || !Number.isSafeInteger(version) || Number(version) <= 0))) return { ok: false, message: 'Solicitud inválida.' };
    const { data, error } = await ctx.supabase.rpc('reward_save_draft_v1', { p_payload: input, p_request_token: token, p_draft_id: id ?? null, p_expected_version: version ?? null });
    if (error) return { ok: false, message: error.message };
    revalidatePath('/app/admin/premios');
    return { ok: true, draftId: Number((data as { id: number }).id), message: 'Diseño guardado. No se emitió crédito ni se modificaron comisiones.' };
  } catch (e) { return { ok: false, message: e instanceof Error ? e.message : 'No se pudo guardar.' }; }
}
export async function cancelRewardDraftAction(id: number, version: number, reason: string) {
  try {
    const ctx = await requireAdminContext();
    if (!Number.isSafeInteger(id) || id <= 0 || !Number.isSafeInteger(version) || version <= 0 || typeof reason !== 'string' || reason.trim().length < 10 || reason.trim().length > 500) return { ok: false, message: 'Justifica la cancelación en 10 a 500 caracteres.' };
    const { error } = await ctx.supabase.rpc('reward_cancel_draft_v1', { p_draft_id: id, p_expected_version: version, p_reason: reason.trim() });
    if (error) return { ok: false, message: error.message };
    revalidatePath('/app/admin/premios');
    return { ok: true, message: 'Diseño cancelado; el historial se conserva.' };
  } catch (e) { return { ok: false, message: e instanceof Error ? e.message : 'No se pudo cancelar.' }; }
}
