'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { createSupabaseServer } from '@/lib/supabase/server';
import { requireMasterOrAdminContext } from '@/lib/auth';

async function requireMasterOrAdmin() {
  return requireMasterOrAdminContext();
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}

function valuesEquivalent(field: string, beforeValue: unknown, afterValue: unknown): boolean {
  if (field === 'total_usd' || field === 'total_bs_snapshot') {
    const beforeNumber = Number(beforeValue ?? 0);
    const afterNumber = Number(afterValue ?? 0);

    if (Number.isFinite(beforeNumber) && Number.isFinite(afterNumber)) {
      return Math.abs(beforeNumber - afterNumber) < 0.005;
    }
  }

  return stableStringify(beforeValue) === stableStringify(afterValue);
}

function toSafeNumber(value: unknown, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

async function syncInventoryItemFromCatalogProduct(
  supabase: Awaited<ReturnType<typeof createSupabaseServer>>,
  input: {
    currentName?: string;
    nextName: string;
    isActive: boolean;
    inventoryEnabled: boolean;
    isInventoryItem: boolean;
    inventoryDeductionMode: 'self' | 'composition';
    inventoryKind: 'raw_material' | 'prepared_base' | 'finished_good';
    inventoryUnitName: string;
    packagingName: string | null;
    packagingSize: number | null;
    currentStockUnits: number | null;
    lowStockThreshold: number | null;
  }
) {
  if (!input.inventoryEnabled || !input.isInventoryItem || input.inventoryDeductionMode !== 'self') {
    return;
  }

  const candidateNames = Array.from(
    new Set([String(input.currentName || '').trim(), String(input.nextName || '').trim()].filter(Boolean))
  );

  const { data: existingItems, error: existingItemsError } = await supabase
    .from('inventory_items')
    .select('id, name, current_stock_units')
    .in('name', candidateNames);

  if (existingItemsError) {
    throw new Error(existingItemsError.message);
  }

  const matchedItem =
    (existingItems ?? []).find((item) => String(item.name || '').trim() === String(input.currentName || '').trim()) ??
    (existingItems ?? []).find((item) => String(item.name || '').trim() === String(input.nextName || '').trim()) ??
    null;

  const payload = {
    name: input.nextName,
    inventory_kind:
      input.inventoryKind === 'finished_good' ? 'finished_stock' : input.inventoryKind,
    unit_name: input.inventoryUnitName.trim() || 'pieza',
    packaging_name: input.packagingName?.trim() ? input.packagingName.trim() : null,
    packaging_size: input.packagingSize == null ? null : Math.max(0, toSafeNumber(input.packagingSize, 0)),
    current_stock_units:
      matchedItem != null
        ? toSafeNumber(matchedItem.current_stock_units, 0)
        : input.currentStockUnits == null
          ? 0
          : Math.max(0, toSafeNumber(input.currentStockUnits, 0)),
    low_stock_threshold:
      input.lowStockThreshold == null ? null : Math.max(0, toSafeNumber(input.lowStockThreshold, 0)),
    is_active: !!input.isActive,
  };

  if (matchedItem) {
    const { error } = await supabase
      .from('inventory_items')
      .update(payload)
      .eq('id', Number(matchedItem.id));

    if (error) throw new Error(error.message);
    return;
  }

  const { error } = await supabase.from('inventory_items').insert(payload);
  if (error) throw new Error(error.message);
}

export async function createPaymentReportAction(input: {
  orderId: number;
  reportedMoneyAccountId: number;
  reportedCurrency: string;
  reportedAmount: number;
  reportedExchangeRateVesPerUsd: number | null;
  referenceCode: string | null;
  payerName: string | null;
  notes: string | null;
}) {
  const supabase = await createSupabaseServer();

  const { error } = await supabase.rpc('create_payment_report', {
    p_order_id: input.orderId,
    p_reported_money_account_id: input.reportedMoneyAccountId,
    p_reported_currency: input.reportedCurrency,
    p_reported_amount: input.reportedAmount,
    p_reported_exchange_rate_ves_per_usd: input.reportedExchangeRateVesPerUsd,
    p_reference_code: input.referenceCode,
    p_payer_name: input.payerName,
    p_notes: input.notes,
  });

  if (error) throw new Error(error.message);
  revalidatePath('/app/master/dashboard');
}

export async function confirmPaymentReportAction(input: {
  reportId: number;
  confirmedMoneyAccountId: number;
  confirmedCurrency: string;
  confirmedAmount: number;
  movementDate: string;
  confirmedExchangeRateVesPerUsd: number | null;
  reviewNotes: string;
  referenceCode: string | null;
  counterpartyName: string | null;
  description: string | null;
}) {
  const supabase = await createSupabaseServer();

  const { error } = await supabase.rpc('confirm_payment_report', {
    p_report_id: input.reportId,
    p_confirmed_money_account_id: input.confirmedMoneyAccountId,
    p_confirmed_currency: input.confirmedCurrency,
    p_confirmed_amount: input.confirmedAmount,
    p_movement_date: input.movementDate,
    p_confirmed_exchange_rate_ves_per_usd: input.confirmedExchangeRateVesPerUsd,
    p_review_notes: input.reviewNotes,
    p_reference_code: input.referenceCode,
    p_counterparty_name: input.counterpartyName,
    p_description: input.description,
  });

  if (error) throw new Error(error.message);
  revalidatePath('/app/master/dashboard');
}

export async function rejectPaymentReportAction(input: {
  reportId: number;
  reviewNotes: string;
}) {
  const supabase = await createSupabaseServer();

  const { error } = await supabase.rpc('reject_payment_report', {
    p_report_id: input.reportId,
    p_review_notes: input.reviewNotes,
  });

  if (error) throw new Error(error.message);
  revalidatePath('/app/master/dashboard');
}

export async function approveOrderAction(input: {
  orderId: number;
}) {
  const { supabase } = await requireMasterOrAdmin();

  const { error } = await supabase.rpc('approve_order', {
    p_order_id: input.orderId,
  });

  if (error) throw new Error(error.message);
  revalidatePath('/app/master/dashboard');
}

export async function reapproveQueuedOrderAction(input: {
  orderId: number;
  notes: string;
}) {
  const { supabase } = await requireMasterOrAdmin();

  const { error } = await supabase.rpc('reapprove_queued_order', {
    p_order_id: input.orderId,
    p_notes: input.notes,
  });

  if (error) throw new Error(error.message);
  revalidatePath('/app/master/dashboard');
}

export async function sendToKitchenAction(input: {
  orderId: number;
}) {
  const { supabase } = await requireMasterOrAdmin();

  const { error } = await supabase.rpc('send_to_kitchen', {
    p_order_id: input.orderId,
  });

  if (error) throw new Error(error.message);
  revalidatePath('/app/master/dashboard');
}

export async function returnToCreatedAction(input: {
  orderId: number;
  reason: string;
}) {
  const { supabase, user } = await requireMasterOrAdmin();

  const reason = input.reason?.trim();
  if (!reason) {
    throw new Error('Debes indicar un motivo.');
  }

  const { data: currentOrder, error: currentOrderError } = await supabase
    .from('orders')
    .select('id, status, notes')
    .eq('id', input.orderId)
    .single();

  if (currentOrderError || !currentOrder) {
    throw new Error(currentOrderError?.message || 'No se pudo cargar la orden.');
  }

  if (currentOrder.status !== 'queued') {
    throw new Error('Solo se puede devolver una orden que estÃ© en cola.');
  }

  const nextNotes = [
    currentOrder.notes?.trim() || '',
    `DEVUELTA A CREATED: ${reason}`,
  ]
    .filter(Boolean)
    .join(' | ');

  const { error: updateError } = await supabase
    .from('orders')
    .update({
      status: 'created',
      queued_needs_reapproval: false,
      queued_last_modified_at: null,
      queued_last_modified_by: null,
      review_notes: reason,
      notes: nextNotes,
      last_modified_at: new Date().toISOString(),
      last_modified_by: user.id,
    })
    .eq('id', input.orderId);

  if (updateError) {
    throw new Error(updateError.message);
  }

  revalidatePath('/app/master/dashboard');
}

export async function cancelOrderAction(input: {
  orderId: number;
  reason: string;
}) {
  const { supabase, user } = await requireMasterOrAdmin();

  const orderId = Number(input.orderId);
  const reason = String(input.reason || '').trim();

  if (!Number.isFinite(orderId) || orderId <= 0) {
    throw new Error('Orden invÃ¡lida.');
  }

  if (!reason) {
    throw new Error('Debes indicar un motivo de cancelaciÃ³n.');
  }

  const { data: currentOrder, error: currentOrderError } = await supabase
    .from('orders')
    .select('id, status, notes')
    .eq('id', orderId)
    .single();

  if (currentOrderError || !currentOrder) {
    throw new Error(currentOrderError?.message || 'No se pudo cargar la orden.');
  }

  if (currentOrder.status === 'cancelled') {
    throw new Error('La orden ya estÃ¡ cancelada.');
  }

  const nextNotes = [
    currentOrder.notes?.trim() || '',
    `CANCELADA: ${reason}`,
  ]
    .filter(Boolean)
    .join(' | ');

  const { error: updateError } = await supabase
    .from('orders')
    .update({
      status: 'cancelled',
      review_notes: reason,
      notes: nextNotes,
      queued_needs_reapproval: false,
      queued_last_modified_at: null,
      queued_last_modified_by: null,
      last_modified_at: new Date().toISOString(),
      last_modified_by: user.id,
    })
    .eq('id', orderId);

  if (updateError) {
    throw new Error(updateError.message);
  }

  revalidatePath('/app/master/dashboard');
}

export async function assignInternalDriverAction(input: {
  orderId: number;
  driverUserId: string;
  costUsd?: number | null;
}) {
  const { supabase } = await requireMasterOrAdmin();

  const { error } = await supabase.rpc('assign_internal_driver', {
    p_order_id: input.orderId,
    p_driver_user_id: input.driverUserId,
  });

  if (error) throw new Error(error.message);

  const { data: orderRow, error: orderFetchError } = await supabase
    .from('orders')
    .select('extra_fields')
    .eq('id', input.orderId)
    .single();

  if (orderFetchError) throw new Error(orderFetchError.message);

  const extraFields =
    orderRow?.extra_fields && typeof orderRow.extra_fields === 'object' && !Array.isArray(orderRow.extra_fields)
      ? (orderRow.extra_fields as Record<string, unknown>)
      : {};
  const currentDelivery =
    extraFields.delivery && typeof extraFields.delivery === 'object' && !Array.isArray(extraFields.delivery)
      ? (extraFields.delivery as Record<string, unknown>)
      : {};

  const { error: snapshotError } = await supabase
    .from('orders')
    .update({
      extra_fields: {
        ...extraFields,
        delivery: {
          ...currentDelivery,
          cost_usd: input.costUsd != null ? Math.max(0, Number(input.costUsd || 0)) : currentDelivery.cost_usd ?? null,
          cost_source: 'internal_product',
        },
      },
    })
    .eq('id', input.orderId);

  if (snapshotError) throw new Error(snapshotError.message);
  revalidatePath('/app/master/dashboard');
}

export async function assignExternalPartnerAction(input: {
  orderId: number;
  partnerId: number;
  reference: string | null;
  distanceKm?: number | null;
  costUsd?: number | null;
}) {
  const { supabase } = await requireMasterOrAdmin();

  const { error } = await supabase.rpc('assign_external_partner', {
    p_order_id: input.orderId,
    p_partner_id: input.partnerId,
    p_reference: input.reference,
  });

  if (error) throw new Error(error.message);
  const { data: orderRow, error: orderFetchError } = await supabase
    .from('orders')
    .select('extra_fields')
    .eq('id', input.orderId)
    .single();

  if (orderFetchError) throw new Error(orderFetchError.message);

  const extraFields =
    orderRow?.extra_fields && typeof orderRow.extra_fields === 'object' && !Array.isArray(orderRow.extra_fields)
      ? (orderRow.extra_fields as Record<string, unknown>)
      : {};
  const currentDelivery =
    extraFields.delivery && typeof extraFields.delivery === 'object' && !Array.isArray(extraFields.delivery)
      ? (extraFields.delivery as Record<string, unknown>)
      : {};

  const { error: snapshotError } = await supabase
    .from('orders')
    .update({
      extra_fields: {
        ...extraFields,
        delivery: {
          ...currentDelivery,
          distance_km:
            input.distanceKm != null ? Math.max(0, Number(input.distanceKm || 0)) : currentDelivery.distance_km ?? null,
          cost_usd: input.costUsd != null ? Math.max(0, Number(input.costUsd || 0)) : currentDelivery.cost_usd ?? null,
          cost_source: 'external_partner_manual',
        },
      },
    })
    .eq('id', input.orderId);

  if (snapshotError) throw new Error(snapshotError.message);
  revalidatePath('/app/master/dashboard');
}

export async function reviewOrderChangesAction(input: {
  orderId: number;
  approved: boolean;
  notes: string;
}) {
  const { supabase } = await requireMasterOrAdmin();

  const { error } = await supabase.rpc('review_order_changes', {
    p_order_id: input.orderId,
    p_approved: input.approved,
    p_notes: input.notes,
  });

  if (error) throw new Error(error.message);
  revalidatePath('/app/master/dashboard');
}

export async function kitchenTakeAction(input: {
  orderId: number;
  etaMinutes: number;
}) {
  const { supabase } = await requireMasterOrAdmin();

  const { error } = await supabase.rpc('kitchen_take', {
    p_order_id: input.orderId,
    p_eta_minutes: input.etaMinutes,
  });

  if (error) throw new Error(error.message);
  revalidatePath('/app/master/dashboard');
}

export async function markReadyAction(input: {
  orderId: number;
}) {
  const { supabase } = await requireMasterOrAdmin();

  const { error } = await supabase.rpc('mark_ready', {
    p_order_id: input.orderId,
  });

  if (error) throw new Error(error.message);
  revalidatePath('/app/master/dashboard');
}

export async function outForDeliveryAction(input: {
  orderId: number;
  etaMinutes?: number | null;
}) {
  const { supabase } = await requireMasterOrAdmin();
  const normalizedEta =
    input.etaMinutes != null && Number.isFinite(input.etaMinutes) && input.etaMinutes > 0
      ? Math.round(input.etaMinutes)
      : null;

  let existingExtraFields: Record<string, unknown> = {};

  if (normalizedEta != null) {
    const { data: orderRow, error: orderError } = await supabase
      .from('orders')
      .select('extra_fields')
      .eq('id', input.orderId)
      .single();

    if (orderError) throw new Error(orderError.message);

    if (
      orderRow?.extra_fields &&
      typeof orderRow.extra_fields === 'object' &&
      !Array.isArray(orderRow.extra_fields)
    ) {
      existingExtraFields = orderRow.extra_fields as Record<string, unknown>;
    }
  }

  const { error } = await supabase.rpc('out_for_delivery', {
    p_order_id: input.orderId,
  });

  if (error) throw new Error(error.message);

  if (normalizedEta != null) {
    const currentDelivery =
      existingExtraFields.delivery &&
      typeof existingExtraFields.delivery === 'object' &&
      !Array.isArray(existingExtraFields.delivery)
        ? (existingExtraFields.delivery as Record<string, unknown>)
        : {};

    const nextExtraFields = {
      ...existingExtraFields,
      delivery: {
        ...currentDelivery,
        eta_minutes: normalizedEta,
        eta_recorded_at: new Date().toISOString(),
      },
    };

    const { error: updateError } = await supabase
      .from('orders')
      .update({
        eta_minutes: normalizedEta,
        extra_fields: nextExtraFields,
      })
      .eq('id', input.orderId);

    if (updateError) throw new Error(updateError.message);
  }

  revalidatePath('/app/master/dashboard');
}

export async function markDeliveredAction(input: {
  orderId: number;
}) {
  const { supabase, user } = await requireMasterOrAdmin();

  const { error } = await supabase.rpc('mark_delivered', {
    p_order_id: input.orderId,
  });

  if (error) throw new Error(error.message);
  await applyDeliveredOrderInventoryDeductions(supabase, user.id, input.orderId);
  revalidatePath('/app/master/dashboard');
}

export async function clearDeliveryAssignmentAction(input: {
  orderId: number;
  notes: string;
}) {
  const supabase = await createSupabaseServer();

  const { error } = await supabase.rpc('clear_delivery_assignment', {
    p_order_id: input.orderId,
    p_notes: input.notes,
  });

  if (error) throw new Error(error.message);
  revalidatePath('/app/master/dashboard');
}

export async function returnFromKitchenToQueueAction(input: {
  orderId: number;
  reason: string;
}) {
  const { supabase, user } = await requireMasterOrAdmin();

  const reason = input.reason?.trim();
  if (!reason) {
    throw new Error('Debes indicar un motivo.');
  }

  const { data: currentOrder, error: currentOrderError } = await supabase
    .from('orders')
    .select('id, status, notes')
    .eq('id', input.orderId)
    .single();

  if (currentOrderError || !currentOrder) {
    throw new Error(currentOrderError?.message || 'No se pudo cargar la orden.');
  }

  if (!['confirmed', 'in_kitchen', 'ready'].includes(currentOrder.status)) {
    throw new Error('Solo se puede devolver a cola una orden que estÃ© en cocina/preparaciÃ³n/lista.');
  }

  const nextNotes = [
    currentOrder.notes?.trim() || '',
    `REGRESADA A COLA DESDE COCINA: ${reason}`,
  ]
    .filter(Boolean)
    .join(' | ');

  const { error: updateError } = await supabase
    .from('orders')
    .update({
      status: 'queued',
      notes: nextNotes,
      review_notes: reason,
      sent_to_kitchen_at: null,
      sent_to_kitchen_by: null,
      eta_minutes: null,
      kitchen_started_at: null,
      kitchen_operator_id: null,
      ready_at: null,
      internal_driver_user_id: null,
      external_partner_id: null,
      external_driver_name: null,
      external_driver_phone: null,
      external_reference: null,
      last_modified_at: new Date().toISOString(),
      last_modified_by: user.id,
    })
    .eq('id', input.orderId);

  if (updateError) {
    throw new Error(updateError.message);
  }

  revalidatePath('/app/master/dashboard');
}

export async function updateCatalogItemAction(input: {
  productId: number;
  sourcePriceAmount: number;
  sourcePriceCurrency: 'VES' | 'USD';
  isActive: boolean;
  unitsPerService: number;
  isDetailEditable: boolean;
  detailUnitsLimit: number;
  isInventoryItem: boolean;
  isTemporary: boolean;
  isComboComponentSelectable: boolean;
  commissionMode: 'default' | 'fixed_item' | 'fixed_order';
  commissionValue: number | null;
  commissionNotes: string | null;
  internalRiderPayUsd: number | null;
  inventoryEnabled: boolean;
  inventoryKind: 'raw_material' | 'prepared_base' | 'finished_good';
  inventoryDeductionMode: 'self' | 'composition';
  inventoryUnitName: string;
  packagingName: string | null;
  packagingSize: number | null;
  currentStockUnits: number | null;
  lowStockThreshold: number | null;
  inventoryLinks?: Array<{
    inventoryItemId: number;
    quantityUnits: number;
    notes: string | null;
    sortOrder: number;
  }>;
  components: Array<{
    componentProductId: number;
    componentMode: 'fixed' | 'selectable';
    quantity: number;
    countsTowardDetailLimit: boolean;
    isRequired: boolean;
    sortOrder: number;
    notes: string | null;
  }>;
}) {
  const { supabase } = await requireMasterOrAdmin();

  if (!Number.isFinite(input.productId) || input.productId <= 0) {
    throw new Error('Producto invÃ¡lido.');
  }

  const sourcePriceAmount = toSafeNumber(input.sourcePriceAmount, 0);
  const unitsPerService = Math.max(0, toSafeNumber(input.unitsPerService, 0));
  const detailUnitsLimit = Math.max(0, toSafeNumber(input.detailUnitsLimit, 0));
  const internalRiderPayUsd =
    input.internalRiderPayUsd == null ? null : Math.max(0, toSafeNumber(input.internalRiderPayUsd, 0));
  const packagingSize =
    input.packagingSize == null ? null : Math.max(0, toSafeNumber(input.packagingSize, 0));
  const currentStockUnits =
    input.currentStockUnits == null ? null : Math.max(0, toSafeNumber(input.currentStockUnits, 0));
  const lowStockThreshold =
    input.lowStockThreshold == null ? null : Math.max(0, toSafeNumber(input.lowStockThreshold, 0));

  if (!['default', 'fixed_item', 'fixed_order'].includes(input.commissionMode)) {
    throw new Error('Modo de comisiÃ³n invÃ¡lido.');
  }
  if (!['raw_material', 'prepared_base', 'finished_good'].includes(input.inventoryKind)) {
    throw new Error('Tipo de inventario inválido.');
  }
  if (!['self', 'composition'].includes(input.inventoryDeductionMode)) {
    throw new Error('Modo de descuento de inventario inválido.');
  }
  if (!['VES', 'USD'].includes(input.sourcePriceCurrency)) {
    throw new Error('Moneda invÃ¡lida.');
  }

  const normalizedInventoryLinks = (input.inventoryLinks ?? [])
    .map((row, index) => ({
      inventoryItemId: toSafeNumber(row.inventoryItemId, 0),
      quantityUnits: Math.max(0, toSafeNumber(row.quantityUnits, 0)),
      notes: row.notes?.trim() ? row.notes.trim() : null,
      sortOrder: toSafeNumber(row.sortOrder, index + 1) || index + 1,
    }))
    .filter((row) => row.inventoryItemId > 0 && row.quantityUnits > 0);

  if (input.inventoryEnabled && input.inventoryDeductionMode === 'composition' && normalizedInventoryLinks.length === 0) {
    throw new Error('Define al menos un item interno para el descuento por composiciÃ³n.');
  }

  const { data: currentProduct, error: productError } = await supabase
    .from('products')
    .select('id, sku, name')
    .eq('id', input.productId)
    .single();

  if (productError || !currentProduct) {
    throw new Error(productError?.message || 'No se pudo cargar el producto.');
  }

  const { data: exchangeRateData, error: exchangeRateError } = await supabase
    .from('exchange_rates')
    .select('id, rate_bs_per_usd')
    .eq('is_active', true)
    .order('effective_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (exchangeRateError) {
    throw new Error(exchangeRateError.message);
  }

  const rateBsPerUsd = toSafeNumber(exchangeRateData?.rate_bs_per_usd, 0);

  if (rateBsPerUsd <= 0) {
    throw new Error('No hay una tasa activa vÃ¡lida.');
  }

  let basePriceUsd = 0;
  let basePriceBs = 0;

  if (input.sourcePriceCurrency === 'USD') {
    basePriceUsd = sourcePriceAmount;
    basePriceBs = sourcePriceAmount * rateBsPerUsd;
  } else {
    basePriceBs = sourcePriceAmount;
    basePriceUsd = sourcePriceAmount / rateBsPerUsd;
  }

  const normalizedComponents = (input.components ?? [])
    .map((row, index) => ({
      componentProductId: toSafeNumber(row.componentProductId, 0),
      componentMode: row.componentMode === 'selectable' ? 'selectable' : 'fixed',
      quantity: Math.max(0, toSafeNumber(row.quantity, 0)),
      countsTowardDetailLimit: !!row.countsTowardDetailLimit,
      isRequired: !!row.isRequired,
      sortOrder: toSafeNumber(row.sortOrder, index + 1),
      notes: row.notes?.trim() ? row.notes.trim() : null,
    }))
    .filter((row) => row.componentProductId > 0 && row.quantity > 0);

  const componentIds = Array.from(
    new Set(normalizedComponents.map((row) => row.componentProductId))
  );

  if (componentIds.length > 0) {
    const { data: componentProducts, error: componentCheckError } = await supabase
      .from('products')
      .select('id')
      .in('id', componentIds);

    if (componentCheckError) {
      throw new Error(componentCheckError.message);
    }

    const foundIds = new Set((componentProducts ?? []).map((row) => Number(row.id)));
    const missing = componentIds.filter((id) => !foundIds.has(id));
    if (missing.length > 0) {
      throw new Error(`Hay componentes invÃ¡lidos: ${missing.join(', ')}`);
    }
  }

  const { data: updatedProduct, error: updateProductError } = await supabase
    .from('products')
    .update({
      source_price_amount: sourcePriceAmount,
      source_price_currency: input.sourcePriceCurrency,
      base_price_usd: basePriceUsd,
      base_price_bs: basePriceBs,
      is_active: input.isActive,
      units_per_service: unitsPerService,
      is_detail_editable: input.isDetailEditable,
      detail_units_limit: detailUnitsLimit,
      is_inventory_item: input.isInventoryItem,
      is_temporary: input.isTemporary,
      is_combo_component_selectable: input.isComboComponentSelectable,
      commission_mode: input.commissionMode,
      commission_value: input.commissionMode === 'default' ? null : input.commissionValue,
      commission_notes: input.commissionNotes,
      internal_rider_pay_usd: internalRiderPayUsd,
      inventory_enabled: input.inventoryEnabled,
      inventory_kind: input.inventoryKind,
      inventory_deduction_mode: input.inventoryDeductionMode,
      inventory_unit_name: String(input.inventoryUnitName || 'pieza').trim() || 'pieza',
      packaging_name: input.packagingName?.trim() ? input.packagingName.trim() : null,
      packaging_size: packagingSize,
      current_stock_units: currentStockUnits ?? 0,
      low_stock_threshold: lowStockThreshold,
    })
    .eq('id', input.productId)
    .select('id')
    .maybeSingle();

  if (updateProductError) {
    throw new Error(updateProductError.message);
  }

  if (!updatedProduct) {
    throw new Error('No se pudo actualizar el producto. Revisa los permisos de update sobre products.');
  }

  await syncInventoryItemFromCatalogProduct(supabase, {
    currentName: currentProduct.name,
    nextName: currentProduct.name,
    isActive: input.isActive,
    inventoryEnabled: input.inventoryEnabled,
    isInventoryItem: input.isInventoryItem,
    inventoryDeductionMode: input.inventoryDeductionMode,
    inventoryKind: input.inventoryKind,
    inventoryUnitName: input.inventoryUnitName,
    packagingName: input.packagingName,
    packagingSize,
    currentStockUnits,
    lowStockThreshold,
  });

  await replaceProductInventoryLinks(supabase, {
    productId: input.productId,
    inventoryDeductionMode: input.inventoryDeductionMode,
    inventoryLinks: normalizedInventoryLinks,
  });

  const { error: deleteComponentsError } = await supabase
    .from('product_components')
    .delete()
    .eq('parent_product_id', input.productId);

  if (deleteComponentsError) {
    throw new Error(deleteComponentsError.message);
  }

  if (normalizedComponents.length > 0) {
    const rowsToInsert = normalizedComponents.map((row) => ({
      parent_product_id: input.productId,
      component_product_id: row.componentProductId,
      component_mode: row.componentMode,
      quantity: row.quantity,
      counts_toward_detail_limit: row.countsTowardDetailLimit,
      is_required: row.isRequired,
      sort_order: row.sortOrder,
      notes: row.notes,
    }));

    const { error: insertComponentsError } = await supabase
      .from('product_components')
      .insert(rowsToInsert);

    if (insertComponentsError) {
      throw new Error(insertComponentsError.message);
    }
  }

  revalidatePath('/app/master/dashboard');
}

export async function updateExchangeRateAction(input: {
  rateBsPerUsd: number;
}) {
  const supabase = await createSupabaseServer();

  const rate = Number(input.rateBsPerUsd);
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new Error('La tasa debe ser mayor a 0.');
  }

  const { error: disableError } = await supabase
    .from('exchange_rates')
    .update({ is_active: false })
    .eq('is_active', true);

  if (disableError) {
    throw new Error(disableError.message);
  }

  const { error: insertError } = await supabase
    .from('exchange_rates')
    .insert({
      rate_bs_per_usd: rate,
      is_active: true,
      effective_at: new Date().toISOString(),
    });

  if (insertError) {
    throw new Error(insertError.message);
  }

  const { data: products, error: productsError } = await supabase
    .from('products')
    .select('id, source_price_amount, source_price_currency');

  if (productsError) {
    throw new Error(productsError.message);
  }

  for (const product of products ?? []) {
    const sourceAmount = Number(product.source_price_amount || 0);
    const sourceCurrency = String(product.source_price_currency || '');

    if (sourceCurrency !== 'USD') {
      continue;
    }

    const basePriceUsd = sourceAmount;
    const basePriceBs = sourceAmount * rate;

    const { error: updateProductError } = await supabase
      .from('products')
      .update({
        base_price_usd: basePriceUsd,
        base_price_bs: basePriceBs,
      })
      .eq('id', product.id);

    if (updateProductError) {
      throw new Error(updateProductError.message);
    }
  }

  revalidatePath('/app/master/dashboard');
}

