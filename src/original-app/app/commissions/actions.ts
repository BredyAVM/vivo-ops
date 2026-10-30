'use server';

import { revalidatePath } from 'next/cache';
import { commissionCalculationFeedback, commissionCalculationTimeLabel } from '@/lib/commissions/calculation-feedback';
import { redirectInWorkspace } from '@/lib/navigation/workspace-server';
import { requireAuthContext } from '@/lib/auth';
import {
  readAdvisorCommissionCarryOverride,
  writeAdvisorCommissionCarryOverride,
} from '@/lib/commissions/carry-state';
import {
  readAdvisorCommissionSettlementSnapshot,
  writeAdvisorCommissionSettlementSnapshot,
} from '@/lib/commissions/closure-snapshot';
import { readAdvisorGoalPeriodConfig, readAdvisorGoalPublicationSnapshot, resolveAdvisorGoalScoringConfiguration, withAdvisorGoalPublicationSnapshot } from '@/lib/commissions/goal-snapshot';
import { loadAdvisorGoalSimulation } from '@/lib/commissions/goal-data';
import { advisorGoalFinalizationBlock, buildAdvisorGoalResultApplication } from '@/lib/commissions/goal-application';
import {
  ADVISOR_COMMISSION_PAYMENT_DESCRIPTION_PREFIX,
  readCommissionPaymentResult,
} from '@/lib/commissions/payment-ledger';
import {
  notifyAdvisorCommissionPayment,
  notifyAdvisorCommissionPeriodReviewReady,
  notifyAdvisorCommissionReconfirmationRequired,
  resolveAdvisorCommissionReviewNotification,
} from '@/lib/commissions/notifications';
import { calculateAdvisorCommissionSettlement } from '@/lib/commissions/settlement-engine';
import { parseDecimalInput } from '@/lib/number-input';
import { loadCommissionLiveCollections } from '@/lib/commissions/live-collections';
import {
  advisorReceivesCommissions,
  loadEligibleCommissionAdvisors,
} from '@/lib/commissions/advisor-eligibility';
import {
  preserveAdvisorCommissionWorkflowSnapshot,
  reopenAdvisorCommissionWorkflowSnapshot,
} from '@/lib/commissions/workflow-snapshot';
import { generateAdvisorCommissionClosuresAction } from '@/app/app/master/dashboard/actions';

type DeductionRow = {
  deduction_type: string | null;
  amount_usd: number | string | null;
};

type ClosureMoneyRow = {
  id: number | string;
  period_id: number | string;
  advisor_user_id: string;
  status: string;
  gross_commission_usd: number | string | null;
  gift_deductions_usd: number | string | null;
  manual_deductions_usd: number | string | null;
  pending_collection_usd: number | string | null;
  payable_usd: number | string | null;
  snapshot: unknown;
  deductions: DeductionRow[] | null;
};

const ADVISOR_COMMISSION_PCT_FIELD_PREFIX = 'baseCommissionPct:';

function numberValue(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function advisorCommissionRates(formData: FormData) {
  const rates = Object.create(null) as Record<string, number>;

  for (const [field, value] of formData.entries()) {
    if (!field.startsWith(ADVISOR_COMMISSION_PCT_FIELD_PREFIX)) continue;
    const advisorUserId = field.slice(ADVISOR_COMMISSION_PCT_FIELD_PREFIX.length).trim();
    const rawValue = String(value ?? '').trim().replace(',', '.');
    const commissionPct = Number(rawValue);

    if (!advisorUserId || !rawValue || !Number.isFinite(commissionPct)) {
      throw new Error('Indica un porcentaje válido para cada asesor.');
    }
    if (commissionPct < 0 || commissionPct > 100) {
      throw new Error('Cada porcentaje debe estar entre 0 y 100.');
    }

    rates[advisorUserId] = commissionPct;
  }

  if (Object.keys(rates).length === 0) {
    throw new Error('Indica el porcentaje de comisión de cada asesor.');
  }

  return rates;
}

function roundMoney(value: unknown) {
  return Math.round((numberValue(value) + Number.EPSILON) * 100) / 100;
}

async function bestEffortCommissionNotification(
  label: string,
  task: () => Promise<unknown>,
) {
  try {
    await task();
  } catch (error) {
    console.warn(
      `advisor commission notification skipped: ${label}`,
      error instanceof Error ? error.message : 'unknown notification error',
    );
  }
}

function directDeductionsUsd(closure: Pick<ClosureMoneyRow, 'deductions'>) {
  return roundMoney(
    (closure.deductions ?? [])
      .filter((deduction) => deduction.deduction_type !== 'gift')
      .reduce((sum, deduction) => sum + numberValue(deduction.amount_usd), 0)
  );
}

function optionalDate(value: unknown) {
  const date = String(value ?? '').trim();
  if (!date) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error('La fecha prevista de liquidación no es válida.');
  }
  return date;
}

