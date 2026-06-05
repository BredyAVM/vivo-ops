'use server';

import { revalidatePath } from 'next/cache';
import { isAdvisorRole, isMasterOrAdminRole, requireAuthContext } from '@/lib/auth';
import { getOrderMoneySnapshot } from '@/lib/orders/order-money';
import { getPaymentReportRequirements, validatePaymentReportDetails } from '@/lib/payments/payment-report-rules';
import { sendPushToRoleDevices } from '@/lib/push';

type NotificationRole = 'admin' | 'master' | 'advisor' | 'kitchen' | 'driver';

const ADVISOR_REPORT_PAYMENT_METHODS = new Set(['payment_mobile', 'transfer', 'zelle']);

type OrderFinancialState = {
  total_usd: number | string | null;
  total_bs: number | string | null;
  snapshot_rate_bs_per_usd: number | string | null;
  confirmed_paid_usd: number | string | null;
  pending_reports_usd: number | string | null;
  pending_reports_bs_snapshot: number | string | null;
  pending_usd: number | string | null;
  pending_bs: number | string | null;
  collection_mode: string | null;
};

type OrderEventContext = {
  orderId: number;
  orderNumber: string | null;
  advisorUserId: string | null;
};

type OrderEventRecipientInput = {
  targetRole?: NotificationRole | null;
  targetUserId?: string | null;
  requiresAction?: boolean;
};

