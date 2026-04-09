'use client';

import Link from 'next/link';
import { type FormEvent, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createSupabaseBrowser } from '@/lib/supabase/browser';

type ClientType = 'assigned' | 'own' | 'legacy';
type FulfillmentType = 'pickup' | 'delivery';
type PaymentMethod = 'pending' | 'cash' | 'transfer' | 'zelle' | 'mixed';

type ClientRow = {
  id: number;
  full_name: string;
  phone: string | null;
  client_type: string | null;
};

type ProductRow = {
  id: number;
  sku: string | null;
  name: string;
  base_price_usd: number | string | null;
};

type DraftItem = {
  localId: string;
  product_id: number;
  sku_snapshot: string | null;
  product_name_snapshot: string;
  qty: number;
  unit_price_usd_snapshot: number;
  line_total_usd: number;
};

function pad2(n: number) {
  return String(n).padStart(2, '0');
}

function pad4(n: number) {
  return String(n).padStart(4, '0');
}

function todayKey() {
  const now = new Date();
  return `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}`;
}

function getTodayInputValue() {
  const now = new Date();
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

function getRoundedTime() {
  const date = new Date();
  date.setSeconds(0, 0);
  const mins = date.getMinutes();

  if (mins > 0 && mins < 30) date.setMinutes(30);
  else if (mins > 30) {
    date.setHours(date.getHours() + 1);
    date.setMinutes(0);
  }

  return date;
}

function to12h(date: Date) {
  const hour24 = date.getHours();
  const minute = date.getMinutes();
  const ampm: 'AM' | 'PM' = hour24 >= 12 ? 'PM' : 'AM';
  let hour12 = hour24 % 12;
  if (hour12 === 0) hour12 = 12;
  return { hour12: String(hour12), minute: pad2(minute), ampm };
}

function from12hTo24h(hour12: string, minute: string, ampm: 'AM' | 'PM') {
  let hour = Number(hour12);
  const mins = Number(minute);

  if (!Number.isFinite(hour) || hour < 1 || hour > 12) throw new Error('Hora invalida.');
  if (!Number.isFinite(mins) || mins < 0 || mins > 59) throw new Error('Minutos invalidos.');

  if (ampm === 'AM') {
    if (hour === 12) hour = 0;
  } else if (hour !== 12) {
    hour += 12;
  }

  return `${pad2(hour)}:${pad2(mins)}`;
}

function normalizePhone(value: string) {
  return value.replace(/[^\d+]/g, '');
}

function formatUsd(value: number) {
  return `$${value.toFixed(2)}`;
}

function inputClass(multiline = false) {
  return [
    'w-full rounded-[16px] border border-[#232632] bg-[#0F131B] px-3.5 text-sm text-[#F5F7FB] placeholder:text-[#636C80]',
    multiline ? 'min-h-[92px] py-3' : 'h-11',
  ].join(' ');
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <div className="mb-1.5 text-[12px] font-medium text-[#AAB2C5]">{label}</div>
      {children}
      {hint ? <div className="mt-1 text-[11px] leading-5 text-[#6F7890]">{hint}</div> : null}
    </label>
  );
}

function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-[24px] border border-[#232632] bg-[#12151d] px-4 py-4">
      <h2 className="text-base font-semibold text-[#F5F7FB]">{title}</h2>
      {subtitle ? <p className="mt-1 text-xs leading-5 text-[#8B93A7]">{subtitle}</p> : null}
      <div className="mt-3 space-y-3">{children}</div>
    </section>
  );
}