function actionMessage(error: unknown) {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  return 'No se pudo actualizar la liquidación.';
}

async function requireCommissionAdmin() {
  const ctx = await requireAuthContext();
  if (!ctx.roles.includes('admin')) {
    throw new Error('Esta acción requiere permisos de administración.');
  }
  return ctx;
}

async function applySettlementToPreliminaryClosures(input: {
  periodId: number;
  scheduledLiquidationDate: string | null;
  previousSnapshotsByAdvisor?: Map<string, unknown>;
  closureId?: number;
}) {
  const { supabase } = await requireCommissionAdmin();
  const { data: periodData, error: periodError } = await supabase
    .from('advisor_commission_periods')
    .select('id, date_from, status')
    .eq('id', input.periodId)
    .single();

  if (periodError || !periodData) {
    throw new Error(periodError?.message || 'No se pudo cargar el periodo.');
  }
  if (periodData.status !== 'open') {
    throw new Error('Solo se pueden actualizar periodos en revisión.');
  }

  const { data: currentData, error: currentError } = await supabase
    .from('advisor_commission_closures')
    .select(`
      id,
      period_id,
      advisor_user_id,
      status,
      gross_commission_usd,
      gift_deductions_usd,
      manual_deductions_usd,
      pending_collection_usd,
      payable_usd,
      snapshot,
      deductions:advisor_commission_deductions (
        deduction_type,
        amount_usd
      )
    `)
    .eq('period_id', input.periodId)
    .order('id', { ascending: true });

  if (currentError) throw new Error(currentError.message);

  const eligibleAdvisorIds = new Set(
    (await loadEligibleCommissionAdvisors(supabase)).map((advisor) => advisor.userId)
  );
  const currentClosures = ((currentData ?? []) as ClosureMoneyRow[]).filter(
    (closure) =>
      closure.status === 'preliminary' &&
      eligibleAdvisorIds.has(closure.advisor_user_id) &&
      (!input.closureId || Number(closure.id) === input.closureId)
  );
  if (currentClosures.length === 0) {
    return { updated: 0, skippedLocked: (currentData ?? []).length };
  }

  const preliminaryClosureIds = currentClosures.map((c) => Number(c.id));
  const liveCollections = await loadCommissionLiveCollections(supabase, preliminaryClosureIds, { preliminaryClosureIds });

  const calculationCutoffAt = new Date().toISOString();
  const updates = currentClosures.map((closure) => {
    const directDeductions = directDeductionsUsd(closure);
    const live = liveCollections.get(Number(closure.id));
    if (!live?.supported) throw new Error('No se pudo verificar la cobranza para actualizar este preliminar.');
    const snapshotWithWorkflow = preserveAdvisorCommissionWorkflowSnapshot({
      generatedSnapshot: closure.snapshot,
      previousSnapshot: input.previousSnapshotsByAdvisor?.get(closure.advisor_user_id),
    });
    const carryOverride = readAdvisorCommissionCarryOverride(snapshotWithWorkflow);
    const calculation = calculateAdvisorCommissionSettlement({
      carriedCommissionUsd: live.carriedCommissionUsd,
      priorAdvisorDebtUsd: live.priorAdvisorDebtUsd,
      grossCommissionUsd: roundMoney(closure.gross_commission_usd),
      giftDeductionsUsd: roundMoney(closure.gift_deductions_usd),
      directDeductionsUsd: directDeductions,
      outstandingCustomerDebtUsd: live.customerDebtUsd,
    });
    const snapshot = writeAdvisorCommissionSettlementSnapshot({
      currentSnapshot: snapshotWithWorkflow,
      calculation,
      calculationCutoffAt,
      scheduledLiquidationDate: input.scheduledLiquidationDate,
      carrySource: carryOverride ? 'manual-bootstrap' : live.incomingTransferCount > 0 ? 'settlement' : 'none',
    });

    return {
      id: Number(closure.id),
      snapshot,
      manualDeductionsUsd: directDeductions,
      payableUsd: calculation.payableUsd,
      pendingUsd: live.customerDebtUsd,
      pendingOrders: live.orders.filter((order) => order.pendingUsd > 0),
    };
  });

  for (const update of updates) {
    const { error: updateError } = await supabase
      .from('advisor_commission_closures')
      .update({
        snapshot: { ...update.snapshot, pending_orders: update.pendingOrders },
        manual_deductions_usd: update.manualDeductionsUsd,
        payable_usd: update.payableUsd,
        pending_collection_usd: update.pendingUsd,
        pending_payment_count: update.pendingOrders.length,
        updated_at: calculationCutoffAt,
      })
      .eq('id', update.id)
      .eq('status', 'preliminary');

    if (updateError) throw new Error(updateError.message);
  }

  return {
    updated: updates.length,
    skippedLocked: input.closureId
      ? 0
      : (currentData ?? []).length - currentClosures.length,
  };
}

