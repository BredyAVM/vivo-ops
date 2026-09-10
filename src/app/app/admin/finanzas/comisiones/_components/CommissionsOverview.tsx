import Link from 'next/link';
import { commissionPeriodView, type CommissionsOverview as Overview, type CommissionFilters, type CommissionRow } from '@/lib/admin-finance/commissions-model';
import { adminCommissionAuditHref } from '@/lib/commissions/admin-audit';

const basePath = '/app/admin/finanzas/comisiones';
const moneyFormat = new Intl.NumberFormat('es-VE', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
const dateFormat = new Intl.DateTimeFormat('es-VE', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'America/Caracas' });
const money = (amount: number | null) => amount === null ? '—' : moneyFormat.format(amount);
const control = 'min-h-11 rounded-xl border border-[#30303D] bg-[#111117] px-3 text-sm text-white focus-visible:outline-2 focus-visible:outline-[#FEEF00]';
const statuses = { preliminary: 'Preliminar', closed: 'Cerrada', paid: 'Marcada pagada' };
function href(filters: CommissionFilters, patch: Partial<CommissionFilters> = {}) {
  const f = { ...filters, page: 1, ...patch };
  const params = new URLSearchParams({ estado: f.status, q: f.q, page: String(f.page) });
  if (f.periodId !== null) params.set('period', String(f.periodId));
  return `${basePath}?${params}`;
}
function RowStatus({ row }: { row: CommissionRow }) {
  return <><span className="text-xs text-[#C8C8D0]">{statuses[row.status]}</span>
    {row.issues.length > 0 ? <details className="mt-1 text-xs text-orange-200"><summary className="cursor-pointer py-1">{row.issues.length} aviso(s)</summary><ul className="mt-1 list-disc space-y-1 pl-4">{row.issues.map(issue => <li key={issue}>{issue}</li>)}</ul></details> : null}</>;
}
export default function CommissionsOverview({ data, filters }: { data: Overview; filters: CommissionFilters }) {
  const view = commissionPeriodView(data, filters);
  const selected = { ...filters, periodId: view.period?.id ?? filters.periodId };
  const totals = view.summary;
  const cards = [
    { label: 'Generada', amount: totals.grossUsd, note: 'Bruta en cálculos guardados' },
    { label: 'Retenida', amount: totals.retainedUsd, note: totals.estimatedRetentions ? `${totals.estimatedRetentions} retenciones históricas estimadas` : 'En el cálculo del período' },
    { label: 'Conformada', amount: totals.conformedUsd, note: 'Cerrada, aún sin marcar pagada' },
    { label: 'Por pagar conciliado', amount: totals.pendingUsd, note: totals.pendingUsd === null ? 'Vínculo de pagos por verificar' : 'Solo obligaciones conformadas' },
  ];
  return <div className="space-y-5">
    <header className="flex flex-wrap items-center justify-between gap-3">
      <div><h1 className="text-xl font-semibold text-white">Comisiones</h1><p className="mt-1 text-xs text-[#A3A3AE]">USD · Consulta {dateFormat.format(new Date(data.asOf))}</p></div>
      <div className="flex flex-wrap gap-2"><Link href={view.period ? `/app/commissions?period=${view.period.id}` : '/app/commissions'} prefetch={false} className={`${control} inline-flex items-center`}>Calcular / conformar / pagar →</Link>
        <Link href="/app/commissions/goals" prefetch={false} className={`${control} inline-flex items-center`}>Metas</Link></div>
    </header>
    <form key={`${selected.periodId}:${filters.status}:${filters.q}`} action={basePath} method="get" className="flex flex-wrap gap-2">
      <label className="min-w-0 flex-1 basis-52"><span className="sr-only">Período de comisión</span>
        <select name="period" defaultValue={selected.periodId ?? ''} className={`${control} w-full`}>
          {!view.period ? <option value="">Selecciona un período</option> : null}
          {data.periods.map(p => <option key={p.id} value={p.id}>{p.name} · {p.from} / {p.to}</option>)}
        </select></label>
      <label><span className="sr-only">Estado del cierre</span><select name="estado" defaultValue={filters.status} className={control}>
        <option value="all">Todos los cierres</option><option value="preliminary">Preliminares</option><option value="closed">Cerradas</option><option value="paid">Marcadas pagadas</option><option value="issues">Con avisos</option>
      </select></label>
      <label className="min-w-0 flex-1 basis-40"><span className="sr-only">Asesor o cierre</span><input name="q" defaultValue={filters.q} maxLength={80} placeholder="Asesor o cierre" className={`${control} w-full`} /></label>
      <button type="submit" className={`${control} font-semibold`}>Ver / actualizar</button>
    </form>
    {!view.period ? <p className="rounded-xl border border-[#292937] p-4 text-sm text-[#C8C8D0]">{data.periods.length ? 'El período solicitado no está disponible. Selecciona uno de la lista.' : 'No hay períodos de comisión registrados.'}</p> : <>
      <section aria-label="Indicadores del período seleccionado" className="grid grid-cols-2 gap-3 xl:grid-cols-4">{cards.map(card => <article key={card.label} className="min-w-0 rounded-2xl border border-[#292937] bg-[#111117] p-3 sm:p-4">
        <h2 className="text-[11px] font-semibold uppercase tracking-wide text-[#A3A3AE]">{card.label}</h2>
        <p className="mt-2 break-words text-2xl font-semibold text-white tabular-nums">{money(card.amount)}</p>
        <p className="mt-2 text-[11px] text-[#A3A3AE]">{card.note}</p>
      </article>)}</section>
      <div className="flex flex-wrap gap-2 text-xs">{([
        ['preliminary', 'Preliminares', totals.preliminary], ['closed', 'Cerradas', totals.closed],
        ['paid', 'Marcadas pagadas', totals.paid], ['issues', 'Con avisos', totals.issues],
      ] as const).map(([status, label, count]) => <Link key={status} href={href(selected, { status })} prefetch={false} className="rounded-lg border border-[#30303D] px-3 py-2 text-[#C8C8D0]">{label} · {count}</Link>)}
        {filters.status !== 'all' || filters.q ? <Link href={href(selected, { status: 'all', q: '' })} prefetch={false} className="px-3 py-2 text-[#FEEF00]">Quitar filtros</Link> : null}
      </div>
      <p className="text-xs text-[#A3A3AE]">{view.period.name} · {view.count} cierres seleccionados. Son cálculos guardados, no una actualización automática de comisiones.</p>
      {totals.pendingUsd === null && view.count > 0 ? <p className="rounded-xl border border-orange-300/20 bg-orange-300/5 p-3 text-sm text-orange-200">El saldo por pagar aún no está conciliado: los abonos se identifican por descripción. “Pagada” no confirma por sí sola el pago.</p> : null}
      {view.missingCurrentAdvisors ? <p className="text-sm text-orange-200">{view.missingCurrentAdvisors} asesores activos todavía sin cálculo en este período.</p> : null}
      {view.excluded > 0 ? <p className="text-xs text-[#A3A3AE]">{view.excluded} preliminares de asesores actualmente no habilitados quedan fuera del total, igual que en el módulo de liquidación.</p> : null}
      {view.rows.length === 0 ? <p className="rounded-xl border border-[#292937] p-5 text-sm text-[#C8C8D0]">No hay cierres con estos filtros. Un período sin cálculo no equivale a comisión generada cero.</p> : <>
        <div className="hidden overflow-x-auto rounded-2xl border border-[#292937] lg:block"><table className="w-full text-left text-sm">
          <caption className="sr-only">Cálculos por asesor del período seleccionado; totales incluyen todas las páginas. Abonos identificados no equivalen a pagos conciliados.</caption>
          <thead className="bg-[#191920] text-xs text-[#A3A3AE]"><tr>{['Asesor / cierre', 'Estado', 'Generada', 'Retenida', 'Liquidación', 'Abonos identificados*'].map((label, index) => <th key={label} scope="col" className={`px-3 py-3 ${index > 1 ? 'text-right' : ''}`}>{label}</th>)}</tr></thead>
          <tbody className="divide-y divide-[#292937]">{view.rows.map(row => <tr key={row.id} className="bg-[#111117]">
            <td className="max-w-56 px-3 py-3"><Link href={adminCommissionAuditHref(row.id, 'settlement')} prefetch={false} className="font-semibold text-white hover:text-[#FEEF00]">{row.advisorName} →</Link><p className="mt-1 text-xs text-[#A3A3AE]">#{row.id} · Cálculo {dateFormat.format(new Date(row.calculationAt))}</p></td>
            <td className="max-w-60 px-3 py-3"><RowStatus row={row} /></td>
            <td className="px-3 py-3 text-right text-white tabular-nums">{money(row.calculationBeforePeriod ? null : row.grossUsd)}</td><td className="px-3 py-3 text-right text-orange-200 tabular-nums">{money(row.calculationBeforePeriod ? null : row.retainedUsd)}{row.retainedBasis === 'legacy' ? '*' : ''}</td>
            <td className="px-3 py-3 text-right text-white tabular-nums">{money(row.calculationBeforePeriod ? null : row.payableUsd)}</td>
            <td className="px-3 py-3 text-right"><Link href={adminCommissionAuditHref(row.id, 'payments')} prefetch={false} className="text-[#FEEF00] tabular-nums">{money(row.referencedPaidUsd)} →</Link></td>
          </tr>)}</tbody></table></div>
        <div className="grid gap-3 lg:hidden">{view.rows.map(row => <article key={row.id} className="min-w-0 rounded-2xl border border-[#292937] bg-[#111117] p-3">
          <Link href={adminCommissionAuditHref(row.id, 'settlement')} prefetch={false} className="block break-words font-semibold text-white">{row.advisorName} · #{row.id} →</Link>
          <p className="my-1 text-xs text-[#A3A3AE]">Cálculo {dateFormat.format(new Date(row.calculationAt))}</p><RowStatus row={row} />
          <dl className="mt-3 grid grid-cols-2 gap-3">{[['Generada', row.calculationBeforePeriod ? null : row.grossUsd], ['Retenida', row.calculationBeforePeriod ? null : row.retainedUsd], ['Liquidación', row.calculationBeforePeriod ? null : row.payableUsd], ['Abonos identificados*', row.referencedPaidUsd]].map(([label, amount]) => <div key={String(label)} className="min-w-0"><dt className="text-[10px] text-[#A3A3AE]">{label}</dt><dd className="break-words font-semibold text-white tabular-nums">{money(amount === null ? null : Number(amount))}</dd></div>)}</dl>
          <Link href={adminCommissionAuditHref(row.id, 'payments')} prefetch={false} className="mt-2 inline-flex min-h-11 items-center text-sm text-[#FEEF00]">Revisar pagos →</Link>
        </article>)}</div>
      </>}
      <footer className="flex items-center justify-between gap-2 text-xs text-[#A3A3AE]">
        {view.page > 1 ? <Link href={href(selected, { page: view.page - 1 })} prefetch={false} className={`${control} inline-flex items-center`}>← Anterior</Link> : <span />}
        <span>Página {view.page} de {view.pages}</span>
        {view.page < view.pages ? <Link href={href(selected, { page: view.page + 1 })} prefetch={false} className={`${control} inline-flex items-center`}>Siguiente →</Link> : <span />}
      </footer>
    </>}
    {data.unmatchedPayments > 0 ? <p className="text-sm text-orange-200">{data.unmatchedPayments} abonos con referencia a cierre no identificado en la consulta completa.</p> : null}
    <details className="text-xs leading-relaxed text-[#A3A3AE]"><summary className="cursor-pointer py-2">Cómo leer las cifras</summary>
      <p className="mt-2">Generada es la comisión bruta guardada; una preliminar todavía puede cambiar. Retenida es el saldo retenido al corte de cálculo: puede incluir arrastre anterior y no debe sumarse entre períodos. Las retenciones antiguas estimadas llevan aviso. Liquidación es el importe del cierre antes de descontar pagos; solo queda conformado con la conformidad registrada. Las tarjetas respetan todos los filtros y páginas.</p>
      <p className="mt-2">* Abonos identificados: salidas confirmadas reconocidas por el formato de descripción del módulo actual, sin comisiones bancarias. No certifican el vínculo contable ni un saldo pendiente exacto. Ningún cero de esta columna demuestra ausencia de otros pagos. No se recalculan ni se modifican cierres desde esta vista.</p>
    </details>
  </div>;
}
