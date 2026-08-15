'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { createSupabaseBrowser } from '@/lib/supabase/browser';
import {
  kitchenOrderPriority,
  type KitchenIncidentStatus,
} from '@/lib/kitchen/operations';
import { getKitchenItemPresentation } from '@/lib/kitchen/order-presentation';
import { ModulePreference } from '../ModulePreference';
import {
  useKitchenLiveSync,
  type KitchenConnectionState,
} from './useKitchenLiveSync';
import {
  kitchenTakeAction,
  markReadyAction,
  reportKitchenIncidentAction,
  updateKitchenEtaAction,
} from '../master/dashboard/actions';
import { acknowledgeKitchenOrderChangesAction } from './actions';

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

export type KitchenOrderChangeAlert = {
  recipientId: number;
  eventId: number;
  orderId: number;
  title: string;
  message: string;
  reason: string | null;
  changedSections: string[];
  createdAt: string;
};

export type KitchenIncidentAlert = {
  eventId: number;
  orderId: number;
  message: string;
  status: KitchenIncidentStatus;
  reportedAt: string;
  updatedAt: string;
};

type KitchenClientProps = {
  publicVapidKey: string;
  fullName: string;
  orders: KitchenOrder[];
  changeAlerts: KitchenOrderChangeAlert[];
  incidentAlerts: KitchenIncidentAlert[];
  inventoryTaskCount: number;
};

type PushState = 'checking' | 'unsupported' | 'denied' | 'ready' | 'subscribed' | 'error';

type PushTestResult = {
  tone: 'success' | 'error';
  message: string;
};

type NewOrderNotice = {
  ids: number[];
  displayNumbers: string[];
};

const STATUS_COLUMNS: Array<{
  key: KitchenOrder['status'];
  title: string;
  empty: string;
}> = [
  { key: 'confirmed', title: 'Cola', empty: 'Sin pedidos pendientes.' },
  { key: 'in_kitchen', title: 'Preparando', empty: 'Sin pedidos en preparación.' },
  { key: 'ready', title: 'Listos', empty: 'Sin pedidos listos.' },
];

const PUSH_TIMEOUT_MS = 12000;
const NEW_ORDER_HIGHLIGHT_MS = 15000;
const ETA_PRESETS = [10, 20];
const KITCHEN_INCIDENT_REASONS = [
  {
    key: 'power',
    label: 'Sin luz / planta',
    message: 'Cocina queda mas lenta por falla electrica o cambio a planta.',
  },
  {
    key: 'slow',
    label: 'Produccion lenta',
    message: 'Cocina reporta retraso operativo en la preparacion.',
  },
  {
    key: 'missing_item',
    label: 'Falta producto',
    message: 'Cocina necesita revision por falta de producto o componente.',
  },
  {
    key: 'question',
    label: 'Duda del pedido',
    message: 'Cocina necesita que master revise una duda del pedido.',
  },
] as const;

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

