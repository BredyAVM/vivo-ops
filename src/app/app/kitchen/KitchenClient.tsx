'use client';

import { useEffect, useMemo, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { createSupabaseBrowser } from '@/lib/supabase/browser';
import { getWhatsAppLineUnits } from '@/lib/orders/whatsapp-summary';
import { ModulePreference } from '../ModulePreference';
import { kitchenTakeAction, markReadyAction, updateKitchenEtaAction } from '../master/dashboard/actions';

export type KitchenOrderItem = {
  id: number;
  qty: number;
  name: string;
  notes: string | null;
  unitsPerService: number;
};

export type KitchenOrder = {
  id: number;
  orderNumber: string;
  displayNumber: string;
  status: 'confirmed' | 'in_kitchen' | 'ready';
  clientName: string;
  clientPhone: string | null;
  fulfillment: 'pickup' | 'delivery';
  deliveryAddress: string | null;
  notes: string | null;
  createdAt: string;
  scheduledDate: string | null;
  scheduledTime: string | null;
  sentToKitchenAt: string | null;
  kitchenStartedAt: string | null;
  readyAt: string | null;
  etaMinutes: number | null;
  items: KitchenOrderItem[];
};

type KitchenClientProps = {
  publicVapidKey: string;
  fullName: string;
  orders: KitchenOrder[];
};

type PushState = 'checking' | 'unsupported' | 'denied' | 'ready' | 'subscribed' | 'error';

const STATUS_COLUMNS: Array<{
  key: KitchenOrder['status'];
  title: string;
  empty: string;
}> = [
  { key: 'confirmed', title: 'Cola', empty: 'Sin pedidos pendientes.' },
  { key: 'in_kitchen', title: 'Preparando', empty: 'Sin pedidos en preparación.' },
  { key: 'ready', title: 'Listos', empty: 'Sin pedidos listos.' },
];

const HIDDEN_DETAIL_PREFIX = '@sel|';
const PUSH_TIMEOUT_MS = 12000;
const ETA_PRESETS = [10, 15];

type KitchenDetailLine = {
  label: string;
  qty: number | null;
};

function urlBase64ToUint8Array(base64String: string) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  return Uint8Array.from(rawData, (char) => char.charCodeAt(0));
}

function subscriptionToJson(subscription: PushSubscription) {
  return subscription.toJSON() as {
    endpoint: string;
    keys: {
      p256dh: string;
      auth: string;
    };
  };
}

async function withTimeout<T>(promise: Promise<T>, message: string) {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), PUSH_TIMEOUT_MS);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

async function getAppServiceWorker() {
  const existing = await navigator.serviceWorker.getRegistration('/app/');
  if (existing) return existing;

  return navigator.serviceWorker.register('/vivo-sw.js', {
    scope: '/app/',
    updateViaCache: 'none',
  });
}

async function waitForActiveServiceWorker(registration: ServiceWorkerRegistration) {
  if (registration.active) return registration;
  const worker = registration.installing || registration.waiting;
  if (!worker) return navigator.serviceWorker.ready;

  await withTimeout(
    new Promise<void>((resolve, reject) => {
      const onStateChange = () => {
        if (worker.state === 'activated') {
          worker.removeEventListener('statechange', onStateChange);
          resolve();
        }
        if (worker.state === 'redundant') {
          worker.removeEventListener('statechange', onStateChange);
          reject(new Error('El servicio de notificaciones no pudo activarse.'));
        }
      };

      worker.addEventListener('statechange', onStateChange);
      onStateChange();
    }),
    'La app tardo demasiado en activar notificaciones.'
  );

  return navigator.serviceWorker.ready;
}

function formatDateTime(value: string | null) {
  if (!value) return 'Sin hora';

  return new Date(value).toLocaleString('es-VE', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: 'America/Caracas',
  });
}

function formatKitchenToday() {
  return new Date().toLocaleDateString('es-VE', {
    weekday: 'short',
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
    timeZone: 'America/Caracas',
  });
}

function scheduleLabel(order: KitchenOrder) {
  if (order.scheduledDate && order.scheduledTime) return `${order.scheduledDate} ${order.scheduledTime}`;
  if (order.scheduledDate) return order.scheduledDate;
  return formatDateTime(order.createdAt);
}

