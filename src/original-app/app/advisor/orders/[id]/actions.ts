'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@supabase/supabase-js';
import { isAdvisorRole, isMasterOrAdminRole, requireAuthContext } from '@/lib/auth';
import { getOrderMoneySnapshot } from '@/lib/orders/order-money';
import { formatOrderDisplayLabel } from '@/lib/orders/order-labels';
import { assertNoActivePaymentDuplicate } from '@/lib/payments/payment-duplicates';
import {
  ADVISOR_PAYMENT_REPORT_METHOD_CODES,
  getPaymentReportRequirements,
  isAdvisorPaymentReportMethod,
  validatePaymentReportDetails,
} from '@/lib/payments/payment-report-rules';
import { sendPushToRoleDevices } from '@/lib/push';

type NotificationRole = 'admin' | 'master' | 'advisor' | 'kitchen' | 'counter' | 'driver';

function createSupabaseServiceRoleServer() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error('Falta configurar SUPABASE_SERVICE_ROLE_KEY para acciones administrativas.');
  }

  return createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

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

type AdvisorPaymentReportInput = {
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
};

type AdvisorPaymentReportResult = { ok: true } | { ok: false; message: string };

const MASTER_PING_COOLDOWN_MS = 3 * 60 * 1000;

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

function getAdvisorPaymentReportErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message.trim() : '';

  if (/not authenticated/i.test(message)) {
    return 'Tu sesión venció. Vuelve a iniciar sesión e intenta nuevamente.';
  }

  if (/advisor cannot report payments|no puedes reportar pagos/i.test(message)) {
    return 'Esta orden no está asignada a tu usuario asesor.';
  }

  if (/payment account is inactive|cuenta seleccionada no esta disponible/i.test(message)) {
    return 'La cuenta seleccionada ya no está disponible. Elige otra cuenta.';
  }

  const safePrefixes = [
    'No autorizado.',
    'Orden invalida.',
    'No se pudo cargar la orden.',
    'Selecciona una cuenta.',
    'Falta la moneda del reporte.',
    'El monto debe ser mayor a cero.',
    'La tasa es obligatoria',
    'La moneda reportada no coincide',
    'Selecciona el metodo',
    'Selecciona el método',
    'Este metodo de pago',
    'Este método de pago',
    'No tienes permiso para reportar pagos',
    'Debes indicar',
    'Posible pago duplicado:',
  ];

  if (safePrefixes.some((prefix) => message.startsWith(prefix))) {
    return message;
  }

  return 'No se pudo reportar el pago. Revisa los datos e intenta nuevamente.';
}

function parseRpcId(value: unknown) {
  const candidate = Array.isArray(value) ? value[0] : value;
  const parsed = Number(candidate);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

async function savePaymentReportOperationDate(reportId: unknown, operationDate: unknown) {
  const id = parseRpcId(reportId);
  const normalizedOperationDate = normalizeDateOnly(operationDate);

  if (!id || !normalizedOperationDate) return;

  const adminSupabase = createSupabaseServiceRoleServer();
  const { error } = await adminSupabase
    .from('payment_reports')
    .update({ operation_date: normalizedOperationDate })
    .eq('id', id);

  if (error) throw new Error(error.message);
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
      const orderLabel = formatOrderDisplayLabel(input.orderId);
      const pushResult = await sendPushToRoleDevices({
        roles: Array.from(rolePushTargets),
        title: `${orderLabel}: ${input.title}`,
        body: input.message || 'Requiere revision en el dashboard.',
        url: '/app/master/dashboard',
        tag: `master-order-${input.orderId}-${input.eventType}`,
        tone: input.severity === 'critical' ? 'critical' : input.severity === 'warning' ? 'warning' : 'info',
        requireInteraction: input.eventType === 'payment_reported' || input.severity === 'critical',
      });

      if (pushResult.skipped || Number(pushResult.delivered || 0) <= 0) {
        console.warn('advisor appendOrderEvent role push not delivered', JSON.stringify(pushResult));
      }
    } catch (pushError) {
      console.warn(
        'advisor appendOrderEvent role push skipped',
        pushError instanceof Error ? pushError.message : 'unknown push error',
      );
    }
  }
}

async function createAdvisorPaymentReport(input: AdvisorPaymentReportInput) {
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

  const requestedPaymentMethod = String(input.paymentMethod || '').trim();
  const effectivePaymentMethod = isAdvisorPaymentReportMethod(requestedPaymentMethod)
    ? requestedPaymentMethod
    : '';

  if (!effectivePaymentMethod) {
    throw new Error('Selecciona el método del pago reportado.');
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

  await assertNoActivePaymentDuplicate(ctx.supabase, {
    moneyAccountId: reportedMoneyAccountId,
    operationDate,
    currencyCode: reportedCurrency,
    amount: reportedAmount,
    referenceCode,
  });

  const { data: createdReportId, error } = await ctx.supabase.rpc('create_payment_report', {
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

  await savePaymentReportOperationDate(createdReportId, operationDate);

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

  return { ok: true as const };
}

export async function createAdvisorPaymentReportAction(
  input: AdvisorPaymentReportInput
): Promise<AdvisorPaymentReportResult> { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function loadAdvisorPaymentOptionsAction(input: {
  orderId: number;
}) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function requestClientFundApplicationAction(formData: FormData) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function pingMasterForAdvisorOrderAction(formData: FormData) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function cancelAdvisorOrderAction(formData: FormData) { throw new Error('All business actions are disabled in the CPU benchmark.'); }
