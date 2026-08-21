'use server';

import { revalidatePath } from 'next/cache';
import { requireAuthContext } from '@/lib/auth';
import {
  readEventBudgetPayload,
  type EventBudgetComponent,
  type EventBudgetCurrency,
  type EventBudgetFulfillment,
  type EventCommissionMode,
  type EventPreparationMode,
} from '@/lib/events/event-budget';
import { createOrderAction, searchClientsAction } from '../master/dashboard/actions';

export async function searchEventClientsAction(input: {
  query: string;
  limit?: number;
  includeRecentWhenEmpty?: boolean;
}) {
  return searchClientsAction(input);
}

export type SaveEventBudgetInput = {
  draftId?: number | null;
  status: 'draft' | 'quoted';
  title: string;
  advisorUserId: string;
  selectedClientId: number | null;
  newClientName: string;
  newClientPhone: string;
  eventDate: string;
  eventTime: string;
  fulfillment: EventBudgetFulfillment;
  deliveryAddress: string;
  notes: string;
  negotiatedCurrency: EventBudgetCurrency;
  negotiatedAmount: number;
  commissionMode: EventCommissionMode;
  commissionValue: number | null;
  components: Array<{
    productId: number;
    qty: number;
    preparationMode: EventPreparationMode;
  }>;
};

type CatalogProductRow = {
  id: number | string;
  sku: string | null;
  name: string | null;
  is_active: boolean | null;
  source_price_currency: string | null;
  source_price_amount: number | string | null;
  base_price_usd: number | string | null;
  internal_rider_pay_usd: number | string | null;
  extra_fields: Record<string, unknown> | null;
};

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function clean(value: unknown, max = 5000) {
  return String(value ?? '').trim().slice(0, max);
}

function finite(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function requireAdmin(roles: readonly string[]) {
  if (!roles.includes('admin')) {
    throw new Error('Solo Administración puede crear o modificar presupuestos de eventos.');
  }
}

function normalizeDate(value: unknown) {
  const text = clean(value, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw new Error('Selecciona la fecha del evento.');
  }
  return text;
}

function normalizeTime(value: unknown) {
  const text = clean(value, 5);
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(text)) {
    throw new Error('Selecciona la hora del evento.');
  }
  return text;
}

function splitTime(value: string) {
  const [hourRaw, minuteRaw] = value.split(':');
  const hour = Number(hourRaw);
  const hour12 = hour % 12 || 12;
  return {
    deliveryHour12: String(hour12),
    deliveryMinute: minuteRaw,
    deliveryAmPm: hour >= 12 ? ('PM' as const) : ('AM' as const),
  };
}

function isInternalProduct(product: CatalogProductRow) {
  return object(product.extra_fields).catalog_access_scope === 'admin_internal';
}

function isDeliveryProduct(product: CatalogProductRow) {
  return finite(product.internal_rider_pay_usd) > 0 || clean(product.name).toLowerCase().includes('delivery');
}

function componentMode(value: unknown): EventPreparationMode {
  if (value === 'on_site' || value === 'not_applicable') return value;
  return 'kitchen';
}

function commissionMode(value: unknown): EventCommissionMode {
  if (value === 'fixed_item' || value === 'fixed_order' || value === 'none') return value;
  return 'default';
}