export async function recalculateAdvisorCommissionSettlementsForGoal(input: {
  periodId: number;
  scheduledLiquidationDate: string | null;
  closureId?: number;
  previousSnapshotsByAdvisor?: Record<string, unknown>;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function applyAdvisorCommissionGoalResults(input: {
  periodId: number;
  advisorUserId?: string;
  intent: 'automatic' | 'preliminary' | 'final';
  overrides?: Record<string, { commissionPct: number; reason: string } | null>;
  reason?: string;
  scheduledLiquidationDate?: string | null;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function calculateCommissionPeriodAction(formData: FormData) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

function requiredText(value: unknown, label: string, maxLength: number) {
  const text = String(value ?? '').trim();
  if (!text) throw new Error(`${label} es obligatorio.`);
  if (text.length > maxLength) {
    throw new Error(`${label} no puede superar ${maxLength} caracteres.`);
  }
  return text;
}

function movementDate(value: unknown) {
  const date = String(value ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error('La fecha del abono no es válida.');
  }
  return date;
}

async function loadConfirmedCommissionPayments(
  supabase: Awaited<ReturnType<typeof requireCommissionAdmin>>['supabase'],
  closureId: number
) {
  const { data, error } = await supabase
    .from('money_movements')
    .select('id, amount_usd_equivalent')
    .eq('direction', 'outflow')
    .eq('movement_type', 'expense_payment')
    .eq('status', 'confirmed')
    .like(
      'description',
      `${ADVISOR_COMMISSION_PAYMENT_DESCRIPTION_PREFIX}${closureId} ·%`
    )
    .limit(100);

  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function confirmCommissionClosureAction(formData: FormData) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function reopenCommissionClosureAction(formData: FormData) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function registerCommissionPaymentAction(formData: FormData) { throw new Error('All business actions are disabled in the CPU benchmark.'); }
export async function reverseCommissionPaymentAction(formData: FormData) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

function dateOnly(value: unknown, label: string) {
  const date = String(value ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`${label} no es válida.`);
  }
  return date;
}

export async function createCommissionPeriodAction(formData: FormData) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

async function loadEditableClosure(
  supabase: Awaited<ReturnType<typeof requireCommissionAdmin>>['supabase'],
  closureId: number
) {
  const { data, error } = await supabase
    .from('advisor_commission_closures')
    .select('id, period_id, advisor_user_id, status, snapshot')
    .eq('id', closureId)
    .single();

  if (error || !data) {
    throw new Error(error?.message || 'No se pudo cargar la liquidación.');
  }
  if (data.status !== 'preliminary') {
    throw new Error('Solo una liquidación preliminar admite cambios administrativos.');
  }
  if (!(await advisorReceivesCommissions(supabase, data.advisor_user_id))) {
    throw new Error('Este usuario no está habilitado para recibir comisiones.');
  }
  return data;
}

async function recalculateEditedClosure(input: {
  closureId: number;
  periodId: number;
  snapshot: unknown;
}) {
  const settlement = readAdvisorCommissionSettlementSnapshot(input.snapshot);
  await applySettlementToPreliminaryClosures({
    periodId: input.periodId,
    closureId: input.closureId,
    scheduledLiquidationDate: settlement.scheduledLiquidationDate,
  });
}

export async function addCommissionDeductionAction(formData: FormData) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function deleteCommissionDeductionAction(formData: FormData) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function saveCommissionBootstrapAction(formData: FormData) { throw new Error('All business actions are disabled in the CPU benchmark.'); }
