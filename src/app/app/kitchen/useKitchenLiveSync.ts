'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createSupabaseBrowser } from '@/lib/supabase/browser';

export type KitchenConnectionState = 'connecting' | 'live' | 'fallback' | 'offline';
export type KitchenRefreshReason =
  | 'kitchen-event'
  | 'operational-event'
  | 'inventory-event'
  | 'fallback'
  | 'resume'
  | 'online'
  | 'manual'
  | 'push'
  | 'action';

const REFRESH_DEBOUNCE_MS = 280;
const FALLBACK_REFRESH_MS = 20_000;
const LIVE_REPAIR_MS = 60_000;
const RESUME_REFRESH_MS = 5_000;
const SYNC_TICK_MS = 5_000;

export function useKitchenLiveSync(
  supabase: ReturnType<typeof createSupabaseBrowser>,
  onRefresh: (reason: KitchenRefreshReason) => void
) {
  const lastRefreshAtRef = useRef(0);
  const refreshTimerRef = useRef<number | null>(null);
  const pendingReasonRef = useRef<KitchenRefreshReason>('fallback');
  const [connectionState, setConnectionState] = useState<KitchenConnectionState>('connecting');
  const [lastRealtimeEventAt, setLastRealtimeEventAt] = useState<string | null>(null);

  const requestRefresh = useCallback((reason: KitchenRefreshReason, immediate = false) => {
    pendingReasonRef.current = reason;

    if (refreshTimerRef.current != null) {
      window.clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = null;
    }

    const run = () => {
      refreshTimerRef.current = null;
      lastRefreshAtRef.current = Date.now();
      onRefresh(pendingReasonRef.current);
    };

    if (immediate) {
      run();
      return;
    }

    refreshTimerRef.current = window.setTimeout(run, REFRESH_DEBOUNCE_MS);
  }, [onRefresh]);

  useEffect(() => {
    let disposed = false;
    let isLive = false;
    const processedRecipientIds = new Set<number>();

    const handleRecipient = (
      payload: { new?: Record<string, unknown> | null },
      reason: KitchenRefreshReason
    ) => {
      const recipientId = Number(payload.new?.id);
      if (Number.isFinite(recipientId) && processedRecipientIds.has(recipientId)) return;

      if (Number.isFinite(recipientId)) {
        processedRecipientIds.add(recipientId);
        if (processedRecipientIds.size > 400) {
          const newestIds = Array.from(processedRecipientIds).slice(-200);
          processedRecipientIds.clear();
          newestIds.forEach((id) => processedRecipientIds.add(id));
        }
      }

      setLastRealtimeEventAt(new Date().toISOString());
      requestRefresh(reason);
    };

    const handleInventoryEvent = () => {
      setLastRealtimeEventAt(new Date().toISOString());
      requestRefresh('inventory-event');
    };

    const channel = supabase
      .channel('kitchen-operational-events')
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'order_timeline_event_recipients',
          filter: 'target_role=eq.kitchen',
        },
        (payload) => handleRecipient(payload, 'kitchen-event')
      )
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'order_timeline_event_recipients',
          filter: 'target_role=eq.master',
        },
        (payload) => handleRecipient(payload, 'operational-event')
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'inventory_counts',
          filter: 'responsible_role=eq.kitchen',
        },
        handleInventoryEvent,
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'inventory_planned_flows',
          filter: 'flow_type=eq.expected_receipt',
        },
        handleInventoryEvent,
      )
      .subscribe((status) => {
        if (disposed) return;

        if (status === 'SUBSCRIBED') {
          isLive = true;
          setConnectionState(navigator.onLine ? 'live' : 'offline');
          requestRefresh('resume');
          return;
        }

        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          isLive = false;
          setConnectionState(navigator.onLine ? 'fallback' : 'offline');
        }
      });

    const refreshVisibleOrders = (reason: KitchenRefreshReason, minAgeMs: number) => {
      if (
        disposed ||
        document.visibilityState !== 'visible' ||
        !navigator.onLine ||
        Date.now() - lastRefreshAtRef.current < minAgeMs
      ) {
        return;
      }

      requestRefresh(reason, true);
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        refreshVisibleOrders('resume', RESUME_REFRESH_MS);
      }
    };
    const onFocus = () => refreshVisibleOrders('resume', RESUME_REFRESH_MS);
    const onOnline = () => {
      setConnectionState(isLive ? 'live' : 'connecting');
      refreshVisibleOrders('online', 0);
    };
    const onOffline = () => setConnectionState('offline');
    const intervalId = window.setInterval(() => {
      refreshVisibleOrders('fallback', isLive ? LIVE_REPAIR_MS : FALLBACK_REFRESH_MS);
    }, SYNC_TICK_MS);

    const initialOfflineTimerId = !navigator.onLine
      ? window.setTimeout(onOffline, 0)
      : null;
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('focus', onFocus);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);

    return () => {
      disposed = true;
      if (initialOfflineTimerId != null) window.clearTimeout(initialOfflineTimerId);
      if (refreshTimerRef.current != null) {
        window.clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
      window.clearInterval(intervalId);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      void supabase.removeChannel(channel);
    };
  }, [requestRefresh, supabase]);

  return {
    connectionState,
    lastRealtimeEventAt,
    requestRefresh,
  };
}
