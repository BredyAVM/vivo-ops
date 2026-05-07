'use server';

import { revalidatePath } from 'next/cache';
import { isAdvisorRole, isMasterOrAdminRole, requireAuthContext } from '@/lib/auth';
import { getPaymentReportRequirements, validatePaymentReportDetails } from '@/lib/payments/payment-report-rules';
import { sendPushToRoleDevices } from '@/lib/push';

type NotificationRole = 'admin' | 'master' | 'advisor' | 'kitchen' | 'driver';

const ADVISOR_REPORT_PAYMENT_METHODS = new Set(['payment_mobile', 'transfer', 'zelle']);

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
    .select('id, attributed_advisor_id, extra_fields')
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

  const { error } = await ctx.supabase.rpc('create_payment_report', {
    p_order_id: orderId,
    p_reported_money_account_id: reportedMoneyAccountId,
    p_reported_currency: reportedCurrency,
    p_reported_amount: reportedAmount,
    p_reported_exchange_rate_ves_per_usd: reportedExchangeRate,
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
