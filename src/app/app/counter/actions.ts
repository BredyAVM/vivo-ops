'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@supabase/supabase-js';
import { requireAuthContext } from '@/lib/auth';
import { formatOrderDisplayNumber } from '@/lib/orders/order-labels';
import { getOrderMoneySnapshot } from '@/lib/orders/order-money';
import { getPhoneSearchTerms, normalizePhone } from '@/lib/phone/normalize-phone';
import { calculateOrderLineSnapshot, calculateOrderTotalsSnapshot } from '@/lib/pricing/order-snapshots';

type CounterQuickSaleInput = {
  clientName: string;
  clientPhone: string;
  fulfillment: 'pickup' | 'delivery';
  deliveryAddress: string;
  note: string;
  scheduleAsap: boolean;
  scheduledDate: string;
  scheduledTime: string;
  paymentMethod: string;
  paymentCurrency: 'USD' | 'VES';
  paymentRequiresChange: boolean;
  paymentChangeFor: string;
  paymentChangeCurrency: 'USD' | 'VES';
  paymentNote: string;
  items: Array<{
    productId: number;
    qty: number;
    notes?: string | null;
  }>;
};

type CounterProductRow = {
  id: number;
  sku: string | null;
  name: string | null;
  source_price_currency: string | null;
  source_price_amount: number | string | null;
  base_price_usd: number | string | null;
  base_price_bs: number | string | null;
};

type CounterOrderForItemsRow = {
  id: number;
  order_number: string | null;
  status: string | null;
  total_usd: number | string | null;
  total_bs_snapshot: number | string | null;
  extra_fields: Record<string, any> | null;
};

type CounterExistingItemRow = {
  line_total_usd: number | string | null;
  line_total_bs_snapshot: number | string | null;
};

type CounterAddItemsInput = {
  orderId: number;
  items: Array<{
    productId: number;
    qty: number;
    notes?: string | null;
  }>;
};

type CounterCashMovementInput = {
  direction: 'inflow' | 'outflow';
  outflowPurpose?: 'change' | 'expense' | null;
  moneyAccountId: number;
  amount: number;
  movementDate: string;
  exchangeRateVesPerUsd: number | null;
  referenceCode?: string | null;
  counterpartyName?: string | null;
  description: string;
  notes?: string | null;
};

export type CounterAgendaSearchResult = {
  id: number;
  displayNumber: string;
  orderNumber: string | null;
  status: 'created' | 'confirmed' | 'in_kitchen' | 'ready' | 'out_for_delivery';
  fulfillment: 'pickup' | 'delivery';
  clientName: string;
  clientPhone: string | null;
  scheduledDate: string | null;
  scheduledTime: string | null;
  totalUsd: number;
  totalBs: number;
  note: string | null;
};

type CounterAgendaOrderRow = {
  id: number;
  order_number: string | null;
  status: 'created' | 'confirmed' | 'in_kitchen' | 'ready' | 'out_for_delivery';
  fulfillment: 'pickup' | 'delivery';
  total_usd: number | string | null;
  total_bs_snapshot: number | string | null;
  notes: string | null;
  created_at: string;
  extra_fields: {
    schedule?: {
      date?: string | null;
      time_12?: string | null;
      time_24?: string | null;
      asap?: boolean | null;
    } | null;
  } | null;
  client:
    | { full_name: string | null; phone: string | null }[]
    | { full_name: string | null; phone: string | null }
    | null;
};

function createSupabaseServiceRoleServer() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error('Falta configurar SUPABASE_SERVICE_ROLE_KEY para acciones de mostrador.');
  }

  return createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

function toSafeNumber(value: unknown, fallback = 0) {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : fallback;
}

function pad2(value: number) {
  return String(value).padStart(2, '0');
}

function pad4(value: number) {
  return String(value).padStart(4, '0');
}

function getCaracasDateParts() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Caracas',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date());
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  const hour = Number(get('hour') || 0);
  const minute = Number(get('minute') || 0);
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  const ampm = hour >= 12 ? 'PM' : 'AM';

  return {
    dateKey: `${get('year')}${get('month')}${get('day')}`,
    date: `${get('year')}-${get('month')}-${get('day')}`,
    time24: `${pad2(hour)}:${pad2(minute)}`,
    time12: `${hour12}:${pad2(minute)} ${ampm}`,
  };
}

