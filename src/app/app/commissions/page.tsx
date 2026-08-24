import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getAuthContext, resolveHomePath } from '@/lib/auth';
import { adminCommissionAuditHref } from '@/lib/commissions/admin-audit';
import { readAdvisorCommissionCarryOverride } from '@/lib/commissions/carry-state';
import { readAdvisorCommissionSettlementSnapshot } from '@/lib/commissions/closure-snapshot';
import {
  ADVISOR_COMMISSION_BANK_FEE_DESCRIPTION_PREFIX,
  ADVISOR_COMMISSION_PAYMENT_DESCRIPTION_PREFIX,
  getAdvisorCommissionClosureIdFromPaymentDescription,
} from '@/lib/commissions/payment-ledger';
import { readAdvisorCommissionWorkflowSnapshot } from '@/lib/commissions/workflow-snapshot';
import { loadEligibleCommissionAdvisors } from '@/lib/commissions/advisor-eligibility';
import {
  addCommissionDeductionAction,
  calculateCommissionPeriodAction,
  confirmCommissionClosureAction,
  createCommissionPeriodAction,
  deleteCommissionDeductionAction,
  reopenCommissionClosureAction,
  saveCommissionBootstrapAction,
} from './actions';
import CommissionPaymentForm, {
  type CommissionPaymentAccountOption,
} from './CommissionPaymentForm';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

type SearchParams = Promise<{ period?: string; notice?: string; error?: string }>;

type CommissionPeriodRow = {
  id: number | string;
  name: string;
  date_from: string;
  date_to: string;
  status: string;
  notes: string | null;
};

type CommissionDeductionRow = {
  id: number | string;
  deduction_type: string | null;
  description: string | null;
  amount_usd: number | string | null;
};

type CommissionClosureRow = {
  id: number | string;
  advisor_user_id: string;
  status: string;
  base_commission_pct: number | string | null;
  delivered_orders_count: number | string | null;
  billed_usd: number | string | null;
  gross_commission_usd: number | string | null;
  pending_collection_usd: number | string | null;
  gift_deductions_usd: number | string | null;
  manual_deductions_usd: number | string | null;
  payable_usd: number | string | null;
  pending_payment_count: number | string | null;
  generated_at: string | null;
  closed_at: string | null;
  paid_at: string | null;
  snapshot: unknown;
  deductions: CommissionDeductionRow[] | null;
};

type AdvisorProfileRow = {
  user_id: string;
  full_name: string | null;
  is_active: boolean | null;
};

type CommissionPaymentRow = {
  id: number | string;
  movement_date: string;
  created_at: string;
  money_account_id: number | string;
  currency_code: string;
  amount: number | string;
  exchange_rate_ves_per_usd: number | string | null;
  amount_usd_equivalent: number | string;
  reference_code: string | null;
  description: string | null;
  movement_group_id: string | null;
};

type CommissionBankFeeRow = {
  id: number | string;
  movement_group_id: string | null;
  currency_code: string;
  amount: number | string;
  amount_usd_equivalent: number | string;
};

type CommissionPaymentDisplayRow = CommissionPaymentRow & {
  bankFee: CommissionBankFeeRow | null;
};

type MoneyAccountRow = {
  id: number | string;
  name: string;
  currency_code: string;
  is_active: boolean;
};

const COMMISSION_CALCULATION_FORM_ID = 'commission-period-calculation';

