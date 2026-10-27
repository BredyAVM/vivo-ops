import assert from 'node:assert/strict';
import test from 'node:test';
import { createRefreshCoordinator } from '../../src/lib/refresh/refresh-coordinator.ts';

function fixture() {
  let now = 0;
  let nextId = 0;
  let available = true;
  const calls: number[] = [];
  const timers = new Map<number, { at: number; callback: () => void }>();
  const coordinator = createRefreshCoordinator({
    refresh: () => { calls.push(now); },
    canRefresh: () => available,
    schedule(callback, delayMs) {
      const id = ++nextId;
      timers.set(id, { at: now + delayMs, callback });
      return id;
    },
    cancel: (id) => { timers.delete(id); },
  });
  return {
    coordinator, calls, timers,
    available(value: boolean) { available = value; },
    tick(ms: number) {
      const end = now + ms;
      for (;;) {
        const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > end) break;
        now = next[1].at;
        timers.delete(next[0]);
        next[1].callback();
      }
      now = end;
    },
  };
}

test('a burst becomes one read within 280ms, even if signals keep arriving', () => {
  const f = fixture();
  for (let i = 0; i < 14; i++) {
    f.coordinator.request();
    f.tick(20);
  }
  assert.deepEqual(f.calls, [280]);
});

test('events during a read produce exactly one follow-up, never overlapping reads', () => {
  const f = fixture();
  f.coordinator.request({ immediate: true });
  for (let i = 0; i < 100; i++) f.coordinator.request({ immediate: true });
  f.tick(10_000);
  assert.deepEqual(f.calls, [0]);
  f.coordinator.setBusy(true);
  f.coordinator.setBusy(false);
  f.tick(280);
  assert.deepEqual(f.calls, [0, 10_280]);
  f.coordinator.setBusy(false);
  f.tick(10_000);
  assert.equal(f.calls.length, 2);
});

test('a payment completion during an older read retains a fresh follow-up', () => {
  const f = fixture();
  f.coordinator.request({ immediate: true });
  f.tick(500);
  // Post-mutation refreshes use the default queueIfBusy, unlike timer polls.
  f.coordinator.request({ immediate: true });
  f.coordinator.setBusy(false);
  f.tick(280);
  assert.deepEqual(f.calls, [0, 780]);
});

test('periodic safety checks do not queue redundant reads while one is in flight', () => {
  const f = fixture();
  f.coordinator.request({ immediate: true });
  f.coordinator.request({ immediate: true, queueIfBusy: false });
  f.coordinator.setBusy(false);
  f.tick(1_000);
  assert.deepEqual(f.calls, [0]);
});

test('hidden/offline signals are retained and flushed once on return', () => {
  const f = fixture();
  f.available(false);
  for (let i = 0; i < 100; i++) f.coordinator.request({ immediate: true });
  f.tick(60_000);
  assert.equal(f.calls.length, 0);
  assert.equal(f.timers.size, 0);
  f.available(true);
  f.coordinator.resume();
  f.coordinator.resume();
  assert.deepEqual(f.calls, [60_000]);
});

test('hiding during the debounce defers the work rather than dropping it', () => {
  const f = fixture();
  f.coordinator.request();
  f.available(false);
  f.coordinator.suspend();
  f.tick(1_000);
  assert.equal(f.calls.length, 0);
  f.available(true);
  f.coordinator.resume();
  assert.deepEqual(f.calls, [1_000]);
});

test('resuming cannot overlap an existing read, and unmount cancels pending work', () => {
  const f = fixture();
  f.coordinator.request({ immediate: true });
  f.coordinator.request();
  f.coordinator.resume();
  assert.equal(f.calls.length, 1);
  f.coordinator.setBusy(false);
  f.coordinator.cancel();
  f.coordinator.request({ immediate: true });
  f.tick(1_000);
  f.coordinator.resume();
  assert.equal(f.calls.length, 1);
});

test('effect replay reactivates the coordinator without keeping cancelled work', () => {
  const f = fixture();
  f.coordinator.request();
  f.coordinator.cancel();
  f.coordinator.activate();
  f.tick(1_000);
  assert.equal(f.calls.length, 0);
  f.coordinator.request({ immediate: true });
  assert.deepEqual(f.calls, [1_000]);
});
