'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireAuthContext } from '@/lib/auth';
import { loadEligibleCommissionAdvisors } from '@/lib/commissions/advisor-eligibility';
import { loadAdvisorGoalSimulation } from '@/lib/commissions/goal-data';
import { buildAdvisorGoalPublicationBundle } from '@/lib/commissions/goal-publication';
import {
  readAdvisorGoalPeriodConfig,
  readAdvisorGoalPublicationSnapshot,
} from '@/lib/commissions/goal-snapshot';
import { generateAdvisorCommissionClosuresAction } from '@/app/app/master/dashboard/actions';

function numberInput(value: FormDataEntryValue | null, label: string) {
  const parsed = Number(String(value ?? '').trim().replace(',', '.'));
  if (!Number.isFinite(parsed)) throw new Error(`${label} no es válido.`);
  return parsed;
}

function textInput(value: FormDataEntryValue | null, maxLength: number) {
  const text = String(value ?? '').trim();
  if (text.length > maxLength) throw new Error(`El texto no puede superar ${maxLength} caracteres.`);
  return text;
}

function errorMessage(error: unknown) {
  return error instanceof Error && error.message.trim()
    ? error.message.trim()
    : 'No se pudo guardar la configuración de metas.';
}

async function requireGoalAdmin() {
  const ctx = await requireAuthContext();
  if (!ctx.roles.includes('admin')) throw new Error('Esta acción requiere permisos de administración.');
  return ctx;
}

export async function saveAdvisorGoalConfigurationAction(formData: FormData) {
  const periodId = Number(formData.get('periodId') ?? 0);
  const intent = formData.get('intent') === 'publish' ? 'publish' as const : 'draft' as const;

  try {
    const { supabase, user } = await requireGoalAdmin();
    if (!Number.isInteger(periodId) || periodId <= 0) throw new Error('Selecciona un periodo válido.');
    const billingContextPct = numberInput(formData.get('billingContextPct'), 'El contexto de facturación');
    const closuresContextPct = numberInput(formData.get('closuresContextPct'), 'El contexto de cierres');
    const growthChallengePct = numberInput(formData.get('growthChallengePct'), 'El desafío de crecimiento');
    const reason = textInput(formData.get('reason'), 500);
    const publicationMessage = textInput(formData.get('publicationMessage'), 500) || null;
    if (billingContextPct <= -100 || closuresContextPct <= -100) {
      throw new Error('Los ajustes de contexto deben ser mayores a -100%.');
    }
    if (growthChallengePct < 0 || growthChallengePct > 200) {
      throw new Error('El desafío de crecimiento debe estar entre 0% y 200%.');
    }

    const [periodResult, advisors, closuresResult] = await Promise.all([
      supabase
        .from('advisor_commission_periods')
        .select('id, name, date_from, date_to, status, goal_config')
        .eq('id', periodId)
        .single(),
      loadEligibleCommissionAdvisors(supabase),
      supabase
        .from('advisor_commission_closures')
        .select('advisor_user_id, base_commission_pct')
        .eq('period_id', periodId),
    ]);
    if (periodResult.error || !periodResult.data) {
      throw new Error(periodResult.error?.message || 'No se pudo cargar el periodo.');
    }
    if (periodResult.data.status !== 'open') {
      throw new Error('Solo se pueden configurar metas en un periodo abierto.');
    }
    if (closuresResult.error) throw new Error(closuresResult.error.message);

    const storedRateByAdvisorId = new Map(
      (closuresResult.data ?? []).map((closure) => [
        String(closure.advisor_user_id),
        Number(closure.base_commission_pct ?? 8),
      ])
    );
    const baseCommissionPctByAdvisor = Object.fromEntries(
      advisors.map((advisor) => [advisor.userId, storedRateByAdvisorId.get(advisor.userId) ?? 8])
    );
    await generateAdvisorCommissionClosuresAction({ periodId, baseCommissionPctByAdvisor });

    const simulation = await loadAdvisorGoalSimulation({
      supabase,
      periodId,
      periodFrom: periodResult.data.date_from,
      periodTo: periodResult.data.date_to,
      context: { billingContextPct, closuresContextPct, growthChallengePct },
    });
    const refreshedClosures = await supabase
      .from('advisor_commission_closures')
      .select('advisor_user_id, snapshot')
      .eq('period_id', periodId);
    if (refreshedClosures.error) throw new Error(refreshedClosures.error.message);

    const previousByAdvisorId = new Map(
      (refreshedClosures.data ?? []).flatMap((closure) => {
        const publication = readAdvisorGoalPublicationSnapshot(closure.snapshot);
        return publication ? [[String(closure.advisor_user_id), publication] as const] : [];
      })
    );
    const recordedAt = new Date().toISOString();
    const bundle = buildAdvisorGoalPublicationBundle({
      simulation,
      periodId,
      intent,
      reason,
      publicationMessage,
      actorUserId: user.id,
      recordedAt,
      previousConfig: readAdvisorGoalPeriodConfig(periodResult.data.goal_config),
      previousByAdvisorId,
    });
    const { data: updated, error: saveError } = await supabase.rpc(
      'save_advisor_goal_publications_v1',
      {
        p_period_id: periodId,
        p_period_config: bundle.config,
        p_publications: bundle.publications.map((row) => ({
          advisor_user_id: row.advisorUserId,
          advisor_goal: row.publication,
        })),
      }
    );
    if (saveError) throw new Error(saveError.message);
    if (Number(updated) !== bundle.publications.length) {
      throw new Error('No se guardaron todas las metas de los asesores.');
    }
  } catch (error) {
    redirect(`/app/commissions/goals?period=${periodId > 0 ? periodId : ''}&error=${encodeURIComponent(errorMessage(error))}`);
  }

  revalidatePath('/app/commissions/goals');
  revalidatePath('/app/commissions');
  revalidatePath('/app/advisor/commissions');
  redirect(`/app/commissions/goals?period=${periodId}&notice=${encodeURIComponent(intent === 'publish' ? 'Metas publicadas con trazabilidad por asesor.' : 'Simulación guardada como borrador.')}`);
}