async function validateEventBudgetInput(input: SaveEventBudgetInput) {
  const ctx = await requireAuthContext();
  requireAdmin(ctx.roles);

  const title = clean(input.title, 140);
  const advisorUserId = clean(input.advisorUserId, 80);
  const eventDate = normalizeDate(input.eventDate);
  const eventTime = normalizeTime(input.eventTime);
  const negotiatedCurrency: EventBudgetCurrency = input.negotiatedCurrency === 'VES' ? 'VES' : 'USD';
  const negotiatedAmount = finite(input.negotiatedAmount);
  const mode = commissionMode(input.commissionMode);
  const commissionValue = mode === 'fixed_item' || mode === 'fixed_order'
    ? finite(input.commissionValue)
    : null;
  const fulfillment: EventBudgetFulfillment = input.fulfillment === 'delivery' ? 'delivery' : 'pickup';
  const deliveryAddress = clean(input.deliveryAddress, 1000);
  const selectedClientId = Math.trunc(finite(input.selectedClientId));
  const newClientName = clean(input.newClientName, 180);
  const newClientPhone = clean(input.newClientPhone, 60);

  if (!title) throw new Error('Indica un nombre reconocible para el evento.');
  if (!advisorUserId) throw new Error('Selecciona el asesor responsable.');
  if (negotiatedAmount < 0) throw new Error('El precio negociado no es válido.');
  if ((mode === 'fixed_item' || mode === 'fixed_order') && (commissionValue == null || commissionValue < 0 || commissionValue > 100)) {
    throw new Error('El porcentaje de comisión debe estar entre 0 y 100.');
  }
  if (fulfillment === 'delivery' && !deliveryAddress) {
    throw new Error('Indica la dirección del evento.');
  }
  if (selectedClientId <= 0 && (!newClientName || !newClientPhone)) {
    throw new Error('Selecciona un cliente o escribe su nombre y teléfono.');
  }

  const rawComponents = (Array.isArray(input.components) ? input.components : [])
    .map((component) => ({
      productId: Math.trunc(finite(component.productId)),
      qty: finite(component.qty),
      preparationMode: componentMode(component.preparationMode),
    }))
    .filter((component) => component.productId > 0 && component.qty > 0);
  const requestedComponents = Array.from(
    rawComponents.reduce((componentsByProduct, component) => {
      const existing = componentsByProduct.get(component.productId);
      componentsByProduct.set(component.productId, existing
        ? { ...component, qty: existing.qty + component.qty }
        : component);
      return componentsByProduct;
    }, new Map<number, (typeof rawComponents)[number]>()).values()
  );

  if (requestedComponents.length === 0) {
    throw new Error('Agrega al menos un producto o servicio al evento.');
  }

  const productIds = Array.from(new Set(requestedComponents.map((component) => component.productId)));
  const [productsResult, advisorsResult, rateResult, clientResult] = await Promise.all([
    ctx.supabase
      .from('products')
      .select('id, sku, name, is_active, source_price_currency, source_price_amount, base_price_usd, internal_rider_pay_usd, extra_fields')
      .in('id', productIds),
    ctx.supabase.rpc('get_advisor_profiles'),
    ctx.supabase
      .from('exchange_rates')
      .select('rate_bs_per_usd')
      .eq('is_active', true)
      .order('effective_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    selectedClientId > 0
      ? ctx.supabase
          .from('clients')
          .select('id, full_name, phone, client_type')
          .eq('id', selectedClientId)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);

  const error = productsResult.error ?? advisorsResult.error ?? rateResult.error ?? clientResult.error;
  if (error) throw new Error(error.message);

  const advisor = ((advisorsResult.data ?? []) as Array<{
    user_id: string | null;
    full_name: string | null;
    is_active: boolean | null;
  }>).find((row) => row.user_id === advisorUserId && row.is_active !== false);
  if (!advisor) throw new Error('El asesor seleccionado ya no está activo.');

  const productById = new Map(
    ((productsResult.data ?? []) as CatalogProductRow[]).map((product) => [Number(product.id), product] as const)
  );
  const components: EventBudgetComponent[] = requestedComponents.map((component) => {
    const product = productById.get(component.productId);
    if (!product || product.is_active === false || isInternalProduct(product)) {
      throw new Error(`El producto #${component.productId} ya no está disponible para presupuestos.`);
    }
    return {
      productId: component.productId,
      productName: clean(product.name) || `Producto #${component.productId}`,
      qty: component.qty,
      preparationMode: component.preparationMode,
    };
  });

  const activeRate = finite(rateResult.data?.rate_bs_per_usd);
  if (activeRate <= 0) throw new Error('No hay una tasa activa para guardar el presupuesto.');
  const totalUsd = negotiatedCurrency === 'VES'
    ? Number((negotiatedAmount / activeRate).toFixed(2))
    : Number(negotiatedAmount.toFixed(2));

  return {
    ctx,
    normalized: {
      title,
      advisorUserId,
      selectedClientId: selectedClientId > 0 ? selectedClientId : null,
      newClientName,
      newClientPhone,
      eventDate,
      eventTime,
      fulfillment,
      deliveryAddress,
      notes: clean(input.notes, 5000),
      negotiatedCurrency,
      negotiatedAmount,
      totalUsd,
      fxRate: activeRate,
      commissionMode: mode,
      commissionValue,
      components,
      products: productById,
      advisorName: clean(advisor.full_name) || 'Asesor',
      client: clientResult.data as { id: number | string; full_name: string | null; phone: string | null; client_type: string | null } | null,
    },
  };
}

function buildQuoteText(input: Awaited<ReturnType<typeof validateEventBudgetInput>>['normalized']) {
  const price = input.negotiatedCurrency === 'VES'
    ? `Bs ${input.negotiatedAmount.toLocaleString('es-VE', { maximumFractionDigits: 2 })}`
    : `$${input.negotiatedAmount.toFixed(2)}`;
  return [
    `*${input.title}*`,
    `Fecha: ${input.eventDate} · ${input.eventTime}`,
    '',
    ...input.components.map((component) => `- ${component.qty} ${component.productName}`),
    '',
    `*Total: ${price}*`,
  ].join('\n');
}

function eventPayload(input: Awaited<ReturnType<typeof validateEventBudgetInput>>['normalized']) {
  return {
    event_budget: {
      kind: 'admin_event_budget',
      schema_version: 1,
      title: input.title,
      event_date: input.eventDate,
      event_time: input.eventTime,
      fulfillment: input.fulfillment,
      delivery_address: input.deliveryAddress || null,
      notes: input.notes || null,
      negotiated_currency: input.negotiatedCurrency,
      negotiated_amount: input.negotiatedAmount,
      total_usd: input.totalUsd,
      commission_mode: input.commissionMode,
      commission_value: input.commissionValue,
      components: input.components.map((component) => ({
        product_id: component.productId,
        product_name: component.productName,
        qty: component.qty,
        preparation_mode: component.preparationMode,
      })),
    },
  };
}

export async function saveEventBudgetAction(input: SaveEventBudgetInput) {
  const { ctx, normalized } = await validateEventBudgetInput(input);
  const draftId = Math.trunc(finite(input.draftId));
  const status = input.status === 'quoted' ? 'quoted' : 'draft';
  const payload = eventPayload(normalized);
  const now = new Date().toISOString();
  const draftRow = {
    advisor_user_id: normalized.advisorUserId,
    status,
    title: normalized.title,
    client_id: normalized.selectedClientId,
    client_snapshot: normalized.client
      ? {
          id: Number(normalized.client.id),
          full_name: normalized.client.full_name,
          phone: normalized.client.phone,
          client_type: normalized.client.client_type,
        }
      : {},
    new_client_snapshot: normalized.selectedClientId
      ? {}
      : {
          full_name: normalized.newClientName,
          phone: normalized.newClientPhone,
          client_type: 'assigned',
        },
    payload,
    quote_text: buildQuoteText(normalized),
    total_usd: normalized.totalUsd,
    total_bs: normalized.negotiatedCurrency === 'VES'
      ? Number(normalized.negotiatedAmount.toFixed(2))
      : Number((normalized.totalUsd * normalized.fxRate).toFixed(2)),
    fx_rate: normalized.fxRate,
    quoted_at: status === 'quoted' ? now : null,
    updated_at: now,
  };

  if (draftId > 0) {
    const { data: existing, error: existingError } = await ctx.supabase
      .from('advisor_order_drafts')
      .select('id, status, payload')
      .eq('id', draftId)
      .maybeSingle();
    if (existingError || !existing) throw new Error(existingError?.message || 'El presupuesto ya no existe.');
    if (!readEventBudgetPayload(existing.payload)) throw new Error('Este borrador no es un presupuesto de evento.');
    if (existing.status === 'converted' || existing.status === 'archived') {
      throw new Error('Este presupuesto ya fue cerrado y conserva su fotografía histórica.');
    }
    const { error } = await ctx.supabase
      .from('advisor_order_drafts')
      .update(draftRow)
      .eq('id', draftId);
    if (error) throw new Error(error.message);
    revalidatePath('/app/events');
    revalidatePath('/app/advisor/drafts');
    return { id: draftId, status };
  }

  const { data, error } = await ctx.supabase
    .from('advisor_order_drafts')
    .insert(draftRow)
    .select('id')
    .single();
  if (error) throw new Error(error.message);
  revalidatePath('/app/events');
  revalidatePath('/app/advisor/drafts');
  return { id: Number(data.id), status };
}

export async function archiveEventBudgetAction(draftIdInput: number) {
  const ctx = await requireAuthContext();
  requireAdmin(ctx.roles);
  const draftId = Math.trunc(finite(draftIdInput));
  if (draftId <= 0) throw new Error('El presupuesto no es válido.');
  const { data, error } = await ctx.supabase
    .from('advisor_order_drafts')
    .update({ status: 'archived', archived_at: new Date().toISOString() })
    .eq('id', draftId)
    .in('status', ['draft', 'quoted'])
    .select('id, payload')
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data || !readEventBudgetPayload(data.payload)) throw new Error('El presupuesto ya no está disponible.');
  revalidatePath('/app/events');
  revalidatePath('/app/advisor/drafts');
  return { ok: true as const };
}

export async function convertEventBudgetToOrderAction(draftIdInput: number) {
  const ctx = await requireAuthContext();
  requireAdmin(ctx.roles);
  const draftId = Math.trunc(finite(draftIdInput));
  if (draftId <= 0) throw new Error('El presupuesto no es válido.');

  const { data: draft, error: draftError } = await ctx.supabase
    .from('advisor_order_drafts')
    .select('id, advisor_user_id, status, client_id, client_snapshot, new_client_snapshot, payload, total_usd, fx_rate, converted_order_id')
    .eq('id', draftId)
    .maybeSingle();
  if (draftError || !draft) throw new Error(draftError?.message || 'El presupuesto ya no existe.');
  if (draft.converted_order_id) return { id: Number(draft.converted_order_id), reused: true as const };
  if (draft.status === 'archived') throw new Error('El presupuesto está archivado.');

  const budget = readEventBudgetPayload(draft.payload);
  if (!budget) throw new Error('Este borrador no es un presupuesto de evento.');
  if (budget.components.length === 0) throw new Error('El evento no tiene componentes para convertir.');

  const productIds = Array.from(new Set(budget.components.map((component) => component.productId)));
  const [eventProductResult, productsResult] = await Promise.all([
    ctx.supabase
      .from('products')
      .select('id, sku, name')
      .eq('sku', 'PACK_EVENTO')
      .maybeSingle(),
    ctx.supabase
      .from('products')
      .select('id, sku, name, is_active, source_price_currency, source_price_amount, base_price_usd, internal_rider_pay_usd, extra_fields')
      .in('id', productIds),
  ]);
  const queryError = eventProductResult.error ?? productsResult.error;
  if (queryError) throw new Error(queryError.message);
  if (!eventProductResult.data) throw new Error('Falta el identificador interno del evento.');

  const productById = new Map(
    ((productsResult.data ?? []) as CatalogProductRow[]).map((product) => [Number(product.id), product] as const)
  );
  const deliveryComponents = budget.components.filter((component) => {
    const product = productById.get(component.productId);
    return product ? isDeliveryProduct(product) : false;
  });
  const composedComponents = budget.components.filter(
    (component) => !deliveryComponents.some((delivery) => delivery.productId === component.productId)
  );
  if (composedComponents.length === 0) {
    throw new Error('Agrega al menos un producto real al evento, además del servicio de entrega.');
  }
  if (budget.fulfillment === 'delivery' && deliveryComponents.length === 0) {
    throw new Error('Para convertir un evento con entrega, agrega un producto de delivery al presupuesto.');
  }

  const parentProductId = Number(eventProductResult.data.id);
  const componentRows = composedComponents.map((component, index) => ({
    parent_product_id: parentProductId,
    component_product_id: component.productId,
    component_mode: 'selectable',
    quantity: 1,
    counts_toward_detail_limit: true,
    is_required: false,
    sort_order: 1000 + index,
    notes: 'Componente habilitado por presupuesto administrativo de evento.',
  }));
  const { error: componentError } = await ctx.supabase
    .from('product_components')
    .upsert(componentRows, { onConflict: 'parent_product_id,component_product_id,component_mode' });
  if (componentError) throw new Error(componentError.message);

  const detailLines = composedComponents.flatMap((component) => [
    `${component.qty} ${component.productName}`,
    `@sel|${component.productId}|${component.qty}`,
    `@prep|${component.productId}|${component.preparationMode}`,
  ]);
  detailLines.push(`@event|draft|${draftId}`);

  const clientSnapshot = object(draft.client_snapshot);
  const newClientSnapshot = object(draft.new_client_snapshot);
  const selectedClientId = Math.trunc(finite(draft.client_id));
  const fxRate = finite(draft.fx_rate);
  if (fxRate <= 0) throw new Error('El presupuesto no conserva una tasa válida.');
  const totalUsd = finite(draft.total_usd, budget.totalUsd);
  const time = splitTime(budget.eventTime);
  const mainItem = {
    productId: parentProductId,
    skuSnapshot: eventProductResult.data.sku,
    productNameSnapshot: budget.title,
    qty: 1,
    sourcePriceCurrency: budget.negotiatedCurrency,
    sourcePriceAmount: budget.negotiatedAmount,
    unitPriceUsdSnapshot: totalUsd,
    lineTotalUsd: totalUsd,
    adminPriceOverrideUsd: totalUsd,
    adminPriceOverrideCurrency: budget.negotiatedCurrency,
    adminPriceOverrideReason: `Precio negociado del evento: ${budget.title}`,
    editableDetailLines: detailLines,
  } as const;
  const deliveryItems = deliveryComponents.map((component) => {
    const product = productById.get(component.productId)!;
    return {
      productId: component.productId,
      skuSnapshot: product.sku,
      productNameSnapshot: component.productName,
      qty: component.qty,
      sourcePriceCurrency: 'USD' as const,
      sourcePriceAmount: 0,
      unitPriceUsdSnapshot: 0,
      lineTotalUsd: 0,
      adminPriceOverrideUsd: 0,
      adminPriceOverrideCurrency: 'USD' as const,
      adminPriceOverrideReason: 'Incluido dentro del precio negociado del evento.',
      editableDetailLines: [],
    };
  });

  const created = await createOrderAction({
    source: 'advisor',
    attributedAdvisorUserId: String(draft.advisor_user_id),
    fulfillment: budget.fulfillment,
    selectedClientId: selectedClientId > 0 ? selectedClientId : null,
    newClientName: clean(newClientSnapshot.full_name ?? newClientSnapshot.fullName ?? clientSnapshot.full_name),
    newClientPhone: clean(newClientSnapshot.phone ?? clientSnapshot.phone),
    newClientType: 'assigned',
    deliveryDate: budget.eventDate,
    ...time,
    isAsap: false,
    receiverName: clean(clientSnapshot.full_name ?? newClientSnapshot.full_name),
    receiverPhone: clean(clientSnapshot.phone ?? newClientSnapshot.phone),
    deliveryAddress: budget.deliveryAddress,
    deliveryGpsUrl: '',
    note: budget.notes,
    discountEnabled: false,
    discountPct: '0',
    invoiceTaxPct: '16',
    fxRate: String(fxRate),
    paymentMethod: '',
    paymentCurrency: budget.negotiatedCurrency,
    paymentRequiresChange: false,
    paymentChangeFor: '',
    paymentChangeCurrency: budget.negotiatedCurrency,
    paymentNote: '',
    useClientFund: false,
    clientFundAmountUsd: '',
    hasDeliveryNote: false,
    hasInvoice: false,
    invoiceDataNote: '',
    invoiceCompanyName: '',
    invoiceTaxId: '',
    invoiceAddress: '',
    invoicePhone: '',
    deliveryNoteName: '',
    deliveryNoteDocumentId: '',
    deliveryNoteAddress: '',
    deliveryNotePhone: '',
    preserveClientCommercialProfile: true,
    items: [mainItem, ...deliveryItems],
  });

  const orderId = Number(created.id);
  const { data: orderItem, error: orderItemError } = await ctx.supabase
    .from('order_items')
    .select('id')
    .eq('order_id', orderId)
    .eq('product_id', parentProductId)
    .maybeSingle();
  if (orderItemError || !orderItem) throw new Error(orderItemError?.message || 'No se pudo congelar la composición del evento.');

  const commercialPayload = {
    kind: 'event_commercial_terms',
    schema_version: 1,
    draft_id: draftId,
    negotiated_currency: budget.negotiatedCurrency,
    negotiated_amount: budget.negotiatedAmount,
    total_usd: totalUsd,
    fx_rate: fxRate,
    commission_mode: budget.commissionMode,
    commission_value: budget.commissionValue,
    components: budget.components.map((component) => ({
      product_id: component.productId,
      product_name: component.productName,
      qty: component.qty,
      preparation_mode: component.preparationMode,
    })),
  };
  const { error: termsError } = await ctx.supabase
    .from('order_admin_adjustments')
    .insert({
      order_id: orderId,
      order_item_id: Number(orderItem.id),
      adjustment_type: 'other',
      reason: 'Condiciones comerciales del evento',
      notes: 'Fotografía canónica del presupuesto aceptado.',
      payload: commercialPayload,
      created_by_user_id: ctx.user.id,
    });
  if (termsError) throw new Error(termsError.message);

  const { data: order, error: orderError } = await ctx.supabase
    .from('orders')
    .select('extra_fields')
    .eq('id', orderId)
    .single();
  if (orderError) throw new Error(orderError.message);
  const { error: orderUpdateError } = await ctx.supabase
    .from('orders')
    .update({
      extra_fields: {
        ...object(order.extra_fields),
        event_budget: {
          draft_id: draftId,
          title: budget.title,
          commission_mode: budget.commissionMode,
          commission_value: budget.commissionValue,
        },
      },
      last_modified_at: new Date().toISOString(),
      last_modified_by: ctx.user.id,
    })
    .eq('id', orderId);
  if (orderUpdateError) throw new Error(orderUpdateError.message);

  const { error: draftUpdateError } = await ctx.supabase
    .from('advisor_order_drafts')
    .update({
      status: 'converted',
      converted_order_id: orderId,
      converted_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', draftId)
    .in('status', ['draft', 'quoted']);
  if (draftUpdateError) throw new Error(draftUpdateError.message);

  revalidatePath('/app/events');
  revalidatePath('/app/advisor/drafts');
  revalidatePath('/app/advisor/orders');
  revalidatePath('/app/master/ops');
  return { id: orderId, orderNumber: created.orderNumber, reused: false as const };
}
