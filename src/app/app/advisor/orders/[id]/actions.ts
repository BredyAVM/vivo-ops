'use server';

import { revalidatePath } from 'next/cache';
import { isAdvisorRole, isMasterOrAdminRole, requireAuthContext } from '@/lib/auth';

type NotificationRole = 'admin' | 'master' | 'advisor' | 'kitchen' | 'driver';

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
}

export async function createAdvisorPaymentReportAction(input: {
  orderId: number;
  reportedMoneyAccountId: number;
  reportedCurrency: string;
  reportedAmount: number;
  reportedExchangeRateVesPerUsd: number | null;
  referenceCode: string | null;
  payerName: string | null;
  notes: string | null;
}) {
  const ctx = await requireAuthContext();
  if (!isAdvisorRole(ctx.roles) && !isMasterOrAdminRole(ctx.roles)) {
    throw new Error('No autorizado.');
  }

  const orderId = Number(input.orderId || 0);
  if (!Number.isFinite(orderId) || orderId <= 0) {
    throw new Error('Orden invalida.');
  }

  const { data: order, error: orderError } = await ctx.supabase
    .from('orders')
    .select('id, attributed_advisor_id')
    .eq('id', orderId)
    .maybeSingle();

  if (orderError || !order) {
    throw new Error(orderError?.message || 'No se pudo cargar la orden.');
  }

  if (!isMasterOrAdminRole(ctx.roles) && order.attributed_advisor_id !== ctx.user.id) {
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

  const { error } = await ctx.supabase.rpc('create_payment_report', {
    p_order_id: orderId,
    p_reported_money_account_id: reportedMoneyAccountId,
    p_reported_currency: reportedCurrency,
    p_reported_amount: reportedAmount,
    p_reported_exchange_rate_ves_per_usd: reportedExchangeRate,
    p_reference_code: String(input.referenceCode || '').trim() || null,
    p_payer_name: String(input.payerName || '').trim() || null,
    p_notes: String(input.notes || '').trim() || null,
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
      reference_code: String(input.referenceCode || '').trim() || null,
      payer_name: String(input.payerName || '').trim() || null,
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