function normalizeSchedule(input: CounterQuickSaleInput) {
  const current = getCaracasDateParts();
  if (input.scheduleAsap) {
    return {
      date: current.date,
      time24: current.time24,
      time12: current.time12,
      asap: true,
    };
  }

  const date = String(input.scheduledDate || '').trim();
  const time24 = String(input.scheduledTime || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error('Indica una fecha valida para agendar el pedido.');
  }
  if (!/^\d{2}:\d{2}$/.test(time24)) {
    throw new Error('Indica una hora valida para agendar el pedido.');
  }

  const [rawHour, rawMinute] = time24.split(':');
  const hour = Number(rawHour);
  const minute = Number(rawMinute);
  if (!Number.isFinite(hour) || hour < 0 || hour > 23 || !Number.isFinite(minute) || minute < 0 || minute > 59) {
    throw new Error('Indica una hora valida para agendar el pedido.');
  }

  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  const ampm = hour >= 12 ? 'PM' : 'AM';

  return {
    date,
    time24,
    time12: `${hour12}:${pad2(minute)} ${ampm}`,
    asap: false,
  };
}

function buildClientPhoneOrFilters(phone: string) {
  return [
    `phone.eq.${phone}`,
    ...getPhoneSearchTerms(phone)
      .map((term) => term.replace(/[,%]/g, ' '))
      .filter(Boolean)
      .slice(0, 5)
      .map((term) => `phone.ilike.%${term}%`),
  ];
}

function buildClientSearchOrFilters(term: string) {
  const safeTerm = term.replace(/[,%]/g, ' ').trim();
  const normalizedPhone = normalizePhone(term);
  const filters = new Set<string>();

  if (safeTerm) {
    filters.add(`full_name.ilike.%${safeTerm}%`);
    filters.add(`phone.ilike.%${safeTerm}%`);
  }

  for (const phoneTerm of getPhoneSearchTerms(normalizedPhone || term)) {
    const safePhoneTerm = phoneTerm.replace(/[,%]/g, ' ').trim();
    if (safePhoneTerm) filters.add(`phone.ilike.%${safePhoneTerm}%`);
  }

  return Array.from(filters);
}

function normalizeAgendaClient(order: CounterAgendaOrderRow) {
  return Array.isArray(order.client) ? order.client[0] ?? null : order.client;
}

function mapAgendaOrder(order: CounterAgendaOrderRow): CounterAgendaSearchResult {
  const client = normalizeAgendaClient(order);
  const schedule = order.extra_fields?.schedule;

  return {
    id: order.id,
    displayNumber: formatOrderDisplayNumber(order.id),
    orderNumber: order.order_number,
    status: order.status,
    fulfillment: order.fulfillment,
    clientName: client?.full_name || 'Cliente',
    clientPhone: client?.phone || null,
    scheduledDate: schedule?.date || null,
    scheduledTime: schedule?.asap ? 'Lo antes posible' : schedule?.time_12 || schedule?.time_24 || null,
    totalUsd: toSafeNumber(order.total_usd, 0),
    totalBs: toSafeNumber(order.total_bs_snapshot, 0),
    note: order.notes || null,
  };
}

async function searchAgendaOrdersBy(
  supabase: ReturnType<typeof createSupabaseServiceRoleServer>,
  mode: 'id' | 'order_number' | 'client_ids',
  value: number | string | number[]
) {
  const selectColumns = [
    'id',
    'order_number',
    'status',
    'fulfillment',
    'total_usd',
    'total_bs_snapshot',
    'notes',
    'created_at',
    'extra_fields',
    'client:clients(full_name, phone)',
  ].join(', ');
  let query = supabase
    .from('orders')
    .select(selectColumns)
    .in('status', ['created', 'confirmed', 'in_kitchen', 'ready', 'out_for_delivery'])
    .order('created_at', { ascending: false })
    .limit(12);

  if (mode === 'id') query = query.eq('id', value as number);
  if (mode === 'order_number') query = query.ilike('order_number', `%${String(value).replace(/[,%]/g, ' ')}%`);
  if (mode === 'client_ids') query = query.in('client_id', value as number[]);

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as CounterAgendaOrderRow[];
}

