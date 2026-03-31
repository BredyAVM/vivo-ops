'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { createSupabaseServer } from '@/lib/supabase/server';
import { requireMasterOrAdminContext } from '@/lib/auth';

async function requireMasterOrAdmin() {
  return requireMasterOrAdminContext();
}

function toSafeNumber(value: unknown, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
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
    throw new Error('Solo se puede devolver una orden que esté en cola.');
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
    throw new Error('Orden inválida.');
  }

  if (!reason) {
    throw new Error('Debes indicar un motivo de cancelación.');
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
    throw new Error('La orden ya está cancelada.');
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
}) {
  const { supabase } = await requireMasterOrAdmin();

  const { error } = await supabase.rpc('assign_internal_driver', {
    p_order_id: input.orderId,
    p_driver_user_id: input.driverUserId,
  });

  if (error) throw new Error(error.message);
  revalidatePath('/app/master/dashboard');
}

export async function assignExternalPartnerAction(input: {
  orderId: number;
  partnerId: number;
  reference: string | null;
}) {
  const { supabase } = await requireMasterOrAdmin();

  const { error } = await supabase.rpc('assign_external_partner', {
    p_order_id: input.orderId,
    p_partner_id: input.partnerId,
    p_reference: input.reference,
  });

  if (error) throw new Error(error.message);
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
}) {
  const { supabase } = await requireMasterOrAdmin();

  const { error } = await supabase.rpc('out_for_delivery', {
    p_order_id: input.orderId,
  });

  if (error) throw new Error(error.message);
  revalidatePath('/app/master/dashboard');
}

export async function markDeliveredAction(input: {
  orderId: number;
}) {
  const { supabase } = await requireMasterOrAdmin();

  const { error } = await supabase.rpc('mark_delivered', {
    p_order_id: input.orderId,
  });

  if (error) throw new Error(error.message);
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
    throw new Error('Solo se puede devolver a cola una orden que esté en cocina/preparación/lista.');
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
    throw new Error('Producto inválido.');
  }

  const sourcePriceAmount = toSafeNumber(input.sourcePriceAmount, 0);
  const unitsPerService = Math.max(0, toSafeNumber(input.unitsPerService, 0));
  const detailUnitsLimit = Math.max(0, toSafeNumber(input.detailUnitsLimit, 0));

  if (!['VES', 'USD'].includes(input.sourcePriceCurrency)) {
    throw new Error('Moneda inválida.');
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
    throw new Error('No hay una tasa activa válida.');
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
      throw new Error(`Hay componentes inválidos: ${missing.join(', ')}`);
    }
  }

  const { error: updateProductError } = await supabase
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
    })
    .eq('id', input.productId);

  if (updateProductError) {
    throw new Error(updateProductError.message);
  }

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
    throw new Error('Cuenta invÃ¡lida.');
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
    throw new Error('Cuenta invÃ¡lida.');
  }

  const { error } = await supabase
    .from('money_accounts')
    .update({ is_active: input.nextIsActive })
    .eq('id', accountId);

  if (error) throw new Error(error.message);
  revalidatePath('/app/master/dashboard');
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

  const { error } = await supabase.from('clients').insert({
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
  });

  if (error) throw new Error(error.message);
  revalidatePath('/app/master/dashboard');
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
    throw new Error('Cliente inválido.');
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
    throw new Error('Cliente inválido.');
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
}) {
  const supabase = await createSupabaseServer();

  const sku = String(input.sku || '').trim().toUpperCase();
  const name = String(input.name || '').trim();
  const sourcePriceAmount = Number(input.sourcePriceAmount || 0);
  const unitsPerService = Number(input.unitsPerService || 0);
  const detailUnitsLimit = Number(input.detailUnitsLimit || 0);

  if (!sku) throw new Error('El SKU es obligatorio.');
  if (!name) throw new Error('El nombre es obligatorio.');
  if (!['product', 'combo', 'service', 'promo', 'gambit'].includes(input.type)) {
    throw new Error('Tipo inválido.');
  }
  if (!['VES', 'USD'].includes(input.sourcePriceCurrency)) {
    throw new Error('Moneda inválida.');
  }
  if (!Number.isFinite(sourcePriceAmount) || sourcePriceAmount < 0) {
    throw new Error('El monto fuente es inválido.');
  }
  if (!Number.isFinite(unitsPerService) || unitsPerService < 0) {
    throw new Error('Und/servicio inválido.');
  }
  if (!Number.isFinite(detailUnitsLimit) || detailUnitsLimit < 0) {
    throw new Error('Límite de detalle inválido.');
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
    throw new Error('No hay una tasa activa válida.');
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
    })
    .select('id')
    .single();

  if (error) throw new Error(error.message);

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

