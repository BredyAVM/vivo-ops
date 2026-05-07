import webpush from 'web-push';
import { createClient } from '@supabase/supabase-js';

export type StoredPushSubscription = {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
};

type AdvisorPushTone = 'info' | 'warning' | 'critical' | 'success';
type UserPushTone = 'info' | 'warning' | 'critical' | 'success';

export const ADVISOR_PUSH_EVENT_TYPES = new Set([
  'order_approved',
  'order_returned_to_review',
  'order_reapproved',
  'order_changes_rejected',
  'order_changes_approved',
  'order_sent_to_kitchen',
  'kitchen_taken',
  'kitchen_eta_updated',
  'kitchen_delayed_prep',
  'order_ready',
  'pickup_ready',
  'driver_assigned',
  'out_for_delivery',
  'delivery_delayed',
  'pickup_collected',
  'order_delivered',
  'payment_confirmed',
  'payment_rejected',
]);

function safeText(value: unknown, fallback = '') {
  const text = String(value ?? '').trim();
  return text || fallback;
}

function eventPushTone(eventType: string): AdvisorPushTone {
  if (eventType === 'payment_rejected' || eventType === 'order_changes_rejected' || eventType === 'order_returned_to_review') {
    return 'critical';
  }
  if (eventType === 'payment_confirmed' || eventType === 'order_delivered' || eventType === 'pickup_collected') {
    return 'success';
  }
  if (eventType.includes('delayed') || eventType === 'driver_assigned' || eventType === 'out_for_delivery') {
    return 'warning';
  }
  return 'info';
}

function buildAdvisorPushCopy(input: {
  eventType: string;
  orderId: number;
  orderNumber?: string | null;
  clientName?: string | null;
  body?: string | null;
  payload?: Record<string, unknown> | null;
}) {
  const orderLabel = safeText(input.orderNumber, `Orden #${input.orderId}`);
  const clientName = safeText(input.clientName, 'Cliente');
  const payload = input.payload && typeof input.payload === 'object' ? input.payload : {};
  const reason = safeText(payload.reason ?? payload.review_notes ?? payload.notes ?? payload.note, '');
  const eta = safeText(payload.eta_minutes ?? payload.etaMinutes ?? payload.prep_eta_minutes, '');
  const driver = safeText(payload.driver_name ?? payload.driverName ?? payload.partner_name ?? payload.partnerName, '');

  const defaultLine = safeText(input.body, 'Tienes una actualizacion en una orden.');

  const map: Record<string, { title: string; body: string }> = {
    order_approved: {
      title: `${orderLabel} aprobada`,
      body: `${clientName}. La orden ya puede avanzar.`,
    },
    order_returned_to_review: {
      title: `${orderLabel} devuelta`,
      body: reason ? `${clientName}. Motivo: ${reason}` : `${clientName}. Revisa la orden.`,
    },
    order_reapproved: {
      title: `${orderLabel} re-aprobada`,
      body: `${clientName}. La orden volvio a aprobarse.`,
    },
    order_changes_rejected: {
      title: `${orderLabel} con cambios rechazados`,
      body: reason ? `${clientName}. Motivo: ${reason}` : `${clientName}. Revisa los cambios.`,
    },
    order_changes_approved: {
      title: `${orderLabel} con cambios aprobados`,
      body: `${clientName}. Los cambios ya fueron aceptados.`,
    },
    order_sent_to_kitchen: {
      title: `${orderLabel} en cocina`,
      body: `${clientName}. La orden fue enviada a cocina.`,
    },
    kitchen_taken: {
      title: `${orderLabel} tomada por cocina`,
      body: eta ? `${clientName}. Cocina marco ${eta} min.` : `${clientName}. Cocina ya la tomo.`,
    },
    kitchen_eta_updated: {
      title: `${orderLabel} con nuevo tiempo`,
      body: eta ? `${clientName}. Nuevo estimado: ${eta} min.` : `${clientName}. Se actualizo el tiempo.`,
    },
    kitchen_delayed_prep: {
      title: `${orderLabel} con retraso`,
      body: eta ? `${clientName}. Cocina reporta retraso. ETA ${eta} min.` : `${clientName}. Cocina reporta retraso.`,
    },
    order_ready: {
      title: `${orderLabel} preparada`,
      body: `${clientName}. La orden esta lista para salir.`,
    },
    pickup_ready: {
      title: `${orderLabel} lista para retiro`,
      body: `${clientName}. Ya puede retirarse.`,
    },
    driver_assigned: {
      title: `${orderLabel} con motorizado`,
      body: driver ? `${clientName}. Motorizado: ${driver}` : `${clientName}. Ya tiene motorizado asignado.`,
    },
    out_for_delivery: {
      title: `${orderLabel} en camino`,
      body: eta
        ? `${clientName}. Va en camino con ETA ${eta} min.`
        : driver
          ? `${clientName}. Va en camino con ${driver}.`
          : `${clientName}. La orden ya va en camino.`,
    },
    delivery_delayed: {
      title: `${orderLabel} con retraso en entrega`,
      body: eta ? `${clientName}. Nuevo ETA ${eta} min.` : `${clientName}. Se reporto retraso en entrega.`,
    },
    pickup_collected: {
      title: `${orderLabel} retirada`,
      body: `${clientName}. La orden ya fue retirada.`,
    },
    order_delivered: {
      title: `${orderLabel} entregada`,
      body: `${clientName}. La entrega se completo.`,
    },
    payment_confirmed: {
      title: `Pago confirmado ${orderLabel}`,
      body: `${clientName}. El pago quedo validado.`,
    },
    payment_rejected: {
      title: `Pago rechazado ${orderLabel}`,
      body: reason ? `${clientName}. Motivo: ${reason}` : `${clientName}. Debes reportar el pago de nuevo.`,
    },
  };

  const tone = eventPushTone(input.eventType);
  const copy = map[input.eventType] ?? {
    title: orderLabel,
    body: `${clientName}. ${defaultLine}`,
  };

  return {
    title: copy.title,
    body: copy.body,
    tone,
    requireInteraction: tone === 'critical',
    tag: `advisor-order-${input.orderId}-${input.eventType}`,
  };
}

function requireEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name} in environment.`);
  return value;
}

export function getPublicVapidKey() {
  return process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || '';
}

export function hasPushEnv() {
  return Boolean(
    process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY &&
      process.env.VAPID_PRIVATE_KEY &&
      process.env.VAPID_SUBJECT
  );
}

export function configureWebPush() {
  const publicKey = requireEnv('NEXT_PUBLIC_VAPID_PUBLIC_KEY');
  const privateKey = requireEnv('VAPID_PRIVATE_KEY');
  const subject = requireEnv('VAPID_SUBJECT');

  webpush.setVapidDetails(subject, publicKey, privateKey);
  return webpush;
}

function getServiceSupabase() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error('Missing SUPABASE_URL/NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in env.');
  }

  return createClient(url, key, {
    auth: { persistSession: false },
  });
}

function isMissingUserPushTable(message: string) {
  return /user_push_subscriptions/i.test(message) && /does not exist/i.test(message);
}

export async function sendPushToUserDevices(input: {
  userId: string;
  title: string;
  body: string;
  url: string;
  tag: string;
  tone?: UserPushTone;
  requireInteraction?: boolean;
}) {
  if (!hasPushEnv()) return { skipped: true, reason: 'missing_env' as const };

  const userId = String(input.userId || '').trim();
  if (!userId) return { skipped: true, reason: 'missing_user' as const };

  const supa = getServiceSupabase();
  const { data: rows, error } = await supa
    .from('user_push_subscriptions')
    .select('endpoint, p256dh, auth')
    .eq('user_id', userId)
    .eq('is_active', true);

  if (error) {
    if (isMissingUserPushTable(error.message)) {
      return { skipped: true, reason: 'missing_table' as const };
    }

    throw new Error(error.message);
  }

  if (!rows || rows.length === 0) {
    return { skipped: true, reason: 'no_subscriptions' as const };
  }

  const tone = input.tone ?? 'info';
  const webPush = configureWebPush();
  const payload = JSON.stringify({
    title: safeText(input.title, 'VIVO OPS'),
    body: safeText(input.body, 'Tienes una actualizacion nueva.'),
    url: safeText(input.url, '/app/master/dashboard'),
    tag: safeText(input.tag, 'vivo-notification'),
    tone,
    requireInteraction: Boolean(input.requireInteraction || tone === 'critical'),
  });

  const results = await Promise.allSettled(
    rows.map((row) =>
      webPush.sendNotification(
        {
          endpoint: String(row.endpoint),
          keys: {
            p256dh: String(row.p256dh),
            auth: String(row.auth),
          },
        },
        payload,
        {
          TTL: tone === 'critical' ? 300 : 120,
          urgency: tone === 'critical' ? 'high' : tone === 'warning' ? 'normal' : 'low',
          topic: safeText(input.tag, 'vivo-notification'),
        },
      ),
    ),
  );

  const invalidEndpoints = rows
    .filter((_, index) => {
      const result = results[index];
      if (!result || result.status !== 'rejected') return false;
      const statusCode = Number((result.reason as { statusCode?: number })?.statusCode || 0);
      return statusCode === 404 || statusCode === 410;
    })
    .map((row) => String(row.endpoint));

  if (invalidEndpoints.length > 0) {
    await supa
      .from('user_push_subscriptions')
      .update({ is_active: false })
      .in('endpoint', invalidEndpoints);
  }

  return {
    skipped: false,
    delivered: results.filter((result) => result.status === 'fulfilled').length,
    invalid: invalidEndpoints.length,
  };
}

export async function sendPushToRoleDevices(input: {
  roles: string[];
  title: string;
  body: string;
  url: string;
  tag: string;
  tone?: UserPushTone;
  requireInteraction?: boolean;
}) {
  if (!hasPushEnv()) return { skipped: true, reason: 'missing_env' as const };

  const roles = Array.from(
    new Set(
      input.roles
        .map((role) => String(role || '').trim())
        .filter(Boolean),
    ),
  );

  if (roles.length === 0) return { skipped: true, reason: 'missing_roles' as const };

  const supa = getServiceSupabase();
  const { data: rows, error } = await supa
    .from('user_roles')
    .select('user_id, role')
    .in('role', roles);

  if (error) throw new Error(error.message);

  const userIds = Array.from(new Set((rows ?? []).map((row) => String(row.user_id || '').trim()).filter(Boolean)));
  if (userIds.length === 0) return { skipped: true, reason: 'no_users' as const };

  const results = await Promise.allSettled(
    userIds.map((userId) =>
      sendPushToUserDevices({
        userId,
        title: input.title,
        body: input.body,
        url: input.url,
        tag: input.tag,
        tone: input.tone,
        requireInteraction: input.requireInteraction,
      }),
    ),
  );

  return {
    skipped: false,
    users: userIds.length,
    delivered: results.reduce((sum, result) => {
      if (result.status !== 'fulfilled' || result.value.skipped) return sum;
      return sum + Number(result.value.delivered || 0);
    }, 0),
  };
}

export async function sendPushToAdvisorDevices(input: {
  advisorUserId: string;
  orderId: number;
  eventType: string;
  title: string;
  body?: string | null;
  tag?: string | null;
  orderNumber?: string | null;
  clientName?: string | null;
  payload?: Record<string, unknown> | null;
}) {
  if (!hasPushEnv()) return { skipped: true, reason: 'missing_env' as const };
  if (!ADVISOR_PUSH_EVENT_TYPES.has(String(input.eventType || '').trim())) {
    return { skipped: true, reason: 'event_not_enabled' as const };
  }

  const supa = getServiceSupabase();
  const { data: rows, error } = await supa
    .from('advisor_push_subscriptions')
    .select('endpoint, p256dh, auth')
    .eq('user_id', input.advisorUserId)
    .eq('is_active', true);

  if (error) {
    throw new Error(error.message);
  }

  if (!rows || rows.length === 0) {
    return { skipped: true, reason: 'no_subscriptions' as const };
  }

  const webPush = configureWebPush();
  const copy = buildAdvisorPushCopy({
    eventType: input.eventType,
    orderId: input.orderId,
    orderNumber: input.orderNumber,
    clientName: input.clientName,
    body: input.body,
    payload: input.payload,
  });
  const payload = JSON.stringify({
    title: copy.title || input.title || 'VIVO OPS',
    body: copy.body || String(input.body || '').trim() || 'Tienes una actualizacion en una orden.',
    url: `/app/advisor/orders/${input.orderId}`,
    tag: String(input.tag || '').trim() || copy.tag,
    tone: copy.tone,
    requireInteraction: copy.requireInteraction,
  });

  const results = await Promise.allSettled(
    rows.map((row) =>
      webPush.sendNotification(
        {
          endpoint: String(row.endpoint),
          keys: {
            p256dh: String(row.p256dh),
            auth: String(row.auth),
          },
        },
        payload,
        {
          TTL: copy.requireInteraction ? 300 : 120,
          urgency:
            copy.tone === 'critical'
              ? 'high'
              : copy.tone === 'warning'
                ? 'normal'
                : 'low',
          topic: String(input.tag || '').trim() || copy.tag,
        },
      ),
    ),
  );

  const invalidEndpoints = rows
    .filter((_, index) => {
      const result = results[index];
      if (!result || result.status !== 'rejected') return false;
      const statusCode = Number((result.reason as { statusCode?: number })?.statusCode || 0);
      return statusCode === 404 || statusCode === 410;
    })
    .map((row) => String(row.endpoint));

  if (invalidEndpoints.length > 0) {
    await supa
      .from('advisor_push_subscriptions')
      .update({ is_active: false })
      .in('endpoint', invalidEndpoints);
  }

  return {
    skipped: false,
    delivered: results.filter((result) => result.status === 'fulfilled').length,
    invalid: invalidEndpoints.length,
  };
}

export function normalizePushSubscription(input: unknown): StoredPushSubscription | null {
  if (!input || typeof input !== 'object') return null;

  const data = input as Record<string, unknown>;
  const endpoint = String(data.endpoint || '').trim();
  const keys = data.keys && typeof data.keys === 'object' ? (data.keys as Record<string, unknown>) : null;
  const p256dh = String(keys?.p256dh || '').trim();
  const auth = String(keys?.auth || '').trim();

  if (!endpoint || !p256dh || !auth) return null;

  return {
    endpoint,
    keys: {
      p256dh,
      auth,
    },
  };
}
