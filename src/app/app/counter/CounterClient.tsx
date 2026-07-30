'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { getOperationalStatusLabel } from '@/lib/orders/order-labels';
import { createSupabaseBrowser } from '@/lib/supabase/browser';
import type { OrderComposerProductComponent } from '@/lib/orders/order-composer';
import { ModulePreference } from '../ModulePreference';
import {
  applyCounterPaymentAction,
  changeCounterPickupItemsAction,
  completeCounterPickupAction,
  createCounterCashClosureAction,
  createCounterCashMovementAction,
  createCounterQuickSaleAction,
  dispatchCounterDeliveryAction,
  executeCounterRefundAction,
  requestCounterRefundAction,
  searchCounterHistoricalOrdersAction,
  type CounterHistoricalSearchCursor,
  type CounterHistoricalSearchResult,
  updateCounterPickupScheduleAction,
} from './actions';
import { CounterPendingSettlementsPanel } from './CounterDeliveryWorkspace';
import type {
  CounterDeliveryDispatchIntent,
  CounterDeliveryDispatchResult,
} from './delivery-contract';
import type {
  CounterPaymentIntent,
  CounterPaymentOperationResult,
  CounterRefundAuthorization,
  CounterRefundExecutionIntent,
  CounterRefundExecutionResult,
  CounterRefundRequestIntent,
  CounterRefundRequestResult,
} from './payment-contract';
import type {
  CounterPickupChangeRequest,
  CounterPickupItemChangeIntent,
  CounterPickupItemChangeResult,
  CounterPickupScheduleIntent,
  CounterPickupScheduleResult,
} from './pickup-contract';
import type {
  CounterDirectSaleIntent,
  CounterDiscountRuleOption,
} from './direct-sale-contract';
import type {
  CounterCashClosureInput,
  CounterCashMovementInput,
} from './CounterCashWorkspace';
import {
  loadCounterCashSnapshotAction,
  loadCounterCatalogAction,
  loadCounterOrderDetailAction,
  refreshCounterQueueAction,
} from './read-actions';

const CounterCashPanel = dynamic(
  () => import('./CounterCashWorkspace').then((module) => module.CounterCashPanel),
  { loading: () => <CounterWorkspaceLoading label="Abriendo caja..." /> }
);

const CounterHistoricalSearchPanel = dynamic(
  () => import('./CounterHistoricalSearchWorkspace').then((module) => module.CounterHistoricalSearchPanel),
  { loading: () => <CounterWorkspaceLoading label="Abriendo búsqueda..." compact /> }
);

const CounterQuickSalePanel = dynamic(
  () => import('./CounterQuickSaleWorkspace').then((module) => module.CounterQuickSalePanel),
  { loading: () => <CounterWorkspaceLoading label="Abriendo nueva venta..." /> }
);

const OrderDetail = dynamic(
  () => import('./CounterOrderWorkspace').then((module) => module.OrderDetail),
  { loading: () => <CounterWorkspaceLoading label="Abriendo orden..." /> }
);

export type CounterPaymentAccountOption = {
  accountId: number;
  accountName: string;
  accountKind: string;
  currencyCode: 'USD' | 'VES';
  paymentMethodCode: string;
  canReportPayment: boolean;
  canConfirmPayment: boolean;
  autoConfirmsReport: boolean;
  reviewRequired: boolean;
};

export type CounterCashMovement = {
  id: number;
  movementDate: string;
  createdAt: string | null;
  direction: 'inflow' | 'outflow';
  movementType: string;
  amount: number;
  amountUsdEquivalent: number;
  currencyCode: 'USD' | 'VES';
  referenceCode: string | null;
  counterpartyName: string | null;
  description: string | null;
  orderId: number | null;
  createdByName: string | null;
};

export type CounterCashMovementCursor = {
  createdAt: string;
  id: number;
};

export type CounterCashMovementPage = {
  results: CounterCashMovement[];
  nextCursor: CounterCashMovementCursor | null;
};

export type CounterCashPendingRequest = {
  id: number;
  movementGroupId: string | null;
  movementDate: string;
  createdAt: string | null;
  amount: number;
  amountUsdEquivalent: number;
  currencyCode: 'USD' | 'VES';
  referenceCode: string | null;
  counterpartyName: string | null;
  description: string | null;
  approvalReason: string | null;
  createdByName: string | null;
};

export type CounterCashClosureSummary = {
  id: number;
  closureAt: string;
  expectedAmount: number;
  countedAmount: number;
  differenceAmount: number;
  createdByName: string | null;
};

export type CounterCashAccountSummary = {
  accountId: number;
  accountName: string;
  accountKind: string;
  closureKind: string;
  currencyCode: 'USD' | 'VES';
  methods: string[];
  inflow: number;
  outflow: number;
  net: number;
  balance: number;
  closureExpectedAmount: number;
  closureReady: boolean;
  movementCount: number;
  lastClosure: CounterCashClosureSummary | null;
  pendingRequestCount: number;
  pendingRequests: CounterCashPendingRequest[];
  movements: CounterCashMovement[];
};

export type CounterQuickSaleProductOption = {
  id: number;
  sku: string | null;
  name: string;
  type: string | null;
  sourcePriceCurrency: 'USD' | 'VES';
  sourcePriceAmount: number;
  basePriceUsd: number;
  basePriceBs: number;
  unitsPerService: number;
  isDetailEditable: boolean;
  detailUnitsLimit: number;
  isComboComponentSelectable: boolean;
};

export type CounterQuickSaleProductComponent = OrderComposerProductComponent & {
  id: number;
  parentSku: string | null;
  parentName: string | null;
  componentSku: string | null;
  componentType: string | null;
  notes: string | null;
};

export type CounterOrderItem = {
  id: number;
  qty: number;
  name: string;
  lineTotalUsd: number;
  lineTotalBs: number;
  notes: string | null;
};

export type CounterOrder = {
  id: number;
  orderNumber: string;
  displayNumber: string;
  status:
    | 'created'
    | 'queued'
    | 'confirmed'
    | 'in_kitchen'
    | 'ready'
    | 'out_for_delivery'
    | 'delivered'
    | 'cancelled';
  source: string | null;
  isCounterSale: boolean;
  isCounterScheduled: boolean;
  fulfillment: 'pickup' | 'delivery';
  clientName: string;
  clientPhone: string | null;
  advisorName: string | null;
  hasAdvisor: boolean;
  deliveryAddress: string | null;
  deliveryMode: string | null;
  deliveryAssigneeKind: 'internal' | 'external' | null;
  deliveryAssigneeName: string | null;
  externalReference: string | null;
  notes: string | null;
  createdAt: string;
  sentToKitchenAt: string | null;
  kitchenStartedAt: string | null;
  readyAt: string | null;
  deliveredAt: string | null;
  receiverName: string | null;
  receiverPhone: string | null;
  scheduledDate: string | null;
  scheduledTime: string | null;
  paymentMethod: string;
  paymentCurrency: string | null;
  paymentRequiresChange: boolean;
  paymentChangeFor: string | null;
  paymentChangeCurrency: string | null;
  paymentNote: string | null;
  totalUsd: number;
  totalBs: number;
  fxRate: number;
  confirmedPaidUsd: number;
  balanceUsd: number;
  paymentStatus: string;
  pendingReportsUsd: number;
  overpaidUsd: number;
  pendingDigitalChangeUsd: number;
  refundAuthorizations: CounterRefundAuthorization[];
  reports: {
    pending: number;
    confirmed: number;
    rejected: number;
  };
  items: CounterOrderItem[];
  pickupChangeRequests: CounterPickupChangeRequest[];
  detailLoaded: boolean;
};

type CounterClientProps = {
  publicVapidKey: string;
  fullName: string;
  orders: CounterOrder[];
  paymentAccounts: CounterPaymentAccountOption[];
  activeBsRate: number;
};

type PushState = 'checking' | 'unsupported' | 'denied' | 'ready' | 'subscribed' | 'error';

type CounterConnectionState = 'connecting' | 'live' | 'fallback' | 'offline';

type CounterSyncResource = 'queue' | 'detail' | 'cash' | 'settlements';

type CounterSyncMetric = {
  calls: number;
  errors: number;
  totalDurationMs: number;
  lastDurationMs: number | null;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
};

type CounterSyncMetrics = Record<CounterSyncResource, CounterSyncMetric>;

type CounterFilter =
  | 'ready'
  | 'kitchen'
  | 'pickup'
  | 'delivery';

const FILTERS: Array<{ key: CounterFilter; label: string }> = [
  { key: 'ready', label: 'Listos' },
  { key: 'kitchen', label: 'En cocina' },
  { key: 'pickup', label: 'Pickup' },
  { key: 'delivery', label: 'Delivery' },
];

const PUSH_TIMEOUT_MS = 12000;
const COUNTER_CATALOG_FRESH_MS = 60_000;
const COUNTER_SYNC_TICK_MS = 15_000;
const COUNTER_LIVE_QUEUE_REPAIR_MS = 5 * 60_000;
const COUNTER_FALLBACK_QUEUE_MS = 60_000;
const COUNTER_DETAIL_REFRESH_MS = 2 * 60_000;
const COUNTER_OPEN_RESOURCE_REFRESH_MS = 2 * 60_000;
const COUNTER_SYNC_RESOURCE_LABELS: Record<CounterSyncResource, string> = {
  queue: 'Cola',
  detail: 'Detalle',
  cash: 'Caja',
  settlements: 'Liquidaciones',
};