export default function AdvisorOrderComposer() {
  const router = useRouter();
  const supabase = useMemo(() => createSupabaseBrowser(), []);
  const rounded = useMemo(() => to12h(getRoundedTime()), []);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [searchingClient, setSearchingClient] = useState(false);
  const [creatingClient, setCreatingClient] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const [authUserId, setAuthUserId] = useState('');
  const [products, setProducts] = useState<ProductRow[]>([]);
  const [selectedProductId, setSelectedProductId] = useState<number | ''>('');
  const [qty, setQty] = useState('1');
  const [draftItems, setDraftItems] = useState<DraftItem[]>([]);

  const [searchTerm, setSearchTerm] = useState('');
  const [clientResults, setClientResults] = useState<ClientRow[]>([]);
  const [selectedClient, setSelectedClient] = useState<ClientRow | null>(null);
  const [isNewClientMode, setIsNewClientMode] = useState(false);
  const [newClientName, setNewClientName] = useState('');
  const [newClientPhone, setNewClientPhone] = useState('');
  const [newClientType, setNewClientType] = useState<ClientType>('assigned');

  const [quoteOnly, setQuoteOnly] = useState(false);
  const [fulfillment, setFulfillment] = useState<FulfillmentType>('pickup');
  const [deliveryDate, setDeliveryDate] = useState(getTodayInputValue());
  const [deliveryHour12, setDeliveryHour12] = useState(rounded.hour12);
  const [deliveryMinute, setDeliveryMinute] = useState(rounded.minute);
  const [deliveryAmPm, setDeliveryAmPm] = useState<'AM' | 'PM'>(rounded.ampm);
  const [receiverName, setReceiverName] = useState('');
  const [receiverPhone, setReceiverPhone] = useState('');
  const [deliveryAddress, setDeliveryAddress] = useState('');
  const [orderNote, setOrderNote] = useState('');
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('pending');
  const [paymentCurrency, setPaymentCurrency] = useState<'USD' | 'VES'>('USD');
  const [paymentNote, setPaymentNote] = useState('');

  const selectedProduct = useMemo(() => {
    if (selectedProductId === '') return null;
    return products.find((product) => product.id === selectedProductId) ?? null;
  }, [products, selectedProductId]);

  const draftTotalUsd = useMemo(
    () => draftItems.reduce((sum, item) => sum + Number(item.line_total_usd || 0), 0),
    [draftItems]
  );

  const createReady =
    draftItems.length > 0 &&
    (!!selectedClient || (isNewClientMode && newClientName.trim() && newClientPhone.trim())) &&
    (fulfillment === 'pickup' || deliveryAddress.trim().length > 0);

  useEffect(() => {
    async function boot() {
      setLoading(true);
      setError(null);

      const { data: authData, error: authError } = await supabase.auth.getUser();
      if (authError) {
        setError(authError.message);
        setLoading(false);
        return;
      }

      const user = authData.user;
      if (!user) {
        router.push('/login');
        return;
      }

      setAuthUserId(user.id);

      const { data: productData, error: productError } = await supabase
        .from('products')
        .select('id, sku, name, base_price_usd')
        .eq('is_active', true)
        .order('name', { ascending: true });

      if (productError) setError(productError.message);
      else setProducts((productData ?? []) as ProductRow[]);

      setLoading(false);
    }

    void boot();
  }, [router, supabase]);

  function clearMessages() {
    setError(null);
    setInfo(null);
  }

  async function handleSearchClients(e?: FormEvent) {
    e?.preventDefault();
    clearMessages();

    const query = searchTerm.trim();
    if (!query) {
      setClientResults([]);
      return;
    }

    setSearchingClient(true);

    const { data, error: searchError } = await supabase
      .from('clients')
      .select('id, full_name, phone, client_type')
      .or(`phone.ilike.%${query}%,full_name.ilike.%${query}%`)
      .order('id', { ascending: false })
      .limit(12);

    setSearchingClient(false);

    if (searchError) {
      setError(searchError.message);
      return;
    }

    setClientResults((data ?? []) as ClientRow[]);
    setInfo((data ?? []).length > 0 ? 'Cliente encontrado.' : 'No hubo coincidencias.');
  }

  async function createClientNow() {
    clearMessages();
    const full_name = newClientName.trim();
    const phone = normalizePhone(newClientPhone.trim());

    if (!full_name) throw new Error('Falta el nombre del cliente.');
    if (!phone) throw new Error('Falta el telefono del cliente.');

    setCreatingClient(true);

    try {
      const { data: existing, error: existingError } = await supabase
        .from('clients')
        .select('id, full_name, phone, client_type')
        .eq('phone', phone)
        .limit(1);

      if (existingError) throw new Error(existingError.message);

      if (existing && existing.length > 0) {
        const current = existing[0] as ClientRow;
        setSelectedClient(current);
        setSearchTerm(current.phone ?? current.full_name);
        setIsNewClientMode(false);
        setInfo(`Cliente listo: ${current.full_name}`);
        return current.id;
      }

      const { data: created, error: createError } = await supabase
        .from('clients')
        .insert({
          full_name,
          phone,
          client_type: newClientType,
        })
        .select('id, full_name, phone, client_type')
        .single();

      if (createError) throw new Error(createError.message);

      const client = created as ClientRow;
      setSelectedClient(client);
      setSearchTerm(client.phone ?? client.full_name);
      setIsNewClientMode(false);
      setClientResults([]);
      setInfo(`Cliente creado: ${client.full_name}`);
      return client.id;
    } finally {
      setCreatingClient(false);
    }
  }

  function addDraftItem() {
    clearMessages();
    if (!selectedProduct) {
      setError('Selecciona un producto.');
      return;
    }

    const quantity = Number(qty);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      setError('La cantidad debe ser mayor que cero.');
      return;
    }

    const unitPrice = Number(selectedProduct.base_price_usd ?? 0);
    const lineTotal = Number((unitPrice * quantity).toFixed(2));

    setDraftItems((current) => [
      ...current,
      {
        localId: `${selectedProduct.id}-${Date.now()}`,
        product_id: selectedProduct.id,
        sku_snapshot: selectedProduct.sku,
        product_name_snapshot: selectedProduct.name,
        qty: quantity,
        unit_price_usd_snapshot: unitPrice,
        line_total_usd: lineTotal,
      },
    ]);
    setQty('1');
    setSelectedProductId('');
  }

  function removeDraftItem(localId: string) {
    setDraftItems((current) => current.filter((item) => item.localId !== localId));
  }

  async function ensureClientId() {
    if (selectedClient) return selectedClient.id;
    if (!isNewClientMode) throw new Error('Selecciona o crea un cliente.');
    return createClientNow();
  }

  async function generateOrderNumber() {
    const randomNumber = Math.floor(Math.random() * 10000);
    return `VO-${todayKey()}-${pad4(randomNumber)}`;
  }

  function buildExtraFields() {
    const deliveryTime24 = from12hTo24h(deliveryHour12, deliveryMinute, deliveryAmPm);

    return {
      schedule: {
        date: deliveryDate,
        time_12: `${deliveryHour12}:${deliveryMinute} ${deliveryAmPm}`,
        time_24: deliveryTime24,
      },
      receiver: {
        name: receiverName.trim() || null,
        phone: receiverPhone.trim() ? normalizePhone(receiverPhone.trim()) : null,
      },
      delivery: {
        address: fulfillment === 'delivery' ? deliveryAddress.trim() || null : null,
      },
      payment: {
        method: paymentMethod,
        currency: paymentCurrency,
        notes: paymentNote.trim() || null,
      },
      note: orderNote.trim() || null,
      ui: {
        quote_only: quoteOnly,
        surface: 'advisor_mobile',
      },
    };
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    clearMessages();

    if (!createReady) {
      setError('Completa cliente, items y entrega para continuar.');
      return;
    }

    try {
      from12hTo24h(deliveryHour12, deliveryMinute, deliveryAmPm);
    } catch (timeError) {
      setError(timeError instanceof Error ? timeError.message : 'Hora invalida.');
      return;
    }

    if (quoteOnly) {
      setInfo(`Presupuesto listo por ${formatUsd(draftTotalUsd)}. Aun no se creo la orden.`);
      return;
    }

    setSaving(true);

    try {
      const clientId = await ensureClientId();
      const orderNumber = await generateOrderNumber();

      const { data: order, error: orderError } = await supabase
        .from('orders')
        .insert({
          order_number: orderNumber,
          client_id: clientId,
          created_by_user_id: authUserId,
          attributed_advisor_id: authUserId,
          source: 'advisor',
          status: 'created',
          fulfillment,
          total_usd: draftTotalUsd,
          is_price_locked: false,
          delivery_address: fulfillment === 'delivery' ? deliveryAddress.trim() || null : null,
          notes: orderNote.trim() || null,
          extra_fields: buildExtraFields(),
        })
        .select('id')
        .single();

      if (orderError) throw new Error(orderError.message);

      const itemsPayload = draftItems.map((item) => ({
        order_id: order.id,
        product_id: item.product_id,
        qty: item.qty,
        unit_price_usd_snapshot: item.unit_price_usd_snapshot,
        line_total_usd: item.line_total_usd,
        sku_snapshot: item.sku_snapshot,
        product_name_snapshot: item.product_name_snapshot,
        notes: null,
      }));

      const { error: itemsError } = await supabase.from('order_items').insert(itemsPayload);
      if (itemsError) throw new Error(itemsError.message);

      router.push(`/orders/${order.id}`);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'No se pudo crear la orden.');
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <div className="rounded-[24px] border border-[#232632] bg-[#12151d] px-4 py-5 text-sm text-[#AAB2C5]">Cargando captura del asesor...</div>;
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4 pb-28">
      <section className="rounded-[26px] border border-[#232632] bg-[#12151d] px-4 py-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-[#8B93A7]">Nuevo pedido</p>
            <h1 className="mt-1 text-[22px] font-semibold tracking-[-0.04em] text-[#F5F7FB]">Captura mobile-first</h1>
            <p className="mt-2 text-sm leading-5 text-[#AAB2C5]">
              Flujo corto para cliente, entrega, pago y resumen final.
            </p>
          </div>
          <Link href="/app/advisor" className="inline-flex h-10 items-center rounded-[14px] border border-[#232632] px-3.5 text-sm font-medium text-[#F5F7FB]">
            Salir
          </Link>
        </div>
      </section>

      {error ? <div className="rounded-[18px] border border-[#5E2229] bg-[#261114] px-4 py-3 text-sm text-[#F0A6AE]">{error}</div> : null}
      {info ? <div className="rounded-[18px] border border-[#1C5036] bg-[#0F2119] px-4 py-3 text-sm text-[#7CE0A9]">{info}</div> : null}

      <Section title="1. Cliente" subtitle="Busca primero. Si no existe, crealo aqui mismo.">
        <div className="grid gap-3">
          <Field label="Buscar cliente">
            <div className="flex gap-2">
              <input
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className={inputClass()}
                placeholder="Telefono o nombre"
              />
              <button type="button" onClick={() => void handleSearchClients()} className="h-11 rounded-[16px] border border-[#232632] px-3.5 text-sm font-medium text-[#F5F7FB]">
                {searchingClient ? 'Buscando' : 'Buscar'}
              </button>
            </div>
          </Field>

          {selectedClient ? (
            <div className="rounded-[18px] border border-[#232632] bg-[#0F131B] px-3.5 py-3 text-sm text-[#F5F7FB]">
              <div className="font-medium">{selectedClient.full_name}</div>
              <div className="mt-1 text-xs text-[#8B93A7]">{selectedClient.phone || 'Sin telefono'}</div>
            </div>
          ) : null}

          {clientResults.length > 0 ? (
            <div className="space-y-2">
              {clientResults.map((client) => (
                <button
                  key={client.id}
                  type="button"
                  onClick={() => {
                    setSelectedClient(client);
                    setIsNewClientMode(false);
                    setInfo(`Cliente seleccionado: ${client.full_name}`);
                  }}
                  className="flex w-full items-center justify-between rounded-[18px] border border-[#232632] bg-[#0F131B] px-3.5 py-3 text-left"
                >
                  <div>
                    <div className="text-sm font-medium text-[#F5F7FB]">{client.full_name}</div>
                    <div className="mt-1 text-xs text-[#8B93A7]">{client.phone || 'Sin telefono'}</div>
                  </div>
                  <div className="text-xs text-[#AAB2C5]">Usar</div>
                </button>
              ))}
            </div>
          ) : null}

          <button
            type="button"
            onClick={() => {
              setIsNewClientMode((current) => !current);
              setSelectedClient(null);
            }}
            className="h-10 rounded-[14px] border border-[#232632] text-sm font-medium text-[#F5F7FB]"
          >
            {isNewClientMode ? 'Cancelar cliente nuevo' : 'Crear cliente nuevo'}
          </button>

          {isNewClientMode ? (
            <div className="grid gap-3 rounded-[18px] border border-[#232632] bg-[#0F131B] px-3.5 py-3">
              <Field label="Nombre">
                <input value={newClientName} onChange={(e) => setNewClientName(e.target.value)} className={inputClass()} placeholder="Nombre completo" />
              </Field>
              <Field label="Telefono">
                <input value={newClientPhone} onChange={(e) => setNewClientPhone(e.target.value)} className={inputClass()} placeholder="0412..." />
              </Field>
              <Field label="Canal">
                <select value={newClientType} onChange={(e) => setNewClientType(e.target.value as ClientType)} className={inputClass()}>
                  <option value="assigned">Asignado</option>
                  <option value="own">Propio</option>
                  <option value="legacy">Antiguo</option>
                </select>
              </Field>
              <button type="button" onClick={() => void createClientNow()} className="h-10 rounded-[14px] bg-[#F0D000] text-sm font-semibold text-[#17191E]">
                {creatingClient ? 'Creando...' : 'Guardar cliente'}
              </button>
            </div>
          ) : null}
        </div>
      </Section>

      <Section title="2. Items" subtitle="Controles compactos y lectura inmediata del total.">
        <div className="grid grid-cols-[1fr_88px] gap-2">
          <select value={selectedProductId} onChange={(e) => setSelectedProductId(e.target.value ? Number(e.target.value) : '')} className={inputClass()}>
            <option value="">Selecciona producto</option>
            {products.map((product) => (
              <option key={product.id} value={product.id}>
                {product.name} - ${Number(product.base_price_usd ?? 0).toFixed(2)}
              </option>
            ))}
          </select>
          <input value={qty} onChange={(e) => setQty(e.target.value)} className={inputClass()} inputMode="numeric" placeholder="Cant." />
        </div>
        <button type="button" onClick={addDraftItem} className="h-10 rounded-[14px] border border-[#232632] text-sm font-medium text-[#F5F7FB]">
          Agregar item
        </button>

        {draftItems.length === 0 ? (
          <div className="rounded-[18px] border border-dashed border-[#2A3040] bg-[#0F131B] px-4 py-4 text-sm text-[#AAB2C5]">
            Agrega al menos un producto para activar el pedido.
          </div>
        ) : (
          <div className="space-y-2">
            {draftItems.map((item) => (
              <div key={item.localId} className="flex items-center justify-between gap-3 rounded-[18px] border border-[#232632] bg-[#0F131B] px-3.5 py-3">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-[#F5F7FB]">{item.product_name_snapshot}</div>
                  <div className="mt-1 text-xs text-[#8B93A7]">{item.qty} x {formatUsd(item.unit_price_usd_snapshot)}</div>
                </div>
                <div className="flex items-center gap-3">
                  <div className="text-sm font-medium text-[#F0D000]">{formatUsd(item.line_total_usd)}</div>
                  <button type="button" onClick={() => removeDraftItem(item.localId)} className="text-xs text-[#AAB2C5]">
                    Quitar
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section title="3. Entrega" subtitle="Solo la direccion y notas crecen cuando hace falta.">
        <div className="grid grid-cols-2 gap-2">
          <button type="button" onClick={() => setFulfillment('pickup')} className={['h-10 rounded-[14px] border text-sm font-medium', fulfillment === 'pickup' ? 'border-[#F0D000] bg-[#201B08] text-[#F7DA66]' : 'border-[#232632] text-[#F5F7FB]'].join(' ')}>
            Retiro
          </button>
          <button type="button" onClick={() => setFulfillment('delivery')} className={['h-10 rounded-[14px] border text-sm font-medium', fulfillment === 'delivery' ? 'border-[#F0D000] bg-[#201B08] text-[#F7DA66]' : 'border-[#232632] text-[#F5F7FB]'].join(' ')}>
            Delivery
          </button>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Fecha">
            <input type="date" value={deliveryDate} onChange={(e) => setDeliveryDate(e.target.value)} className={inputClass()} />
          </Field>
          <Field label="Hora">
            <div className="grid grid-cols-[1fr_1fr_78px] gap-2">
              <input value={deliveryHour12} onChange={(e) => setDeliveryHour12(e.target.value)} className={inputClass()} inputMode="numeric" />
              <input value={deliveryMinute} onChange={(e) => setDeliveryMinute(e.target.value)} className={inputClass()} inputMode="numeric" />
              <select value={deliveryAmPm} onChange={(e) => setDeliveryAmPm(e.target.value as 'AM' | 'PM')} className={inputClass()}>
                <option value="AM">AM</option>
                <option value="PM">PM</option>
              </select>
            </div>
          </Field>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Recibe">
            <input value={receiverName} onChange={(e) => setReceiverName(e.target.value)} className={inputClass()} placeholder="Nombre" />
          </Field>
          <Field label="Telefono">
            <input value={receiverPhone} onChange={(e) => setReceiverPhone(e.target.value)} className={inputClass()} placeholder="Contacto" />
          </Field>
        </div>

        {fulfillment === 'delivery' ? (
          <Field label="Direccion" hint="Campo amplio solo cuando hace falta.">
            <textarea value={deliveryAddress} onChange={(e) => setDeliveryAddress(e.target.value)} className={inputClass(true)} placeholder="Direccion completa" />
          </Field>
        ) : null}
      </Section>

      <Section title="4. Pago y nota" subtitle="Semantica simple para una operacion real.">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Forma de pago">
            <select value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value as PaymentMethod)} className={inputClass()}>
              <option value="pending">Por definir</option>
              <option value="cash">Efectivo</option>
              <option value="transfer">Transferencia</option>
              <option value="zelle">Zelle</option>
              <option value="mixed">Mixto</option>
            </select>
          </Field>
          <Field label="Moneda">
            <select value={paymentCurrency} onChange={(e) => setPaymentCurrency(e.target.value as 'USD' | 'VES')} className={inputClass()}>
              <option value="USD">USD</option>
              <option value="VES">Bs</option>
            </select>
          </Field>
        </div>

        <Field label="Nota de pago">
          <input value={paymentNote} onChange={(e) => setPaymentNote(e.target.value)} className={inputClass()} placeholder="Referencia o acuerdo" />
        </Field>

        <Field label="Observaciones del pedido">
          <textarea value={orderNote} onChange={(e) => setOrderNote(e.target.value)} className={inputClass(true)} placeholder="Notas operativas utiles" />
        </Field>

        <label className="flex items-center gap-3 rounded-[18px] border border-[#232632] bg-[#0F131B] px-3.5 py-3 text-sm text-[#F5F7FB]">
          <input type="checkbox" checked={quoteOnly} onChange={(e) => setQuoteOnly(e.target.checked)} />
          <span>Solo presupuesto. No crea la orden todavia.</span>
        </label>
      </Section>

      <Section title="5. Resumen" subtitle="Confirmacion corta antes de guardar.">
        <div className="grid gap-2 text-sm text-[#AAB2C5]">
          <div className="flex items-center justify-between rounded-[16px] bg-[#0F131B] px-3.5 py-3">
            <span>Cliente</span>
            <span className="max-w-[60%] truncate text-right text-[#F5F7FB]">{selectedClient?.full_name || newClientName || 'Falta cliente'}</span>
          </div>
          <div className="flex items-center justify-between rounded-[16px] bg-[#0F131B] px-3.5 py-3">
            <span>Entrega</span>
            <span className="text-[#F5F7FB]">{fulfillment === 'delivery' ? 'Delivery' : 'Retiro'}</span>
          </div>
          <div className="flex items-center justify-between rounded-[16px] bg-[#0F131B] px-3.5 py-3">
            <span>Pago</span>
            <span className="text-[#F5F7FB]">{paymentMethod}</span>
          </div>
          <div className="flex items-center justify-between rounded-[16px] bg-[#0F131B] px-3.5 py-3">
            <span>Total</span>
            <span className="text-base font-semibold text-[#F0D000]">{formatUsd(draftTotalUsd)}</span>
          </div>
        </div>
      </Section>

      <div className="fixed inset-x-0 bottom-[68px] z-20 border-t border-[#1A1D26] bg-[#090B10]/96 px-4 py-3 backdrop-blur">
        <div className="mx-auto flex max-w-screen-md items-center justify-between gap-3">
          <div>
            <div className="text-[11px] uppercase tracking-[0.22em] text-[#8B93A7]">Total</div>
            <div className="text-lg font-semibold text-[#F5F7FB]">{formatUsd(draftTotalUsd)}</div>
          </div>
          <button
            type="submit"
            disabled={saving || !createReady}
            className={[
              'h-11 rounded-[16px] px-4 text-sm font-semibold',
              saving || !createReady ? 'bg-[#232632] text-[#6F7890]' : 'bg-[#F0D000] text-[#17191E]',
            ].join(' ')}
          >
            {saving ? 'Guardando...' : quoteOnly ? 'Guardar presupuesto' : 'Crear pedido'}
          </button>
        </div>
      </div>
    </form>
  );
}
