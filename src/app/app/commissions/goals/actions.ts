'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireAuthContext } from '@/lib/auth';
import { loadEligibleCommissionAdvisors } from '@/lib/commissions/advisor-eligibility';
import { loadAdvisorGoalSimulation } from '@/lib/commissions/goal-data';
import { suggestNextAdvisorGoalPeriod } from '@/lib/commissions/goal-period';
import { buildAdvisorGoalPublicationBundle } from '@/lib/commissions/goal-publication';
import { notifyAdvisorGoalPublications } from '@/lib/commissions/notifications';
import { readAdvisorCommissionSettlementSnapshot } from '@/lib/commissions/closure-snapshot';
import {
  readAdvisorGoalPeriodConfig,
  readAdvisorGoalPublicationSnapshot,
} from '@/lib/commissions/goal-snapshot';
import { generateAdvisorCommissionClosuresAction } from '@/app/app/master/dashboard/actions';
import { recalculateAdvisorCommissionSettlementsForGoal } from '../actions';

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

async function bestEffortGoalNotification(label: string, task: () => Promise<unknown>) {
  try {
    await task();
  } catch (error) {
    console.warn(
      `advisor goal notification skipped: ${label}`,
      error instanceof Error ? error.message : 'unknown notification error'
    );
  }
}

function caracasToday() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Caracas',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const fields = new Map(parts.map((part) => [part.type, part.value]));
  return `${fields.get('year')}-${fields.get('month')}-${fields.get('day')}`;
}

