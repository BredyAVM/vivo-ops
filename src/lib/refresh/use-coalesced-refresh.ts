'use client';

import { useCallback, useEffect, useState } from 'react';
import { createRefreshCoordinator, type RefreshRequest } from './refresh-coordinator';

export function useCoalescedRefresh(onRefresh: () => void, isRefreshing: boolean) {
  const [coordinator] = useState(() => createRefreshCoordinator({
    refresh: onRefresh,
    canRefresh: () => document.visibilityState === 'visible' && navigator.onLine,
    schedule: (callback, delayMs) => window.setTimeout(callback, delayMs),
    cancel: (timer) => window.clearTimeout(timer),
  }));

  useEffect(() => {
    coordinator.setRefresh(onRefresh);
  }, [coordinator, onRefresh]);

  useEffect(() => {
    coordinator.setBusy(isRefreshing);
  }, [coordinator, isRefreshing]);

  useEffect(() => {
    coordinator.activate();
    if (!navigator.onLine) coordinator.request();
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') coordinator.resume();
      else coordinator.suspend();
    };
    const onOnline = () => coordinator.resume();
    // Keep one reconciliation pending across a network gap, even if the
    // transport could not deliver an event while disconnected.
    const onOffline = () => coordinator.request();
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('focus', onOnline);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);

    return () => {
      coordinator.cancel();
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('focus', onOnline);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, [coordinator]);

  return useCallback((options?: RefreshRequest) => coordinator.request(options), [coordinator]);
}