async function loadActiveExchangeRate(supabase: ReturnType<typeof createSupabaseServiceRoleServer>) {
  const { data, error } = await supabase
    .from('exchange_rates')
    .select('rate_bs_per_usd')
    .eq('is_active', true)
    .order('effective_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(error.message);

  const rate = toSafeNumber(data?.rate_bs_per_usd, 0);
  if (rate <= 0) throw new Error('No hay una tasa activa valida.');
  return rate;
}

async function generateUniqueOrderNumber(supabase: ReturnType<typeof createSupabaseServiceRoleServer>) {
  const { dateKey } = getCaracasDateParts();

  for (let i = 0; i < 20; i += 1) {
    const orderNumber = `VO-${dateKey}-${pad4(Math.floor(Math.random() * 10000))}`;
    const { data, error } = await supabase.from('orders').select('id').eq('order_number', orderNumber).maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return orderNumber;
  }

  throw new Error('No se pudo generar un numero de orden unico.');
}

export async function createCounterQuickSaleAction(input: CounterQuickSaleInput) {
  const ctx = await requireAuthContext();
  const allowed = ctx.roles.includes('admin') || ctx.roles.includes('master') || ctx.roles.includes('counter');
  if (!allowed) {
    throw new Error('Esta accion requiere permisos de mostrador, master o administrador.');
  }

  const clientName = String(input.clientName || '').trim();
  const phone = normalizePhone(input.clientPhone || '');
  const fulfillment = input.fulfillment === 'delivery' ? 'delivery' : 'pickup';
  const deliveryAddress = String(input.deliveryAddress || '').trim();
  const items = (input.items || [])
    .map((item) => ({
      productId: Number(item.productId || 0),
      qty: Math.max(0, Number(item.qty || 0)),
      notes: String(item.notes || '').trim() || null,
    }))
    .filter((item) => item.productId > 0 && item.qty > 0);

  if (!clientName) throw new Error('Indica el nombre del cliente.');
  if (!phone) throw new Error('Indica un telefono valido del cliente.');
  if (fulfillment === 'delivery' && !deliveryAddress) throw new Error('La direccion es obligatoria para delivery.');
  if (items.length === 0) throw new Error('Agrega al menos un producto.');

  const supabase = createSupabaseServiceRoleServer();
  const fxRate = await loadActiveExchangeRate(supabase);
  const productIds = Array.from(new Set(items.map((item) => item.productId)));
  const { data: productsData, error: productsError } = await supabase
    .from('products')
    .select('id, sku, name, source_price_currency, source_price_amount, base_price_usd, base_price_bs')
    .in('id', productIds)
    .eq('is_active', true);

  if (productsError) throw new Error(productsError.message);

  const productsById = new Map<number, CounterProductRow>(
    ((productsData ?? []) as CounterProductRow[]).map((product) => [Number(product.id), product])
  );
  if (productsById.size !== productIds.length) {
    throw new Error('Uno de los productos no esta activo o no existe.');
  }

  const { data: existingClients, error: existingClientError } = await supabase
    .from('clients')
    .select('id')
    .or(buildClientPhoneOrFilters(phone).join(','))
    .limit(1);

  if (existingClientError) throw new Error(existingClientError.message);

  let clientId = Number(existingClients?.[0]?.id || 0);
  if (!clientId) {
    const { data: createdClient, error: createClientError } = await supabase
      .from('clients')
      .insert({
        full_name: clientName,
        phone,
        client_type: 'own',
      })
      .select('id')
      .single();

    if (createClientError) throw new Error(createClientError.message);
    clientId = Number(createdClient.id);
  }

  const itemSnapshots = items.map((item) => {
    const product = productsById.get(item.productId);
    if (!product) throw new Error('Producto no encontrado.');
    const sourceCurrency = product.source_price_currency === 'VES' ? 'VES' : 'USD';
    const sourceAmount =
      sourceCurrency === 'VES'
        ? toSafeNumber(product.source_price_amount, toSafeNumber(product.base_price_bs, 0))
        : toSafeNumber(product.source_price_amount, toSafeNumber(product.base_price_usd, 0));

    return calculateOrderLineSnapshot({
      sourceCurrency,
      sourceAmount,
      quantity: item.qty,
      fxRate,
      fallbackUnitUsd: toSafeNumber(product.base_price_usd, 0),
    });
  });
  const subtotalUsd = itemSnapshots.reduce((sum, snapshot) => sum + snapshot.lineUsd, 0);
  const subtotalBs = itemSnapshots.reduce((sum, snapshot) => sum + snapshot.lineBs, 0);
  const totals = calculateOrderTotalsSnapshot({ subtotalUsd, subtotalBs, discountPct: 0, invoiceTaxPct: 0 });
  const orderNumber = await generateUniqueOrderNumber(supabase);
  const nowIso = new Date().toISOString();
  const schedule = normalizeSchedule(input);
  const sendNowToKitchen = schedule.asap;
  const paymentChangeFor = String(input.paymentChangeFor || '').trim()
    ? toSafeNumber(String(input.paymentChangeFor).replace(',', '.'), 0)
    : null;
  const paymentMethod = String(input.paymentMethod || '').trim() || 'pending';
  const paymentCurrency = input.paymentCurrency === 'VES' ? 'VES' : 'USD';
  const paymentChangeCurrency = input.paymentChangeCurrency === 'VES' ? 'VES' : 'USD';
  const note = String(input.note || '').trim();

  const extraFields = {
    schedule: {
      date: schedule.date,
      time_12: schedule.time12,
      time_24: schedule.time24,
      asap: schedule.asap,
    },
    receiver: {
      name: null,
      phone: null,
    },
    delivery: {
      address: fulfillment === 'delivery' ? deliveryAddress : null,
      gps_url: null,
    },
    payment: {
      method: paymentMethod,
      currency: paymentCurrency,
      requires_change: Boolean(input.paymentRequiresChange),
      change_for: paymentChangeFor,
      change_currency: paymentChangeCurrency,
      notes: String(input.paymentNote || '').trim() || null,
      client_fund_used_usd: 0,
    },
    documents: {
      has_delivery_note: false,
      has_invoice: false,
      invoice_data_note: null,
      invoice_snapshot: null,
      delivery_note_snapshot: null,
    },
    pricing: {
      fx_rate: fxRate,
      discount_enabled: false,
      discount_pct: 0,
      discount_amount_usd: 0,
      discount_amount_bs: 0,
      invoice_tax_pct: 0,
      invoice_tax_amount_usd: 0,
      invoice_tax_amount_bs: 0,
      subtotal_usd: totals.subtotalAfterDiscountUsd,
      subtotal_bs: totals.subtotalAfterDiscountBs,
      subtotal_after_discount_usd: totals.subtotalAfterDiscountUsd,
      subtotal_after_discount_bs: totals.subtotalAfterDiscountBs,
      total_usd: totals.totalUsd,
      total_bs: totals.totalBs,
    },
    note: note || null,
    ui: {
      quote_only: false,
    },
    counter: {
      quick_sale: true,
      created_at: nowIso,
      scheduled_by_counter: !schedule.asap,
    },
  };

  const { data: createdOrder, error: orderError } = await supabase
    .from('orders')
    .insert({
      order_number: orderNumber,
      client_id: clientId,
      created_by_user_id: ctx.user.id,
      attributed_advisor_id: ctx.user.id,
      source: 'walk_in',
      fulfillment,
      status: sendNowToKitchen ? 'confirmed' : 'created',
      sent_to_kitchen_at: sendNowToKitchen ? nowIso : null,
      total_usd: totals.totalUsd,
      total_bs_snapshot: totals.totalBs,
      is_price_locked: false,
      delivery_address: fulfillment === 'delivery' ? deliveryAddress : null,
      receiver_name: null,
      receiver_phone: null,
      notes: note || null,
      extra_fields: extraFields,
    })
    .select('id')
    .single();

  if (orderError) throw new Error(orderError.message);
  const orderId = Number(createdOrder.id);

  const itemsPayload = items.map((item, index) => {
    const product = productsById.get(item.productId);
    if (!product) throw new Error('Producto no encontrado.');
    const sourceCurrency = product.source_price_currency === 'VES' ? 'VES' : 'USD';
    const sourceAmount =
      sourceCurrency === 'VES'
        ? toSafeNumber(product.source_price_amount, toSafeNumber(product.base_price_bs, 0))
        : toSafeNumber(product.source_price_amount, toSafeNumber(product.base_price_usd, 0));
    const snapshot = itemSnapshots[index];

    return {
      order_id: orderId,
      product_id: item.productId,
      qty: item.qty,
      pricing_origin_currency: sourceCurrency,
      pricing_origin_amount: sourceAmount,
      unit_price_usd_snapshot: snapshot.unitUsd,
      line_total_usd: snapshot.lineUsd,
      unit_price_bs_snapshot: snapshot.unitBs,
      line_total_bs_snapshot: snapshot.lineBs,
      sku_snapshot: product.sku,
      product_name_snapshot: product.name || 'Producto',
      notes: item.notes,
    };
  });

  const { error: itemsError } = await supabase.from('order_items').insert(itemsPayload);
  if (itemsError) throw new Error(itemsError.message);

  await supabase.from('order_timeline_events').insert({
    order_id: orderId,
    order_number: orderNumber,
    event_type: sendNowToKitchen ? 'counter_quick_sale_created' : 'counter_scheduled_order_created',
    event_group: sendNowToKitchen ? 'kitchen' : 'approval',
    title: sendNowToKitchen ? 'Venta de mostrador enviada a cocina' : 'Pedido agendado por mostrador',
    message: sendNowToKitchen
      ? 'El counter creo la venta y la envio directamente a cocina.'
      : 'El counter creo un pedido agendado para que master lo envie a cocina cuando corresponda.',
    severity: sendNowToKitchen ? 'info' : 'warning',
    actor_user_id: ctx.user.id,
    payload: {
      source: 'counter_quick_sale',
      fulfillment,
      scheduled: !sendNowToKitchen,
      schedule_date: schedule.date,
      schedule_time: schedule.time24,
    },
  });

  revalidatePath('/app/counter');
  revalidatePath('/app/kitchen');
  revalidatePath('/app/master/dashboard');

  return { id: orderId, orderNumber, sentToKitchen: sendNowToKitchen, scheduled: !sendNowToKitchen };
}

export async function addCounterOrderItemsAction(input: CounterAddItemsInput) {
  const ctx = await requireAuthContext();
  const allowed = ctx.roles.includes('admin') || ctx.roles.includes('master') || ctx.roles.includes('counter');
  if (!allowed) {
    throw new Error('Esta accion requiere permisos de mostrador, master o administrador.');
  }

  const orderId = Number(input.orderId || 0);
  const items = (input.items || [])
    .map((item) => ({
      productId: Number(item.productId || 0),
      qty: Math.max(0, Number(item.qty || 0)),
      notes: String(item.notes || '').trim() || null,
    }))
    .filter((item) => item.productId > 0 && item.qty > 0);

  if (!Number.isFinite(orderId) || orderId <= 0) throw new Error('Orden invalida.');
  if (items.length === 0) throw new Error('Agrega al menos un producto.');

  const supabase = createSupabaseServiceRoleServer();
  const { data: orderData, error: orderError } = await supabase
    .from('orders')
    .select('id, order_number, status, total_usd, total_bs_snapshot, extra_fields')
    .eq('id', orderId)
    .single();

  if (orderError || !orderData) throw new Error(orderError?.message || 'No se pudo cargar la orden.');

  const order = orderData as CounterOrderForItemsRow;
  if (order.status === 'out_for_delivery' || order.status === 'delivered' || order.status === 'cancelled') {
    throw new Error('Esta orden ya no puede modificarse desde mostrador.');
  }

  const fxRate = await loadActiveExchangeRate(supabase);
  const productIds = Array.from(new Set(items.map((item) => item.productId)));
  const { data: productsData, error: productsError } = await supabase
    .from('products')
    .select('id, sku, name, source_price_currency, source_price_amount, base_price_usd, base_price_bs')
    .in('id', productIds)
    .eq('is_active', true);

  if (productsError) throw new Error(productsError.message);

  const productsById = new Map<number, CounterProductRow>(
    ((productsData ?? []) as CounterProductRow[]).map((product) => [Number(product.id), product])
  );
  if (productsById.size !== productIds.length) {
    throw new Error('Uno de los productos no esta activo o no existe.');
  }

  const itemSnapshots = items.map((item) => {
    const product = productsById.get(item.productId);
    if (!product) throw new Error('Producto no encontrado.');
    const sourceCurrency = product.source_price_currency === 'VES' ? 'VES' : 'USD';
    const sourceAmount =
      sourceCurrency === 'VES'
        ? toSafeNumber(product.source_price_amount, toSafeNumber(product.base_price_bs, 0))
        : toSafeNumber(product.source_price_amount, toSafeNumber(product.base_price_usd, 0));

    return calculateOrderLineSnapshot({
      sourceCurrency,
      sourceAmount,
      quantity: item.qty,
      fxRate,
      fallbackUnitUsd: toSafeNumber(product.base_price_usd, 0),
    });
  });

  const { data: existingItemsData, error: existingItemsError } = await supabase
    .from('order_items')
    .select('line_total_usd, line_total_bs_snapshot')
    .eq('order_id', orderId);

  if (existingItemsError) throw new Error(existingItemsError.message);

  const existingSubtotalUsd = ((existingItemsData ?? []) as CounterExistingItemRow[]).reduce(
    (sum, item) => sum + toSafeNumber(item.line_total_usd, 0),
    0
  );
  const existingSubtotalBs = ((existingItemsData ?? []) as CounterExistingItemRow[]).reduce(
    (sum, item) => sum + toSafeNumber(item.line_total_bs_snapshot, 0),
    0
  );
  const addedSubtotalUsd = itemSnapshots.reduce((sum, snapshot) => sum + snapshot.lineUsd, 0);
  const addedSubtotalBs = itemSnapshots.reduce((sum, snapshot) => sum + snapshot.lineBs, 0);
  const currentMoney = getOrderMoneySnapshot(order);
  const totals = calculateOrderTotalsSnapshot({
    subtotalUsd: existingSubtotalUsd + addedSubtotalUsd,
    subtotalBs: existingSubtotalBs + addedSubtotalBs,
    discountPct: currentMoney.discountEnabled ? currentMoney.discountPct : 0,
    invoiceTaxPct: currentMoney.hasInvoice ? currentMoney.invoiceTaxPct : 0,
  });

  const nowIso = new Date().toISOString();
  const shouldReturnToKitchen = order.status === 'ready';
  const itemsPayload = items.map((item, index) => {
    const product = productsById.get(item.productId);
    if (!product) throw new Error('Producto no encontrado.');
    const sourceCurrency = product.source_price_currency === 'VES' ? 'VES' : 'USD';
    const sourceAmount =
      sourceCurrency === 'VES'
        ? toSafeNumber(product.source_price_amount, toSafeNumber(product.base_price_bs, 0))
        : toSafeNumber(product.source_price_amount, toSafeNumber(product.base_price_usd, 0));
    const snapshot = itemSnapshots[index];

    return {
      order_id: orderId,
      product_id: item.productId,
      qty: item.qty,
      pricing_origin_currency: sourceCurrency,
      pricing_origin_amount: sourceAmount,
      unit_price_usd_snapshot: snapshot.unitUsd,
      line_total_usd: snapshot.lineUsd,
      unit_price_bs_snapshot: snapshot.unitBs,
      line_total_bs_snapshot: snapshot.lineBs,
      sku_snapshot: product.sku,
      product_name_snapshot: product.name || 'Producto',
      notes: item.notes,
    };
  });

  const { error: insertItemsError } = await supabase.from('order_items').insert(itemsPayload);
  if (insertItemsError) throw new Error(insertItemsError.message);

  const currentExtraFields = order.extra_fields ?? {};
  const currentPricing = (currentExtraFields.pricing ?? {}) as Record<string, any>;
  const nextExtraFields = {
    ...currentExtraFields,
    pricing: {
      ...currentPricing,
      fx_rate: fxRate,
      discount_enabled: currentMoney.discountEnabled,
      discount_pct: currentMoney.discountEnabled ? currentMoney.discountPct : 0,
      discount_amount_usd: totals.discountAmountUsd,
      discount_amount_bs: totals.discountAmountBs,
      subtotal_usd: existingSubtotalUsd + addedSubtotalUsd,
      subtotal_bs: existingSubtotalBs + addedSubtotalBs,
      subtotal_after_discount_usd: totals.subtotalAfterDiscountUsd,
      subtotal_after_discount_bs: totals.subtotalAfterDiscountBs,
      invoice_tax_pct: currentMoney.hasInvoice ? currentMoney.invoiceTaxPct : 0,
      invoice_tax_amount_usd: totals.invoiceTaxAmountUsd,
      invoice_tax_amount_bs: totals.invoiceTaxAmountBs,
      total_usd: totals.totalUsd,
      total_bs: totals.totalBs,
    },
    counter: {
      ...((currentExtraFields.counter ?? {}) as Record<string, any>),
      last_added_items_at: nowIso,
      last_added_items_by: ctx.user.id,
    },
  };

  const updatePayload: Record<string, any> = {
    total_usd: totals.totalUsd,
    total_bs_snapshot: totals.totalBs,
    extra_fields: nextExtraFields,
  };
  if (shouldReturnToKitchen) {
    updatePayload.status = 'confirmed';
    updatePayload.ready_at = null;
    updatePayload.sent_to_kitchen_at = nowIso;
  }

  const { error: updateOrderError } = await supabase.from('orders').update(updatePayload).eq('id', orderId);
  if (updateOrderError) throw new Error(updateOrderError.message);

  await supabase.from('order_timeline_events').insert({
    order_id: orderId,
    order_number: order.order_number,
    event_type: 'counter_items_added',
    event_group: shouldReturnToKitchen ? 'kitchen' : 'order',
    title: shouldReturnToKitchen ? 'Mostrador agrego productos y regreso a cocina' : 'Mostrador agrego productos',
    message: `Se agregaron ${items.length} linea(s) desde mostrador.`,
    severity: shouldReturnToKitchen ? 'warning' : 'info',
    actor_user_id: ctx.user.id,
    payload: {
      source: 'counter',
      added_lines: items.length,
      returned_to_kitchen: shouldReturnToKitchen,
      total_usd: totals.totalUsd,
      total_bs: totals.totalBs,
    },
  });

  revalidatePath('/app/counter');
  revalidatePath('/app/kitchen');
  revalidatePath('/app/master/dashboard');

  return {
    ok: true,
    returnedToKitchen: shouldReturnToKitchen,
    addedLines: items.length,
    totalUsd: totals.totalUsd,
    totalBs: totals.totalBs,
  };
}

export async function createCounterCashMovementAction(input: CounterCashMovementInput) {
  const ctx = await requireAuthContext();
  const allowed = ctx.roles.includes('admin') || ctx.roles.includes('master') || ctx.roles.includes('counter');
  if (!allowed) {
    throw new Error('Esta accion requiere permisos de mostrador, master o administrador.');
  }

  const direction = input.direction === 'outflow' ? 'outflow' : 'inflow';
  const outflowPurpose = input.outflowPurpose === 'change' ? 'change' : 'expense';
  const moneyAccountId = Number(input.moneyAccountId || 0);
  const amount = Number(input.amount || 0);
  const movementDate = String(input.movementDate || '').trim();
  const referenceCode = String(input.referenceCode || '').trim() || null;
  const counterpartyName = String(input.counterpartyName || '').trim() || null;
  const description = String(input.description || '').trim();
  const notes = String(input.notes || '').trim() || null;

  if (!Number.isFinite(moneyAccountId) || moneyAccountId <= 0) {
    throw new Error('Debes seleccionar una cuenta.');
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('El monto debe ser mayor a 0.');
  }
  if (!movementDate || !/^\d{4}-\d{2}-\d{2}$/.test(movementDate)) {
    throw new Error('Debes indicar una fecha valida.');
  }
  if (!description) {
    throw new Error('Debes indicar el motivo.');
  }

  const supabase = createSupabaseServiceRoleServer();
  const { data: account, error: accountError } = await supabase
    .from('money_accounts')
    .select('id, name, currency_code, account_kind, is_active')
    .eq('id', moneyAccountId)
    .single();

  if (accountError || !account) {
    throw new Error(accountError?.message || 'No se pudo cargar la cuenta.');
  }
  if (!account.is_active) {
    throw new Error('La cuenta seleccionada esta inactiva.');
  }

  const accountKind = String(account.account_kind || '');
  if (accountKind !== 'cash' && accountKind !== 'pos') {
    throw new Error('Mostrador solo puede registrar movimientos directos en cajas y puntos.');
  }

  const currencyCode = String(account.currency_code || '').toUpperCase();
  if (currencyCode !== 'USD' && currencyCode !== 'VES') {
    throw new Error('La moneda de la cuenta no es valida.');
  }

  const { data: allowedRule, error: allowedRuleError } = await supabase
    .from('money_account_payment_rules')
    .select('id')
    .eq('money_account_id', moneyAccountId)
    .eq('role', 'counter')
    .eq('is_active', true)
    .or('can_confirm_payment.eq.true,auto_confirms_report.eq.true')
    .limit(1)
    .maybeSingle();

  if (allowedRuleError) {
    throw new Error(allowedRuleError.message);
  }
  if (!allowedRule && !ctx.roles.includes('admin') && !ctx.roles.includes('master')) {
    throw new Error('Mostrador no tiene permiso para mover esta cuenta.');
  }

  const exchangeRate =
    currencyCode === 'VES'
      ? Number(input.exchangeRateVesPerUsd || 0)
      : null;
  if (currencyCode === 'VES' && (!Number.isFinite(exchangeRate ?? NaN) || (exchangeRate ?? 0) <= 0)) {
    throw new Error('Debes indicar una tasa valida para movimientos en Bs.');
  }

  const amountRounded = Number(amount.toFixed(2));
  const amountUsdEquivalent =
    currencyCode === 'USD'
      ? amountRounded
      : Number((amountRounded / (exchangeRate ?? 1)).toFixed(2));
  const movementType =
    direction === 'inflow'
      ? 'other_income'
      : outflowPurpose === 'change'
        ? 'change_given'
        : 'expense_payment';

  const { error: insertError } = await supabase.from('money_movements').insert({
    movement_date: movementDate,
    created_by_user_id: ctx.user.id,
    confirmed_at: new Date().toISOString(),
    confirmed_by_user_id: ctx.user.id,
    status: 'confirmed',
    approval_required: false,
    approval_required_reason: null,
    direction,
    movement_type: movementType,
    money_account_id: moneyAccountId,
    currency_code: currencyCode,
    amount: amountRounded,
    exchange_rate_ves_per_usd: currencyCode === 'VES' ? exchangeRate : null,
    amount_usd_equivalent: amountUsdEquivalent,
    reference_code: referenceCode,
    counterparty_name: counterpartyName,
    description: `Mostrador - ${description}`,
    notes,
    order_id: null,
    payment_report_id: null,
    movement_group_id: null,
  });

  if (insertError) {
    throw new Error(insertError.message);
  }

  revalidatePath('/app/counter');
  revalidatePath('/app/master/dashboard');

  return {
    ok: true,
    amount: amountRounded,
    currencyCode,
    amountUsdEquivalent,
  };
}

export async function searchCounterAgendaAction(input: { query: string }) {
  const ctx = await requireAuthContext();
  const allowed = ctx.roles.includes('admin') || ctx.roles.includes('master') || ctx.roles.includes('counter');
  if (!allowed) {
    throw new Error('Esta accion requiere permisos de mostrador, master o administrador.');
  }

  const query = String(input.query || '').trim();
  if (query.length < 2) return [];

  const supabase = createSupabaseServiceRoleServer();
  const safeTerm = query.replace(/[,%]/g, ' ').trim();
  const digitTerm = query.replace(/\D/g, '');
  const rows: CounterAgendaOrderRow[] = [];

  if (digitTerm && digitTerm.length <= 8) {
    rows.push(...(await searchAgendaOrdersBy(supabase, 'id', Number(digitTerm))));
  }

  rows.push(...(await searchAgendaOrdersBy(supabase, 'order_number', safeTerm)));

  const clientFilters = buildClientSearchOrFilters(query);
  if (clientFilters.length > 0) {
    const { data: clientsData, error: clientsError } = await supabase
      .from('clients')
      .select('id')
      .or(clientFilters.join(','))
      .limit(20);

    if (clientsError) throw new Error(clientsError.message);

    const clientIds = (clientsData ?? [])
      .map((client) => Number(client.id))
      .filter((id) => Number.isFinite(id) && id > 0);

    if (clientIds.length > 0) {
      rows.push(...(await searchAgendaOrdersBy(supabase, 'client_ids', clientIds)));
    }
  }

  const unique = new Map<number, CounterAgendaOrderRow>();
  for (const row of rows) {
    unique.set(row.id, row);
  }

  return Array.from(unique.values())
    .sort((a, b) => Number(b.id) - Number(a.id))
    .slice(0, 10)
    .map(mapAgendaOrder);
}