export async function createAdvisorGoalProjectionPeriodAction(formData: FormData) {
  const sourcePeriodId = Number(formData.get('sourcePeriodId') ?? 0);
  let targetPeriodId = 0;
  let notice = '';

  try {
    const { supabase, user } = await requireGoalAdmin();
    if (!Number.isInteger(sourcePeriodId) || sourcePeriodId <= 0) {
      throw new Error('Selecciona un periodo válido para preparar el siguiente.');
    }
    const sourceResult = await supabase
      .from('advisor_commission_periods')
      .select('id, name, date_to')
      .eq('id', sourcePeriodId)
      .single();
    if (sourceResult.error || !sourceResult.data) {
      throw new Error(sourceResult.error?.message || 'No se pudo cargar el periodo de origen.');
    }
    const suggestion = suggestNextAdvisorGoalPeriod(sourceResult.data.date_to);
    const overlapResult = await supabase
      .from('advisor_commission_periods')
      .select('id, name, date_from, date_to')
      .lte('date_from', suggestion.dateTo)
      .gte('date_to', suggestion.dateFrom)
      .limit(1)
      .maybeSingle();
    if (overlapResult.error) throw new Error(overlapResult.error.message);

    if (overlapResult.data) {
      if (
        overlapResult.data.date_from !== suggestion.dateFrom
        || overlapResult.data.date_to !== suggestion.dateTo
      ) {
        throw new Error(`La proyección se cruza con el periodo ${overlapResult.data.name}.`);
      }
      targetPeriodId = Number(overlapResult.data.id);
      notice = `${overlapResult.data.name} ya existía. Se abrió su proyección sin modificar datos.`;
    } else {
      const insertResult = await supabase
        .from('advisor_commission_periods')
        .insert({
          name: suggestion.name,
          date_from: suggestion.dateFrom,
          date_to: suggestion.dateTo,
          status: 'open',
          notes: `Preparado desde la proyección de ${sourceResult.data.name}.`,
          created_by_user_id: user.id,
        })
        .select('id')
        .single();
      if (insertResult.error || !insertResult.data) {
        throw new Error(insertResult.error?.message || 'No se pudo preparar el siguiente periodo.');
      }
      targetPeriodId = Number(insertResult.data.id);
      notice = `${suggestion.name} quedó preparado como proyección. Todavía no publica metas ni calcula comisiones.`;
    }
  } catch (error) {
    redirect(`/app/commissions/goals?period=${sourcePeriodId > 0 ? sourcePeriodId : ''}&error=${encodeURIComponent(errorMessage(error))}`);
  }

  revalidatePath('/app/commissions/goals');
  revalidatePath('/app/commissions');
  redirect(`/app/commissions/goals?period=${targetPeriodId}&notice=${encodeURIComponent(notice)}`);
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
    const previousConfig = readAdvisorGoalPeriodConfig(periodResult.data.goal_config);
    if (previousConfig?.status === 'closed') {
      throw new Error('El resultado ya fue finalizado. Usa la rectificación final para modificarlo.');
    }
    const bundle = buildAdvisorGoalPublicationBundle({
      simulation,
      periodId,
      intent,
      reason,
      publicationMessage,
      actorUserId: user.id,
      recordedAt,
      previousConfig,
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
    if (intent === 'publish') {
      await bestEffortGoalNotification('published', () => notifyAdvisorGoalPublications({
        supabase,
        periodId,
        event: previousConfig?.status === 'published' ? 'updated' : 'published',
      }));
    }
  } catch (error) {
    redirect(`/app/commissions/goals?period=${periodId > 0 ? periodId : ''}&error=${encodeURIComponent(errorMessage(error))}`);
  }

  revalidatePath('/app/commissions/goals');
  revalidatePath('/app/commissions');
  revalidatePath('/app/advisor/commissions');
  redirect(`/app/commissions/goals?period=${periodId}&notice=${encodeURIComponent(intent === 'publish' ? 'Metas publicadas con trazabilidad por asesor.' : 'Simulación guardada como borrador.')}`);
}

export async function finalizeAdvisorGoalResultsAction(formData: FormData) {
  const periodId = Number(formData.get('periodId') ?? 0);

  try {
    const { supabase, user } = await requireGoalAdmin();
    if (!Number.isInteger(periodId) || periodId <= 0) throw new Error('Selecciona un periodo válido.');
    const reason = textInput(formData.get('finalizationReason'), 500);
    const periodResult = await supabase
      .from('advisor_commission_periods')
      .select('id, name, date_from, date_to, status, goal_config')
      .eq('id', periodId)
      .single();
    if (periodResult.error || !periodResult.data) {
      throw new Error(periodResult.error?.message || 'No se pudo cargar el periodo.');
    }
    if (periodResult.data.status !== 'open') throw new Error('El periodo de comisiones ya no está abierto.');
    const previousConfig = readAdvisorGoalPeriodConfig(periodResult.data.goal_config);
    if (!previousConfig || previousConfig.status === 'draft') {
      throw new Error('Primero publica las metas del periodo antes de finalizar sus resultados.');
    }
    if (previousConfig.status === 'closed' && !reason) {
      throw new Error('Indica el motivo de la rectificación antes de volver a confirmar los resultados.');
    }

    const initialClosures = await supabase
      .from('advisor_commission_closures')
      .select('advisor_user_id, status, base_commission_pct, snapshot')
      .eq('period_id', periodId);
    if (initialClosures.error) throw new Error(initialClosures.error.message);
    const currentRateByAdvisorId = new Map(
      (initialClosures.data ?? []).map((closure) => [
        String(closure.advisor_user_id),
        Number(closure.base_commission_pct ?? 8),
      ])
    );
    await generateAdvisorCommissionClosuresAction({
      periodId,
      baseCommissionPctByAdvisor: Object.fromEntries(currentRateByAdvisorId),
    });

    const simulation = await loadAdvisorGoalSimulation({
      supabase,
      periodId,
      periodFrom: periodResult.data.date_from,
      periodTo: periodResult.data.date_to,
      context: {
        billingContextPct: previousConfig.billing.appliedPct,
        closuresContextPct: previousConfig.closures.appliedPct,
        growthChallengePct: previousConfig.growthChallengePct,
      },
    });
    if (caracasToday() < simulation.cutoffDate) {
      throw new Error(`La cobranza se completa el ${simulation.cutoffDate}. Finaliza el resultado a partir de esa fecha.`);
    }

    const refreshedClosures = await supabase
      .from('advisor_commission_closures')
      .select('advisor_user_id, status, base_commission_pct, snapshot')
      .eq('period_id', periodId);
    if (refreshedClosures.error) throw new Error(refreshedClosures.error.message);
    const previousByAdvisorId = new Map(
      (refreshedClosures.data ?? []).flatMap((closure) => {
        const publication = readAdvisorGoalPublicationSnapshot(closure.snapshot);
        return publication ? [[String(closure.advisor_user_id), publication] as const] : [];
      })
    );
    const overrideByAdvisorId = new Map<string, { commissionPct: number; reason: string }>();
    for (const advisor of simulation.advisors) {
      overrideByAdvisorId.set(advisor.advisorUserId, {
        commissionPct: numberInput(
          formData.get(`commissionPct:${advisor.advisorUserId}`),
          `El porcentaje de ${advisor.advisorName}`
        ),
        reason: textInput(formData.get(`overrideReason:${advisor.advisorUserId}`), 500),
      });
    }
    const bundle = buildAdvisorGoalPublicationBundle({
      simulation,
      periodId,
      intent: 'finalize',
      reason,
      publicationMessage: previousConfig.publicationMessage,
      actorUserId: user.id,
      recordedAt: new Date().toISOString(),
      previousConfig,
      previousByAdvisorId,
      commissionOverrideByAdvisorId: overrideByAdvisorId,
    });
    const targetRateByAdvisorId = Object.fromEntries(
      bundle.publications.map((row) => [row.advisorUserId, row.publication.appliedCommissionPct])
    );
    for (const closure of refreshedClosures.data ?? []) {
      const targetRate = targetRateByAdvisorId[String(closure.advisor_user_id)];
      if (targetRate == null) continue;
      const locked = closure.status === 'closed' || closure.status === 'paid';
      if (locked && Math.abs(Number(closure.base_commission_pct ?? 0) - targetRate) > 0.0001) {
        throw new Error('Hay una liquidación conformada con un porcentaje diferente. Debe reabrirse antes de finalizar el resultado.');
      }
    }

    await generateAdvisorCommissionClosuresAction({
      periodId,
      baseCommissionPctByAdvisor: targetRateByAdvisorId,
    });
    const scheduledLiquidationDate = (refreshedClosures.data ?? [])
      .map((closure) => readAdvisorCommissionSettlementSnapshot(closure.snapshot).scheduledLiquidationDate)
      .find(Boolean) ?? null;
    await recalculateAdvisorCommissionSettlementsForGoal({ periodId, scheduledLiquidationDate });

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
      throw new Error('No se finalizaron todos los resultados de los asesores.');
    }
    await bestEffortGoalNotification('finalized', () => notifyAdvisorGoalPublications({
      supabase,
      periodId,
      event: 'finalized',
    }));
  } catch (error) {
    redirect(`/app/commissions/goals?period=${periodId > 0 ? periodId : ''}&error=${encodeURIComponent(errorMessage(error))}`);
  }

  revalidatePath('/app/commissions/goals');
  revalidatePath('/app/commissions');
  revalidatePath('/app/advisor', 'layout');
  revalidatePath('/app/advisor/inbox');
  revalidatePath('/app/advisor/commissions');
  redirect(`/app/commissions/goals?period=${periodId}&notice=${encodeURIComponent('Resultados finalizados y porcentajes individuales aplicados a las liquidaciones.')}`);
}