function toSafeNumber(value: unknown, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function roundMoney(value: unknown) {
  return Number(toSafeNumber(value, 0).toFixed(2));
}

function normalizeDateOnly(value: unknown) {
  const text = String(value || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function getCaracasDateString(value: Date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Caracas',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(value);
}

function dateOnlyFromIso(value: unknown) {
  const text = String(value || '').trim();
  if (!text) return null;

  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return null;

  return getCaracasDateString(date);
}

function getOrderDeliveryReferenceDate(order: { status?: unknown; extra_fields?: unknown }) {
  const extraFields =
    order.extra_fields && typeof order.extra_fields === 'object' && !Array.isArray(order.extra_fields)
      ? (order.extra_fields as Record<string, any>)
      : {};

  const completedAt = dateOnlyFromIso(extraFields.delivery?.completed_at);
  if (completedAt) return completedAt;

  if (String(order.status || '') !== 'delivered') return null;

  return normalizeDateOnly(extraFields.schedule?.date);
}

function canUseSnapshotForPaymentOperation(
  order: { status?: unknown; extra_fields?: unknown },
  operationDate: string | null
) {
  const deliveryDate = getOrderDeliveryReferenceDate(order);
  if (!deliveryDate) return true;

  const effectiveOperationDate = operationDate || getCaracasDateString(new Date());
  return effectiveOperationDate.localeCompare(deliveryDate) <= 0;
}

async function loadOrderFinancialState(
  supabase: Awaited<ReturnType<typeof requireAuthContext>>['supabase'],
  input: {
    orderId: number;
    operationDate?: string | null;
    activeBsRate?: number | null;
  }
) {
  const { data, error } = await (supabase as any).rpc('get_order_financial_state', {
    p_order_id: input.orderId,
    p_operation_date: input.operationDate || null,
    p_active_bs_rate: input.activeBsRate && input.activeBsRate > 0 ? input.activeBsRate : null,
  });

  if (error) {
    console.warn('get_order_financial_state skipped in advisor action', error.message);
    return null;
  }

  return (((data ?? []) as OrderFinancialState[])[0] ?? null);
}

function getSnapshotEquivalentUsdFromFinancialState(input: {
  state: OrderFinancialState | null;
  reportedAmount: number;
}) {
  const state = input.state;
  if (!state || state.collection_mode !== 'snapshot_quote') return null;

  const reportedAmount = roundMoney(input.reportedAmount);
  const pendingUsd = roundMoney(state.pending_usd);
  const pendingBs = roundMoney(state.pending_bs);
  const totalUsd = roundMoney(state.total_usd);
  const totalBs = roundMoney(state.total_bs);
  const snapshotRate = toSafeNumber(state.snapshot_rate_bs_per_usd, 0);

  if (pendingUsd > 0.005 && pendingBs > 0.005 && Math.abs(reportedAmount - pendingBs) <= 0.01) {
    return pendingUsd;
  }

  if (reportedAmount > 0 && pendingBs > 0.005 && reportedAmount < pendingBs && snapshotRate > 0) {
    return roundMoney(reportedAmount / snapshotRate);
  }

  if (totalUsd > 0.005 && totalBs > 0.005 && Math.abs(reportedAmount - totalBs) <= 0.01) {
    return totalUsd;
  }

  return null;
}

async function loadOrderEventContext(
  supabase: Awaited<ReturnType<typeof requireAuthContext>>['supabase'],
  orderId: number,
): Promise<OrderEventContext | null> {
  const { data, error } = await supabase
    .from('orders')
    .select('id, order_number, attributed_advisor_id')
    .eq('id', orderId)
    .maybeSingle();

  if (error || !data) return null;

  return {
    orderId: Number(data.id),
    orderNumber: data.order_number == null ? null : String(data.order_number),
    advisorUserId: data.attributed_advisor_id ?? null,
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

async function appendOrderEvent(
  supabase: Awaited<ReturnType<typeof requireAuthContext>>['supabase'],
  input: {
    orderId: number;
    eventType: string;
    eventGroup: string;
    title: string;
    message?: string | null;
    severity?: 'info' | 'warning' | 'critical';
    actorUserId?: string | null;
    payload?: Record<string, unknown>;
    context?: OrderEventContext | null;
    recipients?: OrderEventRecipientInput[];
  },
) {
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
    throw new Error(insertEventError?.message || 'No se pudo registrar el evento.');
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
    throw new Error(recipientsError.message);
  }

  const rolePushTargets = new Set<string>();
  for (const recipient of input.recipients ?? []) {
    if (!recipient.requiresAction) continue;
    if (recipient.targetRole === 'admin') rolePushTargets.add('admin');
    if (recipient.targetRole === 'master') {
      rolePushTargets.add('master');
      rolePushTargets.add('admin');
    }
  }

  if (rolePushTargets.size > 0) {
    try {
      const orderLabel = context?.orderNumber ? `Orden ${context.orderNumber}` : `Orden #${input.orderId}`;
      await sendPushToRoleDevices({
        roles: Array.from(rolePushTargets),
        title: `${orderLabel}: ${input.title}`,
        body: input.message || 'Requiere revision en el dashboard.',
        url: '/app/master/dashboard',
        tag: `master-order-${input.orderId}-${input.eventType}`,
        tone: input.severity === 'critical' ? 'critical' : input.severity === 'warning' ? 'warning' : 'info',
        requireInteraction: input.eventType === 'payment_reported' || input.severity === 'critical',
      });
    } catch (pushError) {
      console.warn(
        'advisor appendOrderEvent role push skipped',
        pushError instanceof Error ? pushError.message : 'unknown push error',
      );
    }
  }
}

export async function createAdvisorPaymentReportAction(input: {
  orderId: number;
  reportedMoneyAccountId: number;
  reportedCurrency: string;
  reportedAmount: number;
  reportedExchangeRateVesPerUsd: number | null;
  paymentMethod?: string | null;
  operationDate?: string | null;
  referenceCode: string | null;
  bankName?: string | null;
  payerName: string | null;
  notes: string | null;
}) {
  const ctx = await requireAuthContext();
  const isMasterOrAdmin = isMasterOrAdminRole(ctx.roles);
  if (!isAdvisorRole(ctx.roles) && !isMasterOrAdmin) {
    throw new Error('No autorizado.');
  }

  const orderId = Number(input.orderId || 0);
  if (!Number.isFinite(orderId) || orderId <= 0) {
    throw new Error('Orden invalida.');
  }

  const { data: order, error: orderError } = await ctx.supabase
    .from('orders')
    .select('id, attributed_advisor_id, status, total_usd, total_bs_snapshot, extra_fields')
    .eq('id', orderId)
    .maybeSingle();

  if (orderError || !order) {
    throw new Error(orderError?.message || 'No se pudo cargar la orden.');
  }

  if (!isMasterOrAdmin && order.attributed_advisor_id !== ctx.user.id) {
    throw new Error('No puedes reportar pagos para esta orden.');
  }

  const reportedMoneyAccountId = Number(input.reportedMoneyAccountId || 0);
  if (!Number.isFinite(reportedMoneyAccountId) || reportedMoneyAccountId <= 0) {
    throw new Error('Selecciona una cuenta.');
  }

  const reportedCurrency = String(input.reportedCurrency || '').trim().toUpperCase();
  const reportedAmount = toSafeNumber(input.reportedAmount, 0);
  const reportedExchangeRate =
    input.reportedExchangeRateVesPerUsd == null ? null : toSafeNumber(input.reportedExchangeRateVesPerUsd, 0);

  if (!reportedCurrency) throw new Error('Falta la moneda del reporte.');
  if (reportedAmount <= 0) throw new Error('El monto debe ser mayor a cero.');
  if (reportedCurrency === 'VES' && (!reportedExchangeRate || reportedExchangeRate <= 0)) {
    throw new Error('La tasa es obligatoria para reportes en bolivares.');
  }

  const { data: reportedAccount, error: reportedAccountError } = await ctx.supabase
    .from('money_accounts')
    .select('id, currency_code, is_active')
    .eq('id', reportedMoneyAccountId)
    .maybeSingle();

  if (reportedAccountError || !reportedAccount || !reportedAccount.is_active) {
    throw new Error(reportedAccountError?.message || 'La cuenta seleccionada no esta disponible.');
  }

  if (String(reportedAccount.currency_code || '').toUpperCase() !== reportedCurrency) {
    throw new Error('La moneda reportada no coincide con la cuenta seleccionada.');
  }

  const extraFields =
    order.extra_fields && typeof order.extra_fields === 'object' && !Array.isArray(order.extra_fields)
      ? (order.extra_fields as { payment?: { method?: unknown } })
      : {};
  const orderPaymentMethod = String(extraFields.payment?.method || '').trim();
  const shouldMatchOrderPaymentMethod = ADVISOR_REPORT_PAYMENT_METHODS.has(orderPaymentMethod);
  const requestedPaymentMethod = String(input.paymentMethod || '').trim();
  const effectivePaymentMethod = shouldMatchOrderPaymentMethod
    ? orderPaymentMethod
    : ADVISOR_REPORT_PAYMENT_METHODS.has(requestedPaymentMethod)
      ? requestedPaymentMethod
      : '';

  if (!effectivePaymentMethod) {
    throw new Error('Selecciona el método del pago reportado.');
  }

  if (
    !isMasterOrAdmin &&
    orderPaymentMethod &&
    orderPaymentMethod !== 'pending' &&
    orderPaymentMethod !== 'mixed' &&
    !shouldMatchOrderPaymentMethod
  ) {
    throw new Error('Este metodo de pago no puede ser reportado por asesor.');
  }

  let rulesQuery = ctx.supabase
    .from('money_account_payment_rules')
    .select('id')
    .eq('money_account_id', reportedMoneyAccountId)
    .eq('is_active', true)
    .eq('can_report_payment', true)
    .in('role', isMasterOrAdmin ? ['master', 'admin'] : ['advisor']);

  if (!isMasterOrAdmin) {
    rulesQuery = rulesQuery.in(
      'payment_method_code',
      [effectivePaymentMethod]
    );
  }

  const { data: allowedRules, error: allowedRulesError } = await rulesQuery.limit(1);

  if (allowedRulesError || !allowedRules || allowedRules.length === 0) {
    throw new Error(allowedRulesError?.message || 'No tienes permiso para reportar pagos en esta cuenta.');
  }

  const operationDate = String(input.operationDate || '').trim();
  const referenceCode = String(input.referenceCode || '').trim();
  const bankName = String(input.bankName || '').trim();
  const payerName = String(input.payerName || '').trim();
  const requirements = getPaymentReportRequirements(effectivePaymentMethod);
  const validationError = validatePaymentReportDetails({
    method: effectivePaymentMethod,
    operationDate,
    referenceCode,
    bankName,
    holderName: payerName,
  });

  if (validationError) {
    throw new Error(validationError);
  }

  const notesParts = [
    operationDate ? `Fecha operación: ${operationDate}` : null,
    requirements.requiresBank && bankName ? `Banco: ${bankName}` : null,
    requirements.requiresHolderName && payerName ? `Titular: ${payerName}` : null,
    input.notes ? String(input.notes).trim() : null,
  ].filter((part): part is string => Boolean(part));
  const reportNotes = notesParts.length > 0 ? notesParts.join('\n') : null;
  const reportPayerName = requirements.requiresBank ? bankName : payerName || null;
  let snapshotEquivalentUsd: number | null = null;

  if (reportedCurrency === 'VES') {
    const financialState = await loadOrderFinancialState(ctx.supabase, {
      orderId,
      operationDate: normalizeDateOnly(operationDate),
      activeBsRate: reportedExchangeRate,
    });
    snapshotEquivalentUsd = getSnapshotEquivalentUsdFromFinancialState({
      state: financialState,
      reportedAmount,
    });
  }

  const effectiveReportedExchangeRate =
    snapshotEquivalentUsd != null && snapshotEquivalentUsd > 0.005
      ? Number((reportedAmount / snapshotEquivalentUsd).toFixed(6))
      : reportedExchangeRate;

  const { error } = await ctx.supabase.rpc('create_payment_report', {
    p_order_id: orderId,
    p_reported_money_account_id: reportedMoneyAccountId,
    p_reported_currency: reportedCurrency,
    p_reported_amount: reportedAmount,
    p_reported_exchange_rate_ves_per_usd: effectiveReportedExchangeRate,
    p_reference_code: referenceCode || null,
    p_payer_name: reportPayerName,
    p_notes: reportNotes,
  });

  if (error) throw new Error(error.message);

  const eventContext = await loadOrderEventContext(ctx.supabase, orderId);
  await appendOrderEvent(ctx.supabase, {
    orderId,
    context: eventContext,
    eventType: 'payment_reported',
    eventGroup: 'payment',
    title: 'Pago reportado',
    message: 'El asesor envio un nuevo reporte de pago.',
    severity: 'warning',
    actorUserId: ctx.user.id,
    payload: {
      reported_money_account_id: reportedMoneyAccountId,
      reported_currency: reportedCurrency,
      reported_amount: reportedAmount,
      exchange_rate_ves_per_usd: reportedExchangeRate,
      payment_method: effectivePaymentMethod,
      operation_date: operationDate || null,
      reference_code: referenceCode || null,
      bank_name: bankName || null,
      payer_name: reportPayerName,
    },
    recipients: [
      { targetRole: 'master', requiresAction: true },
      { targetRole: 'admin', requiresAction: true },
      { targetUserId: eventContext?.advisorUserId },
    ],
  });

  revalidatePath(`/app/advisor/orders/${orderId}`);
  revalidatePath('/app/advisor/orders');
  revalidatePath('/app/advisor/payments');
  revalidatePath('/app/advisor/inbox');

  return { ok: true };
}

export async function loadAdvisorPaymentOptionsAction(input: {
  orderId: number;
}) {
  const ctx = await requireAuthContext();
  const isMasterOrAdmin = isMasterOrAdminRole(ctx.roles);
  if (!isAdvisorRole(ctx.roles) && !isMasterOrAdmin) {
    throw new Error('No autorizado.');
  }

  const orderId = Number(input.orderId || 0);
  if (!Number.isFinite(orderId) || orderId <= 0) {
    throw new Error('Orden invalida.');
  }

  const { data: order, error: orderError } = await ctx.supabase
    .from('orders')
    .select('id, attributed_advisor_id, status, extra_fields')
    .eq('id', orderId)
    .maybeSingle();

  if (orderError || !order) {
    throw new Error(orderError?.message || 'No se pudo cargar la orden.');
  }

  if (!isMasterOrAdmin && order.attributed_advisor_id !== ctx.user.id) {
    throw new Error('No puedes reportar pagos para esta orden.');
  }

  if (order.status === 'cancelled') {
    return { moneyAccounts: [] };
  }

  const extraFields =
    order.extra_fields && typeof order.extra_fields === 'object' && !Array.isArray(order.extra_fields)
      ? (order.extra_fields as { payment?: { method?: unknown } })
      : {};
  const orderPaymentMethod = String(extraFields.payment?.method || '').trim();
  const shouldMatchOrderPaymentMethod = ADVISOR_REPORT_PAYMENT_METHODS.has(orderPaymentMethod);

  const { data: rulesData, error: rulesError } = await ctx.supabase
    .from('money_account_payment_rules')
    .select('money_account_id, payment_method_code, can_report_payment, is_active')
    .eq('role', 'advisor')
    .eq('is_active', true)
    .eq('can_report_payment', true)
    .in(
      'payment_method_code',
      shouldMatchOrderPaymentMethod ? [orderPaymentMethod] : Array.from(ADVISOR_REPORT_PAYMENT_METHODS)
    );

  if (rulesError) {
    throw new Error(rulesError.message);
  }

  const reportMethodsByAccountId = new Map<number, string[]>();
  for (const rule of rulesData ?? []) {
    const accountId = Number(rule.money_account_id || 0);
    const method = String(rule.payment_method_code || '');
    if (!Number.isFinite(accountId) || accountId <= 0 || !ADVISOR_REPORT_PAYMENT_METHODS.has(method)) continue;

    const methods = reportMethodsByAccountId.get(accountId) ?? [];
    if (!methods.includes(method)) methods.push(method);
    reportMethodsByAccountId.set(accountId, methods);
  }

  const accountIds = Array.from(reportMethodsByAccountId.keys());
  if (accountIds.length === 0) {
    return { moneyAccounts: [] };
  }

  const { data: accountsData, error: accountsError } = await ctx.supabase
    .from('money_accounts')
    .select('id, name, currency_code, is_active')
    .eq('is_active', true)
    .in('id', accountIds)
    .order('name', { ascending: true });

  if (accountsError) {
    throw new Error(accountsError.message);
  }

  const moneyAccounts = (accountsData ?? [])
    .filter((account) => Boolean(account.is_active) && reportMethodsByAccountId.has(Number(account.id)))
    .map((account) => ({
      id: Number(account.id),
      name: String(account.name || 'Cuenta'),
      currencyCode: String(account.currency_code || 'USD'),
      isActive: Boolean(account.is_active),
      paymentMethodCodes: reportMethodsByAccountId.get(Number(account.id)) ?? [],
    }));

  return { moneyAccounts };
}

export async function requestClientFundApplicationAction(formData: FormData) {
  const ctx = await requireAuthContext();
  const isMasterOrAdmin = isMasterOrAdminRole(ctx.roles);
  if (!isAdvisorRole(ctx.roles) && !isMasterOrAdmin) {
    throw new Error('No autorizado.');
  }

  const orderId = Number(formData.get('orderId') || 0);
  const requestedAmountUsd = Number(
    toSafeNumber(String(formData.get('amountUsd') || '').replace(',', '.'), 0).toFixed(2)
  );
  const notes = String(formData.get('notes') || '').trim();

  if (!Number.isFinite(orderId) || orderId <= 0) {
    throw new Error('Orden invalida.');
  }

  if (!Number.isFinite(requestedAmountUsd) || requestedAmountUsd <= 0) {
    throw new Error('El monto del fondo no es valido.');
  }

  const { data: order, error: orderError } = await ctx.supabase
    .from('orders')
    .select('id, order_number, client_id, attributed_advisor_id, total_usd, status, extra_fields')
    .eq('id', orderId)
    .maybeSingle();

  if (orderError || !order) {
    throw new Error(orderError?.message || 'No se pudo cargar la orden.');
  }

  if (!isMasterOrAdmin && order.attributed_advisor_id !== ctx.user.id) {
    throw new Error('No puedes solicitar fondo para esta orden.');
  }

  if (order.status === 'cancelled') {
    throw new Error('No se puede aplicar fondo a una orden cancelada.');
  }

  const clientId = Number(order.client_id || 0);
  if (!Number.isFinite(clientId) || clientId <= 0) {
    throw new Error('La orden no tiene cliente asociado.');
  }

  const { data: client, error: clientError } = await ctx.supabase
    .from('clients')
    .select('id, full_name, fund_balance_usd')
    .eq('id', clientId)
    .maybeSingle();

  if (clientError || !client) {
    throw new Error(clientError?.message || 'No se pudo cargar el fondo del cliente.');
  }

  const availableFundUsd = Number(toSafeNumber(client.fund_balance_usd, 0).toFixed(2));
  if (availableFundUsd <= 0.005) {
    throw new Error('El cliente no tiene fondo disponible.');
  }

  const financialState = await loadOrderFinancialState(ctx.supabase, { orderId });
  let balanceUsd = financialState ? roundMoney(financialState.pending_usd) : 0;
  let pendingUsd = financialState ? roundMoney(financialState.pending_reports_usd) : 0;

  if (!financialState) {
    const { data: paymentReports, error: paymentReportsError } = await ctx.supabase
      .from('payment_reports')
      .select('status, reported_amount_usd_equivalent')
      .eq('order_id', orderId);

    if (paymentReportsError) {
      throw new Error(paymentReportsError.message);
    }

    const confirmedUsd =
      (paymentReports ?? [])
        .filter((report) => report.status === 'confirmed')
        .reduce((sum, report) => sum + toSafeNumber(report.reported_amount_usd_equivalent, 0), 0) +
      toSafeNumber((order.extra_fields as any)?.payment?.client_fund_used_usd, 0);
    pendingUsd = (paymentReports ?? [])
      .filter((report) => report.status === 'pending')
      .reduce((sum, report) => sum + toSafeNumber(report.reported_amount_usd_equivalent, 0), 0);
    const orderTotalUsd = getOrderMoneySnapshot(order).totalUsd;
    balanceUsd = Math.max(0, Number((orderTotalUsd - confirmedUsd).toFixed(2)));
  }

  const reportableBalanceUsd = Math.max(0, Number((balanceUsd - pendingUsd).toFixed(2)));
  const applicableAmountUsd = Number(
    Math.min(requestedAmountUsd, availableFundUsd, reportableBalanceUsd > 0 ? reportableBalanceUsd : balanceUsd).toFixed(2)
  );

  if (applicableAmountUsd <= 0.005) {
    throw new Error('Esta orden no tiene saldo disponible para aplicar fondo.');
  }

  const eventContext = await loadOrderEventContext(ctx.supabase, orderId);
  await appendOrderEvent(ctx.supabase, {
    orderId,
    context: eventContext,
    eventType: 'client_fund_application_requested',
    eventGroup: 'payment',
    title: 'Solicitud de pago con fondo',
    message: `El asesor solicita aplicar ${applicableAmountUsd.toFixed(2)} USD del fondo del cliente como pago de la orden.`,
    severity: 'warning',
    actorUserId: ctx.user.id,
    payload: {
      requested_amount_usd: applicableAmountUsd,
      available_fund_usd: availableFundUsd,
      order_balance_usd: balanceUsd,
      reportable_balance_usd: reportableBalanceUsd,
      client_id: clientId,
      client_name: client.full_name ?? null,
      notes: notes || null,
      source: 'advisor_mobile',
    },
    recipients: [
      { targetRole: 'master', requiresAction: true },
      { targetRole: 'admin', requiresAction: true },
      { targetUserId: eventContext?.advisorUserId },
    ],
  });

  revalidatePath(`/app/advisor/orders/${orderId}`);
  revalidatePath('/app/advisor/orders');
  revalidatePath('/app/advisor/payments');
  revalidatePath('/app/advisor/inbox');
  revalidatePath('/app/master/dashboard');
}

export async function cancelAdvisorOrderAction(formData: FormData) {
  const ctx = await requireAuthContext();
  if (!isAdvisorRole(ctx.roles) && !isMasterOrAdminRole(ctx.roles)) {
    throw new Error('No autorizado.');
  }

  const orderId = Number(formData.get('orderId') || 0);
  const reason = String(formData.get('reason') || '').trim();

  if (!Number.isFinite(orderId) || orderId <= 0) {
    throw new Error('Orden invalida.');
  }

  if (!reason) {
    throw new Error('Indica el motivo de cancelacion.');
  }

  const { data: order, error: orderError } = await ctx.supabase
    .from('orders')
    .select('id, order_number, attributed_advisor_id, status, notes, extra_fields')
    .eq('id', orderId)
    .maybeSingle();

  if (orderError || !order) {
    throw new Error(orderError?.message || 'No se pudo cargar la orden.');
  }

  const isMasterOrAdmin = isMasterOrAdminRole(ctx.roles);
  if (!isMasterOrAdmin && order.attributed_advisor_id !== ctx.user.id) {
    throw new Error('No puedes cancelar esta orden.');
  }

  if (!['created', 'queued'].includes(String(order.status || ''))) {
    throw new Error('El asesor solo puede cancelar ordenes creadas o en cola.');
  }

  const { data: paymentReports, error: paymentReportsError } = await ctx.supabase
    .from('payment_reports')
    .select('id')
    .eq('order_id', orderId)
    .in('status', ['pending', 'confirmed'])
    .limit(1);

  if (paymentReportsError) {
    throw new Error(paymentReportsError.message);
  }

  const clientFundUsedUsd = toSafeNumber((order.extra_fields as any)?.payment?.client_fund_used_usd, 0);
  if ((paymentReports ?? []).length > 0 || clientFundUsedUsd > 0.005) {
    throw new Error('Esta orden ya tiene dinero involucrado. Pide a master/admin que la cancele.');
  }

  const nextNotes = [
    String(order.notes || '').trim(),
    `CANCELADA POR ASESOR: ${reason}`,
  ]
    .filter(Boolean)
    .join(' | ');

  const { error: updateError } = await ctx.supabase
    .from('orders')
    .update({
      status: 'cancelled',
      review_notes: reason,
      notes: nextNotes,
      queued_needs_reapproval: false,
      queued_last_modified_at: null,
      queued_last_modified_by: null,
      last_modified_at: new Date().toISOString(),
      last_modified_by: ctx.user.id,
    })
    .eq('id', orderId);

  if (updateError) {
    throw new Error(updateError.message);
  }

  const eventContext = await loadOrderEventContext(ctx.supabase, orderId);
  await appendOrderEvent(ctx.supabase, {
    orderId,
    context: eventContext,
    eventType: 'order_cancelled',
    eventGroup: 'approval',
    title: 'Orden cancelada',
    message: reason,
    severity: 'warning',
    actorUserId: ctx.user.id,
    payload: {
      reason,
      cancelled_by_role: isMasterOrAdmin ? 'master_admin' : 'advisor',
      previous_status: order.status,
      source: 'advisor_mobile',
    },
    recipients: [
      { targetRole: 'master' },
      { targetRole: 'admin' },
      { targetUserId: eventContext?.advisorUserId },
    ],
  });

  revalidatePath(`/app/advisor/orders/${orderId}`);
  revalidatePath('/app/advisor');
  revalidatePath('/app/advisor/orders');
  revalidatePath('/app/advisor/inbox');
  revalidatePath('/app/master/dashboard');

  return { ok: true };
}
