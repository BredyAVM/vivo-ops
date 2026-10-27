import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { createRefreshCoordinator } from '../../src/lib/refresh/refresh-coordinator.ts';

// Execute the production hooks with deterministic browser, transport and React
// lifecycle boundaries. No database mutations or network requests are made.
function fixture(kind: 'kitchen' | 'advisor', initiallyOnline = true) {
  const require = createRequire(import.meta.url);
  let now = Date.parse('2026-10-27T12:00:00Z');
  let busy = false;
  let nextId = 0;
  let cursor = 0;
  let observedAt = new Date(now).toISOString();
  type Slot = { value?: unknown; deps?: unknown[]; cleanup?: () => void; setup?: () => void | (() => void) };
  const slots: Slot[] = [];
  let effects: Array<() => void> = [];
  const calls: number[] = [];
  const timers = new Map<number, { at: number; every?: number; callback: () => void }>();
  const listeners = new Map<string, Set<() => void>>();
  const eventTarget = {
    addEventListener(name: string, callback: () => void) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name)!.add(callback);
    },
    removeEventListener(name: string, callback: () => void) { listeners.get(name)?.delete(callback); },
  };
  function schedule(callback: () => void, ms: number, every?: number) {
    const id = ++nextId;
    timers.set(id, { at: now + ms, callback, every });
    return id;
  }
  const window = {
    ...eventTarget,
    setTimeout: (callback: () => void, ms: number) => schedule(callback, ms),
    clearTimeout: (id: number) => timers.delete(id),
    setInterval: (callback: () => void, ms: number) => schedule(callback, ms, ms),
    clearInterval: (id: number) => timers.delete(id),
  };
  const document = { ...eventTarget, visibilityState: 'visible' };
  const navigator = { onLine: initiallyOnline };
  const same = (a?: unknown[], b?: unknown[]) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const react = {
    useRef(value: unknown) {
      const index = cursor++;
      slots[index] ??= { value: { current: value } };
      return slots[index].value;
    },
    useState(initial: unknown) {
      const index = cursor++;
      slots[index] ??= { value: typeof initial === 'function' ? initial() : initial };
      return [slots[index].value, (value: unknown) => {
        slots[index].value = typeof value === 'function' ? value(slots[index].value) : value;
      }];
    },
    useCallback(callback: unknown, deps: unknown[]) {
      const index = cursor++;
      if (!same(slots[index]?.deps, deps)) slots[index] = { value: callback, deps };
      return slots[index].value;
    },
    useEffect(setup: Slot['setup'], deps: unknown[]) {
      const index = cursor++;
      if (same(slots[index]?.deps, deps)) return;
      effects.push(() => {
        slots[index]?.cleanup?.();
        slots[index] = { deps, setup, cleanup: setup?.() || undefined };
      });
    },
    useTransition: () => [busy, (action: () => void) => { busy = true; action(); }],
  };
  const channelHandlers: Array<{ filter: { table: string; filter?: string }; callback: (payload: unknown) => void }> = [];
  let status: (value: string) => void = () => {};
  let removed = 0;
  const channel = {
    on(_event: string, filter: { table: string; filter?: string }, callback: (payload: unknown) => void) {
      channelHandlers.push({ filter, callback });
      return channel;
    },
    subscribe(callback: typeof status) { status = callback; return channel; },
  };
  const supabase = { channel: () => channel, removeChannel: () => { removed++; } };
  const router = { refresh() { calls.push(now); } };
  const onRefresh = () => { busy = true; calls.push(now); };
  function load(path: string, imports: Record<string, unknown> = {}): Record<string, (...args: unknown[]) => typeof output> {
    const compiled = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const mod = { exports: {} };
    class ClockDate extends Date { static now() { return now; } }
    const boundaryRequire = (name: string) => {
      if (name === 'react') return react;
      if (name === 'next/navigation') return { useRouter: () => router };
      if (name in imports) return imports[name];
      return require(name);
    };
    new Function('require', 'module', 'exports', 'window', 'document', 'navigator', 'Date', compiled)(
      boundaryRequire, mod, mod.exports, window, document, navigator, ClockDate,
    );
    return mod.exports;
  }
  const coalesced = load('../../src/lib/refresh/use-coalesced-refresh.ts', {
    './refresh-coordinator': { createRefreshCoordinator },
  });
  const source = kind === 'kitchen'
    ? '../../src/app/app/kitchen/useKitchenLiveSync.ts'
    : '../../src/app/app/advisor/commissions/AdvisorGoalLiveRefresh.tsx';
  const loaded = load(source, { '@/lib/refresh/use-coalesced-refresh': coalesced });
  let output: { requestRefresh: (reason: string, immediate?: boolean) => void; props?: unknown };
  function render() {
    cursor = 0;
    output = kind === 'kitchen'
      ? loaded.useKitchenLiveSync(supabase, onRefresh, busy)
      : loaded.AdvisorGoalLiveRefresh({ observedAt });
    const pending = effects;
    effects = [];
    pending.forEach((effect) => effect());
  }
  render();
  function dispatch(name: string) {
    for (const callback of [...listeners.get(name) ?? []]) callback();
    render();
  }
  return {
    calls, timers, channelHandlers,
    complete() { busy = false; observedAt = new Date(now).toISOString(); render(); },
    status(value: string) { status(value); render(); },
    event(table: string, payload: unknown, filter?: string) {
      const handler = channelHandlers.find((item) => item.filter.table === table && (!filter || item.filter.filter === filter));
      assert.ok(handler, `Missing subscription: ${table} ${filter ?? ''}`);
      handler.callback(payload);
      render();
    },
    request(reason: string) { output.requestRefresh(reason, true); render(); },
    visible(value: boolean) { document.visibilityState = value ? 'visible' : 'hidden'; dispatch('visibilitychange'); },
    online(value: boolean) { navigator.onLine = value; dispatch(value ? 'online' : 'offline'); },
    focus() { dispatch('focus'); },
    manual() {
      function findButton(element: unknown): { onClick: () => void } | undefined {
        if (!element || typeof element !== 'object') return;
        const node = element as { type?: string; props?: { onClick?: () => void; children?: unknown } };
        if (node.type === 'button' && node.props?.onClick) return { onClick: node.props.onClick };
        const children = Array.isArray(node.props?.children) ? node.props.children : [node.props?.children];
        for (const child of children) {
          const match = findButton(child);
          if (match) return match;
        }
      }
      const button = findButton(output);
      assert.ok(button);
      button.onClick();
      render();
    },
    tick(ms: number) {
      const end = now + ms;
      for (;;) {
        const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > end) break;
        now = next[1].at;
        if (next[1].every) next[1].at += next[1].every;
        else timers.delete(next[0]);
        next[1].callback();
        render();
      }
      now = end;
    },
    unmount() {
      slots.forEach((slot) => slot.cleanup?.());
      assert.equal(timers.size, 0);
      assert.ok([...listeners.values()].every((set) => set.size === 0));
      if (kind === 'kitchen') assert.equal(removed, 1);
    },
  };
}

