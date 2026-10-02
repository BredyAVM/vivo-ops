'use client';

import { useEffect } from 'react';
import { createSupabaseBrowser } from '@/lib/supabase/browser';
import { getOperationsServiceWorker, waitForOperationsWorker } from '@/lib/pwa/operations-push';

export default function AdminPwaRegistrar({ userId }: { userId: string }) {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    async function registerAndSync() {
      const registration = await waitForOperationsWorker(await getOperationsServiceWorker('admin'));
      if (controller.signal.aborted || !('PushManager' in window) || !('Notification' in window) ||
          Notification.permission !== 'granted') return;
      const subscription = await registration.pushManager.getSubscription();
      if (!subscription) return;
      const client = createSupabaseBrowser();
      const { data } = await client.auth.getSession();
      if (data.session?.user.id !== userId || controller.signal.aborted) return;
      await fetch('/api/push-subscriptions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({ accessToken: data.session.access_token, scope: 'admin', subscription: subscription.toJSON() }),
      });
    }
    void registerAndSync().catch(() => {
      // Installation/push failures never block an administrative operation.
    }).finally(() => clearTimeout(timeout));
    return () => { clearTimeout(timeout); controller.abort(); };
  }, [userId]);
  return null;
}
