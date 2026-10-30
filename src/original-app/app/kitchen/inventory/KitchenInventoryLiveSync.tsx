'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createSupabaseBrowser } from '@/lib/supabase/browser';

const REFRESH_DEBOUNCE_MS = 350;

export function KitchenInventoryLiveSync() {
  const router = useRouter();
  const [supabase] = useState(() => createSupabaseBrowser());

  useEffect(() => {
    let refreshTimer: number | null = null;
    const refresh = () => {
      if (refreshTimer != null) window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => {
        refreshTimer = null;
        router.refresh();
      }, REFRESH_DEBOUNCE_MS);
    };

    const channel = supabase
      .channel('kitchen-inventory-live')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'inventory_counts',
          filter: 'responsible_role=eq.kitchen',
        },
        refresh,
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'inventory_planned_flows',
          filter: 'flow_type=eq.expected_receipt',
        },
        refresh,
      )
      .subscribe();

    const onServiceWorkerMessage = (event: MessageEvent) => {
      const data = event.data && typeof event.data === 'object'
        ? event.data as { type?: string; payload?: { url?: string } }
        : null;
      if (data?.type !== 'vivo-push') return;
      if (!String(data.payload?.url || '').startsWith('/app/kitchen/inventory')) return;
      refresh();
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible' && navigator.onLine) refresh();
    };
    const onOnline = () => refresh();

    navigator.serviceWorker?.addEventListener('message', onServiceWorkerMessage);
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('online', onOnline);

    return () => {
      if (refreshTimer != null) window.clearTimeout(refreshTimer);
      navigator.serviceWorker?.removeEventListener('message', onServiceWorkerMessage);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('online', onOnline);
      void supabase.removeChannel(channel);
    };
  }, [router, supabase]);

  return null;
}
