import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getAuthContext, resolveHomePath } from '@/lib/auth';
import {
  adminCommissionAuditHref,
  buildAdminCommissionAuditCalculation,
  commissionAuditNumber,
  getAdminCommissionAuditSection,
  readAdminCommissionAuditSnapshot,
  roundCommissionAuditMoney,
  type AdminCommissionAuditSection,
  type CommissionAuditGift,
  type CommissionAuditOrder,
  type CommissionAuditProduct,
} from '@/lib/commissions/admin-audit';
import { ADVISOR_COMMISSION_PAYMENT_DESCRIPTION_PREFIX } from '@/lib/commissions/payment-ledger';
import { readAdvisorCommissionWorkflowSnapshot } from '@/lib/commissions/workflow-snapshot';
import { formatOrderDisplayNumber } from '@/lib/orders/order-labels';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

type RouteParams = Promise<{ closureId: string }>;
type SearchParams = Promise<{ section?: string }>;

type PeriodRow = {
  id: number | string;
  name: string;
  date_from: string;
  date_to: string;
  status: string;
};

type DeductionRow = {
  id: number | string;
  deduction_type: string | null;
  description: string | null;
  amount_usd: number | string | null;
  order_id: number | string | null;
  notes: string | null;
  created_at: string | null;
};

type ClosureRow = {
  id: number | string;
  period_id: number | string;
  advisor_user_id: string;
  status: string;
  base_commission_pct: number | string | null;
  delivered_orders_count: number | string | null;
  billed_usd: number | string | null;
  regular_base_usd: number | string | null;
  special_item_base_usd: number | string | null;
  special_order_base_usd: number | string | null;
  gross_commission_usd: number | string | null;
  pending_collection_usd: number | string | null;
  punctual_paid_count: number | string | null;
  late_paid_count: number | string | null;
  pending_payment_count: number | string | null;
  new_own_clients_count: number | string | null;
  new_assigned_clients_count: number | string | null;
  gift_deductions_usd: number | string | null;
  manual_deductions_usd: number | string | null;
  payable_usd: number | string | null;
  generated_at: string | null;
  closed_at: string | null;
  paid_at: string | null;
  snapshot: unknown;
  deductions: DeductionRow[] | null;
};

type PaymentRow = {
  id: number | string;
  movement_date: string;
  created_at: string;
  money_account_id: number | string;
  currency_code: string;
  amount: number | string;
  exchange_rate_ves_per_usd: number | string | null;
  amount_usd_equivalent: number | string;
  reference_code: string | null;
};