function formatSignalTime(value: string | null) {
  if (!value) return 'aun no recibida';
  return new Date(value).toLocaleTimeString('es-VE', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
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

function connectionPresentation(state: KitchenConnectionState) {
  if (state === 'live') {
    return {
      label: 'En vivo',
      className: 'border-emerald-400/35 bg-emerald-400/10 text-emerald-200',
    };
  }
  if (state === 'offline') {
    return {
      label: 'Sin conexión',
      className: 'border-red-400/40 bg-red-400/10 text-red-100',
    };
  }
  if (state === 'fallback') {
    return {
      label: 'Sincronizando',
      className: 'border-orange-400/40 bg-orange-400/10 text-orange-100',
    };
  }
  return {
    label: 'Conectando',
    className: 'border-[#3A3A4D] bg-[#171720] text-[#C9C9D4]',
  };
}

function normalizeEtaMinutes(value: string) {
  const etaMinutes = Math.round(Number(value));
  if (!Number.isFinite(etaMinutes) || etaMinutes < 1 || etaMinutes > 180) {
    throw new Error('Indica un ETA entre 1 y 180 minutos.');
  }
  return etaMinutes;
}

function formatQty(value: number) {
  if (Math.abs(value - Math.round(value)) < 0.001) return String(Math.round(value));
  return value.toLocaleString('es-VE', { maximumFractionDigits: 2 });
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

function vibrateKitchenAlert() {
  if ('vibrate' in navigator) navigator.vibrate([140, 70, 140]);
}

function playKitchenChangeAlert() {
  try {
    const AudioContextCtor =
      window.AudioContext ||
      (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextCtor) return;
    const ctx = new AudioContextCtor();
    const toneStarts = [0, 0.24, 0.48];

    toneStarts.forEach((offset, index) => {
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      const startsAt = ctx.currentTime + offset;

      oscillator.type = 'square';
      oscillator.frequency.setValueAtTime(index === 1 ? 520 : 700, startsAt);
      gain.gain.setValueAtTime(0.0001, startsAt);
      gain.gain.exponentialRampToValueAtTime(0.2, startsAt + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, startsAt + 0.18);
      oscillator.connect(gain);
      gain.connect(ctx.destination);
      oscillator.start(startsAt);
      oscillator.stop(startsAt + 0.2);
    });

    setTimeout(() => void ctx.close().catch(() => undefined), 950);
  } catch {
    // Browsers can block audio until the user interacts with the page.
  }
}

function vibrateKitchenChangeAlert() {
  if ('vibrate' in navigator) navigator.vibrate([220, 90, 220, 90, 420]);
}

function changeSectionLabel(section: string) {
  const labels: Record<string, string> = {
    pedido: 'productos del pedido',
    cliente: 'cliente',
    entrega: 'tipo o programación de entrega',
    direccion: 'dirección',
    nota: 'notas',
    precio: 'precios',
  };
  return labels[section] || section;
}

function incidentStatusPresentation(status: KitchenIncidentAlert['status']) {
  if (status === 'resolved') {
    return {
      label: 'Resuelta por Master',
      className: 'border-emerald-400/35 bg-emerald-400/10 text-emerald-100',
    };
  }
  if (status === 'reviewed') {
    return {
      label: 'Recibida y revisada por Master',
      className: 'border-[#FEEF00]/40 bg-[#FEEF00]/10 text-[#FEEF00]',
    };
  }
  if (status === 'reopened') {
    return {
      label: 'Reabierta por Master',
      className: 'border-orange-400/40 bg-orange-400/10 text-orange-100',
    };
  }
  return {
    label: 'Enviada a Master',
    className: 'border-red-400/40 bg-red-400/10 text-red-100',
  };
}

function printKitchenOrder(orderId: number) {
  const orderElement = document.getElementById(`kitchen-order-${orderId}`);
  const ticket = orderElement?.querySelector('.kitchen-print-ticket');
  if (!(ticket instanceof HTMLElement)) return;

  const printPortal = ticket.cloneNode(true) as HTMLElement;
  printPortal.classList.remove('kitchen-print-ticket');
  printPortal.classList.add('kitchen-print-portal');
  printPortal.removeAttribute('aria-hidden');

  const cleanup = () => {
    document.body.classList.remove('kitchen-printing');
    printPortal.remove();
  };
  document.body.appendChild(printPortal);
  document.body.classList.add('kitchen-printing');
  window.addEventListener('afterprint', cleanup, { once: true });
  window.setTimeout(() => window.print(), 80);
  window.setTimeout(cleanup, 5000);
}

export default function KitchenClient({
  publicVapidKey,
  fullName,
  orders,
  changeAlerts,
  incidentAlerts,
  inventoryTaskCount,
}: KitchenClientProps) {
  const router = useRouter();
  const [supabase] = useState(() => createSupabaseBrowser());
  const [isPending, startActionTransition] = useTransition();
  const [isRefreshPending, startRefreshTransition] = useTransition();
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [etaByOrder, setEtaByOrder] = useState<Record<number, string>>({});
  const [incidentOrderId, setIncidentOrderId] = useState<number | null>(null);
  const [incidentReasonByOrder, setIncidentReasonByOrder] = useState<Record<number, string>>({});
  const [incidentNoteByOrder, setIncidentNoteByOrder] = useState<Record<number, string>>({});
  const [activeStatus, setActiveStatus] = useState<KitchenOrder['status']>('confirmed');
  const [currentTimeMs, setCurrentTimeMs] = useState(() => Date.now());
  const [pushState, setPushState] = useState<PushState>('checking');
  const [pushBusy, setPushBusy] = useState(false);
  const [pushTestBusy, setPushTestBusy] = useState(false);
  const [pushTestResult, setPushTestResult] = useState<PushTestResult | null>(null);
  const [lastPushAt, setLastPushAt] = useState<string | null>(null);
  const [newOrderNotice, setNewOrderNotice] = useState<NewOrderNotice | null>(null);
  const [newOrderIds, setNewOrderIds] = useState<Set<number>>(() => new Set());
  const previousOrderIdsRef = useRef<Set<number> | null>(null);
  const alertedOrderIdsRef = useRef(new Set<number>());
  const alertedChangeEventIdsRef = useRef(new Set<number>());
  const newOrderTimerRef = useRef<number | null>(null);

  const refreshOrders = useCallback(() => {
    startRefreshTransition(() => router.refresh());
  }, [router]);
  const { connectionState, lastRealtimeEventAt, requestRefresh } = useKitchenLiveSync(
    supabase,
    refreshOrders,
  );

  useEffect(() => {
    const intervalId = window.setInterval(() => setCurrentTimeMs(Date.now()), 30000);
    return () => window.clearInterval(intervalId);
  }, []);

  const persistPushSubscription = useCallback(
    async (subscription: PushSubscription) => {
      const { data, error } = await supabase.auth.getSession();
      const accessToken = data.session?.access_token || '';
      if (error || !accessToken) throw new Error('La sesión venció. Ingresa de nuevo para activar alertas.');

      const response = await withTimeout(
        fetch('/api/push-subscriptions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            accessToken,
            scope: 'kitchen',
            subscription: subscriptionToJson(subscription),
          }),
        }),
        'Guardar las alertas tardó demasiado.'
      );

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error || 'No se pudo registrar este dispositivo.');
      }
    },
    [supabase]
  );

  useEffect(() => {
    let cancelled = false;

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
          'La app tardó demasiado en revisar alertas.'
        );
        if (cancelled) return;

        if (!currentSubscription) {
          setPushState('ready');
          return;
        }

        await persistPushSubscription(currentSubscription);
        if (!cancelled) setPushState('subscribed');
      } catch {
        if (!cancelled) setPushState('error');
      }
    }

    void bootPushState();
    return () => {
      cancelled = true;
    };
  }, [persistPushSubscription, publicVapidKey]);

  useEffect(() => {
    const currentIds = new Set(orders.map((order) => order.id));
    const previousIds = previousOrderIdsRef.current;
    previousOrderIdsRef.current = currentIds;

    if (!previousIds) return;

    const newConfirmedOrders = orders.filter(
      (order) =>
        order.status === 'confirmed' &&
        !previousIds.has(order.id) &&
        !alertedOrderIdsRef.current.has(order.id)
    );
    if (newConfirmedOrders.length === 0) return;

    newConfirmedOrders.forEach((order) => alertedOrderIdsRef.current.add(order.id));
    if (alertedOrderIdsRef.current.size > 250) {
      alertedOrderIdsRef.current = new Set(Array.from(alertedOrderIdsRef.current).slice(-120));
    }

    const ids = newConfirmedOrders.map((order) => order.id);
    setNewOrderIds(new Set(ids));
    setNewOrderNotice({
      ids,
      displayNumbers: newConfirmedOrders.map((order) => order.displayNumber),
    });
    setActiveStatus('confirmed');
    playKitchenAlert();
    vibrateKitchenAlert();

    if (newOrderTimerRef.current != null) window.clearTimeout(newOrderTimerRef.current);
    newOrderTimerRef.current = window.setTimeout(() => {
      setNewOrderIds(new Set());
      newOrderTimerRef.current = null;
    }, NEW_ORDER_HIGHLIGHT_MS);
  }, [orders]);

  useEffect(() => {
    return () => {
      if (newOrderTimerRef.current != null) window.clearTimeout(newOrderTimerRef.current);
    };
  }, []);

  useEffect(() => {
    const newChangeAlerts = changeAlerts.filter(
      (alert) => !alertedChangeEventIdsRef.current.has(alert.eventId),
    );
    if (newChangeAlerts.length === 0) return;

    newChangeAlerts.forEach((alert) => alertedChangeEventIdsRef.current.add(alert.eventId));
    if (alertedChangeEventIdsRef.current.size > 250) {
      alertedChangeEventIdsRef.current = new Set(
        Array.from(alertedChangeEventIdsRef.current).slice(-120),
      );
    }

    const newestChangedOrder = orders.find(
      (order) => order.id === newChangeAlerts[0]?.orderId,
    );
    if (newestChangedOrder) setActiveStatus(newestChangedOrder.status);
    playKitchenChangeAlert();
    vibrateKitchenChangeAlert();
  }, [changeAlerts, orders]);

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;

    const onMessage = (event: MessageEvent) => {
      const data = event.data && typeof event.data === 'object' ? event.data as { type?: string; payload?: { url?: string; tone?: string; tag?: string } } : null;
      if (data?.type !== 'vivo-push') return;
      if (!String(data.payload?.url || '').startsWith('/app/kitchen')) return;
      setLastPushAt(new Date().toISOString());
      if (data.payload?.tag === 'user-push-test') {
        setPushTestResult({ tone: 'success', message: 'Push recibido correctamente en Cocina.' });
      }
      requestRefresh('push', true);
    };

    navigator.serviceWorker.addEventListener('message', onMessage);
    return () => navigator.serviceWorker.removeEventListener('message', onMessage);
  }, [requestRefresh]);

  const changeAlertsByOrder = useMemo(() => {
    const alertsByOrder = new Map<number, KitchenOrderChangeAlert[]>();
    for (const alert of changeAlerts) {
      const orderAlerts = alertsByOrder.get(alert.orderId) ?? [];
      orderAlerts.push(alert);
      alertsByOrder.set(alert.orderId, orderAlerts);
    }
    return alertsByOrder;
  }, [changeAlerts]);

  const incidentAlertsByOrder = useMemo(() => {
    const alertsByOrder = new Map<number, KitchenIncidentAlert>();
    for (const alert of incidentAlerts) {
      if (!alertsByOrder.has(alert.orderId)) alertsByOrder.set(alert.orderId, alert);
    }
    return alertsByOrder;
  }, [incidentAlerts]);

  const ordersByStatus = useMemo(() => {
    const priorityFor = (order: KitchenOrder) => {
      const incident = incidentAlertsByOrder.get(order.id);
      return kitchenOrderPriority({
        hasPendingChanges: changeAlertsByOrder.has(order.id),
        hasPendingIncident: Boolean(incident && incident.status !== 'resolved'),
        remainingPrepMinutes: remainingPrepMinutes(order, currentTimeMs),
      });
    };

    return new Map(
      STATUS_COLUMNS.map((column) => [
        column.key,
        orders
          .filter((order) => order.status === column.key)
          .sort((a, b) => priorityFor(a) - priorityFor(b)),
      ])
    );
  }, [changeAlertsByOrder, currentTimeMs, incidentAlertsByOrder, orders]);

  const latestChangeAlert = changeAlerts[0] ?? null;
  const latestChangedOrder = latestChangeAlert
    ? orders.find((order) => order.id === latestChangeAlert.orderId) ?? null
    : null;
  const latestPendingIncident = incidentAlerts.find(
    (incident) =>
      incident.status !== 'resolved' && orders.some((order) => order.id === incident.orderId),
  ) ?? null;
  const latestIncidentOrder = latestPendingIncident
    ? orders.find((order) => order.id === latestPendingIncident.orderId) ?? null
    : null;

  const activeColumn = STATUS_COLUMNS.find((column) => column.key === activeStatus) ?? STATUS_COLUMNS[0];
  const activeOrders = ordersByStatus.get(activeColumn.key) ?? [];
  const todayLabel = formatKitchenToday();
  const connection = connectionPresentation(connectionState);
  const pushLabel =
    pushBusy
      ? 'Activando...'
      : pushState === 'subscribed'
        ? 'Push activo'
        : pushState === 'checking'
          ? 'Revisando push'
          : pushState === 'denied'
            ? 'Push bloqueado'
            : pushState === 'error'
              ? 'Reparar push'
              : pushState === 'unsupported'
                ? 'Sin push'
                : 'Activar push';

  const runAction = (key: string, action: () => Promise<void>) => {
    if (isPending) return;
    if (!navigator.onLine) {
      setErrorMessage('No hay conexión. Recupera internet antes de realizar esta acción.');
      return;
    }
    setPendingKey(key);
    setErrorMessage(null);
    startActionTransition(async () => {
      try {
        await action();
        requestRefresh('action', true);
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : 'No se pudo completar la acción.');
      } finally {
        setPendingKey(null);
      }
    });
  };

  const focusOrder = useCallback((orderId: number) => {
    const order = orders.find((candidate) => candidate.id === orderId);
    if (!order) return;

    setActiveStatus(order.status);
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        document.getElementById(`kitchen-order-${orderId}`)?.scrollIntoView({
          behavior: 'smooth',
          block: 'start',
        });
      });
    });
  }, [orders]);

  async function enablePush() {
    setPushBusy(true);
    setErrorMessage(null);

    try {
      if (!publicVapidKey) throw new Error('Falta configurar alertas push.');
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        setPushState(permission === 'denied' ? 'denied' : 'ready');
        throw new Error(
          permission === 'denied'
            ? 'El navegador bloqueó las notificaciones.'
            : 'Debes permitir las notificaciones para activar las alertas.'
        );
      }

      const registration = await waitForActiveServiceWorker(await getAppServiceWorker());
      let subscription = await withTimeout(
        registration.pushManager.getSubscription(),
        'La app tardó demasiado en revisar alertas.'
      );
      if (!subscription) {
        subscription = await withTimeout(
          registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(publicVapidKey),
          }),
          'La suscripción push tardó demasiado.'
        );
      }

      await persistPushSubscription(subscription);

      playKitchenAlert();
      vibrateKitchenAlert();
      setPushState('subscribed');
    } catch (error) {
      setPushState((current) => current === 'denied' ? 'denied' : 'error');
      setErrorMessage(error instanceof Error ? error.message : 'No se pudo activar alertas.');
    } finally {
      setPushBusy(false);
    }
  }

  async function testPush() {
    if (pushTestBusy) return;

    setPushTestBusy(true);
    setPushTestResult(null);
    setErrorMessage(null);

    try {
      const { data, error } = await supabase.auth.getSession();
      const accessToken = data.session?.access_token || '';
      if (error || !accessToken) {
        throw new Error('La sesion vencio. Ingresa de nuevo para probar las alertas.');
      }

      const response = await withTimeout(
        fetch('/api/push-notifications/test', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            accessToken,
            scope: 'kitchen',
            url: '/app/kitchen',
          }),
        }),
        'La prueba push tardo demasiado.',
      );
      const payload = (await response.json().catch(() => null)) as {
        delivered?: number;
        failures?: string[];
        error?: string;
      } | null;

      if (!response.ok || !payload?.delivered) {
        throw new Error(payload?.error || payload?.failures?.[0] || 'No se pudo entregar la prueba push.');
      }

      setPushTestResult({
        tone: 'success',
        message: `Prueba enviada a ${payload.delivered} dispositivo${payload.delivered === 1 ? '' : 's'} de Cocina.`,
      });
    } catch (error) {
      setPushTestResult({
        tone: 'error',
        message: error instanceof Error ? error.message : 'No se pudo probar el push.',
      });
    } finally {
      setPushTestBusy(false);
    }
  }

  return (
    <main className="kitchen-app min-h-screen overflow-x-hidden bg-[#08090D] text-[#F5F5F7]">
      <ModulePreference moduleKey="kitchen" />
      <div className="mx-auto flex min-h-screen w-full max-w-[640px] flex-col px-2.5 sm:px-3">
        <header className="kitchen-safe-header sticky top-0 z-30 -mx-3 border-b border-[#242433] bg-[#08090D]/95 px-3 pb-3 backdrop-blur sm:-mx-4 sm:px-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-xs uppercase tracking-[0.18em] text-[#8A8A96]">VIVO OPS</div>
              <h1 className="mt-0.5 text-xl font-black leading-tight">Cocina</h1>
              <div className="mt-0.5 text-xs text-[#B7B7C2]">{fullName || 'Operación de cocina'}</div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Link
                href="/app/kitchen/history"
                prefetch={false}
                aria-label="Abrir historial diario de Cocina"
                className="flex h-10 items-center rounded-xl border border-[#2A2A38] bg-[#121218] px-2.5 text-xs font-semibold text-[#F5F5F7]"
              >
                Hist.
              </Link>
              <Link
                href="/app/kitchen/inventory"
                prefetch={false}
                aria-label={inventoryTaskCount > 0
                  ? `Abrir Inventario: ${inventoryTaskCount} tareas pendientes`
                  : 'Abrir Inventario'}
                className="flex h-10 items-center rounded-xl border border-[#FEEF00]/40 bg-[#FEEF00]/10 px-2.5 text-xs font-semibold text-[#FEEF00]"
              >
                <span className="text-left leading-tight">
                  <span className="block">Inventario</span>
                  {inventoryTaskCount > 0 ? (
                    <span className="block text-[9px] font-bold text-[#F5F5A8]">
                      {inventoryTaskCount} pendientes
                    </span>
                  ) : null}
                </span>
              </Link>
              <Link
                href="/app"
                className="flex h-10 items-center rounded-xl border border-[#2A2A38] bg-[#121218] px-3 text-xs font-semibold text-[#F5F5F7]"
              >
                Módulos
              </Link>
            </div>
          </div>

          <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="rounded-full border border-[#303041] bg-[#0B0B10] px-2 py-1 text-xs font-semibold text-[#F5F5F7]">
                Hoy {todayLabel}
              </span>
              <span
                className={`rounded-full border px-2 py-1 text-xs font-semibold ${connection.className}`}
                aria-live="polite"
              >
                {connection.label}
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => {
                  if (pushState === 'subscribed') void testPush();
                  else void enablePush();
                }}
                disabled={
                  pushBusy ||
                  pushTestBusy ||
                  pushState === 'checking' ||
                  pushState === 'unsupported' ||
                  pushState === 'denied'
                }
                className={[
                  'h-9 rounded-xl border px-2.5 text-xs font-semibold',
                  pushState === 'subscribed'
                    ? 'border-emerald-400/40 bg-emerald-400/10 text-emerald-200'
                    : 'border-[#FEEF00]/40 bg-[#FEEF00]/10 text-[#FEEF00]',
                ].join(' ')}
              >
                {pushTestBusy ? 'Probando...' : pushState === 'subscribed' ? 'Probar push' : pushLabel}
              </button>
              <button
                type="button"
                onClick={() => requestRefresh('manual', true)}
                disabled={isRefreshPending || connectionState === 'offline'}
                className="h-9 rounded-xl border border-[#2A2A38] bg-[#121218] px-2.5 text-xs font-semibold text-[#F5F5F7]"
              >
                {isRefreshPending ? 'Actualizando...' : 'Actualizar'}
              </button>
            </div>
          </div>

          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 px-0.5 text-[11px] text-[#8A8A96]">
            <span>En vivo: {formatSignalTime(lastRealtimeEventAt)}</span>
            <span>Push: {formatSignalTime(lastPushAt)}</span>
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

        {latestChangeAlert && latestChangedOrder ? (
          <div
            className="kitchen-enter mt-3 rounded-xl border-2 border-orange-400 bg-[#321B0C] p-3 shadow-[0_14px_34px_rgba(249,115,22,0.18)]"
            role="alert"
            aria-live="assertive"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-xs font-black uppercase tracking-[0.14em] text-orange-300">
                  Modificación pendiente de revisar
                </div>
                <div className="mt-1 text-base font-black leading-tight text-white">
                  {changeAlertsByOrder.size === 1
                    ? `Orden #${latestChangedOrder.displayNumber} modificada durante preparación`
                    : `${changeAlertsByOrder.size} pedidos tienen cambios sin revisar`}
                </div>
                <div className="mt-1 text-sm font-semibold text-orange-100">
                  {latestChangeAlert.message}
                </div>
                {latestChangeAlert.reason ? (
                  <div className="mt-1 text-xs text-orange-100/80">
                    Motivo de Master: {latestChangeAlert.reason}
                  </div>
                ) : null}
              </div>
              <span className="shrink-0 rounded-full bg-orange-400 px-2 py-1 text-xs font-black text-black">
                {changeAlerts.length}
              </span>
            </div>
            <button
              type="button"
              onClick={() => focusOrder(latestChangeAlert.orderId)}
              className="mt-3 h-11 w-full rounded-xl bg-orange-400 px-3 text-sm font-black text-black active:scale-[0.98]"
            >
              Ver pedido #{latestChangedOrder.displayNumber}
            </button>
          </div>
        ) : null}

        {latestPendingIncident && latestIncidentOrder ? (
          <div
            className="kitchen-enter mt-3 rounded-xl border border-red-400/45 bg-[#260F13] p-3"
            role="status"
            aria-live="polite"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-xs font-black uppercase tracking-[0.14em] text-red-200">
                  Incidencia · Orden #{latestIncidentOrder.displayNumber}
                </div>
                <div className="mt-1 text-sm font-semibold text-red-50">
                  {latestPendingIncident.message}
                </div>
              </div>
              <span className="shrink-0 rounded-full border border-red-300/40 bg-red-400/15 px-2 py-1 text-[11px] font-black text-red-100">
                {incidentStatusPresentation(latestPendingIncident.status).label}
              </span>
            </div>
            <button
              type="button"
              onClick={() => focusOrder(latestPendingIncident.orderId)}
              className="mt-3 h-10 w-full rounded-xl border border-red-300/40 bg-red-500/20 px-3 text-sm font-black text-red-50 active:scale-[0.98]"
            >
              Ver pedido afectado
            </button>
          </div>
        ) : null}

        {newOrderNotice ? (
          <div
            className="kitchen-enter mt-3 rounded-xl border border-[#FEEF00]/55 bg-[#FEEF00]/12 p-3"
            role="status"
            aria-live="assertive"
          >
            <div className="text-sm font-black text-[#FEEF00]">
              {newOrderNotice.ids.length === 1 ? 'Nuevo pedido en cocina' : `${newOrderNotice.ids.length} pedidos nuevos`}
            </div>
            <div className="mt-0.5 text-xs text-[#F5F5F7]">
              Orden #{newOrderNotice.displayNumbers.join(', #')}
            </div>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setActiveStatus('confirmed')}
                className="h-10 rounded-xl border border-[#FEEF00]/60 bg-[#FEEF00] px-3 text-sm font-black text-black"
              >
                Ver cola
              </button>
              <button
                type="button"
                onClick={() => setNewOrderNotice(null)}
                className="h-10 rounded-xl border border-[#3A3A4D] bg-[#121218] px-3 text-sm font-semibold text-[#F5F5F7]"
              >
                Entendido
              </button>
            </div>
          </div>
        ) : null}

        {pushTestResult ? (
          <div
            className={[
              'mt-3 flex items-start justify-between gap-3 rounded-xl border px-3 py-2.5 text-sm',
              pushTestResult.tone === 'success'
                ? 'border-emerald-400/40 bg-emerald-400/10 text-emerald-100'
                : 'border-red-500/40 bg-red-500/10 text-red-100',
            ].join(' ')}
            role="status"
          >
            <span>{pushTestResult.message}</span>
            <button
              type="button"
              onClick={() => setPushTestResult(null)}
              className="shrink-0 rounded-lg border border-current/30 px-2 py-1 text-xs font-semibold"
            >
              Cerrar
            </button>
          </div>
        ) : null}

        {errorMessage ? (
          <div className="mt-3 flex items-start justify-between gap-3 rounded-xl border border-red-500/40 bg-red-500/10 px-3 py-2.5 text-sm text-red-100" role="alert">
            <span>{errorMessage}</span>
            <button
              type="button"
              onClick={() => setErrorMessage(null)}
              className="shrink-0 rounded-lg border border-red-300/30 px-2 py-1 text-xs font-semibold"
            >
              Cerrar
            </button>
          </div>
        ) : null}

        <section className="kitchen-safe-content flex-1 py-2">
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
              const incidentActionKey = `incident:${order.id}`;
              const changeActionKey = `ack-change:${order.id}`;
              const etaValue = etaByOrder[order.id] ?? String(order.etaMinutes || 15);
              const incidentOpen = incidentOrderId === order.id;
              const incidentReasonKey = incidentReasonByOrder[order.id] ?? KITCHEN_INCIDENT_REASONS[0].key;
              const incidentReason =
                KITCHEN_INCIDENT_REASONS.find((reason) => reason.key === incidentReasonKey) ??
                KITCHEN_INCIDENT_REASONS[0];
              const incidentNote = incidentNoteByOrder[order.id] ?? '';
              const totalUnits = order.items.reduce(
                (sum, item) => sum + getKitchenItemPresentation(item).preparedUnits,
                0,
              );
              const elapsed =
                order.status === 'confirmed'
                  ? elapsedMinutes(order.sentToKitchenAt || order.createdAt, currentTimeMs)
                  : order.status === 'in_kitchen'
                    ? elapsedMinutes(order.kitchenStartedAt, currentTimeMs)
                    : elapsedMinutes(order.readyAt, currentTimeMs);
              const readyTime = etaClockLabel(order);
              const remainingMinutes = remainingPrepMinutes(order, currentTimeMs);
              const isNewOrder = newOrderIds.has(order.id);
              const orderChanges = changeAlertsByOrder.get(order.id) ?? [];
              const latestOrderChange = orderChanges[0] ?? null;
              const hasPendingChanges = orderChanges.length > 0;
              const orderIncident = incidentAlertsByOrder.get(order.id) ?? null;
              const incidentPresentation = orderIncident
                ? incidentStatusPresentation(orderIncident.status)
                : null;

              return (
                <article
                  key={order.id}
                  id={`kitchen-order-${order.id}`}
                  className={[
                    'scroll-mt-44 rounded-xl border p-2.5 shadow-[0_12px_28px_rgba(0,0,0,0.16)]',
                    hasPendingChanges
                      ? 'border-orange-400 bg-[#26180C] ring-2 ring-orange-400/30'
                      : orderIncident && orderIncident.status !== 'resolved'
                        ? 'border-red-400/70 bg-[#1D1014] ring-1 ring-red-400/25'
                      : isNewOrder
                      ? 'kitchen-new-order border-[#FEEF00]/75 bg-[#1D1D19]'
                      : orderIndex % 2 === 0
                        ? 'border-[#2A2A38] bg-[#101018]'
                        : 'border-[#56566A] bg-[#282834] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.05),0_12px_28px_rgba(0,0,0,0.18)]',
                  ].join(' ')}
                >
                  <div className="kitchen-print-ticket" aria-hidden="true">
                    <div className="kitchen-print-brand">VIVO OPS · COCINA</div>
                    <div className="kitchen-print-order-number">Orden #{order.displayNumber}</div>
                    <div>{order.clientName}</div>
                    <div>{order.fulfillment === 'delivery' ? 'Delivery' : 'Pickup'} · {scheduleLabel(order)}</div>
                    <div className="kitchen-print-divider" />
                    {order.items.map((item) => {
                      const presentation = getKitchenItemPresentation(item);
                      const printQuantity = presentation.hasCountedDetails
                        ? item.qty
                        : presentation.totalUnits;
                      return (
                        <div key={`print-${item.id}`} className="kitchen-print-line">
                          <strong>{formatQty(printQuantity)} × {item.name}</strong>
                          {presentation.detailLines.map((line, index) => (
                            <div key={`print-${item.id}-${index}`}>
                              {line.qty == null
                                ? line.label
                                : `${formatQty(line.qty)} × ${line.label}${
                                    line.qtyPerPresentation != null
                                      ? ` (${formatQty(line.qtyPerPresentation)} por presentación)`
                                      : ''
                                  }`}
                            </div>
                          ))}
                        </div>
                      );
                    })}
                    {order.notes?.trim() ? <div><strong>Nota:</strong> {order.notes.trim()}</div> : null}
                    {order.deliveryAddress ? <div><strong>Dirección:</strong> {order.deliveryAddress}</div> : null}
                    {order.etaMinutes ? <div><strong>ETA Cocina:</strong> {order.etaMinutes} min</div> : null}
                    <div className="kitchen-print-divider" />
                    <div>{formatDateTime(new Date(currentTimeMs).toISOString())}</div>
                  </div>
                        <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-xl font-black leading-none tracking-tight text-[#FEEF00]">
                        Orden #{order.displayNumber}
                      </div>
                      <div className="mt-1 truncate text-base font-semibold text-[#F5F5F7]">{order.clientName}</div>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-[#B7B7C2]">
                        {isNewOrder ? (
                          <span className="rounded-full border border-[#FEEF00]/60 bg-[#FEEF00] px-2 py-0.5 font-black text-black">
                            Nuevo
                          </span>
                        ) : null}
                        {hasPendingChanges ? (
                          <span className="rounded-full border border-orange-300 bg-orange-400 px-2 py-0.5 font-black text-black">
                            MODIFICADO · REVISAR
                          </span>
                        ) : null}
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
                      <button
                        type="button"
                        onClick={() => printKitchenOrder(order.id)}
                        className="kitchen-no-print mt-1.5 rounded-lg border border-[#3A3A4D] bg-[#0B0B10] px-2 py-1 text-[11px] font-semibold text-[#C9C9D4]"
                        aria-label={`Imprimir orden ${order.displayNumber}`}
                      >
                        Imprimir
                      </button>
                        </div>
                  </div>

                  {latestOrderChange ? (
                    <div className="mt-2 rounded-xl border-2 border-orange-400/80 bg-[#3A1D08] p-2.5 text-orange-50">
                      <div className="text-xs font-black uppercase tracking-[0.12em] text-orange-300">
                        Master modificó esta orden durante la preparación
                      </div>
                      <div className="mt-1 text-sm font-semibold leading-snug">
                        {latestOrderChange.message}
                      </div>
                      {latestOrderChange.changedSections.length > 0 ? (
                        <div className="mt-1 text-xs text-orange-100/85">
                          Cambió: {latestOrderChange.changedSections.map(changeSectionLabel).join(', ')}
                        </div>
                      ) : null}
                      {latestOrderChange.reason ? (
                        <div className="mt-1 text-xs text-orange-100/85">
                          Motivo: {latestOrderChange.reason}
                        </div>
                      ) : null}
                      {orderChanges.length > 1 ? (
                        <div className="mt-1 text-xs font-bold text-orange-200">
                          Hay {orderChanges.length} modificaciones pendientes en este pedido.
                        </div>
                      ) : null}
                      <div className="mt-2 flex items-center justify-between gap-2">
                        <span className="text-[11px] text-orange-100/65">
                          {formatDateTime(latestOrderChange.createdAt)}
                        </span>
                        <button
                          type="button"
                          disabled={isPending || connectionState === 'offline'}
                          onClick={() =>
                            runAction(changeActionKey, async () => {
                              await acknowledgeKitchenOrderChangesAction({
                                orderId: order.id,
                                recipientIds: orderChanges.map((change) => change.recipientId),
                              });
                            })
                          }
                          className="min-h-10 shrink-0 rounded-xl border border-orange-200/60 bg-orange-400 px-3 text-xs font-black text-black active:scale-[0.98] disabled:opacity-60"
                        >
                          {isPending && pendingKey === changeActionKey
                            ? 'Marcando...'
                            : 'Cambio revisado'}
                        </button>
                      </div>
                    </div>
                  ) : null}

                  {orderIncident && incidentPresentation ? (
                    <div className={`mt-2 rounded-xl border px-2.5 py-2 ${incidentPresentation.className}`}>
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="text-xs font-black uppercase tracking-[0.12em]">
                            Incidencia reportada
                          </div>
                          <div className="mt-1 text-sm font-semibold leading-snug">
                            {orderIncident.message}
                          </div>
                        </div>
                        <span className="shrink-0 rounded-full border border-current/30 px-2 py-0.5 text-[10px] font-black">
                          {incidentPresentation.label}
                        </span>
                      </div>
                      <div className="mt-1 text-[11px] opacity-70">
                        Reportada {formatDateTime(orderIncident.reportedAt)}
                        {orderIncident.updatedAt !== orderIncident.reportedAt
                          ? ` · Actualizada ${formatDateTime(orderIncident.updatedAt)}`
                          : ''}
                      </div>
                    </div>
                  ) : null}

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
                      const presentation = getKitchenItemPresentation(item);
                      const detailLines = presentation.detailLines;
                      const hasComponentDetails = presentation.hasCountedDetails;
                      const itemUnits = hasComponentDetails ? 0 : presentation.totalUnits;
                      const unitsPerPresentation = item.qty > 0
                        ? presentation.totalUnits / item.qty
                        : 0;
                      return (
                        <div key={item.id} className="rounded-lg border border-[#242433] bg-[#0B0B10] px-2.5 py-2">
                          <div className="flex items-start gap-2.5">
                            {hasComponentDetails && item.qty > 1 ? (
                              <div className="w-[76px] shrink-0 rounded-lg border border-[#FEEF00]/50 bg-[#FEEF00]/10 px-2 py-1 text-center">
                                <div className="text-2xl font-black leading-none text-[#FEEF00]">{formatQty(item.qty)}</div>
                                <div className="text-[9px] uppercase tracking-[0.1em] text-[#B7B7C2]">present.</div>
                              </div>
                            ) : itemUnits > 0 ? (
                              <div className="w-[76px] shrink-0 rounded-lg border border-[#FEEF00]/35 bg-[#FEEF00]/10 px-2 py-1 text-center">
                                <div className="text-2xl font-black leading-none text-[#FEEF00]">{formatQty(itemUnits)}</div>
                                <div className="text-[10px] uppercase tracking-[0.12em] text-[#B7B7C2]">und</div>
                              </div>
                            ) : null}
                            <div className="min-w-0 flex-1">
                              <div className="text-sm font-black leading-snug text-[#F5F5F7]">{item.name}</div>
                              {hasComponentDetails && item.qty > 1 ? (
                                <div className="mt-0.5 text-xs font-semibold text-[#FEEF00]">
                                  {presentation.repeatsSameConfiguration
                                    ? `${formatQty(item.qty)} presentaciones iguales · ${formatQty(presentation.totalUnits)} und en total`
                                    : `${formatQty(item.qty)} presentaciones · desglose total`}
                                </div>
                              ) : itemUnits > 0 && Math.abs(itemUnits - item.qty) > 0.001 ? (
                                <div className="mt-0.5 text-xs text-[#8A8A96]">
                                  {formatQty(item.qty)} serv. x {formatQty(unitsPerPresentation)} und
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
                                      <div>{line.label}</div>
                                      {line.qtyPerPresentation != null ? (
                                        <div className="mt-0.5 text-[10px] font-medium text-[#8A8A96]">
                                          {formatQty(line.qtyPerPresentation)} por presentación × {formatQty(item.qty)}
                                        </div>
                                      ) : null}
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
                    <div className="mt-3 grid grid-cols-[52px_52px_minmax(76px,1fr)] gap-2 sm:grid-cols-[52px_52px_90px_1fr]">
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
                              max="180"
                              step="1"
                              inputMode="numeric"
                              value={etaValue}
                              onChange={(event) =>
                                setEtaByOrder((current) => ({ ...current, [order.id]: event.target.value }))
                              }
                        className="h-12 w-full rounded-xl border border-[#2A2A38] bg-[#0B0B10] px-2 text-center text-base font-semibold text-[#F5F5F7]"
                              aria-label={`Minutos de preparación orden ${order.displayNumber}`}
                            />
                            <button
                              type="button"
                              disabled={isPending || connectionState === 'offline'}
                              onClick={() =>
                                runAction(takeActionKey, async () => {
                                  const etaMinutes = normalizeEtaMinutes(etaValue);
                                  await kitchenTakeAction({ orderId: order.id, etaMinutes });
                                })
                              }
                              className="col-span-3 h-12 rounded-xl border border-emerald-400/40 bg-emerald-400/10 px-3 text-sm font-black text-emerald-200 disabled:opacity-60 sm:col-span-1"
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
                                disabled={isPending || connectionState === 'offline'}
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
                                disabled={isPending || connectionState === 'offline'}
                                onClick={() => {
                                  const confirmed = window.confirm(
                                    `¿Confirmas que la orden #${order.displayNumber} está lista?`
                                  );
                                  if (!confirmed) return;
                                  runAction(readyActionKey, async () => {
                                    await markReadyAction({ orderId: order.id });
                                  });
                                }}
                                className="h-11 rounded-xl border border-[#FEEF00]/50 bg-[#FEEF00] px-2 text-sm font-black text-black active:scale-[0.98] disabled:opacity-60"
                              >
                                {isPending && pendingKey === readyActionKey ? 'Marcando...' : 'Marcar lista'}
                              </button>
                            </div>
                            <button
                              type="button"
                              disabled={isPending || connectionState === 'offline'}
                              onClick={() => setIncidentOrderId((current) => current === order.id ? null : order.id)}
                              className="h-10 w-full rounded-xl border border-red-400/40 bg-red-400/10 px-3 text-xs font-black text-red-100 active:scale-[0.98]"
                            >
                              {incidentOpen ? 'Cerrar problema' : 'Reportar problema'}
                            </button>
                            {incidentOpen ? (
                              <div className="rounded-xl border border-red-400/35 bg-[#260F13] p-2.5">
                                <div className="grid grid-cols-2 gap-1.5">
                                  {KITCHEN_INCIDENT_REASONS.map((reason) => {
                                    const activeReason = reason.key === incidentReasonKey;
                                    return (
                                      <button
                                        key={`${order.id}-${reason.key}`}
                                        type="button"
                                        disabled={isPending}
                                        onClick={() =>
                                          setIncidentReasonByOrder((current) => ({ ...current, [order.id]: reason.key }))
                                        }
                                        className={[
                                          'min-h-10 rounded-lg border px-2 text-left text-xs font-semibold active:scale-[0.98]',
                                          activeReason
                                            ? 'border-[#FEEF00]/70 bg-[#FEEF00] text-black'
                                            : 'border-red-400/30 bg-[#12090B] text-red-100',
                                        ].join(' ')}
                                      >
                                        {reason.label}
                                      </button>
                                    );
                                  })}
                                </div>
                                <textarea
                                  value={incidentNote}
                                  onChange={(event) =>
                                    setIncidentNoteByOrder((current) => ({ ...current, [order.id]: event.target.value }))
                                  }
                                  rows={2}
                                  placeholder="Nota opcional"
                                  className="mt-2 w-full rounded-lg border border-red-400/30 bg-[#12090B] px-2.5 py-2 text-sm text-[#F5F5F7] placeholder:text-red-100/45"
                                />
                                  <button
                                    type="button"
                                    disabled={isPending || connectionState === 'offline'}
                                  onClick={() =>
                                    runAction(incidentActionKey, async () => {
                                      await reportKitchenIncidentAction({
                                        orderId: order.id,
                                        reason: `${incidentReason.label}: ${incidentReason.message}`,
                                        note: incidentNote,
                                      });
                                      setIncidentOrderId(null);
                                      setIncidentNoteByOrder((current) => ({ ...current, [order.id]: '' }));
                                    })
                                  }
                                  className="mt-2 h-10 w-full rounded-xl border border-red-300/50 bg-red-500/20 px-3 text-sm font-black text-red-50 active:scale-[0.98] disabled:opacity-60"
                                >
                                  {isPending && pendingKey === incidentActionKey ? 'Enviando...' : 'Avisar al master'}
                                </button>
                              </div>
                            ) : null}
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
      aria-pressed={active}
      aria-label={`${label}: ${value} pedidos`}
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
