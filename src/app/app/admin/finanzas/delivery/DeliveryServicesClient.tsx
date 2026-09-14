'use client';

import { useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { deliveryServiceTotals, deliveryServicesCsv, serviceAmount, servicePayable, type DeliveryService } from '@/lib/admin-finance/delivery-services';
import { deliveryCombinedBatch, extraPayable, extraTotal, type DeliveryExtra, type DeliveryPayee } from '@/lib/admin-finance/delivery-extras';
import DeliveryExtrasPanel from './DeliveryExtrasPanel';
import { deliveryPeriodHref, deliveryWeekShortcuts, type DeliveryWeek } from '@/lib/admin-finance/delivery-period';
import DeliveryPaymentForm, { deliveryButton, deliveryInput, deliveryPrimaryButton, type DeliveryMoneyAccount, type DeliveryPaymentAttempt } from './DeliveryPaymentForm';

const usd = (n: number) => `$${n.toFixed(2)}`;
const shortDate = (date: string) => `${date.slice(8)}/${date.slice(5, 7)}`;
const panel = 'min-w-0 overflow-hidden rounded-lg border border-[#292937] bg-[#111117]';
const orderHref = (row: DeliveryService) => `/app/master/ops?openOrder=${row.id}&focusDate=${row.date}&tab=entrega`;

export default function DeliveryServicesClient({ rows, extras, payees, accounts, payments, from, to, today, initialMode, initialQuery, initialResponsible }: {
  extras: DeliveryExtra[]; payees: DeliveryPayee[];
  rows: DeliveryService[]; accounts: DeliveryMoneyAccount[]; from: string; to: string; today: string;
  payments: { request_id: string; responsible_name: string; responsible_key: string; total_usd: number; period_from: string; period_to: string; voided_at: string | null }[];
  initialMode: string; initialQuery: string; initialResponsible: string;
}) {
  const router = useRouter();
  const [mode, setMode] = useState(initialMode);
  const [responsible, setResponsible] = useState(initialResponsible);
  const [query, setQuery] = useState(initialQuery);
  const [page, setPage] = useState(1);
  const [partial, setPartial] = useState(false);
  const [selected, setSelected] = useState<number[]>([]);
  const [selectedExtras, setSelectedExtras] = useState<string[]>([]);
  const [editingExtra, setEditingExtra] = useState(false);
  const [paymentExtras, setPaymentExtras] = useState<DeliveryExtra[]>([]);
  const [paymentRows, setPaymentRows] = useState<DeliveryService[] | null>(null);
  const [receipt, setReceipt] = useState<{ id: string; movementId: number; total: number; orderIds: number[]; extraIds: string[] } | null>(null);
  const [pending, startTransition] = useTransition();
  const attempt = useRef<DeliveryPaymentAttempt>(null);
  const modeRows = rows.filter(row => mode === 'all' || row.mode === mode);
  const modeExtras = extras.filter(row => mode === 'all' || row.responsibleKey.startsWith(`${mode}:`));
  const options = Array.from(new Map([...payees.filter(p => mode === 'all' || p.key.startsWith(`${mode}:`)).map(p => [p.key, p.name] as const), ...modeExtras.map(r => [r.responsibleKey, r.responsible] as const), ...modeRows.filter(row => row.mode !== 'unassigned').map(row => [row.responsibleKey, row.responsible] as const)]).entries()).sort((a, b) => a[1].localeCompare(b[1]));
  const scopedExtras = modeExtras.filter(r => !responsible || r.responsibleKey === responsible);
  const extrasAmount = extraTotal(scopedExtras.filter(r => !r.voided));
  const extrasPaid = extraTotal(scopedExtras.filter(r => !!r.paymentId));
  const scoped = modeRows.filter(row => !responsible || row.responsibleKey === responsible);
  const visible = scoped.filter(row => `${row.orderNumber} ${row.client} ${row.responsible}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const totals = deliveryServiceTotals(scoped);
  const periodBatch = deliveryCombinedBatch(modeRows, modeExtras, responsible);
  const batch = partial ? deliveryCombinedBatch(modeRows, modeExtras, responsible, selected, selectedExtras) : periodBatch;
  const recentlyPaid = batch.rows.some(row => receipt?.orderIds.includes(row.id)) || batch.extras.some(row => receipt?.extraIds.includes(row.id));
  const locked = pending || paymentRows !== null || editingExtra;
  const pages = Math.max(1, Math.ceil(visible.length / 30));
  const currentPage = Math.min(page, pages);
  const weeks = deliveryWeekShortcuts(today, from, to);
  const paymentHistory = payments.filter(p => (!responsible || p.responsible_key === responsible) && (mode === 'all' || p.responsible_key.startsWith(`${mode}:`)));
  const selectedIds = new Set(selected);

  function resetSelection() { setPage(1); setSelected([]); setSelectedExtras([]); }
  function openWeek(week: DeliveryWeek) {
    startTransition(() => router.push(deliveryPeriodHref(week, { mode, responsible, query })));
  }
  function exportCsv() {
    const url = URL.createObjectURL(new Blob([deliveryServicesCsv(visible)], { type: 'text/csv;charset=utf-8;' }));
    const anchor = document.createElement('a');
    anchor.href = url; anchor.download = `delivery-${from}-${to}.csv`; anchor.click(); URL.revokeObjectURL(url);
  }
  function beginPayment() {
    if (!locked && !batch.error && !recentlyPaid) { setPaymentRows(batch.rows); setPaymentExtras(batch.extras); }
  }

  return <div className="space-y-3">
    <fieldset disabled={locked} className={`${panel} space-y-2 p-3`}>
      <nav aria-label="Semanas de delivery" className="flex flex-wrap items-center gap-2 text-xs">
        <span className="mr-auto font-medium">{shortDate(from)} – {shortDate(to)} · {weeks.isWeekly ? 'Lun–dom' : 'Personalizado'}</span>
        {weeks.isWeekly ? <button type="button" aria-label="Semana anterior" onClick={() => openWeek(weeks.previous)} className={deliveryButton}>←</button> : null}
        <button type="button" disabled={from === weeks.lastComplete.from && to === weeks.lastComplete.to} onClick={() => openWeek(weeks.lastComplete)} className={deliveryButton}>Última semana</button>
        <button type="button" disabled={from === weeks.current.from && to === weeks.current.to} onClick={() => openWeek(weeks.current)} className={deliveryButton}>Esta semana</button>
        {weeks.isWeekly && from < weeks.current.from ? <button type="button" aria-label="Semana siguiente" onClick={() => openWeek(weeks.next)} className={deliveryButton}>→</button> : null}
      </nav>
      <form className="grid grid-cols-2 items-end gap-2 md:grid-cols-[140px_140px_auto_110px_minmax(160px,1fr)]">
        <label className="grid gap-1 text-xs">Desde<input type="date" name="from" required defaultValue={from} className={deliveryInput} /></label>
        <label className="grid gap-1 text-xs">Hasta<input type="date" name="to" required defaultValue={to} className={deliveryInput} /></label>
        <button className={deliveryButton}>Consultar período</button>
        <label className="grid gap-1 text-xs">Tipo<select name="mode" value={mode} onChange={e => { setMode(e.target.value); setResponsible(''); setQuery(''); setPartial(false); resetSelection(); }} className={deliveryInput}>
          <option value="all">Todos</option><option value="internal">Internos</option><option value="external">Externos</option><option value="unassigned">Sin asignar</option></select></label>
        <label className="col-span-2 grid gap-1 text-xs md:col-span-1">Motorizado o empresa<select name="responsible" value={responsible} onChange={e => { setResponsible(e.target.value); setQuery(''); setPartial(false); resetSelection(); }} className={deliveryInput}>
          <option value="">Todos los responsables</option>{options.map(([key, name]) => <option key={key} value={key}>{name}</option>)}</select></label>
        <input type="hidden" name="q" value={query} />
      </form>
    </fieldset>

    <section aria-label="Resumen del período" className={`${panel} p-3`}>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
        {[['Entregas', totals.deliveries], ['Total servicios', `${usd(totals.amount + extrasAmount)}${totals.proposed ? '*' : ''}`], ['Pagos registrados', usd(totals.paid + extrasPaid)], ['Por registrar', `${usd(totals.unlinked + extraTotal(scopedExtras.filter(extraPayable)))}${totals.proposed ? '*' : ''}`]].map(([label, value]) => <div key={label}><dt className="text-[11px] text-[#B9B9C4]">{label}</dt><dd className="mt-0.5 text-lg font-semibold tabular-nums">{value}</dd></div>)}
      </dl>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-[#292937] pt-2">
        <div className="text-xs"><span className="font-medium">{responsible ? options.find(([key]) => key === responsible)?.[1] || 'Responsable seleccionado' : 'Selecciona un motorizado o empresa'}</span>
          {totals.missing ? <p className="mt-1 text-amber-200">Total parcial: {totals.missing} entregas sin costo.</p> : null}
          {batch.error && responsible ? <p className="mt-1 text-[#B9B9C4]">{batch.error}</p> : null}</div>
        <div className="flex flex-wrap items-center gap-2">
          {!partial && responsible ? <button type="button" disabled={locked} onClick={() => { setPartial(true); resetSelection(); }} className={deliveryButton}>Pagar algunas entregas</button> : null}
          {partial ? <button type="button" disabled={locked} onClick={() => { setPartial(false); resetSelection(); }} className={deliveryButton}>Volver al período completo</button> : null}
          <button type="button" disabled={locked || !!batch.error || recentlyPaid} onClick={beginPayment} className={deliveryPrimaryButton}>{partial ? `Pagar selección${selected.length ? ` · ${usd(batch.total)}` : ''}` : `Pagar período${!periodBatch.error ? ` · ${usd(periodBatch.total)}` : ''}`}</button>
        </div>
      </div>
      {totals.proposed ? <p className="mt-2 text-[11px] text-amber-100">* {totals.proposed} entregas usan la tarifa actual del tabulador porque no tenían costo guardado. La confirmarás al registrar el pago.</p> : null}
    </section>

    {receipt ? <div role="status" className="rounded-lg border border-emerald-500/30 px-3 py-2 text-xs text-emerald-200">Pago registrado: {usd(receipt.total)} · {receipt.orderIds.length} entregas · {receipt.extraIds.length} servicios adicionales. <Link href={`/app/admin/finanzas/delivery/pagos/${receipt.id}`} prefetch={false} className="underline">Ver comprobante · egreso #{receipt.movementId} →</Link></div> : null}
    {paymentRows ? <DeliveryPaymentForm rows={paymentRows} extras={paymentExtras} accounts={accounts} from={from} to={to} today={today} partial={partial} attempt={attempt}
      onClose={() => setPaymentRows(null)} onPaid={result => { setReceipt({ ...result, orderIds: paymentRows.map(row => row.id), extraIds: paymentExtras.map(row => row.id) }); setPaymentRows(null); setSelected([]); setSelectedExtras([]); setPartial(false); router.refresh(); }} /> : null}

    <DeliveryExtrasPanel rows={scopedExtras} payees={payees} responsible={responsible} today={today} from={from} to={to} locked={locked}
      partial={partial} selected={selectedExtras} onSelected={setSelectedExtras} onEditing={setEditingExtra} />

    <section className={panel}>
      <div className="flex flex-wrap items-center gap-2 border-b border-[#292937] px-3 py-2">
        <h2 className="mr-auto text-sm font-semibold">Entregas · {visible.length}{visible.length !== scoped.length ? ` de ${scoped.length}` : ''}</h2>
        <input aria-label="Buscar orden o cliente" placeholder="Orden o cliente" value={query} maxLength={80} disabled={locked} onChange={e => { setQuery(e.target.value); resetSelection(); }} className={`${deliveryInput} w-44`} />
        {query ? <button type="button" disabled={locked} onClick={() => { setQuery(''); resetSelection(); }} className={deliveryButton}>Limpiar búsqueda</button> : null}
        <button type="button" onClick={exportCsv} className={deliveryButton}>Descargar CSV</button>
      </div>
      {visible.length !== scoped.length ? <p className="px-3 py-2 text-[11px] text-[#B9B9C4]">La búsqueda solo filtra esta tabla. «Pagar período» incluye todas las entregas pendientes del responsable en estas fechas.</p> : null}
      {partial ? <div className="flex flex-wrap items-center gap-3 px-3 py-2 text-xs"><span>{selected.length} entregas elegidas · {usd(batch.total)}</span><button type="button" disabled={locked || !responsible} onClick={() => setSelected(visible.filter(servicePayable).slice(0, 500).map(row => row.id))} className="min-h-9 underline">Elegir las visibles (máx. 500)</button><button type="button" disabled={locked} onClick={() => setSelected([])} className="min-h-9 underline">Quitar selección</button></div> : null}
      <div role="region" aria-label="Detalle de entregas" tabIndex={0} className="max-h-[560px] overflow-auto focus-visible:outline-2 focus-visible:outline-[#FEEF00]">
        <table className="w-full min-w-[470px] text-left text-xs"><thead className="sticky top-0 z-10 bg-[#191920] text-[11px] text-[#B9B9C4]"><tr>
          {partial ? <th scope="col" className="w-10 px-2 py-2">Elegir</th> : null}
          <th scope="col" className="px-3 py-2">Fecha</th><th scope="col" className="px-3 py-2">Orden</th><th scope="col" className="px-3 py-2">Cliente</th>
          {!responsible ? <th scope="col" className="px-3 py-2">Responsable</th> : null}<th scope="col" className="px-3 py-2 text-right">Pago USD</th><th scope="col" className="px-3 py-2">Estado</th>
        </tr></thead><tbody>{visible.slice((currentPage - 1) * 30, currentPage * 30).map(row => <tr key={row.id} className="border-t border-[#24242E] even:bg-white/[0.02] hover:bg-white/[0.04]">
          {partial ? <td className="px-2"><label className="flex min-h-11 min-w-8 items-center justify-center md:min-h-8"><input type="checkbox" aria-label={`Incluir orden ${row.orderNumber} en el pago`} disabled={locked || !servicePayable(row) || row.responsibleKey !== responsible} checked={selectedIds.has(row.id)} onChange={e => setSelected(prev => e.target.checked ? [...prev, row.id] : prev.filter(id => id !== row.id))} /></label></td> : null}
          <td className="whitespace-nowrap px-3 py-1.5 text-[#B9B9C4]">{shortDate(row.date)}</td>
          <td className="px-3 py-1.5"><Link href={orderHref(row)} prefetch={false} className="inline-flex min-h-8 items-center underline md:min-h-5">#{row.orderNumber}</Link></td>
          <td title={row.client} className="max-w-60 truncate px-3 py-1.5">{row.client}</td>
          {!responsible ? <td className="px-3 py-1.5">{row.responsible}</td> : null}
          <td className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums">{serviceAmount(row) === null ? <Link href={orderHref(row)} prefetch={false} className="text-amber-200 underline">Definir costo</Link> : <>{usd(serviceAmount(row)!)}{!row.payment && row.cost.stored === null ? <span className="text-amber-100" title="Tarifa actual del tabulador; pendiente de confirmar">*</span> : null}</>}</td>
          <td className="whitespace-nowrap px-3 py-1.5">{row.payment ? <Link href={`/app/admin/finanzas/delivery/pagos/${row.payment.id}`} prefetch={false} className="text-emerald-300 underline">Pagado · #{row.payment.movementId}</Link> : row.legacyPaid ? <span className="text-emerald-300">Pago anterior</span> : <span className="text-[#A7A7B2]">Sin registro</span>}</td>
        </tr>)}</tbody></table>
        {!visible.length ? <p className="px-3 py-5 text-xs text-[#B9B9C4]">No hay entregas con estos filtros.</p> : null}
      </div>
      <nav className="flex items-center justify-between gap-2 border-t border-[#292937] px-3 py-1 text-xs" aria-label="Páginas de entregas"><button className="min-h-9" disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)}>← Anterior</button><span>{currentPage} / {pages} · {visible.length} entregas</span><button className="min-h-9" disabled={currentPage === pages} onClick={() => setPage(currentPage + 1)}>Siguiente →</button></nav>
    </section>
    <details className={`${panel} px-3 py-2`}>
      <summary className="cursor-pointer text-xs font-medium">Pagos del período · {paymentHistory.length} registros recientes</summary>
      <p className="mt-2 text-[11px] text-[#B9B9C4]">Máximo 30 registros recientes. Si pagaste desde otra pantalla, usa «Ya registré el egreso» al pagar el período para no duplicarlo.</p>
      {paymentHistory.map(p => <Link key={p.request_id} href={`/app/admin/finanzas/delivery/pagos/${p.request_id}`} prefetch={false} className="mt-1 flex min-h-9 items-center justify-between gap-3 border-b border-[#292937] text-xs"><span>{p.responsible_name} · {shortDate(p.period_from)}–{shortDate(p.period_to)}</span><span>{usd(Number(p.total_usd))} · {p.voided_at ? 'Anulado' : 'Registrado'} →</span></Link>)}
      {!paymentHistory.length ? <p className="mt-2 text-xs text-[#9B9BA7]">Sin pagos registrados aquí para este período y responsable.</p> : null}
    </details>
  </div>;
}