function money(value: unknown) {
  return `$${roundCommissionAuditMoney(value).toFixed(2)}`;
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

function dateTimeLabel(value: string | null | undefined) {
  if (!value) return 'Sin registro';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat('es-VE', {
    timeZone: 'America/Caracas',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(parsed);
}

function orderLabel(order: CommissionAuditOrder | CommissionAuditProduct) {
  const explicit = String(order.orderNumber || '').trim();
  const id = commissionAuditNumber(order.orderId);
  return explicit || (id > 0 ? formatOrderDisplayNumber(id) : 'Sin número');
}

function commissionModeLabel(value: string | null | undefined) {
  if (value === 'fixed_order') return 'Orden especial';
  if (value === 'mixed_items') return 'Mixta';
  if (value === 'fixed_item') return 'Ítem especial';
  return 'Normal';
}

function paymentTimingLabel(value: CommissionAuditOrder['paymentTiming']) {
  if (value === 'punctual') return 'Puntual';
  if (value === 'late') return 'Crédito / posterior';
  return 'Pendiente';
}

function closureStatus(status: string) {
  if (status === 'paid') return { label: 'Pagada', classes: 'border-emerald-400/30 bg-emerald-400/10 text-emerald-200' };
  if (status === 'closed') return { label: 'Cerrada', classes: 'border-amber-400/30 bg-amber-400/10 text-amber-100' };
  return { label: 'Preliminar', classes: 'border-[#3B3B47] bg-[#1B1B23] text-[#C9C9D3]' };
}

const sectionLabels: Record<AdminCommissionAuditSection, { label: string; description: string }> = {
  billing: { label: 'Facturación', description: 'Pedidos entregados y base neta' },
  commission: { label: 'Comisión', description: 'Porcentaje, bases e ítems' },
  deductions: { label: 'Deducibles', description: 'Obsequios y cargos directos' },
  debts: { label: 'Deuda clientes', description: 'Facturas todavía pendientes' },
  settlement: { label: 'Liquidación', description: 'Fórmula completa del cierre' },
  payments: { label: 'Abonos', description: 'Dinero pagado al asesor' },
};

function AuditNavCard({
  closureId,
  section,
  active,
  value,
  note,
}: {
  closureId: number | string;
  section: AdminCommissionAuditSection;
  active: boolean;
  value: string;
  note?: string;
}) {
  const copy = sectionLabels[section];
  return (
    <Link
      aria-current={active ? 'page' : undefined}
      className={[
        'group flex min-h-36 flex-col rounded-2xl border bg-[#15151B] px-4 py-3 transition hover:border-[#F0D000]/60',
        active ? 'border-[#F0D000] ring-1 ring-[#F0D000]/70' : 'border-[#2B2B35]',
      ].join(' ')}
      href={adminCommissionAuditHref(closureId, section)}
    >
      <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#8F8F9C]">{copy.label}</div>
      <div className="mt-2 text-2xl font-semibold tracking-[-0.04em] text-[#F7F7F8]">{value}</div>
      <div className="mt-1 text-xs leading-5 text-[#9E9EAA]">{note || copy.description}</div>
      <div className="mt-auto flex items-center justify-between pt-3 text-xs font-semibold text-[#F7DA66]">
        <span>Auditar detalle</span>
        <span aria-hidden="true">→</span>
      </div>
    </Link>
  );
}

function EmptyDetail({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-dashed border-[#383843] bg-[#101014] px-5 py-10 text-center text-sm text-[#9D9DA8]">
      {children}
    </div>
  );
}

function AmountCard({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="rounded-2xl border border-[#2B2B35] bg-[#111116] p-4">
      <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#878793]">{label}</div>
      <div className="mt-1 text-xl font-semibold">{value}</div>
      {note ? <div className="mt-1 text-xs leading-5 text-[#9696A2]">{note}</div> : null}
    </div>
  );
}

function TableFrame({ children }: { children: React.ReactNode }) {
  return <div className="overflow-x-auto rounded-2xl border border-[#2B2B35]">{children}</div>;
}

function FormulaRow({
  label,
  value,
  sign,
  emphasis,
}: {
  label: string;
  value: number;
  sign?: '+' | '−' | '=';
  emphasis?: boolean;
}) {
  return (
    <div className={[
      'grid grid-cols-[24px_1fr_auto] items-center gap-2 px-4 py-3 text-sm',
      emphasis ? 'bg-[#F0D000]/10 font-semibold text-[#FFF2A8]' : 'border-b border-[#292933] text-[#CFCFD6]',
    ].join(' ')}>
      <span className="text-center text-[#83838E]">{sign || ''}</span>
      <span>{label}</span>
      <span className="font-semibold tabular-nums">{money(value)}</span>
    </div>
  );
}

export default async function CommissionAuditPage({
  params,
  searchParams,
}: {
  params: RouteParams;
  searchParams?: SearchParams;
}) {
  const ctx = await getAuthContext();
  if (!ctx) redirect('/login');
  if (!ctx.roles.includes('admin')) redirect(resolveHomePath(ctx.roles));

  const routeParams = await params;
  const query = (await searchParams) ?? {};
  const closureId = Number(routeParams.closureId);
  if (!Number.isInteger(closureId) || closureId <= 0) notFound();
  const activeSection = getAdminCommissionAuditSection(query.section);

  const closureResult = await ctx.supabase
    .from('advisor_commission_closures')
    .select(`
      id, period_id, advisor_user_id, status, base_commission_pct,
      delivered_orders_count, billed_usd, regular_base_usd, special_item_base_usd,
      special_order_base_usd, gross_commission_usd, pending_collection_usd,
      punctual_paid_count, late_paid_count, pending_payment_count,
      new_own_clients_count, new_assigned_clients_count, gift_deductions_usd,
      manual_deductions_usd, payable_usd, generated_at, closed_at, paid_at, snapshot,
      deductions:advisor_commission_deductions (
        id, deduction_type, description, amount_usd, order_id, notes, created_at
      )
    `)
    .eq('id', closureId)
    .maybeSingle();

  if (closureResult.error) {
    return (
      <main className="min-h-screen bg-[#0B0B0D] px-5 py-10 text-[#F7F7F8]">
        <div className="mx-auto max-w-2xl rounded-3xl border border-red-500/25 bg-[#15151B] p-6">
          <h1 className="text-lg font-semibold">No se pudo cargar la auditoría</h1>
          <p className="mt-2 text-sm leading-6 text-[#B5B5C0]">El cierre no fue modificado. Regresa a Comisiones e inténtalo nuevamente.</p>
          <Link className="mt-5 inline-flex text-sm font-semibold text-[#F7DA66]" href="/app/commissions">Volver a Comisiones</Link>
        </div>
      </main>
    );
  }
  if (!closureResult.data) notFound();

  const closure = closureResult.data as ClosureRow;
  const paymentDescriptionPattern = `${ADVISOR_COMMISSION_PAYMENT_DESCRIPTION_PREFIX}${closureId} · %`;
  const [periodResult, profileResult, paymentsResult] = await Promise.all([
    ctx.supabase
      .from('advisor_commission_periods')
      .select('id, name, date_from, date_to, status')
      .eq('id', Number(closure.period_id))
      .maybeSingle(),
    ctx.supabase
      .from('profiles')
      .select('id, full_name')
      .eq('id', closure.advisor_user_id)
      .maybeSingle(),
    ctx.supabase
      .from('money_movements')
      .select('id, movement_date, created_at, money_account_id, currency_code, amount, exchange_rate_ves_per_usd, amount_usd_equivalent, reference_code')
      .eq('direction', 'outflow')
      .eq('movement_type', 'expense_payment')
      .eq('status', 'confirmed')
      .like('description', paymentDescriptionPattern)
      .order('created_at', { ascending: true }),
  ]);

  const period = (periodResult.data as PeriodRow | null) ?? null;
  const payments = paymentsResult.error ? [] : ((paymentsResult.data ?? []) as PaymentRow[]);
  const accountIds = Array.from(new Set(payments.map((payment) => Number(payment.money_account_id)).filter((id) => id > 0)));
  const accountsResult = accountIds.length
    ? await ctx.supabase.from('money_accounts').select('id, name').in('id', accountIds)
    : { data: [], error: null };
  const accountNames = new Map(
    (accountsResult.data ?? []).map((account) => [Number(account.id), String(account.name)])
  );

  const deductions = Array.isArray(closure.deductions) ? closure.deductions : [];
  const directDeductions = deductions.filter((deduction) => deduction.deduction_type !== 'gift');
  const snapshot = readAdminCommissionAuditSnapshot(closure.snapshot);
  const audit = buildAdminCommissionAuditCalculation({ closure, deductions, payments });
  const workflow = readAdvisorCommissionWorkflowSnapshot(closure.snapshot);
  const status = closureStatus(closure.status);
  const advisorName =
    String(profileResult.data?.full_name || '').trim() ||
    snapshot.advisorName ||
    'Asesor sin nombre';
  const backHref = `/app/commissions${period ? `?period=${period.id}` : ''}`;
  const totalDeductionsUsd = roundCommissionAuditMoney(
    commissionAuditNumber(closure.gift_deductions_usd) +
      commissionAuditNumber(closure.manual_deductions_usd)
  );
  const sourceDifferences =
    Math.abs(audit.payableDifferenceUsd) >= 0.01 ||
    Math.abs(audit.directDeductionDifferenceUsd) >= 0.01 ||
    Math.abs(audit.commissionDifferenceUsd) >= 0.01 ||
    Math.abs(audit.pendingCollectionDifferenceUsd) >= 0.01 ||
    Math.abs(audit.giftDeductionDifferenceUsd) >= 0.01 ||
    (audit.billedDifferenceUsd !== null && Math.abs(audit.billedDifferenceUsd) >= 0.05);

  return (
    <main className="min-h-screen bg-[#0B0B0D] text-[#F7F7F8]">
      <header className="border-b border-[#24242D] bg-[#101014]">
        <div className="mx-auto flex max-w-[1500px] flex-col gap-4 px-5 py-5 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-semibold tracking-[-0.04em]">Auditoría de comisión</h1>
              <span className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold ${status.classes}`}>{status.label}</span>
              {sourceDifferences ? (
                <span className="rounded-full border border-red-400/30 bg-red-400/10 px-2.5 py-1 text-[11px] font-semibold text-red-200">Requiere revisión</span>
              ) : (
                <span className="rounded-full border border-emerald-400/25 bg-emerald-400/10 px-2.5 py-1 text-[11px] font-semibold text-emerald-200">Cálculo conciliado</span>
              )}
            </div>
            <p className="mt-1 text-sm text-[#A9A9B4]">
              {advisorName} · {period?.name || 'Periodo'} · {period ? `${dateLabel(period.date_from)} al ${dateLabel(period.date_to)}` : 'Fechas no disponibles'}
            </p>
          </div>
          <Link className="inline-flex w-fit items-center rounded-full border border-[#34343F] px-4 py-2 text-sm font-semibold text-[#D8D8DF] transition hover:border-[#F0D000] hover:text-[#F7DA66]" href={backHref}>
            ← Volver a la relación
          </Link>
        </div>
      </header>

      <div className="mx-auto max-w-[1500px] space-y-5 px-5 py-6">
        <section className="rounded-3xl border border-[#292933] bg-[#121217] p-5">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <div className="text-xs font-semibold uppercase tracking-[0.16em] text-[#8E8E9A]">Fuente del cálculo</div>
              <h2 className="mt-1 text-lg font-semibold">Cierre #{closure.id} · {advisorName}</h2>
              <p className="mt-1 max-w-3xl text-sm leading-6 text-[#A3A3AE]">
                Cada detalle se lee del cierre guardado, sus deducibles y los movimientos de pago vinculados. Esta pantalla no recalcula ni modifica órdenes.
              </p>
            </div>
            <div className="grid gap-1 text-xs text-[#A1A1AC] lg:text-right">
              <span>Corte de datos: {dateTimeLabel(audit.settlement.calculationCutoffAt || closure.generated_at)}</span>
              <span>Fórmula: {audit.settlement.formulaVersion === 'legacy' ? 'Cierre histórico' : audit.settlement.formulaVersion}</span>
              <span>
                Conformidad: {workflow.conformity.status === 'confirmed' ? 'Confirmada' : workflow.conformity.status === 'requires_reconfirmation' ? 'Debe confirmarse otra vez' : 'Pendiente'}
              </span>
            </div>
          </div>
        </section>

        {sourceDifferences ? (
          <section className="rounded-3xl border border-red-400/30 bg-red-400/5 p-5 text-sm text-red-100">
            <div className="font-semibold">Hay una diferencia que debe auditarse antes de cerrar.</div>
            <div className="mt-2 grid gap-1 text-xs leading-5 text-red-100/80">
              {Math.abs(audit.payableDifferenceUsd) >= 0.01 ? <span>Liquidación guardada vs. fórmula: {money(audit.payableDifferenceUsd)} de diferencia.</span> : null}
              {Math.abs(audit.directDeductionDifferenceUsd) >= 0.01 ? <span>Deducibles directos guardados vs. registros: {money(audit.directDeductionDifferenceUsd)} de diferencia.</span> : null}
              {Math.abs(audit.commissionDifferenceUsd) >= 0.01 ? <span>Comisión bruta vs. suma por pedido: {money(audit.commissionDifferenceUsd)} de diferencia.</span> : null}
              {Math.abs(audit.pendingCollectionDifferenceUsd) >= 0.01 ? <span>Deuda de clientes vs. facturas pendientes: {money(audit.pendingCollectionDifferenceUsd)} de diferencia.</span> : null}
              {Math.abs(audit.giftDeductionDifferenceUsd) >= 0.01 ? <span>Obsequios guardados vs. detalle: {money(audit.giftDeductionDifferenceUsd)} de diferencia.</span> : null}
              {audit.billedDifferenceUsd !== null && Math.abs(audit.billedDifferenceUsd) >= 0.05 ? <span>Facturación neta vs. suma por pedido: {money(audit.billedDifferenceUsd)} de diferencia.</span> : null}
            </div>
          </section>
        ) : null}

        <nav aria-label="Secciones de auditoría" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
          <AuditNavCard closureId={closure.id} section="billing" active={activeSection === 'billing'} value={money(closure.billed_usd)} note={`${snapshot.orders.length} pedidos entregados`} />
          <AuditNavCard closureId={closure.id} section="commission" active={activeSection === 'commission'} value={money(closure.gross_commission_usd)} note={`Base individual ${commissionAuditNumber(closure.base_commission_pct).toFixed(2)}%`} />
          <AuditNavCard closureId={closure.id} section="deductions" active={activeSection === 'deductions'} value={money(totalDeductionsUsd)} note={`${snapshot.gifts.length} obsequios + ${directDeductions.length} cargos`} />
          <AuditNavCard closureId={closure.id} section="debts" active={activeSection === 'debts'} value={money(closure.pending_collection_usd)} note={`${snapshot.pendingOrders.length} facturas pendientes`} />
          <AuditNavCard closureId={closure.id} section="settlement" active={activeSection === 'settlement'} value={money(closure.payable_usd)} note={`${money(audit.settlement.retainedCommissionUsd)} retenidos`} />
          <AuditNavCard closureId={closure.id} section="payments" active={activeSection === 'payments'} value={money(audit.paidUsd)} note={`${money(audit.paymentBalanceUsd)} por pagar`} />
        </nav>

        <section id="audit-detail" className="scroll-mt-5 rounded-3xl border border-[#292933] bg-[#141419] p-5">
          <div className="mb-5 flex flex-col gap-2 border-b border-[#292933] pb-4 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <div className="text-xs font-semibold uppercase tracking-[0.16em] text-[#8E8E9A]">Detalle auditado</div>
              <h2 className="mt-1 text-xl font-semibold tracking-[-0.03em]">{sectionLabels[activeSection].label}</h2>
              <p className="mt-1 text-sm text-[#9B9BA6]">{sectionLabels[activeSection].description}</p>
            </div>
            <span className="text-xs text-[#777783]">Cierre #{closure.id}</span>
          </div>

          {activeSection === 'billing' ? (
            <div className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <AmountCard label="Facturación neta" value={money(closure.billed_usd)} note="Sin IVA, según cierre" />
                <AmountCard label="Pedidos entregados" value={String(commissionAuditNumber(closure.delivered_orders_count))} />
                <AmountCard label="Clientes nuevos propios" value={String(commissionAuditNumber(closure.new_own_clients_count))} />
                <AmountCard label="Clientes nuevos asignados" value={String(commissionAuditNumber(closure.new_assigned_clients_count))} />
              </div>
              {audit.perOrderBilledUsd === null ? (
                <div className="rounded-2xl border border-amber-400/25 bg-amber-400/5 p-4 text-sm leading-6 text-amber-100">
                  Este cierre fue calculado antes de guardar el neto sin IVA por pedido. El total del cierre sí está preservado; al recalcular un periodo preliminar, el nuevo snapshot incorporará ese desglose sin crear columnas.
                </div>
              ) : (
                <div className="rounded-2xl border border-emerald-400/20 bg-emerald-400/5 p-4 text-sm text-emerald-100">
                  La suma neta de los pedidos es {money(audit.perOrderBilledUsd)}{audit.billedDifferenceUsd && Math.abs(audit.billedDifferenceUsd) >= 0.01 ? ` · Diferencia de redondeo ${money(audit.billedDifferenceUsd)}` : ' y coincide con el total del cierre.'}
                </div>
              )}
              {snapshot.orders.length === 0 ? <EmptyDetail>No hay pedidos guardados en este cierre.</EmptyDetail> : (
                <TableFrame>
                  <table className="min-w-[1080px] w-full text-left text-xs">
                    <thead className="bg-[#0F0F13] text-[10px] uppercase tracking-[0.12em] text-[#858591]">
                      <tr><th className="px-4 py-3">Pedido</th><th className="px-4 py-3">Cliente</th><th className="px-4 py-3">Entrega</th><th className="px-4 py-3 text-right">Neto sin IVA</th><th className="px-4 py-3 text-right">Total del pedido</th><th className="px-4 py-3 text-right">Pagado validado</th><th className="px-4 py-3 text-right">Pendiente</th><th className="px-4 py-3">Cobranza</th></tr>
                    </thead>
                    <tbody className="divide-y divide-[#292933]">
                      {snapshot.orders.map((order, index) => (
                        <tr key={`${order.orderId || order.orderNumber || 'order'}-${index}`} className="text-[#D0D0D7]">
                          <td className="px-4 py-3 font-semibold text-[#F1F1F3]">{orderLabel(order)}</td>
                          <td className="px-4 py-3">{order.clientName || 'Cliente sin nombre'}</td>
                          <td className="px-4 py-3">{dateLabel(order.deliveryDate)}</td>
                          <td className="px-4 py-3 text-right font-semibold">{order.billedUsd === null || order.billedUsd === undefined ? 'No guardado' : money(order.billedUsd)}</td>
                          <td className="px-4 py-3 text-right">{money(order.totalUsd)}</td>
                          <td className="px-4 py-3 text-right text-emerald-300">{money(order.confirmedPaidUsd)}</td>
                          <td className="px-4 py-3 text-right text-amber-200">{money(order.pendingUsd)}</td>
                          <td className="px-4 py-3">{paymentTimingLabel(order.paymentTiming)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableFrame>
              )}
            </div>
          ) : null}

          {activeSection === 'commission' ? (
            <div className="space-y-5">
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <AmountCard label="Comisión normal" value={money(audit.normalCommissionUsd)} note={`${money(closure.regular_base_usd)} al ${commissionAuditNumber(closure.base_commission_pct).toFixed(2)}%`} />
                <AmountCard label="Ítems especiales" value={money(audit.specialItemsCommissionUsd)} note={`${money(closure.special_item_base_usd)} de base`} />
                <AmountCard label="Órdenes especiales" value={money(audit.specialOrdersCommissionUsd)} note={`${money(closure.special_order_base_usd)} de base`} />
                <AmountCard label="Comisión bruta" value={money(closure.gross_commission_usd)} note="Suma de las tres modalidades" />
              </div>
              <div>
                <h3 className="mb-3 text-sm font-semibold">Comisión por pedido</h3>
                {snapshot.orders.length === 0 ? <EmptyDetail>No hay pedidos para explicar la comisión.</EmptyDetail> : (
                  <TableFrame>
                    <table className="min-w-[1080px] w-full text-left text-xs">
                      <thead className="bg-[#0F0F13] text-[10px] uppercase tracking-[0.12em] text-[#858591]">
                        <tr><th className="px-4 py-3">Pedido</th><th className="px-4 py-3">Cliente</th><th className="px-4 py-3">Regla</th><th className="px-4 py-3 text-right">Base normal</th><th className="px-4 py-3 text-right">Base ítems especiales</th><th className="px-4 py-3 text-right">Base orden especial</th><th className="px-4 py-3 text-right">Comisión</th></tr>
                      </thead>
                      <tbody className="divide-y divide-[#292933]">
                        {snapshot.orders.map((order, index) => (
                          <tr key={`${order.orderId || order.orderNumber || 'commission'}-${index}`}>
                            <td className="px-4 py-3 font-semibold">{orderLabel(order)}</td><td className="px-4 py-3 text-[#C5C5CD]">{order.clientName || 'Cliente'}</td><td className="px-4 py-3">{commissionModeLabel(order.commissionMode)}</td><td className="px-4 py-3 text-right">{money(order.regularBaseUsd)}</td><td className="px-4 py-3 text-right">{money(order.specialItemBaseUsd)}</td><td className="px-4 py-3 text-right">{money(order.specialOrderBaseUsd)}</td><td className="px-4 py-3 text-right font-semibold text-[#F7DA66]">{money(order.commissionUsd)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </TableFrame>
                )}
              </div>
              <details className="rounded-2xl border border-[#2B2B35] bg-[#111116] px-4 py-3">
                <summary className="cursor-pointer text-sm font-semibold text-[#D7D7DE]">Ver las {snapshot.products.length} líneas de producto que forman las bases</summary>
                <div className="mt-4">
                  {snapshot.products.length === 0 ? <EmptyDetail>No hay líneas de producto en el snapshot.</EmptyDetail> : (
                    <TableFrame>
                      <table className="min-w-[980px] w-full text-left text-xs">
                        <thead className="bg-[#0F0F13] text-[10px] uppercase tracking-[0.12em] text-[#858591]"><tr><th className="px-4 py-3">Pedido</th><th className="px-4 py-3">Producto</th><th className="px-4 py-3 text-right">Cantidad</th><th className="px-4 py-3">Regla</th><th className="px-4 py-3 text-right">Base</th><th className="px-4 py-3 text-right">Porcentaje</th><th className="px-4 py-3 text-right">Comisión línea</th></tr></thead>
                        <tbody className="divide-y divide-[#292933]">
                          {snapshot.products.map((product, index) => {
                            const pct = product.commissionMode === 'fixed_item' ? commissionAuditNumber(product.commissionValue) : commissionAuditNumber(closure.base_commission_pct);
                            return <tr key={`${product.orderId || product.orderNumber || 'product'}-${product.productName || index}-${index}`}><td className="px-4 py-3 font-semibold">{orderLabel(product)}</td><td className="px-4 py-3">{product.productName || 'Producto'}</td><td className="px-4 py-3 text-right">{commissionAuditNumber(product.qty)}</td><td className="px-4 py-3">{commissionModeLabel(product.commissionMode)}</td><td className="px-4 py-3 text-right">{money(product.lineBaseUsd)}</td><td className="px-4 py-3 text-right">{pct.toFixed(2)}%</td><td className="px-4 py-3 text-right font-semibold text-[#F7DA66]">{money(commissionAuditNumber(product.lineBaseUsd) * (pct / 100))}</td></tr>;
                          })}
                        </tbody>
                      </table>
                    </TableFrame>
                  )}
                </div>
              </details>
            </div>
          ) : null}

          {activeSection === 'deductions' ? (
            <div className="space-y-5">
              <div className="grid gap-3 sm:grid-cols-3">
                <AmountCard label="Obsequios" value={money(closure.gift_deductions_usd)} note={`${snapshot.gifts.length} registros`} />
                <AmountCard label="Deducibles directos" value={money(closure.manual_deductions_usd)} note={`${directDeductions.length} registros`} />
                <AmountCard label="Total descontado" value={money(totalDeductionsUsd)} />
              </div>
              <div>
                <h3 className="mb-3 text-sm font-semibold">Obsequios descontados</h3>
                {snapshot.gifts.length === 0 ? <EmptyDetail>No hubo obsequios en este cierre.</EmptyDetail> : (
                  <TableFrame><table className="min-w-[780px] w-full text-left text-xs"><thead className="bg-[#0F0F13] text-[10px] uppercase tracking-[0.12em] text-[#858591]"><tr><th className="px-4 py-3">Pedido</th><th className="px-4 py-3">Cliente</th><th className="px-4 py-3">Obsequio</th><th className="px-4 py-3 text-right">Cantidad</th><th className="px-4 py-3 text-right">Deducción</th></tr></thead><tbody className="divide-y divide-[#292933]">{snapshot.gifts.map((gift: CommissionAuditGift, index) => <tr key={`${gift.orderId || gift.orderNumber || 'gift'}-${index}`}><td className="px-4 py-3 font-semibold">{orderLabel(gift)}</td><td className="px-4 py-3">{gift.clientName || 'Cliente'}</td><td className="px-4 py-3">{gift.productName || 'Obsequio'}</td><td className="px-4 py-3 text-right">{commissionAuditNumber(gift.qty)}</td><td className="px-4 py-3 text-right font-semibold text-amber-200">{money(gift.deductionUsd)}</td></tr>)}</tbody></table></TableFrame>
                )}
              </div>
              <div>
                <h3 className="mb-3 text-sm font-semibold">Cargos directos registrados por Administración</h3>
                {directDeductions.length === 0 ? <EmptyDetail>No hay deducibles directos en este cierre.</EmptyDetail> : (
                  <TableFrame><table className="min-w-[760px] w-full text-left text-xs"><thead className="bg-[#0F0F13] text-[10px] uppercase tracking-[0.12em] text-[#858591]"><tr><th className="px-4 py-3">Fecha</th><th className="px-4 py-3">Concepto</th><th className="px-4 py-3">Pedido relacionado</th><th className="px-4 py-3">Nota</th><th className="px-4 py-3 text-right">Monto</th></tr></thead><tbody className="divide-y divide-[#292933]">{directDeductions.map((deduction) => <tr key={deduction.id}><td className="px-4 py-3">{dateLabel(deduction.created_at)}</td><td className="px-4 py-3 font-semibold">{deduction.description || 'Sin concepto'}</td><td className="px-4 py-3">{deduction.order_id ? formatOrderDisplayNumber(Number(deduction.order_id)) : '—'}</td><td className="px-4 py-3 text-[#A8A8B2]">{deduction.notes || '—'}</td><td className="px-4 py-3 text-right font-semibold text-amber-200">{money(deduction.amount_usd)}</td></tr>)}</tbody></table></TableFrame>
                )}
              </div>
            </div>
          ) : null}

          {activeSection === 'debts' ? (
            <div className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-3">
                <AmountCard label="Deuda de clientes" value={money(closure.pending_collection_usd)} note="Saldo al corte del cálculo" />
                <AmountCard label="Facturas pendientes" value={String(snapshot.pendingOrders.length)} />
                <AmountCard label="Comisión retenida" value={money(audit.settlement.retainedCommissionUsd)} note="Se arrastra al periodo siguiente" />
              </div>
              {snapshot.pendingOrders.length === 0 ? <EmptyDetail>No hay facturas pendientes en este cierre.</EmptyDetail> : (
                <TableFrame><table className="min-w-[980px] w-full text-left text-xs"><thead className="bg-[#0F0F13] text-[10px] uppercase tracking-[0.12em] text-[#858591]"><tr><th className="px-4 py-3">Pedido</th><th className="px-4 py-3">Cliente</th><th className="px-4 py-3">Entrega</th><th className="px-4 py-3 text-right">Factura neta</th><th className="px-4 py-3 text-right">Pago validado</th><th className="px-4 py-3 text-right">Saldo</th><th className="px-4 py-3 text-right">Comisión asociada</th></tr></thead><tbody className="divide-y divide-[#292933]">{snapshot.pendingOrders.map((order, index) => <tr key={`${order.orderId || order.orderNumber || 'debt'}-${index}`}><td className="px-4 py-3 font-semibold">{orderLabel(order)}</td><td className="px-4 py-3">{order.clientName || 'Cliente'}</td><td className="px-4 py-3">{dateLabel(order.deliveryDate)}</td><td className="px-4 py-3 text-right">{money(order.totalUsd)}</td><td className="px-4 py-3 text-right text-emerald-300">{money(order.confirmedPaidUsd)}</td><td className="px-4 py-3 text-right font-semibold text-amber-200">{money(order.pendingUsd)}</td><td className="px-4 py-3 text-right">{money(order.commissionUsd)}</td></tr>)}</tbody></table></TableFrame>
              )}
              {audit.settlement.uncoveredCustomerDebtUsd > 0 ? <div className="rounded-2xl border border-amber-400/25 bg-amber-400/5 p-4 text-sm text-amber-100">La deuda supera el crédito disponible del asesor por {money(audit.settlement.uncoveredCustomerDebtUsd)}. Esa parte queda identificada para el siguiente periodo.</div> : null}
            </div>
          ) : null}

          {activeSection === 'settlement' ? (
            <div className="grid gap-5 lg:grid-cols-[1.15fr_0.85fr]">
              <div className="overflow-hidden rounded-2xl border border-[#2B2B35] bg-[#111116]">
                <FormulaRow label="Comisión arrastrada a favor" value={audit.recalculation.carriedCommissionUsd} sign="+" />
                <FormulaRow label="Comisión bruta del periodo" value={audit.recalculation.grossCommissionUsd} sign="+" />
                <FormulaRow label="Ajustes a favor" value={audit.recalculation.positiveAdjustmentsUsd} sign="+" />
                <FormulaRow label="Crédito antes de deducciones" value={audit.recalculation.creditBeforeDeductionsUsd} sign="=" emphasis />
                <FormulaRow label="Deuda propia anterior" value={audit.recalculation.priorAdvisorDebtUsd} sign="−" />
                <FormulaRow label="Obsequios" value={audit.recalculation.giftDeductionsUsd} sign="−" />
                <FormulaRow label="Deducibles directos" value={audit.recalculation.directDeductionsUsd} sign="−" />
                <FormulaRow label="Ajustes en contra" value={audit.recalculation.negativeAdjustmentsUsd} sign="−" />
                <FormulaRow label="Crédito después de deducciones" value={audit.recalculation.creditAfterDeductionsUsd} sign="=" emphasis />
                <FormulaRow label="Deuda de clientes retenida" value={audit.recalculation.retainedCommissionUsd} sign="−" />
                <FormulaRow label="Liquidación acordada" value={audit.recalculation.payableUsd} sign="=" emphasis />
              </div>
              <div className="space-y-3">
                <AmountCard label="Monto guardado en el cierre" value={money(closure.payable_usd)} note={Math.abs(audit.payableDifferenceUsd) < 0.01 ? 'Coincide con la fórmula' : `Diferencia: ${money(audit.payableDifferenceUsd)}`} />
                <AmountCard label="Comisión que pasa al siguiente periodo" value={money(audit.settlement.retainedCommissionUsd)} note="Sigue a favor del asesor hasta cubrir la deuda" />
                <AmountCard label="Deuda propia que pasa al siguiente periodo" value={money(audit.settlement.advisorDebtOutUsd)} />
                <AmountCard label="Fecha prevista de pago" value={audit.settlement.scheduledLiquidationDate ? dateLabel(audit.settlement.scheduledLiquidationDate) : 'No indicada'} note="Fecha administrativa, no calculada automáticamente" />
                <AmountCard label="Conformidad" value={workflow.conformity.status === 'confirmed' ? 'Confirmada' : workflow.conformity.status === 'requires_reconfirmation' ? 'Pendiente de reconfirmar' : 'Pendiente'} note={`${workflow.revisionCount} correcciones registradas`} />
              </div>
            </div>
          ) : null}

          {activeSection === 'payments' ? (
            <div className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-3">
                <AmountCard label="Liquidación acordada" value={money(closure.payable_usd)} />
                <AmountCard label="Total abonado" value={money(audit.paidUsd)} note={`${payments.length} ${payments.length === 1 ? 'movimiento' : 'movimientos'}`} />
                <AmountCard label="Saldo por pagar" value={money(audit.paymentBalanceUsd)} />
              </div>
              {paymentsResult.error ? <EmptyDetail>No se pudieron cargar los movimientos bancarios vinculados.</EmptyDetail> : payments.length === 0 ? <EmptyDetail>Todavía no hay abonos registrados para esta liquidación.</EmptyDetail> : (
                <TableFrame><table className="min-w-[900px] w-full text-left text-xs"><thead className="bg-[#0F0F13] text-[10px] uppercase tracking-[0.12em] text-[#858591]"><tr><th className="px-4 py-3">Abono</th><th className="px-4 py-3">Fecha</th><th className="px-4 py-3">Cuenta</th><th className="px-4 py-3">Moneda real</th><th className="px-4 py-3 text-right">Monto real</th><th className="px-4 py-3 text-right">Tasa</th><th className="px-4 py-3 text-right">Equivalente USD</th><th className="px-4 py-3">Referencia</th></tr></thead><tbody className="divide-y divide-[#292933]">{payments.map((payment, index) => <tr key={payment.id}><td className="px-4 py-3 font-semibold">Abono {index + 1}</td><td className="px-4 py-3">{dateLabel(payment.movement_date)}</td><td className="px-4 py-3">{accountNames.get(Number(payment.money_account_id)) || 'Cuenta sin nombre'}</td><td className="px-4 py-3">{payment.currency_code}</td><td className="px-4 py-3 text-right">{commissionAuditNumber(payment.amount).toFixed(2)}</td><td className="px-4 py-3 text-right">{payment.currency_code === 'VES' ? commissionAuditNumber(payment.exchange_rate_ves_per_usd).toFixed(2) : '—'}</td><td className="px-4 py-3 text-right font-semibold text-emerald-300">{money(payment.amount_usd_equivalent)}</td><td className="px-4 py-3">{payment.reference_code || '—'}</td></tr>)}</tbody></table></TableFrame>
              )}
            </div>
          ) : null}
        </section>
      </div>
    </main>
  );
}