function statusTone(status: KitchenOrder['status']) {
  if (status === 'confirmed') return 'border-orange-400/40 bg-orange-400/10 text-orange-200';
  if (status === 'in_kitchen') return 'border-emerald-400/40 bg-emerald-400/10 text-emerald-200';
  return 'border-[#FEEF00]/50 bg-[#FEEF00]/10 text-[#FEEF00]';
}

function toNumber(value: unknown, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function formatQty(value: number) {
  if (Math.abs(value - Math.round(value)) < 0.001) return String(Math.round(value));
  return value.toLocaleString('es-VE', { maximumFractionDigits: 2 });
}

function floorKitchenPieces(value: number) {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

function extractUnitsPerService(name: string) {
  const match = name.match(/(\d+(?:[.,]\d+)?)\s*(?:und|uds|unidad(?:es)?|pzs?|piezas?)/i);
  if (!match) return 0;
  return toNumber(match[1].replace(',', '.'), 0);
}

function isNonKitchenLine(name: string) {
  return /\b(delivery|entrega|envio|envío)\b/i.test(name);
}

function isKitchenAccessoryLine(name: string) {
  return /\b(salsa|salsas|refresco|refrescos|bebida|bebidas|agua|jugo|jugos|malta|coca|pepsi|chinotto|papel[oÃ³]n|tequechicha)\b/i.test(name);
}

function isKitchenPreparedLine(name: string) {
  return !isNonKitchenLine(name) && !isKitchenAccessoryLine(name);
}

function getItemUnits(item: KitchenOrderItem) {
  if (isNonKitchenLine(item.name)) return 0;
  const lineUnits = getWhatsAppLineUnits({
    qty: item.qty,
    name: item.name,
    unitsPerService: item.unitsPerService,
  });
  if (lineUnits != null) return lineUnits;

  const unitsPerService = extractUnitsPerService(item.name);
  if (unitsPerService > 0) return floorKitchenPieces(item.qty * unitsPerService);
  return item.qty;
}

function parseDetailLines(notes: string | null): KitchenDetailLine[] {
  return String(notes || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith(HIDDEN_DETAIL_PREFIX))
    .map((line) => {
      const match = line.match(/^(\d+(?:[.,]\d+)?)\s+(.+)$/);
      if (!match) return { label: line, qty: null };
      return {
        label: match[2].trim(),
        qty: floorKitchenPieces(toNumber(match[1].replace(',', '.'), 0)),
      };
    });
}

function getItemPreparedUnits(item: KitchenOrderItem) {
  if (!isKitchenPreparedLine(item.name)) return 0;

  const detailUnits = parseDetailLines(item.notes).reduce((sum, line) => {
    if (line.qty == null || !isKitchenPreparedLine(line.label)) return sum;
    return sum + line.qty;
  }, 0);
  if (detailUnits > 0) return detailUnits;
  return getItemUnits(item);
}

function elapsedMinutes(value: string | null, nowMs = Date.now()) {
  if (!value) return null;
  const startedAt = new Date(value).getTime();
  if (!Number.isFinite(startedAt)) return null;
  return Math.max(0, Math.floor((nowMs - startedAt) / 60000));
}

function remainingPrepMinutes(order: KitchenOrder, nowMs = Date.now()) {
  if (order.status !== 'in_kitchen' || !order.kitchenStartedAt || !order.etaMinutes) return null;
  const startedAt = new Date(order.kitchenStartedAt).getTime();
  if (!Number.isFinite(startedAt)) return null;
  return Math.ceil((startedAt + order.etaMinutes * 60000 - nowMs) / 60000);
}

function etaClockLabel(order: KitchenOrder) {
  if (order.status !== 'in_kitchen' || !order.kitchenStartedAt || !order.etaMinutes) return null;
  const startedAt = new Date(order.kitchenStartedAt).getTime();
  if (!Number.isFinite(startedAt)) return null;
  const dueAt = new Date(startedAt + order.etaMinutes * 60000);
  return dueAt.toLocaleTimeString('es-VE', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: 'America/Caracas',
  });
}

function playKitchenAlert() {
  try {
    const AudioContextCtor = window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextCtor) return;
    const ctx = new AudioContextCtor();
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();

    oscillator.type = 'square';
    oscillator.frequency.setValueAtTime(880, ctx.currentTime);
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.42);
    oscillator.connect(gain);
    gain.connect(ctx.destination);
    oscillator.start();
    oscillator.stop(ctx.currentTime + 0.45);
    setTimeout(() => void ctx.close().catch(() => undefined), 650);
  } catch {
    // Browsers can block audio until the user interacts with the page.
  }
}

