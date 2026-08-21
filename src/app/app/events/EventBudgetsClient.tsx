'use client';

import Link from 'next/link';
import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  type EventBudgetData,
  type EventCommissionMode,
  type EventPreparationMode,
} from '@/lib/events/event-budget';
import {
  archiveEventBudgetAction,
  convertEventBudgetToOrderAction,
  saveEventBudgetAction,
  searchEventClientsAction,
} from './actions';

type ProductOption = { id: number; sku: string | null; name: string; type: string };
type AdvisorOption = { id: string; name: string };
type EventDraft = {
  id: number;
  advisorUserId: string;
  advisorName: string;
  status: string;
  title: string;
  clientId: number | null;
  clientName: string;
  clientPhone: string;
  quoteText: string;
  totalUsd: number;
  totalBs: number;
  fxRate: number;
  convertedOrderId: number | null;
  updatedAt: string;
  budget: EventBudgetData;
};
type ClientResult = {
  id: number | string;
  full_name?: string | null;
  phone?: string | null;
};
type FormComponent = {
  localId: string;
  productId: number;
  productName: string;
  qty: string;
  preparationMode: EventPreparationMode;
};

function fieldClass(className = '') {
  return `w-full rounded-xl border border-[#2A2A36] bg-[#0B0B0F] px-3 py-2.5 text-sm text-[#F6F6F8] outline-none focus:border-[#FEEF00]/70 ${className}`;
}

function money(value: number) {
  return `$${Number(value || 0).toFixed(2)}`;
}

