import webpush from 'web-push';
import { createClient } from '@supabase/supabase-js';

export type StoredPushSubscription = {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
};

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

export async function sendPushToAdvisorDevices(input: {
  advisorUserId: string;
  orderId: number;
  eventType: string;
  title: string;
  body?: string | null;
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
  const payload = JSON.stringify({
    title: input.title || 'VIVO OPS',
    body: String(input.body || '').trim() || 'Tienes una actualizacion en una orden.',
    url: `/app/advisor/orders/${input.orderId}`,
    tag: `advisor-order-${input.orderId}`,
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
