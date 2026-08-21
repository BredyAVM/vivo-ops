import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { sendPushToAdvisorDevices } from '@/lib/push';
import { readAdvisorCommissionWorkflowSnapshot } from './workflow-snapshot';

const COMMISSION_NOTIFICATION_DOMAIN = 'advisor_commissions';

export type AdvisorCommissionNotificationKind =
  | 'advisor_commission_review_ready'
  | 'advisor_commission_reconfirmation_required'
  | 'advisor_commission_payment_recorded'
  | 'advisor_commission_paid';

type NotificationMeta = Record<string, unknown>;

type ExistingNotificationRow = {
  id: number | string;
  status: string | null;
  read_at: string | null;
  meta: NotificationMeta | null;
};

type PeriodRow = {
  id: number | string;
  name: string | null;
};

type ClosureRow = {
  id: number | string;
  advisor_user_id: string;
  status: string;
  base_commission_pct: number | string | null;
  billed_usd: number | string | null;
  gross_commission_usd: number | string | null;
  pending_collection_usd: number | string | null;
  payable_usd: number | string | null;
  snapshot: unknown;
};

type ProfileRow = {
  id: string;
  receives_commissions: boolean | null;
};

function record(value: unknown): NotificationMeta {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as NotificationMeta)
    : {};
}

function numberValue(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function money(value: unknown) {
  return `$${numberValue(value).toFixed(2)}`;
}

function notificationFingerprint(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);
}

function commissionHref(periodId: number) {
  return `/app/advisor/commissions?period=${periodId}`;
}

async function findCommissionNotification(
  supabase: SupabaseClient,
  advisorUserId: string,
  dedupeKey: string,
) {
  const { data, error } = await supabase
    .from('notifications')
    .select('id, status, read_at, meta')
    .eq('recipient_user_id', advisorUserId)
    .contains('meta', {
      domain: COMMISSION_NOTIFICATION_DOMAIN,
      dedupe_key: dedupeKey,
    })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return (data ?? null) as ExistingNotificationRow | null;
}

async function upsertCommissionNotification(input: {
  supabase: SupabaseClient;
  advisorUserId: string;
  closureId: number;
  periodId: number;
  periodName: string;
  kind: AdvisorCommissionNotificationKind;
  dedupeKey: string;
  fingerprint: string;
  requiresAction: boolean;
  title: string;
  body: string;
  extraMeta?: NotificationMeta;
}) {
  const existing = await findCommissionNotification(
    input.supabase,
    input.advisorUserId,
    input.dedupeKey,
  );
  const existingMeta = record(existing?.meta);
  if (
    existing &&
    existingMeta.fingerprint === input.fingerprint &&
    existingMeta.kind === input.kind
  ) {
    return { changed: false, notificationId: Number(existing.id) };
  }

  const now = new Date().toISOString();
  const href = commissionHref(input.periodId);
  const meta = {
    ...input.extraMeta,
    domain: COMMISSION_NOTIFICATION_DOMAIN,
    kind: input.kind,
    dedupe_key: input.dedupeKey,
    fingerprint: input.fingerprint,
    requires_action: input.requiresAction,
    closure_id: input.closureId,
    period_id: input.periodId,
    period_name: input.periodName,
    href,
  };
  const payload = {
    recipient_user_id: input.advisorUserId,
    order_id: null,
    type: 'master_info',
    status: 'unread',
    title: input.title,
    body: input.body,
    created_at: now,
    read_at: null,
    meta,
  };

  let notificationId = 0;
  if (existing) {
    const { data, error } = await input.supabase
      .from('notifications')
      .update(payload)
      .eq('id', Number(existing.id))
      .eq('recipient_user_id', input.advisorUserId)
      .select('id')
      .single();

    if (error) throw new Error(error.message);
    notificationId = Number(data.id);
  } else {
    const { data, error } = await input.supabase
      .from('notifications')
      .insert(payload)
      .select('id')
      .single();

    if (error) throw new Error(error.message);
    notificationId = Number(data.id);
  }

  try {
    await sendPushToAdvisorDevices({
      advisorUserId: input.advisorUserId,
      orderId: input.closureId,
      eventType: input.kind,
      title: input.title,
      body: input.body,
      tag: input.dedupeKey,
      url: href,
      payload: meta,
    });
  } catch (error) {
    console.warn(
      'advisor commission push skipped',
      error instanceof Error ? error.message : 'unknown push error',
    );
  }

  return { changed: true, notificationId };
}