const INITIAL_SYNC_METRICS: CounterSyncMetrics = {
  queue: {
    calls: 0,
    errors: 0,
    totalDurationMs: 0,
    lastDurationMs: null,
    lastSuccessAt: null,
    lastErrorAt: null,
  },
  detail: {
    calls: 0,
    errors: 0,
    totalDurationMs: 0,
    lastDurationMs: null,
    lastSuccessAt: null,
    lastErrorAt: null,
  },
  cash: {
    calls: 0,
    errors: 0,
    totalDurationMs: 0,
    lastDurationMs: null,
    lastSuccessAt: null,
    lastErrorAt: null,
  },
  settlements: {
    calls: 0,
    errors: 0,
    totalDurationMs: 0,
    lastDurationMs: null,
    lastSuccessAt: null,
    lastErrorAt: null,
  },
};

function orderSummaryFingerprint(order: CounterOrder) {
  return JSON.stringify([
    order.status,
    order.readyAt,
    order.deliveredAt,
    order.scheduledDate,
    order.scheduledTime,
    order.totalUsd,
    order.totalBs,
    order.confirmedPaidUsd,
    order.balanceUsd,
    order.paymentStatus,
    order.pendingReportsUsd,
    order.overpaidUsd,
    order.pendingDigitalChangeUsd,
    order.reports.pending,
    order.reports.confirmed,
    order.reports.rejected,
  ]);
}

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
      };

      worker.addEventListener('statechange', onStateChange);

      if (worker.state === 'activated') {
        worker.removeEventListener('statechange', onStateChange);
        resolve();
      }

      if (worker.state === 'redundant') {
        worker.removeEventListener('statechange', onStateChange);
        reject(new Error('El servicio de notificaciones no pudo activarse.'));
      }
    }),
    'La app tardo demasiado en activar el servicio de notificaciones.'
  );

  return navigator.serviceWorker.ready;
}

function playCounterAlert() {
  try {
    const AudioContextCtor = window.AudioContext || (window as Window & {
      webkitAudioContext?: typeof AudioContext;
    }).webkitAudioContext;
    if (!AudioContextCtor) return;

    const ctx = new AudioContextCtor();
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    oscillator.type = 'square';
    oscillator.frequency.setValueAtTime(740, ctx.currentTime);
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.16, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.38);
    oscillator.connect(gain);
    gain.connect(ctx.destination);
    oscillator.start();
    oscillator.stop(ctx.currentTime + 0.42);
    setTimeout(() => void ctx.close().catch(() => undefined), 650);
  } catch {
    // Browsers can block audio until the user interacts with the page.
  }
}