export async function updateCatalogPricesQuickAction(input: {
  items: Array<{
    productId: number;
    sourcePriceAmount: number;
  }>;
}) {
  const { supabase } = await requireMasterOrAdmin();

  const items = (input.items ?? [])
    .map((row) => ({
      productId: toSafeNumber(row.productId, 0),
      sourcePriceAmount: toSafeNumber(row.sourcePriceAmount, NaN),
    }))
    .filter(
      (row) =>
        Number.isFinite(row.productId) &&
        row.productId > 0 &&
        Number.isFinite(row.sourcePriceAmount) &&
        row.sourcePriceAmount >= 0
    );

  if (items.length === 0) {
    throw new Error('No hay precios vÃ¡lidos para actualizar.');
  }

  const productIds = items.map((row) => row.productId);

  const { data: products, error: productsError } = await supabase
    .from('products')
    .select('id, source_price_currency')
    .in('id', productIds);

  if (productsError) throw new Error(productsError.message);

  const { data: exchangeRateData, error: exchangeRateError } = await supabase
    .from('exchange_rates')
    .select('id, rate_bs_per_usd')
    .eq('is_active', true)
    .order('effective_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (exchangeRateError) throw new Error(exchangeRateError.message);

  const rateBsPerUsd = toSafeNumber(exchangeRateData?.rate_bs_per_usd, 0);

  if (rateBsPerUsd <= 0) {
    throw new Error('No hay una tasa activa vÃ¡lida.');
  }

  const productCurrencyById = new Map<number, 'VES' | 'USD'>();
  for (const product of products ?? []) {
    productCurrencyById.set(
      Number(product.id),
      product.source_price_currency === 'VES' ? 'VES' : 'USD'
    );
  }

  for (const item of items) {
    const sourcePriceCurrency = productCurrencyById.get(item.productId);

    if (!sourcePriceCurrency) {
      throw new Error(`No se pudo cargar el producto ${item.productId}.`);
    }

    let basePriceUsd = 0;
    let basePriceBs = 0;

    if (sourcePriceCurrency === 'USD') {
      basePriceUsd = item.sourcePriceAmount;
      basePriceBs = item.sourcePriceAmount * rateBsPerUsd;
    } else {
      basePriceBs = item.sourcePriceAmount;
      basePriceUsd = item.sourcePriceAmount / rateBsPerUsd;
    }

    const { error: updateError } = await supabase
      .from('products')
      .update({
        source_price_amount: item.sourcePriceAmount,
        base_price_usd: basePriceUsd,
        base_price_bs: basePriceBs,
      })
      .eq('id', item.productId);

    if (updateError) {
      throw new Error(updateError.message);
    }
  }

  revalidatePath('/app/master/dashboard');
}

export async function createMoneyAccountAction(input: {
  name: string;
  currencyCode: 'USD' | 'VES';
  accountKind: 'bank' | 'cash' | 'fund' | 'other' | 'pos' | 'wallet';
  institutionName: string;
  ownerName: string;
  notes: string;
  isActive: boolean;
}) {
  const { supabase, user } = await requireMasterOrAdmin();

  const name = String(input.name || '').trim();
  if (!name) throw new Error('El nombre de la cuenta es obligatorio.');

  const { error } = await supabase.from('money_accounts').insert({
    name,
    currency_code: input.currencyCode,
    account_kind: input.accountKind,
    institution_name: input.institutionName.trim() || null,
    owner_name: input.ownerName.trim() || null,
    notes: input.notes.trim() || null,
    is_active: input.isActive,
    created_by_user_id: user.id,
  });

  if (error) throw new Error(error.message);
  revalidatePath('/app/master/dashboard');
}

export async function updateMoneyAccountAction(input: {
  accountId: number;
  name: string;
  currencyCode: 'USD' | 'VES';
  accountKind: 'bank' | 'cash' | 'fund' | 'other' | 'pos' | 'wallet';
  institutionName: string;
  ownerName: string;
  notes: string;
  isActive: boolean;
}) {
  const { supabase } = await requireMasterOrAdmin();

  const accountId = Number(input.accountId);
  if (!Number.isFinite(accountId) || accountId <= 0) {
    throw new Error('Cuenta invÃƒÂ¡lida.');
  }

  const name = String(input.name || '').trim();
  if (!name) throw new Error('El nombre de la cuenta es obligatorio.');

  const { error } = await supabase
    .from('money_accounts')
    .update({
      name,
      currency_code: input.currencyCode,
      account_kind: input.accountKind,
      institution_name: input.institutionName.trim() || null,
      owner_name: input.ownerName.trim() || null,
      notes: input.notes.trim() || null,
      is_active: input.isActive,
    })
    .eq('id', accountId);

  if (error) throw new Error(error.message);
  revalidatePath('/app/master/dashboard');
}

export async function toggleMoneyAccountActiveAction(input: {
  accountId: number;
  nextIsActive: boolean;
}) {
  const { supabase } = await requireMasterOrAdmin();

  const accountId = Number(input.accountId);
  if (!Number.isFinite(accountId) || accountId <= 0) {
    throw new Error('Cuenta invÃƒÂ¡lida.');
  }

  const { error } = await supabase
    .from('money_accounts')
    .update({ is_active: input.nextIsActive })
    .eq('id', accountId);

  if (error) throw new Error(error.message);
  revalidatePath('/app/master/dashboard');
}

export async function createInventoryItemAction(input: {
  name: string;
  inventoryKind: 'raw_material' | 'prepared_base' | 'finished_stock' | 'packaging';
  unitName: string;
  packagingName: string | null;
  packagingSize: number | null;
  currentStockUnits: number;
  lowStockThreshold: number | null;
  isActive: boolean;
  notes: string | null;
}) {
  const { supabase } = await requireMasterOrAdmin();

  const name = String(input.name || '').trim();
  if (!name) throw new Error('El nombre del item es obligatorio.');
  if (!['raw_material', 'prepared_base', 'finished_stock', 'packaging'].includes(input.inventoryKind)) {
    throw new Error('Tipo de inventario inválido.');
  }

  const { error } = await supabase.from('inventory_items').insert({
    name,
    inventory_kind: input.inventoryKind,
    unit_name: String(input.unitName || '').trim() || 'pieza',
    packaging_name: String(input.packagingName || '').trim() || null,
    packaging_size:
      input.packagingSize == null ? null : Math.max(0, toSafeNumber(input.packagingSize, 0)),
    current_stock_units: Math.max(0, toSafeNumber(input.currentStockUnits, 0)),
    low_stock_threshold:
      input.lowStockThreshold == null ? null : Math.max(0, toSafeNumber(input.lowStockThreshold, 0)),
    is_active: !!input.isActive,
    notes: String(input.notes || '').trim() || null,
  });

  if (error) throw new Error(error.message);
  revalidatePath('/app/master/dashboard');
}

export async function updateInventoryItemAction(input: {
  inventoryItemId: number;
  name: string;
  inventoryKind: 'raw_material' | 'prepared_base' | 'finished_stock' | 'packaging';
  unitName: string;
  packagingName: string | null;
  packagingSize: number | null;
  currentStockUnits: number;
  lowStockThreshold: number | null;
  isActive: boolean;
  notes: string | null;
}) {
  const { supabase } = await requireMasterOrAdmin();

  const inventoryItemId = Number(input.inventoryItemId);
  if (!Number.isFinite(inventoryItemId) || inventoryItemId <= 0) {
    throw new Error('Item de inventario inválido.');
  }

  const name = String(input.name || '').trim();
  if (!name) throw new Error('El nombre del item es obligatorio.');
  if (!['raw_material', 'prepared_base', 'finished_stock', 'packaging'].includes(input.inventoryKind)) {
    throw new Error('Tipo de inventario inválido.');
  }

  const { error } = await supabase
    .from('inventory_items')
    .update({
      name,
      inventory_kind: input.inventoryKind,
      unit_name: String(input.unitName || '').trim() || 'pieza',
      packaging_name: String(input.packagingName || '').trim() || null,
      packaging_size:
        input.packagingSize == null ? null : Math.max(0, toSafeNumber(input.packagingSize, 0)),
      current_stock_units: Math.max(0, toSafeNumber(input.currentStockUnits, 0)),
      low_stock_threshold:
        input.lowStockThreshold == null ? null : Math.max(0, toSafeNumber(input.lowStockThreshold, 0)),
      is_active: !!input.isActive,
      notes: String(input.notes || '').trim() || null,
    })
    .eq('id', inventoryItemId);

  if (error) throw new Error(error.message);
  revalidatePath('/app/master/dashboard');
}

export async function toggleInventoryItemActiveAction(input: {
  inventoryItemId: number;
  nextIsActive: boolean;
}) {
  const { supabase } = await requireMasterOrAdmin();

  const inventoryItemId = Number(input.inventoryItemId);
  if (!Number.isFinite(inventoryItemId) || inventoryItemId <= 0) {
    throw new Error('Item de inventario inválido.');
  }

  const { error } = await supabase
    .from('inventory_items')
    .update({ is_active: !!input.nextIsActive })
    .eq('id', inventoryItemId);

  if (error) throw new Error(error.message);
  revalidatePath('/app/master/dashboard');
}

export async function createDeliveryPartnerAction(input: {
  name: string;
  partnerType: string;
  whatsappPhone: string;
  isActive: boolean;
}) {
  const { supabase } = await requireMasterOrAdmin();

  const name = String(input.name || '').trim();
  if (!name) throw new Error('El nombre del partner es obligatorio.');
  const partnerType =
    String(input.partnerType || '').trim() === 'direct_driver'
      ? 'direct_driver'
      : 'company_dispatch';

  const { data, error } = await supabase
    .from('delivery_partners')
    .insert({
      name,
      partner_type: partnerType,
      whatsapp_phone: normalizePhone(String(input.whatsappPhone || '')) || null,
      is_active: !!input.isActive,
    })
    .select('id')
    .single();

  if (error) throw new Error(error.message);
  if (!data?.id) {
    throw new Error('No se pudo crear el partner externo.');
  }
  revalidatePath('/app/master/dashboard');
}

export async function updateDeliveryPartnerAction(input: {
  partnerId: number;
  name: string;
  partnerType: string;
  whatsappPhone: string;
  isActive: boolean;
}) {
  const { supabase } = await requireMasterOrAdmin();

  const partnerId = Number(input.partnerId);
  if (!Number.isFinite(partnerId) || partnerId <= 0) {
    throw new Error('Partner invÃ¡lido.');
  }

  const name = String(input.name || '').trim();
  if (!name) throw new Error('El nombre del partner es obligatorio.');
  const partnerType =
    String(input.partnerType || '').trim() === 'direct_driver'
      ? 'direct_driver'
      : 'company_dispatch';

  const { data, error } = await supabase
    .from('delivery_partners')
    .update({
      name,
      partner_type: partnerType,
      whatsapp_phone: normalizePhone(String(input.whatsappPhone || '')) || null,
      is_active: !!input.isActive,
    })
    .eq('id', partnerId)
    .select('id')
    .single();

  if (error) throw new Error(error.message);
  if (!data?.id) {
    throw new Error('No se pudo actualizar el partner externo.');
  }
  revalidatePath('/app/master/dashboard');
}

export async function toggleDeliveryPartnerActiveAction(input: {
  partnerId: number;
  nextIsActive: boolean;
}) {
  const { supabase } = await requireMasterOrAdmin();

  const partnerId = Number(input.partnerId);
  if (!Number.isFinite(partnerId) || partnerId <= 0) {
    throw new Error('Partner invÃ¡lido.');
  }

  const { error } = await supabase
    .from('delivery_partners')
    .update({ is_active: !!input.nextIsActive })
    .eq('id', partnerId);

  if (error) throw new Error(error.message);
  revalidatePath('/app/master/dashboard');
}

export async function createOrderAdminAdjustmentAction(input: {
  orderId: number;
  kind: 'advisor_change' | 'client_change' | 'schedule_change';
  reason: string;
  notes?: string | null;
  nextAdvisorUserId?: string | null;
  nextClientId?: number | null;
  nextDeliveryDate?: string | null;
  nextDeliveryHour12?: string | null;
  nextDeliveryMinute?: string | null;
  nextDeliveryAmPm?: 'AM' | 'PM' | null;
}) {
  const { supabase, user, roles } = await requireMasterOrAdmin();

  if (!roles.includes('admin')) {
    throw new Error('Solo admin puede crear ajustes administrativos.');
  }

  const orderId = Number(input.orderId);
  if (!Number.isFinite(orderId) || orderId <= 0) {
    throw new Error('Orden invÃ¡lida.');
  }

  const kind = String(input.kind || '').trim();
  if (!['advisor_change', 'client_change', 'schedule_change'].includes(kind)) {
    throw new Error('Tipo de ajuste invÃ¡lido.');
  }

  const reason = String(input.reason || '').trim();
  if (!reason) {
    throw new Error('Debes indicar el motivo del ajuste.');
  }

  const { data: currentOrder, error: currentOrderError } = await supabase
    .from('orders')
    .select('id, client_id, attributed_advisor_id, extra_fields')
    .eq('id', orderId)
    .single();

  if (currentOrderError || !currentOrder) {
    throw new Error(currentOrderError?.message || 'No se pudo cargar la orden.');
  }

  const nowIso = new Date().toISOString();
  const payload: Record<string, unknown> = { kind };
  const updatePayload: Record<string, unknown> = {
    last_modified_at: nowIso,
    last_modified_by: user.id,
  };

  if (kind === 'advisor_change') {
    const nextAdvisorUserId = String(input.nextAdvisorUserId || '').trim();
    if (!nextAdvisorUserId) {
      throw new Error('Debes seleccionar el nuevo asesor.');
    }

    updatePayload.attributed_advisor_id = nextAdvisorUserId;
    payload.previous_advisor_user_id = currentOrder.attributed_advisor_id ?? null;
    payload.next_advisor_user_id = nextAdvisorUserId;
  }

  if (kind === 'client_change') {
    const nextClientId = Number(input.nextClientId || 0);
    if (!Number.isFinite(nextClientId) || nextClientId <= 0) {
      throw new Error('Debes seleccionar el nuevo cliente.');
    }

    updatePayload.client_id = nextClientId;
    payload.previous_client_id = currentOrder.client_id ?? null;
    payload.next_client_id = nextClientId;
  }

  if (kind === 'schedule_change') {
    const nextDate = String(input.nextDeliveryDate || '').trim();
    const nextHour12 = String(input.nextDeliveryHour12 || '').trim();
    const nextMinute = String(input.nextDeliveryMinute || '').trim();
    const nextAmPm = input.nextDeliveryAmPm;

    if (!nextDate || !nextHour12 || !nextMinute || (nextAmPm !== 'AM' && nextAmPm !== 'PM')) {
      throw new Error('Debes completar la nueva fecha y hora.');
    }

    const nextTime24 = from12hTo24h(nextHour12, nextMinute, nextAmPm);
    const currentExtraFields =
      currentOrder.extra_fields && typeof currentOrder.extra_fields === 'object' && !Array.isArray(currentOrder.extra_fields)
        ? (currentOrder.extra_fields as Record<string, unknown>)
        : {};

    updatePayload.extra_fields = {
      ...currentExtraFields,
      schedule: {
        date: nextDate,
        time_12: `${nextHour12}:${pad2(Number(nextMinute || 0))} ${nextAmPm}`,
        time_24: nextTime24,
      },
    };

    payload.previous_schedule =
      currentExtraFields.schedule && typeof currentExtraFields.schedule === 'object'
        ? currentExtraFields.schedule
        : null;
    payload.next_schedule = {
      date: nextDate,
      time_12: `${nextHour12}:${pad2(Number(nextMinute || 0))} ${nextAmPm}`,
      time_24: nextTime24,
    };
  }

  const { error: updateOrderError } = await supabase
    .from('orders')
    .update(updatePayload)
    .eq('id', orderId);

  if (updateOrderError) {
    throw new Error(updateOrderError.message);
  }

  const { error: adjustmentError } = await supabase
    .from('order_admin_adjustments')
    .insert({
      order_id: orderId,
      order_item_id: null,
      adjustment_type: 'other',
      reason,
      notes: String(input.notes || '').trim() || null,
      payload,
      created_by_user_id: user.id,
    });

  if (adjustmentError) {
    throw new Error(adjustmentError.message);
  }

  revalidatePath('/app/master/dashboard');
  return { id: orderId };
}

function normalizeTagList(input: string[]) {
  return Array.from(
    new Set(
      (input ?? [])
        .map((tag) => String(tag || '').trim())
        .filter(Boolean)
    )
  );
}

function normalizeRecentAddressesForClient(input: unknown) {
  if (!Array.isArray(input)) return [] as Array<{ address_text: string; gps_url: string | null }>;

  return input
    .map((row) => {
      const data =
        row && typeof row === 'object' ? (row as Record<string, unknown>) : {};

      return {
        address_text: String(data.address_text ?? data.addressText ?? '').trim(),
        gps_url: String(data.gps_url ?? data.gpsUrl ?? '').trim() || null,
      };
    })
    .filter((row) => row.address_text || row.gps_url);
}

function mergeRecentAddresses(
  currentValue: unknown,
  nextAddressText: string,
  nextGpsUrl: string
) {
  const current = normalizeRecentAddressesForClient(currentValue);
  const normalizedAddressText = String(nextAddressText || '').trim();
  const normalizedGpsUrl = String(nextGpsUrl || '').trim() || null;

  if (!normalizedAddressText && !normalizedGpsUrl) {
    return current.slice(0, 2);
  }

  const nextEntry = {
    address_text: normalizedAddressText,
    gps_url: normalizedGpsUrl,
  };

  const deduped = current.filter(
    (row) =>
      !(
        row.address_text === nextEntry.address_text &&
        (row.gps_url ?? null) === (nextEntry.gps_url ?? null)
      )
  );

  return [nextEntry, ...deduped].slice(0, 2);
}

function normalizeRecentAddresses(
  input: Array<{ addressText: string; gpsUrl: string }>
) {
  return (input ?? [])
    .map((row) => ({
      address_text: String(row?.addressText || '').trim(),
      gps_url: String(row?.gpsUrl || '').trim(),
    }))
    .filter((row) => row.address_text || row.gps_url)
    .slice(0, 2);
}

async function assertDeliveryItemForOrder(
  supabase: Awaited<ReturnType<typeof createSupabaseServer>>,
  items: Array<{ productId: number; productNameSnapshot?: string | null }>
) {
  const productIds = Array.from(
    new Set(
      (items ?? [])
        .map((item) => Number(item.productId))
        .filter((id) => Number.isFinite(id) && id > 0)
    )
  );

  if (productIds.length === 0) {
    throw new Error('Debes agregar un Ã­tem de delivery.');
  }

  const { data, error } = await supabase
    .from('products')
    .select('id, name, internal_rider_pay_usd')
    .in('id', productIds);

  if (error) throw new Error(error.message);

  const hasDeliveryItem = (data ?? []).some((product) => {
    const name = String(product.name || '').trim().toLowerCase();
    return Number(product.internal_rider_pay_usd || 0) > 0 || name.includes('delivery');
  });

  if (!hasDeliveryItem) {
    throw new Error('Una orden delivery debe incluir un producto de delivery.');
  }
}

async function replaceProductInventoryLinks(
  supabase: Awaited<ReturnType<typeof createSupabaseServer>>,
  input: {
    productId: number;
    inventoryDeductionMode: 'self' | 'composition';
    inventoryLinks: Array<{
      inventoryItemId: number;
      quantityUnits: number;
      notes: string | null;
      sortOrder: number;
    }>;
  }
) {
  const { error: deleteError } = await supabase
    .from('product_inventory_links')
    .delete()
    .eq('product_id', input.productId);

  if (deleteError) {
    throw new Error(deleteError.message);
  }

  if (input.inventoryDeductionMode !== 'composition') {
    return;
  }

  const normalized = (input.inventoryLinks ?? [])
    .map((row, index) => ({
      inventoryItemId: toSafeNumber(row.inventoryItemId, 0),
      quantityUnits: Math.max(0, toSafeNumber(row.quantityUnits, 0)),
      notes: row.notes?.trim() ? row.notes.trim() : null,
      sortOrder: toSafeNumber(row.sortOrder, index + 1) || index + 1,
    }))
    .filter((row) => row.inventoryItemId > 0 && row.quantityUnits > 0);

  if (normalized.length === 0) {
    return;
  }

  const { data: existingItems, error: existingItemsError } = await supabase
    .from('inventory_items')
    .select('id')
    .in('id', normalized.map((row) => row.inventoryItemId));

  if (existingItemsError) {
    throw new Error(existingItemsError.message);
  }

  const foundIds = new Set((existingItems ?? []).map((row) => Number(row.id)));
  const missing = normalized.filter((row) => !foundIds.has(row.inventoryItemId));
  if (missing.length > 0) {
    throw new Error('Hay items internos invÃ¡lidos en el descuento de inventario.');
  }

  const { error: insertError } = await supabase
    .from('product_inventory_links')
    .insert(
      normalized.map((row) => ({
        product_id: input.productId,
        inventory_item_id: row.inventoryItemId,
        deduction_mode: 'recipe',
        quantity_units: row.quantityUnits,
        sort_order: row.sortOrder,
        notes: row.notes,
        is_active: true,
      }))
    );

  if (insertError) {
    throw new Error(insertError.message);
  }
}

async function applyDeliveredOrderInventoryDeductions(
  supabase: Awaited<ReturnType<typeof createSupabaseServer>>,
  userId: string,
  orderId: number
) {
  const { data: existingSaleMovements, error: existingSaleMovementsError } = await supabase
    .from('inventory_movements')
    .select('id')
    .eq('order_id', orderId)
    .eq('movement_type', 'sale_out')
    .limit(1);

  if (existingSaleMovementsError) {
    throw new Error(existingSaleMovementsError.message);
  }

  if ((existingSaleMovements ?? []).length > 0) {
    return;
  }

  const { data: orderRow, error: orderError } = await supabase
    .from('orders')
    .select('id, order_number')
    .eq('id', orderId)
    .single();

  if (orderError || !orderRow) {
    throw new Error(orderError?.message || 'No se pudo cargar la orden entregada.');
  }

  const { data: orderItems, error: orderItemsError } = await supabase
    .from('order_items')
    .select('id, product_id, qty, product_name_snapshot')
    .eq('order_id', orderId);

  if (orderItemsError) {
    throw new Error(orderItemsError.message);
  }

  const productIds = Array.from(
    new Set((orderItems ?? []).map((row) => toSafeNumber(row.product_id, 0)).filter((id) => id > 0))
  );

  if (productIds.length === 0) {
    return;
  }

  const { data: products, error: productsError } = await supabase
    .from('products')
    .select('id, name, inventory_enabled, inventory_deduction_mode')
    .in('id', productIds);

  if (productsError) {
    throw new Error(productsError.message);
  }

  const { data: links, error: linksError } = await supabase
    .from('product_inventory_links')
    .select('product_id, inventory_item_id, quantity_units, is_active')
    .in('product_id', productIds);

  if (linksError) {
    throw new Error(linksError.message);
  }

  const productById = new Map(
    (products ?? []).map((row) => [
      Number(row.id),
      {
        id: Number(row.id),
        name: String(row.name || '').trim(),
        inventoryEnabled: !!row.inventory_enabled,
        deductionMode: row.inventory_deduction_mode === 'composition' ? ('composition' as const) : ('self' as const),
      },
    ])
  );

  const linksByProductId = new Map<number, Array<{ inventoryItemId: number; quantityUnits: number }>>();
  for (const row of links ?? []) {
    if (!row.is_active) continue;
    const productId = Number(row.product_id);
    const list = linksByProductId.get(productId) ?? [];
    list.push({
      inventoryItemId: Number(row.inventory_item_id),
      quantityUnits: Math.max(0, toSafeNumber(row.quantity_units, 0)),
    });
    linksByProductId.set(productId, list);
  }

  const selfInventoryNames = Array.from(
    new Set(
      (products ?? [])
        .filter((row) => row.inventory_enabled && row.inventory_deduction_mode !== 'composition')
        .map((row) => String(row.name || '').trim())
        .filter(Boolean)
    )
  );

  const inventoryItemsByName = new Map<string, { id: number; currentStockUnits: number }>();
  if (selfInventoryNames.length > 0) {
    const { data: selfInventoryItems, error: selfInventoryItemsError } = await supabase
      .from('inventory_items')
      .select('id, name, current_stock_units')
      .in('name', selfInventoryNames);

    if (selfInventoryItemsError) {
      throw new Error(selfInventoryItemsError.message);
    }

    for (const row of selfInventoryItems ?? []) {
      inventoryItemsByName.set(String(row.name || '').trim(), {
        id: Number(row.id),
        currentStockUnits: toSafeNumber(row.current_stock_units, 0),
      });
    }
  }

  const allLinkedInventoryIds = Array.from(
    new Set((links ?? []).filter((row) => row.is_active).map((row) => Number(row.inventory_item_id)).filter((id) => id > 0))
  );

  const inventoryItemsById = new Map<number, { id: number; currentStockUnits: number }>();
  if (allLinkedInventoryIds.length > 0) {
    const { data: linkedInventoryItems, error: linkedInventoryItemsError } = await supabase
      .from('inventory_items')
      .select('id, current_stock_units')
      .in('id', allLinkedInventoryIds);

    if (linkedInventoryItemsError) {
      throw new Error(linkedInventoryItemsError.message);
    }

    for (const row of linkedInventoryItems ?? []) {
      inventoryItemsById.set(Number(row.id), {
        id: Number(row.id),
        currentStockUnits: toSafeNumber(row.current_stock_units, 0),
      });
    }
  }

  const aggregatedDeductions = new Map<number, number>();
  const notesByInventoryItemId = new Map<number, string[]>();

  for (const row of orderItems ?? []) {
    const productId = toSafeNumber(row.product_id, 0);
    const qty = Math.max(0, toSafeNumber(row.qty, 0));
    if (productId <= 0 || qty <= 0) continue;

    const product = productById.get(productId);
    if (!product?.inventoryEnabled) continue;

    if (product.deductionMode === 'composition') {
      const productLinks = linksByProductId.get(productId) ?? [];
      for (const link of productLinks) {
        if (link.inventoryItemId <= 0 || link.quantityUnits <= 0) continue;
        const delta = qty * link.quantityUnits;
        aggregatedDeductions.set(
          link.inventoryItemId,
          (aggregatedDeductions.get(link.inventoryItemId) ?? 0) + delta
        );
        const notes = notesByInventoryItemId.get(link.inventoryItemId) ?? [];
        notes.push(`${row.product_name_snapshot || product.name} x${qty}`);
        notesByInventoryItemId.set(link.inventoryItemId, notes);
      }
      continue;
    }

    const selfInventoryItem = inventoryItemsByName.get(product.name);
    if (!selfInventoryItem) continue;

    aggregatedDeductions.set(
      selfInventoryItem.id,
      (aggregatedDeductions.get(selfInventoryItem.id) ?? 0) + qty
    );
    const notes = notesByInventoryItemId.get(selfInventoryItem.id) ?? [];
    notes.push(`${row.product_name_snapshot || product.name} x${qty}`);
    notesByInventoryItemId.set(selfInventoryItem.id, notes);
  }

  if (aggregatedDeductions.size === 0) {
    return;
  }

  for (const [inventoryItemId, quantityUnits] of aggregatedDeductions.entries()) {
    const inventoryItem = inventoryItemsById.get(inventoryItemId)
      ?? Array.from(inventoryItemsByName.values()).find((item) => item.id === inventoryItemId);

    if (!inventoryItem) {
      throw new Error(`No se encontró el item interno ${inventoryItemId} para descontar inventario.`);
    }

    const nextStock = inventoryItem.currentStockUnits - quantityUnits;
    const noteLines = notesByInventoryItemId.get(inventoryItemId) ?? [];
    const notes = [`Orden #${orderRow.order_number}`, ...noteLines].join(' · ');

    const { error: movementError } = await supabase
      .from('inventory_movements')
      .insert({
        inventory_item_id: inventoryItemId,
        movement_type: 'sale_out',
        quantity_units: quantityUnits,
        reason_code: 'order_delivery',
        notes,
        order_id: orderId,
        created_by_user_id: userId,
      });

    if (movementError) {
      throw new Error(movementError.message);
    }

    const { error: stockError } = await supabase
      .from('inventory_items')
      .update({ current_stock_units: nextStock })
      .eq('id', inventoryItemId);

    if (stockError) {
      throw new Error(stockError.message);
    }

    inventoryItemsById.set(inventoryItemId, { id: inventoryItemId, currentStockUnits: nextStock });
  }
}

export async function createClientAction(input: {
  fullName: string;
  phone: string;
  notes: string;
  primaryAdvisorId: string | null;
  clientType: string;
  isActive: boolean;
  birthDate: string;
  importantDate: string;
  billingCompanyName: string;
  billingTaxId: string;
  billingAddress: string;
  billingPhone: string;
  deliveryNoteName: string;
  deliveryNoteDocumentId: string;
  deliveryNoteAddress: string;
  deliveryNotePhone: string;
  recentAddresses: Array<{ addressText: string; gpsUrl: string }>;
  crmTags: string[];
}) {
  const { supabase } = await requireMasterOrAdmin();

  const fullName = String(input.fullName || '').trim();
  if (!fullName) throw new Error('El nombre del cliente es obligatorio.');

  const phone = normalizePhone(String(input.phone || ''));
  const billingPhone = normalizePhone(String(input.billingPhone || ''));
  const deliveryNotePhone = normalizePhone(String(input.deliveryNotePhone || ''));

  const { data: createdClient, error } = await supabase.from('clients').insert({
    full_name: fullName,
    phone: phone || null,
    notes: String(input.notes || '').trim() || null,
    primary_advisor_id: input.primaryAdvisorId || null,
    client_type: String(input.clientType || '').trim() || null,
    is_active: !!input.isActive,
    birth_date: String(input.birthDate || '').trim() || null,
    important_date: String(input.importantDate || '').trim() || null,
    billing_company_name: String(input.billingCompanyName || '').trim() || null,
    billing_tax_id: String(input.billingTaxId || '').trim() || null,
    billing_address: String(input.billingAddress || '').trim() || null,
    billing_phone: billingPhone || null,
    delivery_note_name: String(input.deliveryNoteName || '').trim() || null,
    delivery_note_document_id: String(input.deliveryNoteDocumentId || '').trim() || null,
    delivery_note_address: String(input.deliveryNoteAddress || '').trim() || null,
    delivery_note_phone: deliveryNotePhone || null,
    recent_addresses: normalizeRecentAddresses(input.recentAddresses),
    crm_tags: normalizeTagList(input.crmTags),
  }).select(`
    id,
    full_name,
    phone,
    notes,
    primary_advisor_id,
    created_at,
    client_type,
    is_active,
    birth_date,
    important_date,
    billing_company_name,
    billing_tax_id,
    billing_address,
    billing_phone,
    delivery_note_name,
    delivery_note_document_id,
    delivery_note_address,
    delivery_note_phone,
    recent_addresses,
    crm_tags,
    extra_fields,
    updated_at
  `).single();

  if (error) throw new Error(error.message);
  revalidatePath('/app/master/dashboard');

  return createdClient;
}

export async function createOrderClientQuickAction(input: {
  fullName: string;
  phone: string;
  clientType: 'assigned' | 'own' | 'legacy';
}) {
  const { supabase } = await requireMasterOrAdmin();

  const fullName = String(input.fullName || '').trim();
  const phone = normalizePhone(String(input.phone || ''));

  if (!fullName) {
    throw new Error('Debes colocar el nombre del cliente.');
  }

  if (!phone) {
    throw new Error('Debes colocar el telÃ©fono del cliente.');
  }

  const { data: existingClient, error: existingClientError } = await supabase
    .from('clients')
    .select(`
      id,
      full_name,
      phone,
      notes,
      primary_advisor_id,
      created_at,
      client_type,
      is_active,
      birth_date,
      important_date,
      billing_company_name,
      billing_tax_id,
      billing_address,
      billing_phone,
      delivery_note_name,
      delivery_note_document_id,
      delivery_note_address,
      delivery_note_phone,
      recent_addresses,
      crm_tags,
      extra_fields,
      updated_at
    `)
    .eq('phone', phone)
    .maybeSingle();

  if (existingClientError) {
    throw new Error(existingClientError.message);
  }

  if (existingClient) {
    return { client: existingClient, alreadyExisted: true };
  }

  const { data: createdClient, error: createClientError } = await supabase
    .from('clients')
    .insert({
      full_name: fullName,
      phone,
      client_type: input.clientType,
    })
    .select(`
      id,
      full_name,
      phone,
      notes,
      primary_advisor_id,
      created_at,
      client_type,
      is_active,
      birth_date,
      important_date,
      billing_company_name,
      billing_tax_id,
      billing_address,
      billing_phone,
      delivery_note_name,
      delivery_note_document_id,
      delivery_note_address,
      delivery_note_phone,
      recent_addresses,
      crm_tags,
      extra_fields,
      updated_at
    `)
    .single();

  if (createClientError) {
    console.error('createOrderClientQuickAction insert failed', {
      fullName,
      phone,
      clientType: input.clientType,
      message: createClientError.message,
    });
    throw new Error(createClientError.message);
  }

  revalidatePath('/app/master/dashboard');

  return { client: createdClient, alreadyExisted: false };
}

export async function updateClientAction(input: {
  clientId: number;
  fullName: string;
  phone: string;
  notes: string;
  primaryAdvisorId: string | null;
  clientType: string;
  isActive: boolean;
  birthDate: string;
  importantDate: string;
  billingCompanyName: string;
  billingTaxId: string;
  billingAddress: string;
  billingPhone: string;
  deliveryNoteName: string;
  deliveryNoteDocumentId: string;
  deliveryNoteAddress: string;
  deliveryNotePhone: string;
  recentAddresses: Array<{ addressText: string; gpsUrl: string }>;
  crmTags: string[];
}) {
  const { supabase } = await requireMasterOrAdmin();

  const clientId = Number(input.clientId);
  if (!Number.isFinite(clientId) || clientId <= 0) {
    throw new Error('Cliente invÃ¡lido.');
  }

  const fullName = String(input.fullName || '').trim();
  if (!fullName) throw new Error('El nombre del cliente es obligatorio.');

  const phone = normalizePhone(String(input.phone || ''));
  const billingPhone = normalizePhone(String(input.billingPhone || ''));
  const deliveryNotePhone = normalizePhone(String(input.deliveryNotePhone || ''));

  const { error } = await supabase
    .from('clients')
    .update({
      full_name: fullName,
      phone: phone || null,
      notes: String(input.notes || '').trim() || null,
      primary_advisor_id: input.primaryAdvisorId || null,
      client_type: String(input.clientType || '').trim() || null,
      is_active: !!input.isActive,
      birth_date: String(input.birthDate || '').trim() || null,
      important_date: String(input.importantDate || '').trim() || null,
      billing_company_name: String(input.billingCompanyName || '').trim() || null,
      billing_tax_id: String(input.billingTaxId || '').trim() || null,
      billing_address: String(input.billingAddress || '').trim() || null,
      billing_phone: billingPhone || null,
      delivery_note_name: String(input.deliveryNoteName || '').trim() || null,
      delivery_note_document_id: String(input.deliveryNoteDocumentId || '').trim() || null,
      delivery_note_address: String(input.deliveryNoteAddress || '').trim() || null,
      delivery_note_phone: deliveryNotePhone || null,
      recent_addresses: normalizeRecentAddresses(input.recentAddresses),
      crm_tags: normalizeTagList(input.crmTags),
    })
    .eq('id', clientId);

  if (error) throw new Error(error.message);
  revalidatePath('/app/master/dashboard');
}

export async function toggleClientActiveAction(input: {
  clientId: number;
  nextIsActive: boolean;
}) {
  const { supabase } = await requireMasterOrAdmin();

  const clientId = Number(input.clientId);
  if (!Number.isFinite(clientId) || clientId <= 0) {
    throw new Error('Cliente invÃ¡lido.');
  }

  const { error } = await supabase
    .from('clients')
    .update({ is_active: !!input.nextIsActive })
    .eq('id', clientId);

  if (error) throw new Error(error.message);
  revalidatePath('/app/master/dashboard');
}

export async function createCatalogItemAction(input: {
  sku: string;
  name: string;
  type: 'product' | 'combo' | 'service' | 'promo' | 'gambit';
  sourcePriceAmount: number;
  sourcePriceCurrency: 'VES' | 'USD';
  unitsPerService: number;
  isActive: boolean;
  isDetailEditable: boolean;
  detailUnitsLimit: number;
  isInventoryItem: boolean;
  isTemporary: boolean;
  isComboComponentSelectable: boolean;
  commissionMode: 'default' | 'fixed_item' | 'fixed_order';
  commissionValue: number | null;
  commissionNotes: string | null;
  internalRiderPayUsd: number | null;
  inventoryEnabled: boolean;
  inventoryKind: 'raw_material' | 'prepared_base' | 'finished_good';
  inventoryDeductionMode: 'self' | 'composition';
  inventoryUnitName: string;
  packagingName: string | null;
  packagingSize: number | null;
  currentStockUnits: number | null;
  lowStockThreshold: number | null;
  inventoryLinks?: Array<{
    inventoryItemId: number;
    quantityUnits: number;
    notes: string | null;
    sortOrder: number;
  }>;
}) {
  const supabase = await createSupabaseServer();

  const sku = String(input.sku || '').trim().toUpperCase();
  const name = String(input.name || '').trim();
  const sourcePriceAmount = Number(input.sourcePriceAmount || 0);
  const unitsPerService = Number(input.unitsPerService || 0);
  const detailUnitsLimit = Number(input.detailUnitsLimit || 0);
  const internalRiderPayUsd =
    input.internalRiderPayUsd == null ? null : Math.max(0, Number(input.internalRiderPayUsd || 0));
  const packagingSize =
    input.packagingSize == null ? null : Math.max(0, Number(input.packagingSize || 0));
  const currentStockUnits =
    input.currentStockUnits == null ? null : Math.max(0, Number(input.currentStockUnits || 0));
  const lowStockThreshold =
    input.lowStockThreshold == null ? null : Math.max(0, Number(input.lowStockThreshold || 0));

  if (!sku) throw new Error('El SKU es obligatorio.');
  if (!name) throw new Error('El nombre es obligatorio.');
  if (!['product', 'combo', 'service', 'promo', 'gambit'].includes(input.type)) {
    throw new Error('Tipo invÃ¡lido.');
  }
  if (!['VES', 'USD'].includes(input.sourcePriceCurrency)) {
    throw new Error('Moneda invÃ¡lida.');
  }
  if (!['raw_material', 'prepared_base', 'finished_good'].includes(input.inventoryKind)) {
    throw new Error('Tipo de inventario invÃ¡lido.');
  }
  if (!['self', 'composition'].includes(input.inventoryDeductionMode)) {
    throw new Error('Modo de descuento de inventario invÃ¡lido.');
  }
  const normalizedInventoryLinks = (input.inventoryLinks ?? [])
    .map((row, index) => ({
      inventoryItemId: toSafeNumber(row.inventoryItemId, 0),
      quantityUnits: Math.max(0, toSafeNumber(row.quantityUnits, 0)),
      notes: row.notes?.trim() ? row.notes.trim() : null,
      sortOrder: toSafeNumber(row.sortOrder, index + 1) || index + 1,
    }))
    .filter((row) => row.inventoryItemId > 0 && row.quantityUnits > 0);
  if (!Number.isFinite(sourcePriceAmount) || sourcePriceAmount < 0) {
    throw new Error('El monto fuente es invÃ¡lido.');
  }
  if (!Number.isFinite(unitsPerService) || unitsPerService < 0) {
    throw new Error('Und/servicio invÃ¡lido.');
  }
  if (!Number.isFinite(detailUnitsLimit) || detailUnitsLimit < 0) {
    throw new Error('LÃ­mite de detalle invÃ¡lido.');
  }
  if (input.inventoryEnabled && input.inventoryDeductionMode === 'composition' && normalizedInventoryLinks.length === 0) {
    throw new Error('Define al menos un item interno para el descuento por composiciÃ³n.');
  }

  const { data: existingSku, error: existingSkuError } = await supabase
    .from('products')
    .select('id')
    .eq('sku', sku)
    .maybeSingle();

  if (existingSkuError) throw new Error(existingSkuError.message);
  if (existingSku) throw new Error('Ya existe un producto con ese SKU.');

  const { data: activeRate, error: activeRateError } = await supabase
    .from('exchange_rates')
    .select('rate_bs_per_usd')
    .eq('is_active', true)
    .order('effective_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (activeRateError) throw new Error(activeRateError.message);

  const rate = Number(activeRate?.rate_bs_per_usd || 0);
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new Error('No hay una tasa activa vÃ¡lida.');
  }

  let basePriceUsd = 0;
  let basePriceBs = 0;

  if (input.sourcePriceCurrency === 'USD') {
    basePriceUsd = sourcePriceAmount;
    basePriceBs = sourcePriceAmount * rate;
  } else {
    basePriceBs = sourcePriceAmount;
    basePriceUsd = sourcePriceAmount / rate;
  }

  const { data, error } = await supabase
    .from('products')
    .insert({
      sku,
      name,
      type: input.type,
      source_price_amount: sourcePriceAmount,
      source_price_currency: input.sourcePriceCurrency,
      base_price_usd: basePriceUsd,
      base_price_bs: basePriceBs,
      units_per_service: unitsPerService,
      is_active: input.isActive,
      is_detail_editable: input.isDetailEditable,
      detail_units_limit: detailUnitsLimit,
      is_inventory_item: input.isInventoryItem,
      is_temporary: input.isTemporary,
      is_combo_component_selectable: input.isComboComponentSelectable,
      commission_mode: input.commissionMode,
      commission_value: input.commissionMode === 'default' ? null : input.commissionValue,
      commission_notes: input.commissionNotes,
      internal_rider_pay_usd: internalRiderPayUsd,
      inventory_enabled: input.inventoryEnabled,
      inventory_kind: input.inventoryKind,
      inventory_deduction_mode: input.inventoryDeductionMode,
      inventory_unit_name: String(input.inventoryUnitName || 'pieza').trim() || 'pieza',
      packaging_name: input.packagingName?.trim() ? input.packagingName.trim() : null,
      packaging_size: packagingSize,
      current_stock_units: currentStockUnits ?? 0,
      low_stock_threshold: lowStockThreshold,
    })
    .select('id')
    .single();

  if (error) throw new Error(error.message);

  await syncInventoryItemFromCatalogProduct(supabase, {
    nextName: name,
    isActive: input.isActive,
    inventoryEnabled: input.inventoryEnabled,
    isInventoryItem: input.isInventoryItem,
    inventoryDeductionMode: input.inventoryDeductionMode,
    inventoryKind: input.inventoryKind,
    inventoryUnitName: input.inventoryUnitName,
    packagingName: input.packagingName,
    packagingSize,
    currentStockUnits,
    lowStockThreshold,
  });

  await replaceProductInventoryLinks(supabase, {
    productId: Number(data.id),
    inventoryDeductionMode: input.inventoryDeductionMode,
    inventoryLinks: normalizedInventoryLinks,
  });

  revalidatePath('/app/master/dashboard');
  return { id: Number(data.id) };
}

export async function toggleCatalogItemActiveAction(input: {
  productId: number;
  nextIsActive: boolean;
}) {
  const supabase = await createSupabaseServer();

  const { error } = await supabase
    .from('products')
    .update({
      is_active: input.nextIsActive,
    })
    .eq('id', input.productId);

  if (error) {
    throw new Error(error.message);
  }

  revalidatePath('/app/master/dashboard');
}

export async function createInventoryMovementAction(input: {
  inventoryItemId: number;
  movementType:
    | 'inbound'
    | 'damage'
    | 'waste'
    | 'manual_adjustment'
    | 'stock_count';
  quantityUnits: number;
  reasonCode: string | null;
  notes: string | null;
}) {
  const { supabase, user } = await requireMasterOrAdmin();

  const inventoryItemId = toSafeNumber(input.inventoryItemId, 0);
  const quantityUnits = toSafeNumber(input.quantityUnits, 0);

  if (inventoryItemId <= 0) throw new Error('Item de inventario inválido.');
  if (!['inbound', 'damage', 'waste', 'manual_adjustment', 'stock_count'].includes(input.movementType)) {
    throw new Error('Movimiento inválido.');
  }
  if (!Number.isFinite(quantityUnits) || quantityUnits < 0) {
    throw new Error('Cantidad inválida.');
  }

  const { data: inventoryItem, error: inventoryItemError } = await supabase
    .from('inventory_items')
    .select('id, current_stock_units')
    .eq('id', inventoryItemId)
    .single();

  if (inventoryItemError || !inventoryItem) {
    throw new Error(inventoryItemError?.message || 'No se pudo cargar el item de inventario.');
  }

  const currentStock = toSafeNumber(inventoryItem.current_stock_units, 0);
  const signedDelta =
    input.movementType === 'inbound'
      ? quantityUnits
      : input.movementType === 'stock_count'
        ? quantityUnits - currentStock
        : -quantityUnits;

  const nextStock = currentStock + signedDelta;
  if (nextStock < 0) {
    throw new Error('El movimiento dejaría el inventario en negativo.');
  }

  const { error: movementError } = await supabase
    .from('inventory_movements')
    .insert({
      inventory_item_id: inventoryItemId,
      movement_type: input.movementType,
      quantity_units: quantityUnits,
      reason_code: input.reasonCode?.trim() ? input.reasonCode.trim() : null,
      notes: input.notes?.trim() ? input.notes.trim() : null,
      order_id: null,
      created_by_user_id: user.id,
    });

  if (movementError) throw new Error(movementError.message);

  const { error: stockError } = await supabase
    .from('inventory_items')
    .update({
      current_stock_units: nextStock,
    })
    .eq('id', inventoryItemId);

  if (stockError) throw new Error(stockError.message);

  revalidatePath('/app/master/dashboard');
}

export async function createInventoryProductionAction(input: {
  recipeId: number;
  batchMultiplier: number;
  notes: string | null;
}) {
  const { supabase, user } = await requireMasterOrAdmin();

  const recipeId = toSafeNumber(input.recipeId, 0);
  const batchMultiplier = toSafeNumber(input.batchMultiplier, 0);

  if (recipeId <= 0) throw new Error('Receta inválida.');
  if (!Number.isFinite(batchMultiplier) || batchMultiplier <= 0) {
    throw new Error('La cantidad a producir es inválida.');
  }

  const { data: recipe, error: recipeError } = await supabase
    .from('inventory_recipes')
    .select('id, output_inventory_item_id, recipe_kind, output_quantity_units, notes, is_active')
    .eq('id', recipeId)
    .single();

  if (recipeError || !recipe) {
    throw new Error(recipeError?.message || 'No se pudo cargar la receta.');
  }

  if (!recipe.is_active) {
    throw new Error('La receta está inactiva.');
  }

  const { data: components, error: componentsError } = await supabase
    .from('inventory_recipe_components')
    .select('id, input_inventory_item_id, quantity_units, sort_order')
    .eq('recipe_id', recipeId)
    .order('sort_order', { ascending: true });

  if (componentsError) {
    throw new Error(componentsError.message);
  }

  if ((components ?? []).length === 0) {
    throw new Error('La receta no tiene componentes cargados.');
  }

  const inputInventoryItemIds = Array.from(
    new Set((components ?? []).map((component) => Number(component.input_inventory_item_id)).filter((id) => id > 0))
  );

  const allInventoryItemIds = Array.from(
    new Set([...inputInventoryItemIds, Number(recipe.output_inventory_item_id)])
  );

  const { data: inventoryItems, error: inventoryItemsError } = await supabase
    .from('inventory_items')
    .select('id, name, current_stock_units')
    .in('id', allInventoryItemIds);

  if (inventoryItemsError) {
    throw new Error(inventoryItemsError.message);
  }

  const inventoryItemById = new Map((inventoryItems ?? []).map((item) => [Number(item.id), item]));
  const outputInventoryItem = inventoryItemById.get(Number(recipe.output_inventory_item_id));

  if (!outputInventoryItem) {
    throw new Error('No se pudo cargar el item resultante.');
  }

  const componentRows = (components ?? []).map((component) => {
    const inputInventoryItemId = Number(component.input_inventory_item_id);
    const inputInventoryItem = inventoryItemById.get(inputInventoryItemId);
    const baseQuantity = toSafeNumber(component.quantity_units, 0);
    const quantityUnits = baseQuantity * batchMultiplier;

    if (!inputInventoryItem) {
      throw new Error('No se pudo cargar un insumo de la receta.');
    }

    const currentStock = toSafeNumber(inputInventoryItem.current_stock_units, 0);
    if (currentStock < quantityUnits) {
      throw new Error(`Stock insuficiente en ${inputInventoryItem.name}.`);
    }

    return {
      inventoryItemId: inputInventoryItemId,
      inventoryItemName: String(inputInventoryItem.name || 'Insumo'),
      quantityUnits,
      nextStock: currentStock - quantityUnits,
    };
  });

  const outputQuantityUnits = toSafeNumber(recipe.output_quantity_units, 0) * batchMultiplier;
  if (!Number.isFinite(outputQuantityUnits) || outputQuantityUnits <= 0) {
    throw new Error('La receta tiene una salida inválida.');
  }

  const outputCurrentStock = toSafeNumber(outputInventoryItem.current_stock_units, 0);
  const outputNextStock = outputCurrentStock + outputQuantityUnits;
  const notes = input.notes?.trim() || null;
  const recipeLabel = recipe.recipe_kind === 'packaging' ? 'Empaque' : 'Producción';

  for (const component of componentRows) {
    const { error: movementError } = await supabase
      .from('inventory_movements')
      .insert({
        inventory_item_id: component.inventoryItemId,
        movement_type: recipe.recipe_kind === 'packaging' ? 'pack_out' : 'production_out',
        quantity_units: component.quantityUnits,
        reason_code: 'recipe_output',
        notes:
          notes ??
          `${recipeLabel}: ${outputInventoryItem.name}`,
        order_id: null,
        created_by_user_id: user.id,
      });

    if (movementError) throw new Error(movementError.message);

    const { error: stockError } = await supabase
      .from('inventory_items')
      .update({ current_stock_units: component.nextStock })
      .eq('id', component.inventoryItemId);

    if (stockError) throw new Error(stockError.message);
  }

  const { error: outputMovementError } = await supabase
    .from('inventory_movements')
    .insert({
      inventory_item_id: Number(recipe.output_inventory_item_id),
      movement_type: recipe.recipe_kind === 'packaging' ? 'pack_in' : 'production_in',
      quantity_units: outputQuantityUnits,
      reason_code: 'recipe_output',
      notes:
        notes ??
        `${recipeLabel}: ${outputInventoryItem.name}`,
      order_id: null,
      created_by_user_id: user.id,
    });

  if (outputMovementError) throw new Error(outputMovementError.message);

  const { error: outputStockError } = await supabase
    .from('inventory_items')
    .update({ current_stock_units: outputNextStock })
    .eq('id', Number(recipe.output_inventory_item_id));

  if (outputStockError) throw new Error(outputStockError.message);

  revalidatePath('/app/master/dashboard');
}

export async function deleteCatalogItemAction(input: {
  productId: number;
}) {
  const supabase = await createSupabaseServer();

  const productId = Number(input.productId);
  if (!Number.isFinite(productId) || productId <= 0) {
    throw new Error('Producto invÃ¡lido.');
  }

  const { data: orderUse, error: orderUseError } = await supabase
    .from('order_items')
    .select('id')
    .eq('product_id', productId)
    .limit(1);

  if (orderUseError) {
    throw new Error(orderUseError.message);
  }

  if ((orderUse ?? []).length > 0) {
    throw new Error('No se puede eliminar: el producto ya fue usado en Ã³rdenes.');
  }

  const { data: parentUse, error: parentUseError } = await supabase
    .from('product_components')
    .select('id')
    .eq('parent_product_id', productId)
    .limit(1);

  if (parentUseError) {
    throw new Error(parentUseError.message);
  }

  if ((parentUse ?? []).length > 0) {
    throw new Error('No se puede eliminar: el producto tiene composiciÃ³n cargada.');
  }

  const { data: componentUse, error: componentUseError } = await supabase
    .from('product_components')
    .select('id')
    .eq('component_product_id', productId)
    .limit(1);

  if (componentUseError) {
    throw new Error(componentUseError.message);
  }

  if ((componentUse ?? []).length > 0) {
    throw new Error('No se puede eliminar: el producto estÃ¡ siendo usado como componente de otro.');
  }

  const { error } = await supabase
    .from('products')
    .delete()
    .eq('id', productId);

  if (error) {
    throw new Error(error.message);
  }

  revalidatePath('/app/master/dashboard');
}

function pad2(n: number) {
  return String(n).padStart(2, '0');
}

function buildOrderItemOverrideAuditPayload(item: {
  productNameSnapshot: string;
  unitPriceUsdSnapshot: number;
  adminPriceOverrideUsd: number | null;
  qty: number;
  lineTotalUsd: number;
}) {
  const originalUnitPriceUsd = Number(item.unitPriceUsdSnapshot || 0);
  const overrideUnitPriceUsd = Number(item.adminPriceOverrideUsd || 0);
  const qty = Number(item.qty || 0);
  const originalLineTotalUsd = originalUnitPriceUsd * qty;
  const overrideLineTotalUsd = Number(item.lineTotalUsd || 0);

  return {
    kind: 'item_price_override',
    product_name: item.productNameSnapshot,
    qty,
    original_unit_price_usd: originalUnitPriceUsd,
    override_unit_price_usd: overrideUnitPriceUsd,
    original_line_total_usd: originalLineTotalUsd,
    override_line_total_usd: overrideLineTotalUsd,
    delta_usd: overrideLineTotalUsd - originalLineTotalUsd,
  };
}

function pad4(n: number) {
  return String(n).padStart(4, '0');
}

function todayKey() {
  const now = new Date();
  const y = now.getFullYear();
  const m = pad2(now.getMonth() + 1);
  const d = pad2(now.getDate());
  return `${y}${m}${d}`;
}

function normalizePhone(raw: string) {
  return String(raw || '').replace(/[^\d+]/g, '');
}

function from12hTo24h(hour12: string, minute: string, ampm: 'AM' | 'PM') {
  let h = Number(hour12);
  let m = Number(minute);

  if (!Number.isFinite(h) || h < 1 || h > 12) {
    throw new Error('Hora invÃ¡lida (1â€“12).');
  }

  if (!Number.isFinite(m) || m < 0 || m > 59) {
    throw new Error('Minutos invÃ¡lidos (0â€“59).');
  }

  if (ampm === 'AM') {
    if (h === 12) h = 0;
  } else {
    if (h !== 12) h = h + 12;
  }

  return `${pad2(h)}:${pad2(m)}`;
}

async function generateUniqueOrderNumber(supabase: Awaited<ReturnType<typeof createSupabaseServer>>) {
  for (let i = 0; i < 20; i++) {
    const orderNumber = `VO-${todayKey()}-${pad4(Math.floor(Math.random() * 10000))}`;

    const { data, error } = await supabase
      .from('orders')
      .select('id')
      .eq('order_number', orderNumber)
      .maybeSingle();

    if (error) {
      throw new Error(error.message);
    }

    if (!data) {
      return orderNumber;
    }
  }

  throw new Error('No se pudo generar un nÃºmero de orden Ãºnico.');
}

export async function createOrderAction(input: {
  source: 'advisor' | 'master' | 'walk_in';
  attributedAdvisorUserId: string | null;
  fulfillment: 'pickup' | 'delivery';

  selectedClientId: number | null;
  newClientName: string;
  newClientPhone: string;
  newClientType: 'assigned' | 'own' | 'legacy';

  deliveryDate: string;
  deliveryHour12: string;
  deliveryMinute: string;
  deliveryAmPm: 'AM' | 'PM';
  receiverName: string;
  receiverPhone: string;
  deliveryAddress: string;
  deliveryGpsUrl: string;
  note: string;

  discountEnabled: boolean;
  discountPct: string;
  invoiceTaxPct: string;
  fxRate: string;

  paymentMethod: string;
  paymentCurrency: 'USD' | 'VES';
  paymentRequiresChange: boolean;
  paymentChangeFor: string;
  paymentChangeCurrency: 'USD' | 'VES';
  paymentNote: string;
  hasDeliveryNote: boolean;
  hasInvoice: boolean;
  invoiceDataNote: string;
  invoiceCompanyName: string;
  invoiceTaxId: string;
  invoiceAddress: string;
  invoicePhone: string;
  deliveryNoteName: string;
  deliveryNoteDocumentId: string;
  deliveryNoteAddress: string;
  deliveryNotePhone: string;

  items: Array<{
    productId: number;
    skuSnapshot: string | null;
    productNameSnapshot: string;
    qty: number;
    sourcePriceCurrency: 'VES' | 'USD';
    sourcePriceAmount: number;
    unitPriceUsdSnapshot: number;
    lineTotalUsd: number;
    adminPriceOverrideUsd: number | null;
    adminPriceOverrideReason: string | null;
    editableDetailLines: string[];
  }>;
}) {
  const { supabase, user, roles } = await requireMasterOrAdmin();

  const source = input.source;
  const fulfillment = input.fulfillment;

  if (!['advisor', 'master', 'walk_in'].includes(source)) {
    throw new Error('Source invÃ¡lido.');
  }

  if (!['pickup', 'delivery'].includes(fulfillment)) {
    throw new Error('Fulfillment invÃ¡lido.');
  }

  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw new Error('Debes agregar al menos un Ã­tem.');
  }

  if (
    input.items.some((item) => item.adminPriceOverrideUsd != null) &&
    !roles.includes('admin')
  ) {
    throw new Error('Solo admin puede ajustar precios manualmente.');
  }

  if (source === 'advisor' && !input.attributedAdvisorUserId) {
    throw new Error('Debes seleccionar un asesor.');
  }

  if (fulfillment === 'delivery' && !input.deliveryAddress.trim()) {
    throw new Error('La direcciÃ³n es obligatoria para delivery.');
  }

  if (fulfillment === 'delivery') {
    await assertDeliveryItemForOrder(supabase, input.items);
  }

  const deliveryTime24 = from12hTo24h(
    input.deliveryHour12,
    input.deliveryMinute,
    input.deliveryAmPm
  );

  const fxRate = Number(input.fxRate || 0);
  if (!Number.isFinite(fxRate) || fxRate <= 0) {
    throw new Error('La tasa de la orden es invÃ¡lida.');
  }

  let clientId = input.selectedClientId;

  if (!clientId) {
    const fullName = String(input.newClientName || '').trim();
    const phone = normalizePhone(input.newClientPhone || '');

    if (!fullName) {
      throw new Error('Nombre del cliente es obligatorio.');
    }

    if (!phone) {
      throw new Error('TelÃ©fono del cliente es obligatorio.');
    }

    const { data: existingClient, error: existingClientError } = await supabase
      .from('clients')
      .select('id')
      .eq('phone', phone)
      .maybeSingle();

    if (existingClientError) {
      throw new Error(existingClientError.message);
    }

    if (existingClient) {
      clientId = Number(existingClient.id);
    } else {
      const { data: createdClient, error: createClientError } = await supabase
        .from('clients')
        .insert({
          full_name: fullName,
          phone,
          client_type: input.newClientType,
        })
        .select('id')
        .single();

      if (createClientError) {
        throw new Error(createClientError.message);
      }

      clientId = Number(createdClient.id);
    }
  }

  if (!clientId) {
    throw new Error('No se pudo resolver el cliente.');
  }

  const { data: clientAddressData, error: clientAddressError } = await supabase
    .from('clients')
    .select('recent_addresses')
    .eq('id', clientId)
    .maybeSingle();

  if (clientAddressError) {
    throw new Error(clientAddressError.message);
  }

  const { data: clientProfile, error: updateClientProfileError } = await supabase
    .from('clients')
    .update({
      billing_company_name: input.hasInvoice
        ? String(input.invoiceCompanyName || '').trim() || null
        : null,
      billing_tax_id: input.hasInvoice
        ? String(input.invoiceTaxId || '').trim() || null
        : null,
      billing_address: input.hasInvoice
        ? String(input.invoiceAddress || '').trim() || null
        : null,
      billing_phone: input.hasInvoice
        ? normalizePhone(String(input.invoicePhone || '')) || null
        : null,
      delivery_note_name: input.hasDeliveryNote
        ? String(input.deliveryNoteName || '').trim() || null
        : null,
      delivery_note_document_id: input.hasDeliveryNote
        ? String(input.deliveryNoteDocumentId || '').trim() || null
        : null,
      delivery_note_address: input.hasDeliveryNote
        ? String(input.deliveryNoteAddress || '').trim() || null
        : null,
      delivery_note_phone: input.hasDeliveryNote
        ? normalizePhone(String(input.deliveryNotePhone || '')) || null
        : null,
      recent_addresses:
        fulfillment === 'delivery'
          ? mergeRecentAddresses(
              clientAddressData?.recent_addresses,
              input.deliveryAddress,
              input.deliveryGpsUrl
            )
          : clientAddressData?.recent_addresses ?? [],
    })
    .eq('id', clientId)
    .select(`
      full_name,
      phone,
      billing_company_name,
      billing_tax_id,
      billing_address,
      billing_phone,
      delivery_note_name,
      delivery_note_document_id,
      delivery_note_address,
      delivery_note_phone,
      recent_addresses
    `)
    .single();

  if (updateClientProfileError) {
    console.error('createOrderAction client sync failed', {
      clientId,
      hasInvoice: input.hasInvoice,
      hasDeliveryNote: input.hasDeliveryNote,
      fulfillment,
      message: updateClientProfileError.message,
    });
    throw new Error(updateClientProfileError.message);
  }

  if (!clientProfile) {
    throw new Error('No se pudo confirmar la actualizaciÃ³n del cliente.');
  }

  const attributedAdvisorId =
    source === 'advisor' ? input.attributedAdvisorUserId : user.id;

  if (!attributedAdvisorId) {
    throw new Error('No se pudo resolver el asesor atribuido.');
  }

  const fxRateNumber = Math.max(0, Number(input.fxRate || 0));

  const subtotalBs = input.items.reduce((sum, item) => {
    const lineBs =
      item.adminPriceOverrideUsd != null
        ? Number(item.lineTotalUsd || 0) * fxRateNumber
        : item.sourcePriceCurrency === 'VES'
        ? Number(item.sourcePriceAmount || 0) * Number(item.qty || 0)
        : Number(item.lineTotalUsd || 0) * fxRateNumber;

    return sum + lineBs;
  }, 0);

  const subtotalUsd = input.items.reduce((sum, item) => {
    const lineUsd = Number(item.lineTotalUsd || 0);

    return sum + lineUsd;
  }, 0);

  const discountPctNumber = Math.max(
    0,
    Math.min(100, Number(input.discountPct || 0))
  );

  const discountAmountBs = input.discountEnabled
    ? subtotalBs * (discountPctNumber / 100)
    : 0;

  const subtotalAfterDiscountBs = Math.max(0, subtotalBs - discountAmountBs);
  const invoiceTaxPctNumber = input.hasInvoice
    ? Math.max(0, Number(String(input.invoiceTaxPct || '16').replace(',', '.')) || 0)
    : 0;
  const invoiceTaxAmountBs = input.hasInvoice
    ? subtotalAfterDiscountBs * (invoiceTaxPctNumber / 100)
    : 0;
  const totalBs = subtotalAfterDiscountBs + invoiceTaxAmountBs;

  const discountAmountUsd =
    fxRateNumber > 0 ? discountAmountBs / fxRateNumber : 0;
  const subtotalAfterDiscountUsd =
    fxRateNumber > 0 ? subtotalAfterDiscountBs / fxRateNumber : 0;
  const invoiceTaxAmountUsd =
    fxRateNumber > 0 ? invoiceTaxAmountBs / fxRateNumber : 0;

  const totalUsd =
    fxRateNumber > 0 ? totalBs / fxRateNumber : 0;

  const orderNumber = await generateUniqueOrderNumber(supabase);

  const extraFields = {
    schedule: {
      date: input.deliveryDate,
      time_12: `${input.deliveryHour12}:${pad2(Number(input.deliveryMinute || 0))} ${input.deliveryAmPm}`,
      time_24: deliveryTime24,
    },
    receiver: {
      name: input.receiverName.trim() || null,
      phone: input.receiverPhone.trim() ? normalizePhone(input.receiverPhone) : null,
    },
    delivery: {
      address: fulfillment === 'delivery' ? input.deliveryAddress.trim() || null : null,
      gps_url: fulfillment === 'delivery' ? String(input.deliveryGpsUrl || '').trim() || null : null,
    },
    payment: {
      method: input.paymentMethod || null,
      currency: input.paymentCurrency || null,
      requires_change: !!input.paymentRequiresChange,
      change_for: input.paymentChangeFor.trim()
        ? Number(input.paymentChangeFor)
        : null,
      change_currency: input.paymentChangeCurrency || null,
      notes: input.paymentNote.trim() || null,
    },
    documents: {
      has_delivery_note: !!input.hasDeliveryNote,
      has_invoice: !!input.hasInvoice,
      invoice_data_note: input.invoiceDataNote.trim() || null,
      invoice_snapshot: input.hasInvoice
        ? {
            company_name: clientProfile?.billing_company_name ?? null,
            tax_id: clientProfile?.billing_tax_id ?? null,
            address: clientProfile?.billing_address ?? null,
            phone: clientProfile?.billing_phone ?? null,
          }
        : null,
      delivery_note_snapshot: input.hasDeliveryNote
        ? {
            name: clientProfile?.delivery_note_name ?? null,
            document_id: clientProfile?.delivery_note_document_id ?? null,
            address: clientProfile?.delivery_note_address ?? null,
            phone: clientProfile?.delivery_note_phone ?? null,
          }
        : null,
    },
    pricing: {
      fx_rate: fxRateNumber > 0 ? fxRateNumber : null,
      discount_enabled: !!input.discountEnabled,
      discount_pct: input.discountEnabled ? discountPctNumber : 0,
      discount_amount_usd: input.discountEnabled ? discountAmountUsd : 0,
      discount_amount_bs: input.discountEnabled ? discountAmountBs : 0,
      invoice_tax_pct: input.hasInvoice ? invoiceTaxPctNumber : 0,
      invoice_tax_amount_usd: input.hasInvoice ? invoiceTaxAmountUsd : 0,
      invoice_tax_amount_bs: input.hasInvoice ? invoiceTaxAmountBs : 0,
      subtotal_usd: subtotalUsd,
      subtotal_bs: subtotalBs,
      subtotal_after_discount_usd: subtotalAfterDiscountUsd,
      subtotal_after_discount_bs: subtotalAfterDiscountBs,
      total_usd: totalUsd,
      total_bs: totalBs,
    },
    note: input.note.trim() || null,
    ui: {
      quote_only: false,
    },
  };

  const { data: createdOrder, error: orderError } = await supabase
    .from('orders')
    .insert({
      order_number: orderNumber,
      client_id: clientId,
      created_by_user_id: user.id,
      attributed_advisor_id: attributedAdvisorId,
      source,
      fulfillment,
      status: 'created',
      total_usd: totalUsd,
      total_bs_snapshot: totalBs,
      is_price_locked: false,
      delivery_address: fulfillment === 'delivery' ? input.deliveryAddress.trim() || null : null,
      receiver_name: input.receiverName.trim() || null,
      receiver_phone: input.receiverPhone.trim() ? normalizePhone(input.receiverPhone) : null,
      notes: input.note.trim() || null,
      extra_fields: extraFields,
    })
    .select('id')
    .single();

  if (orderError) {
    throw new Error(orderError.message);
  }

  const orderId = Number(createdOrder.id);

  const adminOverrideTimestamp = new Date().toISOString();

  const itemsPayload = input.items.map((item) => ({
    order_id: orderId,
    product_id: item.productId,
    qty: Number(item.qty || 0),
    pricing_origin_currency: item.sourcePriceCurrency,
    pricing_origin_amount: Number(item.sourcePriceAmount || 0),
    unit_price_usd_snapshot: Number(item.unitPriceUsdSnapshot || 0),
    line_total_usd: Number(item.lineTotalUsd || 0),
    unit_price_bs_snapshot:
      item.adminPriceOverrideUsd != null
        ? Number(item.adminPriceOverrideUsd || 0) * fxRateNumber
        : item.sourcePriceCurrency === 'VES'
        ? Number(item.sourcePriceAmount || 0)
        : Number(item.unitPriceUsdSnapshot || 0) * fxRateNumber,
    line_total_bs_snapshot:
      item.adminPriceOverrideUsd != null
        ? Number(item.lineTotalUsd || 0) * fxRateNumber
        : item.sourcePriceCurrency === 'VES'
        ? Number(item.sourcePriceAmount || 0) * Number(item.qty || 0)
        : Number(item.lineTotalUsd || 0) * fxRateNumber,
    admin_price_override_usd:
      item.adminPriceOverrideUsd != null
        ? Number(item.adminPriceOverrideUsd || 0)
        : null,
    admin_price_override_reason: item.adminPriceOverrideReason || null,
    admin_price_override_by_user_id:
      item.adminPriceOverrideUsd != null ? user.id : null,
    admin_price_override_at:
      item.adminPriceOverrideUsd != null ? adminOverrideTimestamp : null,
    sku_snapshot: item.skuSnapshot,
    product_name_snapshot: item.productNameSnapshot,
    notes:
      item.editableDetailLines && item.editableDetailLines.length > 0
        ? item.editableDetailLines.join('\n')
        : null,
  }));

  const { data: insertedItems, error: itemsError } = await supabase
    .from('order_items')
    .insert(itemsPayload)
    .select('id');

  if (itemsError) {
    throw new Error(itemsError.message);
  }

  const createAdjustmentRows = input.items
    .map((item, idx) => {
      if (item.adminPriceOverrideUsd == null) return null;

      return {
        order_id: orderId,
        order_item_id: Number(insertedItems?.[idx]?.id || 0) || null,
        adjustment_type: 'item_price_override',
        reason:
          String(item.adminPriceOverrideReason || '').trim() ||
          'Ajuste administrativo de precio',
        notes: null,
        payload: buildOrderItemOverrideAuditPayload(item),
        created_by_user_id: user.id,
      };
    })
    .filter(Boolean);

  if (createAdjustmentRows.length > 0) {
    const { error: createAdjustmentsError } = await supabase
      .from('order_admin_adjustments')
      .insert(createAdjustmentRows);

    if (createAdjustmentsError) {
      throw new Error(createAdjustmentsError.message);
    }
  }

  const { error: finalizeTotalsError } = await supabase
    .from('orders')
    .update({
      total_usd: totalUsd,
      total_bs_snapshot: totalBs,
      extra_fields: extraFields,
    })
    .eq('id', orderId);

  if (finalizeTotalsError) {
    throw new Error(finalizeTotalsError.message);
  }

  revalidatePath('/app/master/dashboard');

  return { id: orderId, orderNumber };
}