export async function notifyAdvisorCommissionPeriodReviewReady(input: {
  supabase: SupabaseClient;
  periodId: number;
}) {
  const [periodResult, closuresResult, profilesResult] = await Promise.all([
    input.supabase
      .from('advisor_commission_periods')
      .select('id, name')
      .eq('id', input.periodId)
      .single(),
    input.supabase
      .from('advisor_commission_closures')
      .select(
        'id, advisor_user_id, status, base_commission_pct, billed_usd, gross_commission_usd, pending_collection_usd, payable_usd, snapshot',
      )
      .eq('period_id', input.periodId)
      .eq('status', 'preliminary'),
    input.supabase
      .from('profiles')
      .select('id, receives_commissions')
      .eq('receives_commissions', true),
  ]);

  if (periodResult.error || !periodResult.data) {
    throw new Error(periodResult.error?.message || 'No se pudo cargar el periodo de comisiones.');
  }
  if (closuresResult.error) throw new Error(closuresResult.error.message);
  if (profilesResult.error) throw new Error(profilesResult.error.message);

  const period = periodResult.data as PeriodRow;
  const eligibleAdvisorIds = new Set(
    ((profilesResult.data ?? []) as ProfileRow[]).map((profile) => profile.id),
  );
  const closures = ((closuresResult.data ?? []) as ClosureRow[]).filter((closure) =>
    eligibleAdvisorIds.has(closure.advisor_user_id),
  );

  const results = await Promise.allSettled(
    closures.map((closure) => {
      const closureId = Number(closure.id);
      const workflow = readAdvisorCommissionWorkflowSnapshot(closure.snapshot);
      const needsReconfirmation = workflow.conformity.status === 'requires_reconfirmation';
      const kind: AdvisorCommissionNotificationKind = needsReconfirmation
        ? 'advisor_commission_reconfirmation_required'
        : 'advisor_commission_review_ready';
      const title = needsReconfirmation
        ? 'Tu liquidación requiere una nueva revisión'
        : 'Tu liquidación está lista para revisar';
      const periodName = String(period.name || `Periodo ${period.id}`);
      const body = needsReconfirmation
        ? `La liquidación de ${periodName} fue recalculada y quedó en ${money(closure.payable_usd)}. Revísala nuevamente antes de confirmar.`
        : `La liquidación de ${periodName} tiene un monto calculado de ${money(closure.payable_usd)}. Revisa el detalle antes de dar tu conformidad.`;
      const fingerprint = notificationFingerprint({
        kind,
        periodId: Number(period.id),
        baseCommissionPct: numberValue(closure.base_commission_pct),
        billedUsd: numberValue(closure.billed_usd),
        grossCommissionUsd: numberValue(closure.gross_commission_usd),
        pendingCollectionUsd: numberValue(closure.pending_collection_usd),
        payableUsd: numberValue(closure.payable_usd),
        snapshot: closure.snapshot,
      });

      return upsertCommissionNotification({
        supabase: input.supabase,
        advisorUserId: closure.advisor_user_id,
        closureId,
        periodId: Number(period.id),
        periodName,
        kind,
        dedupeKey: `commission-review:${closureId}`,
        fingerprint,
        requiresAction: true,
        title,
        body,
      });
    }),
  );

  const failures = results.filter((result) => result.status === 'rejected');
  if (failures.length > 0) {
    console.warn('advisor commission review notifications failed', failures.length);
  }

  return {
    attempted: results.length,
    delivered: results.filter((result) => result.status === 'fulfilled').length,
    failures: failures.length,
  };
}

export async function notifyAdvisorCommissionReconfirmationRequired(input: {
  supabase: SupabaseClient;
  advisorUserId: string;
  closureId: number;
  periodId: number;
  periodName: string;
  payableUsd: number;
  reason: string;
  snapshot: unknown;
}) {
  const title = 'Tu liquidación requiere una nueva revisión';
  const body = `La liquidación de ${input.periodName} fue reabierta para corregirla. Revísala nuevamente antes de confirmar.`;

  return upsertCommissionNotification({
    supabase: input.supabase,
    advisorUserId: input.advisorUserId,
    closureId: input.closureId,
    periodId: input.periodId,
    periodName: input.periodName,
    kind: 'advisor_commission_reconfirmation_required',
    dedupeKey: `commission-review:${input.closureId}`,
    fingerprint: notificationFingerprint({
      kind: 'advisor_commission_reconfirmation_required',
      payableUsd: input.payableUsd,
      reason: input.reason,
      snapshot: input.snapshot,
    }),
    requiresAction: true,
    title,
    body,
    extraMeta: { reason: input.reason },
  });
}

export async function resolveAdvisorCommissionReviewNotification(input: {
  supabase: SupabaseClient;
  advisorUserId: string;
  closureId: number;
}) {
  const dedupeKey = `commission-review:${input.closureId}`;
  const existing = await findCommissionNotification(
    input.supabase,
    input.advisorUserId,
    dedupeKey,
  );
  if (!existing) return { updated: false };

  const now = new Date().toISOString();
  const { error } = await input.supabase
    .from('notifications')
    .update({
      status: 'read',
      read_at: now,
      meta: {
        ...record(existing.meta),
        requires_action: false,
        resolved_at: now,
      },
    })
    .eq('id', Number(existing.id))
    .eq('recipient_user_id', input.advisorUserId);

  if (error) throw new Error(error.message);
  return { updated: true };
}

export async function notifyAdvisorCommissionPayment(input: {
  supabase: SupabaseClient;
  advisorUserId: string;
  closureId: number;
  periodId: number;
  periodName: string;
  movementId: number;
  amountUsd: number;
  remainingUsd: number;
  fullyPaid: boolean;
}) {
  const kind: AdvisorCommissionNotificationKind = input.fullyPaid
    ? 'advisor_commission_paid'
    : 'advisor_commission_payment_recorded';
  const title = input.fullyPaid
    ? 'Tu comisión fue pagada completamente'
    : 'Se registró un abono de tu comisión';
  const body = input.fullyPaid
    ? `Con el abono de ${money(input.amountUsd)}, la liquidación de ${input.periodName} quedó pagada completamente.`
    : `Se registró un abono de ${money(input.amountUsd)} para ${input.periodName}. Saldo pendiente: ${money(input.remainingUsd)}.`;

  return upsertCommissionNotification({
    supabase: input.supabase,
    advisorUserId: input.advisorUserId,
    closureId: input.closureId,
    periodId: input.periodId,
    periodName: input.periodName,
    kind,
    dedupeKey: `commission-payment:${input.movementId}`,
    fingerprint: notificationFingerprint({
      kind,
      movementId: input.movementId,
      amountUsd: input.amountUsd,
      remainingUsd: input.remainingUsd,
    }),
    requiresAction: false,
    title,
    body,
    extraMeta: {
      movement_id: input.movementId,
      amount_usd: input.amountUsd,
      remaining_usd: input.remainingUsd,
    },
  });
}
