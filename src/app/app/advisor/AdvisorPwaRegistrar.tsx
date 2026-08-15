'use client';

import { useEffect } from 'react';
import { createSupabaseBrowser } from '@/lib/supabase/browser';

export default function AdvisorPwaRegistrar() {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;

    async function registerAndSyncPush() {
      const registration = await navigator.serviceWorker.register('/advisor-sw.js', {
        scope: '/app/advisor/',
        updateViaCache: 'none',
      });

      if (!('PushManager' in window) || !('Notification' in window) || Notification.permission !== 'granted') {
        return;
      }

      const subscription = await registration.pushManager.getSubscription();
      if (!subscription) return;

      const supabase = createSupabaseBrowser();
      const { data } = await supabase.auth.getSession();
      const accessToken = data.session?.access_token;
      if (!accessToken) return;

      await fetch('/api/advisor/push-subscriptions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accessToken,
          subscription: subscription.toJSON(),
        }),
      });
    }

    void registerAndSyncPush().catch(() => {
      // Push sync must never block the advisor workspace.
    });
  }, []);

  return null;
}
