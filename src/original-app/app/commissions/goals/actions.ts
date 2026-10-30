'use server';

import { revalidatePath } from 'next/cache';
import { redirectInWorkspace } from '@/lib/navigation/workspace-server';
import { requireAuthContext } from '@/lib/auth';
import { loadEligibleCommissionAdvisors } from '@/lib/commissions/advisor-eligibility';
import { loadAdvisorGoalSimulation } from '@/lib/commissions/goal-data';
import {
  ADVISOR_GOAL_BANDS,
  ADVISOR_GOAL_METRICS,
  type AdvisorGoalMetricKey,
} from '@/lib/commissions/goal-engine';
import { suggestNextAdvisorGoalPeriod } from '@/lib/commissions/goal-period';
import { buildAdvisorGoalPublicationBundle } from '@/lib/commissions/goal-publication';
import { notifyAdvisorGoalPublications } from '@/lib/commissions/notifications';
import {
  readAdvisorGoalPeriodConfig,
  readAdvisorGoalPublicationSnapshot,
} from '@/lib/commissions/goal-snapshot';
import { generateAdvisorCommissionClosuresAction } from '@/app/app/master/dashboard/actions';
import { applyAdvisorCommissionGoalResults } from '../actions';

function numberInput(value: FormDataEntryValue | null, label: string) {
  const parsed = Number(String(value ?? '').trim().replace(/\s/g, '').replace('%', '').replace(',', '.'));
  if (!Number.isFinite(parsed)) throw new Error(`${label} no es válido.`);
  return parsed;
}

function textInput(value: FormDataEntryValue | null, maxLength: number) {
  const text = String(value ?? '').trim();
  if (text.length > maxLength) throw new Error(`El texto no puede superar ${maxLength} caracteres.`);
  return text;
}

function scoringInput(formData: FormData) {
  const metricBasePoints = Object.fromEntries(
    ADVISOR_GOAL_METRICS.map((metric) => {
      const weightPct = numberInput(
        formData.get(`metricWeight:${metric.key}`),
        `El peso de ${metric.label}`
      );
      return [metric.key, weightPct * 2];
    })
  ) as Record<AdvisorGoalMetricKey, number>;
  const bands = ADVISOR_GOAL_BANDS.map((band) => ({
    ...band,
    minPoints: band.key === 'yuca'
      ? 0
      : numberInput(formData.get(`bandMin:${band.key}`), `El mínimo de ${band.label}`),
    commissionPct: numberInput(
      formData.get(`bandCommission:${band.key}`),
      `El porcentaje de ${band.label}`
    ),
  }));
  return { metricBasePoints, bands };
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


export async function applyAdvisorGoalResultAction(formData: FormData) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function createAdvisorGoalProjectionPeriodAction(formData: FormData) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function saveAdvisorGoalConfigurationAction(formData: FormData) { throw new Error('All business actions are disabled in the CPU benchmark.'); }
