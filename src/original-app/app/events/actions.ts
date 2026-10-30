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
import { searchClientsAction } from '../master/dashboard/actions';

export async function searchEventClientsAction(input: {
  query: string;
  limit?: number;
  includeRecentWhenEmpty?: boolean;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

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

function isInternalProduct(product: CatalogProductRow) {
  return object(product.extra_fields).catalog_access_scope === 'admin_internal';
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

export async function saveEventBudgetAction(input: SaveEventBudgetInput) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function archiveEventBudgetAction(draftIdInput: number) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function convertEventBudgetToOrderAction(draftIdInput: number) { throw new Error('All business actions are disabled in the CPU benchmark.'); }