test('Kitchen keeps its 60s live safety check and 20s disconnected fallback', () => {
  const f = fixture('kitchen');
  f.status('SUBSCRIBED'); f.tick(280); f.complete();
  assert.equal(f.calls.length, 1);
  f.tick(60_000); assert.equal(f.calls.length, 1);
  f.tick(5_000); assert.equal(f.calls.length, 2);
  f.complete(); f.status('CHANNEL_ERROR');
  f.tick(15_000); assert.equal(f.calls.length, 2);
  f.tick(5_000); assert.equal(f.calls.length, 3);
  f.complete(); f.unmount();
});

test('Kitchen orders, master events and inventory keep prompt refreshes', () => {
  const f = fixture('kitchen');
  f.status('SUBSCRIBED'); f.tick(280); f.complete();
  for (const filter of ['target_role=eq.kitchen', 'target_role=eq.master']) {
    f.event('order_timeline_event_recipients', { new: { id: f.calls.length + 100 } }, filter);
    f.tick(280); f.complete();
  }
  for (const table of ['inventory_counts', 'inventory_planned_flows']) {
    f.event(table, { new: { id: 1 } }); f.tick(280); f.complete();
  }
  assert.equal(f.calls.length, 5);
  f.unmount();
});

test('Kitchen defers hidden signals and reconciles once immediately on return', () => {
  const f = fixture('kitchen');
  f.status('SUBSCRIBED'); f.tick(280); f.complete();
  f.visible(false);
  for (let id = 1; id <= 50; id++) f.event('order_timeline_event_recipients', { new: { id } });
  f.request('push'); f.tick(120_000);
  assert.equal(f.calls.length, 1);
  f.visible(true); f.focus();
  assert.equal(f.calls.length, 2);
  f.complete(); f.tick(280);
  assert.equal(f.calls.length, 2);
  f.unmount();
});

test('Kitchen retains new events during a read and immediate post-action updates', () => {
  const f = fixture('kitchen');
  f.status('SUBSCRIBED'); f.tick(280);
  for (let id = 1; id <= 50; id++) f.event('order_timeline_event_recipients', { new: { id } });
  f.tick(1_000); assert.equal(f.calls.length, 1);
  f.complete(); f.tick(280); assert.equal(f.calls.length, 2);
  f.complete(); f.request('action'); assert.equal(f.calls.length, 3);
  f.complete(); f.unmount();
});

test('Kitchen reconnects, duplicate recipients and offline events do not multiply reads', () => {
  const f = fixture('kitchen');
  f.status('SUBSCRIBED'); f.tick(280); f.complete();
  f.online(false);
  f.event('order_timeline_event_recipients', { new: { id: 7 } });
  f.event('order_timeline_event_recipients', { new: { id: 7 } });
  f.tick(60_000); assert.equal(f.calls.length, 1);
  f.online(true); assert.equal(f.calls.length, 2);
  f.complete(); f.tick(280); assert.equal(f.calls.length, 2);
  f.unmount();
});

test('Advisor idle refreshes drop from 30 to 12 per hour and skip hidden/offline work', () => {
  const f = fixture('advisor');
  for (let i = 0; i < 12; i++) { f.tick(300_000); f.complete(); }
  assert.equal(f.calls.length, 12);
  f.visible(false); f.tick(600_000); assert.equal(f.calls.length, 12);
  f.visible(true); f.focus(); assert.equal(f.calls.length, 13);
  f.complete(); f.online(false); f.tick(600_000); assert.equal(f.calls.length, 13);
  f.online(true); assert.equal(f.calls.length, 14);
  f.complete(); f.unmount();
});

test('a Kitchen view opened offline reconciles immediately when the network returns', () => {
  const f = fixture('kitchen', false);
  f.tick(10_000); assert.equal(f.calls.length, 0);
  f.online(true); assert.equal(f.calls.length, 1);
  f.complete(); f.tick(280); assert.equal(f.calls.length, 1);
  f.unmount();
});

test('Advisor manual refresh remains immediate and delays the next automatic read', () => {
  const f = fixture('advisor');
  f.tick(120_000); assert.equal(f.calls.length, 0);
  f.manual(); assert.equal(f.calls.length, 1);
  f.complete(); f.tick(270_000); assert.equal(f.calls.length, 1);
  f.tick(30_000); assert.equal(f.calls.length, 2);
  f.complete(); f.unmount();
});
