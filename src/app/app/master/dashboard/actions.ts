'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { createSupabaseServer } from '@/lib/supabase/server';
import { requireMasterOrAdminContext } from '@/lib/auth';
import { sendPushToAdvisorDevices } from '@/lib/push';

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

const ORDER_ROUNDING_CLOSE_MAX_USD = 1;

type NotificationRole = 'admin' | 'master' | 'advisor' | 'kitchen' | 'driver';
type OrderEventSeverity = 'info' | 'warning' | 'critical';
type AppUserRole = 'admin' | 'master' | 'advisor' | 'kitchen' | 'driver';

const APP_USER_ROLES = new Set<AppUserRole>(['admin', 'master', 'advisor', 'kitchen', 'driver']);

function normalizeUserRoles(input: unknown): AppUserRole[] {
  if (!Array.isArray(input)) return [];

  const seen = new Set<AppUserRole>();
  for (const value of input) {
    if (typeof value !== 'string') continue;
    if (!APP_USER_ROLES.has(value as AppUserRole)) continue;
    seen.add(value as AppUserRole);
  }

  return Array.from(seen);
}

type OrderEventContext = {
  orderId: number;
  orderNumber: string | null;
  advisorUserId: string | null;
  internalDriverUserId: string | null;
  fulfillment: 'pickup' | 'delivery' | null;
  status: string | null;
  clientName: string | null;
};

type OrderEventRecipientInput = {
  targetRole?: NotificationRole | null;
  targetUserId?: string | null;
  requiresAction?: boolean;
};

export async function updateDashboardUserAction(input: {
  userId: string;
  fullName: string;
  isActive: boolean;
  roles: AppUserRole[];
}) {
  const { supabase, user } = await requireMasterOrAdmin();

  const userId = String(input.userId || '').trim();
  if (!userId) {
    throw new Error('Usuario inválido.');
  }

  const nextRoles = normalizeUserRoles(input.roles);
  if (nextRoles.length === 0) {
    throw new Error('Selecciona al menos un rol.');
  }

  if (userId === user.id && !nextRoles.some((role) => role === 'admin' || role === 'master')) {
    throw new Error('No puedes quitarte tu propio acceso al dashboard master.');
  }

  const fullName = String(input.fullName || '').trim();

  const { error: profileError } = await supabase
    .from('profiles')
    .update({
      full_name: fullName || null,
      is_active: Boolean(input.isActive),
    })
    .eq('id', userId);

  if (profileError) throw new Error(profileError.message);

  const { error: deleteRolesError } = await supabase.from('user_roles').delete().eq('user_id', userId);
  if (deleteRolesError) throw new Error(deleteRolesError.message);

  const { error: insertRolesError } = await supabase
    .from('user_roles')
    .insert(nextRoles.map((role) => ({ user_id: userId, role })));

  if (insertRolesError) throw new Error(insertRolesError.message);

  revalidatePath('/app/master/dashboard');
}

async function loadOrderEventContext(
  supabase: Awaited<ReturnType<typeof createSupabaseServer>>,
  orderId: number,
): Promise<OrderEventContext | null> {
  const { data, error } = await supabase
    .from('orders')
    .select('id, order_number, attributed_advisor_id, internal_driver_user_id, fulfillment, status, client:clients!orders_client_id_fkey(full_name)')
    .eq('id', orderId)
    .maybeSingle();

  if (error || !data) {
    return null;
  }

  const client = Array.isArray(data.client) ? data.client[0] ?? null : data.client;

  return {
    orderId: Number(data.id),
    orderNumber: data.order_number == null ? null : String(data.order_number),
    advisorUserId: data.attributed_advisor_id ?? null,
    internalDriverUserId: data.internal_driver_user_id ?? null,
    fulfillment:
      data.fulfillment === 'pickup' || data.fulfillment === 'delivery' ? data.fulfillment : null,
    status: data.status == null ? null : String(data.status),
    clientName: client?.full_name == null ? null : String(client.full_name),
  };
}

