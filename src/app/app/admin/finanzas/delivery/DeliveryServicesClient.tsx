'use client';
import { useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { deliveryServiceTotals, deliveryServicesCsv, serviceAmount, servicePayable, type DeliveryService } from '@/lib/admin-finance/delivery-services';
import { deliveryPeriodHref, deliveryWeekShortcuts, type DeliveryWeek } from '@/lib/admin-finance/delivery-period';
import { recordDeliveryPayment, type DeliveryPaymentInput } from './actions';
import { adminInput, adminPanel, AdminKpi } from '../../_components/AdminReadUi';

type Account = { id: number; name: string; currency_code: string };
const usd = (n: number) => `$${n.toFixed(2)}`;
export default function DeliveryServicesClient({ rows, accounts, payments, from, to, today, initialMode, initialQuery, initialResponsible }: {
  rows: DeliveryService[]; accounts: Account[]; from: string; to: string; today: string;
  payments: { request_id: string; responsible_name: string; responsible_key: string; total_usd: number; period_from: string; period_to: string; voided_at: string | null }[];
  initialMode: string; initialQuery: string; initialResponsible: string;
}) {
  const router = useRouter();
  const [mode, setMode] = useState(initialMode), [responsible, setResponsible] = useState(initialResponsible);
  const [query, setQuery] = useState(initialQuery), [page, setPage] = useState(1), [selected, setSelected] = useState<number[]>([]);
  const [accountId, setAccountId] = useState(''), [rate, setRate] = useState(''), [method, setMethod] = useState('new');
  const [message, setMessage] = useState(''), [pending, startTransition] = useTransition();
  const attempt = useRef<{ id: string; payload: string } | null>(null);
  const submitting = useRef(false);
  const modeRows = rows.filter(row => mode === 'all' || row.mode === mode);
  const options = Array.from(new Map(modeRows.filter(row => row.mode !== 'unassigned').map(row => [row.responsibleKey, row.responsible])).entries()).sort((a, b) => a[1].localeCompare(b[1]));
  const visible = modeRows.filter(row => (!responsible || row.responsibleKey === responsible)
    && `${row.orderNumber} ${row.id} ${row.client} ${row.responsible}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const totals = deliveryServiceTotals(visible);
  const selectedRows = visible.filter(row => selected.includes(row.id) && servicePayable(row));
  const selectedTotal = deliveryServiceTotals(selectedRows).amount;
  const proposed = selectedRows.some(row => row.cost.stored === null);
  const sameResponsible = new Set(selectedRows.map(row => row.responsibleKey)).size === 1;
  const account = accounts.find(row => String(row.id) === accountId);
  const native = account?.currency_code === 'VES' ? selectedTotal * Number(rate || 0) : selectedTotal;
  const pages = Math.max(1, Math.ceil(visible.length / 30));
  const currentPage = Math.min(page, pages);
  const weeks = deliveryWeekShortcuts(today, from, to);
  function openWeek(week: DeliveryWeek) {
    startTransition(() => router.push(deliveryPeriodHref(week, { mode, responsible, query })));
  }
  function resetSelection() { setPage(1); setSelected([]); }
  function exportCsv() {
    const url = URL.createObjectURL(new Blob([deliveryServicesCsv(visible)], { type: 'text/csv;charset=utf-8;' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `delivery-${from}-${to}.csv`; anchor.click(); URL.revokeObjectURL(url);
  }
  function submit(form: FormData) {
    if (submitting.current || !selectedRows.length || !sameResponsible) return;
    const input: DeliveryPaymentInput = { from, to, paymentDate: String(form.get('paymentDate')), items: selectedRows.map(row => ({ id: row.id, fingerprint: row.cost.fingerprint })),
      accountId: method === 'new' ? Number(accountId) : null, amount: method === 'new' ? Number(form.get('amount')) : null,
      rate: method === 'new' && account?.currency_code === 'VES' ? Number(rate) : null,
      existingMovementId: method === 'existing' ? Number(form.get('existingMovementId')) : null,
      reference: String(form.get('reference') || ''), notes: String(form.get('notes') || ''),
      confirmedUnpaid: form.get('confirmedUnpaid') === 'on', confirmTariffs: form.get('confirmTariffs') === 'on' };
    const payload = JSON.stringify(input);
    if (!attempt.current || attempt.current.payload !== payload) attempt.current = { id: crypto.randomUUID(), payload };
    const requestId = attempt.current.id;
    submitting.current = true; setMessage('');
    startTransition(async () => {
      try {
        const result = await recordDeliveryPayment(requestId, input);
        if (!result.ok) { setMessage(result.message); return; }
        setMessage(`Pago vinculado al egreso #${result.movementId} por ${usd(result.totalUsd)}.`);
        setSelected([]); attempt.current = null; router.refresh();
      } catch { setMessage('No se pudo confirmar la respuesta. Reintenta sin cambiar los datos para verificar el mismo envío.'); }
      finally { submitting.current = false; }
    });
  }
  return <div className="space-y-4">
    <nav aria-label="Semanas de delivery" className="flex flex-wrap items-center gap-2 text-xs">
      <span className="mr-2 text-[#B9B9C4]">{weeks.isWeekly ? 'Lunes a domingo' : 'Período personalizado'}</span>
      {weeks.isWeekly ? <button type="button" disabled={pending} onClick={() => openWeek(weeks.previous)} className={adminInput}>← Semana anterior</button> : null}
      <button type="button" disabled={pending || (from === weeks.lastComplete.from && to === weeks.lastComplete.to)} onClick={() => openWeek(weeks.lastComplete)} className={`${adminInput} disabled:opacity-50`}>Última semana completa</button>
      <button type="button" disabled={pending || (from === weeks.current.from && to === weeks.current.to)} onClick={() => openWeek(weeks.current)} className={`${adminInput} disabled:opacity-50`}>Esta semana</button>
      {weeks.isWeekly && from < weeks.current.from ? <button type="button" disabled={pending} onClick={() => openWeek(weeks.next)} className={adminInput}>Semana siguiente →</button> : null}
    </nav>
    <form className="flex flex-wrap items-end gap-3">
      <label className="grid gap-1 text-xs">Desde<input type="date" name="from" required defaultValue={from} className={adminInput} /></label>
      <label className="grid gap-1 text-xs">Hasta<input type="date" name="to" required defaultValue={to} className={adminInput} /></label>
      <input type="hidden" name="mode" value={mode} /><input type="hidden" name="responsible" value={responsible} />
      <input type="hidden" name="q" value={query} />
      <button className={adminInput} disabled={pending}>Consultar período</button>
    </form>
    <fieldset disabled={pending} className="flex flex-wrap gap-3">
      <label className="grid gap-1 text-xs">Tipo<select value={mode} onChange={e => { setMode(e.target.value); setResponsible(''); resetSelection(); }} className={adminInput}>
        <option value="all">Todos</option><option value="internal">Internos</option><option value="external">Externos</option><option value="unassigned">Sin asignar</option></select></label>
      <label className="grid min-w-48 gap-1 text-xs">Motorizado o empresa<select value={responsible} onChange={e => { setResponsible(e.target.value); resetSelection(); }} className={adminInput}>
        <option value="">Todos los responsables</option>{options.map(([key, name]) => <option key={key} value={key}>{name}</option>)}</select></label>
      <label className="grid flex-1 gap-1 text-xs">Buscar orden o cliente<input value={query} maxLength={80} onChange={e => { setQuery(e.target.value); resetSelection(); }} className={adminInput} /></label>
    </fieldset>
    <section className="grid grid-cols-2 gap-3 xl:grid-cols-4" aria-label="Resumen del período">
      <AdminKpi label="Entregas" value={totals.deliveries} hint={`${from} al ${to}`} />
      <AdminKpi label="Costo de servicios" value={usd(totals.amount)} hint={totals.missing ? `Parcial · ${totals.missing} sin costo` : `${totals.proposed} con tarifa por confirmar`} />
      <AdminKpi label="Pagos vinculados" value={usd(totals.paid)} hint="Registrados en este módulo" />
      <AdminKpi label="Sin pago vinculado" value={usd(totals.unlinked)} hint="Revisar pagos anteriores antes de pagar" />
    </section>
    <section className={adminPanel}>
      <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-sm font-semibold">Relación de servicios</h2><button type="button" onClick={exportCsv} className="min-h-11 text-xs underline">Descargar relación CSV</button></div>
      <p className="mb-3 text-xs text-[#B9B9C4]">«Propuesto» usa el tabulador actual. Selecciona un responsable y las entregas que vas a pagar.</p>
      <button type="button" disabled={pending || !responsible} onClick={() => setSelected(visible.filter(servicePayable).slice(0, 500).map(row => row.id))} className="mb-2 min-h-11 text-xs underline disabled:opacity-40">Seleccionar entregas sin pago vinculado (máx. 500)</button>
      {selectedRows.length ? <a href="#registrar-pago" className="ml-3 inline-flex min-h-11 items-center text-sm text-[#FEEF00] underline">{selectedRows.length} seleccionadas · {usd(selectedTotal)} · Revisar pago ↓</a> : null}
      <div className="overflow-x-auto"><table className="w-full text-left text-xs"><thead className="text-[#B9B9C4]"><tr>{['Elegir', 'Fecha', 'Orden / cliente', 'Responsable', 'Costo USD', 'Pago'].map(label => <th key={label} className="px-2 py-3">{label}</th>)}</tr></thead>
        <tbody>{visible.slice((currentPage - 1) * 30, currentPage * 30).map(row => <tr key={row.id} className="border-t border-[#292937]">
          <td className="px-2"><label className="flex min-h-11 min-w-11 items-center justify-center"><input type="checkbox" aria-label={`Seleccionar orden ${row.orderNumber}`} disabled={pending || !servicePayable(row)} checked={selectedRows.some(x => x.id === row.id)} onChange={e => setSelected(prev => e.target.checked ? [...prev, row.id] : prev.filter(id => id !== row.id))} /></label></td>
          <td className="whitespace-nowrap px-2 py-3">{row.date.slice(8)}/{row.date.slice(5, 7)}</td>
          <td className="px-2 py-3"><Link href={`/app/master/ops?openOrder=${row.id}&focusDate=${row.date}&tab=entrega`} prefetch={false} className="inline-flex min-h-11 items-center underline">#{row.orderNumber}</Link><p>{row.client}</p></td>
          <td className="px-2 py-3">{row.responsible}<p className="text-[#9B9BA7]">{row.mode === 'internal' ? 'Interno' : row.mode === 'external' ? 'Externo' : 'Sin asignar'}</p></td>
          <td className="px-2 py-3 tabular-nums">{serviceAmount(row) === null ? 'Pendiente' : usd(serviceAmount(row)!)}<p className="mt-1 text-[#9B9BA7]">{row.payment ? 'Confirmado al pagar' : row.cost.stored !== null ? 'Guardado' : row.cost.proposed !== null ? 'Propuesto' : row.cost.reason}</p>
            {serviceAmount(row) === null ? <Link href={`/app/master/ops?openOrder=${row.id}&focusDate=${row.date}&tab=entrega`} prefetch={false} className="inline-flex min-h-11 items-center underline">Completar costo</Link> : null}</td>
          <td className="px-2 py-3">{row.payment ? <Link href={`/app/admin/finanzas/delivery/pagos/${row.payment.id}`} prefetch={false} className="underline">Egreso #{row.payment.movementId}<span className="block text-[#9B9BA7]">{row.payment.date}</span></Link> : row.legacyPaid ? 'Pagado · registro anterior' : 'Sin vínculo'}</td>
        </tr>)}</tbody></table></div>
      {!visible.length ? <p className="py-6 text-sm">No hay entregas con estos filtros.</p> : null}
      <nav className="mt-3 flex items-center justify-between text-xs" aria-label="Páginas de entregas"><button className="min-h-11" disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)}>← Anterior</button><span>{currentPage} / {pages} · {visible.length} entregas</span><button className="min-h-11" disabled={currentPage === pages} onClick={() => setPage(currentPage + 1)}>Siguiente →</button></nav>
    </section>
    {message ? <p role="status" className={`${adminPanel} text-sm`}>{message}</p> : null}
    {selectedRows.length ? <form id="registrar-pago" action={submit} className={adminPanel}>
      <fieldset disabled={pending} className="space-y-4"><h2 className="text-sm font-semibold">Registrar pago · {selectedRows.length} entregas · {usd(selectedTotal)}</h2>
        {!sameResponsible ? <p role="alert" className="text-sm text-orange-200">Selecciona un solo motorizado o empresa por pago.</p> : <p className="text-sm">{selectedRows[0].responsible}</p>}
        <label className="grid max-w-md gap-1 text-xs">Operación<select value={method} onChange={e => setMethod(e.target.value)} className={adminInput}><option value="new">Registrar nuevo egreso</option><option value="existing">Vincular un egreso ya registrado (no sacar dinero otra vez)</option></select></label>
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="grid gap-1 text-xs">Fecha del pago<input name="paymentDate" type="date" defaultValue={today} max={today} required className={adminInput} /></label>
          {method === 'existing' ? <label className="grid gap-1 text-xs">Número del egreso existente<input name="existingMovementId" type="number" min="1" step="1" required className={adminInput} /></label> : <>
            <label className="grid gap-1 text-xs">Cuenta de salida<select value={accountId} onChange={e => setAccountId(e.target.value)} required className={adminInput}><option value="">Seleccionar cuenta</option>{accounts.map(a => <option value={a.id} key={a.id}>{a.name} · {a.currency_code}</option>)}</select></label>
            {account?.currency_code === 'VES' ? <label className="grid gap-1 text-xs">Tasa de este pago (Bs/USD)<input value={rate} onChange={e => setRate(e.target.value)} type="number" min="0.000001" step="any" required className={adminInput} /></label> : null}
            <label className="grid gap-1 text-xs">Monto a registrar · {account?.currency_code || 'USD'}<input key={`${accountId}-${rate}-${selectedTotal}`} name="amount" type="number" min="0.01" max="1000000000" step="0.01" defaultValue={native.toFixed(2)} required className={adminInput} /></label>
          </>}
          <label className="grid gap-1 text-xs">Referencia<input name="reference" maxLength={120} className={adminInput} /></label>
          <label className="grid gap-1 text-xs">Nota (opcional)<input name="notes" maxLength={500} className={adminInput} /></label>
        </div>
        {proposed ? <label className="flex min-h-11 items-center gap-3 text-xs"><input name="confirmTariffs" type="checkbox" required />Confirmo que las tarifas propuestas corresponden a este período.</label> : null}
        <label className="flex min-h-11 items-center gap-3 text-xs"><input name="confirmedUnpaid" type="checkbox" required />Revisé los pagos anteriores: esta selección no duplica un pago.</label>
        <p className="text-xs text-[#9B9BA7]">{method === 'new' ? 'Registra el pago realizado fuera de la aplicación y su egreso en la cuenta. No envía una transferencia bancaria.' : 'El egreso debe coincidir exactamente con el total USD. No se crea otro movimiento de dinero.'}</p>
        <button disabled={!sameResponsible || selectedRows.length > 500 || selectedTotal <= 0} className={`${adminInput} font-semibold`}>{pending ? 'Registrando…' : method === 'new' ? `Confirmar egreso de ${usd(selectedTotal)}` : 'Vincular egreso existente'}</button>
      </fieldset>
    </form> : null}
    <section className={adminPanel}><h2 className="text-sm font-semibold">Registros recientes · máximo 30</h2>
      {payments.filter(p => (!responsible || p.responsible_key === responsible) && (mode === 'all' || p.responsible_key.startsWith(`${mode}:`))).map(p => <Link key={p.request_id} href={`/app/admin/finanzas/delivery/pagos/${p.request_id}`} prefetch={false} className="flex min-h-14 items-center justify-between gap-3 border-b border-[#292937] py-3 text-xs"><span>{p.responsible_name} · {p.period_from} al {p.period_to}</span><span>{usd(Number(p.total_usd))} · {p.voided_at ? 'Anulado' : 'Vinculado'} →</span></Link>)}
      {!payments.length ? <p className="mt-3 text-xs text-[#9B9BA7]">Todavía no hay pagos vinculados a este período desde este módulo.</p> : null}
    </section>
  </div>;
}