function updated(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Sin fecha';
  return new Intl.DateTimeFormat('es-VE', {
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

function statusLabel(status: string) {
  if (status === 'quoted') return 'Cotizado';
  if (status === 'converted') return 'Convertido en orden';
  if (status === 'archived') return 'Archivado';
  return 'Borrador';
}

function normalizeSearch(value: string) {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

export default function EventBudgetsClient({
  products,
  advisors,
  drafts,
  activeRate,
  defaultDate,
}: {
  products: ProductOption[];
  advisors: AdvisorOption[];
  drafts: EventDraft[];
  activeRate: number;
  defaultDate: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [editingDraftId, setEditingDraftId] = useState<number | null>(null);
  const [title, setTitle] = useState('');
  const [advisorUserId, setAdvisorUserId] = useState('');
  const [selectedClientId, setSelectedClientId] = useState<number | null>(null);
  const [clientName, setClientName] = useState('');
  const [clientPhone, setClientPhone] = useState('');
  const [clientSearch, setClientSearch] = useState('');
  const [clientResults, setClientResults] = useState<ClientResult[]>([]);
  const [eventDate, setEventDate] = useState(defaultDate);
  const [eventTime, setEventTime] = useState('12:00');
  const [fulfillment, setFulfillment] = useState<'pickup' | 'delivery'>('pickup');
  const [deliveryAddress, setDeliveryAddress] = useState('');
  const [notes, setNotes] = useState('');
  const [negotiatedCurrency, setNegotiatedCurrency] = useState<'USD' | 'VES'>('USD');
  const [negotiatedAmount, setNegotiatedAmount] = useState('');
  const [commissionMode, setCommissionMode] = useState<EventCommissionMode>('default');
  const [commissionValue, setCommissionValue] = useState('');
  const [productSearch, setProductSearch] = useState('');
  const [selectedProductId, setSelectedProductId] = useState<number | ''>('');
  const [componentQty, setComponentQty] = useState('1');
  const [componentMode, setComponentMode] = useState<EventPreparationMode>('kitchen');
  const [components, setComponents] = useState<FormComponent[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const visibleProducts = useMemo(() => {
    const query = normalizeSearch(productSearch);
    if (!query) return products;
    return products.filter((product) => normalizeSearch(`${product.name} ${product.sku || ''}`).includes(query));
  }, [productSearch, products]);

  const openDrafts = drafts.filter((draft) => draft.status !== 'archived');

  function clearEditor() {
    setEditingDraftId(null);
    setTitle('');
    setAdvisorUserId('');
    setSelectedClientId(null);
    setClientName('');
    setClientPhone('');
    setClientSearch('');
    setClientResults([]);
    setEventDate(defaultDate);
    setEventTime('12:00');
    setFulfillment('pickup');
    setDeliveryAddress('');
    setNotes('');
    setNegotiatedCurrency('USD');
    setNegotiatedAmount('');
    setCommissionMode('default');
    setCommissionValue('');
    setProductSearch('');
    setSelectedProductId('');
    setComponents([]);
    setMessage(null);
    setError(null);
  }

  function editDraft(draft: EventDraft) {
    setEditingDraftId(draft.id);
    setTitle(draft.budget.title);
    setAdvisorUserId(draft.advisorUserId);
    setSelectedClientId(draft.clientId);
    setClientName(draft.clientName === 'Cliente sin nombre' ? '' : draft.clientName);
    setClientPhone(draft.clientPhone);
    setClientSearch(draft.clientName);
    setClientResults([]);
    setEventDate(draft.budget.eventDate || defaultDate);
    setEventTime(draft.budget.eventTime || '12:00');
    setFulfillment(draft.budget.fulfillment);
    setDeliveryAddress(draft.budget.deliveryAddress);
    setNotes(draft.budget.notes);
    setNegotiatedCurrency(draft.budget.negotiatedCurrency);
    setNegotiatedAmount(String(draft.budget.negotiatedAmount));
    setCommissionMode(draft.budget.commissionMode);
    setCommissionValue(draft.budget.commissionValue == null ? '' : String(draft.budget.commissionValue));
    setComponents(draft.budget.components.map((component, index) => ({
      localId: `${draft.id}-${component.productId}-${index}`,
      productId: component.productId,
      productName: component.productName,
      qty: String(component.qty),
      preparationMode: component.preparationMode,
    })));
    setMessage(null);
    setError(null);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function searchClients() {
    setError(null);
    startTransition(async () => {
      try {
        const results = await searchEventClientsAction({ query: clientSearch, limit: 10 });
        setClientResults((results ?? []) as ClientResult[]);
      } catch (searchError) {
        setError(searchError instanceof Error ? searchError.message : 'No se pudo buscar el cliente.');
      }
    });
  }

  function selectClient(client: ClientResult) {
    setSelectedClientId(Number(client.id));
    setClientName(String(client.full_name || '').trim());
    setClientPhone(String(client.phone || '').trim());
    setClientSearch(String(client.full_name || client.phone || '').trim());
    setClientResults([]);
  }

  function addComponent() {
    const product = products.find((option) => option.id === Number(selectedProductId));
    const qty = Number(String(componentQty).replace(',', '.'));
    if (!product || !Number.isFinite(qty) || qty <= 0) {
      setError('Selecciona un producto y escribe una cantidad válida.');
      return;
    }
    setComponents((current) => {
      const existing = current.find((component) => component.productId === product.id);
      if (existing) {
        return current.map((component) => component.productId === product.id
          ? { ...component, qty: String(Number(component.qty || 0) + qty), preparationMode: componentMode }
          : component);
      }
      return [...current, {
        localId: `${Date.now()}-${product.id}`,
        productId: product.id,
        productName: product.name,
        qty: String(qty),
        preparationMode: componentMode,
      }];
    });
    setSelectedProductId('');
    setComponentQty('1');
    setError(null);
  }

  function save(status: 'draft' | 'quoted') {
    setError(null);
    setMessage(null);
    startTransition(async () => {
      try {
        const result = await saveEventBudgetAction({
          draftId: editingDraftId,
          status,
          title,
          advisorUserId,
          selectedClientId,
          newClientName: clientName,
          newClientPhone: clientPhone,
          eventDate,
          eventTime,
          fulfillment,
          deliveryAddress,
          notes,
          negotiatedCurrency,
          negotiatedAmount: Number(String(negotiatedAmount).replace(',', '.')),
          commissionMode,
          commissionValue: commissionValue ? Number(String(commissionValue).replace(',', '.')) : null,
          components: components.map((component) => ({
            productId: component.productId,
            qty: Number(String(component.qty).replace(',', '.')),
            preparationMode: component.preparationMode,
          })),
        });
        setEditingDraftId(result.id);
        setMessage(status === 'quoted' ? 'Presupuesto guardado y listo para enviar.' : 'Borrador guardado.');
        router.refresh();
      } catch (saveError) {
        setError(saveError instanceof Error ? saveError.message : 'No se pudo guardar el presupuesto.');
      }
    });
  }

  function convert(draftId: number) {
    setError(null);
    setMessage(null);
    startTransition(async () => {
      try {
        const result = await convertEventBudgetToOrderAction(draftId);
        setMessage(`Evento convertido en la orden ${result.orderNumber || `#${result.id}`}. El inventario comienza a comprometerse desde esa orden.`);
        router.refresh();
      } catch (convertError) {
        setError(convertError instanceof Error ? convertError.message : 'No se pudo convertir el presupuesto.');
      }
    });
  }

  function archive(draftId: number) {
    setError(null);
    startTransition(async () => {
      try {
        await archiveEventBudgetAction(draftId);
        if (editingDraftId === draftId) clearEditor();
        router.refresh();
      } catch (archiveError) {
        setError(archiveError instanceof Error ? archiveError.message : 'No se pudo archivar.');
      }
    });
  }

  return (
    <main className="min-h-screen bg-[#09090C] px-4 py-5 text-[#F5F5F7] sm:px-6">
      <div className="mx-auto max-w-[1500px] space-y-5">
        <header className="flex flex-col gap-3 rounded-2xl border border-[#24242F] bg-[#111116] p-5 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="text-xs font-semibold uppercase tracking-[0.2em] text-[#FEEF00]">Administración</div>
            <h1 className="mt-1 text-2xl font-bold">Presupuestos de eventos</h1>
            <p className="mt-1 max-w-3xl text-sm text-[#A7A7B3]">Arma una propuesta libre, congela su precio y comisión, asígnala al asesor y conviértela en orden cuando el cliente la acepte.</p>
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={clearEditor} className="rounded-xl bg-[#FEEF00] px-4 py-2.5 text-sm font-bold text-black">Nuevo evento</button>
            <Link href="/app/master/dashboard" className="rounded-xl border border-[#30303C] px-4 py-2.5 text-sm">Volver</Link>
          </div>
        </header>

        {error ? <div className="rounded-xl border border-red-500/40 bg-red-950/30 p-3 text-sm text-red-200">{error}</div> : null}
        {message ? <div className="rounded-xl border border-emerald-500/40 bg-emerald-950/30 p-3 text-sm text-emerald-200">{message}</div> : null}

        <div className="grid gap-5 xl:grid-cols-[minmax(0,1.45fr)_minmax(380px,0.75fr)]">
          <section className="space-y-4 rounded-2xl border border-[#24242F] bg-[#111116] p-4 sm:p-5">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold">{editingDraftId ? `Editando presupuesto #${editingDraftId}` : 'Nuevo presupuesto'}</h2>
                <p className="text-xs text-[#858593]">Aquí se define la propuesta. Todavía no descuenta ni compromete inventario.</p>
              </div>
              <span className="rounded-full border border-[#3A3A46] px-3 py-1 text-xs text-[#B9B9C3]">Tasa {activeRate > 0 ? activeRate.toFixed(2) : 'sin cargar'}</span>
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              <label className="text-xs text-[#B9B9C3]">Nombre del evento<input value={title} onChange={(event) => setTitle(event.target.value)} className={`${fieldClass()} mt-1`} placeholder="Ej. Graduación Colegio Vivo" /></label>
              <label className="text-xs text-[#B9B9C3]">Asesor responsable<select value={advisorUserId} onChange={(event) => setAdvisorUserId(event.target.value)} className={`${fieldClass()} mt-1`}><option value="">Seleccionar</option>{advisors.map((advisor) => <option key={advisor.id} value={advisor.id}>{advisor.name}</option>)}</select></label>
              <label className="text-xs text-[#B9B9C3]">Fecha<input type="date" value={eventDate} onChange={(event) => setEventDate(event.target.value)} className={`${fieldClass()} mt-1`} /></label>
              <label className="text-xs text-[#B9B9C3]">Hora<input type="time" value={eventTime} onChange={(event) => setEventTime(event.target.value)} className={`${fieldClass()} mt-1`} /></label>
            </div>

            <div className="rounded-xl border border-[#262631] bg-[#0D0D12] p-3">
              <div className="text-sm font-semibold">Cliente</div>
              <div className="mt-2 flex gap-2"><input value={clientSearch} onChange={(event) => setClientSearch(event.target.value)} className={fieldClass()} placeholder="Buscar por nombre o teléfono" /><button type="button" disabled={pending} onClick={searchClients} className="rounded-xl border border-[#3A3A46] px-4 text-sm">Buscar</button></div>
              {clientResults.length > 0 ? <div className="mt-2 grid gap-1">{clientResults.map((client) => <button key={String(client.id)} type="button" onClick={() => selectClient(client)} className="rounded-lg border border-[#282833] px-3 py-2 text-left text-sm hover:border-[#FEEF00]/50"><span className="font-semibold">{client.full_name || 'Cliente'}</span><span className="ml-2 text-[#8D8D9A]">{client.phone || ''}</span></button>)}</div> : null}
              <div className="mt-3 grid gap-3 md:grid-cols-2"><label className="text-xs text-[#B9B9C3]">Nombre<input value={clientName} onChange={(event) => { setClientName(event.target.value); setSelectedClientId(null); }} className={`${fieldClass()} mt-1`} /></label><label className="text-xs text-[#B9B9C3]">Teléfono<input value={clientPhone} onChange={(event) => { setClientPhone(event.target.value); setSelectedClientId(null); }} className={`${fieldClass()} mt-1`} /></label></div>
              {selectedClientId ? <div className="mt-2 text-xs text-emerald-300">Cliente existente seleccionado #{selectedClientId}</div> : <div className="mt-2 text-xs text-[#777784]">Si no eliges un resultado, se creará el cliente al convertir la propuesta.</div>}
            </div>

            <div className="rounded-xl border border-[#262631] bg-[#0D0D12] p-3">
              <div className="text-sm font-semibold">Productos y servicios incluidos</div>
              <div className="mt-2 grid gap-2 lg:grid-cols-[1.5fr_100px_180px_auto]">
                <div><input value={productSearch} onChange={(event) => setProductSearch(event.target.value)} className={fieldClass('mb-2')} placeholder="Filtrar catálogo" /><select value={selectedProductId} onChange={(event) => setSelectedProductId(event.target.value ? Number(event.target.value) : '')} className={fieldClass()}><option value="">Seleccionar producto</option>{visibleProducts.map((product) => <option key={product.id} value={product.id}>{product.name}</option>)}</select></div>
                <input value={componentQty} onChange={(event) => setComponentQty(event.target.value)} inputMode="decimal" className={fieldClass('self-end')} placeholder="Cantidad" />
                <select value={componentMode} onChange={(event) => setComponentMode(event.target.value as EventPreparationMode)} className={fieldClass('self-end')}><option value="kitchen">Preparar en cocina</option><option value="on_site">Freír en el sitio</option><option value="not_applicable">No requiere preparación</option></select>
                <button type="button" onClick={addComponent} className="self-end rounded-xl bg-[#FEEF00] px-4 py-2.5 text-sm font-bold text-black">Agregar</button>
              </div>
              <div className="mt-3 space-y-2">{components.length === 0 ? <div className="rounded-lg border border-dashed border-[#343440] p-4 text-center text-sm text-[#777784]">Aún no hay componentes.</div> : components.map((component) => <div key={component.localId} className="grid gap-2 rounded-xl border border-[#292934] p-2.5 md:grid-cols-[1fr_110px_190px_auto] md:items-center"><div className="text-sm font-semibold">{component.productName}</div><input value={component.qty} onChange={(event) => setComponents((current) => current.map((item) => item.localId === component.localId ? { ...item, qty: event.target.value } : item))} className={fieldClass()} inputMode="decimal" /><select value={component.preparationMode} onChange={(event) => setComponents((current) => current.map((item) => item.localId === component.localId ? { ...item, preparationMode: event.target.value as EventPreparationMode } : item))} className={fieldClass()}><option value="kitchen">Preparar en cocina</option><option value="on_site">Freír en el sitio</option><option value="not_applicable">No requiere preparación</option></select><button type="button" onClick={() => setComponents((current) => current.filter((item) => item.localId !== component.localId))} className="rounded-lg border border-red-500/30 px-3 py-2 text-xs text-red-300">Quitar</button></div>)}</div>
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              <label className="text-xs text-[#B9B9C3]">Logística<select value={fulfillment} onChange={(event) => setFulfillment(event.target.value as 'pickup' | 'delivery')} className={`${fieldClass()} mt-1`}><option value="pickup">Retiro / logística por definir</option><option value="delivery">Entrega en el evento</option></select></label>
              <label className="text-xs text-[#B9B9C3]">Dirección<input value={deliveryAddress} onChange={(event) => setDeliveryAddress(event.target.value)} disabled={fulfillment !== 'delivery'} className={`${fieldClass()} mt-1 disabled:opacity-50`} /></label>
              <label className="text-xs text-[#B9B9C3]">Moneda y precio negociado<div className="mt-1 grid grid-cols-[100px_1fr] gap-2"><select value={negotiatedCurrency} onChange={(event) => setNegotiatedCurrency(event.target.value as 'USD' | 'VES')} className={fieldClass()}><option value="USD">USD</option><option value="VES">VES</option></select><input value={negotiatedAmount} onChange={(event) => setNegotiatedAmount(event.target.value)} inputMode="decimal" className={fieldClass()} /></div></label>
              <label className="text-xs text-[#B9B9C3]">Comisión<select value={commissionMode} onChange={(event) => setCommissionMode(event.target.value as EventCommissionMode)} className={`${fieldClass()} mt-1`}><option value="default">Comisión general</option><option value="fixed_item">Porcentaje específico</option><option value="none">Sin comisión</option></select>{commissionMode === 'fixed_item' ? <input value={commissionValue} onChange={(event) => setCommissionValue(event.target.value)} inputMode="decimal" className={`${fieldClass()} mt-2`} placeholder="Porcentaje" /> : null}</label>
            </div>
            <label className="block text-xs text-[#B9B9C3]">Notas y condiciones<textarea value={notes} onChange={(event) => setNotes(event.target.value)} rows={4} className={`${fieldClass()} mt-1 resize-y`} /></label>

            <div className="flex flex-wrap justify-end gap-2 border-t border-[#252530] pt-4"><button type="button" disabled={pending} onClick={() => save('draft')} className="rounded-xl border border-[#3A3A46] px-4 py-2.5 text-sm">Guardar borrador</button><button type="button" disabled={pending} onClick={() => save('quoted')} className="rounded-xl bg-[#FEEF00] px-5 py-2.5 text-sm font-bold text-black">Guardar presupuesto</button></div>
          </section>

          <aside className="space-y-3 rounded-2xl border border-[#24242F] bg-[#111116] p-4 sm:p-5">
            <div><h2 className="text-lg font-semibold">Presupuestos</h2><p className="text-xs text-[#858593]">{openDrafts.length} visibles · el asesor solo puede consultar los que le asignes.</p></div>
            {openDrafts.length === 0 ? <div className="rounded-xl border border-dashed border-[#343440] p-6 text-center text-sm text-[#777784]">No hay presupuestos de eventos.</div> : openDrafts.map((draft) => <article key={draft.id} className="rounded-xl border border-[#292934] bg-[#0D0D12] p-3"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><div className="truncate font-semibold">{draft.title}</div><div className="mt-1 text-xs text-[#9898A5]">{draft.clientName} · {draft.advisorName}</div><div className="mt-1 text-[11px] text-[#6F6F7C]">{statusLabel(draft.status)} · {updated(draft.updatedAt)}</div></div><div className="shrink-0 text-right font-bold text-[#FEEF00]">{money(draft.totalUsd)}</div></div><div className="mt-2 flex flex-wrap gap-1">{draft.budget.components.slice(0, 4).map((component) => <span key={`${draft.id}-${component.productId}`} className="rounded-full bg-[#1B1B23] px-2 py-1 text-[10px] text-[#B8B8C2]">{component.qty} {component.productName}</span>)}</div><div className="mt-3 grid grid-cols-2 gap-2">{draft.status === 'draft' || draft.status === 'quoted' ? <><button type="button" onClick={() => editDraft(draft)} className="rounded-lg border border-[#393946] px-3 py-2 text-xs">Editar</button><button type="button" disabled={pending} onClick={() => convert(draft.id)} className="rounded-lg bg-emerald-400 px-3 py-2 text-xs font-bold text-black">Convertir en orden</button>{draft.quoteText ? <button type="button" onClick={() => navigator.clipboard.writeText(draft.quoteText)} className="rounded-lg border border-[#393946] px-3 py-2 text-xs">Copiar propuesta</button> : null}<button type="button" disabled={pending} onClick={() => archive(draft.id)} className="rounded-lg border border-red-500/30 px-3 py-2 text-xs text-red-300">Archivar</button></> : draft.convertedOrderId ? <Link href={`/app/master/ops?openOrder=${draft.convertedOrderId}`} className="col-span-2 rounded-lg border border-emerald-500/40 px-3 py-2 text-center text-xs text-emerald-300">Abrir orden #{draft.convertedOrderId}</Link> : null}</div></article>)}
          </aside>
        </div>
      </div>
    </main>
  );
}