function dedupeEventRecipients(recipients: OrderEventRecipientInput[]) {
  const seen = new Set<string>();
  const out: Array<{
    target_role: NotificationRole | null;
    target_user_id: string | null;
    requires_action: boolean;
  }> = [];

  for (const recipient of recipients) {
    const targetRole = recipient.targetRole ?? null;
    const targetUserId = recipient.targetUserId ?? null;

    if (!targetRole && !targetUserId) continue;

    const key = `${targetRole ?? ''}|${targetUserId ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({
      target_role: targetRole,
      target_user_id: targetUserId,
      requires_action: !!recipient.requiresAction,
    });
  }

  return out;
}

function getAdvisorPushTargets(params: {
  contextAdvisorUserId?: string | null;
  recipients?: OrderEventRecipientInput[];
}) {
  const ids = new Set<string>();

  const contextAdvisorUserId = String(params.contextAdvisorUserId || '').trim();
  if (contextAdvisorUserId) ids.add(contextAdvisorUserId);

  for (const recipient of params.recipients ?? []) {
    const targetUserId = String(recipient.targetUserId || '').trim();
    const targetRole = String(recipient.targetRole || '').trim();

    if (targetUserId) {
      ids.add(targetUserId);
      continue;
    }

    if (targetRole === 'advisor' && contextAdvisorUserId) {
      ids.add(contextAdvisorUserId);
    }
  }

  return Array.from(ids);
}

async function appendOrderEvent(
  supabase: Awaited<ReturnType<typeof createSupabaseServer>>,
  input: {
    orderId: number;
    eventType: string;
    eventGroup: string;
    title: string;
    message?: string | null;
    severity?: OrderEventSeverity;
    actorUserId?: string | null;
    payload?: Record<string, unknown>;
    context?: OrderEventContext | null;
    recipients?: OrderEventRecipientInput[];
  },
) {
  try {
    const context = input.context ?? (await loadOrderEventContext(supabase, input.orderId));

    const { data: insertedEvent, error: insertEventError } = await supabase
      .from('order_timeline_events')
      .insert({
        order_id: input.orderId,
        order_number: context?.orderNumber ?? null,
        event_type: input.eventType,
        event_group: input.eventGroup,
        title: input.title,
        message: input.message ?? null,
        severity: input.severity ?? 'info',
        actor_user_id: input.actorUserId ?? null,
        payload: input.payload ?? {},
      })
      .select('id')
      .single();

    if (insertEventError || !insertedEvent) {
      console.warn('appendOrderEvent skipped', insertEventError?.message ?? 'unknown insert error');
      return;
    }

    const recipientRows = dedupeEventRecipients(input.recipients ?? []).map((recipient) => ({
      event_id: insertedEvent.id,
      target_role: recipient.target_role,
      target_user_id: recipient.target_user_id,
      requires_action: recipient.requires_action,
    }));

    if (recipientRows.length === 0) return;

    const { error: recipientsError } = await supabase
      .from('order_timeline_event_recipients')
      .insert(recipientRows);

    if (recipientsError) {
      console.warn('appendOrderEvent recipients skipped', recipientsError.message);
    }

    const advisorPushTargets = getAdvisorPushTargets({
      contextAdvisorUserId: context?.advisorUserId,
      recipients: input.recipients,
    });

    if (advisorPushTargets.length > 0) {
      for (const advisorUserId of advisorPushTargets) {
        try {
          await sendPushToAdvisorDevices({
            advisorUserId,
            orderId: input.orderId,
            eventType: input.eventType,
            title: input.title,
            body: input.message,
            orderNumber: context?.orderNumber,
            clientName: context?.clientName,
            payload: input.payload,
            tag: `advisor-order-${input.orderId}-${input.eventType}`,
          });
        } catch (pushError) {
          console.warn(
            'appendOrderEvent push skipped',
            pushError instanceof Error ? pushError.message : 'unknown push error',
          );
        }
      }
    }
  } catch (error) {
    console.warn(
      'appendOrderEvent failed',
      error instanceof Error ? error.message : 'unknown order event error',
    );
  }
}

function getChangeSectionsSummary(params: {
  changedFields: string[];
  itemsChanged: boolean;
}): { sections: string[]; summary: string[] } {
  const sectionSet = new Set<string>();
  const summary: string[] = [];

  if (params.itemsChanged) {
    sectionSet.add('pedido');
    summary.push('Se modificó el pedido.');
  }

  for (const field of params.changedFields) {
    if (field === 'client_id') {
      sectionSet.add('cliente');
      summary.push('Se cambió el cliente.');
      continue;
    }
    if (field === 'attributed_advisor_id') {
      sectionSet.add('cliente');
      summary.push('Se cambió el asesor.');
      continue;
    }
    if (field === 'fulfillment') {
      sectionSet.add('entrega');
      summary.push('Se cambió el tipo de entrega.');
      continue;
    }
    if (field === 'delivery_address') {
      sectionSet.add('direccion');
      summary.push('Se cambió la dirección.');
      continue;
    }
    if (field === 'receiver_name' || field === 'receiver_phone') {
      sectionSet.add('entrega');
      summary.push('Se cambiaron datos del receptor.');
      continue;
    }
    if (field === 'notes') {
      sectionSet.add('nota');
      summary.push('Se modificó la nota de la orden.');
      continue;
    }
    if (field === 'source') {
      sectionSet.add('cliente');
      summary.push('Se cambió el origen de la orden.');
      continue;
    }
    if (field === 'total_usd' || field === 'total_bs_snapshot') {
      sectionSet.add('precio');
      summary.push('Se modificó el total de la orden.');
      continue;
    }
    if (field === 'extra_fields') {
      sectionSet.add('entrega');
      summary.push('Se cambiaron datos de entrega, pago o configuración.');
    }
  }

  return {
    sections: Array.from(sectionSet),
    summary: Array.from(new Set(summary)),
  };
}

function toUsdEquivalentByCurrency(
  amount: number,
  currency: string,
  exchangeRateVesPerUsd: number | null
) {
  if (String(currency || '').toUpperCase() === 'VES') {
    const rate = toSafeNumber(exchangeRateVesPerUsd, 0);
    if (rate <= 0) {
      throw new Error('La tasa es obligatoria para montos en VES.');
    }
    return amount / rate;
  }

  return amount;
}

function toNativeAmountFromUsd(
  amountUsd: number,
  currency: string,
  exchangeRateVesPerUsd: number | null
) {
  if (String(currency || '').toUpperCase() === 'VES') {
    const rate = toSafeNumber(exchangeRateVesPerUsd, 0);
    if (rate <= 0) {
      throw new Error('La tasa es obligatoria para montos en VES.');
    }
    return Number((amountUsd * rate).toFixed(2));
  }

  return Number(amountUsd.toFixed(2));
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
    inventoryGroup: 'raw' | 'fried' | 'prefried' | 'sauces' | 'packaging' | 'other';
  }
) {
  if (!input.inventoryEnabled || !input.isInventoryItem || input.inventoryDeductionMode !== 'self') {
    return null;
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
    inventory_group: input.inventoryGroup,
    is_active: !!input.isActive,
  };

  if (matchedItem) {
    const { error } = await supabase
      .from('inventory_items')
      .update(payload)
      .eq('id', Number(matchedItem.id));

    if (error) throw new Error(error.message);
    return Number(matchedItem.id);
  }

  const { data, error } = await supabase
    .from('inventory_items')
    .insert(payload)
    .select('id')
    .single();
  if (error) throw new Error(error.message);
  return Number(data.id);
}

async function applyClientFundToOrder(
  supabase: Awaited<ReturnType<typeof createSupabaseServer>>,
  input: {
    clientId: number;
    orderId: number;
    amountUsd: number;
    userId: string;
    notes?: string | null;
  }
) {
  const amountUsd = Number(input.amountUsd || 0);
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) return;

  const { data: currentClient, error: currentClientError } = await supabase
    .from('clients')
    .select('id, fund_balance_usd')
    .eq('id', input.clientId)
    .single();

  if (currentClientError || !currentClient) {
    throw new Error(currentClientError?.message || 'No se pudo cargar el fondo del cliente.');
  }

  const currentBalance = Number(toSafeNumber(currentClient.fund_balance_usd, 0).toFixed(2));
  const nextAmountUsd = Number(amountUsd.toFixed(2));

  if (nextAmountUsd > currentBalance + 0.0001) {
    throw new Error('El cliente no tiene suficiente fondo disponible.');
  }

  const { error: updateClientError } = await supabase
    .from('clients')
    .update({
      fund_balance_usd: Number((currentBalance - nextAmountUsd).toFixed(2)),
    })
    .eq('id', input.clientId);

  if (updateClientError) {
    throw new Error(updateClientError.message);
  }

  const { error: fundMovementError } = await supabase
    .from('client_fund_movements')
    .insert({
      client_id: input.clientId,
      movement_type: 'debit',
      currency_code: 'USD',
      amount: nextAmountUsd,
      amount_usd: nextAmountUsd,
      money_account_id: null,
      order_id: input.orderId,
      payment_report_id: null,
      reason_code: 'order_fund_applied',
      notes: String(input.notes || '').trim() || null,
      created_by_user_id: input.userId,
    });

  if (fundMovementError) {
    throw new Error(fundMovementError.message);
  }
}

async function restoreClientFundToOrder(
  supabase: Awaited<ReturnType<typeof createSupabaseServer>>,
  input: {
    clientId: number;
    orderId: number;
    amountUsd: number;
    userId: string;
    notes?: string | null;
  }
) {
  const amountUsd = Number(input.amountUsd || 0);
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) return;

  const { data: currentClient, error: currentClientError } = await supabase
    .from('clients')
    .select('id, fund_balance_usd')
    .eq('id', input.clientId)
    .single();

  if (currentClientError || !currentClient) {
    throw new Error(currentClientError?.message || 'No se pudo restaurar el fondo del cliente.');
  }

  const currentBalance = Number(toSafeNumber(currentClient.fund_balance_usd, 0).toFixed(2));
  const nextAmountUsd = Number(amountUsd.toFixed(2));

  const { error: updateClientError } = await supabase
    .from('clients')
    .update({
      fund_balance_usd: Number((currentBalance + nextAmountUsd).toFixed(2)),
    })
    .eq('id', input.clientId);

  if (updateClientError) {
    throw new Error(updateClientError.message);
  }

  const { error: fundMovementError } = await supabase
    .from('client_fund_movements')
    .insert({
      client_id: input.clientId,
      movement_type: 'credit',
      currency_code: 'USD',
      amount: nextAmountUsd,
      amount_usd: nextAmountUsd,
      money_account_id: null,
      order_id: input.orderId,
      payment_report_id: null,
      reason_code: 'order_fund_restore',
      notes: String(input.notes || '').trim() || null,
      created_by_user_id: input.userId,
    });

  if (fundMovementError) {
    throw new Error(fundMovementError.message);
  }
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
  const { supabase, user } = await requireMasterOrAdmin();

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
  const eventContext = await loadOrderEventContext(supabase, input.orderId);
  await appendOrderEvent(supabase, {
    orderId: input.orderId,
    context: eventContext,
    eventType: 'payment_reported',
    eventGroup: 'payment',
    title: 'Pago reportado',
    message: 'Se registro un nuevo reporte de pago.',
    severity: 'warning',
    actorUserId: user.id,
    payload: {
      reported_money_account_id: input.reportedMoneyAccountId,
      reported_currency: input.reportedCurrency,
      reported_amount: input.reportedAmount,
      exchange_rate_ves_per_usd: input.reportedExchangeRateVesPerUsd,
      reference_code: input.referenceCode,
      payer_name: input.payerName,
    },
    recipients: [
      { targetRole: 'master', requiresAction: true },
      { targetRole: 'admin', requiresAction: true },
      { targetUserId: eventContext?.advisorUserId },
    ],
  });
  revalidatePath('/app/master/dashboard');
}

export async function confirmPaymentReportAction(input: {
  reportId: number;
  orderId?: number | null;
  clientId?: number | null;
  confirmedMoneyAccountId: number;
  confirmedCurrency: string;
  confirmedAmount: number;
  movementDate: string;
  confirmedExchangeRateVesPerUsd: number | null;
  reviewNotes: string;
  referenceCode: string | null;
  counterpartyName: string | null;
  description: string | null;
  overpaymentHandling?: 'change_given' | 'store_fund' | 'close_difference' | null;
  overpaymentNotes?: string | null;
  changeMoneyAccountId?: number | null;
  changeCurrency?: string | null;
  changeAmount?: number | null;
  changeExchangeRateVesPerUsd?: number | null;
}) {
  const { supabase, user, roles } = await requireMasterOrAdmin();

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

  const orderId = Number(input.orderId || 0);
  if (Number.isFinite(orderId) && orderId > 0) {
    const eventContext = await loadOrderEventContext(supabase, orderId);
    const { data: currentOrder, error: currentOrderError } = await supabase
      .from('orders')
      .select('id, client_id, total_usd, total_bs_snapshot, extra_fields')
      .eq('id', orderId)
      .single();

    if (currentOrderError || !currentOrder) {
      throw new Error(currentOrderError?.message || 'No se pudo recalcular el saldo de la orden.');
    }

    const { data: orderMovements, error: orderMovementsError } = await supabase
      .from('money_movements')
      .select('direction, amount_usd_equivalent')
      .eq('order_id', orderId);

    if (orderMovementsError) {
      throw new Error(orderMovementsError.message);
    }

    const confirmedPaidUsd = (orderMovements ?? []).reduce((sum, row) => {
      const signedAmount =
        toSafeNumber(row.amount_usd_equivalent, 0) *
        (row.direction === 'outflow' ? -1 : 1);
      return sum + signedAmount;
    }, 0);

    const currentTotalUsd = toSafeNumber(currentOrder.total_usd, 0);
    const currentTotalBs = toSafeNumber(currentOrder.total_bs_snapshot, 0);
    const excessUsd = Number(Math.max(0, confirmedPaidUsd - currentTotalUsd).toFixed(2));
    const handling = input.overpaymentHandling ?? (excessUsd > 0.005 ? 'store_fund' : null);
    const notes = String(input.overpaymentNotes || '').trim() || null;

    if (excessUsd > 0.005 && handling === 'change_given') {
      const changeMoneyAccountId = Number(input.changeMoneyAccountId || 0);
      if (!Number.isFinite(changeMoneyAccountId) || changeMoneyAccountId <= 0) {
        throw new Error('Debes seleccionar la cuenta desde la cual se dará el cambio.');
      }

      const changeCurrency = String(input.changeCurrency || '').trim().toUpperCase();
      if (!changeCurrency) {
        throw new Error('No se pudo determinar la moneda del cambio.');
      }

      const changeAmount =
        input.changeAmount != null && Number.isFinite(Number(input.changeAmount))
          ? Number(Number(input.changeAmount).toFixed(2))
          : toNativeAmountFromUsd(
              excessUsd,
              changeCurrency,
              input.changeExchangeRateVesPerUsd ?? null
            );

      if (!Number.isFinite(changeAmount) || changeAmount <= 0) {
        throw new Error('El monto del cambio no es válido.');
      }

      const { error: changeMovementError } = await supabase
        .from('money_movements')
        .insert({
          movement_date: input.movementDate,
          created_by_user_id: user.id,
          confirmed_at: new Date().toISOString(),
          confirmed_by_user_id: user.id,
          direction: 'outflow',
          movement_type: 'change_given',
          money_account_id: changeMoneyAccountId,
          currency_code: changeCurrency,
          amount: changeAmount,
          exchange_rate_ves_per_usd:
            changeCurrency === 'VES'
              ? input.changeExchangeRateVesPerUsd ?? null
              : null,
          amount_usd_equivalent: excessUsd,
          reference_code: input.referenceCode,
          counterparty_name: input.counterpartyName,
          description:
            input.description
              ? `${input.description} · cambio entregado`
              : `Cambio entregado · orden ${orderId} · reporte ${input.reportId}`,
          notes,
          order_id: orderId,
          payment_report_id: null,
          movement_group_id: null,
        });

      if (changeMovementError) {
        throw new Error(changeMovementError.message);
      }
    }

    if (excessUsd > 0.005 && handling === 'store_fund') {
      const clientId = Number(input.clientId || currentOrder.client_id || 0);
      if (!Number.isFinite(clientId) || clientId <= 0) {
        throw new Error('La orden no tiene un cliente válido para guardar el fondo.');
      }

      const nativeAmount = toNativeAmountFromUsd(
        excessUsd,
        input.confirmedCurrency,
        input.confirmedExchangeRateVesPerUsd
      );

      const { data: currentClient, error: currentClientError } = await supabase
        .from('clients')
        .select('id, fund_balance_usd')
        .eq('id', clientId)
        .single();

      if (currentClientError || !currentClient) {
        throw new Error(currentClientError?.message || 'No se pudo cargar el fondo del cliente.');
      }

      const { error: updateClientFundError } = await supabase
        .from('clients')
        .update({
          fund_balance_usd: Number((toSafeNumber(currentClient.fund_balance_usd, 0) + excessUsd).toFixed(2)),
        })
        .eq('id', clientId);

      if (updateClientFundError) {
        throw new Error(updateClientFundError.message);
      }

      const { error: fundMovementError } = await supabase
        .from('client_fund_movements')
        .insert({
          client_id: clientId,
          movement_type: 'credit',
          currency_code: input.confirmedCurrency,
          amount: nativeAmount,
          amount_usd: excessUsd,
          money_account_id: input.confirmedMoneyAccountId,
          order_id: orderId,
          payment_report_id: input.reportId,
          reason_code: 'payment_overage_stored',
          notes,
          created_by_user_id: user.id,
        });

      if (fundMovementError) {
        throw new Error(fundMovementError.message);
      }
    }

    if (excessUsd > 0.005 && handling === 'close_difference') {
      if (!roles.includes('admin')) {
        throw new Error('Solo admin puede cerrar excedentes por redondeo.');
      }

      if (excessUsd > ORDER_ROUNDING_CLOSE_MAX_USD) {
        throw new Error(
          `Solo se pueden cerrar diferencias de hasta ${ORDER_ROUNDING_CLOSE_MAX_USD.toFixed(2)} USD.`
        );
      }

      const extraFields =
        currentOrder.extra_fields &&
        typeof currentOrder.extra_fields === 'object' &&
        !Array.isArray(currentOrder.extra_fields)
          ? ({ ...currentOrder.extra_fields } as Record<string, any>)
          : {};

      const pricing =
        extraFields.pricing && typeof extraFields.pricing === 'object' && !Array.isArray(extraFields.pricing)
          ? { ...extraFields.pricing }
          : {};

      const payment =
        extraFields.payment && typeof extraFields.payment === 'object' && !Array.isArray(extraFields.payment)
          ? { ...extraFields.payment }
          : {};

      const fxRate = toSafeNumber(pricing.fx_rate, 0);
      const nextTotalUsd = Number(confirmedPaidUsd.toFixed(2));
      const nextTotalBs =
        fxRate > 0
          ? Number((nextTotalUsd * fxRate).toFixed(2))
          : currentTotalUsd > 0
            ? Number(((currentTotalBs / currentTotalUsd) * nextTotalUsd).toFixed(2))
            : currentTotalBs;

      pricing.total_usd = nextTotalUsd;
      pricing.total_bs = nextTotalBs;
      pricing.rounding_gain_closed_usd = excessUsd;
      pricing.rounding_gain_close_applied_at = new Date().toISOString();
      pricing.rounding_gain_close_applied_by = user.id;

      payment.rounding_gain_close = {
        closed_balance_usd: excessUsd,
        previous_total_usd: Number(currentTotalUsd.toFixed(2)),
        next_total_usd: nextTotalUsd,
        applied_at: new Date().toISOString(),
        applied_by: user.id,
        notes,
      };

      extraFields.pricing = pricing;
      extraFields.payment = payment;

      const { error: updateOrderError } = await supabase
        .from('orders')
        .update({
          total_usd: nextTotalUsd,
          total_bs_snapshot: nextTotalBs,
          extra_fields: extraFields,
          last_modified_at: new Date().toISOString(),
          last_modified_by: user.id,
        })
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
          reason: 'Cierre de excedente por redondeo',
          notes,
          payload: {
            kind: 'rounding_gain_close',
            delta_usd: excessUsd,
            original_unit_price_usd: Number(currentTotalUsd.toFixed(2)),
            override_unit_price_usd: nextTotalUsd,
            product_name: 'Cierre por redondeo',
            qty: 1,
            closed_balance_usd: excessUsd,
            previous_total_usd: Number(currentTotalUsd.toFixed(2)),
            previous_total_bs: Number(currentTotalBs.toFixed(2)),
            confirmed_paid_usd: Number(confirmedPaidUsd.toFixed(2)),
            next_total_usd: nextTotalUsd,
            next_total_bs: nextTotalBs,
            payment_report_id: input.reportId,
          },
          created_by_user_id: user.id,
        });

      if (adjustmentError) {
        throw new Error(adjustmentError.message);
      }
    }

    await appendOrderEvent(supabase, {
      orderId,
      context: eventContext,
      eventType: 'payment_confirmed',
      eventGroup: 'payment',
      title: 'Pago confirmado',
      message: 'El pago reportado fue confirmado.',
      severity: 'info',
      actorUserId: user.id,
      payload: {
        report_id: input.reportId,
        confirmed_money_account_id: input.confirmedMoneyAccountId,
        confirmed_currency: input.confirmedCurrency,
        confirmed_amount: input.confirmedAmount,
        movement_date: input.movementDate,
        exchange_rate_ves_per_usd: input.confirmedExchangeRateVesPerUsd,
      },
      recipients: [
        { targetRole: 'master' },
        { targetUserId: eventContext?.advisorUserId },
      ],
    });
  }

  revalidatePath('/app/master/dashboard');
}

export async function applyClientFundPaymentAction(input: {
  orderId: number;
  amountUsd: number;
  notes?: string | null;
}) {
  const { supabase, user } = await requireMasterOrAdmin();

  const orderId = Number(input.orderId || 0);
  const requestedAmountUsd = Number(toSafeNumber(input.amountUsd, 0).toFixed(2));

  if (!Number.isFinite(orderId) || orderId <= 0) {
    throw new Error('Orden inválida.');
  }

  if (!Number.isFinite(requestedAmountUsd) || requestedAmountUsd <= 0) {
    throw new Error('El monto del fondo no es válido.');
  }

  const { data: currentOrder, error: currentOrderError } = await supabase
    .from('orders')
    .select('id, client_id, total_usd, extra_fields')
    .eq('id', orderId)
    .single();

  if (currentOrderError || !currentOrder) {
    throw new Error(currentOrderError?.message || 'No se pudo cargar la orden.');
  }

  const clientId = Number(currentOrder.client_id || 0);
  if (!Number.isFinite(clientId) || clientId <= 0) {
    throw new Error('La orden no tiene cliente asociado.');
  }

  const totalUsd = Number(toSafeNumber(currentOrder.total_usd, 0).toFixed(2));
  const previousFundUsedUsd = Number(
    toSafeNumber((currentOrder.extra_fields as any)?.payment?.client_fund_used_usd, 0).toFixed(2)
  );

  const { data: orderMovements, error: orderMovementsError } = await supabase
    .from('money_movements')
    .select('direction, amount_usd_equivalent')
    .eq('order_id', orderId);

  if (orderMovementsError) {
    throw new Error(orderMovementsError.message);
  }

  const confirmedPaidUsd = (orderMovements ?? []).reduce((sum, row) => {
    const signedAmount =
      toSafeNumber(
        (row as { amount_usd_equivalent?: number | string | null }).amount_usd_equivalent,
        0
      ) * (((row as { direction?: string | null }).direction ?? 'inflow') === 'outflow' ? -1 : 1);
    return sum + signedAmount;
  }, 0);

  const pendingUsd = Number(
    Math.max(0, totalUsd - confirmedPaidUsd - previousFundUsedUsd).toFixed(2)
  );

  if (pendingUsd <= 0.005) {
    throw new Error('Esta orden ya no tiene saldo pendiente.');
  }

  const applicableAmountUsd = Number(Math.min(requestedAmountUsd, pendingUsd).toFixed(2));

  if (applicableAmountUsd <= 0.005) {
    throw new Error('El monto del fondo no es aplicable a esta orden.');
  }

  await applyClientFundToOrder(supabase, {
    clientId,
    orderId,
    amountUsd: applicableAmountUsd,
    userId: user.id,
    notes: input.notes ?? 'Fondo aplicado desde pagos',
  });

  try {
    const nextExtraFields = {
      ...(currentOrder.extra_fields && typeof currentOrder.extra_fields === 'object'
        ? (currentOrder.extra_fields as Record<string, unknown>)
        : {}),
      payment: {
        ...(((currentOrder.extra_fields as any)?.payment ?? {}) as Record<string, unknown>),
        client_fund_used_usd: Number((previousFundUsedUsd + applicableAmountUsd).toFixed(2)),
      },
    };

    const { error: updateOrderError } = await supabase
      .from('orders')
      .update({
        extra_fields: nextExtraFields,
      })
      .eq('id', orderId);

    if (updateOrderError) {
      throw new Error(updateOrderError.message);
    }
  } catch (error) {
    await restoreClientFundToOrder(supabase, {
      clientId,
      orderId,
      amountUsd: applicableAmountUsd,
      userId: user.id,
      notes: 'Reverso por error aplicando fondo a la orden',
    });
    throw error;
  }

  revalidatePath('/app/master/dashboard');
}

export async function deliverClientFundChangeAction(input: {
  orderId: number;
  moneyAccountId: number;
  currencyCode: string;
  amount: number;
  exchangeRateVesPerUsd?: number | null;
  notes?: string | null;
}) {
  try {
    const { supabase, user } = await requireMasterOrAdmin();

    const orderId = Number(input.orderId || 0);
    const moneyAccountId = Number(input.moneyAccountId || 0);
    const nativeAmount = Number(toSafeNumber(input.amount, 0).toFixed(2));
    const currencyCode = String(input.currencyCode || '').trim().toUpperCase();
    const exchangeRate =
      input.exchangeRateVesPerUsd == null ? null : Number(toSafeNumber(input.exchangeRateVesPerUsd, 0).toFixed(6));

    if (!Number.isFinite(orderId) || orderId <= 0) throw new Error('Orden inválida.');
    if (!Number.isFinite(moneyAccountId) || moneyAccountId <= 0) throw new Error('Cuenta inválida.');
    if (!currencyCode) throw new Error('Moneda inválida.');
    if (!Number.isFinite(nativeAmount) || nativeAmount <= 0) throw new Error('Monto inválido.');
    if (currencyCode === 'VES' && (!exchangeRate || exchangeRate <= 0)) {
      throw new Error('Debes indicar una tasa válida para el cambio en Bs.');
    }

    const { data: currentOrder, error: currentOrderError } = await supabase
      .from('orders')
      .select('id, client_id')
      .eq('id', orderId)
      .single();

    if (currentOrderError || !currentOrder) {
      throw new Error(currentOrderError?.message || 'No se pudo cargar la orden.');
    }

    const clientId = Number(currentOrder.client_id || 0);
    if (!Number.isFinite(clientId) || clientId <= 0) {
      throw new Error('La orden no tiene cliente asociado.');
    }

    const { data: currentClient, error: currentClientError } = await supabase
      .from('clients')
      .select('id, fund_balance_usd')
      .eq('id', clientId)
      .single();

    if (currentClientError || !currentClient) {
      throw new Error(currentClientError?.message || 'No se pudo cargar el fondo del cliente.');
    }

    const amountUsd = Number(
      (currencyCode === 'VES' ? nativeAmount / Number(exchangeRate) : nativeAmount).toFixed(2)
    );
    const currentBalanceUsd = Number(toSafeNumber(currentClient.fund_balance_usd, 0).toFixed(2));

    if (amountUsd > currentBalanceUsd + 0.0001) {
      throw new Error('El cliente no tiene suficiente fondo para entregar ese cambio.');
    }

    const { error: updateClientError } = await supabase
      .from('clients')
      .update({
        fund_balance_usd: Number((currentBalanceUsd - amountUsd).toFixed(2)),
      })
      .eq('id', clientId);

    if (updateClientError) {
      throw new Error(updateClientError.message);
    }

    try {
      const { error: fundMovementError } = await supabase
        .from('client_fund_movements')
        .insert({
          client_id: clientId,
          movement_type: 'debit',
          currency_code: currencyCode,
          amount: nativeAmount,
          amount_usd: amountUsd,
          money_account_id: moneyAccountId,
          order_id: orderId,
          payment_report_id: null,
          reason_code: 'change_given_from_fund',
          notes: String(input.notes || '').trim() || null,
          created_by_user_id: user.id,
        });

      if (fundMovementError) {
        throw new Error(fundMovementError.message);
      }

      const { error: moneyMovementError } = await supabase
        .from('money_movements')
        .insert({
          movement_date: new Date().toISOString().slice(0, 10),
          created_by_user_id: user.id,
          confirmed_at: new Date().toISOString(),
          confirmed_by_user_id: user.id,
          direction: 'outflow',
          movement_type: 'change_given',
          money_account_id: moneyAccountId,
          currency_code: currencyCode,
          amount: nativeAmount,
          exchange_rate_ves_per_usd: currencyCode === 'VES' ? exchangeRate : null,
          amount_usd_equivalent: amountUsd,
          reference_code: null,
          counterparty_name: null,
          description: `Cambio entregado desde fondo · orden ${orderId}`,
          notes: String(input.notes || '').trim() || null,
          order_id: orderId,
          payment_report_id: null,
          movement_group_id: null,
        });

      if (moneyMovementError) {
        throw new Error(moneyMovementError.message);
      }
    } catch (error) {
      await supabase
        .from('clients')
        .update({
          fund_balance_usd: currentBalanceUsd,
        })
        .eq('id', clientId);
      throw error;
    }

    revalidatePath('/app/master/dashboard');
    return { ok: true as const };
  } catch (error) {
    return {
      ok: false as const,
      message: error instanceof Error ? error.message : 'Error entregando el cambio.',
    };
  }
}

export async function rejectPaymentReportAction(input: {
  reportId: number;
  reviewNotes: string;
}) {
  const { supabase, user } = await requireMasterOrAdmin();

  const { data: currentReport } = await supabase
    .from('payment_reports')
    .select('order_id')
    .eq('id', input.reportId)
    .maybeSingle();

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
  try {
    const { supabase, user } = await requireMasterOrAdmin();
    const eventContext = await loadOrderEventContext(supabase, input.orderId);

    const { error } = await supabase.rpc('approve_order', {
      p_order_id: input.orderId,
    });

    if (error) throw new Error(error.message);
    await appendOrderEvent(supabase, {
      orderId: input.orderId,
      context: eventContext,
      eventType: 'order_approved',
      eventGroup: 'approval',
      title: 'Orden aprobada',
      message: 'La orden fue aprobada y ya puede avanzar en operación.',
      severity: 'info',
      actorUserId: user.id,
      recipients: [
        { targetRole: 'master' },
        { targetUserId: eventContext?.advisorUserId },
      ],
    });
    revalidatePath('/app/master/dashboard');
    return { ok: true as const };
  } catch (error) {
    return {
      ok: false as const,
      message: error instanceof Error ? error.message : 'Error aprobando la orden.',
    };
  }
}

export async function reapproveQueuedOrderAction(input: {
  orderId: number;
  notes: string;
}) {
  try {
    const { supabase, user } = await requireMasterOrAdmin();
    const eventContext = await loadOrderEventContext(supabase, input.orderId);

    const { error } = await supabase.rpc('reapprove_queued_order', {
      p_order_id: input.orderId,
      p_notes: input.notes,
    });

    if (error) throw new Error(error.message);
    await appendOrderEvent(supabase, {
      orderId: input.orderId,
      context: eventContext,
      eventType: 'order_reapproved',
      eventGroup: 'approval',
      title: 'Orden re-aprobada',
      message: input.notes?.trim() ? `Notas de revisión: ${input.notes.trim()}` : 'La orden fue re-aprobada.',
      severity: 'info',
      actorUserId: user.id,
      payload: {
        review_notes: input.notes?.trim() || null,
      },
      recipients: [
        { targetRole: 'master' },
        { targetUserId: eventContext?.advisorUserId },
      ],
    });
    revalidatePath('/app/master/dashboard');
    return { ok: true as const };
  } catch (error) {
    return {
      ok: false as const,
      message: error instanceof Error ? error.message : 'Error re-aprobando la orden.',
    };
  }
}

export async function sendToKitchenAction(input: {
  orderId: number;
}) {
  try {
    const { supabase, user } = await requireMasterOrAdmin();
    const eventContext = await loadOrderEventContext(supabase, input.orderId);

    const { error } = await supabase.rpc('send_to_kitchen', {
      p_order_id: input.orderId,
    });

    if (error) throw new Error(error.message);
    await appendOrderEvent(supabase, {
      orderId: input.orderId,
      context: eventContext,
      eventType: 'order_sent_to_kitchen',
      eventGroup: 'kitchen',
      title: 'Enviada a cocina',
      message: 'La orden fue enviada a cocina.',
      severity: 'info',
      actorUserId: user.id,
      recipients: [
        { targetRole: 'kitchen', requiresAction: true },
        { targetRole: 'master' },
        { targetUserId: eventContext?.advisorUserId },
      ],
    });
    revalidatePath('/app/master/dashboard');
    return { ok: true as const };
  } catch (error) {
    return {
      ok: false as const,
      message: error instanceof Error ? error.message : 'Error enviando a cocina.',
    };
  }
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
    throw new Error('Solo se puede devolver una orden que está en cola.');
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

  const eventContext = await loadOrderEventContext(supabase, input.orderId);
  await appendOrderEvent(supabase, {
    orderId: input.orderId,
    context: eventContext,
    eventType: 'order_returned_to_review',
    eventGroup: 'approval',
    title: 'Orden devuelta a revisión',
    message: reason,
    severity: 'warning',
    actorUserId: user.id,
    payload: {
      reason,
    },
    recipients: [
      { targetRole: 'master' },
      { targetUserId: eventContext?.advisorUserId, requiresAction: true },
    ],
  });

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

  const eventContext = await loadOrderEventContext(supabase, orderId);
  await appendOrderEvent(supabase, {
    orderId,
    context: eventContext,
    eventType: 'order_cancelled',
    eventGroup: 'approval',
    title: 'Orden cancelada',
    message: reason,
    severity: 'critical',
    actorUserId: user.id,
    payload: { reason },
    recipients: [
      { targetRole: 'master' },
      { targetUserId: eventContext?.advisorUserId },
      { targetUserId: eventContext?.internalDriverUserId },
      { targetRole: 'kitchen' },
    ],
  });

  revalidatePath('/app/master/dashboard');
}

export async function assignInternalDriverAction(input: {
  orderId: number;
  driverUserId: string;
  costUsd?: number | null;
}) {
  const { supabase, user } = await requireMasterOrAdmin();

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
  const eventContext = await loadOrderEventContext(supabase, input.orderId);
  await appendOrderEvent(supabase, {
    orderId: input.orderId,
    context: eventContext,
    eventType: 'driver_assigned',
    eventGroup: 'delivery',
    title: 'Driver asignado',
    message: 'Se asignó un driver interno a la orden.',
    severity: 'info',
    actorUserId: user.id,
    payload: {
      driver_user_id: input.driverUserId,
      cost_usd: input.costUsd ?? null,
      assignment_kind: 'internal',
    },
    recipients: [
      { targetRole: 'master' },
      { targetUserId: eventContext?.advisorUserId },
      { targetUserId: input.driverUserId },
    ],
  });
  revalidatePath('/app/master/dashboard');
}

export async function assignExternalPartnerAction(input: {
  orderId: number;
  partnerId: number;
  reference: string | null;
  distanceKm?: number | null;
  costUsd?: number | null;
}) {
  const { supabase, user } = await requireMasterOrAdmin();

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
  const eventContext = await loadOrderEventContext(supabase, input.orderId);
  await appendOrderEvent(supabase, {
    orderId: input.orderId,
    context: eventContext,
    eventType: 'driver_assigned',
    eventGroup: 'delivery',
    title: 'Partner externo asignado',
    message: 'Se asignó un partner externo a la orden.',
    severity: 'info',
    actorUserId: user.id,
    payload: {
      partner_id: input.partnerId,
      reference: input.reference,
      distance_km: input.distanceKm ?? null,
      cost_usd: input.costUsd ?? null,
      assignment_kind: 'external',
    },
    recipients: [
      { targetRole: 'master' },
      { targetUserId: eventContext?.advisorUserId },
    ],
  });
  revalidatePath('/app/master/dashboard');
}

export async function reviewOrderChangesAction(input: {
  orderId: number;
  approved: boolean;
  notes: string;
}) {
  const { supabase, user } = await requireMasterOrAdmin();

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
  const { supabase, user } = await requireMasterOrAdmin();

  const { error } = await supabase.rpc('kitchen_take', {
    p_order_id: input.orderId,
    p_eta_minutes: input.etaMinutes,
  });

  if (error) throw new Error(error.message);
  const eventContext = await loadOrderEventContext(supabase, input.orderId);
  await appendOrderEvent(supabase, {
    orderId: input.orderId,
    context: eventContext,
    eventType: 'kitchen_taken',
    eventGroup: 'kitchen',
    title: 'Cocina tomo la orden',
    message: `Cocina registro ${input.etaMinutes} min de preparacion.`,
    severity: 'info',
    actorUserId: user.id,
    payload: {
      prep_eta_minutes: input.etaMinutes,
    },
    recipients: [
      { targetRole: 'master' },
      { targetUserId: eventContext?.advisorUserId },
    ],
  });
  revalidatePath('/app/master/dashboard');
}

export async function markReadyAction(input: {
  orderId: number;
}) {
  const { supabase, user } = await requireMasterOrAdmin();

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
  const { supabase, user } = await requireMasterOrAdmin();
  const eventContext = await loadOrderEventContext(supabase, input.orderId);
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

  await appendOrderEvent(supabase, {
    orderId: input.orderId,
    context: eventContext,
    eventType: 'out_for_delivery',
    eventGroup: 'delivery',
    title: 'Orden en camino',
    message:
      normalizedEta != null
        ? `La orden salio en camino con ETA de ${normalizedEta} min.`
        : 'La orden salio en camino.',
    severity: 'info',
    actorUserId: user.id,
    payload: {
      delivery_eta_minutes: normalizedEta,
    },
    recipients: [
      { targetRole: 'master' },
      { targetUserId: eventContext?.advisorUserId },
      { targetUserId: eventContext?.internalDriverUserId },
    ],
  });
  revalidatePath('/app/master/dashboard');
}

export async function markDeliveredAction(input: {
  orderId: number;
}) {
  const { supabase, user } = await requireMasterOrAdmin();

  let existingExtraFields: Record<string, unknown> = {};

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

  const { error } = await supabase.rpc('mark_delivered', {
    p_order_id: input.orderId,
  });

  if (error) throw new Error(error.message);

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
      completed_at: new Date().toISOString(),
    },
  };

  const { error: updateError } = await supabase
    .from('orders')
    .update({
      extra_fields: nextExtraFields,
    })
    .eq('id', input.orderId);

  if (updateError) throw new Error(updateError.message);

  await applyDeliveredOrderInventoryDeductions(supabase, user.id, input.orderId);
  const eventContext = await loadOrderEventContext(supabase, input.orderId);
  await appendOrderEvent(supabase, {
    orderId: input.orderId,
    context: eventContext,
    eventType: eventContext?.fulfillment === 'pickup' ? 'pickup_collected' : 'order_delivered',
    eventGroup: 'delivery',
    title: eventContext?.fulfillment === 'pickup' ? 'Orden retirada' : 'Orden entregada',
    message:
      eventContext?.fulfillment === 'pickup'
        ? 'La orden fue retirada por el cliente.'
        : 'La orden fue entregada al cliente.',
    severity: 'info',
    actorUserId: user.id,
    payload: {
      fulfillment: eventContext?.fulfillment ?? null,
      completed_at: nextExtraFields.delivery.completed_at,
    },
    recipients: [
      { targetRole: 'master' },
      { targetUserId: eventContext?.advisorUserId },
      { targetUserId: eventContext?.internalDriverUserId },
    ],
  });
  revalidatePath('/app/master/dashboard');
}

export async function clearDeliveryAssignmentAction(input: {
  orderId: number;
  notes: string;
}) {
  const { supabase, user } = await requireMasterOrAdmin();
  const eventContext = await loadOrderEventContext(supabase, input.orderId);

  const { error } = await supabase.rpc('clear_delivery_assignment', {
    p_order_id: input.orderId,
    p_notes: input.notes,
  });

  if (error) throw new Error(error.message);
  await appendOrderEvent(supabase, {
    orderId: input.orderId,
    context: eventContext,
    eventType: 'driver_unassigned',
    eventGroup: 'delivery',
    title: 'Asignacion removida',
    message: 'La orden quedo sin driver asignado.',
    severity: 'warning',
    actorUserId: user.id,
    payload: {
      notes: input.notes,
    },
    recipients: [
      { targetRole: 'master', requiresAction: true },
      { targetUserId: eventContext?.advisorUserId },
    ],
  });
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
    throw new Error('Solo se puede devolver a cola una orden que está en cocina/preparación/lista.');
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
  type: 'product' | 'combo' | 'service' | 'promo' | 'gambit';
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
  inventoryGroup: 'raw' | 'fried' | 'prefried' | 'sauces' | 'packaging' | 'other';
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
    throw new Error('Producto inválido.');
  }

  if (!['product', 'combo', 'service', 'promo', 'gambit'].includes(input.type)) {
    throw new Error('Tipo de producto inválido.');
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
    throw new Error('Modo de comisión inválido.');
  }
  if (!['raw_material', 'prepared_base', 'finished_good'].includes(input.inventoryKind)) {
    throw new Error('Tipo de inventario inválido.');
  }
  if (!['raw', 'fried', 'prefried', 'sauces', 'packaging', 'other'].includes(input.inventoryGroup)) {
    throw new Error('Grupo de inventario inválido.');
  }
  if (!['self', 'composition'].includes(input.inventoryDeductionMode)) {
    throw new Error('Modo de descuento de inventario inválido.');
  }
  if (!['VES', 'USD'].includes(input.sourcePriceCurrency)) {
    throw new Error('Moneda inválida.');
  }

  const normalizedInventoryLinks = (input.inventoryLinks ?? [])
    .map((row, index) => ({
      inventoryItemId: toSafeNumber(row.inventoryItemId, 0),
      quantityUnits: Math.max(0, toSafeNumber(row.quantityUnits, 0)),
      notes: row.notes?.trim() ? row.notes.trim() : null,
      sortOrder: toSafeNumber(row.sortOrder, index + 1) || index + 1,
    }))
    .filter((row) => row.inventoryItemId > 0 && row.quantityUnits > 0);
  const hasConfiguredComponents = input.isDetailEditable;

  if (
    input.inventoryEnabled &&
    input.inventoryDeductionMode === 'composition' &&
    normalizedInventoryLinks.length === 0 &&
    !hasConfiguredComponents
  ) {
    throw new Error('Define al menos un item interno para el descuento por composición.');
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

  const { data: updatedProduct, error: updateProductError } = await supabase
    .from('products')
    .update({
      type: input.type,
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

  const selfInventoryItemId = await syncInventoryItemFromCatalogProduct(supabase, {
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
    inventoryGroup: input.inventoryGroup,
  });

  await replaceProductInventoryLinks(supabase, {
    productId: input.productId,
    inventoryDeductionMode: input.inventoryDeductionMode,
    selfInventoryItemId,
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
    throw new Error('No hay precios válidos para actualizar.');
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
    throw new Error('No hay una tasa activa válida.');
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
    throw new Error('Cuenta inv�lida.');
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
    throw new Error('Cuenta inv�lida.');
  }

  const { error } = await supabase
    .from('money_accounts')
    .update({ is_active: input.nextIsActive })
    .eq('id', accountId);

  if (error) throw new Error(error.message);

  revalidatePath('/app/master/dashboard');
}

export async function createExtraMoneyMovementAction(input: {
  direction: 'inflow' | 'outflow';
  moneyAccountId: number;
  amount: number;
  movementDate: string;
  exchangeRateVesPerUsd: number | null;
  referenceCode: string;
  counterpartyName: string;
  description: string;
  notes: string;
}) {
  const { supabase, user } = await requireMasterOrAdmin();

  const direction = input.direction === 'outflow' ? 'outflow' : 'inflow';
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

  if (!movementDate) {
    throw new Error('Debes indicar la fecha del movimiento.');
  }

  if (!description) {
    throw new Error('Debes indicar el motivo o descripción.');
  }

  const { data: account, error: accountError } = await supabase
    .from('money_accounts')
    .select('id, currency_code, is_active')
    .eq('id', moneyAccountId)
    .single();

  if (accountError || !account) {
    throw new Error(accountError?.message || 'No se pudo cargar la cuenta.');
  }

  if (!account.is_active) {
    throw new Error('La cuenta seleccionada está inactiva.');
  }

  const currencyCode = String(account.currency_code || '').toUpperCase();
  if (currencyCode !== 'USD' && currencyCode !== 'VES') {
    throw new Error('La moneda de la cuenta no es válida.');
  }

  const exchangeRate =
    currencyCode === 'VES'
      ? Number(input.exchangeRateVesPerUsd || 0)
      : null;

  if (currencyCode === 'VES' && (!Number.isFinite(exchangeRate ?? NaN) || (exchangeRate ?? 0) <= 0)) {
    throw new Error('Debes indicar una tasa válida para movimientos en Bs.');
  }

  const amountUsdEquivalent =
    currencyCode === 'USD'
      ? Number(amount.toFixed(2))
      : Number((amount / (exchangeRate ?? 1)).toFixed(2));

  const movementType = direction === 'inflow' ? 'other_income' : 'expense_payment';

  const { error } = await supabase.from('money_movements').insert({
    movement_date: movementDate,
    created_by_user_id: user.id,
    confirmed_at: new Date().toISOString(),
    confirmed_by_user_id: user.id,
    direction,
    movement_type: movementType,
    money_account_id: moneyAccountId,
    currency_code: currencyCode,
    amount: Number(amount.toFixed(2)),
    exchange_rate_ves_per_usd: currencyCode === 'VES' ? exchangeRate : null,
    amount_usd_equivalent: amountUsdEquivalent,
    reference_code: referenceCode,
    counterparty_name: counterpartyName,
    description,
    notes,
    order_id: null,
    payment_report_id: null,
    movement_group_id: null,
  });

  if (error) throw new Error(error.message);

  revalidatePath('/app/master/dashboard');

  /* const orderId = Number(input.orderId || 0);
  if (Number.isFinite(orderId) && orderId > 0) {
    const { data: currentOrder, error: currentOrderError } = await supabase
      .from('orders')
      .select('id, client_id, total_usd, total_bs_snapshot, extra_fields')
      .eq('id', orderId)
      .single();

    if (currentOrderError || !currentOrder) {
      throw new Error(currentOrderError?.message || 'No se pudo recalcular el saldo de la orden.');
    }

    const { data: orderMovements, error: orderMovementsError } = await supabase
      .from('money_movements')
      .select('direction, amount_usd_equivalent')
      .eq('order_id', orderId);

    if (orderMovementsError) {
      throw new Error(orderMovementsError.message);
    }

    const confirmedPaidUsd = (orderMovements ?? []).reduce((sum, row) => {
      const signedAmount =
        toSafeNumber(row.amount_usd_equivalent, 0) *
        (row.direction === 'outflow' ? -1 : 1);
      return sum + signedAmount;
    }, 0);

    const currentTotalUsd = toSafeNumber(currentOrder.total_usd, 0);
    const currentTotalBs = toSafeNumber(currentOrder.total_bs_snapshot, 0);
    const excessUsd = Number(Math.max(0, confirmedPaidUsd - currentTotalUsd).toFixed(2));
    const handling = input.overpaymentHandling ?? null;
    const notes = String(input.overpaymentNotes || '').trim() || null;

    if (excessUsd > 0.005 && handling === 'change_given') {
      const changeNativeAmount = toNativeAmountFromUsd(
        excessUsd,
        input.confirmedCurrency,
        input.confirmedExchangeRateVesPerUsd
      );

      const { error: changeMovementError } = await supabase
        .from('money_movements')
        .insert({
          movement_date: input.movementDate,
          created_by_user_id: user.id,
          confirmed_at: new Date().toISOString(),
          confirmed_by_user_id: user.id,
          direction: 'outflow',
          movement_type: 'change_given',
          money_account_id: input.confirmedMoneyAccountId,
          currency_code: input.confirmedCurrency,
          amount: changeNativeAmount,
          exchange_rate_ves_per_usd:
            String(input.confirmedCurrency).toUpperCase() === 'VES'
              ? input.confirmedExchangeRateVesPerUsd
              : null,
          amount_usd_equivalent: excessUsd,
          reference_code: input.referenceCode,
          counterparty_name: input.counterpartyName,
          description:
            input.description
              ? `${input.description} · cambio entregado`
              : `Cambio entregado · orden ${orderId} · reporte ${input.reportId}`,
          notes,
          order_id: orderId,
          payment_report_id: input.reportId,
          movement_group_id: `change-${orderId}-${input.reportId}`,
        });

      if (changeMovementError) {
        throw new Error(changeMovementError.message);
      }
    }

    if (excessUsd > 0.005 && handling === 'store_fund') {
      const clientId = Number(input.clientId || currentOrder.client_id || 0);
      if (!Number.isFinite(clientId) || clientId <= 0) {
        throw new Error('La orden no tiene un cliente válido para guardar el fondo.');
      }

      const nativeAmount = toNativeAmountFromUsd(
        excessUsd,
        input.confirmedCurrency,
        input.confirmedExchangeRateVesPerUsd
      );

      const { data: currentClient, error: currentClientError } = await supabase
        .from('clients')
        .select('id, fund_balance_usd')
        .eq('id', clientId)
        .single();

      if (currentClientError || !currentClient) {
        throw new Error(currentClientError?.message || 'No se pudo cargar el fondo del cliente.');
      }

      const { error: updateClientFundError } = await supabase
        .from('clients')
        .update({
          fund_balance_usd: toSafeNumber(currentClient.fund_balance_usd, 0) + excessUsd,
        })
        .eq('id', clientId);

      if (updateClientFundError) {
        throw new Error(updateClientFundError.message);
      }

      const { error: fundMovementError } = await supabase
        .from('client_fund_movements')
        .insert({
          client_id: clientId,
          movement_type: 'credit',
          currency_code: input.confirmedCurrency,
          amount: nativeAmount,
          amount_usd: excessUsd,
          money_account_id: input.confirmedMoneyAccountId,
          order_id: orderId,
          payment_report_id: input.reportId,
          reason_code: 'payment_overage_stored',
          notes,
          created_by_user_id: user.id,
        });

      if (fundMovementError) {
        throw new Error(fundMovementError.message);
      }
    }

    if (excessUsd > 0.005 && handling === 'close_difference') {
      if (!roles.includes('admin')) {
        throw new Error('Solo admin puede cerrar excedentes por redondeo.');
      }

      if (excessUsd > ORDER_ROUNDING_CLOSE_MAX_USD) {
        throw new Error(
          `Solo se pueden cerrar diferencias de hasta ${ORDER_ROUNDING_CLOSE_MAX_USD.toFixed(2)} USD.`
        );
      }

      const extraFields =
        currentOrder.extra_fields &&
        typeof currentOrder.extra_fields === 'object' &&
        !Array.isArray(currentOrder.extra_fields)
          ? ({ ...currentOrder.extra_fields } as Record<string, any>)
          : {};

      const pricing =
        extraFields.pricing && typeof extraFields.pricing === 'object' && !Array.isArray(extraFields.pricing)
          ? { ...extraFields.pricing }
          : {};

      const payment =
        extraFields.payment && typeof extraFields.payment === 'object' && !Array.isArray(extraFields.payment)
          ? { ...extraFields.payment }
          : {};

      const fxRate = toSafeNumber(pricing.fx_rate, 0);
      const nextTotalUsd = Number(confirmedPaidUsd.toFixed(2));
      const nextTotalBs =
        fxRate > 0
          ? Number((nextTotalUsd * fxRate).toFixed(2))
          : currentTotalUsd > 0
            ? Number(((currentTotalBs / currentTotalUsd) * nextTotalUsd).toFixed(2))
            : currentTotalBs;

      pricing.total_usd = nextTotalUsd;
      pricing.total_bs = nextTotalBs;
      pricing.rounding_gain_closed_usd = excessUsd;
      pricing.rounding_gain_close_applied_at = new Date().toISOString();
      pricing.rounding_gain_close_applied_by = user.id;

      payment.rounding_gain_close = {
        closed_balance_usd: excessUsd,
        previous_total_usd: Number(currentTotalUsd.toFixed(2)),
        next_total_usd: nextTotalUsd,
        applied_at: new Date().toISOString(),
        applied_by: user.id,
        notes,
      };

      extraFields.pricing = pricing;
      extraFields.payment = payment;

      const { error: updateOrderError } = await supabase
        .from('orders')
        .update({
          total_usd: nextTotalUsd,
          total_bs_snapshot: nextTotalBs,
          extra_fields: extraFields,
          last_modified_at: new Date().toISOString(),
          last_modified_by: user.id,
        })
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
          reason: 'Cierre de excedente por redondeo',
          notes,
          payload: {
            kind: 'rounding_gain_close',
            delta_usd: excessUsd,
            original_unit_price_usd: Number(currentTotalUsd.toFixed(2)),
            override_unit_price_usd: nextTotalUsd,
            product_name: 'Cierre por redondeo',
            qty: 1,
            closed_balance_usd: excessUsd,
            previous_total_usd: Number(currentTotalUsd.toFixed(2)),
            previous_total_bs: Number(currentTotalBs.toFixed(2)),
            confirmed_paid_usd: Number(confirmedPaidUsd.toFixed(2)),
            next_total_usd: nextTotalUsd,
            next_total_bs: nextTotalBs,
            payment_report_id: input.reportId,
          },
          created_by_user_id: user.id,
        });

      if (adjustmentError) {
        throw new Error(adjustmentError.message);
      }
    }
  } */
  revalidatePath('/app/master/dashboard');
}

export async function createInventoryItemAction(input: {
  name: string;
  inventoryKind: 'raw_material' | 'prepared_base' | 'finished_stock' | 'packaging';
  inventoryGroup: 'raw' | 'fried' | 'prefried' | 'sauces' | 'packaging' | 'other';
  unitName: string;
  packagingName: string | null;
  packagingSize: number | null;
  currentStockUnits: number;
  lowStockThreshold: number | null;
  isActive: boolean;
  notes: string | null;
}) {
  const { supabase, user } = await requireMasterOrAdmin();

  const name = String(input.name || '').trim();
  if (!name) throw new Error('El nombre del item es obligatorio.');
  if (!['raw_material', 'prepared_base', 'finished_stock', 'packaging'].includes(input.inventoryKind)) {
    throw new Error('Tipo de inventario inválido.');
  }
  if (!['raw', 'fried', 'prefried', 'sauces', 'packaging', 'other'].includes(input.inventoryGroup)) {
    throw new Error('Grupo de inventario inválido.');
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
    inventory_group: input.inventoryGroup,
    is_active: !!input.isActive,
    notes: String(input.notes || '').trim() || null,
  });

  if (error) throw new Error(error.message);
  /*

  const orderId = Number(input.orderId || 0);
  if (Number.isFinite(orderId) && orderId > 0) {
    const { data: currentOrder, error: currentOrderError } = await supabase
      .from('orders')
      .select('id, client_id, total_usd, total_bs_snapshot, extra_fields')
      .eq('id', orderId)
      .single();

    if (currentOrderError || !currentOrder) {
      throw new Error(currentOrderError?.message || 'No se pudo recalcular el saldo de la orden.');
    }

    const { data: orderMovements, error: orderMovementsError } = await supabase
      .from('money_movements')
      .select('direction, amount_usd_equivalent')
      .eq('order_id', orderId);

    if (orderMovementsError) {
      throw new Error(orderMovementsError.message);
    }

    const confirmedPaidUsd = (orderMovements ?? []).reduce((sum, row) => {
      const signedAmount =
        toSafeNumber(row.amount_usd_equivalent, 0) *
        (row.direction === 'outflow' ? -1 : 1);
      return sum + signedAmount;
    }, 0);

    const currentTotalUsd = toSafeNumber(currentOrder.total_usd, 0);
    const currentTotalBs = toSafeNumber(currentOrder.total_bs_snapshot, 0);
    const excessUsd = Number(Math.max(0, confirmedPaidUsd - currentTotalUsd).toFixed(2));
    const handling = input.overpaymentHandling ?? null;
    const notes = String(input.overpaymentNotes || '').trim() || null;

    if (excessUsd > 0.005 && handling === 'change_given') {
      const changeNativeAmount = toNativeAmountFromUsd(
        excessUsd,
        input.confirmedCurrency,
        input.confirmedExchangeRateVesPerUsd
      );

      const { error: changeMovementError } = await supabase
        .from('money_movements')
        .insert({
          movement_date: input.movementDate,
          created_by_user_id: user.id,
          confirmed_at: new Date().toISOString(),
          confirmed_by_user_id: user.id,
          direction: 'outflow',
          movement_type: 'change_given',
          money_account_id: input.confirmedMoneyAccountId,
          currency_code: input.confirmedCurrency,
          amount: changeNativeAmount,
          exchange_rate_ves_per_usd:
            String(input.confirmedCurrency).toUpperCase() === 'VES'
              ? input.confirmedExchangeRateVesPerUsd
              : null,
          amount_usd_equivalent: excessUsd,
          reference_code: input.referenceCode,
          counterparty_name: input.counterpartyName,
          description:
            input.description
              ? `${input.description} · cambio entregado`
              : `Cambio entregado · orden ${orderId} · reporte ${input.reportId}`,
          notes,
          order_id: orderId,
          payment_report_id: input.reportId,
          movement_group_id: `change-${orderId}-${input.reportId}`,
        });

      if (changeMovementError) {
        throw new Error(changeMovementError.message);
      }
    }

    if (excessUsd > 0.005 && handling === 'store_fund') {
      const clientId = Number(input.clientId || currentOrder.client_id || 0);
      if (!Number.isFinite(clientId) || clientId <= 0) {
        throw new Error('La orden no tiene un cliente válido para guardar el fondo.');
      }

      const nativeAmount = toNativeAmountFromUsd(
        excessUsd,
        input.confirmedCurrency,
        input.confirmedExchangeRateVesPerUsd
      );

      const { data: currentClient, error: currentClientError } = await supabase
        .from('clients')
        .select('id, fund_balance_usd')
        .eq('id', clientId)
        .single();

      if (currentClientError || !currentClient) {
        throw new Error(currentClientError?.message || 'No se pudo cargar el fondo del cliente.');
      }

      const { error: updateClientFundError } = await supabase
        .from('clients')
        .update({
          fund_balance_usd: toSafeNumber(currentClient.fund_balance_usd, 0) + excessUsd,
        })
        .eq('id', clientId);

      if (updateClientFundError) {
        throw new Error(updateClientFundError.message);
      }

      const { error: fundMovementError } = await supabase
        .from('client_fund_movements')
        .insert({
          client_id: clientId,
          movement_type: 'credit',
          currency_code: input.confirmedCurrency,
          amount: nativeAmount,
          amount_usd: excessUsd,
          money_account_id: input.confirmedMoneyAccountId,
          order_id: orderId,
          payment_report_id: input.reportId,
          reason_code: 'payment_overage_stored',
          notes,
          created_by_user_id: user.id,
        });

      if (fundMovementError) {
        throw new Error(fundMovementError.message);
      }
    }

    if (excessUsd > 0.005 && handling === 'close_difference') {
      if (!roles.includes('admin')) {
        throw new Error('Solo admin puede cerrar excedentes por redondeo.');
      }

      if (excessUsd > ORDER_ROUNDING_CLOSE_MAX_USD) {
        throw new Error(
          `Solo se pueden cerrar diferencias de hasta ${ORDER_ROUNDING_CLOSE_MAX_USD.toFixed(2)} USD.`
        );
      }

      const extraFields =
        currentOrder.extra_fields &&
        typeof currentOrder.extra_fields === 'object' &&
        !Array.isArray(currentOrder.extra_fields)
          ? ({ ...currentOrder.extra_fields } as Record<string, any>)
          : {};

      const pricing =
        extraFields.pricing && typeof extraFields.pricing === 'object' && !Array.isArray(extraFields.pricing)
          ? { ...extraFields.pricing }
          : {};

      const payment =
        extraFields.payment && typeof extraFields.payment === 'object' && !Array.isArray(extraFields.payment)
          ? { ...extraFields.payment }
          : {};

      const fxRate = toSafeNumber(pricing.fx_rate, 0);
      const nextTotalUsd = Number(confirmedPaidUsd.toFixed(2));
      const nextTotalBs =
        fxRate > 0
          ? Number((nextTotalUsd * fxRate).toFixed(2))
          : currentTotalUsd > 0
            ? Number(((currentTotalBs / currentTotalUsd) * nextTotalUsd).toFixed(2))
            : currentTotalBs;

      pricing.total_usd = nextTotalUsd;
      pricing.total_bs = nextTotalBs;
      pricing.rounding_gain_closed_usd = excessUsd;
      pricing.rounding_gain_close_applied_at = new Date().toISOString();
      pricing.rounding_gain_close_applied_by = user.id;

      payment.rounding_gain_close = {
        closed_balance_usd: excessUsd,
        previous_total_usd: Number(currentTotalUsd.toFixed(2)),
        next_total_usd: nextTotalUsd,
        applied_at: new Date().toISOString(),
        applied_by: user.id,
        notes,
      };

      extraFields.pricing = pricing;
      extraFields.payment = payment;

      const { error: updateOrderError } = await supabase
        .from('orders')
        .update({
          total_usd: nextTotalUsd,
          total_bs_snapshot: nextTotalBs,
          extra_fields: extraFields,
          last_modified_at: new Date().toISOString(),
          last_modified_by: user.id,
        })
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
          reason: 'Cierre de excedente por redondeo',
          notes,
          payload: {
            kind: 'rounding_gain_close',
            delta_usd: excessUsd,
            original_unit_price_usd: Number(currentTotalUsd.toFixed(2)),
            override_unit_price_usd: nextTotalUsd,
            product_name: 'Cierre por redondeo',
            qty: 1,
            closed_balance_usd: excessUsd,
            previous_total_usd: Number(currentTotalUsd.toFixed(2)),
            previous_total_bs: Number(currentTotalBs.toFixed(2)),
            confirmed_paid_usd: Number(confirmedPaidUsd.toFixed(2)),
            next_total_usd: nextTotalUsd,
            next_total_bs: nextTotalBs,
            payment_report_id: input.reportId,
          },
          created_by_user_id: user.id,
        });

      if (adjustmentError) {
        throw new Error(adjustmentError.message);
      }
    }
  }
  */

  revalidatePath('/app/master/dashboard');
}

export async function updateInventoryItemAction(input: {
  inventoryItemId: number;
  name: string;
  inventoryKind: 'raw_material' | 'prepared_base' | 'finished_stock' | 'packaging';
  inventoryGroup: 'raw' | 'fried' | 'prefried' | 'sauces' | 'packaging' | 'other';
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
  if (!['raw', 'fried', 'prefried', 'sauces', 'packaging', 'other'].includes(input.inventoryGroup)) {
    throw new Error('Grupo de inventario inválido.');
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
      inventory_group: input.inventoryGroup,
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
  const { supabase, user } = await requireMasterOrAdmin();

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
    throw new Error('Partner inválido.');
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
    throw new Error('Partner inválido.');
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
    throw new Error('Orden inválida.');
  }

  const kind = String(input.kind || '').trim();
  if (!['advisor_change', 'client_change', 'schedule_change'].includes(kind)) {
    throw new Error('Tipo de ajuste inválido.');
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

export async function closeOrderRoundingBalanceAction(input: {
  orderId: number;
  notes?: string | null;
}) {
  const { supabase, user, roles } = await requireMasterOrAdmin();

  if (!roles.includes('admin')) {
    throw new Error('Solo admin puede cerrar diferencias de redondeo.');
  }

  const orderId = Number(input.orderId);
  if (!Number.isFinite(orderId) || orderId <= 0) {
    throw new Error('Orden inválida.');
  }

  const { data: currentOrder, error: currentOrderError } = await supabase
    .from('orders')
    .select('id, status, total_usd, total_bs_snapshot, extra_fields')
    .eq('id', orderId)
    .single();

  if (currentOrderError || !currentOrder) {
    throw new Error(currentOrderError?.message || 'No se pudo cargar la orden.');
  }

  if (currentOrder.status === 'cancelled') {
    throw new Error('No puedes cerrar diferencias en una orden cancelada.');
  }

  const { data: orderMovements, error: orderMovementsError } = await supabase
    .from('money_movements')
    .select('direction, amount_usd_equivalent')
    .eq('order_id', orderId);

  if (orderMovementsError) {
    throw new Error(orderMovementsError.message);
  }

  const confirmedPaidUsd = (orderMovements ?? []).reduce(
    (sum, row) =>
      sum +
      toSafeNumber(row.amount_usd_equivalent, 0) *
        (row.direction === 'outflow' ? -1 : 1),
    0
  );

  const currentTotalUsd = toSafeNumber(currentOrder.total_usd, 0);
  const currentTotalBs = toSafeNumber(currentOrder.total_bs_snapshot, 0);
  const pendingUsd = Math.max(0, currentTotalUsd - confirmedPaidUsd);

  if (pendingUsd <= 0.005) {
    throw new Error('Esta orden ya no tiene una diferencia pendiente por cerrar.');
  }

  if (pendingUsd > ORDER_ROUNDING_CLOSE_MAX_USD) {
    throw new Error(
      `Solo se pueden cerrar diferencias de hasta ${ORDER_ROUNDING_CLOSE_MAX_USD.toFixed(2)} USD.`
    );
  }

  const extraFields =
    currentOrder.extra_fields &&
    typeof currentOrder.extra_fields === 'object' &&
    !Array.isArray(currentOrder.extra_fields)
      ? ({ ...currentOrder.extra_fields } as Record<string, any>)
      : {};

  const pricing =
    extraFields.pricing && typeof extraFields.pricing === 'object' && !Array.isArray(extraFields.pricing)
      ? { ...extraFields.pricing }
      : {};

  const payment =
    extraFields.payment && typeof extraFields.payment === 'object' && !Array.isArray(extraFields.payment)
      ? { ...extraFields.payment }
      : {};

  const fxRate = toSafeNumber(pricing.fx_rate, 0);
  const nextTotalUsd = Number(confirmedPaidUsd.toFixed(2));
  const nextTotalBs =
    fxRate > 0
      ? Number((nextTotalUsd * fxRate).toFixed(2))
      : currentTotalUsd > 0
        ? Number(((currentTotalBs / currentTotalUsd) * nextTotalUsd).toFixed(2))
        : currentTotalBs;

  const nowIso = new Date().toISOString();
  const roundedPendingUsd = Number(pendingUsd.toFixed(2));

  pricing.total_usd = nextTotalUsd;
  pricing.total_bs = nextTotalBs;
  pricing.rounding_closed_usd = roundedPendingUsd;
  pricing.rounding_close_applied_at = nowIso;
  pricing.rounding_close_applied_by = user.id;

  payment.rounding_close = {
    closed_balance_usd: roundedPendingUsd,
    previous_total_usd: Number(currentTotalUsd.toFixed(2)),
    next_total_usd: nextTotalUsd,
    applied_at: nowIso,
    applied_by: user.id,
    notes: String(input.notes || '').trim() || null,
  };

  extraFields.pricing = pricing;
  extraFields.payment = payment;

  const { error: updateOrderError } = await supabase
    .from('orders')
    .update({
      total_usd: nextTotalUsd,
      total_bs_snapshot: nextTotalBs,
      extra_fields: extraFields,
      last_modified_at: nowIso,
      last_modified_by: user.id,
    })
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
      reason: 'Cierre de diferencia por redondeo',
      notes: String(input.notes || '').trim() || null,
      payload: {
        kind: 'rounding_writeoff',
        delta_usd: -roundedPendingUsd,
        original_unit_price_usd: Number(currentTotalUsd.toFixed(2)),
        override_unit_price_usd: nextTotalUsd,
        product_name: 'Cierre por redondeo',
        qty: 1,
        closed_balance_usd: roundedPendingUsd,
        previous_total_usd: Number(currentTotalUsd.toFixed(2)),
        previous_total_bs: Number(currentTotalBs.toFixed(2)),
        confirmed_paid_usd: Number(confirmedPaidUsd.toFixed(2)),
        next_total_usd: nextTotalUsd,
        next_total_bs: nextTotalBs,
      },
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
    throw new Error('Debes agregar un ítem de delivery.');
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
    selfInventoryItemId?: number | null;
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

  if (input.inventoryDeductionMode === 'self') {
    const selfInventoryItemId = toSafeNumber(input.selfInventoryItemId, 0);
    if (selfInventoryItemId <= 0) {
      return;
    }

    const { error: insertSelfLinkError } = await supabase
      .from('product_inventory_links')
      .insert({
        product_id: input.productId,
        inventory_item_id: selfInventoryItemId,
        deduction_mode: 'self_link',
        quantity_units: 1,
        sort_order: 1,
        notes: null,
        is_active: true,
      });

    if (insertSelfLinkError) {
      throw new Error(insertSelfLinkError.message);
    }

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
    throw new Error('Hay items internos inválidos en el descuento de inventario.');
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
    .select('id, product_id, qty, product_name_snapshot, notes')
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

  const { data: productComponents, error: productComponentsError } = await supabase
    .from('product_components')
    .select('parent_product_id, component_product_id, component_mode, quantity, is_required')
    .in('parent_product_id', productIds);

  if (productComponentsError) {
    throw new Error(productComponentsError.message);
  }

  const componentProductIds = Array.from(
    new Set(
      (productComponents ?? [])
        .map((row) => Number(row.component_product_id))
        .filter((id) => id > 0)
    )
  );

  const lookupProductIds = Array.from(new Set([...productIds, ...componentProductIds]));

  const { data: products, error: productsError } = await supabase
    .from('products')
    .select('id, name, inventory_enabled, inventory_deduction_mode')
    .in('id', lookupProductIds);

  if (productsError) {
    throw new Error(productsError.message);
  }

  const { data: links, error: linksError } = await supabase
    .from('product_inventory_links')
    .select('product_id, inventory_item_id, quantity_units, is_active')
    .in('product_id', lookupProductIds);

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

  const componentsByParentProductId = new Map<
    number,
    Array<{
      componentProductId: number;
      componentMode: 'fixed' | 'selectable';
      quantity: number;
      isRequired: boolean;
    }>
  >();

  for (const row of productComponents ?? []) {
    const parentProductId = Number(row.parent_product_id);
    const componentProductId = Number(row.component_product_id);
    if (parentProductId <= 0 || componentProductId <= 0) continue;

    const list = componentsByParentProductId.get(parentProductId) ?? [];
    list.push({
      componentProductId,
      componentMode: row.component_mode === 'selectable' ? 'selectable' : 'fixed',
      quantity: Math.max(0, toSafeNumber(row.quantity, 0)),
      isRequired: !!row.is_required,
    });
    componentsByParentProductId.set(parentProductId, list);
  }

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

  const fallbackInventoryNames = Array.from(
    new Set(
      Array.from(productById.values())
        .map((product) => String(product.name || '').trim())
        .filter(Boolean)
    )
  );

  const inventoryItemsByName = new Map<string, { id: number; currentStockUnits: number }>();
  if (fallbackInventoryNames.length > 0) {
    const { data: fallbackInventoryItems, error: fallbackInventoryItemsError } = await supabase
      .from('inventory_items')
      .select('id, name, current_stock_units')
      .in('name', fallbackInventoryNames);

    if (fallbackInventoryItemsError) {
      throw new Error(fallbackInventoryItemsError.message);
    }

    for (const row of fallbackInventoryItems ?? []) {
      const normalizedName = String((row as { name?: string | null }).name || '').trim().toLowerCase();
      if (!normalizedName) continue;

      const inventoryRow = {
        id: Number(row.id),
        currentStockUnits: toSafeNumber(row.current_stock_units, 0),
      };

      inventoryItemsByName.set(normalizedName, inventoryRow);
      inventoryItemsById.set(inventoryRow.id, inventoryRow);
    }
  }

  const aggregatedDeductions = new Map<number, number>();
  const notesByInventoryItemId = new Map<number, string[]>();

  const parseOrderItemSelections = (notes: string | null | undefined) => {
    const selectedComponentQtyById = new Map<number, number>();
    const selectedComponentQtyByName = new Map<string, number>();

    for (const rawLine of String(notes || '').split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;

      if (line.startsWith('@sel|')) {
        const [, componentProductIdRaw, qtyRaw] = line.split('|');
        const componentProductId = Number(componentProductIdRaw || 0);
        const qty = Math.max(0, toSafeNumber(qtyRaw, 0));
        if (componentProductId > 0 && qty > 0) {
          selectedComponentQtyById.set(componentProductId, qty);
        }
        continue;
      }

      if (/^para\s*:/i.test(line)) continue;

      const match = line.match(/^(\d+)\s+(.+)$/i);
      if (!match) continue;

      const qty = Math.max(0, toSafeNumber(match[1], 0));
      const componentName = String(match[2] || '').trim().toLowerCase();
      if (!componentName || qty <= 0) continue;
      selectedComponentQtyByName.set(componentName, qty);
    }

    return { selectedComponentQtyById, selectedComponentQtyByName };
  };

  const addInventoryDeduction = (inventoryItemId: number, quantityUnits: number, noteLabel: string) => {
    if (inventoryItemId <= 0 || quantityUnits <= 0) return;

    aggregatedDeductions.set(
      inventoryItemId,
      (aggregatedDeductions.get(inventoryItemId) ?? 0) + quantityUnits
    );

    const notes = notesByInventoryItemId.get(inventoryItemId) ?? [];
    notes.push(noteLabel);
    notesByInventoryItemId.set(inventoryItemId, notes);
  };

  const applyProductDeductions = (
    productId: number,
    qty: number,
    noteLabel: string,
    selectableSelections?: ReturnType<typeof parseOrderItemSelections>,
    stack: number[] = []
  ) => {
    if (productId <= 0 || qty <= 0) return;
    if (stack.includes(productId)) return;

    const product = productById.get(productId);
    if (!product?.inventoryEnabled) return;

    const nextStack = [...stack, productId];
    const productComponentsRows = componentsByParentProductId.get(productId) ?? [];

    if (product.deductionMode === 'composition' && productComponentsRows.length > 0) {
      let appliedFromComponents = false;

      for (const componentRow of productComponentsRows) {
        if (componentRow.componentMode === 'fixed' && componentRow.isRequired) {
          const childQty = qty * Math.max(0, componentRow.quantity);
          if (childQty > 0) {
            appliedFromComponents = true;
            applyProductDeductions(componentRow.componentProductId, childQty, noteLabel, undefined, nextStack);
          }
          continue;
        }

        let selectedQty = selectableSelections?.selectedComponentQtyById.get(componentRow.componentProductId) ?? 0;
        if (selectedQty <= 0) {
          const componentName = productById.get(componentRow.componentProductId)?.name?.trim().toLowerCase() || '';
          if (componentName) {
            selectedQty = selectableSelections?.selectedComponentQtyByName.get(componentName) ?? 0;
          }
        }

        if (selectedQty > 0) {
          appliedFromComponents = true;
          applyProductDeductions(componentRow.componentProductId, qty * selectedQty, noteLabel, undefined, nextStack);
        }
      }

      if (appliedFromComponents) {
        return;
      }
    }

    const productLinks = linksByProductId.get(productId) ?? [];
    if (product.deductionMode === 'composition') {
      for (const link of productLinks) {
        if (link.inventoryItemId <= 0 || link.quantityUnits <= 0) continue;
        addInventoryDeduction(link.inventoryItemId, qty * link.quantityUnits, noteLabel);
      }
      if (productLinks.length > 0) {
        return;
      }
    }

    const selfInventoryLink = productLinks.find((link) => link.inventoryItemId > 0) ?? null;
    if (selfInventoryLink) {
      addInventoryDeduction(selfInventoryLink.inventoryItemId, qty, noteLabel);
      return;
    }

    const fallbackInventoryItem = inventoryItemsByName.get(product.name.trim().toLowerCase()) ?? null;
    if (fallbackInventoryItem) {
      addInventoryDeduction(fallbackInventoryItem.id, qty, noteLabel);
    }
  };

  for (const row of orderItems ?? []) {
    const productId = toSafeNumber(row.product_id, 0);
    const qty = Math.max(0, toSafeNumber(row.qty, 0));
    if (productId <= 0 || qty <= 0) continue;

    const product = productById.get(productId);
    if (!product?.inventoryEnabled) continue;
    applyProductDeductions(
      productId,
      qty,
      `${row.product_name_snapshot || product.name} x${qty}`,
      parseOrderItemSelections((row as { notes?: string | null }).notes ?? null)
    );
  }

  if (aggregatedDeductions.size === 0) {
    return;
  }

  for (const [inventoryItemId, quantityUnits] of aggregatedDeductions.entries()) {
    const inventoryItem = inventoryItemsById.get(inventoryItemId);

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

async function resetDeliveredOrderInventoryDeductions(
  supabase: Awaited<ReturnType<typeof createSupabaseServer>>,
  orderId: number
) {
  const { data: existingSaleMovements, error: existingSaleMovementsError } = await supabase
    .from('inventory_movements')
    .select('id, inventory_item_id, quantity_units')
    .eq('order_id', orderId)
    .eq('movement_type', 'sale_out');

  if (existingSaleMovementsError) {
    throw new Error(existingSaleMovementsError.message);
  }

  if ((existingSaleMovements ?? []).length === 0) {
    return;
  }

  const restoreByItemId = new Map<number, number>();
  for (const movement of existingSaleMovements ?? []) {
    const inventoryItemId = Number(movement.inventory_item_id);
    const quantityUnits = Math.max(0, toSafeNumber(movement.quantity_units, 0));
    if (inventoryItemId <= 0 || quantityUnits <= 0) continue;

    restoreByItemId.set(
      inventoryItemId,
      (restoreByItemId.get(inventoryItemId) ?? 0) + quantityUnits
    );
  }

  const inventoryItemIds = Array.from(restoreByItemId.keys());
  if (inventoryItemIds.length > 0) {
    const { data: inventoryItems, error: inventoryItemsError } = await supabase
      .from('inventory_items')
      .select('id, current_stock_units')
      .in('id', inventoryItemIds);

    if (inventoryItemsError) {
      throw new Error(inventoryItemsError.message);
    }

    const inventoryById = new Map(
      (inventoryItems ?? []).map((row) => [
        Number(row.id),
        toSafeNumber(row.current_stock_units, 0),
      ])
    );

    for (const inventoryItemId of inventoryItemIds) {
      const currentStockUnits = inventoryById.get(inventoryItemId);
      if (currentStockUnits == null) {
        throw new Error(`No se encontró el item interno ${inventoryItemId} para restaurar inventario.`);
      }

      const restoreQty = restoreByItemId.get(inventoryItemId) ?? 0;
      const { error: restoreError } = await supabase
        .from('inventory_items')
        .update({ current_stock_units: currentStockUnits + restoreQty })
        .eq('id', inventoryItemId);

      if (restoreError) {
        throw new Error(restoreError.message);
      }
    }
  }

  const movementIds = (existingSaleMovements ?? [])
    .map((movement) => Number(movement.id))
    .filter((id) => id > 0);

  if (movementIds.length > 0) {
    const { error: deleteMovementsError } = await supabase
      .from('inventory_movements')
      .delete()
      .in('id', movementIds);

    if (deleteMovementsError) {
      throw new Error(deleteMovementsError.message);
    }
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
  const { supabase, user } = await requireMasterOrAdmin();

  const fullName = String(input.fullName || '').trim();
  const phone = normalizePhone(String(input.phone || ''));

  if (!fullName) {
    throw new Error('Debes colocar el nombre del cliente.');
  }

  if (!phone) {
    throw new Error('Debes colocar el teléfono del cliente.');
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
      fund_balance_usd,
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
      fund_balance_usd,
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
  inventoryGroup: 'raw' | 'fried' | 'prefried' | 'sauces' | 'packaging' | 'other';
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
    throw new Error('Tipo inválido.');
  }
  if (!['VES', 'USD'].includes(input.sourcePriceCurrency)) {
    throw new Error('Moneda inválida.');
  }
  if (!['raw_material', 'prepared_base', 'finished_good'].includes(input.inventoryKind)) {
    throw new Error('Tipo de inventario inválido.');
  }
  if (!['raw', 'fried', 'prefried', 'sauces', 'packaging', 'other'].includes(input.inventoryGroup)) {
    throw new Error('Grupo de inventario inválido.');
  }
  if (!['self', 'composition'].includes(input.inventoryDeductionMode)) {
    throw new Error('Modo de descuento de inventario inválido.');
  }
  const normalizedInventoryLinks = (input.inventoryLinks ?? [])
    .map((row, index) => ({
      inventoryItemId: toSafeNumber(row.inventoryItemId, 0),
      quantityUnits: Math.max(0, toSafeNumber(row.quantityUnits, 0)),
      notes: row.notes?.trim() ? row.notes.trim() : null,
      sortOrder: toSafeNumber(row.sortOrder, index + 1) || index + 1,
    }))
    .filter((row) => row.inventoryItemId > 0 && row.quantityUnits > 0);
  const hasConfiguredComponents = input.isDetailEditable;
  if (!Number.isFinite(sourcePriceAmount) || sourcePriceAmount < 0) {
    throw new Error('El monto fuente es inválido.');
  }
  if (!Number.isFinite(unitsPerService) || unitsPerService < 0) {
    throw new Error('Und/servicio inválido.');
  }
  if (!Number.isFinite(detailUnitsLimit) || detailUnitsLimit < 0) {
    throw new Error('Límite de detalle inválido.');
  }
  if (
    input.inventoryEnabled &&
    input.inventoryDeductionMode === 'composition' &&
    normalizedInventoryLinks.length === 0 &&
    !hasConfiguredComponents
  ) {
    throw new Error('Define al menos un item interno para el descuento por composición.');
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
      inventory_group: input.inventoryGroup,
    })
    .select('id')
    .single();

  if (error) throw new Error(error.message);

  const selfInventoryItemId = await syncInventoryItemFromCatalogProduct(supabase, {
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
    inventoryGroup: input.inventoryGroup,
  });

  await replaceProductInventoryLinks(supabase, {
    productId: Number(data.id),
    inventoryDeductionMode: input.inventoryDeductionMode,
    selfInventoryItemId,
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
    throw new Error('No se puede eliminar: el producto ya fue usado en Órdenes.');
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

function buildOrderItemOverrideAuditPayload(item: {
  productNameSnapshot: string;
  unitPriceUsdSnapshot: number;
  adminPriceOverrideUsd: number | null;
  adminPriceOverrideReason?: string | null;
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

function buildOrderItemOverrideAuditSignature(item: {
  productNameSnapshot: string;
  unitPriceUsdSnapshot: number;
  adminPriceOverrideUsd: number | null;
  adminPriceOverrideReason?: string | null;
  qty: number;
  lineTotalUsd: number;
}) {
  const payload = buildOrderItemOverrideAuditPayload(item);
  return JSON.stringify({
    product_name: payload.product_name,
    qty: payload.qty,
    original_unit_price_usd: payload.original_unit_price_usd,
    override_unit_price_usd: payload.override_unit_price_usd,
    override_line_total_usd: payload.override_line_total_usd,
    reason: String(item.adminPriceOverrideReason || '').trim(),
  });
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
  isAsap: boolean;
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
  useClientFund: boolean;
  clientFundAmountUsd: string;
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
    throw new Error('Source inválido.');
  }

  if (!['pickup', 'delivery'].includes(fulfillment)) {
    throw new Error('Fulfillment inválido.');
  }

  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw new Error('Debes agregar al menos un ítem.');
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
    throw new Error('La dirección es obligatoria para delivery.');
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
    throw new Error('No se pudo confirmar la actualización del cliente.');
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

  const requestedClientFundUsd = Number(
    String(input.clientFundAmountUsd || '').replace(',', '.')
  );
  const clientFundUsedUsd = input.useClientFund
    ? Number(Math.max(0, Math.min(totalUsd, Number.isFinite(requestedClientFundUsd) ? requestedClientFundUsd : 0)).toFixed(2))
    : 0;

  const orderNumber = await generateUniqueOrderNumber(supabase);

  const extraFields = {
    schedule: {
      date: input.deliveryDate,
      time_12: `${input.deliveryHour12}:${pad2(Number(input.deliveryMinute || 0))} ${input.deliveryAmPm}`,
      time_24: deliveryTime24,
      asap: Boolean(input.isAsap),
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
      client_fund_used_usd: clientFundUsedUsd > 0.005 ? clientFundUsedUsd : 0,
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

  if (clientFundUsedUsd > 0.005) {
    await applyClientFundToOrder(supabase, {
      clientId,
      orderId,
      amountUsd: clientFundUsedUsd,
      userId: user.id,
      notes: 'Fondo aplicado al crear orden',
    });
  }

  await appendOrderEvent(supabase, {
    orderId,
    eventType: 'order_created',
    eventGroup: 'approval',
    title: 'Orden creada',
    message: 'La orden fue creada y quedo pendiente de aprobacion.',
    severity: 'warning',
    actorUserId: user.id,
    payload: {
      order_number: orderNumber,
      fulfillment,
      source,
      urgent: Boolean(input.isAsap),
      delivery_time: `${input.deliveryDate} ${deliveryTime24}`,
    },
    recipients: [
      { targetRole: 'master', requiresAction: true },
      { targetUserId: attributedAdvisorId },
    ],
  });

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
  isAsap: boolean;
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
  useClientFund: boolean;
  clientFundAmountUsd: string;
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
    throw new Error('La dirección es obligatoria para delivery.');
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
    throw new Error('Solo se pueden editar Órdenes en estado created o queued.');
  }

  if (isAdvancedAdminEdit && !String(input.adminEditReason || '').trim()) {
    throw new Error('Debes indicar el motivo de la modificación administrativa.');
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
    throw new Error('No se pudo confirmar la actualización del cliente.');
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

  const requestedClientFundUsd = Number(
    String(input.clientFundAmountUsd || '').replace(',', '.')
  );
  const clientFundUsedUsd = input.useClientFund
    ? Number(Math.max(0, Math.min(totalUsd, Number.isFinite(requestedClientFundUsd) ? requestedClientFundUsd : 0)).toFixed(2))
    : 0;
  const previousClientFundUsedUsd = Number(
    toSafeNumber((currentOrder.extra_fields as any)?.payment?.client_fund_used_usd, 0).toFixed(2)
  );

  const extraFields = {
    schedule: {
      date: input.deliveryDate,
      time_12: `${input.deliveryHour12}:${pad2(Number(input.deliveryMinute || 0))} ${input.deliveryAmPm}`,
      time_24: deliveryTime24,
      asap: Boolean(input.isAsap),
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
      client_fund_used_usd: clientFundUsedUsd > 0.005 ? clientFundUsedUsd : 0,
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

  const previousClientId = Number(currentOrder.client_id || 0);
  if (previousClientFundUsedUsd > 0.005 && Number.isFinite(previousClientId) && previousClientId > 0) {
    await restoreClientFundToOrder(supabase, {
      clientId: previousClientId,
      orderId,
      amountUsd: previousClientFundUsedUsd,
      userId: user.id,
      notes: 'Restitución de fondo por edición de orden',
    });
  }

  if (clientFundUsedUsd > 0.005) {
    await applyClientFundToOrder(supabase, {
      clientId,
      orderId,
      amountUsd: clientFundUsedUsd,
      userId: user.id,
      notes: 'Fondo aplicado por edición de orden',
    });
  }

  const { error: updateOrderError } = await supabase
    .from('orders')
    .update(orderUpdatePayload)
    .eq('id', orderId);

  if (updateOrderError) {
    throw new Error(updateOrderError.message);
  }

  const { data: previousOrderItems, error: previousOrderItemsError } = await supabase
    .from('order_items')
    .select(`
      id,
      product_name_snapshot,
      unit_price_usd_snapshot,
      admin_price_override_usd,
      admin_price_override_reason,
      qty,
      line_total_usd
    `)
    .eq('order_id', orderId);

  if (previousOrderItemsError) {
    throw new Error(previousOrderItemsError.message);
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

  const previousOverrideSignatureCounts = new Map<string, number>();
  for (const previousItem of previousOrderItems ?? []) {
    if (previousItem.admin_price_override_usd == null) continue;
    const signature = buildOrderItemOverrideAuditSignature({
      productNameSnapshot: String(previousItem.product_name_snapshot || ''),
      unitPriceUsdSnapshot: Number(previousItem.unit_price_usd_snapshot || 0),
      adminPriceOverrideUsd: Number(previousItem.admin_price_override_usd || 0),
      adminPriceOverrideReason: previousItem.admin_price_override_reason ?? null,
      qty: Number(previousItem.qty || 0),
      lineTotalUsd: Number(previousItem.line_total_usd || 0),
    });
    previousOverrideSignatureCounts.set(
      signature,
      (previousOverrideSignatureCounts.get(signature) ?? 0) + 1
    );
  }

  const updateAdjustmentRows = input.items
    .map((item, idx) => {
      if (item.adminPriceOverrideUsd == null) return null;

      const signature = buildOrderItemOverrideAuditSignature(item);
      const previousCount = previousOverrideSignatureCounts.get(signature) ?? 0;
      if (previousCount > 0) {
        previousOverrideSignatureCounts.set(signature, previousCount - 1);
        return null;
      }

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

  if (currentOrder.status === 'delivered') {
    await resetDeliveredOrderInventoryDeductions(supabase, orderId);
    await applyDeliveredOrderInventoryDeductions(supabase, user.id, orderId);
  }

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

  const previousItemsSignature = stableStringify(
    (previousOrderItems ?? []).map((item) => ({
      product_name_snapshot: item.product_name_snapshot,
      qty: Number(item.qty || 0),
      line_total_usd: Number(item.line_total_usd || 0),
    })),
  );
  const nextItemsSignature = stableStringify(
    input.items.map((item) => ({
      product_name_snapshot: item.productNameSnapshot,
      qty: Number(item.qty || 0),
      line_total_usd: Number(item.lineTotalUsd || 0),
    })),
  );
  const itemsChanged = previousItemsSignature !== nextItemsSignature;
  const changeMeta = getChangeSectionsSummary({
    changedFields,
    itemsChanged,
  });

  if (changedFields.length > 0 || itemsChanged) {
    const eventContext = await loadOrderEventContext(supabase, orderId);
    await appendOrderEvent(supabase, {
      orderId,
      context: eventContext,
      eventType: 'order_modified',
      eventGroup: 'modification',
      title: currentOrder.status === 'queued' ? 'Orden modificada para re-aprobacion' : 'Orden modificada',
      message:
        changeMeta.summary.length > 0
          ? changeMeta.summary.join(' ')
          : 'Se realizaron cambios en la orden.',
      severity: currentOrder.status === 'queued' ? 'warning' : 'info',
      actorUserId: user.id,
      payload: {
        changed_sections: changeMeta.sections,
        change_summary: changeMeta.summary,
        reason: String(input.adminEditReason || '').trim() || null,
        queued_needs_reapproval: currentOrder.status === 'queued',
      },
      recipients: [
        { targetRole: 'master', requiresAction: currentOrder.status === 'queued' },
        { targetUserId: attributedAdvisorId },
      ],
    });
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
