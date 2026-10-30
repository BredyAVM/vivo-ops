export type RefreshRequest = {
  immediate?: boolean;
  // Polling can skip an in-flight read; a mutation/event must keep a follow-up.
  queueIfBusy?: boolean;
};

export function createRefreshCoordinator({
  refresh,
  canRefresh,
  schedule,
  cancel,
  debounceMs = 280,
}: {
  refresh: () => void;
  canRefresh: () => boolean;
  schedule: (callback: () => void, delayMs: number) => number;
  cancel: (timer: number) => void;
  debounceMs?: number;
}) {
  let busy = false;
  let active = true;
  let pending = false;
  let timer: number | null = null;

  function clearTimer() {
    if (timer !== null) cancel(timer);
    timer = null;
  }

  function flush() {
    clearTimer();
    if (!active || !pending || busy || !canRefresh()) return;
    pending = false;
    // Latch synchronously, before React commits its pending transition state.
    busy = true;
    try {
      refresh();
    } catch (error) {
      busy = false;
      pending = true;
      throw error;
    }
  }

  function request({ immediate = false, queueIfBusy = true }: RefreshRequest = {}) {
    if (!active) return;
    if (busy && !queueIfBusy) return;
    pending = true;
    if (!canRefresh()) {
      clearTimer();
      return;
    }
    if (busy) return;
    if (immediate) {
      flush();
    } else if (timer === null) {
      // A fixed window also prevents continuous events from starving refreshes.
      timer = schedule(flush, debounceMs);
    }
  }

  return {
    request,
    activate() {
      active = true;
    },
    setRefresh(callback: () => void) {
      refresh = callback;
    },
    setBusy(value: boolean) {
      busy = value;
      if (busy) clearTimer();
      else if (pending) request();
    },
    resume: flush,
    suspend: clearTimer,
    cancel() {
      clearTimer();
      pending = false;
      active = false;
    },
  };
}
