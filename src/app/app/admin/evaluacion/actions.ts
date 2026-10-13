'use server';
import { requireAdminContext } from '@/lib/auth';
import { revalidatePath } from 'next/cache';
import { UUID_PATTERN } from '@/lib/rewards/wallet-model';
import { awardCalculationServer } from '@/lib/rewards/evaluation-server';
import { evaluateAwards, validateAwardRules, type AwardRules, type EvaluationInput } from '@/lib/rewards/evaluation-model';

export async function prepareAwardReview(period: string, rules: AwardRules, token: string) {
  try {
    const ctx = await requireAdminContext();
    const invalid = validateAwardRules(rules);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period) || !UUID_PATTERN.test(token) || invalid) return { ok: false, message: invalid ?? 'Solicitud inválida.' };
    const capture = await ctx.supabase.rpc('admin_award_prepare_v2', { p_month: period + '-01', p_rules: rules, p_token: token });
    if (capture.error || typeof capture.data !== 'string') throw new Error(capture.error?.message ?? 'No se pudo guardar el corte.');
    const report = await ctx.supabase.from('award_month_reports').select('input_snapshot,rules_snapshot').eq('id', capture.data).single();
    if (report.error || !report.data) throw new Error('El corte quedó guardado, pero no se pudo calcular. Reintenta esta misma solicitud.');
    // Never accept points, identities or evidence sent by a client component.
    const result = evaluateAwards(report.data.input_snapshot as EvaluationInput, report.data.rules_snapshot as AwardRules);
    const saved = await awardCalculationServer().rpc('admin_award_calculate_v2', { p_report: capture.data, p_results: result, p_actor: ctx.user.id });
    if (saved.error) throw new Error(saved.error.message);
    revalidatePath('/app/admin/evaluacion');
    return { ok: true, reportId: capture.data, message: 'Corte guardado para revisión. No se publicaron resultados ni premios.' };
  } catch (error) { return { ok: false, message: error instanceof Error ? error.message : 'No se pudo preparar.' }; }
}
export async function publishAwardReview(id: string, expectedPublished: string | null, reason: string, confirmed: boolean) {
  try {
    const ctx = await requireAdminContext();
    if (!confirmed || !UUID_PATTERN.test(id) || expectedPublished !== null && !UUID_PATTERN.test(expectedPublished) || typeof reason !== 'string' || reason.trim().length < 10 || reason.length > 500) return { ok: false, message: 'Confirma las reglas, los resultados y el motivo antes de publicar.' };
    const { error } = await ctx.supabase.rpc('admin_award_publish_v2', { p_report: id, p_expected_published: expectedPublished, p_reason: reason.trim() });
    if (error) throw new Error(error.message);
    revalidatePath('/app/admin/evaluacion');
    revalidatePath('/app/advisor/reconocimientos');
    return { ok: true, message: 'Resultados publicados. No se emitió ningún premio financiero.' };
  } catch (error) { return { ok: false, message: error instanceof Error ? error.message : 'No se pudo publicar.' }; }
}
export async function resumeAwardReview(id: string) {
  try {
    const ctx = await requireAdminContext();
    if (!UUID_PATTERN.test(id)) throw new Error('Revisión inválida.');
    const { data, error } = await ctx.supabase.from('award_month_reports').select('input_snapshot,rules_snapshot').eq('id', id).single();
    if (error || !data) throw new Error('No se pudo leer el corte.');
    const result = evaluateAwards(data.input_snapshot as EvaluationInput, data.rules_snapshot as AwardRules);
    const saved = await awardCalculationServer().rpc('admin_award_calculate_v2', { p_report: id, p_results: result, p_actor: ctx.user.id });
    if (saved.error) throw new Error(saved.error.message);
    revalidatePath('/app/admin/evaluacion');
    return { ok: true, message: 'Cálculo completado sobre el mismo corte guardado.' };
  } catch (error) { return { ok: false, message: error instanceof Error ? error.message : 'No se pudo completar.' }; }
}
