import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getAuthContext, resolveHomePath } from '@/lib/auth';
import { readAdvisorCommissionSettlementSnapshot } from '@/lib/commissions/closure-snapshot';
import {
  ADVISOR_COMMISSION_PAYMENT_DESCRIPTION_PREFIX,
  getAdvisorCommissionClosureIdFromPaymentDescription,
} from '@/lib/commissions/payment-ledger';
import { readAdvisorCommissionWorkflowSnapshot } from '@/lib/commissions/workflow-snapshot';
import {
  calculateCommissionPeriodAction,
  confirmCommissionClosureAction,
  registerCommissionPaymentAction,
  reopenCommissionClosureAction,
} from './actions';

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
};

type MoneyAccountRow = {
  id: number | string;
  name: string;
  currency_code: string;
  is_active: boolean;
};

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

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="rounded-2xl border border-[#282832] bg-[#15151B] px-4 py-3">
      <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#8F8F9C]">{label}</div>
      <div className="mt-1 text-2xl font-semibold tracking-[-0.04em] text-[#F7F7F8]">{value}</div>
      {note ? <div className="mt-1 text-xs text-[#A4A4AF]">{note}</div> : null}
    </div>
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
  let advisorNames = new Map<string, string>();
  let moneyAccounts: MoneyAccountRow[] = [];
  let commissionPayments: CommissionPaymentRow[] = [];
  let closureLoadFailed = false;

  if (selectedPeriod) {
    const [closuresResult, advisorsResult, accountsResult, paymentsResult] = await Promise.all([
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
      ctx.supabase.rpc('get_advisor_profiles'),
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
          description
        `)
        .eq('direction', 'outflow')
        .eq('movement_type', 'expense_payment')
        .eq('status', 'confirmed')
        .like('description', `${ADVISOR_COMMISSION_PAYMENT_DESCRIPTION_PREFIX}%`)
        .order('created_at', { ascending: false })
        .limit(1000),
    ]);

    closureLoadFailed = Boolean(closuresResult.error);
    closures = closuresResult.error ? [] : ((closuresResult.data ?? []) as CommissionClosureRow[]);
    advisorNames = new Map(
      ((advisorsResult.data ?? []) as AdvisorProfileRow[]).map((advisor) => [
        String(advisor.user_id),
        advisor.full_name?.trim() || 'Asesor',
      ])
    );
    moneyAccounts = accountsResult.error ? [] : ((accountsResult.data ?? []) as MoneyAccountRow[]);
    commissionPayments = paymentsResult.error
      ? []
      : ((paymentsResult.data ?? []) as CommissionPaymentRow[]);
  }

  const paymentsByClosureId = new Map<number, CommissionPaymentRow[]>();
  for (const payment of commissionPayments) {
    const closureId = getAdvisorCommissionClosureIdFromPaymentDescription(payment.description);
    if (!closureId) continue;
    const payments = paymentsByClosureId.get(closureId) ?? [];
    payments.push(payment);
    paymentsByClosureId.set(closureId, payments);
  }
  const moneyAccountNameById = new Map(
    moneyAccounts.map((account) => [Number(account.id), account.name])
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
        workflow,
        payments,
        paidUsd,
        paymentBalanceUsd,
      };
    })
    .sort((left, right) => left.advisorName.localeCompare(right.advisorName, 'es'));

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
          <Link
            className="inline-flex w-fit items-center rounded-full border border-[#34343F] px-4 py-2 text-sm font-semibold text-[#D8D8DF] transition hover:border-[#F0D000] hover:text-[#F7DA66]"
            href="/app/master/dashboard"
          >
            Volver al panel
          </Link>
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
              className="mt-4 grid gap-3 border-t border-[#24242D] pt-4 md:grid-cols-[150px_190px_1fr_auto] md:items-end"
            >
              <input name="periodId" type="hidden" value={selectedPeriod.id} />
              <label className="block">
                <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#8F8F9B]">
                  Porcentaje base
                </span>
                <div className="relative mt-1">
                  <input
                    className="h-10 w-full rounded-xl border border-[#32323D] bg-[#0E0E12] px-3 pr-8 text-sm text-[#F7F7F8] outline-none focus:border-[#F0D000]"
                    defaultValue={numberValue(rows[0]?.closure.base_commission_pct) || 8}
                    max="100"
                    min="0"
                    name="baseCommissionPct"
                    required
                    step="0.01"
                    type="number"
                  />
                  <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-[#8F8F9B]">%</span>
                </div>
              </label>
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
                Actualiza pedidos, pagos validados, deducibles y arrastres. Los cierres ya confirmados no se modifican.
              </p>
              <button
                className="h-10 rounded-xl bg-[#F0D000] px-5 text-sm font-semibold text-[#111113] transition enabled:hover:bg-[#FFE44F] disabled:cursor-not-allowed disabled:opacity-40"
                disabled={selectedPeriod.status !== 'open'}
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
          <section className="rounded-3xl border border-dashed border-[#363641] bg-[#121217] px-5 py-12 text-center">
            <div className="text-base font-semibold">Este periodo todavía no tiene cálculos</div>
            <p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-[#A6A6B0]">
              Cuando se genere el cálculo preliminar, la relación completa aparecerá aquí.
            </p>
          </section>
        ) : rows.length > 0 ? (
          <>
            <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
              <Stat label="Asesores" value={String(rows.length)} note="Cierres del periodo" />
              <Stat label="Facturación entregada" value={money(totals.billedUsd)} note="Base comercial registrada" />
              <Stat label="Comisión bruta" value={money(totals.grossCommissionUsd)} />
              <Stat label="Deducibles" value={money(totals.deductionsUsd)} note="Obsequios y cargos registrados" />
              <Stat label="Comisión retenida" value={money(totals.retainedCommissionUsd)} note="Se arrastra al próximo periodo" />
              <Stat label="Saldo por pagar" value={money(totals.paymentBalanceUsd)} note={`${money(totals.paidUsd)} ya abonados`} />
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

            <section className="space-y-3">
              <div>
                <h2 className="text-lg font-semibold tracking-[-0.02em]">Relación por asesor</h2>
                <p className="mt-1 text-sm text-[#9696A2]">Una sola lectura compacta por cada liquidación.</p>
              </div>

              <div className="grid gap-3 xl:grid-cols-2">
                {rows.map((row) => {
                  const status = closureStatus(row.closure.status);
                  const settlementIsCurrent = row.settlement.formulaVersion !== 'legacy';
                  const conformityStatus = row.workflow.conformity.status;
                  return (
                    <article key={row.closure.id} className="rounded-3xl border border-[#282832] bg-[#141419] p-5">
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                        <div>
                          <h3 className="text-lg font-semibold tracking-[-0.02em]">{row.advisorName}</h3>
                          <div className="mt-1 text-xs text-[#92929E]">
                            {numberValue(row.closure.delivered_orders_count)} pedidos entregados · Comisión base{' '}
                            {numberValue(row.closure.base_commission_pct).toFixed(2)}%
                          </div>
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
                        <div>
                          <div className="text-[10px] uppercase tracking-[0.14em] text-[#858591]">Facturación</div>
                          <div className="mt-1 font-semibold">{money(row.closure.billed_usd)}</div>
                        </div>
                        <div>
                          <div className="text-[10px] uppercase tracking-[0.14em] text-[#858591]">Comisión bruta</div>
                          <div className="mt-1 font-semibold">{money(row.closure.gross_commission_usd)}</div>
                        </div>
                        <div>
                          <div className="text-[10px] uppercase tracking-[0.14em] text-[#858591]">Deducibles</div>
                          <div className="mt-1 font-semibold">
                            {money(numberValue(row.closure.gift_deductions_usd) + row.registeredManualDeductionsUsd)}
                          </div>
                        </div>
                        <div>
                          <div className="text-[10px] uppercase tracking-[0.14em] text-[#858591]">Deuda clientes</div>
                          <div className="mt-1 font-semibold text-amber-200">{money(row.closure.pending_collection_usd)}</div>
                        </div>
                        <div>
                          <div className="text-[10px] uppercase tracking-[0.14em] text-[#858591]">Liquidación acordada</div>
                          <div className="mt-1 font-semibold text-[#F7DA66]">{money(row.closure.payable_usd)}</div>
                        </div>
                        <div>
                          <div className="text-[10px] uppercase tracking-[0.14em] text-[#858591]">Pagado / pendiente</div>
                          <div className="mt-1 font-semibold">
                            {money(row.paidUsd)} <span className="text-[#777784]">/</span>{' '}
                            <span className="text-[#F7DA66]">{money(row.paymentBalanceUsd)}</span>
                          </div>
                        </div>
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
                                <span className="shrink-0 font-semibold text-[#E4E4E8]">{money(deduction.amount_usd)}</span>
                              </div>
                            ))}
                          </div>
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
                            Saldo pendiente: {money(row.paymentBalanceUsd)}. El monto se mantiene en dólares y la cuenta define la moneda real.
                          </p>
                          <form action={registerCommissionPaymentAction} className="mt-3 grid gap-3 sm:grid-cols-2">
                            <input name="closureId" type="hidden" value={row.closure.id} />
                            <input name="periodId" type="hidden" value={selectedPeriod?.id ?? ''} />
                            <label className="block sm:col-span-2">
                              <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#8F8F9B]">Cuenta de pago</span>
                              <select
                                className="mt-1 h-10 w-full rounded-xl border border-[#32323D] bg-[#0E0E12] px-3 text-sm text-[#F7F7F8] outline-none focus:border-[#F0D000]"
                                name="moneyAccountId"
                                required
                              >
                                <option value="">Seleccionar cuenta</option>
                                {moneyAccounts.map((account) => (
                                  <option key={account.id} value={account.id}>
                                    {account.name} · {account.currency_code}
                                  </option>
                                ))}
                              </select>
                            </label>
                            <label className="block">
                              <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#8F8F9B]">Monto USD</span>
                              <input
                                className="mt-1 h-10 w-full rounded-xl border border-[#32323D] bg-[#0E0E12] px-3 text-sm text-[#F7F7F8] outline-none focus:border-[#F0D000]"
                                defaultValue={row.paymentBalanceUsd.toFixed(2)}
                                max={row.paymentBalanceUsd.toFixed(2)}
                                min="0.01"
                                name="amountUsd"
                                required
                                step="0.01"
                                type="number"
                              />
                            </label>
                            <label className="block">
                              <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#8F8F9B]">Fecha</span>
                              <input
                                className="mt-1 h-10 w-full rounded-xl border border-[#32323D] bg-[#0E0E12] px-3 text-sm text-[#F7F7F8] outline-none focus:border-[#F0D000]"
                                defaultValue={caracasToday()}
                                name="movementDate"
                                required
                                type="date"
                              />
                            </label>
                            <label className="block">
                              <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#8F8F9B]">Tasa Bs/USD</span>
                              <input
                                className="mt-1 h-10 w-full rounded-xl border border-[#32323D] bg-[#0E0E12] px-3 text-sm text-[#F7F7F8] outline-none focus:border-[#F0D000]"
                                min="0.000001"
                                name="exchangeRateVesPerUsd"
                                placeholder="Solo si la cuenta es en Bs."
                                step="0.000001"
                                type="number"
                              />
                            </label>
                            <label className="block">
                              <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#8F8F9B]">Referencia</span>
                              <input
                                className="mt-1 h-10 w-full rounded-xl border border-[#32323D] bg-[#0E0E12] px-3 text-sm text-[#F7F7F8] outline-none focus:border-[#F0D000]"
                                maxLength={120}
                                name="referenceCode"
                                placeholder="Opcional"
                              />
                            </label>
                            <button
                              className="h-10 rounded-xl bg-[#F0D000] px-4 text-sm font-semibold text-[#111113] transition hover:bg-[#FFE44F] sm:col-span-2"
                              type="submit"
                            >
                              Registrar abono
                            </button>
                          </form>
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