function numberValue(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function roundMoney(value: unknown) {
  return Math.round((numberValue(value) + Number.EPSILON) * 100) / 100;
}

function money(value: unknown) {
  return `$${roundMoney(value).toFixed(2)}`;
}

function dateLabel(value: string | null | undefined) {
  if (!value) return 'Sin fecha';
  const parsed = new Date(`${value.slice(0, 10)}T12:00:00-04:00`);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat('es-VE', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(parsed);
}

function caracasToday() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Caracas',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const values = new Map(parts.map((part) => [part.type, part.value]));
  return `${values.get('year')}-${values.get('month')}-${values.get('day')}`;
}

function closureStatus(status: string) {
  if (status === 'paid') {
    return { label: 'Pagada', classes: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300' };
  }
  if (status === 'closed') {
    return { label: 'Cerrada', classes: 'border-amber-400/30 bg-amber-400/10 text-amber-200' };
  }
  return { label: 'Preliminar', classes: 'border-[#383846] bg-[#1B1B24] text-[#C7C7D2]' };
}

function periodStatus(status: string) {
  return status === 'open' ? 'En revisión' : 'Archivado';
}

function getSnapshotAdvisorName(snapshot: unknown) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return null;
  const advisor = (snapshot as Record<string, unknown>).advisor;
  if (!advisor || typeof advisor !== 'object' || Array.isArray(advisor)) return null;
  const name = (advisor as Record<string, unknown>).name;
  return typeof name === 'string' && name.trim() ? name.trim() : null;
}

function Stat({ label, value, note, href }: { label: string; value: string; note?: string; href?: string }) {
  const content = (
    <>
      <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#8F8F9C]">{label}</div>
      <div className="mt-1 text-2xl font-semibold tracking-[-0.04em] text-[#F7F7F8]">{value}</div>
      {note ? <div className="mt-1 text-xs text-[#A4A4AF]">{note}</div> : null}
    </>
  );
  return href ? (
    <Link className="rounded-2xl border border-[#282832] bg-[#15151B] px-4 py-3 transition hover:border-[#F0D000]/55" href={href}>
      {content}
    </Link>
  ) : (
    <div className="rounded-2xl border border-[#282832] bg-[#15151B] px-4 py-3">{content}</div>
  );
}

function CommissionRateField({
  userId,
  value,
  locked,
  compact = false,
  showLockedNote = true,
}: {
  userId: string;
  value: number;
  locked: boolean;
  compact?: boolean;
  showLockedNote?: boolean;
}) {
  if (compact) {
    return (
      <label className="inline-flex items-center gap-2 whitespace-nowrap rounded-xl border border-[#30303A] bg-[#101014] py-1 pl-2.5 pr-1.5">
        <span className="text-[11px] font-medium text-[#A8A8B3]">Porcentaje</span>
        <div className="relative w-16">
          <input
            className="h-7 w-full rounded-lg border border-[#34343F] bg-[#0E0E12] px-2 pr-5 text-xs font-semibold text-[#F7F7F8] outline-none focus:border-[#F0D000] disabled:cursor-not-allowed disabled:opacity-60"
            defaultValue={value}
            disabled={locked}
            form={COMMISSION_CALCULATION_FORM_ID}
            max="100"
            min="0"
            name={`baseCommissionPct:${userId}`}
            required={!locked}
            step="0.01"
            type="number"
          />
          <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-[#8F8F9B]">%</span>
        </div>
        {locked && showLockedNote ? (
          <span className="pr-1 text-[10px] text-[#8F8F9B]">Protegido</span>
        ) : null}
      </label>
    );
  }

  return (
    <label className="block">
      <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#8F8F9B]">
        Porcentaje de comisión
      </span>
      <div className="relative mt-1.5 max-w-40">
        <input
          className="h-9 w-full rounded-xl border border-[#34343F] bg-[#0E0E12] px-3 pr-8 text-sm font-semibold text-[#F7F7F8] outline-none focus:border-[#F0D000] disabled:cursor-not-allowed disabled:opacity-60"
          defaultValue={value}
          disabled={locked}
          form={COMMISSION_CALCULATION_FORM_ID}
          max="100"
          min="0"
          name={`baseCommissionPct:${userId}`}
          required={!locked}
          step="0.01"
          type="number"
        />
        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-[#8F8F9B]">%</span>
      </div>
      {locked && showLockedNote ? (
        <span className="mt-1.5 block text-[10px] text-[#8F8F9B]">Cierre protegido</span>
      ) : null}
    </label>
  );
}

export default async function CommissionAdministrationPage({
  searchParams,
}: {
  searchParams?: SearchParams;
}) {
  const ctx = await getAuthContext();
  if (!ctx) redirect('/login');
  if (!ctx.roles.includes('admin')) redirect(resolveHomePath(ctx.roles));

  const params = (await searchParams) ?? {};
  const periodsResult = await ctx.supabase
    .from('advisor_commission_periods')
    .select('id, name, date_from, date_to, status, notes')
    .order('date_from', { ascending: false })
    .limit(40);

  if (periodsResult.error) {
    return (
      <main className="min-h-screen bg-[#0B0B0D] px-5 py-8 text-[#F7F7F8]">
        <div className="mx-auto max-w-2xl rounded-3xl border border-red-500/25 bg-[#15151B] p-6">
          <div className="text-lg font-semibold">No se pudo abrir Comisiones</div>
          <p className="mt-2 text-sm leading-6 text-[#B5B5C0]">
            Los datos actuales no pudieron cargarse. No se modificó ninguna información.
          </p>
          <Link className="mt-5 inline-flex text-sm font-semibold text-[#F7DA66]" href="/app/master/dashboard">
            Volver al panel administrativo
          </Link>
        </div>
      </main>
    );
  }

  const periods = (periodsResult.data ?? []) as CommissionPeriodRow[];
  const requestedPeriodId = Number(params.period || 0);
  const selectedPeriod =
    periods.find((period) => Number(period.id) === requestedPeriodId) ?? periods[0] ?? null;

  let closures: CommissionClosureRow[] = [];
  let advisorProfiles: AdvisorProfileRow[] = [];
  let advisorNames = new Map<string, string>();
  let moneyAccounts: MoneyAccountRow[] = [];
  let commissionPayments: CommissionPaymentRow[] = [];
  let commissionBankFees: CommissionBankFeeRow[] = [];
  let activeExchangeRate: number | null = null;
  let closureLoadFailed = false;
  let advisorLoadFailed = false;

  if (selectedPeriod) {
    const [
      closuresResult,
      advisorsResult,
      accountsResult,
      paymentsResult,
      bankFeesResult,
      activeRateResult,
    ] = await Promise.all([
      ctx.supabase
        .from('advisor_commission_closures')
        .select(`
          id,
          advisor_user_id,
          status,
          base_commission_pct,
          delivered_orders_count,
          billed_usd,
          gross_commission_usd,
          pending_collection_usd,
          gift_deductions_usd,
          manual_deductions_usd,
          payable_usd,
          pending_payment_count,
          generated_at,
          closed_at,
          paid_at,
          snapshot,
          deductions:advisor_commission_deductions (
            id,
            deduction_type,
            description,
            amount_usd
          )
        `)
        .eq('period_id', Number(selectedPeriod.id))
        .order('generated_at', { ascending: false })
        .limit(100),
      loadEligibleCommissionAdvisors(ctx.supabase)
        .then((data) => ({ data, error: null as Error | null }))
        .catch((error: unknown) => ({
          data: [],
          error: error instanceof Error ? error : new Error('No se pudieron cargar los asesores.'),
        })),
      ctx.supabase
        .from('money_accounts')
        .select('id, name, currency_code, is_active')
        .eq('is_active', true)
        .order('name', { ascending: true }),
      ctx.supabase
        .from('money_movements')
        .select(`
          id,
          movement_date,
          created_at,
          money_account_id,
          currency_code,
          amount,
          exchange_rate_ves_per_usd,
          amount_usd_equivalent,
          reference_code,
          description,
          movement_group_id
        `)
        .eq('direction', 'outflow')
        .eq('movement_type', 'expense_payment')
        .eq('status', 'confirmed')
        .like('description', `${ADVISOR_COMMISSION_PAYMENT_DESCRIPTION_PREFIX}%`)
        .order('created_at', { ascending: false })
        .limit(1000),
      ctx.supabase
        .from('money_movements')
        .select('id, movement_group_id, currency_code, amount, amount_usd_equivalent')
        .eq('direction', 'outflow')
        .eq('movement_type', 'fee_charge')
        .eq('status', 'confirmed')
        .like(
          'description',
          `${ADVISOR_COMMISSION_BANK_FEE_DESCRIPTION_PREFIX}${ADVISOR_COMMISSION_PAYMENT_DESCRIPTION_PREFIX}%`
        )
        .order('created_at', { ascending: false })
        .limit(1000),
      ctx.supabase
        .from('exchange_rates')
        .select('rate_bs_per_usd')
        .eq('is_active', true)
        .limit(1)
        .maybeSingle(),
    ]);

    closureLoadFailed = Boolean(closuresResult.error);
    advisorLoadFailed = Boolean(advisorsResult.error);
    advisorProfiles = advisorsResult.error
      ? []
      : advisorsResult.data.map((advisor) => ({
          user_id: advisor.userId,
          full_name: advisor.fullName,
          is_active: true,
        }));
    const eligibleAdvisorIds = new Set(advisorProfiles.map((advisor) => advisor.user_id));
    closures = closuresResult.error
      ? []
      : ((closuresResult.data ?? []) as CommissionClosureRow[]).filter(
          (closure) =>
            eligibleAdvisorIds.has(String(closure.advisor_user_id)) ||
            closure.status === 'closed' ||
            closure.status === 'paid'
        );
    advisorNames = new Map(
      advisorProfiles.map((advisor) => [
        String(advisor.user_id),
        advisor.full_name?.trim() || 'Asesor',
      ])
    );
    moneyAccounts = accountsResult.error ? [] : ((accountsResult.data ?? []) as MoneyAccountRow[]);
    commissionPayments = paymentsResult.error
      ? []
      : ((paymentsResult.data ?? []) as CommissionPaymentRow[]);
    commissionBankFees = bankFeesResult.error
      ? []
      : ((bankFeesResult.data ?? []) as CommissionBankFeeRow[]);
    activeExchangeRate = activeRateResult.error
      ? null
      : numberValue(activeRateResult.data?.rate_bs_per_usd) || null;
  }

  const bankFeeByMovementGroupId = new Map(
    commissionBankFees
      .filter((fee) => Boolean(fee.movement_group_id))
      .map((fee) => [String(fee.movement_group_id), fee])
  );
  const paymentsByClosureId = new Map<number, CommissionPaymentDisplayRow[]>();
  for (const payment of commissionPayments) {
    const closureId = getAdvisorCommissionClosureIdFromPaymentDescription(payment.description);
    if (!closureId) continue;
    const payments = paymentsByClosureId.get(closureId) ?? [];
    payments.push({
      ...payment,
      bankFee: payment.movement_group_id
        ? bankFeeByMovementGroupId.get(payment.movement_group_id) ?? null
        : null,
    });
    paymentsByClosureId.set(closureId, payments);
  }
  const moneyAccountNameById = new Map(
    moneyAccounts.map((account) => [Number(account.id), account.name])
  );
  const commissionPaymentAccounts = moneyAccounts.flatMap<CommissionPaymentAccountOption>(
    (account) => {
      const currencyCode = String(account.currency_code).toUpperCase();
      if (currencyCode !== 'USD' && currencyCode !== 'VES') return [];
      return [{
        id: Number(account.id),
        name: account.name,
        currencyCode,
      }];
    }
  );

  const rows = closures
    .map((closure) => {
      const deductions = Array.isArray(closure.deductions) ? closure.deductions : [];
      const registeredManualDeductionsUsd = roundMoney(
        deductions
          .filter((deduction) => deduction.deduction_type !== 'gift')
          .reduce((sum, deduction) => sum + numberValue(deduction.amount_usd), 0)
      );
      const storedManualDeductionsUsd = roundMoney(closure.manual_deductions_usd);
      const deductionDifferenceUsd = roundMoney(
        storedManualDeductionsUsd - registeredManualDeductionsUsd
      );
      const settlement = readAdvisorCommissionSettlementSnapshot(closure.snapshot);
      const carryOverride = readAdvisorCommissionCarryOverride(closure.snapshot);
      const workflow = readAdvisorCommissionWorkflowSnapshot(closure.snapshot);
      const payments = paymentsByClosureId.get(Number(closure.id)) ?? [];
      const paidUsd = roundMoney(
        payments.reduce((sum, payment) => sum + numberValue(payment.amount_usd_equivalent), 0)
      );
      const paymentBalanceUsd = roundMoney(
        Math.max(0, numberValue(closure.payable_usd) - paidUsd)
      );

      return {
        closure,
        advisorName:
          advisorNames.get(closure.advisor_user_id) ??
          getSnapshotAdvisorName(closure.snapshot) ??
          'Asesor sin nombre',
        deductions,
        registeredManualDeductionsUsd,
        deductionDifferenceUsd,
        hasDeductionDifference: Math.abs(deductionDifferenceUsd) >= 0.01,
        settlement,
        carryOverride,
        workflow,
        payments,
        paidUsd,
        paymentBalanceUsd,
      };
    })
    .sort((left, right) => left.advisorName.localeCompare(right.advisorName, 'es'));
  const closureByAdvisorId = new Map(
    closures.map((closure) => [String(closure.advisor_user_id), closure])
  );
  const commissionRateAdvisors = advisorProfiles
    .filter((advisor) => Boolean(advisor.is_active ?? true))
    .map((advisor) => {
      const userId = String(advisor.user_id);
      const closure = closureByAdvisorId.get(userId) ?? null;
      return {
        userId,
        name: advisor.full_name?.trim() || 'Asesor',
        closure,
        isLocked: closure?.status === 'closed' || closure?.status === 'paid',
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name, 'es'));
  const hasEditableCommissionRate = commissionRateAdvisors.some((advisor) => !advisor.isLocked);
  const advisorsWithoutClosure = commissionRateAdvisors.filter((advisor) => !advisor.closure);

  const totals = rows.reduce(
    (result, row) => {
      result.billedUsd += numberValue(row.closure.billed_usd);
      result.grossCommissionUsd += numberValue(row.closure.gross_commission_usd);
      result.pendingCollectionUsd += numberValue(row.closure.pending_collection_usd);
      result.payableUsd += numberValue(row.closure.payable_usd);
      result.paidUsd += row.paidUsd;
      result.paymentBalanceUsd += row.paymentBalanceUsd;
      result.retainedCommissionUsd += row.settlement.retainedCommissionUsd;
      result.deductionsUsd +=
        numberValue(row.closure.gift_deductions_usd) + row.registeredManualDeductionsUsd;
      if (row.hasDeductionDifference) result.differences += 1;
      return result;
    },
    {
      billedUsd: 0,
      grossCommissionUsd: 0,
      pendingCollectionUsd: 0,
      payableUsd: 0,
      paidUsd: 0,
      paymentBalanceUsd: 0,
      retainedCommissionUsd: 0,
      deductionsUsd: 0,
      differences: 0,
    }
  );

  return (
    <main className="min-h-screen bg-[#0B0B0D] text-[#F7F7F8]">
      <header className="border-b border-[#24242D] bg-[#101014]">
        <div className="mx-auto flex max-w-[1400px] flex-col gap-4 px-5 py-5 md:flex-row md:items-center md:justify-between">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-semibold tracking-[-0.04em]">Comisiones</h1>
              <span className="rounded-full border border-[#363641] bg-[#18181F] px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-[#BDBDC7]">
                Administración
              </span>
            </div>
            <p className="mt-1 text-sm text-[#A9A9B4]">
              Cierres, cobranza, deducibles y liquidación por asesor.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link
              className="inline-flex w-fit items-center rounded-full border border-[#F0D000]/45 bg-[#F0D000]/10 px-4 py-2 text-sm font-semibold text-[#F7DA66] transition hover:border-[#F0D000]"
              href={`/app/commissions/goals${selectedPeriod ? `?period=${selectedPeriod.id}` : ''}`}
            >
              Metas y porcentajes
            </Link>
            <Link
              className="inline-flex w-fit items-center rounded-full border border-[#34343F] px-4 py-2 text-sm font-semibold text-[#D8D8DF] transition hover:border-[#F0D000] hover:text-[#F7DA66]"
              href="/app/master/dashboard"
            >
              Volver al panel
            </Link>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-[1400px] space-y-5 px-5 py-6">
        {params.notice ? (
          <div className="rounded-2xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-100">
            {params.notice}
          </div>
        ) : null}
        {params.error ? (
          <div className="rounded-2xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-100">
            {params.error}
          </div>
        ) : null}

        <section className="rounded-3xl border border-[#25252E] bg-[#121217] p-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="text-sm font-semibold">Periodo de trabajo</div>
              <div className="mt-1 text-xs leading-5 text-[#9999A5]">
                Esta vista reúne los cierres y deducibles ya registrados, sin duplicar información.
              </div>
            </div>
            {selectedPeriod ? (
              <span className="shrink-0 rounded-full border border-[#34343F] bg-[#1A1A21] px-3 py-1 text-xs text-[#C9C9D1]">
                {periodStatus(selectedPeriod.status)}
              </span>
            ) : null}
          </div>

          <details className="mt-4 rounded-2xl border border-[#30303A] bg-[#101014] px-4 py-3">
            <summary className="cursor-pointer text-xs font-semibold text-[#C9C9D1]">
              Crear otro periodo
            </summary>
            <form action={createCommissionPeriodAction} className="mt-3 grid gap-3 border-t border-[#292933] pt-3 md:grid-cols-2 xl:grid-cols-[1fr_150px_150px_1fr_auto] xl:items-end">
              <label className="block">
                <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#8F8F9B]">Nombre</span>
                <input
                  className="mt-1 h-10 w-full rounded-xl border border-[#32323D] bg-[#0E0E12] px-3 text-sm text-[#F7F7F8] outline-none focus:border-[#F0D000]"
                  maxLength={120}
                  name="name"
                  placeholder="Ej. Agosto 1"
                  required
                />
              </label>
              <label className="block">
                <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#8F8F9B]">Desde</span>
                <input
                  className="mt-1 h-10 w-full rounded-xl border border-[#32323D] bg-[#0E0E12] px-3 text-sm text-[#F7F7F8] outline-none focus:border-[#F0D000]"
                  name="dateFrom"
                  required
                  type="date"
                />
              </label>
              <label className="block">
                <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#8F8F9B]">Hasta</span>
                <input
                  className="mt-1 h-10 w-full rounded-xl border border-[#32323D] bg-[#0E0E12] px-3 text-sm text-[#F7F7F8] outline-none focus:border-[#F0D000]"
                  name="dateTo"
                  required
                  type="date"
                />
              </label>
              <label className="block">
                <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#8F8F9B]">Nota</span>
                <input
                  className="mt-1 h-10 w-full rounded-xl border border-[#32323D] bg-[#0E0E12] px-3 text-sm text-[#F7F7F8] outline-none focus:border-[#F0D000]"
                  maxLength={500}
                  name="notes"
                  placeholder="Opcional"
                />
              </label>
              <button className="h-10 rounded-xl border border-[#F0D000]/45 px-4 text-sm font-semibold text-[#F7DA66]" type="submit">
                Crear periodo
              </button>
            </form>
          </details>

          {periods.length > 0 ? (
            <div className="mt-4 flex gap-2 overflow-x-auto pb-1">
              {periods.map((period) => {
                const active = Number(period.id) === Number(selectedPeriod?.id);
                return (
                  <Link
                    key={period.id}
                    aria-current={active ? 'page' : undefined}
                    className={[
                      'shrink-0 rounded-full border px-3 py-2 text-xs font-semibold transition',
                      active
                        ? 'border-[#F0D000] bg-[#F0D000] text-[#111113]'
                        : 'border-[#30303A] bg-[#18181E] text-[#B7B7C1] hover:border-[#6A6140] hover:text-[#F7DA66]',
                    ].join(' ')}
                    href={`/app/commissions?period=${period.id}`}
                  >
                    {period.name}
                  </Link>
                );
              })}
            </div>
          ) : (
            <div className="mt-4 rounded-2xl border border-dashed border-[#363641] px-4 py-8 text-center text-sm text-[#A6A6B0]">
              Aún no hay periodos de comisión registrados.
            </div>
          )}

          {selectedPeriod ? (
            <div className="mt-4 flex flex-wrap gap-x-5 gap-y-1 border-t border-[#24242D] pt-3 text-xs text-[#9797A3]">
              <span>
                Del {dateLabel(selectedPeriod.date_from)} al {dateLabel(selectedPeriod.date_to)}
              </span>
              {selectedPeriod.notes ? <span>{selectedPeriod.notes}</span> : null}
            </div>
          ) : null}

          {selectedPeriod ? (
            <form
              action={calculateCommissionPeriodAction}
              className="mt-4 grid gap-3 border-t border-[#24242D] pt-4 md:grid-cols-[190px_1fr_auto] md:items-end"
              id={COMMISSION_CALCULATION_FORM_ID}
            >
              <input name="periodId" type="hidden" value={selectedPeriod.id} />
              <label className="block">
                <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#8F8F9B]">
                  Fecha prevista de pago
                </span>
                <input
                  className="mt-1 h-10 w-full rounded-xl border border-[#32323D] bg-[#0E0E12] px-3 text-sm text-[#F7F7F8] outline-none focus:border-[#F0D000]"
                  defaultValue={rows.find((row) => row.settlement.scheduledLiquidationDate)?.settlement.scheduledLiquidationDate ?? ''}
                  name="scheduledLiquidationDate"
                  type="date"
                />
              </label>
              <p className="text-xs leading-5 text-[#92929E]">
                Ajusta el porcentaje dentro de la tarjeta de cada asesor y luego actualiza el periodo. Los cierres confirmados permanecen protegidos.
              </p>
              <button
                className="h-10 rounded-xl bg-[#F0D000] px-5 text-sm font-semibold text-[#111113] transition enabled:hover:bg-[#FFE44F] disabled:cursor-not-allowed disabled:opacity-40"
                disabled={
                  selectedPeriod.status !== 'open' ||
                  advisorLoadFailed ||
                  !hasEditableCommissionRate
                }
                type="submit"
              >
                Calcular / actualizar
              </button>
            </form>
          ) : null}
        </section>

        {closureLoadFailed ? (
          <section className="rounded-3xl border border-red-500/25 bg-red-500/5 p-5 text-sm text-red-100">
            No se pudieron cargar los cierres del periodo. No se modificó ninguna información.
          </section>
        ) : selectedPeriod && rows.length === 0 ? (
          <section className="rounded-3xl border border-[#2B2B35] bg-[#121217] p-5">
            <div>
              <h2 className="text-lg font-semibold tracking-[-0.02em]">Preparar relación por asesor</h2>
              <p className="mt-1 text-sm leading-6 text-[#A6A6B0]">
                Define el porcentaje individual en cada tarjeta y utiliza “Calcular / actualizar” para generar los preliminares.
              </p>
            </div>
            {advisorLoadFailed ? (
              <div className="mt-4 rounded-2xl border border-red-500/25 bg-red-500/5 px-4 py-3 text-sm text-red-100">
                No se pudieron cargar los asesores activos. El cálculo permanece bloqueado para evitar porcentajes incorrectos.
              </div>
            ) : commissionRateAdvisors.length > 0 ? (
              <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
                {commissionRateAdvisors.map((advisor) => (
                  <article key={advisor.userId} className="rounded-2xl border border-[#32323D] bg-[#15151B] p-4">
                    <h3 className="truncate text-sm font-semibold text-[#F0F0F3]" title={advisor.name}>{advisor.name}</h3>
                    <div className="mt-3 border-t border-[#292933] pt-3">
                      <CommissionRateField
                        locked={advisor.isLocked || selectedPeriod.status !== 'open'}
                        userId={advisor.userId}
                        value={advisor.closure?.base_commission_pct == null ? 8 : numberValue(advisor.closure.base_commission_pct)}
                      />
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <div className="mt-4 rounded-2xl border border-dashed border-[#363641] px-4 py-8 text-center text-sm text-[#A6A6B0]">
                No hay asesores activos disponibles para calcular.
              </div>
            )}
          </section>
        ) : rows.length > 0 ? (
          <>
            <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
              <Stat label="Asesores" value={String(rows.length)} note="Ver cierres del periodo" href="#advisor-closures" />
              <Stat label="Facturación entregada" value={money(totals.billedUsd)} note="Desglosada abajo por asesor" href="#advisor-closures" />
              <Stat label="Comisión bruta" value={money(totals.grossCommissionUsd)} note="Desglosada abajo por asesor" href="#advisor-closures" />
              <Stat label="Deducibles" value={money(totals.deductionsUsd)} note="Obsequios y cargos por asesor" href="#advisor-closures" />
              <Stat label="Comisión retenida" value={money(totals.retainedCommissionUsd)} note="Arrastre detallado por asesor" href="#advisor-closures" />
              <Stat label="Saldo por pagar" value={money(totals.paymentBalanceUsd)} note={`${money(totals.paidUsd)} ya abonados · ver relación`} href="#advisor-closures" />
            </section>

            {totals.differences > 0 ? (
              <section className="rounded-3xl border border-amber-400/30 bg-amber-400/5 p-5">
                <div className="text-sm font-semibold text-amber-100">
                  {totals.differences} {totals.differences === 1 ? 'cierre requiere' : 'cierres requieren'} revisión de deducibles
                </div>
                <p className="mt-1 text-sm leading-6 text-[#C7BEA4]">
                  El total guardado no coincide con la suma de los cargos registrados. La diferencia se muestra en el asesor correspondiente.
                </p>
              </section>
            ) : null}

            <section id="advisor-closures" className="scroll-mt-5 space-y-3">
              <div>
                <h2 className="text-lg font-semibold tracking-[-0.02em]">Relación por asesor</h2>
                <p className="mt-1 text-sm text-[#9696A2]">Una sola lectura compacta por cada liquidación.</p>
              </div>

              {advisorsWithoutClosure.length > 0 ? (
                <div className="rounded-3xl border border-dashed border-[#3A3A45] bg-[#111116] p-4">
                  <div className="text-sm font-semibold">Asesores pendientes de incorporar al periodo</div>
                  <p className="mt-1 text-xs leading-5 text-[#9696A2]">
                    Define su porcentaje antes de actualizar; su tarjeta completa aparecerá al generarse el cierre.
                  </p>
                  <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
                    {advisorsWithoutClosure.map((advisor) => (
                      <article key={advisor.userId} className="rounded-2xl border border-[#32323D] bg-[#15151B] p-4">
                        <h3 className="truncate text-sm font-semibold text-[#F0F0F3]" title={advisor.name}>{advisor.name}</h3>
                        <div className="mt-3 border-t border-[#292933] pt-3">
                          <CommissionRateField
                            locked={selectedPeriod?.status !== 'open'}
                            userId={advisor.userId}
                            value={8}
                          />
                        </div>
                      </article>
                    ))}
                  </div>
                </div>
              ) : null}

              <div className="grid gap-3 xl:grid-cols-2">
                {rows.map((row) => {
                  const status = closureStatus(row.closure.status);
                  const settlementIsCurrent = row.settlement.formulaVersion !== 'legacy';
                  const conformityStatus = row.workflow.conformity.status;
                  return (
                    <article key={row.closure.id} className="rounded-3xl border border-[#282832] bg-[#141419] p-5">
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                            <h3 className="text-lg font-semibold tracking-[-0.02em]">{row.advisorName}</h3>
                            <CommissionRateField
                              compact
                              locked={row.closure.status !== 'preliminary' || selectedPeriod?.status !== 'open'}
                              userId={row.closure.advisor_user_id}
                              value={numberValue(row.closure.base_commission_pct)}
                            />
                          </div>
                          <div className="mt-1 text-xs text-[#92929E]">
                            {numberValue(row.closure.delivered_orders_count)} pedidos entregados
                          </div>
                          <Link
                            className="mt-3 inline-flex items-center gap-2 rounded-full border border-[#F0D000]/40 px-3 py-1.5 text-xs font-semibold text-[#F7DA66] transition hover:border-[#F0D000]"
                            href={adminCommissionAuditHref(row.closure.id, 'settlement')}
                          >
                            Auditar cierre completo <span aria-hidden="true">→</span>
                          </Link>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <span className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold ${status.classes}`}>
                            {status.label}
                          </span>
                          <span className="rounded-full border border-[#34343F] bg-[#1A1A21] px-2.5 py-1 text-[11px] text-[#AFAFBA]">
                            {settlementIsCurrent ? 'Cálculo nuevo' : 'Cierre existente'}
                          </span>
                          {conformityStatus === 'confirmed' ? (
                            <span className="rounded-full border border-sky-400/30 bg-sky-400/10 px-2.5 py-1 text-[11px] text-sky-200">
                              Conforme
                            </span>
                          ) : conformityStatus === 'requires_reconfirmation' ? (
                            <span className="rounded-full border border-orange-400/30 bg-orange-400/10 px-2.5 py-1 text-[11px] text-orange-200">
                              Requiere nueva conformidad
                            </span>
                          ) : null}
                        </div>
                      </div>

                      <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 border-y border-[#272730] py-4 sm:grid-cols-3">
                        <Link className="rounded-xl p-2 transition hover:bg-[#1C1C24]" href={adminCommissionAuditHref(row.closure.id, 'billing')}>
                          <div className="text-[10px] uppercase tracking-[0.14em] text-[#858591]">Facturación</div>
                          <div className="mt-1 font-semibold">{money(row.closure.billed_usd)}</div>
                          <div className="mt-1 text-[10px] font-semibold text-[#F7DA66]">Ver pedidos →</div>
                        </Link>
                        <Link className="rounded-xl p-2 transition hover:bg-[#1C1C24]" href={adminCommissionAuditHref(row.closure.id, 'commission')}>
                          <div className="text-[10px] uppercase tracking-[0.14em] text-[#858591]">Comisión bruta</div>
                          <div className="mt-1 font-semibold">{money(row.closure.gross_commission_usd)}</div>
                          <div className="mt-1 text-[10px] font-semibold text-[#F7DA66]">Ver fórmula →</div>
                        </Link>
                        <Link className="rounded-xl p-2 transition hover:bg-[#1C1C24]" href={adminCommissionAuditHref(row.closure.id, 'deductions')}>
                          <div className="text-[10px] uppercase tracking-[0.14em] text-[#858591]">Deducibles</div>
                          <div className="mt-1 font-semibold">
                            {money(numberValue(row.closure.gift_deductions_usd) + row.registeredManualDeductionsUsd)}
                          </div>
                          <div className="mt-1 text-[10px] font-semibold text-[#F7DA66]">Ver cargos →</div>
                        </Link>
                        <Link className="rounded-xl p-2 transition hover:bg-[#1C1C24]" href={adminCommissionAuditHref(row.closure.id, 'debts')}>
                          <div className="text-[10px] uppercase tracking-[0.14em] text-[#858591]">Deuda clientes</div>
                          <div className="mt-1 font-semibold text-amber-200">{money(row.closure.pending_collection_usd)}</div>
                          <div className="mt-1 text-[10px] font-semibold text-[#F7DA66]">Ver clientes →</div>
                        </Link>
                        <Link className="rounded-xl p-2 transition hover:bg-[#1C1C24]" href={adminCommissionAuditHref(row.closure.id, 'settlement')}>
                          <div className="text-[10px] uppercase tracking-[0.14em] text-[#858591]">Liquidación acordada</div>
                          <div className="mt-1 font-semibold text-[#F7DA66]">{money(row.closure.payable_usd)}</div>
                          <div className="mt-1 text-[10px] font-semibold text-[#F7DA66]">Ver cálculo →</div>
                        </Link>
                        <Link className="rounded-xl p-2 transition hover:bg-[#1C1C24]" href={adminCommissionAuditHref(row.closure.id, 'payments')}>
                          <div className="text-[10px] uppercase tracking-[0.14em] text-[#858591]">Pagado / pendiente</div>
                          <div className="mt-1 font-semibold">
                            {money(row.paidUsd)} <span className="text-[#777784]">/</span>{' '}
                            <span className="text-[#F7DA66]">{money(row.paymentBalanceUsd)}</span>
                          </div>
                          <div className="mt-1 text-[10px] font-semibold text-[#F7DA66]">Ver abonos →</div>
                        </Link>
                      </div>

                      {settlementIsCurrent ? (
                        <div className="mt-4 grid gap-2 rounded-2xl border border-[#2D2D37] bg-[#101014] p-3 text-xs sm:grid-cols-3">
                          <div>
                            <span className="text-[#8F8F9B]">Comisión arrastrada</span>
                            <div className="mt-1 font-semibold">{money(row.settlement.carriedCommissionUsd)}</div>
                          </div>
                          <div>
                            <span className="text-[#8F8F9B]">Retenida para próximo periodo</span>
                            <div className="mt-1 font-semibold">{money(row.settlement.retainedCommissionUsd)}</div>
                          </div>
                          <div>
                            <span className="text-[#8F8F9B]">Deuda propia arrastrada</span>
                            <div className="mt-1 font-semibold">{money(row.settlement.advisorDebtOutUsd)}</div>
                          </div>
                          {row.settlement.carrySource === 'legacy-inferred' ? (
                            <div className="rounded-xl border border-amber-400/25 bg-amber-400/5 px-3 py-2 text-amber-100 sm:col-span-3">
                              Arrastre histórico inferido desde datos anteriores. Revísalo antes de registrar la conformidad.
                            </div>
                          ) : row.settlement.carrySource === 'manual-bootstrap' ? (
                            <div className="rounded-xl border border-emerald-400/25 bg-emerald-400/5 px-3 py-2 text-emerald-100 sm:col-span-3">
                              Saldo inicial histórico fijado manualmente a partir de la auditoría.
                            </div>
                          ) : null}
                        </div>
                      ) : null}

                      {row.hasDeductionDifference ? (
                        <div className="mt-4 rounded-2xl border border-amber-400/30 bg-amber-400/5 p-3 text-xs leading-5 text-amber-100">
                          Diferencia por revisar: el cierre guarda {money(row.closure.manual_deductions_usd)}, pero sus cargos suman{' '}
                          {money(row.registeredManualDeductionsUsd)}.
                        </div>
                      ) : null}

                      {row.deductions.length > 0 ? (
                        <details className="mt-4 rounded-2xl border border-[#2D2D37] bg-[#111116] px-4 py-3">
                          <summary className="cursor-pointer text-xs font-semibold text-[#C9C9D1]">
                            Ver {row.deductions.length} {row.deductions.length === 1 ? 'deducible' : 'deducibles'} registrados
                          </summary>
                          <div className="mt-3 space-y-2 border-t border-[#292933] pt-3">
                            {row.deductions.map((deduction) => (
                              <div key={deduction.id} className="flex items-start justify-between gap-4 text-xs">
                                <span className="text-[#AAAAAF]">{deduction.description || 'Sin concepto'}</span>
                                <div className="flex shrink-0 items-center gap-2">
                                  <span className="font-semibold text-[#E4E4E8]">{money(deduction.amount_usd)}</span>
                                  {row.closure.status === 'preliminary' && deduction.deduction_type !== 'gift' ? (
                                    <form action={deleteCommissionDeductionAction}>
                                      <input name="closureId" type="hidden" value={row.closure.id} />
                                      <input name="deductionId" type="hidden" value={deduction.id} />
                                      <input name="periodId" type="hidden" value={selectedPeriod?.id ?? ''} />
                                      <button className="rounded-full border border-red-400/25 px-2 py-0.5 text-[10px] text-red-200" type="submit">
                                        Quitar
                                      </button>
                                    </form>
                                  ) : null}
                                </div>
                              </div>
                            ))}
                          </div>
                        </details>
                      ) : null}

                      {row.closure.status === 'preliminary' ? (
                        <details className="mt-4 rounded-2xl border border-[#2D2D37] bg-[#111116] px-4 py-3">
                          <summary className="cursor-pointer text-xs font-semibold text-[#C9C9D1]">
                            Agregar deducible extraordinario
                          </summary>
                          <form action={addCommissionDeductionAction} className="mt-3 grid gap-3 border-t border-[#292933] pt-3 sm:grid-cols-[1fr_120px_auto] sm:items-end">
                            <input name="closureId" type="hidden" value={row.closure.id} />
                            <input name="periodId" type="hidden" value={selectedPeriod?.id ?? ''} />
                            <label className="block">
                              <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#8F8F9B]">Concepto</span>
                              <input
                                className="mt-1 h-9 w-full rounded-xl border border-[#32323D] bg-[#0E0E12] px-3 text-xs text-[#F7F7F8] outline-none focus:border-[#F0D000]"
                                maxLength={240}
                                name="description"
                                placeholder="Pedido, préstamo, adelanto…"
                                required
                              />
                            </label>
                            <label className="block">
                              <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#8F8F9B]">Monto USD</span>
                              <input
                                className="mt-1 h-9 w-full rounded-xl border border-[#32323D] bg-[#0E0E12] px-3 text-xs text-[#F7F7F8] outline-none focus:border-[#F0D000]"
                                min="0.01"
                                name="amountUsd"
                                required
                                step="0.01"
                                type="number"
                              />
                            </label>
                            <button className="h-9 rounded-xl border border-[#F0D000]/45 px-4 text-xs font-semibold text-[#F7DA66]" type="submit">
                              Agregar
                            </button>
                          </form>
                        </details>
                      ) : null}

                      {row.closure.status === 'preliminary' &&
                      (!settlementIsCurrent ||
                        row.settlement.carrySource === 'legacy-inferred' ||
                        row.settlement.carrySource === 'manual-bootstrap') ? (
                        <details className="mt-4 rounded-2xl border border-amber-400/20 bg-amber-400/5 px-4 py-3">
                          <summary className="cursor-pointer text-xs font-semibold text-amber-100">
                            Definir saldo inicial histórico auditado
                          </summary>
                          <p className="mt-3 border-t border-amber-400/15 pt-3 text-xs leading-5 text-[#B9B19C]">
                            Úsalo solo para el arranque con periodos anteriores. Los periodos nuevos arrastran este saldo automáticamente.
                          </p>
                          <form action={saveCommissionBootstrapAction} className="mt-3 grid gap-3 sm:grid-cols-2">
                            <input name="closureId" type="hidden" value={row.closure.id} />
                            <input name="periodId" type="hidden" value={selectedPeriod?.id ?? ''} />
                            <label className="block">
                              <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#9F967E]">Comisión a favor</span>
                              <input
                                className="mt-1 h-9 w-full rounded-xl border border-[#4A4330] bg-[#0E0E12] px-3 text-xs text-[#F7F7F8] outline-none focus:border-amber-400"
                                defaultValue={(row.carryOverride?.commissionCarryUsd ?? row.settlement.carriedCommissionUsd).toFixed(2)}
                                min="0"
                                name="commissionCarryUsd"
                                required
                                step="0.01"
                                type="number"
                              />
                            </label>
                            <label className="block">
                              <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#9F967E]">Deuda propia anterior</span>
                              <input
                                className="mt-1 h-9 w-full rounded-xl border border-[#4A4330] bg-[#0E0E12] px-3 text-xs text-[#F7F7F8] outline-none focus:border-amber-400"
                                defaultValue={(row.carryOverride?.advisorDebtCarryUsd ?? row.settlement.priorAdvisorDebtUsd).toFixed(2)}
                                min="0"
                                name="advisorDebtCarryUsd"
                                required
                                step="0.01"
                                type="number"
                              />
                            </label>
                            <label className="block sm:col-span-2">
                              <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#9F967E]">Referencia de auditoría</span>
                              <input
                                className="mt-1 h-9 w-full rounded-xl border border-[#4A4330] bg-[#0E0E12] px-3 text-xs text-[#F7F7F8] outline-none focus:border-amber-400"
                                defaultValue={row.carryOverride?.note ?? ''}
                                maxLength={500}
                                name="note"
                                placeholder="Ej. Saldo validado contra cierre de Julio 1"
                                required
                              />
                            </label>
                            <button className="h-9 rounded-xl border border-amber-400/35 px-4 text-xs font-semibold text-amber-100 sm:col-span-2" type="submit">
                              Guardar saldo inicial y recalcular
                            </button>
                          </form>
                        </details>
                      ) : null}

                      {row.payments.length > 0 ? (
                        <details className="mt-4 rounded-2xl border border-[#2D2D37] bg-[#111116] px-4 py-3">
                          <summary className="cursor-pointer text-xs font-semibold text-[#C9C9D1]">
                            Ver {row.payments.length} {row.payments.length === 1 ? 'abono' : 'abonos'} · {money(row.paidUsd)}
                          </summary>
                          <div className="mt-3 space-y-3 border-t border-[#292933] pt-3">
                            {row.payments.map((payment, index) => (
                              <div key={payment.id} className="flex items-start justify-between gap-4 text-xs">
                                <div className="text-[#AAAAAF]">
                                  <div className="font-semibold text-[#D8D8DE]">Abono {row.payments.length - index}</div>
                                  <div className="mt-1">
                                    {dateLabel(payment.movement_date)} ·{' '}
                                    {moneyAccountNameById.get(Number(payment.money_account_id)) || 'Cuenta'}
                                  </div>
                                  {payment.currency_code === 'VES' ? (
                                    <div className="mt-1">
                                      Bs. {numberValue(payment.amount).toFixed(2)} · Tasa{' '}
                                      {numberValue(payment.exchange_rate_ves_per_usd).toFixed(2)}
                                    </div>
                                  ) : null}
                                  {payment.bankFee ? (
                                    <div className="mt-1 text-amber-200/80">
                                      Comisión bancaria:{' '}
                                      {payment.bankFee.currency_code === 'VES'
                                        ? `Bs. ${numberValue(payment.bankFee.amount).toFixed(2)}`
                                        : money(payment.bankFee.amount)}
                                    </div>
                                  ) : null}
                                  {payment.reference_code ? (
                                    <div className="mt-1">Ref. {payment.reference_code}</div>
                                  ) : null}
                                </div>
                                <span className="shrink-0 font-semibold text-emerald-300">
                                  {money(payment.amount_usd_equivalent)}
                                </span>
                              </div>
                            ))}
                          </div>
                        </details>
                      ) : null}

                      {row.closure.status === 'preliminary' && settlementIsCurrent ? (
                        <form action={confirmCommissionClosureAction} className="mt-4">
                          <input name="closureId" type="hidden" value={row.closure.id} />
                          <input name="periodId" type="hidden" value={selectedPeriod?.id ?? ''} />
                          <button
                            className="h-10 w-full rounded-xl border border-sky-400/35 bg-sky-400/10 px-4 text-sm font-semibold text-sky-100 transition hover:bg-sky-400/15"
                            type="submit"
                          >
                            Registrar conformidad recibida
                          </button>
                          <p className="mt-2 text-center text-[11px] leading-4 text-[#898995]">
                            Administración registra aquí la conformidad comunicada por el asesor.
                          </p>
                        </form>
                      ) : null}

                      {row.closure.status === 'closed' && conformityStatus !== 'confirmed' && settlementIsCurrent ? (
                        <form action={confirmCommissionClosureAction} className="mt-4">
                          <input name="closureId" type="hidden" value={row.closure.id} />
                          <input name="periodId" type="hidden" value={selectedPeriod?.id ?? ''} />
                          <button
                            className="h-10 w-full rounded-xl border border-sky-400/35 bg-sky-400/10 px-4 text-sm font-semibold text-sky-100 transition hover:bg-sky-400/15"
                            type="submit"
                          >
                            Completar registro de conformidad
                          </button>
                        </form>
                      ) : null}

                      {row.closure.status === 'closed' && conformityStatus === 'confirmed' && row.paymentBalanceUsd > 0 ? (
                        <div className="mt-4 rounded-2xl border border-[#34343F] bg-[#101014] p-4">
                          <div className="text-sm font-semibold">Registrar abono</div>
                          <p className="mt-1 text-xs text-[#92929E]">
                            Saldo pendiente: {money(row.paymentBalanceUsd)}. Verás el equivalente en bolívares antes de confirmar.
                          </p>
                          <CommissionPaymentForm
                            accounts={commissionPaymentAccounts}
                            activeRate={activeExchangeRate}
                            closureId={Number(row.closure.id)}
                            defaultDate={caracasToday()}
                            paymentBalanceUsd={row.paymentBalanceUsd}
                            periodId={Number(selectedPeriod?.id ?? 0)}
                          />
                        </div>
                      ) : null}

                      {row.closure.status === 'closed' ? (
                        row.paidUsd <= 0 ? (
                          <details className="mt-4 rounded-2xl border border-[#2D2D37] bg-[#111116] px-4 py-3">
                            <summary className="cursor-pointer text-xs font-semibold text-[#AFAFBA]">
                              Corregir liquidación excepcionalmente
                            </summary>
                            <form action={reopenCommissionClosureAction} className="mt-3 border-t border-[#292933] pt-3">
                              <input name="closureId" type="hidden" value={row.closure.id} />
                              <input name="periodId" type="hidden" value={selectedPeriod?.id ?? ''} />
                              <label className="block">
                                <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#8F8F9B]">Motivo de la corrección</span>
                                <textarea
                                  className="mt-1 min-h-20 w-full rounded-xl border border-[#32323D] bg-[#0E0E12] px-3 py-2 text-sm text-[#F7F7F8] outline-none focus:border-orange-400"
                                  maxLength={500}
                                  name="reason"
                                  required
                                />
                              </label>
                              <button
                                className="mt-3 h-9 w-full rounded-xl border border-orange-400/35 bg-orange-400/10 px-4 text-xs font-semibold text-orange-100"
                                type="submit"
                              >
                                Reabrir y exigir nueva conformidad
                              </button>
                            </form>
                          </details>
                        ) : (
                          <p className="mt-4 rounded-2xl border border-[#2D2D37] bg-[#111116] px-4 py-3 text-xs leading-5 text-[#9696A2]">
                            Como ya existen abonos, cualquier ajuste ordinario debe registrarse en el periodo siguiente.
                          </p>
                        )
                      ) : null}
                    </article>
                  );
                })}
              </div>
            </section>
          </>
        ) : null}
      </div>
    </main>
  );
}
