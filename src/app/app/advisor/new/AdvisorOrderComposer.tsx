'use client';

import Link from 'next/link';
import { type FormEvent, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createSupabaseBrowser } from '@/lib/supabase/browser';

type ClientType = 'assigned' | 'own' | 'legacy';
type FulfillmentType = 'pickup' | 'delivery';
type PaymentMethod =
  | 'pending'
  | 'payment_mobile'
  | 'transfer'
  | 'cash_usd'
  | 'cash_ves'
  | 'zelle'
  | 'mixed';
type CurrencyCode = 'USD' | 'VES';

type ClientRow = {
  id: number;
  full_name: string;
  phone: string | null;
  client_type: string | null;
  fund_balance_usd?: number | string | null;
};

type ProductRow = {
  id: number;
  sku: string | null;
  name: string;
  base_price_usd: number | string | null;
  source_price_currency: CurrencyCode | null;
  source_price_amount: number | string | null;
  is_detail_editable: boolean | null;
  detail_units_limit: number | null;
};

type ProductComponentRow = {
  parent_product_id: number;
  component_product_id: number;
  component_mode: 'fixed' | 'selectable';
  quantity: number | null;
  counts_toward_detail_limit: boolean | null;
  is_required: boolean | null;
  sort_order: number | null;
};

type ConfigSelection = {
  componentProductId: number;
  name: string;
  qty: number;
};