export async function updateOrderAction(input: {
  orderId: number;

  source: 'advisor' | 'master' | 'walk_in';
  attributedAdvisorUserId: string | null;
  fulfillment: 'pickup' | 'delivery';

  selectedClientId: number | null;
  newClientName: string;
  newClientPhone: string;
  newClientType: 'assigned' | 'own' | 'legacy';

  deliveryDate: string;
  deliveryHour12: string;
  deliveryMinute: string;
  deliveryAmPm: 'AM' | 'PM';
  receiverName: string;
  receiverPhone: string;
  deliveryAddress: string;
  deliveryGpsUrl: string;
  note: string;

  discountEnabled: boolean;
  discountPct: string;
  invoiceTaxPct: string;
  fxRate: string;

  paymentMethod: string;
  paymentCurrency: 'USD' | 'VES';
  paymentRequiresChange: boolean;
  paymentChangeFor: string;
  paymentChangeCurrency: 'USD' | 'VES';
  paymentNote: string;
  hasDeliveryNote: boolean;
  hasInvoice: boolean;
  invoiceDataNote: string;
  invoiceCompanyName: string;
  invoiceTaxId: string;
  invoiceAddress: string;
  invoicePhone: string;
  deliveryNoteName: string;
  deliveryNoteDocumentId: string;
  deliveryNoteAddress: string;
  deliveryNotePhone: string;

  items: Array<{
    productId: number;
    skuSnapshot: string | null;
    productNameSnapshot: string;
    qty: number;
    sourcePriceCurrency: 'VES' | 'USD';
    sourcePriceAmount: number;
    unitPriceUsdSnapshot: number;
    lineTotalUsd: number;
    adminPriceOverrideUsd: number | null;
    adminPriceOverrideReason: string | null;
    editableDetailLines: string[];
  }>;
  adminEditReason?: string | null;
}) {
  const { supabase, user, roles } = await requireMasterOrAdmin();

  const orderId = Number(input.orderId);
  if (!Number.isFinite(orderId) || orderId <= 0) {
    throw new Error('Orden invÃ¡lida.');
  }

  const source = input.source;
  const fulfillment = input.fulfillment;

  if (!['advisor', 'master', 'walk_in'].includes(source)) {
    throw new Error('Source invÃ¡lido.');
  }

  if (!['pickup', 'delivery'].includes(fulfillment)) {
    throw new Error('Fulfillment invÃ¡lido.');
  }

  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw new Error('Debes agregar al menos un Ã­tem.');
  }

  if (
    input.items.some((item) => item.adminPriceOverrideUsd != null) &&
    !roles.includes('admin')
  ) {
    throw new Error('Solo admin puede ajustar precios manualmente.');
  }

  if (source === 'advisor' && !input.attributedAdvisorUserId) {
    throw new Error('Debes seleccionar un asesor.');
  }

  if (fulfillment === 'delivery' && !input.deliveryAddress.trim()) {
    throw new Error('La direcciÃ³n es obligatoria para delivery.');
  }

  if (fulfillment === 'delivery') {
    await assertDeliveryItemForOrder(supabase, input.items);
  }

  const { data: currentOrder, error: currentOrderError } = await supabase
    .from('orders')
    .select('id, status, client_id, attributed_advisor_id, source, fulfillment, delivery_address, receiver_name, receiver_phone, notes, total_usd, total_bs_snapshot, extra_fields')
    .eq('id', orderId)
    .single();

  if (currentOrderError || !currentOrder) {
    throw new Error(currentOrderError?.message || 'No se pudo cargar la orden.');
  }

  const isAdvancedAdminEdit =
    roles.includes('admin') && !['created', 'queued'].includes(currentOrder.status);

  if (!['created', 'queued'].includes(currentOrder.status) && !roles.includes('admin')) {
    throw new Error('Solo se pueden editar Ã³rdenes en estado created o queued.');
  }

  if (isAdvancedAdminEdit && !String(input.adminEditReason || '').trim()) {
    throw new Error('Debes indicar el motivo de la modificaciÃ³n administrativa.');
  }

  const deliveryTime24 = from12hTo24h(
    input.deliveryHour12,
    input.deliveryMinute,
    input.deliveryAmPm
  );

  let clientId = input.selectedClientId;

  if (!clientId) {
    const fullName = String(input.newClientName || '').trim();
    const phone = normalizePhone(input.newClientPhone || '');

    if (!fullName) {
      throw new Error('Nombre del cliente es obligatorio.');
    }

    if (!phone) {
      throw new Error('TelÃ©fono del cliente es obligatorio.');
    }

    const { data: existingClient, error: existingClientError } = await supabase
      .from('clients')
      .select('id')
      .eq('phone', phone)
      .maybeSingle();

    if (existingClientError) {
      throw new Error(existingClientError.message);
    }

    if (existingClient) {
      clientId = Number(existingClient.id);
    } else {
      const { data: createdClient, error: createClientError } = await supabase
        .from('clients')
        .insert({
          full_name: fullName,
          phone,
          client_type: input.newClientType,
        })
        .select('id')
        .single();

      if (createClientError) {
        throw new Error(createClientError.message);
      }

      clientId = Number(createdClient.id);
    }
  }

  if (!clientId) {
    throw new Error('No se pudo resolver el cliente.');
  }

  const { data: clientAddressData, error: clientAddressError } = await supabase
    .from('clients')
    .select('recent_addresses')
    .eq('id', clientId)
    .maybeSingle();

  if (clientAddressError) {
    throw new Error(clientAddressError.message);
  }

  const { data: clientProfile, error: updateClientProfileError } = await supabase
    .from('clients')
    .update({
      billing_company_name: input.hasInvoice
        ? String(input.invoiceCompanyName || '').trim() || null
        : null,
      billing_tax_id: input.hasInvoice
        ? String(input.invoiceTaxId || '').trim() || null
        : null,
      billing_address: input.hasInvoice
        ? String(input.invoiceAddress || '').trim() || null
        : null,
      billing_phone: input.hasInvoice
        ? normalizePhone(String(input.invoicePhone || '')) || null
        : null,
      delivery_note_name: input.hasDeliveryNote
        ? String(input.deliveryNoteName || '').trim() || null
        : null,
      delivery_note_document_id: input.hasDeliveryNote
        ? String(input.deliveryNoteDocumentId || '').trim() || null
        : null,
      delivery_note_address: input.hasDeliveryNote
        ? String(input.deliveryNoteAddress || '').trim() || null
        : null,
      delivery_note_phone: input.hasDeliveryNote
        ? normalizePhone(String(input.deliveryNotePhone || '')) || null
        : null,
      recent_addresses:
        fulfillment === 'delivery'
          ? mergeRecentAddresses(
              clientAddressData?.recent_addresses,
              input.deliveryAddress,
              input.deliveryGpsUrl
            )
          : clientAddressData?.recent_addresses ?? [],
    })
    .eq('id', clientId)
    .select(`
      full_name,
      phone,
      billing_company_name,
      billing_tax_id,
      billing_address,
      billing_phone,
      delivery_note_name,
      delivery_note_document_id,
      delivery_note_address,
      delivery_note_phone,
      recent_addresses
    `)
    .single();

  if (updateClientProfileError) {
    console.error('updateOrderAction client sync failed', {
      orderId,
      clientId,
      hasInvoice: input.hasInvoice,
      hasDeliveryNote: input.hasDeliveryNote,
      fulfillment,
      message: updateClientProfileError.message,
    });
    throw new Error(updateClientProfileError.message);
  }

  if (!clientProfile) {
    throw new Error('No se pudo confirmar la actualizaciÃ³n del cliente.');
  }

  const attributedAdvisorId =
    source === 'advisor' ? input.attributedAdvisorUserId : user.id;

  if (!attributedAdvisorId) {
    throw new Error('No se pudo resolver el asesor atribuido.');
  }

  const fxRateNumber = Math.max(0, Number(input.fxRate || 0));

  const subtotalBs = input.items.reduce((sum, item) => {
    const lineBs =
      item.adminPriceOverrideUsd != null
        ? Number(item.lineTotalUsd || 0) * fxRateNumber
        : item.sourcePriceCurrency === 'VES'
        ? Number(item.sourcePriceAmount || 0) * Number(item.qty || 0)
        : Number(item.lineTotalUsd || 0) * fxRateNumber;

    return sum + lineBs;
  }, 0);

  const subtotalUsd = input.items.reduce((sum, item) => {
    const lineUsd = Number(item.lineTotalUsd || 0);

    return sum + lineUsd;
  }, 0);

  const discountPctNumber = Math.max(
    0,
    Math.min(100, Number(input.discountPct || 0))
  );

  const discountAmountBs = input.discountEnabled
    ? subtotalBs * (discountPctNumber / 100)
    : 0;

  const subtotalAfterDiscountBs = Math.max(0, subtotalBs - discountAmountBs);
  const invoiceTaxPctNumber = input.hasInvoice
    ? Math.max(0, Number(String(input.invoiceTaxPct || '16').replace(',', '.')) || 0)
    : 0;
  const invoiceTaxAmountBs = input.hasInvoice
    ? subtotalAfterDiscountBs * (invoiceTaxPctNumber / 100)
    : 0;
  const totalBs = subtotalAfterDiscountBs + invoiceTaxAmountBs;

  const discountAmountUsd =
    fxRateNumber > 0 ? discountAmountBs / fxRateNumber : 0;
  const subtotalAfterDiscountUsd =
    fxRateNumber > 0 ? subtotalAfterDiscountBs / fxRateNumber : 0;
  const invoiceTaxAmountUsd =
    fxRateNumber > 0 ? invoiceTaxAmountBs / fxRateNumber : 0;

  const totalUsd =
    fxRateNumber > 0 ? totalBs / fxRateNumber : 0;

  const extraFields = {
    schedule: {
      date: input.deliveryDate,
      time_12: `${input.deliveryHour12}:${pad2(Number(input.deliveryMinute || 0))} ${input.deliveryAmPm}`,
      time_24: deliveryTime24,
    },
    receiver: {
      name: input.receiverName.trim() || null,
      phone: input.receiverPhone.trim() ? normalizePhone(input.receiverPhone) : null,
    },
    delivery: {
      address: fulfillment === 'delivery' ? input.deliveryAddress.trim() || null : null,
      gps_url: fulfillment === 'delivery' ? String(input.deliveryGpsUrl || '').trim() || null : null,
    },
    payment: {
      method: input.paymentMethod || null,
      currency: input.paymentCurrency || null,
      requires_change: !!input.paymentRequiresChange,
      change_for: input.paymentChangeFor.trim()
        ? Number(input.paymentChangeFor)
        : null,
      change_currency: input.paymentChangeCurrency || null,
      notes: input.paymentNote.trim() || null,
    },
    documents: {
      has_delivery_note: !!input.hasDeliveryNote,
      has_invoice: !!input.hasInvoice,
      invoice_data_note: input.invoiceDataNote.trim() || null,
      invoice_snapshot: input.hasInvoice
        ? {
            company_name: clientProfile?.billing_company_name ?? null,
            tax_id: clientProfile?.billing_tax_id ?? null,
            address: clientProfile?.billing_address ?? null,
            phone: clientProfile?.billing_phone ?? null,
          }
        : null,
      delivery_note_snapshot: input.hasDeliveryNote
        ? {
            name: clientProfile?.delivery_note_name ?? null,
            document_id: clientProfile?.delivery_note_document_id ?? null,
            address: clientProfile?.delivery_note_address ?? null,
            phone: clientProfile?.delivery_note_phone ?? null,
          }
        : null,
    },
    pricing: {
      fx_rate: fxRateNumber > 0 ? fxRateNumber : null,
      discount_enabled: !!input.discountEnabled,
      discount_pct: input.discountEnabled ? discountPctNumber : 0,
      discount_amount_usd: input.discountEnabled ? discountAmountUsd : 0,
      discount_amount_bs: input.discountEnabled ? discountAmountBs : 0,
      invoice_tax_pct: input.hasInvoice ? invoiceTaxPctNumber : 0,
      invoice_tax_amount_usd: input.hasInvoice ? invoiceTaxAmountUsd : 0,
      invoice_tax_amount_bs: input.hasInvoice ? invoiceTaxAmountBs : 0,
      subtotal_usd: subtotalUsd,
      subtotal_bs: subtotalBs,
      subtotal_after_discount_usd: subtotalAfterDiscountUsd,
      subtotal_after_discount_bs: subtotalAfterDiscountBs,
      total_usd: totalUsd,
      total_bs: totalBs,
    },
    note: input.note.trim() || null,
    ui: {
      quote_only: false,
    },
  };

  const nowIso = new Date().toISOString();

  const orderUpdatePayload: Record<string, any> = {
    client_id: clientId,
    attributed_advisor_id: attributedAdvisorId,
    source,
    fulfillment,
    total_usd: totalUsd,
    total_bs_snapshot: totalBs,
    delivery_address: fulfillment === 'delivery' ? input.deliveryAddress.trim() || null : null,
    receiver_name: input.receiverName.trim() || null,
    receiver_phone: input.receiverPhone.trim() ? normalizePhone(input.receiverPhone) : null,
    notes: input.note.trim() || null,
    extra_fields: extraFields,
    last_modified_at: nowIso,
    last_modified_by: user.id,
  };

  if (currentOrder.status === 'queued') {
    orderUpdatePayload.queued_needs_reapproval = true;
    orderUpdatePayload.queued_last_modified_at = nowIso;
    orderUpdatePayload.queued_last_modified_by = user.id;
  }

  if (currentOrder.status === 'created') {
    orderUpdatePayload.queued_needs_reapproval = false;
    orderUpdatePayload.queued_last_modified_at = null;
    orderUpdatePayload.queued_last_modified_by = null;
  }

  const { error: updateOrderError } = await supabase
    .from('orders')
    .update(orderUpdatePayload)
    .eq('id', orderId);

  if (updateOrderError) {
    throw new Error(updateOrderError.message);
  }

  const { error: deleteItemsError } = await supabase
    .from('order_items')
    .delete()
    .eq('order_id', orderId);

  if (deleteItemsError) {
    throw new Error(deleteItemsError.message);
  }

  const adminOverrideTimestamp = new Date().toISOString();

  const itemsPayload = input.items.map((item) => ({
    order_id: orderId,
    product_id: item.productId,
    qty: Number(item.qty || 0),
    pricing_origin_currency: item.sourcePriceCurrency,
    pricing_origin_amount: Number(item.sourcePriceAmount || 0),
    unit_price_usd_snapshot: Number(item.unitPriceUsdSnapshot || 0),
    line_total_usd: Number(item.lineTotalUsd || 0),
    unit_price_bs_snapshot:
      item.adminPriceOverrideUsd != null
        ? Number(item.adminPriceOverrideUsd || 0) * fxRateNumber
        : item.sourcePriceCurrency === 'VES'
        ? Number(item.sourcePriceAmount || 0)
        : Number(item.unitPriceUsdSnapshot || 0) * fxRateNumber,
    line_total_bs_snapshot:
      item.adminPriceOverrideUsd != null
        ? Number(item.lineTotalUsd || 0) * fxRateNumber
        : item.sourcePriceCurrency === 'VES'
        ? Number(item.sourcePriceAmount || 0) * Number(item.qty || 0)
        : Number(item.lineTotalUsd || 0) * fxRateNumber,
    admin_price_override_usd:
      item.adminPriceOverrideUsd != null
        ? Number(item.adminPriceOverrideUsd || 0)
        : null,
    admin_price_override_reason: item.adminPriceOverrideReason || null,
    admin_price_override_by_user_id:
      item.adminPriceOverrideUsd != null ? user.id : null,
    admin_price_override_at:
      item.adminPriceOverrideUsd != null ? adminOverrideTimestamp : null,
    sku_snapshot: item.skuSnapshot,
    product_name_snapshot: item.productNameSnapshot,
    notes:
      item.editableDetailLines && item.editableDetailLines.length > 0
        ? item.editableDetailLines.join('\n')
        : null,
  }));

  const { data: insertedItems, error: insertItemsError } = await supabase
    .from('order_items')
    .insert(itemsPayload)
    .select('id');

  if (insertItemsError) {
    throw new Error(insertItemsError.message);
  }

  const { error: deleteOldAdjustmentsError } = await supabase
    .from('order_admin_adjustments')
    .delete()
    .eq('order_id', orderId)
    .eq('adjustment_type', 'item_price_override');

  if (deleteOldAdjustmentsError) {
    throw new Error(deleteOldAdjustmentsError.message);
  }

  const updateAdjustmentRows = input.items
    .map((item, idx) => {
      if (item.adminPriceOverrideUsd == null) return null;

      return {
        order_id: orderId,
        order_item_id: Number(insertedItems?.[idx]?.id || 0) || null,
        adjustment_type: 'item_price_override',
        reason:
          String(item.adminPriceOverrideReason || '').trim() ||
          'Ajuste administrativo de precio',
        notes: null,
        payload: buildOrderItemOverrideAuditPayload(item),
        created_by_user_id: user.id,
      };
    })
    .filter(Boolean);

  if (updateAdjustmentRows.length > 0) {
    const { error: updateAdjustmentsError } = await supabase
      .from('order_admin_adjustments')
      .insert(updateAdjustmentRows);

    if (updateAdjustmentsError) {
      throw new Error(updateAdjustmentsError.message);
    }
  }

  const { error: finalizeTotalsError } = await supabase
    .from('orders')
    .update({
      total_usd: totalUsd,
      total_bs_snapshot: totalBs,
      extra_fields: extraFields,
      last_modified_at: nowIso,
      last_modified_by: user.id,
    })
    .eq('id', orderId);

  if (finalizeTotalsError) {
    throw new Error(finalizeTotalsError.message);
  }

  if (isAdvancedAdminEdit) {
    const beforeExtraFields =
      currentOrder.extra_fields && typeof currentOrder.extra_fields === 'object' && !Array.isArray(currentOrder.extra_fields)
        ? currentOrder.extra_fields
        : {};

    const beforeSnapshot = {
      source: currentOrder.source ?? null,
      fulfillment: currentOrder.fulfillment ?? null,
      client_id: currentOrder.client_id ?? null,
      attributed_advisor_id: currentOrder.attributed_advisor_id ?? null,
      delivery_address: currentOrder.delivery_address ?? null,
      receiver_name: currentOrder.receiver_name ?? null,
      receiver_phone: currentOrder.receiver_phone ?? null,
      notes: currentOrder.notes ?? null,
      total_usd: Number(currentOrder.total_usd ?? 0),
      total_bs_snapshot: Number(currentOrder.total_bs_snapshot ?? 0),
      extra_fields: beforeExtraFields,
    };

    const afterSnapshot = {
      source,
      fulfillment,
      client_id: clientId,
      attributed_advisor_id: attributedAdvisorId,
      delivery_address: fulfillment === 'delivery' ? input.deliveryAddress.trim() || null : null,
      receiver_name: input.receiverName.trim() || null,
      receiver_phone: input.receiverPhone.trim() ? normalizePhone(input.receiverPhone) : null,
      notes: input.note.trim() || null,
      total_usd: totalUsd,
      total_bs_snapshot: totalBs,
      extra_fields: extraFields,
    };

    const changedFields = Object.keys(afterSnapshot).filter((key) => {
      const beforeValue = beforeSnapshot[key as keyof typeof beforeSnapshot];
      const afterValue = afterSnapshot[key as keyof typeof afterSnapshot];
      return !valuesEquivalent(key, beforeValue, afterValue);
    });

    const { error: createAuditError } = await supabase
      .from('order_admin_adjustments')
      .insert({
        order_id: orderId,
        order_item_id: null,
        adjustment_type: 'other',
        reason: String(input.adminEditReason || '').trim(),
        notes: null,
        payload: {
          kind: 'admin_full_edit',
          changed_fields: changedFields,
          before: beforeSnapshot,
          after: afterSnapshot,
        },
        created_by_user_id: user.id,
      });

    if (createAuditError) {
      throw new Error(createAuditError.message);
    }
  }

  revalidatePath('/app/master/dashboard');

  return { id: orderId };
}

export async function logoutAction() {
  const supabase = await createSupabaseServer();

  const { error } = await supabase.auth.signOut();

  if (error) {
    throw new Error(error.message);
  }

  revalidatePath('/login');
  revalidatePath('/app');
  revalidatePath('/app/master/dashboard');

  redirect('/login');
}
