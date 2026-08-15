'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireAuthContext } from '@/lib/auth';
import { getAdvisorCommissionCarryState } from '@/lib/commissions/carry-state';
import {
  readAdvisorCommissionSettlementSnapshot,
  writeAdvisorCommissionSettlementSnapshot,
} from '@/lib/commissions/closure-snapshot';
import {
  ADVISOR_COMMISSION_PAYMENT_DESCRIPTION_PREFIX,
  buildAdvisorCommissionPaymentDescription,
} from '@/lib/commissions/payment-ledger';
import { calculateAdvisorCommissionSettlement } from '@/lib/commissions/settlement-engine';
import {
  confirmAdvisorCommissionWorkflowSnapshot,
  preserveAdvisorCommissionWorkflowSnapshot,
  readAdvisorCommissionWorkflowSnapshot,
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

  const currentClosures = ((currentData ?? []) as ClosureMoneyRow[]).filter(
    (closure) =>
      closure.status === 'preliminary' &&
      (!input.closureId || Number(closure.id) === input.closureId)
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
          pendingCollectionUsd: numberValue(prior.pending_collection_usd),
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
    const snapshotWithWorkflow = preserveAdvisorCommissionWorkflowSnapshot({
      generatedSnapshot: closure.snapshot,
      previousSnapshot: input.previousSnapshotsByAdvisor?.get(closure.advisor_user_id),
    });
    const snapshot = writeAdvisorCommissionSettlementSnapshot({
      currentSnapshot: snapshotWithWorkflow,
      calculation,
      calculationCutoffAt,
      scheduledLiquidationDate: input.scheduledLiquidationDate,
      carrySource: prior ? priorCarry.source : 'none',
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
    skippedLocked: input.closureId
      ? 0
      : (currentData ?? []).length - currentClosures.length,
  };
}

export async function calculateCommissionPeriodAction(formData: FormData) {
  const periodId = Number(formData.get('periodId') ?? 0);
  const baseCommissionPct = numberValue(formData.get('baseCommissionPct'));
  let result: { updated: number; skippedLocked: number };

  try {
    const { supabase } = await requireCommissionAdmin();
    if (!Number.isInteger(periodId) || periodId <= 0) {
      throw new Error('Selecciona un periodo válido.');
    }
    if (baseCommissionPct < 0 || baseCommissionPct > 100) {
      throw new Error('El porcentaje debe estar entre 0 y 100.');
    }
    const scheduledLiquidationDate = optionalDate(formData.get('scheduledLiquidationDate'));
    const { data: previousClosures, error: previousClosuresError } = await supabase
      .from('advisor_commission_closures')
      .select('advisor_user_id, snapshot')
      .eq('period_id', periodId);

    if (previousClosuresError) throw new Error(previousClosuresError.message);
    const previousSnapshotsByAdvisor = new Map(
      (previousClosures ?? []).map((closure) => [
        String(closure.advisor_user_id),
        closure.snapshot,
      ])
    );

    await generateAdvisorCommissionClosuresAction({
      periodId,
      baseCommissionPct,
    });
    result = await applySettlementToPreliminaryClosures({
      periodId,
      scheduledLiquidationDate,
      previousSnapshotsByAdvisor,
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

function getSnapshotAdvisorName(snapshot: unknown) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return 'Asesor';
  const advisor = (snapshot as Record<string, unknown>).advisor;
  if (!advisor || typeof advisor !== 'object' || Array.isArray(advisor)) return 'Asesor';
  const name = (advisor as Record<string, unknown>).name;
  return typeof name === 'string' && name.trim() ? name.trim() : 'Asesor';
}

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

export async function confirmCommissionClosureAction(formData: FormData) {
  const closureId = Number(formData.get('closureId') ?? 0);
  const periodId = Number(formData.get('periodId') ?? 0);

  try {
    const { supabase, user } = await requireCommissionAdmin();
    if (!Number.isInteger(closureId) || closureId <= 0) {
      throw new Error('Selecciona una liquidación válida.');
    }

    const { data: closure, error: closureError } = await supabase
      .from('advisor_commission_closures')
      .select('id, status, snapshot')
      .eq('id', closureId)
      .single();

    if (closureError || !closure) {
      throw new Error(closureError?.message || 'No se pudo cargar la liquidación.');
    }
    if (closure.status !== 'preliminary' && closure.status !== 'closed') {
      throw new Error('Esta liquidación ya no admite conformidad.');
    }
    const settlement = readAdvisorCommissionSettlementSnapshot(closure.snapshot);
    if (settlement.formulaVersion === 'legacy') {
      throw new Error('Actualiza el cálculo antes de registrar la conformidad.');
    }

    const now = new Date().toISOString();
    const snapshot = confirmAdvisorCommissionWorkflowSnapshot({
      snapshot: closure.snapshot,
      confirmedAt: now,
      recordedByUserId: user.id,
    });
    const payload =
      closure.status === 'preliminary'
        ? {
            snapshot,
            status: 'closed',
            closed_at: now,
            closed_by_user_id: user.id,
            updated_at: now,
          }
        : { snapshot, updated_at: now };
    const { error: updateError } = await supabase
      .from('advisor_commission_closures')
      .update(payload)
      .eq('id', closureId);

    if (updateError) throw new Error(updateError.message);
  } catch (error) {
    redirect(
      `/app/commissions?period=${periodId > 0 ? periodId : ''}&error=${encodeURIComponent(
        actionMessage(error)
      )}`
    );
  }

  revalidatePath('/app/commissions');
  redirect(
    `/app/commissions?period=${periodId > 0 ? periodId : ''}&notice=${encodeURIComponent(
      'Conformidad registrada. La liquidación ya puede recibir abonos.'
    )}`
  );
}

export async function reopenCommissionClosureAction(formData: FormData) {
  const closureId = Number(formData.get('closureId') ?? 0);
  const periodId = Number(formData.get('periodId') ?? 0);

  try {
    const { supabase, user } = await requireCommissionAdmin();
    const reason = requiredText(formData.get('reason'), 'El motivo', 500);
    if (!Number.isInteger(closureId) || closureId <= 0) {
      throw new Error('Selecciona una liquidación válida.');
    }

    const { data: closure, error: closureError } = await supabase
      .from('advisor_commission_closures')
      .select('id, status, snapshot')
      .eq('id', closureId)
      .single();

    if (closureError || !closure) {
      throw new Error(closureError?.message || 'No se pudo cargar la liquidación.');
    }
    if (closure.status !== 'closed') {
      throw new Error('Solo una liquidación conformada puede reabrirse.');
    }

    const payments = await loadConfirmedCommissionPayments(supabase, closureId);
    const paidUsd = roundMoney(
      payments.reduce((sum, payment) => sum + numberValue(payment.amount_usd_equivalent), 0)
    );
    if (paidUsd > 0) {
      throw new Error(
        'La liquidación ya tiene abonos. La corrección ordinaria debe pasar al periodo siguiente.'
      );
    }

    const now = new Date().toISOString();
    const snapshot = reopenAdvisorCommissionWorkflowSnapshot({
      snapshot: closure.snapshot,
      reopenedAt: now,
      reopenedByUserId: user.id,
      reason,
    });
    const { error: updateError } = await supabase
      .from('advisor_commission_closures')
      .update({
        snapshot,
        status: 'preliminary',
        closed_at: null,
        closed_by_user_id: null,
        updated_at: now,
      })
      .eq('id', closureId)
      .eq('status', 'closed');

    if (updateError) throw new Error(updateError.message);
  } catch (error) {
    redirect(
      `/app/commissions?period=${periodId > 0 ? periodId : ''}&error=${encodeURIComponent(
        actionMessage(error)
      )}`
    );
  }

  revalidatePath('/app/commissions');
  redirect(
    `/app/commissions?period=${periodId > 0 ? periodId : ''}&notice=${encodeURIComponent(
      'Liquidación reabierta. Debe recalcularse y recibir una nueva conformidad.'
    )}`
  );
}

export async function registerCommissionPaymentAction(formData: FormData) {
  const closureId = Number(formData.get('closureId') ?? 0);
  const periodId = Number(formData.get('periodId') ?? 0);

  try {
    const { supabase, user } = await requireCommissionAdmin();
    const moneyAccountId = Number(formData.get('moneyAccountId') ?? 0);
    const amountUsd = roundMoney(formData.get('amountUsd'));
    const paidOn = movementDate(formData.get('movementDate'));
    const exchangeRate = numberValue(formData.get('exchangeRateVesPerUsd'));
    const referenceCode = String(formData.get('referenceCode') ?? '').trim() || null;

    if (!Number.isInteger(closureId) || closureId <= 0) {
      throw new Error('Selecciona una liquidación válida.');
    }
    if (!Number.isInteger(moneyAccountId) || moneyAccountId <= 0) {
      throw new Error('Selecciona la cuenta desde la que se pagó.');
    }
    if (amountUsd <= 0) throw new Error('El abono debe ser mayor a cero.');
    if (referenceCode && referenceCode.length > 120) {
      throw new Error('La referencia no puede superar 120 caracteres.');
    }

    const { data: closure, error: closureError } = await supabase
      .from('advisor_commission_closures')
      .select('id, period_id, advisor_user_id, status, payable_usd, snapshot')
      .eq('id', closureId)
      .single();

    if (closureError || !closure) {
      throw new Error(closureError?.message || 'No se pudo cargar la liquidación.');
    }
    if (closure.status !== 'closed') {
      throw new Error('Solo una liquidación conformada puede recibir abonos.');
    }
    if (readAdvisorCommissionWorkflowSnapshot(closure.snapshot).conformity.status !== 'confirmed') {
      throw new Error('Primero debe registrarse la conformidad de la liquidación.');
    }

    const [accountResult, periodResult, existingPayments] = await Promise.all([
      supabase
        .from('money_accounts')
        .select('id, name, currency_code, is_active')
        .eq('id', moneyAccountId)
        .single(),
      supabase
        .from('advisor_commission_periods')
        .select('id, name')
        .eq('id', Number(closure.period_id))
        .single(),
      loadConfirmedCommissionPayments(supabase, closureId),
    ]);

    if (accountResult.error || !accountResult.data) {
      throw new Error(accountResult.error?.message || 'No se pudo cargar la cuenta.');
    }
    if (!accountResult.data.is_active) throw new Error('La cuenta seleccionada está inactiva.');
    if (periodResult.error || !periodResult.data) {
      throw new Error(periodResult.error?.message || 'No se pudo cargar el periodo.');
    }

    const currencyCode = String(accountResult.data.currency_code || '').toUpperCase();
    if (currencyCode !== 'USD' && currencyCode !== 'VES') {
      throw new Error('La moneda de la cuenta no es válida.');
    }
    if (currencyCode === 'VES' && exchangeRate <= 0) {
      throw new Error('Indica la tasa usada para el pago en bolívares.');
    }

    const previouslyPaidUsd = roundMoney(
      existingPayments.reduce(
        (sum, payment) => sum + numberValue(payment.amount_usd_equivalent),
        0
      )
    );
    const payableUsd = roundMoney(closure.payable_usd);
    const remainingUsd = roundMoney(Math.max(0, payableUsd - previouslyPaidUsd));
    if (amountUsd - remainingUsd > 0.005) {
      throw new Error(`El abono supera el saldo pendiente de $${remainingUsd.toFixed(2)}.`);
    }

    const advisorName = getSnapshotAdvisorName(closure.snapshot);
    const nativeAmount =
      currencyCode === 'VES' ? roundMoney(amountUsd * exchangeRate) : amountUsd;
    const description = buildAdvisorCommissionPaymentDescription({
      closureId,
      periodName: String(periodResult.data.name || 'Periodo'),
      advisorName,
    });
    const now = new Date().toISOString();
    const { error: paymentError } = await supabase.from('money_movements').insert({
      movement_date: paidOn,
      created_by_user_id: user.id,
      confirmed_at: now,
      confirmed_by_user_id: user.id,
      status: 'confirmed',
      approval_required: false,
      approval_required_reason: null,
      direction: 'outflow',
      movement_type: 'expense_payment',
      money_account_id: moneyAccountId,
      currency_code: currencyCode,
      amount: nativeAmount,
      exchange_rate_ves_per_usd: currencyCode === 'VES' ? exchangeRate : null,
      amount_usd_equivalent: amountUsd,
      reference_code: referenceCode,
      counterparty_name: advisorName,
      description,
      notes: null,
      order_id: null,
      payment_report_id: null,
      movement_group_id: null,
    });

    if (paymentError) throw new Error(paymentError.message);

    if (remainingUsd - amountUsd <= 0.005) {
      const { error: paidStatusError } = await supabase
        .from('advisor_commission_closures')
        .update({
          status: 'paid',
          paid_at: now,
          paid_by_user_id: user.id,
          updated_at: now,
        })
        .eq('id', closureId)
        .eq('status', 'closed');

      if (paidStatusError) {
        throw new Error(
          `El abono fue registrado, pero no se pudo actualizar el estado: ${paidStatusError.message}`
        );
      }
    }
  } catch (error) {
    redirect(
      `/app/commissions?period=${periodId > 0 ? periodId : ''}&error=${encodeURIComponent(
        actionMessage(error)
      )}`
    );
  }

  revalidatePath('/app/commissions');
  revalidatePath('/app/master/dashboard');
  redirect(
    `/app/commissions?period=${periodId > 0 ? periodId : ''}&notice=${encodeURIComponent(
      'Abono registrado en la liquidación y en la cuenta seleccionada.'
    )}`
  );
}

function dateOnly(value: unknown, label: string) {
  const date = String(value ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`${label} no es válida.`);
  }
  return date;
}

export async function createCommissionPeriodAction(formData: FormData) {
  let createdPeriodId = 0;

  try {
    const { supabase, user } = await requireCommissionAdmin();
    const name = requiredText(formData.get('name'), 'El nombre', 120);
    const dateFrom = dateOnly(formData.get('dateFrom'), 'La fecha inicial');
    const dateTo = dateOnly(formData.get('dateTo'), 'La fecha final');
    const notes = String(formData.get('notes') ?? '').trim() || null;

    if (dateFrom > dateTo) {
      throw new Error('La fecha inicial no puede ser posterior a la fecha final.');
    }
    if (notes && notes.length > 500) {
      throw new Error('La nota no puede superar 500 caracteres.');
    }

    const { data: overlap, error: overlapError } = await supabase
      .from('advisor_commission_periods')
      .select('id, name')
      .lte('date_from', dateTo)
      .gte('date_to', dateFrom)
      .limit(1)
      .maybeSingle();

    if (overlapError) throw new Error(overlapError.message);
    if (overlap) {
      throw new Error(`Las fechas se cruzan con el periodo ${overlap.name}.`);
    }

    const { data, error } = await supabase
      .from('advisor_commission_periods')
      .insert({
        name,
        date_from: dateFrom,
        date_to: dateTo,
        status: 'open',
        notes,
        created_by_user_id: user.id,
      })
      .select('id')
      .single();

    if (error || !data) throw new Error(error?.message || 'No se pudo crear el periodo.');
    createdPeriodId = Number(data.id);
  } catch (error) {
    redirect(`/app/commissions?error=${encodeURIComponent(actionMessage(error))}`);
  }

  revalidatePath('/app/commissions');
  revalidatePath('/app/master/dashboard');
  redirect(
    `/app/commissions?period=${createdPeriodId}&notice=${encodeURIComponent(
      'Periodo creado. Ya puedes generar su cálculo preliminar.'
    )}`
  );
}

async function loadEditableClosure(
  supabase: Awaited<ReturnType<typeof requireCommissionAdmin>>['supabase'],
  closureId: number
) {
  const { data, error } = await supabase
    .from('advisor_commission_closures')
    .select('id, period_id, status, snapshot')
    .eq('id', closureId)
    .single();

  if (error || !data) {
    throw new Error(error?.message || 'No se pudo cargar la liquidación.');
  }
  if (data.status !== 'preliminary') {
    throw new Error('Solo una liquidación preliminar admite cambios en deducibles.');
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

export async function addCommissionDeductionAction(formData: FormData) {
  const closureId = Number(formData.get('closureId') ?? 0);
  const requestedPeriodId = Number(formData.get('periodId') ?? 0);

  try {
    const { supabase, user } = await requireCommissionAdmin();
    const amountUsd = roundMoney(formData.get('amountUsd'));
    const description = requiredText(formData.get('description'), 'El concepto', 240);
    if (!Number.isInteger(closureId) || closureId <= 0) {
      throw new Error('Selecciona una liquidación válida.');
    }
    if (amountUsd <= 0) throw new Error('El deducible debe ser mayor a cero.');

    const closure = await loadEditableClosure(supabase, closureId);
    const { error: insertError } = await supabase
      .from('advisor_commission_deductions')
      .insert({
        closure_id: closureId,
        deduction_type: 'manual_expense',
        description,
        amount_usd: amountUsd,
        created_by_user_id: user.id,
      });

    if (insertError) throw new Error(insertError.message);
    await recalculateEditedClosure({
      closureId,
      periodId: Number(closure.period_id),
      snapshot: closure.snapshot,
    });
  } catch (error) {
    redirect(
      `/app/commissions?period=${requestedPeriodId > 0 ? requestedPeriodId : ''}&error=${encodeURIComponent(
        actionMessage(error)
      )}`
    );
  }

  revalidatePath('/app/commissions');
  redirect(
    `/app/commissions?period=${requestedPeriodId > 0 ? requestedPeriodId : ''}&notice=${encodeURIComponent(
      'Deducible agregado y liquidación actualizada.'
    )}`
  );
}

export async function deleteCommissionDeductionAction(formData: FormData) {
  const closureId = Number(formData.get('closureId') ?? 0);
  const deductionId = Number(formData.get('deductionId') ?? 0);
  const requestedPeriodId = Number(formData.get('periodId') ?? 0);

  try {
    const { supabase } = await requireCommissionAdmin();
    if (
      !Number.isInteger(closureId) ||
      closureId <= 0 ||
      !Number.isInteger(deductionId) ||
      deductionId <= 0
    ) {
      throw new Error('Selecciona un deducible válido.');
    }

    const closure = await loadEditableClosure(supabase, closureId);
    const { data: deleted, error: deleteError } = await supabase
      .from('advisor_commission_deductions')
      .delete()
      .eq('id', deductionId)
      .eq('closure_id', closureId)
      .neq('deduction_type', 'gift')
      .select('id')
      .maybeSingle();

    if (deleteError) throw new Error(deleteError.message);
    if (!deleted) throw new Error('El deducible ya no existe o no puede eliminarse.');
    await recalculateEditedClosure({
      closureId,
      periodId: Number(closure.period_id),
      snapshot: closure.snapshot,
    });
  } catch (error) {
    redirect(
      `/app/commissions?period=${requestedPeriodId > 0 ? requestedPeriodId : ''}&error=${encodeURIComponent(
        actionMessage(error)
      )}`
    );
  }

  revalidatePath('/app/commissions');
  redirect(
    `/app/commissions?period=${requestedPeriodId > 0 ? requestedPeriodId : ''}&notice=${encodeURIComponent(
      'Deducible eliminado y liquidación actualizada.'
    )}`
  );
}