type DraftItem = {
  localId: string;
  product_id: number;
  sku_snapshot: string | null;
  product_name_snapshot: string;
  qty: number;
  source_price_currency: CurrencyCode;
  source_price_amount: number;
  unit_price_usd_snapshot: number;
  line_total_usd: number;
  editable_detail_lines: string[];
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

function clientTypeLabel(value: string | null | undefined) {
  if (value === 'assigned') return 'Asignado';
  if (value === 'own') return 'Propio';
  if (value === 'legacy') return 'Antiguo';
  return 'Sin clasificar';
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

function parseEditableDetailLines(lines: string[]) {
  let alias = '';
  const selections: Array<{ componentName: string; qty: number }> = [];

  for (const rawLine of lines) {
    const line = String(rawLine || '').trim();
    if (!line) continue;

    if (/^para\s*:/i.test(line)) {
      alias = line.replace(/^para\s*:/i, '').trim();
      continue;
    }

    const match = line.match(/^(\d+)\s+(.+)$/i);
    if (!match) continue;

    const qty = Number(match[1]);
    const componentName = match[2].trim();

    if (Number.isFinite(qty) && qty > 0 && componentName) {
      selections.push({ componentName, qty });
    }
  }

  return { alias, selections };
}

function ConfigSheet(props: {
  open: boolean;
  title: string;
  alias: string;
  setAlias: (value: string) => void;
  totalSelected: number;
  totalLimit: number;
  options: ProductRow[];
  selections: ConfigSelection[];
  onChangeQty: (product: ProductRow, qty: number) => void;
  onClose: () => void;
  onConfirm: () => void;
  isEditing: boolean;
}) {
  if (!props.open) return null;

  return (
    <div className="fixed inset-0 z-40 bg-[#040507]/84 backdrop-blur-sm">
      <div className="absolute inset-x-0 bottom-0 rounded-t-[28px] border border-[#232632] bg-[#0C1017] px-4 pb-6 pt-4">
        <div className="mx-auto max-w-screen-md space-y-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-[#8B93A7]">
                Configurar producto
              </div>
              <h3 className="mt-1 text-lg font-semibold text-[#F5F7FB]">{props.title}</h3>
              <div className="mt-1 text-xs text-[#8B93A7]">
                Seleccionado {props.totalSelected} de {props.totalLimit || 0} piezas
              </div>
            </div>
            <button
              type="button"
              onClick={props.onClose}
              className="inline-flex h-10 items-center rounded-[14px] border border-[#232632] px-3 text-sm text-[#F5F7FB]"
            >
              Cerrar
            </button>
          </div>

          <Field label="Para">
            <input
              value={props.alias}
              onChange={(e) => props.setAlias(e.target.value)}
              className={inputClass()}
              placeholder="Nombre o referencia"
            />
          </Field>

          <div className="space-y-2">
            {props.options.length === 0 ? (
              <div className="rounded-[18px] border border-dashed border-[#2A3040] bg-[#0F131B] px-4 py-4 text-sm text-[#AAB2C5]">
                Este producto no tiene opciones configuradas.
              </div>
            ) : (
              props.options.map((option) => {
                const currentQty =
                  props.selections.find((item) => item.componentProductId === option.id)?.qty || 0;

                return (
                  <div
                    key={option.id}
                    className="grid grid-cols-[1fr_88px] items-center gap-3 rounded-[18px] border border-[#232632] bg-[#0F131B] px-3.5 py-3"
                  >
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-[#F5F7FB]">{option.name}</div>
                      <div className="mt-1 text-xs text-[#8B93A7]">{option.sku || 'Sin codigo'}</div>
                    </div>
                    <input
                      value={String(currentQty)}
                      onChange={(e) => props.onChangeQty(option, Number(e.target.value || 0))}
                      className={inputClass()}
                      inputMode="numeric"
                    />
                  </div>
                );
              })
            )}
          </div>

          <button
            type="button"
            onClick={props.onConfirm}
            className="h-11 w-full rounded-[16px] bg-[#F0D000] text-sm font-semibold text-[#17191E]"
          >
            {props.isEditing ? 'Guardar composicion' : 'Confirmar composicion'}
          </button>
        </div>
      </div>
    </div>
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
  const [productComponents, setProductComponents] = useState<ProductComponentRow[]>([]);
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
  const [isAsap, setIsAsap] = useState(false);
  const [receiverName, setReceiverName] = useState('');
  const [receiverPhone, setReceiverPhone] = useState('');
  const [deliveryAddress, setDeliveryAddress] = useState('');
  const [deliveryGpsUrl, setDeliveryGpsUrl] = useState('');
  const [orderNote, setOrderNote] = useState('');
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('pending');
  const [paymentCurrency, setPaymentCurrency] = useState<CurrencyCode>('USD');
  const [paymentRequiresChange, setPaymentRequiresChange] = useState(false);
  const [paymentChangeFor, setPaymentChangeFor] = useState('');
  const [paymentChangeCurrency, setPaymentChangeCurrency] = useState<CurrencyCode>('USD');
  const [paymentNote, setPaymentNote] = useState('');
  const [discountEnabled, setDiscountEnabled] = useState(false);
  const [discountPct, setDiscountPct] = useState('0');

  const [configOpen, setConfigOpen] = useState(false);
  const [configEditingLocalId, setConfigEditingLocalId] = useState<string | null>(null);
  const [configProductId, setConfigProductId] = useState<number | null>(null);
  const [configQty, setConfigQty] = useState(1);
  const [configAlias, setConfigAlias] = useState('');
  const [configSelections, setConfigSelections] = useState<ConfigSelection[]>([]);

  const selectedProduct = useMemo(() => {
    if (selectedProductId === '') return null;
    return products.find((product) => product.id === selectedProductId) ?? null;
  }, [products, selectedProductId]);

  const productById = useMemo(() => new Map(products.map((product) => [product.id, product])), [products]);
  const draftTotalUsd = useMemo(
    () => draftItems.reduce((sum, item) => sum + Number(item.line_total_usd || 0), 0),
    [draftItems]
  );
  const selectedClientFundUsd = Number(selectedClient?.fund_balance_usd ?? 0) || 0;
  const discountPctNumber = Math.max(0, Math.min(100, Number(discountPct || 0) || 0));
  const discountAmountUsd = discountEnabled ? Number((draftTotalUsd * (discountPctNumber / 100)).toFixed(2)) : 0;
  const finalTotalUsd = Number(Math.max(0, draftTotalUsd - discountAmountUsd).toFixed(2));

  const configProduct = useMemo(
    () => (configProductId ? productById.get(configProductId) ?? null : null),
    [configProductId, productById]
  );

  const configOptions = useMemo(() => {
    if (!configProductId) return [];
    return productComponents
      .filter((row) => row.parent_product_id === configProductId && row.component_mode === 'selectable')
      .sort((a, b) => Number(a.sort_order || 0) - Number(b.sort_order || 0))
      .map((row) => productById.get(row.component_product_id))
      .filter((row): row is ProductRow => !!row);
  }, [configProductId, productById, productComponents]);

  const configBaseLimit = Number(configProduct?.detail_units_limit || 0);
  const configTotalLimit = configBaseLimit > 0 ? configBaseLimit * Math.max(1, configQty) : 0;
  const configSelectedUnits = configSelections.reduce((sum, item) => sum + Number(item.qty || 0), 0);

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

      const [{ data: productData, error: productError }, { data: componentData, error: componentError }] =
        await Promise.all([
          supabase
            .from('products')
            .select(
              'id, sku, name, base_price_usd, source_price_currency, source_price_amount, is_detail_editable, detail_units_limit'
            )
            .eq('is_active', true)
            .order('name', { ascending: true }),
          supabase
            .from('product_components')
            .select(
              'parent_product_id, component_product_id, component_mode, quantity, counts_toward_detail_limit, is_required, sort_order'
            )
            .order('parent_product_id', { ascending: true })
            .order('sort_order', { ascending: true }),
        ]);

      if (productError) setError(productError.message);
      else setProducts((productData ?? []) as ProductRow[]);

      if (componentError) setError(componentError.message);
      else setProductComponents((componentData ?? []) as ProductComponentRow[]);

      setLoading(false);
    }

    void boot();
  }, [router, supabase]);

  useEffect(() => {
    if (paymentMethod === 'cash_ves' || paymentMethod === 'transfer' || paymentMethod === 'payment_mobile') {
      setPaymentCurrency('VES');
    } else if (paymentMethod === 'cash_usd' || paymentMethod === 'zelle' || paymentMethod === 'pending') {
      setPaymentCurrency('USD');
    }
  }, [paymentMethod]);

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
      .select('id, full_name, phone, client_type, fund_balance_usd')
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
        .select('id, full_name, phone, client_type, fund_balance_usd')
        .eq('phone', phone)
        .limit(1);

      if (existingError) throw new Error(existingError.message);

      if (existing && existing.length > 0) {
        const current = existing[0] as ClientRow;
        setSelectedClient(current);
        setSearchTerm(current.phone ?? current.full_name);
        setIsNewClientMode(false);
        setClientResults([]);
        setInfo(`Cliente listo: ${current.full_name}`);
        return current.id;
      }

      const { data: created, error: createError } = await supabase
        .from('clients')
        .insert({ full_name, phone, client_type: newClientType })
        .select('id, full_name, phone, client_type, fund_balance_usd')
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

  function resetConfig() {
    setConfigOpen(false);
    setConfigEditingLocalId(null);
    setConfigProductId(null);
    setConfigQty(1);
    setConfigAlias('');
    setConfigSelections([]);
  }

  function buildDraftItem(product: ProductRow, quantity: number, lines: string[]) {
    const unitPriceUsd = Number(product.base_price_usd ?? 0);
    const lineTotal = Number((unitPriceUsd * quantity).toFixed(2));

    return {
      localId: `${product.id}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      product_id: product.id,
      sku_snapshot: product.sku,
      product_name_snapshot: product.name,
      qty: quantity,
      source_price_currency: (product.source_price_currency || 'USD') as CurrencyCode,
      source_price_amount: Number(product.source_price_amount ?? product.base_price_usd ?? 0) || 0,
      unit_price_usd_snapshot: unitPriceUsd,
      line_total_usd: lineTotal,
      editable_detail_lines: lines,
    } satisfies DraftItem;
  }

  function openConfigForProduct(product: ProductRow, quantity: number) {
    setConfigEditingLocalId(null);
    setConfigProductId(product.id);
    setConfigQty(quantity);
    setConfigAlias('');
    setConfigSelections([]);
    setConfigOpen(true);
  }

  function openEditConfig(item: DraftItem) {
    const parsed = parseEditableDetailLines(item.editable_detail_lines);
    const product = productById.get(item.product_id);
    if (!product) {
      setError('No se pudo cargar la configuracion del item.');
      return;
    }

    const nextOptions = productComponents
      .filter((row) => row.parent_product_id === product.id && row.component_mode === 'selectable')
      .map((row) => productById.get(row.component_product_id))
      .filter((row): row is ProductRow => !!row);

    setConfigEditingLocalId(item.localId);
    setConfigProductId(item.product_id);
    setConfigQty(item.qty);
    setConfigAlias(parsed.alias);
    setConfigSelections(
      parsed.selections
        .map((selection) => {
          const option =
            nextOptions.find((row) => row.name === selection.componentName) ??
            products.find((row) => row.name === selection.componentName);
          if (!option) return null;
          return {
            componentProductId: option.id,
            name: option.name,
            qty: selection.qty,
          };
        })
        .filter((row): row is ConfigSelection => !!row)
    );
    setConfigOpen(true);
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

    const hasSelectableComponents = productComponents.some(
      (row) => row.parent_product_id === selectedProduct.id && row.component_mode === 'selectable'
    );

    if (selectedProduct.is_detail_editable || hasSelectableComponents) {
      openConfigForProduct(selectedProduct, quantity);
      return;
    }

    setDraftItems((current) => [...current, buildDraftItem(selectedProduct, quantity, [])]);
    setQty('1');
    setSelectedProductId('');
  }

  function removeDraftItem(localId: string) {
    setDraftItems((current) => current.filter((item) => item.localId !== localId));
  }

  function setConfigSelectionQty(product: ProductRow, quantity: number) {
    const nextQty = Number.isFinite(quantity) && quantity > 0 ? Math.floor(quantity) : 0;

    setConfigSelections((current) => {
      const rest = current.filter((item) => item.componentProductId !== product.id);
      if (nextQty <= 0) return rest;
      return [...rest, { componentProductId: product.id, name: product.name, qty: nextQty }];
    });
  }

  function confirmConfig() {
    if (!configProduct) {
      setError('No se encontro el producto a configurar.');
      return;
    }

    if (configTotalLimit > 0 && configSelectedUnits !== configTotalLimit) {
      setError(`Debes completar ${configTotalLimit} piezas para este producto.`);
      return;
    }

    if (configOptions.length > 0 && configSelections.length === 0) {
      setError('Selecciona la composicion interna del producto.');
      return;
    }

    const detailLines = [
      configAlias.trim() ? `Para: ${configAlias.trim()}` : null,
      ...configSelections
        .sort((a, b) => a.name.localeCompare(b.name, 'es'))
        .map((item) => `${item.qty} ${item.name}`),
    ].filter((line): line is string => !!line);

    const item = buildDraftItem(configProduct, configQty, detailLines);

    if (configEditingLocalId) {
      setDraftItems((current) =>
        current.map((draft) =>
          draft.localId === configEditingLocalId ? { ...item, localId: draft.localId } : draft
        )
      );
    } else {
      setDraftItems((current) => [...current, item]);
    }

    setQty('1');
    setSelectedProductId('');
    resetConfig();
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
        asap: isAsap,
      },
      receiver: {
        name: receiverName.trim() || null,
        phone: receiverPhone.trim() ? normalizePhone(receiverPhone.trim()) : null,
      },
      delivery: {
        address: fulfillment === 'delivery' ? deliveryAddress.trim() || null : null,
        gps_url: fulfillment === 'delivery' ? deliveryGpsUrl.trim() || null : null,
      },
      payment: {
        method: paymentMethod,
        currency: paymentCurrency,
        requires_change: paymentRequiresChange,
        change_for: paymentRequiresChange && paymentChangeFor.trim() ? Number(paymentChangeFor) : null,
        change_currency: paymentRequiresChange ? paymentChangeCurrency : null,
        notes: paymentNote.trim() || null,
      },
      pricing: {
        discount_enabled: discountEnabled,
        discount_pct: discountEnabled ? discountPctNumber : 0,
        discount_amount_usd: discountEnabled ? discountAmountUsd : 0,
        subtotal_usd: draftTotalUsd,
        total_usd: finalTotalUsd,
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
      setInfo(`Presupuesto listo por ${formatUsd(finalTotalUsd)}. Aun no se creo la orden.`);
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
          total_usd: finalTotalUsd,
          is_price_locked: false,
          delivery_address: fulfillment === 'delivery' ? deliveryAddress.trim() || null : null,
          receiver_name: receiverName.trim() || null,
          receiver_phone: receiverPhone.trim() ? normalizePhone(receiverPhone.trim()) : null,
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
        pricing_origin_currency: item.source_price_currency,
        pricing_origin_amount: item.source_price_amount,
        unit_price_usd_snapshot: item.unit_price_usd_snapshot,
        line_total_usd: item.line_total_usd,
        sku_snapshot: item.sku_snapshot,
        product_name_snapshot: item.product_name_snapshot,
        notes: item.editable_detail_lines.length > 0 ? item.editable_detail_lines.join('\n') : null,
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
    return (
      <div className="rounded-[24px] border border-[#232632] bg-[#12151d] px-4 py-5 text-sm text-[#AAB2C5]">
        Cargando captura del asesor...
      </div>
    );
  }

  return (
    <>
      <form onSubmit={handleSubmit} className="space-y-4 pb-28">
        <section className="rounded-[22px] border border-[#232632] bg-[#12151d] px-4 py-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-[#8B93A7]">
                Nuevo pedido
              </p>
              <h1 className="mt-1 text-[20px] font-semibold tracking-[-0.04em] text-[#F5F7FB]">
                Crear pedido
              </h1>
            </div>
            <Link
              href="/app/advisor/orders"
              className="inline-flex h-10 items-center rounded-[14px] border border-[#232632] px-3.5 text-sm font-medium text-[#F5F7FB]"
            >
              Salir
            </Link>
          </div>
        </section>

        {error ? <div className="rounded-[18px] border border-[#5E2229] bg-[#261114] px-4 py-3 text-sm text-[#F0A6AE]">{error}</div> : null}
        {info ? <div className="rounded-[18px] border border-[#1C5036] bg-[#0F2119] px-4 py-3 text-sm text-[#7CE0A9]">{info}</div> : null}

        <Section title="1. Cliente" subtitle="Busca primero y crea solo si no existe.">
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
              <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                <div className="rounded-[14px] border border-[#232632] bg-[#12151d] px-3 py-2">
                  <div className="text-[#8B93A7]">Tipo</div>
                  <div className="mt-1 font-medium text-[#F5F7FB]">
                    {clientTypeLabel(selectedClient.client_type)}
                  </div>
                </div>
                <div className="rounded-[14px] border border-[#232632] bg-[#12151d] px-3 py-2">
                  <div className="text-[#8B93A7]">Fondo</div>
                  <div className="mt-1 font-medium text-[#F5F7FB]">
                    {selectedClientFundUsd > 0 ? formatUsd(selectedClientFundUsd) : 'Sin fondo'}
                  </div>
                </div>
              </div>
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
                    setClientResults([]);
                    setSearchTerm(client.phone ?? client.full_name);
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
        </Section>

        <Section title="2. Pedido" subtitle="Misma base operativa del master para items y total.">
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
                <div key={item.localId} className="rounded-[18px] border border-[#232632] bg-[#0F131B] px-3.5 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-[#F5F7FB]">{item.product_name_snapshot}</div>
                      <div className="mt-1 text-xs text-[#8B93A7]">
                        {item.qty} x {formatUsd(item.unit_price_usd_snapshot)}
                      </div>
                    </div>
                    <div className="text-sm font-medium text-[#F0D000]">{formatUsd(item.line_total_usd)}</div>
                  </div>

                  {item.editable_detail_lines.length > 0 ? (
                    <div className="mt-2 space-y-1 rounded-[14px] bg-[#0B0F15] px-3 py-2 text-xs text-[#AAB2C5]">
                      {item.editable_detail_lines.map((line, index) => (
                        <div key={`${item.localId}-${index}`}>• {line}</div>
                      ))}
                    </div>
                  ) : null}

                  <div className="mt-3 flex gap-2">
                    {item.editable_detail_lines.length > 0 ? (
                      <button type="button" onClick={() => openEditConfig(item)} className="h-9 rounded-[12px] border border-[#232632] px-3 text-xs font-medium text-[#F5F7FB]">
                        Editar
                      </button>
                    ) : null}
                    <button type="button" onClick={() => removeDraftItem(item.localId)} className="h-9 rounded-[12px] border border-[#5E2229] px-3 text-xs font-medium text-[#F0A6AE]">
                      Quitar
                    </button>
                  </div>
                </div>
              ))}

              <div className="grid gap-3 rounded-[18px] border border-[#232632] bg-[#0F131B] px-3.5 py-3">
                <label className="flex items-center gap-3 text-sm text-[#F5F7FB]">
                  <input
                    type="checkbox"
                    checked={discountEnabled}
                    onChange={(e) => {
                      setDiscountEnabled(e.target.checked);
                      if (!e.target.checked) setDiscountPct('0');
                    }}
                  />
                  <span>Aplicar descuento</span>
                </label>

                {discountEnabled ? (
                  <Field label="% Descuento">
                    <input
                      value={discountPct}
                      onChange={(e) => setDiscountPct(e.target.value)}
                      className={inputClass()}
                      inputMode="decimal"
                      placeholder="0"
                    />
                  </Field>
                ) : null}

                <div className="grid gap-2 text-sm text-[#AAB2C5]">
                  <div className="flex items-center justify-between rounded-[14px] bg-[#12151d] px-3 py-2">
                    <span>Subtotal</span>
                    <span className="text-[#F5F7FB]">{formatUsd(draftTotalUsd)}</span>
                  </div>
                  {discountEnabled ? (
                    <div className="flex items-center justify-between rounded-[14px] bg-[#12151d] px-3 py-2">
                      <span>Descuento</span>
                      <span className="text-[#F5F7FB]">-{formatUsd(discountAmountUsd)}</span>
                    </div>
                  ) : null}
                  <div className="flex items-center justify-between rounded-[14px] bg-[#12151d] px-3 py-2">
                    <span>Total</span>
                    <span className="font-semibold text-[#F0D000]">{formatUsd(finalTotalUsd)}</span>
                  </div>
                </div>
              </div>
            </div>
          )}
        </Section>

        <Section title="3. Entrega" subtitle="Con soporte para fecha fija o lo antes posible.">
          <div className="grid grid-cols-2 gap-2">
            <button type="button" onClick={() => setFulfillment('pickup')} className={['h-10 rounded-[14px] border text-sm font-medium', fulfillment === 'pickup' ? 'border-[#F0D000] bg-[#201B08] text-[#F7DA66]' : 'border-[#232632] text-[#F5F7FB]'].join(' ')}>
              Retiro
            </button>
            <button type="button" onClick={() => setFulfillment('delivery')} className={['h-10 rounded-[14px] border text-sm font-medium', fulfillment === 'delivery' ? 'border-[#F0D000] bg-[#201B08] text-[#F7DA66]' : 'border-[#232632] text-[#F5F7FB]'].join(' ')}>
              Delivery
            </button>
          </div>

          <button
            type="button"
            onClick={() => setIsAsap((current) => !current)}
            className={[
              'h-10 rounded-[14px] border text-sm font-medium',
              isAsap ? 'border-[#F0D000] bg-[#201B08] text-[#F7DA66]' : 'border-[#232632] text-[#F5F7FB]',
            ].join(' ')}
          >
            Lo antes posible
          </button>

          <Field label="Fecha">
            <input type="date" value={deliveryDate} onChange={(e) => { setDeliveryDate(e.target.value); setIsAsap(false); }} className={inputClass()} />
          </Field>

          <Field label="Hora">
            <div className="grid grid-cols-[72px_72px_minmax(92px,1fr)] gap-2">
              <input value={deliveryHour12} onChange={(e) => { setDeliveryHour12(e.target.value); setIsAsap(false); }} className={inputClass()} inputMode="numeric" />
              <input value={deliveryMinute} onChange={(e) => { setDeliveryMinute(e.target.value); setIsAsap(false); }} className={inputClass()} inputMode="numeric" />
              <select value={deliveryAmPm} onChange={(e) => { setDeliveryAmPm(e.target.value as 'AM' | 'PM'); setIsAsap(false); }} className={inputClass()}>
                <option value="AM">AM</option>
                <option value="PM">PM</option>
              </select>
            </div>
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Recibe">
              <input value={receiverName} onChange={(e) => setReceiverName(e.target.value)} className={inputClass()} placeholder="Nombre" />
            </Field>
            <Field label="Telefono">
              <input value={receiverPhone} onChange={(e) => setReceiverPhone(e.target.value)} className={inputClass()} placeholder="Contacto" />
            </Field>
          </div>

          {fulfillment === 'delivery' ? (
            <>
              <Field label="Direccion" hint="Solo este campo puede crecer mas cuando haga falta.">
                <textarea value={deliveryAddress} onChange={(e) => setDeliveryAddress(e.target.value)} className={inputClass(true)} placeholder="Direccion completa" />
              </Field>
              <Field label="GPS URL">
                <input value={deliveryGpsUrl} onChange={(e) => setDeliveryGpsUrl(e.target.value)} className={inputClass()} placeholder="Link de ubicacion" />
              </Field>
            </>
          ) : null}
        </Section>

        <Section title="4. Pago y notas" subtitle="Misma operacion base de master, sin ruido extra.">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Forma de pago">
              <select value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value as PaymentMethod)} className={inputClass()}>
                <option value="pending">Pendiente</option>
                <option value="payment_mobile">Pago movil</option>
                <option value="transfer">Transferencia</option>
                <option value="cash_usd">Efectivo USD</option>
                <option value="cash_ves">Efectivo Bs</option>
                <option value="zelle">Zelle</option>
                <option value="mixed">Mixto</option>
              </select>
            </Field>
            <Field label="Moneda principal">
              <select value={paymentCurrency} onChange={(e) => setPaymentCurrency(e.target.value as CurrencyCode)} className={inputClass()} disabled={paymentMethod !== 'mixed'}>
                <option value="USD">USD</option>
                <option value="VES">Bs</option>
              </select>
            </Field>
          </div>

          <label className="flex items-center gap-3 rounded-[18px] border border-[#232632] bg-[#0F131B] px-3.5 py-3 text-sm text-[#F5F7FB]">
            <input type="checkbox" checked={paymentRequiresChange} onChange={(e) => setPaymentRequiresChange(e.target.checked)} />
            <span>Requiere cambio</span>
          </label>

          {paymentRequiresChange ? (
            <div className="grid grid-cols-2 gap-3">
              <Field label="Cambio para">
                <input value={paymentChangeFor} onChange={(e) => setPaymentChangeFor(e.target.value)} className={inputClass()} inputMode="decimal" placeholder="Monto" />
              </Field>
              <Field label="Moneda del cambio">
                <select value={paymentChangeCurrency} onChange={(e) => setPaymentChangeCurrency(e.target.value as CurrencyCode)} className={inputClass()}>
                  <option value="USD">USD</option>
                  <option value="VES">Bs</option>
                </select>
              </Field>
            </div>
          ) : null}

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

        <Section title="5. Resumen" subtitle="Lectura rapida antes de guardar.">
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
              <span>Momento</span>
              <span className="text-[#F5F7FB]">{isAsap ? 'Lo antes posible' : `${deliveryDate} ${deliveryHour12}:${deliveryMinute} ${deliveryAmPm}`}</span>
            </div>
            <div className="flex items-center justify-between rounded-[16px] bg-[#0F131B] px-3.5 py-3">
              <span>Pago</span>
              <span className="text-[#F5F7FB]">{paymentMethod}</span>
            </div>
            {discountEnabled ? (
              <div className="flex items-center justify-between rounded-[16px] bg-[#0F131B] px-3.5 py-3">
                <span>Descuento</span>
                <span className="text-[#F5F7FB]">{discountPctNumber}%</span>
              </div>
            ) : null}
            <div className="flex items-center justify-between rounded-[16px] bg-[#0F131B] px-3.5 py-3">
              <span>Total</span>
              <span className="text-base font-semibold text-[#F0D000]">{formatUsd(finalTotalUsd)}</span>
            </div>
          </div>
        </Section>

        <div className="fixed inset-x-0 bottom-[68px] z-20 border-t border-[#1A1D26] bg-[#090B10]/96 px-4 py-3 backdrop-blur">
          <div className="mx-auto flex max-w-screen-md items-center justify-between gap-3">
            <div>
              <div className="text-[11px] uppercase tracking-[0.22em] text-[#8B93A7]">Total</div>
              <div className="text-lg font-semibold text-[#F5F7FB]">{formatUsd(finalTotalUsd)}</div>
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

      <ConfigSheet
        open={configOpen}
        title={configProduct?.name || 'Configurar producto'}
        alias={configAlias}
        setAlias={setConfigAlias}
        totalSelected={configSelectedUnits}
        totalLimit={configTotalLimit}
        options={configOptions}
        selections={configSelections}
        onChangeQty={setConfigSelectionQty}
        onClose={resetConfig}
        onConfirm={confirmConfig}
        isEditing={!!configEditingLocalId}
      />
    </>
  );
}