export async function deleteCatalogItemAction(input: {
  productId: number;
}) {
  const supabase = await createSupabaseServer();

  const productId = Number(input.productId);
  if (!Number.isFinite(productId) || productId <= 0) {
    throw new Error('Producto inválido.');
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
    throw new Error('No se puede eliminar: el producto ya fue usado en órdenes.');
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
    throw new Error('No se puede eliminar: el producto tiene composición cargada.');
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
    throw new Error('No se puede eliminar: el producto está siendo usado como componente de otro.');
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
    throw new Error('Hora inválida (1–12).');
  }

  if (!Number.isFinite(m) || m < 0 || m > 59) {
    throw new Error('Minutos inválidos (0–59).');
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

  throw new Error('No se pudo generar un número de orden único.');
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

  items: Array<{
    productId: number;
    skuSnapshot: string | null;
    productNameSnapshot: string;
    qty: number;
    sourcePriceCurrency: 'VES' | 'USD';
    sourcePriceAmount: number;
    unitPriceUsdSnapshot: number;
    lineTotalUsd: number;
    editableDetailLines: string[];
  }>;
}) {
  const { supabase, user, roles } = await requireMasterOrAdmin();

  const source = input.source;
  const fulfillment = input.fulfillment;

  if (!['advisor', 'master', 'walk_in'].includes(source)) {
    throw new Error('Source inválido.');
  }

  if (!['pickup', 'delivery'].includes(fulfillment)) {
    throw new Error('Fulfillment inválido.');
  }

  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw new Error('Debes agregar al menos un ítem.');
  }

  if (source === 'advisor' && !input.attributedAdvisorUserId) {
    throw new Error('Debes seleccionar un asesor.');
  }

  if (fulfillment === 'delivery' && !input.deliveryAddress.trim()) {
    throw new Error('La dirección es obligatoria para delivery.');
  }

  const deliveryTime24 = from12hTo24h(
    input.deliveryHour12,
    input.deliveryMinute,
    input.deliveryAmPm
  );

  const fxRate = Number(input.fxRate || 0);
  if (!Number.isFinite(fxRate) || fxRate <= 0) {
    throw new Error('La tasa de la orden es inválida.');
  }

  let clientId = input.selectedClientId;

  if (!clientId) {
    const fullName = String(input.newClientName || '').trim();
    const phone = normalizePhone(input.newClientPhone || '');

    if (!fullName) {
      throw new Error('Nombre del cliente es obligatorio.');
    }

    if (!phone) {
      throw new Error('Teléfono del cliente es obligatorio.');
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

  const { data: clientProfile, error: clientProfileError } = await supabase
    .from('clients')
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
      delivery_note_phone
    `)
    .eq('id', clientId)
    .maybeSingle();

  if (clientProfileError) {
    throw new Error(clientProfileError.message);
  }

  const attributedAdvisorId =
    source === 'advisor' ? input.attributedAdvisorUserId : user.id;

  if (!attributedAdvisorId) {
    throw new Error('No se pudo resolver el asesor atribuido.');
  }

  const fxRateNumber = Math.max(0, Number(input.fxRate || 0));

  const subtotalBs = input.items.reduce((sum, item) => {
    const lineBs =
      item.sourcePriceCurrency === 'VES'
        ? Number(item.sourcePriceAmount || 0) * Number(item.qty || 0)
        : Number(item.lineTotalUsd || 0) * fxRateNumber;

    return sum + lineBs;
  }, 0);

  const subtotalUsd = input.items.reduce((sum, item) => {
    const lineUsd =
      item.sourcePriceCurrency === 'VES'
        ? fxRateNumber > 0
          ? (Number(item.sourcePriceAmount || 0) * Number(item.qty || 0)) / fxRateNumber
          : 0
        : Number(item.lineTotalUsd || 0);

    return sum + lineUsd;
  }, 0);

  const discountPctNumber = Math.max(
    0,
    Math.min(100, Number(input.discountPct || 0))
  );

  const discountAmountBs = input.discountEnabled
    ? subtotalBs * (discountPctNumber / 100)
    : 0;

  const totalBs = Math.max(0, subtotalBs - discountAmountBs);

  const discountAmountUsd =
    fxRateNumber > 0 ? discountAmountBs / fxRateNumber : 0;

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
      subtotal_bs: subtotalBs,
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
      total_bs_snapshot: totalUsd * fxRate,
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

  const itemsPayload = input.items.map((item) => ({
    order_id: orderId,
    product_id: item.productId,
    qty: Number(item.qty || 0),
    pricing_origin_currency: item.sourcePriceCurrency,
    pricing_origin_amount: Number(item.sourcePriceAmount || 0),
    unit_price_usd_snapshot: Number(item.unitPriceUsdSnapshot || 0),
    line_total_usd: Number(item.lineTotalUsd || 0),
    unit_price_bs_snapshot:
      item.sourcePriceCurrency === 'VES'
        ? Number(item.sourcePriceAmount || 0)
        : Number(item.unitPriceUsdSnapshot || 0) * fxRateNumber,
    line_total_bs_snapshot:
      item.sourcePriceCurrency === 'VES'
        ? Number(item.sourcePriceAmount || 0) * Number(item.qty || 0)
        : Number(item.lineTotalUsd || 0) * fxRateNumber,
    sku_snapshot: item.skuSnapshot,
    product_name_snapshot: item.productNameSnapshot,
    notes:
      item.editableDetailLines && item.editableDetailLines.length > 0
        ? item.editableDetailLines.join('\n')
        : null,
  }));

  const { error: itemsError } = await supabase
    .from('order_items')
    .insert(itemsPayload);

  if (itemsError) {
    throw new Error(itemsError.message);
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

  items: Array<{
    productId: number;
    skuSnapshot: string | null;
    productNameSnapshot: string;
    qty: number;
    sourcePriceCurrency: 'VES' | 'USD';
    sourcePriceAmount: number;
    unitPriceUsdSnapshot: number;
    lineTotalUsd: number;
    editableDetailLines: string[];
  }>;
}) {
  const { supabase, user } = await requireMasterOrAdmin();

  const orderId = Number(input.orderId);
  if (!Number.isFinite(orderId) || orderId <= 0) {
    throw new Error('Orden inválida.');
  }

  const source = input.source;
  const fulfillment = input.fulfillment;

  if (!['advisor', 'master', 'walk_in'].includes(source)) {
    throw new Error('Source inválido.');
  }

  if (!['pickup', 'delivery'].includes(fulfillment)) {
    throw new Error('Fulfillment inválido.');
  }

  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw new Error('Debes agregar al menos un ítem.');
  }

  if (source === 'advisor' && !input.attributedAdvisorUserId) {
    throw new Error('Debes seleccionar un asesor.');
  }

  if (fulfillment === 'delivery' && !input.deliveryAddress.trim()) {
    throw new Error('La dirección es obligatoria para delivery.');
  }

  const { data: currentOrder, error: currentOrderError } = await supabase
    .from('orders')
    .select('id, status')
    .eq('id', orderId)
    .single();

  if (currentOrderError || !currentOrder) {
    throw new Error(currentOrderError?.message || 'No se pudo cargar la orden.');
  }

  if (!['created', 'queued'].includes(currentOrder.status)) {
    throw new Error('Solo se pueden editar órdenes en estado created o queued.');
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
      throw new Error('Teléfono del cliente es obligatorio.');
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

  const { data: clientProfile, error: clientProfileError } = await supabase
    .from('clients')
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
      delivery_note_phone
    `)
    .eq('id', clientId)
    .maybeSingle();

  if (clientProfileError) {
    throw new Error(clientProfileError.message);
  }

  const attributedAdvisorId =
    source === 'advisor' ? input.attributedAdvisorUserId : user.id;

  if (!attributedAdvisorId) {
    throw new Error('No se pudo resolver el asesor atribuido.');
  }

  const fxRateNumber = Math.max(0, Number(input.fxRate || 0));

  const subtotalBs = input.items.reduce((sum, item) => {
    const lineBs =
      item.sourcePriceCurrency === 'VES'
        ? Number(item.sourcePriceAmount || 0) * Number(item.qty || 0)
        : Number(item.lineTotalUsd || 0) * fxRateNumber;

    return sum + lineBs;
  }, 0);

  const subtotalUsd = input.items.reduce((sum, item) => {
    const lineUsd =
      item.sourcePriceCurrency === 'VES'
        ? fxRateNumber > 0
          ? (Number(item.sourcePriceAmount || 0) * Number(item.qty || 0)) / fxRateNumber
          : 0
        : Number(item.lineTotalUsd || 0);

    return sum + lineUsd;
  }, 0);

  const discountPctNumber = Math.max(
    0,
    Math.min(100, Number(input.discountPct || 0))
  );

  const discountAmountBs = input.discountEnabled
    ? subtotalBs * (discountPctNumber / 100)
    : 0;

  const totalBs = Math.max(0, subtotalBs - discountAmountBs);

  const discountAmountUsd =
    fxRateNumber > 0 ? discountAmountBs / fxRateNumber : 0;

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
      subtotal_bs: subtotalBs,
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

  const itemsPayload = input.items.map((item) => ({
    order_id: orderId,
    product_id: item.productId,
    qty: Number(item.qty || 0),
    pricing_origin_currency: item.sourcePriceCurrency,
    pricing_origin_amount: Number(item.sourcePriceAmount || 0),
    unit_price_usd_snapshot: Number(item.unitPriceUsdSnapshot || 0),
    line_total_usd: Number(item.lineTotalUsd || 0),
    unit_price_bs_snapshot:
      item.sourcePriceCurrency === 'VES'
        ? Number(item.sourcePriceAmount || 0)
        : Number(item.unitPriceUsdSnapshot || 0) * fxRateNumber,
    line_total_bs_snapshot:
      item.sourcePriceCurrency === 'VES'
        ? Number(item.sourcePriceAmount || 0) * Number(item.qty || 0)
        : Number(item.lineTotalUsd || 0) * fxRateNumber,
    sku_snapshot: item.skuSnapshot,
    product_name_snapshot: item.productNameSnapshot,
    notes:
      item.editableDetailLines && item.editableDetailLines.length > 0
        ? item.editableDetailLines.join('\n')
        : null,
  }));

  const { error: insertItemsError } = await supabase
    .from('order_items')
    .insert(itemsPayload);

  if (insertItemsError) {
    throw new Error(insertItemsError.message);
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
