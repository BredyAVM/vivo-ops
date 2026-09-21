'use client';
import Link from 'next/link';
import { useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { eventRequestLabel, eventOrderLabel, summarizeEventOrders, type EventWorkspace, type EventTerms, type EventRate, type EventRequest } from '@/lib/events/event-workspace';
import { eventWorkspaceCommand } from '../workspace-actions';
import EventPayments from './EventPayments';
import type { EventPaymentData } from '@/lib/events/event-payments';

const field = 'w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm';
const button = 'rounded-lg border border-zinc-700 px-3 py-2 text-sm disabled:opacity-40';
const money = (value: number | null, currency = 'USD') => value == null ? 'Por definir' : `${currency === 'VES' ? 'Bs' : '$'} ${Number(value).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const emptyTerms: EventTerms = { currency: 'USD', commission_mode: 'default', commission_value: null, rates: [] };

export default function EventWorkspaceClient({ data, payments, paymentError, admin, master }: { data: EventWorkspace; payments: EventPaymentData | null; paymentError?: string; admin: boolean; master: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [showRequest, setShowRequest] = useState(false);
  const [items, setItems] = useState<{ product_id: number; qty: number }[]>([]);
  const [productId, setProductId] = useState('');
  const [qty, setQty] = useState('1');
  const [search, setSearch] = useState('');
  const [date, setDate] = useState(data.root.payload.event_budget.event_date || '');
  const [time, setTime] = useState(data.root.payload.event_budget.event_time || '12:00');
  const [fulfillment, setFulfillment] = useState('pickup');
  const [address, setAddress] = useState(data.root.payload.event_budget.delivery_address || '');
  const [note, setNote] = useState('');
  const requestKey = useRef<string | null>(null);
  const [terms, setTerms] = useState<EventTerms>(data.root.payload.event_terms ?? emptyTerms);
  const totals = summarizeEventOrders(data.orders, data.root.converted_order_id);
  const rates = data.root.payload.event_terms?.rates ?? [];
  const selectedRate = rates.find(rate => rate.product_id === Number(productId));
  const initialIds = new Set(data.root.payload.event_budget.components?.map(x => Number(x.product_id)) ?? []);
  const products = [...data.products].sort((a, b) => Number(initialIds.has(b.id)) - Number(initialIds.has(a.id)) || a.name.localeCompare(b.name, 'es'));
  const filtered = products.filter(p => p.name.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  const orderHref = (id: number) => master ? `/app/master/ops?openOrder=${id}` : `/app/advisor/orders/${id}`;
  function command(action: string, input: Record<string, unknown>, done?: () => void) {
    setError(''); setMessage('');
    startTransition(async () => {
      try {
        const result = await eventWorkspaceCommand(data.root.id, action, input);
        if (!result.ok) { setError(result.error); return; }
        setMessage(action === 'approve' ? 'Orden creada. Ábrela para continuar con cocina y entrega.' : 'Guardado.');
        done?.(); router.refresh();
      } catch { setError('No se pudo confirmar la operación. Puedes reintentar; la solicitud no se duplicará.'); }
    });
  }
  function addItem() {
    const id = Number(productId), quantity = Number(qty);
    if (!id || !Number.isInteger(quantity) || quantity <= 0) { setError('Selecciona un producto y una cantidad entera positiva.'); return; }
    requestKey.current = null;
    setItems(current => current.some(x => x.product_id === id) ? current.map(x => x.product_id === id ? { ...x, qty: x.qty + quantity } : x) : [...current, { product_id: id, qty: quantity }]);
    setProductId(''); setQty('1');
  }
  return <main className="mx-auto max-w-5xl space-y-4 p-4 sm:p-6">
    <header className="flex items-start justify-between gap-3"><div><Link href="/app/events/ongoing" className="text-sm text-zinc-400">← Eventos</Link><h1 className="mt-2 text-2xl font-bold">{data.root.title}</h1></div>
      <button className={button} onClick={() => router.refresh()}>Actualizar</button></header>
    {error ? <p role="alert" className="rounded-lg bg-red-950/50 p-3 text-red-200">{error}</p> : null}
    {message ? <p role="status" className="text-emerald-300">{message}</p> : null}
    <section className="grid grid-cols-2 gap-2 sm:grid-cols-4" aria-label="Resumen del evento">
      {[['Total del evento', totals.total], ['Adicionales', totals.additions], ['Pagado', totals.paid], ['Pendiente', totals.pending]].map(([label, value]) => <div key={label} className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-3"><p className="text-xs text-zinc-400">{label}</p><strong className="text-xl">{money(Number(value))}</strong></div>)}
    </section>
    <p className="text-xs text-zinc-400">Resumen equivalente en USD. Cada orden conserva su moneda y tasa. Las solicitudes pendientes y rechazadas no se suman.</p>
    {totals.overpaid > 0 ? <p className="text-sm text-amber-300">Hay {money(totals.overpaid)} de excedente por conciliar; no se trasladó automáticamente entre órdenes.</p> : null}
    {!data.root.converted_order_id ? <p>Administración debe convertir el presupuesto inicial antes de solicitar ampliaciones.</p> : data.root.payload.event_state?.closed ? <p className="text-amber-300">Evento cerrado para nuevas ampliaciones. La cobranza sigue disponible.</p> :
      <button className="rounded-xl bg-yellow-300 px-4 py-3 font-semibold text-black" onClick={() => setShowRequest(!showRequest)}>Solicitar ampliación</button>}
    {showRequest ? <section className="space-y-3 rounded-xl border border-zinc-700 p-4">
      <h2 className="font-semibold">¿Qué necesita el cliente?</h2>
      <div className="grid gap-2 sm:grid-cols-[1fr_110px_auto]">
        <div><input aria-label="Buscar producto" placeholder="Buscar producto" value={search} onChange={e => setSearch(e.target.value)} className={field} />
          <select aria-label="Producto" className={`${field} mt-2`} value={productId} onChange={e => setProductId(e.target.value)}><option value="">Seleccionar producto</option>{filtered.map(p => <option key={p.id} value={p.id}>{initialIds.has(p.id) ? '★ ' : ''}{p.name}</option>)}</select></div>
        <label className="text-xs">Cantidad · {selectedRate?.unit ?? 'por definir'}<input type="number" min="1" step="1" value={qty} onChange={e => setQty(e.target.value)} className={`${field} mt-1`} /></label>
        <button disabled={pending} className={button} onClick={addItem}>Agregar</button>
      </div>
      {items.map(item => { const rate = rates.find(r => r.product_id === item.product_id); return <div key={item.product_id} className="flex items-center justify-between gap-3 border-b border-zinc-800 py-2 text-sm"><span>{item.qty} {rate?.unit ?? '(unidad pendiente de definir)'} · {products.find(p => p.id === item.product_id)?.name}<small className="ml-2 text-zinc-400">{rate ? money(rate.price * item.qty, data.root.payload.event_terms?.currency) : 'Requiere precio de Administración'}</small></span><button aria-label="Quitar producto" className={button} onClick={() => { requestKey.current = null; setItems(items.filter(x => x.product_id !== item.product_id)); }}>Quitar</button></div>; })}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3"><label className="text-xs">Fecha<input type="date" className={`${field} mt-1`} value={date} onChange={e => { requestKey.current = null; setDate(e.target.value); }} /></label><label className="text-xs">Hora<input type="time" className={`${field} mt-1`} value={time} onChange={e => { requestKey.current = null; setTime(e.target.value); }} /></label><label className="text-xs">Entrega<select className={`${field} mt-1`} value={fulfillment} onChange={e => { requestKey.current = null; setFulfillment(e.target.value); }}><option value="pickup">Retiro / transporte propio</option><option value="delivery">Nuevo viaje de delivery</option></select></label></div>
      {fulfillment === 'delivery' ? <label className="block text-xs">Dirección<input className={`${field} mt-1`} value={address} onChange={e => { requestKey.current = null; setAddress(e.target.value); }} /><span className="text-zinc-400">Incluye el producto de delivery correspondiente. Un viaje por ampliación.</span></label> : null}
      <label className="block text-xs">Indicaciones<textarea className={`${field} mt-1`} value={note} onChange={e => { requestKey.current = null; setNote(e.target.value); }} /></label>
      <button disabled={pending || !items.length} className={button} onClick={() => { requestKey.current ??= crypto.randomUUID(); command('request', { request_id: requestKey.current, items, date, time, fulfillment, address, note }, () => { setShowRequest(false); setItems([]); requestKey.current = null; }); }}>Enviar solicitud</button>
    </section> : null}
    <section className="space-y-2"><h2 className="font-semibold">Ampliaciones</h2>
      {data.requests.length === 0 ? <p className="text-sm text-zinc-400">Todavía no hay ampliaciones.</p> : data.requests.map(req => <details key={req.id} className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3"><summary className="cursor-pointer text-sm"><span className="font-semibold">{req.extension.request_input.date} · {req.extension.request_input.time}</span><span className="mx-3 text-zinc-400">{eventRequestLabel[req.extension.stage] ?? req.extension.stage}</span><strong>{money(req.extension.amount, req.extension.currency)}</strong></summary>
        <div className="mt-3 space-y-3"><ul className="text-sm">{req.extension.items.map(item => <li key={item.product_id}>{item.qty} {item.unit} · {item.product_name}</li>)}</ul>
          <p className="text-sm text-zinc-400">{req.extension.request_input.note}</p>{req.extension.reason ? <p>{req.extension.reason}</p> : null}
          {req.converted_order_id ? <Link className="text-yellow-300" href={orderHref(req.converted_order_id)}>Ver orden #{req.converted_order_id}</Link> : null}
          {admin && ['requested','priced'].includes(req.extension.stage) ? <RequestPricing request={req} disabled={pending} save={input => command('price', { id: req.id, ...input })} /> : null}
          {master && ['requested','priced'].includes(req.extension.stage) ? <div className="flex gap-2"><button disabled={pending || req.extension.stage !== 'priced'} className={button} onClick={() => command('approve', { id: req.id })}>Aprobar y crear orden</button><button disabled={pending} className={button} onClick={() => { const reason = window.prompt('Motivo del rechazo'); if (reason) command('reject', { id: req.id, reason }); }}>Rechazar</button></div> : null}
        </div></details>)}
    </section>
    <details className="rounded-xl border border-zinc-800 p-4"><summary className="cursor-pointer font-semibold">Órdenes y cobranza · {data.orders.length}</summary>
      <div className="mt-3 space-y-2">{data.orders.map(order => <div key={order.order_id} className="flex flex-wrap justify-between gap-2 border-b border-zinc-800 py-2 text-sm"><Link href={orderHref(order.order_id)} className="text-yellow-300">{Number(order.order_id) === Number(data.root.converted_order_id) ? 'Inicial' : 'Ampliación'} · #{order.order_id}</Link><span>{eventOrderLabel[order.order_status] ?? order.order_status}</span><span>Total {money(order.total_usd)} · pendiente {money(order.pending_usd)}</span></div>)}</div>
      <p className="mt-3 text-xs text-zinc-400">Puedes reportar un solo pago del evento abajo. No repitas ese mismo pago en cada orden.</p>
    </details>
    {data.root.converted_order_id ? payments ? <EventPayments rootId={data.root.id} data={payments} admin={admin} master={master} /> : <p role="alert" className="text-sm text-red-300">No se pudieron cargar los pagos: {paymentError || 'Actualiza la pantalla.'}</p> : null}
    {admin ? <details className="rounded-xl border border-zinc-800 p-4"><summary className="cursor-pointer font-semibold">Condiciones de adicionales · solo Administración</summary><div className="mt-3 space-y-3">
      <CommercialFields value={terms} onChange={value => setTerms({ ...terms, ...value })} />
      <p className="text-xs text-zinc-400">La tarifa es por la unidad indicada. No se divide el presupuesto inicial para calcularla. Las solicitudes ya enviadas conservan sus condiciones.</p>
      {terms.rates.map((rate, i) => <div key={rate.product_id} className="grid gap-2 border-b border-zinc-800 pb-2 sm:grid-cols-[1fr_100px_110px_150px_auto]"><span className="self-center text-sm">{rate.product_name}</span><input aria-label={`Precio de ${rate.product_name}`} className={field} type="number" min="0" step="0.0001" value={rate.price} onChange={e => setTerms({ ...terms, rates: terms.rates.map((r, j) => j === i ? { ...r, price: Number(e.target.value) } : r) })} /><UnitMode value={rate} onChange={value => setTerms({ ...terms, rates: terms.rates.map((r, j) => j === i ? { ...r, ...value } : r) })} /><button className={button} onClick={() => setTerms({ ...terms, rates: terms.rates.filter((_, j) => i !== j) })}>Quitar</button></div>)}
      <select aria-label="Agregar tarifa" className={field} value="" onChange={e => { const product = products.find(p => p.id === Number(e.target.value)); if (product) setTerms({ ...terms, rates: [...terms.rates, { product_id: product.id, product_name: product.name, price: 0, unit: 'UND', preparation_mode: 'kitchen' }] }); }}><option value="">Agregar producto a las tarifas…</option>{products.filter(p => !terms.rates.some(r => r.product_id === p.id)).map(p => <option value={p.id} key={p.id}>{p.name}</option>)}</select>
      <button className={button} disabled={pending} onClick={() => command('terms', { ...terms })}>Guardar tarifas autorizadas</button>
    </div></details> : null}
    {master && data.root.converted_order_id && !data.root.payload.event_state?.closed ? <button disabled={pending} className={`${button} text-zinc-400`} onClick={() => { if (window.confirm('¿Cerrar el evento para nuevas ampliaciones? Esto no marca las órdenes como entregadas ni pagadas.')) command('close', {}); }}>Cerrar nuevas ampliaciones</button> : null}
  </main>;
}

function CommercialFields({ value, onChange }: { value: Pick<EventTerms, 'currency' | 'commission_mode' | 'commission_value'>; onChange: (value: Partial<EventTerms>) => void }) {
  return <div className="grid grid-cols-2 gap-2 sm:grid-cols-3"><label className="text-xs">Moneda<select className={`${field} mt-1`} value={value.currency} onChange={e => onChange({ currency: e.target.value as 'USD' | 'VES' })}><option value="USD">USD</option><option value="VES">Bolívares</option></select></label><label className="text-xs">Comisión<select className={`${field} mt-1`} value={value.commission_mode} onChange={e => onChange({ commission_mode: e.target.value, commission_value: null })}><option value="default">General del asesor</option><option value="fixed_item">Porcentaje específico</option><option value="none">Sin comisión</option></select></label>{value.commission_mode === 'fixed_item' ? <label className="text-xs">Porcentaje<input className={`${field} mt-1`} type="number" min="0" max="100" value={value.commission_value ?? ''} onChange={e => onChange({ commission_value: e.target.value === '' ? null : Number(e.target.value) })} /></label> : null}</div>;
}
function UnitMode({ value, onChange }: { value: Pick<EventRate, 'unit' | 'preparation_mode'>; onChange: (value: Partial<EventRate>) => void }) {
  return <><select aria-label="Unidad de la tarifa" className={field} value={value.unit} onChange={e => onChange({ unit: e.target.value as EventRate['unit'] })}><option value="UND">UND</option><option value="servicio">Servicio</option><option value="envase">Envase</option></select><select aria-label="Preparación" className={field} value={value.preparation_mode} onChange={e => onChange({ preparation_mode: e.target.value })}><option value="kitchen">Cocina</option><option value="on_site">Freír en el sitio</option><option value="not_applicable">Sin preparación</option></select></>;
}
function RequestPricing({ request, disabled, save }: { request: EventRequest; disabled: boolean; save: (input: Record<string, unknown>) => void }) {
  const [amount, setAmount] = useState(request.extension.amount == null ? '' : String(request.extension.amount));
  const [terms, setTerms] = useState({ currency: request.extension.currency, commission_mode: request.extension.terms_snapshot?.commission_mode ?? 'default', commission_value: request.extension.terms_snapshot?.commission_value ?? null });
  const [items, setItems] = useState(request.extension.items.map(item => ({ ...item, unit: item.unit === 'servicio' || item.unit === 'envase' ? item.unit : 'UND' as EventRate['unit'] })));
  return <details className="rounded-lg border border-zinc-700 p-3"><summary className="cursor-pointer text-sm">Autorizar precio y comisión</summary><div className="mt-3 space-y-3">
    <CommercialFields value={terms} onChange={value => setTerms({ ...terms, ...value })} /><label className="block text-xs">Precio total de esta ampliación (incluye delivery si corresponde)<input className={`${field} mt-1`} type="number" min="0" step="0.01" value={amount} onChange={e => setAmount(e.target.value)} /></label>
    {items.map((item, i) => <div key={item.product_id} className="grid gap-2 sm:grid-cols-3"><span className="text-sm">{item.qty} · {item.product_name}</span><UnitMode value={item} onChange={value => setItems(items.map((x, j) => i === j ? { ...x, ...value } : x))} /></div>)}
    <button className={button} disabled={disabled || amount === ''} onClick={() => save({ ...terms, amount: Number(amount), items })}>Autorizar condiciones</button>
  </div></details>;
}