export default function KitchenClient({ publicVapidKey, fullName, orders }: KitchenClientProps) {
  const router = useRouter();
  const supabase = useMemo(() => createSupabaseBrowser(), []);
  const [isPending, startTransition] = useTransition();
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [etaByOrder, setEtaByOrder] = useState<Record<number, string>>({});
  const [activeStatus, setActiveStatus] = useState<KitchenOrder['status']>('confirmed');
  const [currentTimeMs, setCurrentTimeMs] = useState(() => Date.now());
  const [pushState, setPushState] = useState<PushState>('checking');
  const [pushBusy, setPushBusy] = useState(false);

  useEffect(() => {
    const intervalId = window.setInterval(() => setCurrentTimeMs(Date.now()), 30000);
    return () => window.clearInterval(intervalId);
  }, []);

  useEffect(() => {
    async function bootPushState() {
      if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
        setPushState('unsupported');
        return;
      }
      if (!publicVapidKey) {
        setPushState('error');
        return;
      }
      if (Notification.permission === 'denied') {
        setPushState('denied');
        return;
      }

      try {
        const registration = await waitForActiveServiceWorker(await getAppServiceWorker());
        const currentSubscription = await withTimeout(
          registration.pushManager.getSubscription(),
          'La app tardo demasiado en revisar alertas.'
        );
        setPushState(currentSubscription ? 'subscribed' : 'ready');
      } catch {
        setPushState('error');
      }
    }

    void bootPushState();
  }, [publicVapidKey]);

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;

    const onMessage = (event: MessageEvent) => {
      const data = event.data && typeof event.data === 'object' ? event.data as { type?: string; payload?: { url?: string; tone?: string } } : null;
      if (data?.type !== 'vivo-push') return;
      if (data.payload?.url !== '/app/kitchen') return;
      if (data.payload?.tone === 'critical') playKitchenAlert();
      router.refresh();
    };

    navigator.serviceWorker.addEventListener('message', onMessage);
    return () => navigator.serviceWorker.removeEventListener('message', onMessage);
  }, [router]);

  const ordersByStatus = useMemo(() => {
    return new Map(
      STATUS_COLUMNS.map((column) => [
        column.key,
        orders.filter((order) => order.status === column.key),
      ])
    );
  }, [orders]);

  const totalPreparing = ordersByStatus.get('in_kitchen')?.length ?? 0;
  const totalPending = ordersByStatus.get('confirmed')?.length ?? 0;
  const totalReady = ordersByStatus.get('ready')?.length ?? 0;
  const activeColumn = STATUS_COLUMNS.find((column) => column.key === activeStatus) ?? STATUS_COLUMNS[0];
  const activeOrders = ordersByStatus.get(activeColumn.key) ?? [];
  const todayLabel = formatKitchenToday();

  const runAction = (key: string, action: () => Promise<void>) => {
    setPendingKey(key);
    setErrorMessage(null);
    startTransition(async () => {
      try {
        await action();
        router.refresh();
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : 'No se pudo completar la acción.');
      } finally {
        setPendingKey(null);
      }
    });
  };

  async function getAccessToken() {
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token || '';
  }

  async function enablePush() {
    setPushBusy(true);
    setErrorMessage(null);

    try {
      if (!publicVapidKey) throw new Error('Falta configurar alertas push.');
      const permission = await Notification.requestPermission();
      if (permission === 'denied') {
        setPushState('denied');
        throw new Error('El navegador bloqueo las notificaciones.');
      }

      const registration = await waitForActiveServiceWorker(await getAppServiceWorker());
      let subscription = await withTimeout(
        registration.pushManager.getSubscription(),
        'La app tardo demasiado en revisar alertas.'
      );
      if (!subscription) {
        subscription = await withTimeout(
          registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(publicVapidKey),
          }),
          'La suscripcion push tardo demasiado.'
        );
      }

      const response = await withTimeout(
        fetch('/api/push-subscriptions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            accessToken: await getAccessToken(),
            scope: 'kitchen',
            subscription: subscriptionToJson(subscription),
          }),
        }),
        'Guardar las alertas tardo demasiado.'
      );

      if (!response.ok) {
        const payload = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(payload?.error || 'No se pudo guardar este dispositivo.');
      }

      playKitchenAlert();
      setPushState('subscribed');
    } catch (error) {
      setPushState((current) => current === 'denied' ? 'denied' : 'error');
      setErrorMessage(error instanceof Error ? error.message : 'No se pudo activar alertas.');
    } finally {
      setPushBusy(false);
    }
  }

  return (
    <main className="min-h-screen bg-[#08090D] text-[#F5F5F7]">
      <ModulePreference moduleKey="kitchen" />
      <div className="mx-auto flex min-h-screen w-full max-w-[640px] flex-col px-2.5 py-2 sm:px-3">
        <header className="sticky top-0 z-30 -mx-3 border-b border-[#242433] bg-[#08090D]/95 px-3 pb-3 pt-3 backdrop-blur sm:-mx-4 sm:px-4">
          <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-xs uppercase tracking-[0.18em] text-[#8A8A96]">VIVO OPS</div>
              <h1 className="mt-1 text-xl font-semibold leading-tight">Cocina</h1>
              <div className="mt-0.5 text-xs text-[#B7B7C2]">{fullName || 'Operación de cocina'}</div>
              <div className="mt-1 inline-flex rounded-full border border-[#303041] bg-[#0B0B10] px-2 py-0.5 text-xs font-semibold text-[#F5F5F7]">
                Hoy {todayLabel}
              </div>
          </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  if (pushState !== 'subscribed') void enablePush();
                }}
                disabled={pushBusy || pushState === 'unsupported' || pushState === 'subscribed'}
                className={[
                  'h-10 rounded-xl border px-3 text-xs font-semibold active:scale-[0.98] disabled:opacity-70',
                  pushState === 'subscribed'
                    ? 'border-emerald-400/40 bg-emerald-400/10 text-emerald-200'
                    : 'border-[#FEEF00]/40 bg-[#FEEF00]/10 text-[#FEEF00]',
                ].join(' ')}
              >
                {pushBusy ? 'Activando...' : pushState === 'subscribed' ? 'Alertas ON' : 'Alertas'}
              </button>
              <button
                type="button"
                onClick={() => router.refresh()}
                className="h-10 rounded-xl border border-[#2A2A38] bg-[#121218] px-3 text-xs font-semibold text-[#F5F5F7] active:scale-[0.98]"
              >
                Actualizar
              </button>
            <Link
              href="/app"
                className="flex h-10 items-center rounded-xl border border-[#2A2A38] bg-[#121218] px-3 text-xs font-semibold text-[#F5F5F7]"
            >
                Módulo
            </Link>
            </div>
          </div>

          <nav className="mt-2 grid grid-cols-3 gap-2">
            {STATUS_COLUMNS.map((column) => {
              const count = ordersByStatus.get(column.key)?.length ?? 0;
              const active = activeStatus === column.key;
              const tone = column.key === 'confirmed' ? 'warn' : column.key === 'in_kitchen' ? 'ok' : 'brand';
              return (
                <StatusTab
                  key={column.key}
                  label={column.key === 'in_kitchen' ? 'Prep.' : column.title}
                  value={count}
                  tone={tone}
                  active={active}
                  onClick={() => setActiveStatus(column.key)}
                />
              );
            })}
          </nav>
        </header>

        {errorMessage ? (
          <div className="mt-3 rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-100">
            {errorMessage}
          </div>
        ) : null}

        <section className="flex-1 py-2">
          <div className="mb-2 flex items-center justify-between gap-3 px-1">
            <h2 className="text-base font-semibold">{activeColumn.title}</h2>
            <span className={`rounded-full border px-2.5 py-1 text-xs font-semibold ${statusTone(activeColumn.key)}`}>
              {activeOrders.length}
            </span>
          </div>

          <div className="space-y-3">
            {activeOrders.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-[#2A2A38] bg-[#101018] px-4 py-10 text-center text-sm text-[#8A8A96]">
                {activeColumn.empty}
              </div>
            ) : null}

            {activeOrders.map((order, orderIndex) => {
                    const takeActionKey = `take:${order.id}`;
              const delayActionKey = `delay:${order.id}`;
                    const readyActionKey = `ready:${order.id}`;
                    const etaValue = etaByOrder[order.id] ?? String(order.etaMinutes || 15);
              const totalUnits = order.items.reduce((sum, item) => sum + getItemPreparedUnits(item), 0);
              const elapsed =
                order.status === 'confirmed'
                  ? elapsedMinutes(order.sentToKitchenAt || order.createdAt, currentTimeMs)
                  : order.status === 'in_kitchen'
                    ? elapsedMinutes(order.kitchenStartedAt, currentTimeMs)
                    : elapsedMinutes(order.readyAt, currentTimeMs);
              const readyTime = etaClockLabel(order);
              const remainingMinutes = remainingPrepMinutes(order, currentTimeMs);

                    return (
                <article
                  key={order.id}
                  className={[
                    'rounded-xl border p-2.5 shadow-[0_12px_28px_rgba(0,0,0,0.16)]',
                    orderIndex % 2 === 0
                      ? 'border-[#2A2A38] bg-[#101018]'
                      : 'border-[#56566A] bg-[#282834] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.05),0_12px_28px_rgba(0,0,0,0.18)]',
                  ].join(' ')}
                >
                        <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-xl font-black leading-none tracking-tight text-[#FEEF00]">
                        Orden #{order.displayNumber}
                      </div>
                      <div className="mt-1 truncate text-base font-semibold text-[#F5F5F7]">{order.clientName}</div>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-[#B7B7C2]">
                        <span className="rounded-full border border-[#303041] bg-[#0B0B10] px-2 py-0.5">
                          {order.fulfillment === 'delivery' ? 'Delivery' : 'Pickup'}
                        </span>
                        <span className="rounded-full border border-[#303041] bg-[#0B0B10] px-2 py-0.5">
                          {scheduleLabel(order)}
                        </span>
                        {elapsed != null ? (
                          <span className="rounded-full border border-[#303041] bg-[#0B0B10] px-2 py-0.5">
                            {elapsed} min
                          </span>
                        ) : null}
                          </div>
                    </div>
                    <div className="shrink-0 text-right">
                      <span className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${statusTone(order.status)}`}>
                        {activeColumn.title}
                          </span>
                      <div className="mt-1 text-2xl font-black text-[#F5F5F7]">{formatQty(totalUnits)}</div>
                      <div className="text-[10px] uppercase tracking-[0.12em] text-[#8A8A96]">piezas</div>
                        </div>
                  </div>

                  {readyTime ? (
                    <div className="mt-2 rounded-lg border border-emerald-400/30 bg-emerald-400/10 px-2.5 py-1.5 text-sm font-semibold text-emerald-200">
                      Lista aprox. {readyTime}
                          </div>
                  ) : null}

                        {order.deliveryAddress ? (
                    <div className="mt-2 rounded-lg border border-[#242433] bg-[#0B0B10] px-2.5 py-1.5 text-xs text-[#B7B7C2]">
                            {order.deliveryAddress}
                          </div>
                        ) : null}

                  {order.notes?.trim() ? (
                    <div className="mt-2 rounded-lg border border-orange-400/30 bg-orange-400/10 px-2.5 py-1.5 text-xs font-semibold text-orange-100">
                      Nota: {order.notes.trim()}
                    </div>
                  ) : null}

                        <div className="mt-2 space-y-1.5">
                    {order.items.map((item) => {
                      const detailLines = parseDetailLines(item.notes);
                      const hasComponentDetails = detailLines.some((line) => line.qty != null);
                      const itemUnits = hasComponentDetails ? 0 : getItemUnits(item);
                      return (
                        <div key={item.id} className="rounded-lg border border-[#242433] bg-[#0B0B10] px-2.5 py-2">
                          <div className="flex items-start gap-2.5">
                            {itemUnits > 0 ? (
                              <div className="w-[76px] shrink-0 rounded-lg border border-[#FEEF00]/35 bg-[#FEEF00]/10 px-2 py-1 text-center">
                                <div className="text-2xl font-black leading-none text-[#FEEF00]">{formatQty(itemUnits)}</div>
                                <div className="text-[10px] uppercase tracking-[0.12em] text-[#B7B7C2]">und</div>
                              </div>
                            ) : null}
                            <div className="min-w-0 flex-1">
                              <div className="text-sm font-black leading-snug text-[#F5F5F7]">{item.name}</div>
                              {itemUnits > 0 && Math.abs(itemUnits - item.qty) > 0.001 ? (
                                <div className="mt-0.5 text-xs text-[#8A8A96]">
                                  {formatQty(item.qty)} serv. x {formatQty(item.unitsPerService || extractUnitsPerService(item.name))} und
                                </div>
                              ) : itemUnits > 0 ? (
                                <div className="mt-0.5 text-xs text-[#8A8A96]">{formatQty(item.qty)} serv.</div>
                              ) : null}
                            </div>
                          </div>
                          {detailLines.length > 0 ? (
                            <div className="mt-1.5 space-y-1 border-l-2 border-[#FEEF00]/40 pl-3">
                              {detailLines.map((line, idx) => (
                                line.qty != null ? (
                                  <div
                                    key={`${item.id}-detail-${idx}`}
                                    className="flex items-center gap-2 rounded-md bg-[#15151D] px-2 py-1"
                                  >
                                    <div className="w-12 shrink-0 rounded-md border border-[#3A3A4D] bg-[#20202A] px-1.5 py-0.5 text-center">
                                      <div className="text-base font-black leading-none text-[#FEEF00]">{formatQty(line.qty)}</div>
                                      <div className="text-[9px] uppercase tracking-[0.1em] text-[#8A8A96]">und</div>
                                    </div>
                                    <div className="min-w-0 flex-1 text-xs font-semibold leading-snug text-[#D9D9E3]">
                                      {line.label}
                                    </div>
                                  </div>
                                ) : (
                                  <div key={`${item.id}-detail-${idx}`} className="text-xs font-semibold leading-snug text-[#C9C9D4]">
                                    {line.label}
                                  </div>
                                )
                              ))}
                            </div>
                          ) : null}
                        </div>
                      );
                    })}
                        </div>

                        {order.status === 'confirmed' ? (
                  <div className="mt-3 grid grid-cols-[52px_52px_76px_1fr] gap-2">
                            {ETA_PRESETS.map((minutes) => {
                              const activePreset = Math.round(Number(etaValue) || 0) === minutes;
                              return (
                                <button
                                  key={`${order.id}-eta-${minutes}`}
                                  type="button"
                                  onClick={() => setEtaByOrder((current) => ({ ...current, [order.id]: String(minutes) }))}
                                  className={[
                                    'h-12 rounded-xl border text-sm font-black active:scale-[0.98]',
                                    activePreset
                                      ? 'border-[#FEEF00]/70 bg-[#FEEF00] text-black'
                                      : 'border-[#2A2A38] bg-[#0B0B10] text-[#F5F5F7]',
                                  ].join(' ')}
                                  aria-label={`${minutes} minutos para orden ${order.displayNumber}`}
                                >
                                  {minutes}
                                </button>
                              );
                            })}
                            <input
                              type="number"
                              min="1"
                              step="1"
                              value={etaValue}
                              onChange={(event) =>
                                setEtaByOrder((current) => ({ ...current, [order.id]: event.target.value }))
                              }
                        className="h-12 w-full rounded-xl border border-[#2A2A38] bg-[#0B0B10] px-2 text-center text-base font-semibold text-[#F5F5F7]"
                              aria-label={`Minutos de preparación orden ${order.displayNumber}`}
                            />
                            <button
                              type="button"
                              disabled={isPending && pendingKey === takeActionKey}
                              onClick={() =>
                                runAction(takeActionKey, async () => {
                                  const etaMinutes = Math.max(1, Math.round(Number(etaValue) || 15));
                                  await kitchenTakeAction({ orderId: order.id, etaMinutes });
                                })
                              }
                        className="h-12 rounded-xl border border-emerald-400/40 bg-emerald-400/10 px-3 text-sm font-black text-emerald-200 active:scale-[0.98] disabled:opacity-60"
                            >
                              {isPending && pendingKey === takeActionKey ? 'Tomando...' : 'Tomar pedido'}
                            </button>
                          </div>
                        ) : null}

                        {order.status === 'in_kitchen' ? (
                          <div className="mt-2 space-y-2">
                            <div className={[
                              'rounded-lg border px-2.5 py-1.5',
                              remainingMinutes != null && remainingMinutes < 0
                                ? 'border-red-400/40 bg-red-400/10'
                                : 'border-emerald-400/30 bg-emerald-400/10',
                            ].join(' ')}>
                              <div className="flex items-center justify-between gap-3">
                                <div>
                                  <div className="text-[11px] uppercase tracking-[0.12em] text-[#8A8A96]">ETA fijado</div>
                                  <div className="text-sm font-semibold text-[#F5F5F7]">{order.etaMinutes || 0} min</div>
                                </div>
                                <div className="text-right">
                                  <div className={[
                                    'text-xl font-black',
                                    remainingMinutes != null && remainingMinutes < 0 ? 'text-red-200' : 'text-emerald-200',
                                  ].join(' ')}>
                                    {remainingMinutes == null
                                      ? '--'
                                      : remainingMinutes < 0
                                        ? `${Math.abs(remainingMinutes)} min tarde`
                                        : `${remainingMinutes} min`}
                                  </div>
                                  <div className="text-[10px] uppercase tracking-[0.12em] text-[#8A8A96]">
                                    {remainingMinutes != null && remainingMinutes < 0 ? 'retrasada' : 'restante'}
                                  </div>
                                </div>
                              </div>
                            </div>
                            <div className="grid grid-cols-2 gap-2">
                              <button
                                type="button"
                                disabled={isPending && pendingKey === delayActionKey}
                                onClick={() =>
                                  runAction(delayActionKey, async () => {
                                    const etaMinutes = Math.max(1, Math.round(Number(order.etaMinutes || 15) + 5));
                                    await updateKitchenEtaAction({ orderId: order.id, etaMinutes });
                                  })
                                }
                                className="h-11 rounded-xl border border-orange-400/40 bg-orange-400/10 px-2 text-xs font-bold text-orange-200 active:scale-[0.98] disabled:opacity-60"
                              >
                                {isPending && pendingKey === delayActionKey ? 'Reportando...' : 'Retraso +5'}
                              </button>
                              <button
                                type="button"
                                disabled={isPending && pendingKey === readyActionKey}
                                onClick={() =>
                                  runAction(readyActionKey, async () => {
                                    await markReadyAction({ orderId: order.id });
                                  })
                                }
                                className="h-11 rounded-xl border border-[#FEEF00]/50 bg-[#FEEF00] px-2 text-sm font-black text-black active:scale-[0.98] disabled:opacity-60"
                              >
                                {isPending && pendingKey === readyActionKey ? 'Marcando...' : 'Marcar lista'}
                              </button>
                            </div>
                          </div>
                        ) : null}
                      </article>
                    );
                  })}
                </div>
        </section>
      </div>
    </main>
  );
}

function StatusTab({
  label,
  value,
  tone,
  active,
  onClick,
}: {
  label: string;
  value: number;
  tone: 'warn' | 'ok' | 'brand';
  active: boolean;
  onClick: () => void;
}) {
  const toneClass =
    tone === 'warn'
      ? 'text-orange-200'
      : tone === 'ok'
        ? 'text-emerald-200'
        : 'text-[#FEEF00]';

  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        'h-12 rounded-xl border px-2 text-center transition active:scale-[0.98]',
        active ? 'border-[#FEEF00] bg-[#FEEF00] text-black' : 'border-[#242433] bg-[#121218]',
      ].join(' ')}
    >
      <div className={active ? 'text-[11px] font-semibold text-black/70' : 'text-[11px] font-semibold text-[#8A8A96]'}>
        {label}
      </div>
      <div className={`mt-0.5 text-lg font-black ${active ? 'text-black' : toneClass}`}>{value}</div>
    </button>
  );
}
