'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireAuthContext } from '@/lib/auth';
import { getAdvisorCommissionCarryState } from '@/lib/commissions/carry-state';
import { writeAdvisorCommissionSettlementSnapshot } from '@/lib/commissions/closure-snapshot';
import { calculateAdvisorCommissionSettlement } from '@/lib/commissions/settlement-engine';
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

type PeriodRow = {
  id: number | string;
  date_from: string;
};

function numberValue(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function roundMoney(value: unknown) {
  return Math.round((numberValue(value) + Number.EPSILON) * 100) / 100;
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

  const currentClosures = ((currentData ?? []) as ClosureMoneyRow[]).filter(
    (closure) => closure.status === 'preliminary'
  );
  if (currentClosures.length === 0) {
    return { updated: 0, skippedLocked: (currentData ?? []).length };
  }

  const advisorIds = Array.from(
    new Set(currentClosures.map((closure) => closure.advisor_user_id).filter(Boolean))
  );
  const { data: priorPeriodsData, error: priorPeriodsError } = await supabase
    .from('advisor_commission_periods')
    .select('id, date_from')
    .lt('date_from', periodData.date_from)
    .order('date_from', { ascending: false })
    .limit(40);

  if (priorPeriodsError) throw new Error(priorPeriodsError.message);

  const priorPeriods = (priorPeriodsData ?? []) as PeriodRow[];
  const priorPeriodIds = priorPeriods.map((period) => Number(period.id));
  const priorPeriodRank = new Map(
    priorPeriods.map((period, index) => [Number(period.id), index])
  );
  let priorClosures: ClosureMoneyRow[] = [];

  if (priorPeriodIds.length > 0 && advisorIds.length > 0) {
    const { data: priorData, error: priorError } = await supabase
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
      .in('period_id', priorPeriodIds)
      .in('advisor_user_id', advisorIds)
      .limit(4000);

    if (priorError) throw new Error(priorError.message);
    priorClosures = (priorData ?? []) as ClosureMoneyRow[];
  }

  const priorByAdvisor = new Map<string, ClosureMoneyRow>();
  for (const closure of priorClosures) {
    const current = priorByAdvisor.get(closure.advisor_user_id);
    const rank = priorPeriodRank.get(Number(closure.period_id)) ?? Number.MAX_SAFE_INTEGER;
    const currentRank = current
      ? priorPeriodRank.get(Number(current.period_id)) ?? Number.MAX_SAFE_INTEGER
      : Number.MAX_SAFE_INTEGER;
    if (!current || rank < currentRank) {
      priorByAdvisor.set(closure.advisor_user_id, closure);
    }
  }

  const calculationCutoffAt = new Date().toISOString();
  const updates = currentClosures.map((closure) => {
    const directDeductions = directDeductionsUsd(closure);
    const prior = priorByAdvisor.get(closure.advisor_user_id);
    const priorCarry = prior
      ? getAdvisorCommissionCarryState({
          snapshot: prior.snapshot,
          grossCommissionUsd: numberValue(prior.gross_commission_usd),
          giftDeductionsUsd: numberValue(prior.gift_deductions_usd),
          directDeductionsUsd: directDeductionsUsd(prior),
          payableUsd: numberValue(prior.payable_usd),
        })
      : {
          commissionCarryUsd: 0,
          advisorDebtCarryUsd: 0,
          source: 'legacy-inferred' as const,
        };
    const calculation = calculateAdvisorCommissionSettlement({
      carriedCommissionUsd: priorCarry.commissionCarryUsd,
      priorAdvisorDebtUsd: priorCarry.advisorDebtCarryUsd,
      grossCommissionUsd: roundMoney(closure.gross_commission_usd),
      giftDeductionsUsd: roundMoney(closure.gift_deductions_usd),
      directDeductionsUsd: directDeductions,
      outstandingCustomerDebtUsd: roundMoney(closure.pending_collection_usd),
    });
    const snapshot = writeAdvisorCommissionSettlementSnapshot({
      currentSnapshot: closure.snapshot,
      calculation,
      calculationCutoffAt,
      scheduledLiquidationDate: input.scheduledLiquidationDate,
    });

    return {
      id: Number(closure.id),
      snapshot,
      manualDeductionsUsd: directDeductions,
      payableUsd: calculation.payableUsd,
    };
  });

  for (const update of updates) {
    const { error: updateError } = await supabase
      .from('advisor_commission_closures')
      .update({
        snapshot: update.snapshot,
        manual_deductions_usd: update.manualDeductionsUsd,
        payable_usd: update.payableUsd,
        updated_at: calculationCutoffAt,
      })
      .eq('id', update.id)
      .eq('status', 'preliminary');

    if (updateError) throw new Error(updateError.message);
  }

  return {
    updated: updates.length,
    skippedLocked: (currentData ?? []).length - currentClosures.length,
  };
}

export async function calculateCommissionPeriodAction(formData: FormData) {
  const periodId = Number(formData.get('periodId') ?? 0);
  const baseCommissionPct = numberValue(formData.get('baseCommissionPct'));
  let result: { updated: number; skippedLocked: number };

  try {
    await requireCommissionAdmin();
    if (!Number.isInteger(periodId) || periodId <= 0) {
      throw new Error('Selecciona un periodo válido.');
    }
    if (baseCommissionPct < 0 || baseCommissionPct > 100) {
      throw new Error('El porcentaje debe estar entre 0 y 100.');
    }
    const scheduledLiquidationDate = optionalDate(formData.get('scheduledLiquidationDate'));

    await generateAdvisorCommissionClosuresAction({
      periodId,
      baseCommissionPct,
    });
    result = await applySettlementToPreliminaryClosures({
      periodId,
      scheduledLiquidationDate,
    });
  } catch (error) {
    redirect(
      `/app/commissions?period=${Number.isInteger(periodId) && periodId > 0 ? periodId : ''}&error=${encodeURIComponent(
        actionMessage(error)
      )}`
    );
  }

  revalidatePath('/app/commissions');
  redirect(
    `/app/commissions?period=${periodId}&notice=${encodeURIComponent(
      `${result.updated} liquidaciones actualizadas${
        result.skippedLocked > 0 ? `; ${result.skippedLocked} protegidas por estar cerradas` : ''
      }.`
    )}`
  );
}