function moneyUsd(value: number) {
  return `$${value.toLocaleString('es-VE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function moneyBs(value: number) {
  return `Bs ${value.toLocaleString('es-VE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function formatDateTime(value: string | null) {
  if (!value) return 'Sin hora';

  return new Date(value).toLocaleString('es-VE', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: 'America/Caracas',
  });
}

function formatRefreshTime(value: string | null) {
  if (!value) return 'Datos iniciales';

  return `Actualizado ${new Date(value).toLocaleTimeString('es-VE', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'America/Caracas',
  })}`;
}

function connectionStateLabel(state: CounterConnectionState) {
  if (state === 'live') return 'En vivo';
  if (state === 'fallback') return 'Respaldo ligero';
  if (state === 'offline') return 'Sin conexion';
  return 'Conectando';
}

function connectionStateClass(state: CounterConnectionState) {
  if (state === 'live') {
    return 'border-emerald-400/40 bg-emerald-400/10 text-emerald-200';
  }
  if (state === 'offline') {
    return 'border-red-400/40 bg-red-400/10 text-red-200';
  }
  return 'border-orange-400/40 bg-orange-400/10 text-orange-100';
}

function averageMetricDuration(metric: CounterSyncMetric) {
  if (metric.calls === 0) return '-';
  return `${Math.round(metric.totalDurationMs / metric.calls)} ms`;
}

function paymentLabel(order: CounterOrder) {
  if (order.overpaidUsd > 0.005) return 'Saldo a favor';
  if (order.reports.pending > 0) return 'Pago por revisar';
  if (order.balanceUsd <= 0.005) return 'Pagado';
  if (order.confirmedPaidUsd > 0.005) return 'Abonado';
  return 'Pendiente';
}

function isCounterImmediatePaymentMethod(method: string | null | undefined) {
  const normalized = String(method || '').trim();
  return normalized === 'pos' || normalized === 'cash_usd' || normalized === 'cash_ves';
}

function mustSettleBeforeCounterDelivery(order: CounterOrder) {
  if (order.pendingDigitalChangeUsd > 0.005) return true;
  const hasUnconfirmedPayment = order.reports.pending > 0;
  if (order.balanceUsd <= 0.005 && !hasUnconfirmedPayment) return false;
  if (isCounterImmediatePaymentMethod(order.paymentMethod) && order.balanceUsd > 0.005) return true;
  if (order.hasAdvisor && hasUnconfirmedPayment) return false;
  return !order.hasAdvisor && (order.balanceUsd > 0.005 || hasUnconfirmedPayment);
}

function fulfillmentLabel(value: CounterOrder['fulfillment']) {
  return value === 'delivery' ? 'Delivery' : 'Pickup';
}

function counterStatusClass(order: CounterOrder) {
  if (order.status === 'delivered') return 'border-emerald-400/40 bg-emerald-400/10 text-emerald-200';
  if (order.status === 'cancelled') return 'border-red-400/40 bg-red-400/10 text-red-200';
  if (order.status === 'out_for_delivery') return 'border-sky-400/40 bg-sky-400/10 text-sky-200';
  if (order.status === 'in_kitchen') return 'border-emerald-400/40 bg-emerald-400/10 text-emerald-200';
  if (order.status === 'created') return 'border-purple-300/40 bg-purple-300/10 text-purple-100';
  if (order.status === 'queued' || order.status === 'confirmed') return 'border-orange-400/40 bg-orange-400/10 text-orange-200';
  return 'border-[#FEEF00]/50 bg-[#FEEF00]/10 text-[#FEEF00]';
}

function primaryCounterActionLabel(order: CounterOrder) {
  if (order.status === 'delivered') return 'Orden entregada';
  if (order.status === 'cancelled') return 'Orden cancelada';
  if (order.status === 'created') return 'Esperar Master';
  if (order.status === 'queued' || order.status === 'confirmed') return 'En cola de cocina';
  if (order.status === 'in_kitchen') return 'Esperar cocina';
  if (order.status === 'out_for_delivery') return 'Liquidar regreso';
  if (order.fulfillment === 'pickup' && order.status === 'ready' && mustSettleBeforeCounterDelivery(order)) return 'Primero cobrar';
  if (order.fulfillment === 'delivery' && order.status === 'ready') {
    return order.deliveryAssigneeName ? 'Entregar a motorizado' : 'Esperar asignación';
  }
  return 'Entregar pickup';
}

function deliveryAssigneeLabel(order: CounterOrder) {
  if (order.fulfillment !== 'delivery') return null;
  if (!order.deliveryAssigneeName) return 'Sin asignar';
  return order.deliveryAssigneeKind === 'external'
    ? `Externo: ${order.deliveryAssigneeName}`
    : `Interno: ${order.deliveryAssigneeName}`;
}

function scheduleLabel(order: CounterOrder) {
  if (order.scheduledDate && order.scheduledTime) return `${order.scheduledDate} - ${order.scheduledTime}`;
  if (order.scheduledDate) return order.scheduledDate;
  return formatDateTime(order.createdAt);
}

function isCounterAgendaOrder(order: CounterOrder) {
  return order.isCounterSale && order.status === 'created';
}

function isKitchenFollowUpOrder(order: CounterOrder) {
  return order.status === 'confirmed' || order.status === 'in_kitchen';
}

function isCounterReadyPickup(order: CounterOrder) {
  return order.fulfillment === 'pickup' && order.status === 'ready';
}

function isCounterReadyDelivery(order: CounterOrder) {
  return order.fulfillment === 'delivery' && order.status === 'ready';
}

function isCounterRouteSettlement(order: CounterOrder) {
  return order.status === 'out_for_delivery';
}

function getCounterOrderPriority(order: CounterOrder) {
  if (isCounterReadyPickup(order) && order.balanceUsd > 0.005) return 1;
  if (isCounterReadyPickup(order)) return 2;
  if (isCounterReadyDelivery(order) && !order.deliveryAssigneeName) return 3;
  if (isCounterReadyDelivery(order)) return 4;
  if (isCounterRouteSettlement(order) && order.balanceUsd > 0.005) return 5;
  if (isCounterRouteSettlement(order)) return 6;
  if (isKitchenFollowUpOrder(order)) return 7;
  if (isCounterAgendaOrder(order)) return 8;
  return 20;
}

function sortCounterOrders(orders: CounterOrder[]) {
  return [...orders].sort((a, b) => {
    const priorityDiff = getCounterOrderPriority(a) - getCounterOrderPriority(b);
    if (priorityDiff !== 0) return priorityDiff;
    const aTime = Date.parse(a.readyAt || a.createdAt || '');
    const bTime = Date.parse(b.readyAt || b.createdAt || '');
    return (Number.isFinite(aTime) ? aTime : 0) - (Number.isFinite(bTime) ? bTime : 0);
  });
}

export default function CounterClient({
  publicVapidKey,
  fullName,
  orders,
  paymentAccounts,
  activeBsRate,
}: CounterClientProps) {
  const supabase = useMemo(() => createSupabaseBrowser(), []);
  const [isPending, startTransition] = useTransition();
  const [workingOrderId, setWorkingOrderId] = useState<number | null>(null);
  const [message, setMessage] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const [localOrders, setLocalOrders] = useState(orders);
  const localOrdersRef = useRef(orders);
  const [recoveredOrder, setRecoveredOrder] = useState<CounterOrder | null>(null);
  const recoveredOrderRef = useRef<CounterOrder | null>(null);
  const previousOrderIdsRef = useRef(new Set(orders.map((order) => order.id)));
  const previousOrderStatesRef = useRef(
    new Map(orders.map((order) => [order.id, order.status] as const))
  );
  const alertedReadyOrderIdsRef = useRef(
    new Set(orders.filter((order) => order.status === 'ready').map((order) => order.id))
  );
  const processedRealtimeEventIdsRef = useRef(new Set<number>());
  const processedPushTagsRef = useRef(new Set<string>());
  const pendingQueueSignalRef = useRef(false);
  const queueRefreshInFlightRef = useRef<Promise<void> | null>(null);
  const cashRefreshInFlightRef = useRef<Promise<boolean> | null>(null);
  const detailRequestsInFlightRef = useRef(
    new Map<number, Promise<CounterOrder | null>>()
  );
  const readSequenceRef = useRef(0);
  const appliedOrderSequenceRef = useRef(new Map<number, number>());
  const pickupCompletionKeysRef = useRef(new Map<number, string>());
  const selectedOrderIdRef = useRef<number | null>(null);
  const queueSearchRef = useRef<HTMLInputElement>(null);
  const detailStaleOrderIdRef = useRef<number | null>(null);
  const cashPanelOpenRef = useRef(false);
  const settlementsPanelOpenRef = useRef(false);
  const detailLastReadAtRef = useRef(new Map<number, number>());
  const resourceLastAttemptAtRef = useRef<Record<CounterSyncResource, number>>({
    queue: Date.now(),
    detail: 0,
    cash: 0,
    settlements: 0,
  });
  const [queueRefreshing, setQueueRefreshing] = useState(false);
  const [detailLoadingOrderId, setDetailLoadingOrderId] = useState<number | null>(null);
  const [lastAutoRefreshAt, setLastAutoRefreshAt] = useState<string | null>(null);
  const [connectionState, setConnectionState] =
    useState<CounterConnectionState>('connecting');
  const [lastRealtimeEventAt, setLastRealtimeEventAt] = useState<string | null>(null);
  const [detailStaleOrderId, setDetailStaleOrderId] = useState<number | null>(null);
  const [settlementsRefreshToken, setSettlementsRefreshToken] = useState(0);
  const [syncDetailsOpen, setSyncDetailsOpen] = useState(false);
  const [syncMetrics, setSyncMetrics] =
    useState<CounterSyncMetrics>(INITIAL_SYNC_METRICS);
  const [pushState, setPushState] = useState<PushState>('checking');
  const [pushBusy, setPushBusy] = useState(false);
  const [filter, setFilter] = useState<CounterFilter>('ready');
  const [search, setSearch] = useState('');
  const [selectedOrderId, setSelectedOrderId] = useState<number | null>(null);
  const [quickSaleOpen, setQuickSaleOpen] = useState(false);
  const [cashPanelOpen, setCashPanelOpen] = useState(false);
  const [settlementsPanelOpen, setSettlementsPanelOpen] = useState(false);
  const [cashAccounts, setCashAccounts] = useState<CounterCashAccountSummary[]>([]);
  const [cashLoading, setCashLoading] = useState(false);
  const [quickSaleProducts, setQuickSaleProducts] = useState<CounterQuickSaleProductOption[]>([]);
  const [quickSaleProductComponents, setQuickSaleProductComponents] = useState<CounterQuickSaleProductComponent[]>([]);
  const [quickSaleDiscountRules, setQuickSaleDiscountRules] = useState<CounterDiscountRuleOption[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const catalogLoadedRef = useRef(false);
  const catalogLoadedAtRef = useRef(0);
  const [paymentOrderIdToOpen, setPaymentOrderIdToOpen] = useState<number | null>(null);
  const [historicalSearch, setHistoricalSearch] = useState('');
  const [historicalResults, setHistoricalResults] = useState<CounterHistoricalSearchResult[]>([]);
  const [historicalNextCursor, setHistoricalNextCursor] = useState<CounterHistoricalSearchCursor | null>(null);
  const [historicalSearched, setHistoricalSearched] = useState(false);
  const [historicalSearchOpen, setHistoricalSearchOpen] = useState(false);

  useEffect(() => {
    const focusQueueSearch = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const isEditing = Boolean(
        target?.closest('input, textarea, select, [contenteditable="true"]')
      );
      if (event.key !== '/' || isEditing || event.ctrlKey || event.metaKey || event.altKey) return;
      event.preventDefault();
      queueSearchRef.current?.focus();
    };

    window.addEventListener('keydown', focusQueueSearch);
    return () => window.removeEventListener('keydown', focusQueueSearch);
  }, []);

  const recordReadMetric = useCallback((
    resource: CounterSyncResource,
    durationMs: number,
    succeeded: boolean
  ) => {
    const now = new Date().toISOString();
    setSyncMetrics((current) => ({
      ...current,
      [resource]: {
        calls: current[resource].calls + 1,
        errors: current[resource].errors + (succeeded ? 0 : 1),
        totalDurationMs: current[resource].totalDurationMs + durationMs,
        lastDurationMs: durationMs,
        lastSuccessAt: succeeded ? now : current[resource].lastSuccessAt,
        lastErrorAt: succeeded ? current[resource].lastErrorAt : now,
      },
    }));
  }, []);

  const runMeasuredRead = useCallback(async <T,>(
    resource: CounterSyncResource,
    operation: () => Promise<T>
  ) => {
    resourceLastAttemptAtRef.current[resource] = Date.now();
    const startedAt = performance.now();
    try {
      const result = await operation();
      recordReadMetric(resource, performance.now() - startedAt, true);
      return result;
    } catch (error) {
      recordReadMetric(resource, performance.now() - startedAt, false);
      throw error;
    }
  }, [recordReadMetric]);

  const recordSettlementsReadMetric = useCallback((
    durationMs: number,
    succeeded: boolean
  ) => {
    recordReadMetric('settlements', durationMs, succeeded);
  }, [recordReadMetric]);

  const announceReadyOrders = useCallback((readyOrders: CounterOrder[]) => {
    const unseen = readyOrders.filter(
      (order) => !alertedReadyOrderIdsRef.current.has(order.id)
    );
    if (unseen.length === 0) return;

    for (const order of unseen) alertedReadyOrderIdsRef.current.add(order.id);
    if (alertedReadyOrderIdsRef.current.size > 500) {
      alertedReadyOrderIdsRef.current = new Set(
        Array.from(alertedReadyOrderIdsRef.current).slice(-250)
      );
    }

    const firstOrder = unseen[0];
    setMessage({
      tone: 'success',
      text:
        unseen.length === 1
          ? `Pedido listo: #${firstOrder.displayNumber} - ${firstOrder.clientName}.`
          : `${unseen.length} pedidos quedaron listos para mostrador.`,
    });
    if (document.visibilityState === 'visible') playCounterAlert();
  }, []);

  const refreshCounter = useCallback(async () => {
    if (queueRefreshInFlightRef.current) return queueRefreshInFlightRef.current;

    pendingQueueSignalRef.current = false;
    const requestSequence = ++readSequenceRef.current;
    const request = (async () => {
      setQueueRefreshing(true);
      try {
        const nextOrders = await runMeasuredRead('queue', refreshCounterQueueAction);
        const previousIds = previousOrderIdsRef.current;
        const previousStates = previousOrderStatesRef.current;
        const newOrders = nextOrders.filter((order) => !previousIds.has(order.id));
        const newlyReadyOrders = nextOrders.filter(
          (order) =>
            order.status === 'ready'
            && previousStates.get(order.id) !== 'ready'
        );
        const currentById = new Map(
          localOrdersRef.current.map((order) => [order.id, order])
        );
        const selectedId = selectedOrderIdRef.current;
        const selectedSummary = selectedId == null
          ? null
          : nextOrders.find((order) => order.id === selectedId) ?? null;
        const selectedCurrent = selectedId == null
          ? null
          : currentById.get(selectedId) ?? recoveredOrderRef.current;

        previousOrderIdsRef.current = new Set(nextOrders.map((order) => order.id));
        previousOrderStatesRef.current = new Map(
          nextOrders.map((order) => [order.id, order.status] as const)
        );
        setLocalOrders((current) => {
          const currentById = new Map(current.map((order) => [order.id, order]));
          const nextIds = new Set(nextOrders.map((order) => order.id));
          const merged = nextOrders.flatMap((summary) => {
            const previous = currentById.get(summary.id);
            if (
              (appliedOrderSequenceRef.current.get(summary.id) ?? 0) > requestSequence
            ) {
              return previous ? [previous] : [];
            }
            appliedOrderSequenceRef.current.set(summary.id, requestSequence);
            return [previous?.detailLoaded
              ? {
                  ...summary,
                  items: previous.items,
                  pickupChangeRequests: previous.pickupChangeRequests,
                  detailLoaded: true,
                }
              : summary];
          });
          for (const currentOrder of current) {
            if (
              !nextIds.has(currentOrder.id)
              && (appliedOrderSequenceRef.current.get(currentOrder.id) ?? 0) > requestSequence
            ) {
              merged.push(currentOrder);
            }
          }
          localOrdersRef.current = merged;
          return merged;
        });
        setSelectedOrderId((current) =>
          current != null && (
            nextOrders.some((order) => order.id === current)
            || recoveredOrderRef.current?.id === current
          )
            ? current
            : null
        );
        setLastAutoRefreshAt(new Date().toISOString());

        if (
          selectedId != null
          && selectedCurrent?.detailLoaded
          && selectedSummary
          && orderSummaryFingerprint(selectedCurrent) !== orderSummaryFingerprint(selectedSummary)
        ) {
          setDetailStaleOrderId(selectedId);
        }

        announceReadyOrders(newlyReadyOrders);
        if (newlyReadyOrders.length === 0 && newOrders.length > 0) {
          const firstOrder = newOrders[0];
          setMessage({
            tone: 'success',
            text:
              newOrders.length === 1
                ? `Nuevo pedido visible: #${firstOrder.displayNumber} - ${firstOrder.clientName}.`
                : `${newOrders.length} pedidos nuevos visibles en mostrador.`,
          });
        }
      } catch (error) {
        setMessage({
          tone: 'error',
          text: error instanceof Error ? error.message : 'No se pudo actualizar la cola del mostrador.',
        });
      } finally {
        setQueueRefreshing(false);
        queueRefreshInFlightRef.current = null;
      }
    })();

    queueRefreshInFlightRef.current = request;
    return request;
  }, [announceReadyOrders, runMeasuredRead]);

  const refreshCounterOrder = useCallback(async (orderId: number) => {
    const existingRequest = detailRequestsInFlightRef.current.get(orderId);
    if (existingRequest) return existingRequest;

    const requestSequence = ++readSequenceRef.current;
    const request = (async () => {
      setDetailLoadingOrderId(orderId);
      try {
        const detail = await runMeasuredRead(
          'detail',
          () => loadCounterOrderDetailAction({ orderId })
        );
        if (
          (appliedOrderSequenceRef.current.get(detail.id) ?? 0) > requestSequence
        ) {
          setDetailStaleOrderId(detail.id);
          return null;
        }
        appliedOrderSequenceRef.current.set(detail.id, requestSequence);
        detailLastReadAtRef.current.set(detail.id, Date.now());
        setLocalOrders((current) => {
          const next = current.map((order) =>
            order.id === detail.id ? detail : order
          );
          localOrdersRef.current = next;
          return next;
        });
        if (recoveredOrderRef.current?.id === detail.id) {
          recoveredOrderRef.current = detail;
          setRecoveredOrder(detail);
        }
        setDetailStaleOrderId((current) => current === detail.id ? null : current);
        return detail;
      } catch (error) {
        setMessage({
          tone: 'error',
          text: error instanceof Error ? error.message : 'No se pudo cargar el detalle de la orden.',
        });
        return null;
      } finally {
        detailRequestsInFlightRef.current.delete(orderId);
        setDetailLoadingOrderId((current) => current === orderId ? null : current);
      }
    })();

    detailRequestsInFlightRef.current.set(orderId, request);
    return request;
  }, [runMeasuredRead]);

  const ensureCounterCatalog = useCallback(async (refreshIfStale = false) => {
    const catalogIsFresh =
      catalogLoadedRef.current &&
      Date.now() - catalogLoadedAtRef.current < COUNTER_CATALOG_FRESH_MS;
    if (catalogLoadedRef.current && (!refreshIfStale || catalogIsFresh)) return true;
    setCatalogLoading(true);
    try {
      const catalog = await loadCounterCatalogAction();
      setQuickSaleProducts(catalog.products);
      setQuickSaleProductComponents(catalog.components);
      setQuickSaleDiscountRules(catalog.discountRules);
      catalogLoadedRef.current = true;
      catalogLoadedAtRef.current = Date.now();
      return true;
    } catch (error) {
      setMessage({
        tone: 'error',
        text: error instanceof Error ? error.message : 'No se pudo cargar el catalogo.',
      });
      return false;
    } finally {
      setCatalogLoading(false);
    }
  }, []);

  const refreshCounterCash = useCallback(async () => {
    if (cashRefreshInFlightRef.current) return cashRefreshInFlightRef.current;
    const request = (async () => {
      setCashLoading(true);
      try {
        setCashAccounts(await runMeasuredRead('cash', loadCounterCashSnapshotAction));
        return true;
      } catch (error) {
        setMessage({
          tone: 'error',
          text: error instanceof Error ? error.message : 'No se pudo cargar la caja.',
        });
        return false;
      } finally {
        setCashLoading(false);
        cashRefreshInFlightRef.current = null;
      }
    })();
    cashRefreshInFlightRef.current = request;
    return request;
  }, [runMeasuredRead]);

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
    const previousOrderIds = previousOrderIdsRef.current;
    const previousStates = previousOrderStatesRef.current;
    const newOrders = orders.filter((order) => !previousOrderIds.has(order.id));
    const newlyReadyOrders = orders.filter(
      (order) =>
        order.status === 'ready'
        && previousStates.get(order.id) !== 'ready'
    );
    previousOrderIdsRef.current = new Set(orders.map((order) => order.id));
    previousOrderStatesRef.current = new Map(
      orders.map((order) => [order.id, order.status] as const)
    );

    localOrdersRef.current = orders;
    setLocalOrders(orders);
    setSelectedOrderId((current) =>
      current != null && orders.some((order) => order.id === current) ? current : null
    );

    announceReadyOrders(newlyReadyOrders);
    if (newlyReadyOrders.length === 0 && newOrders.length > 0) {
      const firstOrder = newOrders[0];
      setMessage({
        tone: 'success',
        text:
        newOrders.length === 1
          ? `Nuevo pedido visible: #${firstOrder.displayNumber} - ${firstOrder.clientName}.`
          : `${newOrders.length} pedidos nuevos visibles en mostrador.`,
      });
    }
  }, [announceReadyOrders, orders]);

  useEffect(() => {
    selectedOrderIdRef.current = selectedOrderId;
  }, [selectedOrderId]);

  useEffect(() => {
    detailStaleOrderIdRef.current = detailStaleOrderId;
  }, [detailStaleOrderId]);

  useEffect(() => {
    cashPanelOpenRef.current = cashPanelOpen;
  }, [cashPanelOpen]);

  useEffect(() => {
    settlementsPanelOpenRef.current = settlementsPanelOpen;
  }, [settlementsPanelOpen]);

  useEffect(() => {
    let disposed = false;
    let liveConnection = false;
    let queueDebounceId: number | null = null;

    const scheduleQueueRefresh = () => {
      pendingQueueSignalRef.current = true;
      if (queueDebounceId != null) window.clearTimeout(queueDebounceId);
      queueDebounceId = window.setTimeout(() => {
        queueDebounceId = null;
        if (!disposed && document.visibilityState === 'visible' && navigator.onLine) {
          void refreshCounter();
        }
      }, 250);
    };

    const refreshVisibleResources = (returningToTab = false) => {
      if (
        disposed
        || document.visibilityState !== 'visible'
        || !navigator.onLine
      ) {
        return;
      }

      const now = Date.now();
      const queueRefreshMs = liveConnection
        ? COUNTER_LIVE_QUEUE_REPAIR_MS
        : COUNTER_FALLBACK_QUEUE_MS;
      const queueAge = now - resourceLastAttemptAtRef.current.queue;
      if (
        pendingQueueSignalRef.current
        ||
        queueAge >= queueRefreshMs
        || (returningToTab && queueAge >= 30_000)
      ) {
        void refreshCounter();
      }

      const detailOrderId = selectedOrderIdRef.current;
      if (detailOrderId != null) {
        const detailAge = now - (detailLastReadAtRef.current.get(detailOrderId) ?? 0);
        if (
          detailAge >= COUNTER_DETAIL_REFRESH_MS
          || detailStaleOrderIdRef.current === detailOrderId
        ) {
          void refreshCounterOrder(detailOrderId);
        }
      }

      if (
        cashPanelOpenRef.current
        && now - resourceLastAttemptAtRef.current.cash >= COUNTER_OPEN_RESOURCE_REFRESH_MS
      ) {
        void refreshCounterCash();
      }

      if (
        settlementsPanelOpenRef.current
        && now - resourceLastAttemptAtRef.current.settlements
          >= COUNTER_OPEN_RESOURCE_REFRESH_MS
      ) {
        resourceLastAttemptAtRef.current.settlements = now;
        setSettlementsRefreshToken((current) => current + 1);
      }
    };

    const channel = supabase
      .channel('counter-ready-orders')
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'order_timeline_event_recipients',
          filter: 'target_role=eq.counter',
        },
        (payload) => {
          const eventId = Number((payload.new as { id?: number | string } | null)?.id);
          if (
            Number.isFinite(eventId)
            && processedRealtimeEventIdsRef.current.has(eventId)
          ) {
            return;
          }
          if (Number.isFinite(eventId)) {
            processedRealtimeEventIdsRef.current.add(eventId);
            if (processedRealtimeEventIdsRef.current.size > 500) {
              processedRealtimeEventIdsRef.current = new Set(
                Array.from(processedRealtimeEventIdsRef.current).slice(-250)
              );
            }
          }
          setLastRealtimeEventAt(new Date().toISOString());
          scheduleQueueRefresh();
        }
      )
      .subscribe((status) => {
        if (disposed) return;
        if (status === 'SUBSCRIBED') {
          liveConnection = true;
          setConnectionState('live');
          refreshVisibleResources(true);
          return;
        }
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          liveConnection = false;
          setConnectionState(navigator.onLine ? 'fallback' : 'offline');
          return;
        }
        if (status === 'CLOSED') {
          liveConnection = false;
          setConnectionState(navigator.onLine ? 'fallback' : 'offline');
        }
      });

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') refreshVisibleResources(true);
    };
    const onOnline = () => {
      setConnectionState(liveConnection ? 'live' : 'connecting');
      refreshVisibleResources(true);
    };
    const onOffline = () => setConnectionState('offline');
    const intervalId = window.setInterval(
      () => refreshVisibleResources(false),
      COUNTER_SYNC_TICK_MS
    );

    if (!navigator.onLine) setConnectionState('offline');
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);

    return () => {
      disposed = true;
      if (queueDebounceId != null) window.clearTimeout(queueDebounceId);
      window.clearInterval(intervalId);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      void supabase.removeChannel(channel);
    };
  }, [
    refreshCounter,
    refreshCounterCash,
    refreshCounterOrder,
    supabase,
  ]);

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;

    const onMessage = (event: MessageEvent) => {
      const data = event.data && typeof event.data === 'object'
        ? event.data as {
            type?: string;
            payload?: { url?: string; title?: string; body?: string; tag?: string };
          }
        : null;
      if (data?.type !== 'vivo-push') return;
      const url = data.payload?.url || '';
      if (url && !url.startsWith('/app/counter')) return;
      const tag = data.payload?.tag || '';
      if (tag && processedPushTagsRef.current.has(tag)) return;
      if (tag) processedPushTagsRef.current.add(tag);

      setMessage({
        tone: 'success',
        text: data.payload?.title || data.payload?.body || 'Hay novedades en mostrador.',
      });
      const orderIdMatch = tag.match(/^counter-order-(\d+)-/);
      const orderId = orderIdMatch ? Number(orderIdMatch[1]) : null;
      const shouldAlert =
        orderId == null || !alertedReadyOrderIdsRef.current.has(orderId);
      if (orderId != null) alertedReadyOrderIdsRef.current.add(orderId);
      if (shouldAlert && document.visibilityState === 'visible') playCounterAlert();
      pendingQueueSignalRef.current = true;
      if (document.visibilityState === 'visible' && navigator.onLine) {
        void refreshCounter();
      }
    };

    navigator.serviceWorker.addEventListener('message', onMessage);
    return () => navigator.serviceWorker.removeEventListener('message', onMessage);
  }, [refreshCounter]);

  async function getAccessToken() {
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token || '';
  }

  async function enablePush() {
    setPushBusy(true);
    setMessage(null);

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
            scope: 'counter',
            subscription: subscriptionToJson(subscription),
          }),
        }),
        'Guardar las alertas tardo demasiado.'
      );

      if (!response.ok) {
        const payload = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(payload?.error || 'No se pudo guardar este dispositivo.');
      }

      playCounterAlert();
      setPushState('subscribed');
      setMessage({ tone: 'success', text: 'Alertas del mostrador activadas en este dispositivo.' });
    } catch (error) {
      setPushState((current) => current === 'denied' ? 'denied' : 'error');
      setMessage({
        tone: 'error',
        text: error instanceof Error ? error.message : 'No se pudo activar alertas.',
      });
    } finally {
      setPushBusy(false);
    }
  }

  const filterCounts = useMemo<Record<CounterFilter, number>>(() => {
    return {
      ready: localOrders.filter((order) => order.status === 'ready').length,
      kitchen: localOrders.filter(isKitchenFollowUpOrder).length,
      pickup: localOrders.filter((order) => order.fulfillment === 'pickup').length,
      delivery: localOrders.filter((order) => order.fulfillment === 'delivery').length,
    };
  }, [localOrders]);

  const filteredOrders = useMemo(() => {
    const term = search.trim().toLocaleLowerCase('es-VE');

    return sortCounterOrders(localOrders.filter((order) => {
      if (filter === 'ready' && order.status !== 'ready') return false;
      if (filter === 'kitchen' && !isKitchenFollowUpOrder(order)) return false;
      if (filter === 'pickup' && order.fulfillment !== 'pickup') return false;
      if (filter === 'delivery' && order.fulfillment !== 'delivery') return false;

      if (!term) return true;

      return [
        order.displayNumber,
        order.orderNumber,
        order.clientName,
        order.clientPhone,
        order.advisorName,
        order.deliveryAddress,
      ]
        .filter(Boolean)
        .some((value) => String(value).toLocaleLowerCase('es-VE').includes(term));
    }));
  }, [filter, localOrders, search]);

  const selectedOrder = selectedOrderId == null
    ? null
    : localOrders.find((order) => order.id === selectedOrderId)
      ?? (recoveredOrder?.id === selectedOrderId ? recoveredOrder : null);

  function handleQueueKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    if (filteredOrders.length === 0) return;

    event.preventDefault();
    const selectedIndex = filteredOrders.findIndex((order) => order.id === selectedOrderId);
    const nextIndex = event.key === 'ArrowDown'
      ? Math.min(selectedIndex < 0 ? 0 : selectedIndex + 1, filteredOrders.length - 1)
      : Math.max(selectedIndex < 0 ? filteredOrders.length - 1 : selectedIndex - 1, 0);
    const nextOrder = filteredOrders[nextIndex];
    handleSelectCounterOrder(nextOrder);
    requestAnimationFrame(() => {
      document
        .querySelector<HTMLButtonElement>(`[data-counter-order-id="${nextOrder.id}"]`)
        ?.focus();
    });
  }

  function handleSelectCounterOrder(order: CounterOrder) {
    setQuickSaleOpen(false);
    recoveredOrderRef.current = null;
    setRecoveredOrder(null);
    setSelectedOrderId(order.id);
    if (!order.detailLoaded) void refreshCounterOrder(order.id);
  }

  function handleOpenHistoricalOrder(orderId: number, openPayment: boolean) {
    setQuickSaleOpen(false);
    setMessage(null);
    setDetailLoadingOrderId(orderId);
    startTransition(async () => {
      try {
        const detail = await runMeasuredRead(
          'detail',
          () => loadCounterOrderDetailAction({ orderId })
        );
        detailLastReadAtRef.current.set(orderId, Date.now());
        recoveredOrderRef.current = detail;
        setRecoveredOrder(detail);
        setSelectedOrderId(detail.id);
        setPaymentOrderIdToOpen(openPayment && detail.status !== 'cancelled' ? detail.id : null);
      } catch (error) {
        setMessage({
          tone: 'error',
          text: error instanceof Error ? error.message : 'No se pudo abrir el expediente de la orden.',
        });
      } finally {
        setDetailLoadingOrderId((current) => current === orderId ? null : current);
      }
    });
  }

  async function handleOpenQuickSale() {
    if (quickSaleOpen) {
      setQuickSaleOpen(false);
      return;
    }
    if (await ensureCounterCatalog(true)) setQuickSaleOpen(true);
  }

  function handleToggleCashPanel() {
    if (cashPanelOpen) {
      setCashPanelOpen(false);
      return;
    }
    setCashPanelOpen(true);
    void refreshCounterCash();
  }

  const orderSections = useMemo(() => {
    const readySections = [
      {
        key: 'pickup-ready',
        title: 'Pickup listo',
        helper: 'Cliente en mostrador o por retirar.',
        orders: filteredOrders.filter(isCounterReadyPickup),
      },
      {
        key: 'delivery-ready',
        title: 'Delivery listo',
        helper: 'Entregar al motorizado y preparar cambio si aplica.',
        orders: filteredOrders.filter(isCounterReadyDelivery),
      },
    ].filter((section) => section.orders.length > 0);

    if (filter === 'ready') return readySections;

    const filterMeta: Record<Exclude<CounterFilter, 'ready'>, { title: string; helper: string }> = {
      kitchen: {
        title: 'En cocina',
        helper: 'Pedidos confirmados o en preparación.',
      },
      pickup: {
        title: 'Pickup',
        helper: 'Pedidos para retirar en mostrador.',
      },
      delivery: {
        title: 'Delivery',
        helper: 'Pedidos con entrega a domicilio.',
      },
    };
    const meta = filterMeta[filter];

    return [
      {
        key: `filter-${filter}`,
        title: meta.title,
        helper: meta.helper,
        orders: filteredOrders,
      },
    ];
  }, [filter, filteredOrders]);

  function completeLocalOrder(orderId: number) {
    appliedOrderSequenceRef.current.set(orderId, ++readSequenceRef.current);
    setLocalOrders((current) => {
      const next = current.filter((order) => order.id !== orderId);
      localOrdersRef.current = next;
      setSelectedOrderId((selected) => (selected === orderId ? next[0]?.id ?? null : selected));
      return next;
    });
  }

  function updateLocalOrderStatus(orderId: number, status: CounterOrder['status']) {
    appliedOrderSequenceRef.current.set(orderId, ++readSequenceRef.current);
    setLocalOrders((current) => {
      const next = current.map((order) =>
        order.id === orderId ? { ...order, status } : order
      );
      localOrdersRef.current = next;
      return next;
    });
  }

  async function handlePrimaryDeliveryAction(
    order: CounterOrder,
    dispatchIntent?: CounterDeliveryDispatchIntent
  ): Promise<CounterDeliveryDispatchResult | null> {
    setMessage(null);
    setWorkingOrderId(order.id);
    try {
      if (order.fulfillment === 'delivery' && order.status === 'ready') {
        if (!dispatchIntent) {
          throw new Error('Completa los datos de salida y custodia del delivery.');
        }
        const result = await dispatchCounterDeliveryAction(dispatchIntent);
        updateLocalOrderStatus(order.id, 'out_for_delivery');
        setMessage({
          tone: 'success',
          text: result.settlementStatus === 'not_required'
            ? `Orden #${order.displayNumber} entregada al motorizado con ETA ${result.etaMinutes} min. Sin liquidacion de caja.`
            : `Orden #${order.displayNumber} entregada al motorizado con ETA ${result.etaMinutes} min. Custodia abierta.`,
        });
        await Promise.all([
          refreshCounter(),
          cashPanelOpen ? refreshCounterCash() : Promise.resolve(true),
        ]);
        return result;
      }

      if (order.fulfillment === 'pickup' && order.status === 'ready') {
        const idempotencyKey =
          pickupCompletionKeysRef.current.get(order.id) ?? crypto.randomUUID();
        pickupCompletionKeysRef.current.set(order.id, idempotencyKey);
        await completeCounterPickupAction({
          idempotencyKey,
          orderId: order.id,
        });
        pickupCompletionKeysRef.current.delete(order.id);
        completeLocalOrder(order.id);
        setMessage({
          tone: 'success',
          text: `Orden #${order.displayNumber} retirada por el cliente.`,
        });
        await refreshCounter();
        return null;
      }

      throw new Error('Esta accion no corresponde al estado actual de la orden.');
    } catch (error) {
      setMessage({
        tone: 'error',
        text: error instanceof Error ? error.message : 'No se pudo completar la accion.',
      });
      if (dispatchIntent) throw error;
      return null;
    } finally {
      setWorkingOrderId(null);
    }
  }

  async function handleCreatePaymentReport(
    order: CounterOrder,
    input: CounterPaymentIntent
  ): Promise<CounterPaymentOperationResult> {
    setMessage(null);
    setWorkingOrderId(order.id);
    try {
      const result = await applyCounterPaymentAction(input);
      const pendingText =
        result.pendingReportCount > 0
          ? ` ${result.pendingReportCount} pago(s) quedan por revision.`
          : '';
      const digitalChangeText =
        result.digitalChangePendingUsd > 0.005
          ? ` Cambio digital pendiente: ${moneyUsd(result.digitalChangePendingUsd)}.`
          : '';
      setMessage({
        tone: 'success',
        text: `Cobro registrado en orden #${order.displayNumber}.${pendingText}${digitalChangeText}`,
      });
      await Promise.all([
        refreshCounter(),
        refreshCounterOrder(order.id),
        cashPanelOpen ? refreshCounterCash() : Promise.resolve(true),
      ]);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'No se pudo registrar el cobro.';
      setMessage({ tone: 'error', text: message });
      throw error;
    } finally {
      setWorkingOrderId(null);
    }
  }

  async function handleRequestRefund(
    order: CounterOrder,
    input: CounterRefundRequestIntent
  ): Promise<CounterRefundRequestResult> {
    setWorkingOrderId(order.id);
    try {
      const result = await requestCounterRefundAction(input);
      setMessage({
        tone: 'success',
        text: `Devolucion solicitada para orden #${order.displayNumber}. Espera autorizacion.`,
      });
      await refreshCounterOrder(order.id);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'No se pudo solicitar la devolucion.';
      setMessage({ tone: 'error', text: message });
      throw error;
    } finally {
      setWorkingOrderId(null);
    }
  }

  async function handleExecuteRefund(
    order: CounterOrder,
    input: CounterRefundExecutionIntent
  ): Promise<CounterRefundExecutionResult> {
    setWorkingOrderId(order.id);
    try {
      const result = await executeCounterRefundAction(input);
      setMessage({
        tone: 'success',
        text: `Devolucion entregada en orden #${order.displayNumber}.`,
      });
      await Promise.all([
        refreshCounter(),
        refreshCounterOrder(order.id),
        cashPanelOpen ? refreshCounterCash() : Promise.resolve(true),
      ]);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'No se pudo ejecutar la devolucion.';
      setMessage({ tone: 'error', text: message });
      throw error;
    } finally {
      setWorkingOrderId(null);
    }
  }

  function handleCreateQuickSale(input: CounterDirectSaleIntent) {
    setMessage(null);
    setWorkingOrderId(-1);
    startTransition(async () => {
      try {
        const result = await createCounterQuickSaleAction(input);
        setMessage({
          tone: 'success',
          text: result.sentToKitchen
            ? `Venta creada y enviada a cocina. Orden #${result.id}.`
            : `Pedido agendado para master. Orden #${result.id}.`,
        });
        setQuickSaleOpen(false);
        await refreshCounter();
        setSelectedOrderId(result.id);
        setPaymentOrderIdToOpen(result.openPaymentAfterCreate ? result.id : null);
        await refreshCounterOrder(result.id);
      } catch (error) {
        setMessage({
          tone: 'error',
          text: error instanceof Error ? error.message : 'No se pudo crear la venta.',
        });
      } finally {
        setWorkingOrderId(null);
      }
    });
  }

  async function handleChangePickupItems(
    order: CounterOrder,
    input: CounterPickupItemChangeIntent
  ): Promise<CounterPickupItemChangeResult> {
    setMessage(null);
    setWorkingOrderId(order.id);
    try {
      const result = await changeCounterPickupItemsAction(input);
      setMessage({
        tone: 'success',
        text:
          result.status === 'pending_approval'
            ? `La orden #${order.displayNumber} conserva una solicitud anterior pendiente de Master.`
            : result.returnedToKitchen
              ? `Pedido #${order.displayNumber} modificado y enviado nuevamente a cocina.`
              : `Pedido #${order.displayNumber} modificado y recalculado.`,
      });
      await Promise.all([
        refreshCounter(),
        refreshCounterOrder(order.id),
      ]);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'No se pudo modificar el pickup.';
      setMessage({ tone: 'error', text: message });
      throw error;
    } finally {
      setWorkingOrderId(null);
    }
  }

  async function handleUpdatePickupSchedule(
    order: CounterOrder,
    input: CounterPickupScheduleIntent
  ): Promise<CounterPickupScheduleResult> {
    setMessage(null);
    setWorkingOrderId(order.id);
    try {
      const result = await updateCounterPickupScheduleAction(input);
      setMessage({
        tone: 'success',
        text: result.sentToKitchen
          ? `Pickup #${order.displayNumber} corregido y enviado a cocina.`
          : `Fecha del pickup #${order.displayNumber} corregida.`,
      });
      await Promise.all([
        refreshCounter(),
        refreshCounterOrder(order.id),
      ]);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'No se pudo corregir el pickup.';
      setMessage({ tone: 'error', text: message });
      throw error;
    } finally {
      setWorkingOrderId(null);
    }
  }

  function handleHistoricalSearch(cursor: CounterHistoricalSearchCursor | null = null) {
    const query = historicalSearch.trim();
    if (query.length < 2 && !/^[0-9]$/.test(query)) {
      setMessage({ tone: 'error', text: 'Escribe un número de orden o al menos 2 caracteres.' });
      return;
    }

    setMessage(null);
    setHistoricalSearched(true);
    if (!cursor) setHistoricalNextCursor(null);
    startTransition(async () => {
      try {
        const page = await searchCounterHistoricalOrdersAction({ query, cursor });
        setHistoricalResults((current) => cursor ? [...current, ...page.results] : page.results);
        setHistoricalNextCursor(page.nextCursor);
      } catch (error) {
        if (!cursor) setHistoricalResults([]);
        setMessage({
          tone: 'error',
          text: error instanceof Error ? error.message : 'No se pudo consultar el historial.',
        });
      }
    });
  }

  function handleCreateCashMovement(input: CounterCashMovementInput) {
    setMessage(null);
    setWorkingOrderId(-2);
    return new Promise<boolean>((resolve) => {
      startTransition(async () => {
      try {
        const result = await createCounterCashMovementAction(input);
        setMessage({
          tone: 'success',
          text:
            result.status === 'pending'
              ? `Solicitud registrada por ${
                  result.currencyCode === 'VES' ? moneyBs(result.amount) : moneyUsd(result.amount)
                }. Requiere autorización administrativa y todavía no afecta el saldo.`
              : `Movimiento registrado: ${
                  result.currencyCode === 'VES' ? moneyBs(result.amount) : moneyUsd(result.amount)
                }.`,
        });
        await refreshCounterCash();
        resolve(true);
      } catch (error) {
        setMessage({
          tone: 'error',
          text: error instanceof Error ? error.message : 'No se pudo registrar el movimiento.',
        });
        resolve(false);
      } finally {
        setWorkingOrderId(null);
      }
      });
    });
  }

  function handleCreateCashClosure(input: CounterCashClosureInput) {
    setMessage(null);
    setWorkingOrderId(-3);
    return new Promise<boolean>((resolve) => {
      startTransition(async () => {
      try {
        const result = await createCounterCashClosureAction(input);
        setMessage({
          tone: 'success',
          text: `Cierre registrado: contado ${
            result.currencyCode === 'VES' ? moneyBs(result.countedAmount) : moneyUsd(result.countedAmount)
          }.`,
        });
        await refreshCounterCash();
        resolve(true);
      } catch (error) {
        setMessage({
          tone: 'error',
          text: error instanceof Error ? error.message : 'No se pudo registrar el cierre.',
        });
        resolve(false);
      } finally {
        setWorkingOrderId(null);
      }
      });
    });
  }

  return (
    <main className="min-h-screen bg-[#0B0B0D] text-[#F5F5F7]">
      <ModulePreference moduleKey="counter" />
      <header className="sticky top-0 z-20 border-b border-[#242433] bg-[#0B0B0D]/95 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-5">
          <div>
            <div className="text-lg font-semibold tracking-tight sm:text-xl">Counter</div>
            <div className="text-xs text-[#AEB0BC] sm:text-sm">{fullName} · Mostrador operativo</div>
          </div>
          <div className="flex flex-1 flex-wrap items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => void handleOpenQuickSale()}
              disabled={catalogLoading}
              aria-pressed={quickSaleOpen}
              className="min-h-11 rounded-full border border-[#FEEF00]/70 bg-[#FEEF00] px-4 py-2 text-sm font-bold text-black hover:bg-[#fff45c] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#FEEF00] disabled:opacity-60"
            >
              {catalogLoading ? 'Cargando...' : 'Nueva venta'}
            </button>
            <button
              type="button"
              onClick={handleToggleCashPanel}
              aria-expanded={cashPanelOpen}
              className={[
                'min-h-11 rounded-full border px-3 py-2 text-sm font-semibold hover:border-[#FEEF00]/60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#FEEF00]',
                cashPanelOpen
                  ? 'border-[#FEEF00] bg-[#FEEF00]/10 text-[#FEEF00]'
                  : 'border-[#303044] bg-[#111118] text-[#F5F5F7]',
              ].join(' ')}
            >
              Caja
            </button>
            <button
              type="button"
              onClick={() => setSettlementsPanelOpen((current) => !current)}
              aria-expanded={settlementsPanelOpen}
              className={[
                'min-h-11 rounded-full border px-3 py-2 text-sm font-semibold hover:border-sky-300/60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-300',
                settlementsPanelOpen
                  ? 'border-sky-300 bg-sky-300/10 text-sky-100'
                  : 'border-[#303044] bg-[#111118] text-[#F5F5F7]',
              ].join(' ')}
            >
              Liquidaciones
            </button>
            <button
              type="button"
              onClick={() => setHistoricalSearchOpen((current) => !current)}
              aria-expanded={historicalSearchOpen}
              className={[
                'min-h-11 rounded-full border px-3 py-2 text-sm font-semibold hover:border-[#FEEF00]/60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#FEEF00]',
                historicalSearchOpen
                  ? 'border-[#FEEF00] bg-[#FEEF00]/10 text-[#FEEF00]'
                  : 'border-[#303044] bg-[#111118] text-[#F5F5F7]',
              ].join(' ')}
            >
              Buscar orden
            </button>
            <button
              type="button"
              onClick={() => {
                if (pushState !== 'subscribed') void enablePush();
              }}
              disabled={pushBusy || pushState === 'unsupported' || pushState === 'subscribed'}
              aria-label={pushState === 'subscribed' ? 'Alertas activas' : 'Activar alertas'}
              className={[
                'min-h-11 rounded-full border px-3 py-2 text-sm font-semibold hover:border-[#FEEF00]/60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#FEEF00] disabled:opacity-70',
                pushState === 'subscribed'
                  ? 'border-emerald-400/40 bg-emerald-400/10 text-emerald-200'
                  : 'border-[#303044] bg-[#111118] text-[#F5F5F7]',
              ].join(' ')}
            >
              {pushBusy ? 'Activando...' : pushState === 'subscribed' ? 'Alertas ON' : 'Alertas'}
            </button>
            <button
              type="button"
              onClick={() => void refreshCounter()}
              disabled={queueRefreshing}
              className="min-h-11 rounded-full border border-[#303044] bg-[#111118] px-3 py-2 text-sm font-semibold text-[#F5F5F7] hover:border-[#FEEF00]/60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#FEEF00]"
            >
              {queueRefreshing ? 'Actualizando...' : 'Actualizar'}
            </button>
            <button
              type="button"
              onClick={() => setSyncDetailsOpen((current) => !current)}
              className={[
                'inline-flex min-h-11 items-center rounded-full border px-3 py-2 text-xs font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#FEEF00]',
                connectionStateClass(connectionState),
              ].join(' ')}
              aria-expanded={syncDetailsOpen}
            >
              {connectionStateLabel(connectionState)} · {formatRefreshTime(lastAutoRefreshAt)}
            </button>
            <Link
              href="/app"
              className="inline-flex min-h-11 items-center rounded-full border border-[#303044] bg-[#111118] px-3 py-2 text-sm font-semibold text-[#F5F5F7] hover:border-[#FEEF00]/60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#FEEF00]"
            >
              Módulos
            </Link>
          </div>
        </div>
      </header>

      <section className="mx-auto max-w-7xl px-3 py-4 sm:px-5 sm:py-5">
        {message ? (
          <div
            role={message.tone === 'error' ? 'alert' : 'status'}
            aria-live="polite"
            className={[
              'rounded-[8px] border px-4 py-3 text-sm font-semibold',
              message.tone === 'success'
                ? 'border-emerald-400/40 bg-emerald-400/10 text-emerald-200'
                : 'border-red-400/40 bg-red-400/10 text-red-200',
            ].join(' ')}
          >
            {message.text}
          </div>
        ) : null}

        {connectionState === 'offline' || connectionState === 'fallback' ? (
          <div
            className={[
              'mt-4 rounded-[8px] border px-4 py-3 text-sm',
              connectionState === 'offline'
                ? 'border-red-400/35 bg-red-950/20 text-red-100'
                : 'border-orange-400/35 bg-orange-950/20 text-orange-100',
            ].join(' ')}
          >
            {connectionState === 'offline'
              ? 'Sin conexion. Los datos visibles pueden estar desactualizados; no confirmes una operacion hasta recuperar la red.'
              : 'El canal en vivo esta reconectando. Counter mantiene una verificacion ligera por recurso y las acciones finales siguen validando en servidor.'}
          </div>
        ) : null}

        {syncDetailsOpen ? (
          <section className="mt-4 rounded-[8px] border border-[#303044] bg-[#111118] p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold text-[#F5F5F7]">
                  Salud de sincronizacion
                </h2>
                <p className="mt-1 text-xs text-[#9FA0AA]">
                  Realtime despierta la cola; detalle, caja y liquidaciones se consultan por separado solo cuando estan abiertos.
                </p>
              </div>
              <div className="text-right text-xs text-[#9FA0AA]">
                <div>{connectionStateLabel(connectionState)}</div>
                <div>
                  Ultimo evento: {lastRealtimeEventAt ? formatDateTime(lastRealtimeEventAt) : 'sin eventos en esta sesion'}
                </div>
              </div>
            </div>
            <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              {(Object.keys(syncMetrics) as CounterSyncResource[]).map((resource) => {
                const metric = syncMetrics[resource];
                return (
                  <div
                    key={resource}
                    className="rounded-[8px] border border-[#303044] bg-[#0B0B0D] p-3 text-xs"
                  >
                    <div className="font-semibold text-[#F5F5F7]">
                      {COUNTER_SYNC_RESOURCE_LABELS[resource]}
                    </div>
                    <div className="mt-1 text-[#9FA0AA]">
                      {metric.calls} consulta(s) · {metric.errors} error(es)
                    </div>
                    <div className="mt-1 text-[#9FA0AA]">
                      Promedio {averageMetricDuration(metric)}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        ) : null}

        {cashPanelOpen && cashLoading && cashAccounts.length === 0 ? (
          <section className="mt-5 rounded-[8px] border border-[#242433] bg-[#111118] p-6 text-sm text-[#9FA0AA]">
            Cargando saldos exactos y movimientos de caja...
          </section>
        ) : cashPanelOpen ? (
          <CounterCashPanel
            accounts={cashAccounts}
            activeBsRate={activeBsRate}
            isWorking={workingOrderId === -2}
            isClosing={workingOrderId === -3}
            onRefresh={() => void refreshCounterCash()}
            onCreateMovement={handleCreateCashMovement}
            onCreateClosure={handleCreateCashClosure}
          />
        ) : null}

        {settlementsPanelOpen ? (
          <CounterPendingSettlementsPanel
            paymentAccounts={paymentAccounts}
            activeBsRate={activeBsRate}
            refreshToken={settlementsRefreshToken}
            onReadMetric={recordSettlementsReadMetric}
            onChanged={async () => {
              await Promise.all([
                refreshCounter(),
                cashPanelOpen ? refreshCounterCash() : Promise.resolve(true),
              ]);
            }}
          />
        ) : null}

        {historicalSearchOpen ? (
          <CounterHistoricalSearchPanel
            query={historicalSearch}
            results={historicalResults}
            nextCursor={historicalNextCursor}
            searched={historicalSearched}
            isPending={isPending}
            onQueryChange={setHistoricalSearch}
            onSearch={() => handleHistoricalSearch()}
            onLoadMore={() => {
              if (historicalNextCursor) handleHistoricalSearch(historicalNextCursor);
            }}
            onClear={() => {
              setHistoricalSearch('');
              setHistoricalResults([]);
              setHistoricalNextCursor(null);
              setHistoricalSearched(false);
            }}
            onOpenOrder={(orderId) => handleOpenHistoricalOrder(orderId, false)}
            onOpenPayment={(orderId) => handleOpenHistoricalOrder(orderId, true)}
          />
        ) : null}

        <div className="mt-5 grid gap-5 lg:grid-cols-[minmax(340px,0.82fr)_minmax(520px,1.18fr)]">
          <section className="min-w-0 rounded-[8px] border border-[#242433] bg-[#111118]" aria-label="Bandeja de pedidos">
            <div className="border-b border-[#242433] p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h1 className="text-lg font-semibold">Pedidos de mostrador</h1>
                  <p className="text-sm text-[#9FA0AA]">
                    Entregas listas, seguimiento de cocina y liquidacion al regreso.
                  </p>
                </div>
                <span className="rounded-full border border-[#303044] px-3 py-1 text-xs text-[#C7C8D1]">
                  {filteredOrders.length} en vista
                </span>
              </div>

              <div className="mt-4 flex flex-nowrap gap-2 overflow-x-auto pb-1">
                {FILTERS.map((item) => (
                  <button
                    key={item.key}
                    type="button"
                    onClick={() => setFilter(item.key)}
                    aria-pressed={filter === item.key}
                    className={[
                      'min-h-10 shrink-0 whitespace-nowrap rounded-full border px-3 py-1.5 text-[13px] font-semibold transition sm:text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#FEEF00]',
                      filter === item.key
                        ? 'border-[#FEEF00] bg-[#FEEF00]/10 text-[#FEEF00]'
                        : 'border-[#303044] bg-[#0B0B0D] text-[#C7C8D1] hover:border-[#FEEF00]/50',
                    ].join(' ')}
                  >
                    <span>{item.label}</span>
                    <span
                      className={[
                        'ml-2 rounded-full px-2 py-0.5 text-xs',
                        filter === item.key ? 'bg-black/20 text-[#FEEF00]' : 'bg-[#1A1A22] text-[#9FA0AA]',
                      ].join(' ')}
                    >
                      {filterCounts[item.key]}
                    </span>
                  </button>
                ))}
              </div>

              <div className="mt-4">
                <label htmlFor="counter-queue-search" className="sr-only">
                  Buscar en los pedidos visibles
                </label>
                <div className="relative">
                  <input
                    ref={queueSearchRef}
                    id="counter-queue-search"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="Orden, cliente o teléfono"
                    className="min-h-11 w-full rounded-[8px] border border-[#303044] bg-[#0B0B0D] px-4 py-3 pr-16 text-sm outline-none placeholder:text-[#777988] focus:border-[#FEEF00]/70 focus-visible:ring-2 focus-visible:ring-[#FEEF00]/30"
                  />
                  <kbd className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 rounded border border-[#3D3D52] px-2 py-0.5 text-xs text-[#AEB0BC]">
                    /
                  </kbd>
                </div>
              </div>
            </div>

            <div
              className="max-h-[calc(100vh-330px)] overflow-y-auto p-2"
              onKeyDown={handleQueueKeyDown}
              aria-label="Pedidos. Usa flecha arriba y abajo para recorrerlos."
            >
              {filteredOrders.length === 0 ? (
                <div className="rounded-[8px] border border-dashed border-[#3D3D52] p-6 text-sm text-[#AEB0BC]">
                  <div>{search.trim() ? 'No hay coincidencias en esta vista.' : 'No hay pedidos en esta vista.'}</div>
                  {search.trim() ? (
                    <button
                      type="button"
                      onClick={() => {
                        setSearch('');
                        queueSearchRef.current?.focus();
                      }}
                      className="mt-3 min-h-11 rounded-full border border-[#3D3D52] px-4 py-2 font-semibold text-[#F5F5F7] hover:border-[#FEEF00]/60"
                    >
                      Limpiar búsqueda
                    </button>
                  ) : null}
                </div>
              ) : (
                <div className="space-y-3">
                  {orderSections.map((section) => (
                    <div
                      key={section.key}
                      className="rounded-[8px] border border-[#242433] bg-[#0B0B0D] p-2 [contain-intrinsic-size:240px] [content-visibility:auto]"
                    >
                      <div className="flex items-start justify-between gap-3 px-2 pb-2 pt-1">
                        <div className="min-w-0">
                          <div className="text-sm font-semibold text-[#F5F5F7]">{section.title}</div>
                          <div className="mt-0.5 text-xs text-[#9FA0AA]">{section.helper}</div>
                        </div>
                        <span className="shrink-0 rounded-full border border-[#303044] px-2 py-0.5 text-xs font-semibold text-[#C7C8D1]">
                          {section.orders.length}
                        </span>
                      </div>
                      <div className="space-y-2">
                        {section.orders.map((order) => (
                          <CounterOrderCard
                            key={order.id}
                            order={order}
                            selected={selectedOrder?.id === order.id}
                            onSelect={() => handleSelectCounterOrder(order)}
                          />
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>

          <section className="min-w-0 rounded-[8px] border border-[#242433] bg-[#111118]" aria-label="Área de trabajo">
            {quickSaleOpen && selectedOrder ? (
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#242433] bg-[#0B0B0D] px-4 py-3 text-sm">
                <div className="min-w-0">
                  <span className="text-[#9FA0AA]">Contexto conservado: </span>
                  <span className="font-semibold text-[#F5F5F7]">
                    #{selectedOrder.displayNumber} · {selectedOrder.clientName}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => setQuickSaleOpen(false)}
                  className="min-h-11 rounded-full border border-[#3D3D52] px-4 py-2 text-xs font-semibold text-[#F5F5F7] hover:border-[#FEEF00]/60"
                >
                  Volver a la orden
                </button>
              </div>
            ) : null}
            {quickSaleOpen ? (
              <CounterQuickSalePanel
                products={quickSaleProducts}
                productComponents={quickSaleProductComponents}
                discountRules={quickSaleDiscountRules}
                activeBsRate={activeBsRate}
                isWorking={workingOrderId === -1}
                onCancel={() => setQuickSaleOpen(false)}
                onSubmit={handleCreateQuickSale}
              />
            ) : selectedOrder && detailLoadingOrderId === selectedOrder.id && !selectedOrder.detailLoaded ? (
              <div className="flex min-h-[520px] items-center justify-center p-8 text-sm text-[#9FA0AA]">
                Cargando detalle exacto de la orden...
              </div>
            ) : selectedOrder ? (
              <OrderDetail
                key={selectedOrder.id}
                order={selectedOrder}
                initialPaymentOpen={paymentOrderIdToOpen === selectedOrder.id}
                onInitialPaymentOpened={() => setPaymentOrderIdToOpen(null)}
                paymentAccounts={paymentAccounts}
                quickSaleProducts={quickSaleProducts}
                quickSaleProductComponents={quickSaleProductComponents}
                activeBsRate={activeBsRate}
                isWorking={workingOrderId === selectedOrder.id}
                isStale={detailStaleOrderId === selectedOrder.id}
                isRefreshing={detailLoadingOrderId === selectedOrder.id}
                onRefreshExact={() => void refreshCounterOrder(selectedOrder.id)}
                onPrimaryDeliveryAction={handlePrimaryDeliveryAction}
                onDeliverySettlementChanged={async () => {
                  await Promise.all([
                    refreshCounter(),
                    refreshCounterOrder(selectedOrder.id),
                    cashPanelOpen ? refreshCounterCash() : Promise.resolve(true),
                  ]);
                }}
                onCreatePaymentReport={handleCreatePaymentReport}
                onRequestRefund={handleRequestRefund}
                onExecuteRefund={handleExecuteRefund}
                onChangePickupItems={handleChangePickupItems}
                onUpdatePickupSchedule={handleUpdatePickupSchedule}
                onRequestCatalog={ensureCounterCatalog}
                catalogLoading={catalogLoading}
              />
            ) : (
              <CounterEmptyWorkSurface
                hasOrders={filteredOrders.length > 0}
                onNewSale={() => void handleOpenQuickSale()}
              />
            )}
          </section>
        </div>
      </section>
    </main>
  );
}

function CounterOrderCard({
  order,
  selected,
  onSelect,
}: {
  order: CounterOrder;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      data-counter-order-id={order.id}
      aria-pressed={selected}
      aria-label={`Orden ${order.displayNumber}, ${order.clientName}, ${primaryCounterActionLabel(order)}`}
      className={[
        'min-h-11 w-full rounded-[8px] border p-4 text-left transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#FEEF00]',
        selected
          ? 'border-[#FEEF00] bg-[#FEEF00]/8'
          : 'border-[#242433] bg-[#111118] hover:border-[#3D3D52]',
      ].join(' ')}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="text-lg font-bold tracking-tight text-[#FEEF00]">#{order.displayNumber}</div>
          <div className="truncate text-base font-semibold text-[#F5F5F7]">{order.clientName}</div>
        </div>
        <div className="max-w-[52%] shrink-0 rounded-[8px] border border-[#FEEF00]/35 bg-[#FEEF00]/10 px-2.5 py-1.5 text-right text-xs font-bold leading-4 text-[#FEEF00]">
          {primaryCounterActionLabel(order)}
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs">
        <span className="font-semibold text-[#F5F5F7]">
          {fulfillmentLabel(order.fulfillment)}
        </span>
        <span className="text-[#AEB0BC]">{scheduleLabel(order)}</span>
        <span className={['rounded-full border px-2 py-0.5 text-xs font-semibold', counterStatusClass(order)].join(' ')}>
          {getOperationalStatusLabel(order)}
        </span>
        {order.paymentRequiresChange ? (
          <span className="rounded-full border border-orange-300/40 bg-orange-300/10 px-2 py-0.5 text-xs font-semibold text-orange-200">
            Cambio
          </span>
        ) : null}
        {order.fulfillment === 'delivery' ? (
          <span
            className={[
              'rounded-full border px-2 py-0.5 text-xs font-semibold',
              order.deliveryAssigneeName
                ? 'border-sky-300/40 bg-sky-300/10 text-sky-100'
                : 'border-red-300/40 bg-red-300/10 text-red-100',
            ].join(' ')}
          >
            {deliveryAssigneeLabel(order)}
          </span>
        ) : null}
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-[#242433] pt-2 text-xs">
        <span className="truncate text-[#9FA0AA]">Asesor: {order.advisorName || 'Sin asesor'}</span>
        <span className={['font-semibold', order.balanceUsd > 0.005 ? 'text-orange-300' : 'text-emerald-300'].join(' ')}>
          {order.balanceUsd > 0.005
            ? `${paymentLabel(order)} · ${moneyUsd(order.balanceUsd)}`
            : 'Pago cubierto'}
        </span>
      </div>
    </button>
  );
}

function CounterEmptyWorkSurface({
  hasOrders,
  onNewSale,
}: {
  hasOrders: boolean;
  onNewSale: () => void;
}) {
  return (
    <div className="flex min-h-[520px] items-center justify-center p-8">
      <div className="max-w-md rounded-[8px] border border-dashed border-[#303044] bg-[#0B0B0D] p-6 text-center">
        <div className="text-lg font-semibold">Mostrador listo</div>
        <p className="mt-2 text-sm leading-6 text-[#9FA0AA]">
          {hasOrders
            ? 'Selecciona un pedido para cobrar, entregar o revisar sus datos operativos.'
            : 'No hay pedidos en esta vista. Puedes cambiar el filtro o crear una venta nueva.'}
        </p>
        <button
          type="button"
          onClick={onNewSale}
          className="mt-5 rounded-full border border-[#FEEF00]/70 bg-[#FEEF00] px-5 py-2 text-sm font-bold text-black hover:bg-[#fff45c]"
        >
          Nueva venta
        </button>
      </div>
    </div>
  );
}

function CounterWorkspaceLoading({
  label,
  compact = false,
}: {
  label: string;
  compact?: boolean;
}) {
  return (
    <div
      className={[
        'flex items-center justify-center rounded-[8px] border border-[#242433] bg-[#111118] px-6 text-sm text-[#9FA0AA]',
        compact ? 'mt-5 min-h-24' : 'min-h-[520px]',
      ].join(' ')}
      role="status"
      aria-live="polite"
    >
      {label}
    </div>
  );
}
