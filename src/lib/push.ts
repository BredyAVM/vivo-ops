import webpush from 'web-push';

export type StoredPushSubscription = {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
};

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
