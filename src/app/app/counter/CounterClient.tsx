'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { getOperationalStatusLabel, getPaymentMethodLabel } from '@/lib/orders/order-labels';
import { createSupabaseBrowser } from '@/lib/supabase/browser';
import {
  buildComponentDetailLines,
  getVisibleEditableDetailLines,
  type OrderComposerProductComponent,
} from '@/lib/orders/order-composer';
import { calculateOrderLineSnapshot, calculateOrderTotalsSnapshot } from '@/lib/pricing/order-snapshots';
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
  searchCounterClientsAction,
  searchCounterHistoricalOrdersAction,
  type CounterHistoricalSearchCursor,
  type CounterHistoricalSearchResult,
  type CounterClientSearchResult,
  updateCounterPickupScheduleAction,
} from './actions';
import { CounterPaymentEngine } from './CounterPaymentEngine';
import { CounterRefundPanel } from './CounterRefundPanel';
import {
  CounterDeliveryDispatchPanel,
  CounterDeliverySettlementBox,
  CounterPendingSettlementsPanel,
} from './CounterDeliveryWorkspace';
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
import {
  loadCounterCashSnapshotAction,
  loadCounterCatalogAction,
  loadCounterOrderDetailAction,
  refreshCounterQueueAction,
} from './read-actions';

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

export type CounterCashAccountSummary = {
  accountId: number;
  accountName: string;
  accountKind: string;
  currencyCode: 'USD' | 'VES';
  methods: string[];
  inflow: number;
  outflow: number;
  net: number;
  balance: number;
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

type CounterCashMovementInput = {
  direction: 'inflow' | 'outflow';
  outflowPurpose: 'change' | 'expense';
  moneyAccountId: number;
  amount: number;
  movementDate: string;
  exchangeRateVesPerUsd: number | null;
  referenceCode: string | null;
  counterpartyName: string | null;
  description: string;
  notes: string | null;
};

type CounterCashClosureInput = {
  moneyAccountId: number;
  closureDate: string;
  closureTime: string;
  countedAmount: number;
  exchangeRateVesPerUsd: number | null;
  reason: string;
  notes: string | null;
};

type CounterQuickSaleCartItem = {
  id: string;
  productId: number;
  qty: string;
  notes: string;
  editableDetailLines: string[];
};

type PushState = 'checking' | 'unsupported' | 'denied' | 'ready' | 'subscribed' | 'error';

type CounterFilter =
  | 'now'
  | 'kitchen'
  | 'pickup'
  | 'delivery'
  | 'route';

const FILTERS: Array<{ key: CounterFilter; label: string }> = [
  { key: 'now', label: 'Listos' },
  { key: 'pickup', label: 'Pickup' },
  { key: 'delivery', label: 'Delivery' },
  { key: 'kitchen', label: 'En cocina' },
  { key: 'route', label: 'En camino' },
];

const QUICK_SALE_PAYMENT_METHODS = [
  { code: 'pos', label: 'Punto' },
  { code: 'payment_mobile', label: 'Pago movil' },
  { code: 'transfer', label: 'Transferencia' },
  { code: 'cash_usd', label: 'Efectivo USD' },
  { code: 'cash_ves', label: 'Efectivo Bs' },
  { code: 'zelle', label: 'Zelle' },
  { code: 'mixed', label: 'Mixto' },
];

function getQuickSalePaymentCurrency(method: string): 'USD' | 'VES' | null {
  if (method === 'mixed') return null;
  if (method === 'cash_usd' || method === 'zelle') return 'USD';
  return 'VES';
}

const PUSH_TIMEOUT_MS = 12000;
const COUNTER_CATALOG_FRESH_MS = 60_000;

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

function qtyLabel(value: number) {
  if (Math.abs(value - Math.round(value)) < 0.001) return String(Math.round(value));
  return value.toLocaleString('es-VE', { maximumFractionDigits: 2 });
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
  if (!value) return 'Auto activo';

  return `Actualizado ${new Date(value).toLocaleTimeString('es-VE', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'America/Caracas',
  })}`;
}

function getTodayKey() {
  return new Date().toLocaleDateString('en-CA', {
    timeZone: 'America/Caracas',
  });
}

function getCurrentTimeKey() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/Caracas',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date());
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';

  return `${get('hour') || '00'}:${get('minute') || '00'}`;
}

function toDecimalInput(value: string) {
  return Number(String(value || '').replace(',', '.'));
}

function paymentLabel(order: CounterOrder) {
  if (order.overpaidUsd > 0.005) return 'Saldo a favor';
  if (order.reports.pending > 0) return 'Pago por revisar';
  if (order.balanceUsd <= 0.005) return 'Pagado';
  if (order.confirmedPaidUsd > 0.005) return 'Abonado';
  return 'Pendiente';
}

function paymentClass(order: CounterOrder) {
  if (order.overpaidUsd > 0.005) return 'border-violet-400/40 bg-violet-400/10 text-violet-200';
  if (order.reports.pending > 0) return 'border-[#FEEF00]/50 bg-[#FEEF00]/10 text-[#FEEF00]';
  if (order.balanceUsd <= 0.005) return 'border-emerald-400/40 bg-emerald-400/10 text-emerald-200';
  if (order.confirmedPaidUsd > 0.005) return 'border-sky-400/40 bg-sky-400/10 text-sky-200';
  return 'border-orange-400/40 bg-orange-400/10 text-orange-200';
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

function accountKindLabel(value: string | null) {
  if (value === 'cash') return 'Caja';
  if (value === 'pos') return 'Punto';
  if (value === 'bank') return 'Banco';
  if (value === 'wallet') return 'Wallet';
  return 'Cuenta';
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
  if (order.status === 'created') return 'Pendiente master';
  if (order.status === 'queued' || order.status === 'confirmed') return 'En cola de cocina';
  if (order.status === 'in_kitchen') return 'En preparacion';
  if (order.fulfillment === 'pickup' && order.status === 'ready' && mustSettleBeforeCounterDelivery(order)) return 'Primero cobrar';
  if (order.fulfillment === 'delivery' && order.status === 'ready') return 'Entregar a motorizado';
  if (order.fulfillment === 'delivery' && order.status === 'out_for_delivery') return 'Entrega: solo Master';
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

function isCounterActionableOrder(order: CounterOrder) {
  return order.status === 'ready' || order.status === 'out_for_delivery';
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

function historicalSearchStatusLabel(status: CounterHistoricalSearchResult['status']) {
  if (status === 'created') return 'Agendado / pendiente master';
  if (status === 'queued') return 'En cola de cocina';
  if (status === 'confirmed') return 'En cola de cocina';
  if (status === 'in_kitchen') return 'En preparacion';
  if (status === 'ready') return 'Listo';
  if (status === 'out_for_delivery') return 'En camino';
  if (status === 'delivered') return 'Entregada';
  if (status === 'cancelled') return 'Cancelada';
  return status;
}

function historicalSearchReason(result: CounterHistoricalSearchResult) {
  if (result.status === 'created') return 'Master aun no lo ha enviado a cocina.';
  if (result.status === 'queued') return 'Ya esta en la cola operativa de cocina.';
  if (result.status === 'confirmed') return 'Ya esta enviado a cocina; falta que lo tomen.';
  if (result.status === 'in_kitchen') return 'Cocina lo esta preparando.';
  if (result.status === 'ready') return 'Ya esta listo para entrega.';
  if (result.status === 'out_for_delivery') return 'Ya fue entregado al motorizado.';
  if (result.status === 'delivered') return 'Esta orden ya fue entregada.';
  if (result.status === 'cancelled') return 'Esta orden fue cancelada.';
  return null;
}

function historicalSearchPaymentLabel(result: CounterHistoricalSearchResult) {
  if (result.pendingReportsCount > 0) return 'Pago por revisar';
  if (result.balanceUsd <= 0.005) return 'Pagado';
  if (result.confirmedPaidUsd > 0.005) return `Abonado · falta ${moneyUsd(result.balanceUsd)}`;
  return `Pendiente ${moneyUsd(result.balanceUsd)}`;
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
  const [recoveredOrder, setRecoveredOrder] = useState<CounterOrder | null>(null);
  const recoveredOrderRef = useRef<CounterOrder | null>(null);
  const previousOrderIdsRef = useRef<Set<number> | null>(null);
  const queueRefreshInFlightRef = useRef<Promise<void> | null>(null);
  const detailRequestIdRef = useRef(0);
  const [queueRefreshing, setQueueRefreshing] = useState(false);
  const [detailLoadingOrderId, setDetailLoadingOrderId] = useState<number | null>(null);
  const [lastAutoRefreshAt, setLastAutoRefreshAt] = useState<string | null>(null);
  const [pushState, setPushState] = useState<PushState>('checking');
  const [pushBusy, setPushBusy] = useState(false);
  const [filter, setFilter] = useState<CounterFilter>('now');
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

  const refreshCounter = useCallback(async () => {
    if (queueRefreshInFlightRef.current) return queueRefreshInFlightRef.current;

    const request = (async () => {
      setQueueRefreshing(true);
      try {
        const nextOrders = await refreshCounterQueueAction();
        const previousIds = previousOrderIdsRef.current ?? new Set<number>();
        const newOrders = nextOrders.filter((order) => !previousIds.has(order.id));

        previousOrderIdsRef.current = new Set(nextOrders.map((order) => order.id));
        setLocalOrders((current) => {
          const currentById = new Map(current.map((order) => [order.id, order]));
          return nextOrders.map((summary) => {
            const previous = currentById.get(summary.id);
            return previous?.detailLoaded
              ? { ...summary, items: previous.items, detailLoaded: true }
              : summary;
          });
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

        if (newOrders.length > 0) {
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
  }, []);

  const refreshCounterOrder = useCallback(async (orderId: number) => {
    const requestId = ++detailRequestIdRef.current;
    setDetailLoadingOrderId(orderId);
    try {
      const detail = await loadCounterOrderDetailAction({ orderId });
      if (requestId !== detailRequestIdRef.current) return null;
      setLocalOrders((current) =>
        current.map((order) => (order.id === detail.id ? detail : order))
      );
      if (recoveredOrderRef.current?.id === detail.id) {
        recoveredOrderRef.current = detail;
        setRecoveredOrder(detail);
      }
      return detail;
    } catch (error) {
      if (requestId === detailRequestIdRef.current) {
        setMessage({
          tone: 'error',
          text: error instanceof Error ? error.message : 'No se pudo cargar el detalle de la orden.',
        });
      }
      return null;
    } finally {
      if (requestId === detailRequestIdRef.current) setDetailLoadingOrderId(null);
    }
  }, []);

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
    setCashLoading(true);
    try {
      setCashAccounts(await loadCounterCashSnapshotAction());
      return true;
    } catch (error) {
      setMessage({
        tone: 'error',
        text: error instanceof Error ? error.message : 'No se pudo cargar la caja.',
      });
      return false;
    } finally {
      setCashLoading(false);
    }
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
    const previousOrderIds = previousOrderIdsRef.current;
    const newOrders = previousOrderIds
      ? orders.filter((order) => !previousOrderIds.has(order.id))
      : [];
    previousOrderIdsRef.current = new Set(orders.map((order) => order.id));

    setLocalOrders(orders);
    setSelectedOrderId((current) =>
      current != null && orders.some((order) => order.id === current) ? current : null
    );

    if (newOrders.length > 0) {
      const firstOrder = newOrders[0];
      setMessage({
        tone: 'success',
        text:
          newOrders.length === 1
            ? `Nuevo pedido visible: #${firstOrder.displayNumber} - ${firstOrder.clientName}.`
            : `${newOrders.length} pedidos nuevos visibles en mostrador.`,
      });
    }
  }, [orders]);

  useEffect(() => {
    const refreshIfVisible = () => {
      if (document.visibilityState === 'hidden') return;
      void refreshCounter();
    };

    const intervalId = window.setInterval(refreshIfVisible, 30000);
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') void refreshCounter();
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.clearInterval(intervalId);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [refreshCounter]);

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;

    const onMessage = (event: MessageEvent) => {
      const data = event.data && typeof event.data === 'object'
        ? event.data as { type?: string; payload?: { url?: string; title?: string; body?: string } }
        : null;
      if (data?.type !== 'vivo-push') return;
      const url = data.payload?.url || '';
      if (url && !url.startsWith('/app/counter')) return;

      setMessage({
        tone: 'success',
        text: data.payload?.title || data.payload?.body || 'Hay novedades en mostrador.',
      });
      playCounterAlert();
      void refreshCounter();
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
      now: localOrders.filter(isCounterActionableOrder).length,
      kitchen: localOrders.filter(isKitchenFollowUpOrder).length,
      pickup: localOrders.filter((order) => order.fulfillment === 'pickup').length,
      delivery: localOrders.filter((order) => order.fulfillment === 'delivery').length,
      route: localOrders.filter((order) => order.status === 'out_for_delivery').length,
    };
  }, [localOrders]);

  const filteredOrders = useMemo(() => {
    const term = search.trim().toLocaleLowerCase('es-VE');

    return sortCounterOrders(localOrders.filter((order) => {
      if (filter === 'now' && !isCounterActionableOrder(order)) return false;
      if (filter === 'pickup' && order.fulfillment !== 'pickup') return false;
      if (filter === 'kitchen' && !isKitchenFollowUpOrder(order)) return false;
      if (filter === 'delivery' && order.fulfillment !== 'delivery') return false;
      if (filter === 'route' && order.status !== 'out_for_delivery') return false;

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
        const detail = await loadCounterOrderDetailAction({ orderId });
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
    setSelectedOrderId(null);
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
    const actionableSections = [
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
      {
        key: 'delivery-route',
        title: 'En camino',
        helper: 'Liquidar cobro al regreso del motorizado.',
        orders: filteredOrders.filter(isCounterRouteSettlement),
      },
    ].filter((section) => section.orders.length > 0);

    if (filter === 'now') return actionableSections;

    const filterMeta: Record<Exclude<CounterFilter, 'now'>, { title: string; helper: string }> = {
      pickup: {
        title: 'Pickup',
        helper: 'Pedidos para retirar en mostrador.',
      },
      delivery: {
        title: 'Delivery',
        helper: 'Pedidos con entrega a domicilio.',
      },
      kitchen: {
        title: 'En cocina',
        helper: 'Pedidos en cola o preparacion para responder al cliente.',
      },
      route: {
        title: 'En camino',
        helper: 'Pedidos entregados al motorizado y pendientes de liquidar.',
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
    setLocalOrders((current) => {
      const next = current.filter((order) => order.id !== orderId);
      setSelectedOrderId((selected) => (selected === orderId ? next[0]?.id ?? null : selected));
      return next;
    });
  }

  function updateLocalOrderStatus(orderId: number, status: CounterOrder['status']) {
    setLocalOrders((current) =>
      current.map((order) => (order.id === orderId ? { ...order, status } : order))
    );
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
          text: `Orden #${order.displayNumber} entregada al motorizado con ETA ${result.etaMinutes} min. Custodia abierta.`,
        });
        await Promise.all([
          refreshCounter(),
          cashPanelOpen ? refreshCounterCash() : Promise.resolve(true),
        ]);
        return result;
      }

      if (order.fulfillment === 'pickup' && order.status === 'ready') {
        await completeCounterPickupAction({
          idempotencyKey: crypto.randomUUID(),
          orderId: order.id,
        });
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
            ? `Cambio solicitado para la orden #${order.displayNumber}. Master debe autorizarlo porque ya estaba lista.`
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
    startTransition(async () => {
      try {
        const result = await createCounterCashMovementAction(input);
        setMessage({
          tone: 'success',
          text: `Movimiento registrado: ${result.currencyCode === 'VES' ? moneyBs(result.amount) : moneyUsd(result.amount)}.`,
        });
        await refreshCounterCash();
      } catch (error) {
        setMessage({
          tone: 'error',
          text: error instanceof Error ? error.message : 'No se pudo registrar el movimiento.',
        });
      } finally {
        setWorkingOrderId(null);
      }
    });
  }

  function handleCreateCashClosure(input: CounterCashClosureInput) {
    setMessage(null);
    setWorkingOrderId(-3);
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
      } catch (error) {
        setMessage({
          tone: 'error',
          text: error instanceof Error ? error.message : 'No se pudo registrar el cierre.',
        });
      } finally {
        setWorkingOrderId(null);
      }
    });
  }

  return (
    <main className="min-h-screen bg-[#0B0B0D] text-[#F5F5F7]">
      <ModulePreference moduleKey="counter" />
      <header className="sticky top-0 z-20 border-b border-[#242433] bg-[#0B0B0D]/95 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-5 py-4">
          <div>
            <div className="text-xl font-semibold tracking-tight">VIVO OPS - Counter</div>
            <div className="text-sm text-[#9FA0AA]">{fullName} - Mostrador y entregas listas</div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void handleOpenQuickSale()}
              disabled={catalogLoading}
              className="rounded-full border border-[#FEEF00]/70 bg-[#FEEF00] px-4 py-2 text-sm font-bold text-black hover:bg-[#fff45c]"
            >
              {catalogLoading ? 'Cargando...' : 'Nueva venta'}
            </button>
            <button
              type="button"
              onClick={handleToggleCashPanel}
              className={[
                'rounded-full border px-4 py-2 text-sm font-semibold hover:border-[#FEEF00]/60',
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
              className={[
                'rounded-full border px-4 py-2 text-sm font-semibold hover:border-sky-300/60',
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
              className={[
                'rounded-full border px-4 py-2 text-sm font-semibold hover:border-[#FEEF00]/60',
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
              className={[
                'rounded-full border px-4 py-2 text-sm font-semibold hover:border-[#FEEF00]/60 disabled:opacity-70',
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
              className="rounded-full border border-[#303044] bg-[#111118] px-4 py-2 text-sm font-semibold text-[#F5F5F7] hover:border-[#FEEF00]/60"
            >
              {queueRefreshing ? 'Actualizando...' : 'Actualizar'}
            </button>
            <span className="hidden rounded-full border border-emerald-400/30 bg-emerald-400/10 px-3 py-2 text-xs font-semibold text-emerald-200 sm:inline-flex">
              {formatRefreshTime(lastAutoRefreshAt)}
            </span>
            <Link
              href="/app"
              className="rounded-full border border-[#303044] bg-[#111118] px-4 py-2 text-sm font-semibold text-[#F5F5F7] hover:border-[#FEEF00]/60"
            >
              Modulos
            </Link>
          </div>
        </div>
      </header>

      <section className="mx-auto max-w-7xl px-5 py-5">
        {message ? (
          <div
            className={[
              'mt-4 rounded-[8px] border px-4 py-3 text-sm font-semibold',
              message.tone === 'success'
                ? 'border-emerald-400/40 bg-emerald-400/10 text-emerald-200'
                : 'border-red-400/40 bg-red-400/10 text-red-200',
            ].join(' ')}
          >
            {message.text}
          </div>
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

        <div className="mt-5 grid gap-5 lg:grid-cols-[minmax(360px,0.92fr)_minmax(520px,1.08fr)]">
          <section className="rounded-[8px] border border-[#242433] bg-[#111118]">
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

              <div className="mt-4 flex flex-wrap gap-2">
                {FILTERS.map((item) => (
                  <button
                    key={item.key}
                    type="button"
                    onClick={() => setFilter(item.key)}
                    className={[
                      'rounded-full border px-3 py-1.5 text-sm font-semibold transition',
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

              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Buscar en esta vista: orden, cliente o telefono"
                className="mt-4 w-full rounded-[8px] border border-[#303044] bg-[#0B0B0D] px-4 py-3 text-sm outline-none placeholder:text-[#666878] focus:border-[#FEEF00]/70"
              />
            </div>

            <div className="max-h-[calc(100vh-330px)] overflow-y-auto p-2">
              {filteredOrders.length === 0 ? (
                <div className="rounded-[8px] border border-dashed border-[#303044] p-6 text-sm text-[#9FA0AA]">
                  No hay pedidos en esta vista.
                </div>
              ) : (
                <div className="space-y-3">
                  {orderSections.map((section) => (
                    <div key={section.key} className="rounded-[8px] border border-[#242433] bg-[#0B0B0D] p-2">
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

          <section className="rounded-[8px] border border-[#242433] bg-[#111118]">
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
      className={[
        'w-full rounded-[8px] border p-4 text-left transition',
        selected
          ? 'border-[#FEEF00] bg-[#FEEF00]/8'
          : 'border-[#242433] bg-[#111118] hover:border-[#3D3D52]',
      ].join(' ')}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-[#FEEF00]">Orden #{order.displayNumber}</div>
          <div className="mt-1 truncate text-base font-semibold text-[#F5F5F7]">{order.clientName}</div>
          <div className="mt-1 truncate text-xs text-[#9FA0AA]">Asesor: {order.advisorName || 'Sin asesor'}</div>
          <div className="mt-1 text-xs text-[#9FA0AA]">{scheduleLabel(order)}</div>
        </div>
        <div className="shrink-0 text-right">
          <div className="text-sm font-semibold">{moneyUsd(order.totalUsd)}</div>
          {order.balanceUsd > 0.005 ? (
            <div className="text-xs font-semibold text-orange-300">Debe {moneyUsd(order.balanceUsd)}</div>
          ) : (
            <div className="text-xs font-semibold text-emerald-300">OK</div>
          )}
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="rounded-full border border-[#303044] px-2 py-0.5 text-xs text-[#C7C8D1]">
          {fulfillmentLabel(order.fulfillment)}
        </span>
        <span className={['rounded-full border px-2 py-0.5 text-xs font-semibold', counterStatusClass(order)].join(' ')}>
          {getOperationalStatusLabel(order)}
        </span>
        <span className={['rounded-full border px-2 py-0.5 text-xs font-semibold', paymentClass(order)].join(' ')}>
          {paymentLabel(order)}
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

function CounterCashPanel({
  accounts,
  activeBsRate,
  isWorking,
  isClosing,
  onRefresh,
  onCreateMovement,
  onCreateClosure,
}: {
  accounts: CounterCashAccountSummary[];
  activeBsRate: number;
  isWorking: boolean;
  isClosing: boolean;
  onRefresh: () => void;
  onCreateMovement: (input: CounterCashMovementInput) => void;
  onCreateClosure: (input: CounterCashClosureInput) => void;
}) {
  const firstAccount = accounts[0] ?? null;
  const [movementOpen, setMovementOpen] = useState(false);
  const [movementAccountId, setMovementAccountId] = useState(firstAccount ? String(firstAccount.accountId) : '');
  const [movementDirection, setMovementDirection] = useState<'inflow' | 'outflow'>('inflow');
  const [movementOutflowPurpose, setMovementOutflowPurpose] = useState<'change' | 'expense'>('expense');
  const [movementAmount, setMovementAmount] = useState('');
  const [movementDate, setMovementDate] = useState(getTodayKey());
  const [movementExchangeRate, setMovementExchangeRate] = useState(
    activeBsRate > 0 ? String(Number(activeBsRate.toFixed(2))) : ''
  );
  const [movementReferenceCode, setMovementReferenceCode] = useState('');
  const [movementCounterpartyName, setMovementCounterpartyName] = useState('');
  const [movementDescription, setMovementDescription] = useState('');
  const [movementNotes, setMovementNotes] = useState('');
  const [movementError, setMovementError] = useState<string | null>(null);
  const [closureOpen, setClosureOpen] = useState(false);
  const [closureAccountId, setClosureAccountId] = useState(firstAccount ? String(firstAccount.accountId) : '');
  const [closureAmount, setClosureAmount] = useState('');
  const [closureDate, setClosureDate] = useState(getTodayKey());
  const [closureTime, setClosureTime] = useState(getCurrentTimeKey());
  const [closureExchangeRate, setClosureExchangeRate] = useState(
    activeBsRate > 0 ? String(Number(activeBsRate.toFixed(2))) : ''
  );
  const [closureReason, setClosureReason] = useState('Cierre de turno');
  const [closureNotes, setClosureNotes] = useState('');
  const [closureError, setClosureError] = useState<string | null>(null);
  const selectedAccount =
    accounts.find((account) => String(account.accountId) === movementAccountId) ?? firstAccount;
  const selectedClosureAccount =
    accounts.find((account) => String(account.accountId) === closureAccountId) ?? firstAccount;
  const selectedClosureIsPos = selectedClosureAccount?.accountKind === 'pos';
  const selectedClosureExpectedAmount = selectedClosureAccount
    ? selectedClosureIsPos
      ? selectedClosureAccount.net
      : selectedClosureAccount.balance
    : 0;
  const closureCountedNumber = toDecimalInput(closureAmount);
  const closureDifference =
    selectedClosureAccount && Number.isFinite(closureCountedNumber)
      ? Number((closureCountedNumber - selectedClosureExpectedAmount).toFixed(2))
      : 0;
  const totalInflowUsd = accounts.reduce((sum, account) => {
    if (account.currencyCode === 'USD') return sum + account.inflow;
    return sum + account.movements
      .filter((movement) => movement.direction === 'inflow')
      .reduce((movementSum, movement) => movementSum + movement.amountUsdEquivalent, 0);
  }, 0);
  const totalOutflowUsd = accounts.reduce((sum, account) => {
    if (account.currencyCode === 'USD') return sum + account.outflow;
    return sum + account.movements
      .filter((movement) => movement.direction === 'outflow')
      .reduce((movementSum, movement) => movementSum + movement.amountUsdEquivalent, 0);
  }, 0);
  const totalBalanceUsd = accounts.reduce((sum, account) => {
    if (account.currencyCode === 'USD') return sum + account.balance;
    return activeBsRate > 0 ? sum + account.balance / activeBsRate : sum;
  }, 0);

  function submitMovement() {
    const moneyAccountId = Number(movementAccountId || 0);
    const amount = toDecimalInput(movementAmount);
    const exchangeRate =
      selectedAccount?.currencyCode === 'VES'
        ? toDecimalInput(movementExchangeRate)
        : null;
    const description = movementDescription.trim();

    if (!moneyAccountId) {
      setMovementError('Selecciona una cuenta.');
      return;
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      setMovementError('Indica un monto valido.');
      return;
    }
    if (selectedAccount?.currencyCode === 'VES' && (!exchangeRate || exchangeRate <= 0)) {
      setMovementError('Indica una tasa valida.');
      return;
    }
    if (!description) {
      setMovementError('Indica el motivo del movimiento.');
      return;
    }

    setMovementError(null);
    onCreateMovement({
      direction: movementDirection,
      outflowPurpose: movementOutflowPurpose,
      moneyAccountId,
      amount,
      movementDate,
      exchangeRateVesPerUsd: exchangeRate,
      referenceCode: movementReferenceCode.trim() || null,
      counterpartyName: movementCounterpartyName.trim() || null,
      description,
      notes: movementNotes.trim() || null,
    });
    setMovementAmount('');
    setMovementReferenceCode('');
    setMovementCounterpartyName('');
    setMovementDescription('');
    setMovementNotes('');
  }

  function submitClosure() {
    const moneyAccountId = Number(closureAccountId || 0);
    const countedAmount = toDecimalInput(closureAmount);
    const exchangeRate =
      selectedClosureAccount?.currencyCode === 'VES'
        ? toDecimalInput(closureExchangeRate)
        : null;
    const reason = closureReason.trim();

    if (!moneyAccountId) {
      setClosureError('Selecciona una cuenta.');
      return;
    }
    if (!Number.isFinite(countedAmount) || countedAmount < 0) {
      setClosureError('Indica el monto contado.');
      return;
    }
    if (!closureDate) {
      setClosureError('Indica la fecha del cierre.');
      return;
    }
    if (!/^\d{2}:\d{2}$/.test(closureTime)) {
      setClosureError('Indica la hora del cierre.');
      return;
    }
    if (selectedClosureAccount?.currencyCode === 'VES' && (!exchangeRate || exchangeRate <= 0)) {
      setClosureError('Indica una tasa valida.');
      return;
    }
    if (!reason) {
      setClosureError('Indica el motivo del cierre.');
      return;
    }

    setClosureError(null);
    onCreateClosure({
      moneyAccountId,
      closureDate,
      closureTime,
      countedAmount,
      exchangeRateVesPerUsd: exchangeRate,
      reason,
      notes: closureNotes.trim() || null,
    });
    setClosureAmount('');
    setClosureNotes('');
    setClosureTime(getCurrentTimeKey());
  }

  return (
    <section className="mt-5 rounded-[8px] border border-[#242433] bg-[#111118] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Caja</h2>
          <p className="mt-1 text-sm text-[#9FA0AA]">
            Cajas DAR y puntos. Vista operativa del dia.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={onRefresh}
            className="rounded-full border border-[#303044] bg-[#0B0B0D] px-3 py-1.5 text-sm font-semibold text-[#F5F5F7] hover:border-[#FEEF00]/50"
          >
            Actualizar
          </button>
          <button
            type="button"
            onClick={() => setMovementOpen((current) => !current)}
            disabled={accounts.length === 0}
            className="rounded-full border border-[#FEEF00]/50 bg-[#FEEF00]/10 px-3 py-1.5 text-sm font-semibold text-[#FEEF00] hover:bg-[#FEEF00]/20 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {movementOpen ? 'Ocultar movimiento' : 'Registrar movimiento'}
          </button>
          <button
            type="button"
            onClick={() => {
              setClosureOpen((current) => !current);
              setClosureTime(getCurrentTimeKey());
              if (!closureAmount && selectedClosureAccount) {
                setClosureAmount(String(selectedClosureExpectedAmount));
              }
            }}
            disabled={accounts.length === 0}
            className="rounded-full border border-sky-300/50 bg-sky-300/10 px-3 py-1.5 text-sm font-semibold text-sky-100 hover:bg-sky-300/15 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {closureOpen ? 'Ocultar cierre' : 'Arqueo / cierre'}
          </button>
        </div>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <div className="rounded-[8px] border border-[#242433] bg-[#0B0B0D] p-3">
          <div className="text-xs text-[#9FA0AA]">Entradas ref.</div>
          <div className="mt-1 text-lg font-semibold text-emerald-300">{moneyUsd(totalInflowUsd)}</div>
        </div>
        <div className="rounded-[8px] border border-[#242433] bg-[#0B0B0D] p-3">
          <div className="text-xs text-[#9FA0AA]">Salidas ref.</div>
          <div className="mt-1 text-lg font-semibold text-orange-300">{moneyUsd(totalOutflowUsd)}</div>
        </div>
        <div className="rounded-[8px] border border-[#242433] bg-[#0B0B0D] p-3">
          <div className="text-xs text-[#9FA0AA]">Cuentas</div>
          <div className="mt-1 text-lg font-semibold text-[#F5F5F7]">{accounts.length}</div>
        </div>
        <div className="rounded-[8px] border border-[#242433] bg-[#0B0B0D] p-3 sm:col-span-3">
          <div className="text-xs text-[#9FA0AA]">Saldo operativo ref.</div>
          <div className="mt-1 text-lg font-semibold text-[#F5F5F7]">{moneyUsd(totalBalanceUsd)}</div>
        </div>
      </div>

      {movementOpen ? (
        <div className="mt-4 rounded-[8px] border border-[#303044] bg-[#0B0B0D] p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold">Movimiento rapido</h3>
              <p className="mt-1 text-xs text-[#9FA0AA]">
                Para ingresos/egresos operativos de mostrador. Los pagos de orden siguen registrandose desde la orden.
              </p>
            </div>
            <div className="flex rounded-full border border-[#303044] bg-[#111118] p-1">
              {(['inflow', 'outflow'] as const).map((direction) => (
                <button
                  key={direction}
                  type="button"
                  onClick={() => setMovementDirection(direction)}
                  className={[
                    'rounded-full px-3 py-1 text-xs font-semibold',
                    movementDirection === direction
                      ? 'bg-[#FEEF00] text-black'
                      : 'text-[#C7C8D1] hover:text-[#FEEF00]',
                  ].join(' ')}
                >
                  {direction === 'inflow' ? 'Entrada' : 'Salida'}
                </button>
              ))}
            </div>
          </div>

          {movementError ? (
            <div className="mt-3 rounded-[8px] border border-red-400/40 bg-red-400/10 px-3 py-2 text-sm font-semibold text-red-200">
              {movementError}
            </div>
          ) : null}

          <div className="mt-4 grid gap-3 lg:grid-cols-[1.2fr_0.8fr_0.65fr_0.75fr]">
            <label className="text-sm text-[#9FA0AA]">
              Cuenta
              <select
                value={selectedAccount ? String(selectedAccount.accountId) : ''}
                onChange={(event) => setMovementAccountId(event.target.value)}
                className="mt-1 w-full rounded-[8px] border border-[#303044] bg-[#111118] px-3 py-3 text-[#F5F5F7] outline-none focus:border-[#FEEF00]/70"
              >
                {accounts.map((account) => (
                  <option key={account.accountId} value={account.accountId}>
                    {account.accountName} - {accountKindLabel(account.accountKind)}
                  </option>
                ))}
              </select>
            </label>

            <label className="text-sm text-[#9FA0AA]">
              Monto {selectedAccount?.currencyCode || ''}
              <input
                value={movementAmount}
                onChange={(event) => setMovementAmount(event.target.value)}
                inputMode="decimal"
                className="mt-1 w-full rounded-[8px] border border-[#303044] bg-[#111118] px-3 py-3 text-[#F5F5F7] outline-none focus:border-[#FEEF00]/70"
              />
            </label>

            {selectedAccount?.currencyCode === 'VES' ? (
              <label className="text-sm text-[#9FA0AA]">
                Tasa
                <input
                  value={movementExchangeRate}
                  onChange={(event) => setMovementExchangeRate(event.target.value)}
                  inputMode="decimal"
                  className="mt-1 w-full rounded-[8px] border border-[#303044] bg-[#111118] px-3 py-3 text-[#F5F5F7] outline-none focus:border-[#FEEF00]/70"
                />
              </label>
            ) : (
              <div className="hidden lg:block" />
            )}

            <label className="text-sm text-[#9FA0AA]">
              Fecha
              <input
                type="date"
                value={movementDate}
                onChange={(event) => setMovementDate(event.target.value)}
                className="mt-1 w-full rounded-[8px] border border-[#303044] bg-[#111118] px-3 py-3 text-[#F5F5F7] outline-none focus:border-[#FEEF00]/70"
              />
            </label>
          </div>

          {movementDirection === 'outflow' ? (
            <div className="mt-3 flex flex-wrap gap-2">
              {(['expense', 'change'] as const).map((purpose) => (
                <button
                  key={purpose}
                  type="button"
                  onClick={() => setMovementOutflowPurpose(purpose)}
                  className={[
                    'rounded-full border px-3 py-1.5 text-sm font-semibold',
                    movementOutflowPurpose === purpose
                      ? 'border-[#FEEF00] bg-[#FEEF00]/10 text-[#FEEF00]'
                      : 'border-[#303044] text-[#C7C8D1] hover:border-[#FEEF00]/50',
                  ].join(' ')}
                >
                  {purpose === 'change' ? 'Cambio' : 'Gasto operativo'}
                </button>
              ))}
            </div>
          ) : null}

          <div className="mt-3 grid gap-3 lg:grid-cols-3">
            <label className="text-sm text-[#9FA0AA]">
              Motivo
              <input
                value={movementDescription}
                onChange={(event) => setMovementDescription(event.target.value)}
                placeholder={movementDirection === 'inflow' ? 'Ingreso adicional' : 'Gasto / cambio'}
                className="mt-1 w-full rounded-[8px] border border-[#303044] bg-[#111118] px-3 py-3 text-[#F5F5F7] outline-none placeholder:text-[#666878] focus:border-[#FEEF00]/70"
              />
            </label>
            <label className="text-sm text-[#9FA0AA]">
              Referencia
              <input
                value={movementReferenceCode}
                onChange={(event) => setMovementReferenceCode(event.target.value)}
                placeholder="Opcional"
                className="mt-1 w-full rounded-[8px] border border-[#303044] bg-[#111118] px-3 py-3 text-[#F5F5F7] outline-none placeholder:text-[#666878] focus:border-[#FEEF00]/70"
              />
            </label>
            <label className="text-sm text-[#9FA0AA]">
              Persona
              <input
                value={movementCounterpartyName}
                onChange={(event) => setMovementCounterpartyName(event.target.value)}
                placeholder="Opcional"
                className="mt-1 w-full rounded-[8px] border border-[#303044] bg-[#111118] px-3 py-3 text-[#F5F5F7] outline-none placeholder:text-[#666878] focus:border-[#FEEF00]/70"
              />
            </label>
            <label className="text-sm text-[#9FA0AA] lg:col-span-3">
              Nota
              <input
                value={movementNotes}
                onChange={(event) => setMovementNotes(event.target.value)}
                placeholder="Opcional"
                className="mt-1 w-full rounded-[8px] border border-[#303044] bg-[#111118] px-3 py-3 text-[#F5F5F7] outline-none placeholder:text-[#666878] focus:border-[#FEEF00]/70"
              />
            </label>
          </div>

          <div className="mt-4 flex justify-end">
            <button
              type="button"
              onClick={submitMovement}
              disabled={isWorking || accounts.length === 0}
              className="rounded-[8px] border border-[#FEEF00]/70 bg-[#FEEF00] px-5 py-3 text-sm font-bold text-black transition hover:bg-[#fff45c] disabled:cursor-wait disabled:opacity-60"
            >
              {isWorking ? 'Guardando...' : 'Guardar movimiento'}
            </button>
          </div>
        </div>
      ) : null}

      {closureOpen ? (
        <div className="mt-4 rounded-[8px] border border-sky-300/30 bg-sky-950/10 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-sky-100">Arqueo / cierre operativo</h3>
              <p className="mt-1 text-xs text-sky-100/70">
                Cuenta el dinero fisico o el lote del punto y registra la foto del cierre.
              </p>
            </div>
            <span
              className={[
                'rounded-full border px-3 py-1 text-xs font-semibold',
                Math.abs(closureDifference) <= 0.009
                  ? 'border-emerald-300/40 bg-emerald-300/10 text-emerald-200'
                  : 'border-orange-300/40 bg-orange-300/10 text-orange-200',
              ].join(' ')}
            >
              Dif.{' '}
              {selectedClosureAccount?.currencyCode === 'VES'
                ? moneyBs(closureDifference)
                : moneyUsd(closureDifference)}
            </span>
          </div>

          {closureError ? (
            <div className="mt-3 rounded-[8px] border border-red-400/40 bg-red-400/10 px-3 py-2 text-sm font-semibold text-red-200">
              {closureError}
            </div>
          ) : null}

          <div className="mt-4 grid gap-3 lg:grid-cols-[1.2fr_0.8fr_0.8fr_0.7fr]">
            <label className="text-sm text-[#9FA0AA]">
              Cuenta
              <select
                value={selectedClosureAccount ? String(selectedClosureAccount.accountId) : ''}
                onChange={(event) => {
                  const nextAccount = accounts.find((account) => String(account.accountId) === event.target.value);
                  setClosureAccountId(event.target.value);
                  if (nextAccount) {
                    setClosureAmount(String(nextAccount.accountKind === 'pos' ? nextAccount.net : nextAccount.balance));
                  }
                }}
                className="mt-1 w-full rounded-[8px] border border-[#303044] bg-[#111118] px-3 py-3 text-[#F5F5F7] outline-none focus:border-sky-300/70"
              >
                {accounts.map((account) => (
                  <option key={account.accountId} value={account.accountId}>
                    {account.accountName} - {accountKindLabel(account.accountKind)}
                  </option>
                ))}
              </select>
            </label>

            <div className="rounded-[8px] border border-[#303044] bg-[#0B0B0D] px-3 py-2">
              <div className="text-xs text-[#9FA0AA]">
                {selectedClosureIsPos ? 'Lote visible' : 'Esperado sistema'}
              </div>
              <div className="mt-1 text-base font-semibold text-[#F5F5F7]">
                {selectedClosureAccount?.currencyCode === 'VES'
                  ? moneyBs(selectedClosureExpectedAmount)
                  : moneyUsd(selectedClosureExpectedAmount)}
              </div>
              {selectedClosureIsPos ? (
                <div className="mt-1 text-[11px] text-[#9FA0AA]">
                  Pendiente total: {selectedClosureAccount?.currencyCode === 'VES'
                    ? moneyBs(selectedClosureAccount?.balance ?? 0)
                    : moneyUsd(selectedClosureAccount?.balance ?? 0)}
                </div>
              ) : null}
            </div>

            <label className="text-sm text-[#9FA0AA]">
              Contado {selectedClosureAccount?.currencyCode || ''}
              <input
                value={closureAmount}
                onChange={(event) => setClosureAmount(event.target.value)}
                inputMode="decimal"
                placeholder={
                  selectedClosureAccount
                    ? selectedClosureAccount.currencyCode === 'VES'
                      ? moneyBs(selectedClosureExpectedAmount)
                      : moneyUsd(selectedClosureExpectedAmount)
                    : '0'
                }
                className="mt-1 w-full rounded-[8px] border border-[#303044] bg-[#111118] px-3 py-3 text-[#F5F5F7] outline-none placeholder:text-[#666878] focus:border-sky-300/70"
              />
            </label>

            {selectedClosureAccount?.currencyCode === 'VES' ? (
              <label className="text-sm text-[#9FA0AA]">
                Tasa
                <input
                  value={closureExchangeRate}
                  onChange={(event) => setClosureExchangeRate(event.target.value)}
                  inputMode="decimal"
                  className="mt-1 w-full rounded-[8px] border border-[#303044] bg-[#111118] px-3 py-3 text-[#F5F5F7] outline-none focus:border-sky-300/70"
                />
              </label>
            ) : (
              <div className="hidden lg:block" />
            )}
          </div>

          <div className="mt-3 grid gap-3 lg:grid-cols-[0.8fr_0.65fr_1fr]">
            <label className="text-sm text-[#9FA0AA]">
              Fecha
              <input
                type="date"
                value={closureDate}
                onChange={(event) => setClosureDate(event.target.value)}
                className="mt-1 w-full rounded-[8px] border border-[#303044] bg-[#111118] px-3 py-3 text-[#F5F5F7] outline-none focus:border-sky-300/70"
              />
            </label>
            <label className="text-sm text-[#9FA0AA]">
              Hora
              <input
                type="time"
                value={closureTime}
                onChange={(event) => setClosureTime(event.target.value)}
                className="mt-1 w-full rounded-[8px] border border-[#303044] bg-[#111118] px-3 py-3 text-[#F5F5F7] outline-none focus:border-sky-300/70"
              />
            </label>
            <label className="text-sm text-[#9FA0AA]">
              Motivo
              <input
                value={closureReason}
                onChange={(event) => setClosureReason(event.target.value)}
                className="mt-1 w-full rounded-[8px] border border-[#303044] bg-[#111118] px-3 py-3 text-[#F5F5F7] outline-none focus:border-sky-300/70"
              />
            </label>
            <label className="text-sm text-[#9FA0AA] lg:col-span-3">
              Nota
              <input
                value={closureNotes}
                onChange={(event) => setClosureNotes(event.target.value)}
                placeholder="Opcional"
                className="mt-1 w-full rounded-[8px] border border-[#303044] bg-[#111118] px-3 py-3 text-[#F5F5F7] outline-none placeholder:text-[#666878] focus:border-sky-300/70"
              />
            </label>
          </div>

          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
            <div className="text-xs text-sky-100/70">
              Cajas y puntos deben cerrar sin diferencia. Si hay diferencia, registra primero el movimiento que la explica.
            </div>
            <button
              type="button"
              onClick={submitClosure}
              disabled={isClosing || accounts.length === 0}
              className="rounded-[8px] border border-sky-300/60 bg-sky-300/15 px-5 py-3 text-sm font-bold text-sky-100 transition hover:bg-sky-300/20 disabled:cursor-wait disabled:opacity-60"
            >
              {isClosing ? 'Guardando...' : 'Guardar cierre'}
            </button>
          </div>
        </div>
      ) : null}

      <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {accounts.length === 0 ? (
          <div className="rounded-[8px] border border-dashed border-[#303044] p-4 text-sm text-[#9FA0AA] sm:col-span-2">
            Mostrador no tiene cuentas operativas activas.
          </div>
        ) : (
          accounts.map((account) => (
            <div key={account.accountId} className="rounded-[8px] border border-[#242433] bg-[#0B0B0D] p-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold">{account.accountName}</div>
                  <div className="mt-1 text-xs text-[#9FA0AA]">
                    {accountKindLabel(account.accountKind)} · {account.currencyCode}
                  </div>
                </div>
                <span className="rounded-full border border-[#303044] px-2 py-0.5 text-xs text-[#C7C8D1]">
                  {account.methods.map((method) => getPaymentMethodLabel(method)).join(', ')}
                </span>
              </div>
              <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
                <div className="col-span-3 rounded-[8px] border border-[#303044] bg-[#111118] px-2 py-2">
                  <div className="text-[#9FA0AA]">Saldo actual</div>
                  <div className="mt-1 text-base font-semibold text-[#F5F5F7]">
                    {account.currencyCode === 'VES' ? moneyBs(account.balance) : moneyUsd(account.balance)}
                  </div>
                </div>
                <div>
                  <div className="text-[#9FA0AA]">Entró</div>
                  <div className="mt-1 font-semibold text-emerald-300">
                    {account.currencyCode === 'VES' ? moneyBs(account.inflow) : moneyUsd(account.inflow)}
                  </div>
                </div>
                <div>
                  <div className="text-[#9FA0AA]">Salió</div>
                  <div className="mt-1 font-semibold text-orange-300">
                    {account.currencyCode === 'VES' ? moneyBs(account.outflow) : moneyUsd(account.outflow)}
                  </div>
                </div>
                <div>
                  <div className="text-[#9FA0AA]">Neto</div>
                  <div className="mt-1 font-semibold text-[#F5F5F7]">
                    {account.currencyCode === 'VES' ? moneyBs(account.net) : moneyUsd(account.net)}
                  </div>
                </div>
              </div>
              {account.movements.length > 0 ? (
                <div className="mt-3 space-y-1 border-t border-[#242433] pt-2">
                  {account.movements.slice(0, 3).map((movement) => (
                    <div key={movement.id} className="flex items-start justify-between gap-2 text-[11px]">
                      <div className="min-w-0">
                        <div className="truncate text-[#C7C8D1]">
                          {movement.description || (movement.direction === 'inflow' ? 'Entrada' : 'Salida')}
                        </div>
                        <div className="truncate text-[#777988]">
                          {movement.createdByName || 'Usuario'}
                          {movement.referenceCode ? ` · ${movement.referenceCode}` : ''}
                        </div>
                      </div>
                      <div className={movement.direction === 'outflow' ? 'shrink-0 text-orange-300' : 'shrink-0 text-emerald-300'}>
                        {movement.direction === 'outflow' ? '-' : '+'}
                        {movement.currencyCode === 'VES' ? moneyBs(movement.amount) : moneyUsd(movement.amount)}
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ))
        )}
      </div>
    </section>
  );
}

function CounterHistoricalSearchPanel({
  query,
  results,
  nextCursor,
  searched,
  isPending,
  onQueryChange,
  onSearch,
  onLoadMore,
  onClear,
  onOpenOrder,
  onOpenPayment,
}: {
  query: string;
  results: CounterHistoricalSearchResult[];
  nextCursor: CounterHistoricalSearchCursor | null;
  searched: boolean;
  isPending: boolean;
  onQueryChange: (value: string) => void;
  onSearch: () => void;
  onLoadMore: () => void;
  onClear: () => void;
  onOpenOrder: (orderId: number) => void;
  onOpenPayment: (orderId: number) => void;
}) {
  return (
    <section className="mt-4 rounded-[8px] border border-[#242433] bg-[#111118] p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">Buscar orden</h2>
          <p className="mt-1 text-xs text-[#9FA0AA]">
            Consulta cualquier orden por numero, cliente o telefono cuando no aparezca en la cola del counter.
          </p>
        </div>
        {searched ? (
          <button
            type="button"
            onClick={onClear}
            className="rounded-full border border-[#303044] bg-[#0B0B0D] px-3 py-1.5 text-sm font-semibold text-[#F5F5F7] hover:border-[#FEEF00]/50"
          >
            Limpiar
          </button>
        ) : null}
      </div>

      <div className="mt-3 grid gap-2 md:grid-cols-[1fr_128px]">
        <input
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') onSearch();
          }}
          placeholder="Orden, cliente o telefono"
          className="rounded-[8px] border border-[#303044] bg-[#0B0B0D] px-3 py-2 text-sm outline-none placeholder:text-[#666878] focus:border-[#FEEF00]/70"
        />
        <button
          type="button"
          onClick={onSearch}
          disabled={isPending}
          className="rounded-[8px] border border-[#FEEF00]/70 bg-[#FEEF00] px-4 py-2 text-sm font-bold text-black transition hover:bg-[#fff45c] disabled:cursor-wait disabled:opacity-60"
        >
          {isPending ? 'Buscando...' : 'Buscar'}
        </button>
      </div>

      {searched ? (
        <div className="mt-4">
          {results.length === 0 ? (
            <div className="rounded-[8px] border border-dashed border-[#303044] p-4 text-sm text-[#9FA0AA]">
              Sin resultados para esa busqueda.
            </div>
          ) : (
            <div className="grid gap-2 xl:grid-cols-2">
              {results.map((result) => {
                const reason = historicalSearchReason(result);

                return (
                  <div key={result.id} className="rounded-[8px] border border-[#303044] bg-[#0B0B0D] p-3">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-base font-semibold">#{result.displayNumber}</span>
                          <span className="rounded-full border border-[#303044] px-2 py-0.5 text-xs text-[#C7C8D1]">
                            {result.fulfillment === 'delivery' ? 'Delivery' : 'Pickup'}
                          </span>
                          <span className="rounded-full border border-[#FEEF00]/50 bg-[#FEEF00]/10 px-2 py-0.5 text-xs font-semibold text-[#FEEF00]">
                            {historicalSearchStatusLabel(result.status)}
                          </span>
                        </div>
                        <div className="mt-1 truncate text-sm font-semibold">{result.clientName}</div>
                        <div className="mt-1 text-xs text-[#9FA0AA]">
                          {result.clientPhone || 'Sin telefono'} - {result.scheduledDate || 'Sin fecha'}{' '}
                          {result.scheduledTime || ''}
                        </div>
                        {result.receiverName || result.receiverPhone ? (
                          <div className="mt-1 text-xs text-[#9FA0AA]">
                            Recibe: {result.receiverName || 'Sin nombre'}
                            {result.receiverPhone ? ` · ${result.receiverPhone}` : ''}
                          </div>
                        ) : null}
                        {reason ? <div className="mt-2 text-sm text-[#C7C8D1]">{reason}</div> : null}
                      </div>
                      <div className="shrink-0 text-right">
                        <div className="text-sm font-semibold">{moneyUsd(result.totalUsd)}</div>
                        <div className="text-xs text-[#9FA0AA]">{moneyBs(result.totalBs)}</div>
                      </div>
                    </div>
                    <div className="mt-3 grid gap-2 rounded-[8px] border border-[#242433] bg-[#111118] p-2 text-xs text-[#C7C8D1] sm:grid-cols-2">
                      <div>
                        <span className="text-[#777988]">Productos: </span>
                        {result.productSummary.length > 0
                          ? result.productSummary.join(', ')
                          : `${result.itemCount} item(s)`}
                      </div>
                      <div>
                        <span className="text-[#777988]">Pago: </span>
                        {historicalSearchPaymentLabel(result)}
                      </div>
                      <div>
                        <span className="text-[#777988]">Creada: </span>
                        {formatDateTime(result.createdAt)}
                      </div>
                      <div>
                        <span className="text-[#777988]">Entrega: </span>
                        {result.deliveredAt
                          ? formatDateTime(result.deliveredAt)
                          : result.readyAt
                            ? `Lista ${formatDateTime(result.readyAt)}`
                            : 'Pendiente'}
                      </div>
                    </div>
                    {result.note ? <div className="mt-2 text-xs text-[#9FA0AA]">Nota: {result.note}</div> : null}
                    <div className="mt-3 grid gap-2 sm:grid-cols-2">
                      <button
                        type="button"
                        onClick={() => onOpenOrder(result.id)}
                        disabled={isPending}
                        className="rounded-[8px] border border-[#303044] bg-[#111118] px-3 py-2 text-xs font-semibold text-[#F5F5F7] hover:border-[#FEEF00]/60 disabled:opacity-60"
                      >
                        Abrir expediente
                      </button>
                      {result.status !== 'cancelled' && result.balanceUsd > 0.005 ? (
                        <button
                          type="button"
                          onClick={() => onOpenPayment(result.id)}
                          disabled={isPending}
                          className="rounded-[8px] border border-emerald-300/40 bg-emerald-300/10 px-3 py-2 text-xs font-semibold text-emerald-100 hover:border-emerald-300/70 disabled:opacity-60"
                        >
                          Abrir cobro
                        </button>
                      ) : (
                        <div className="rounded-[8px] border border-[#242433] px-3 py-2 text-center text-xs text-[#777988]">
                          {result.status === 'cancelled' ? 'Solo consulta' : 'Sin deuda pendiente'}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {nextCursor ? (
            <div className="mt-3 flex justify-center">
              <button
                type="button"
                onClick={onLoadMore}
                disabled={isPending}
                className="rounded-full border border-[#303044] bg-[#0B0B0D] px-4 py-2 text-sm font-semibold text-[#F5F5F7] hover:border-[#FEEF00]/50 disabled:cursor-wait disabled:opacity-60"
              >
                {isPending ? 'Cargando...' : 'Cargar resultados anteriores'}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function CounterQuickSalePanel({
  products,
  productComponents,
  discountRules,
  activeBsRate,
  isWorking,
  onCancel,
  onSubmit,
}: {
  products: CounterQuickSaleProductOption[];
  productComponents: CounterQuickSaleProductComponent[];
  discountRules: CounterDiscountRuleOption[];
  activeBsRate: number;
  isWorking: boolean;
  onCancel: () => void;
  onSubmit: (input: CounterDirectSaleIntent) => void;
}) {
  const [clientSearch, setClientSearch] = useState('');
  const [clientSearchResults, setClientSearchResults] = useState<CounterClientSearchResult[]>([]);
  const [clientSearchLoading, setClientSearchLoading] = useState(false);
  const [selectedClient, setSelectedClient] = useState<CounterClientSearchResult | null>(null);
  const [newClientMode, setNewClientMode] = useState(false);
  const [clientName, setClientName] = useState('');
  const [clientPhone, setClientPhone] = useState('');
  const [clientType, setClientType] = useState<'own' | 'assigned' | 'legacy'>('own');
  const [fulfillment, setFulfillment] = useState<'pickup' | 'delivery'>('pickup');
  const [deliveryAddress, setDeliveryAddress] = useState('');
  const [deliveryGpsUrl, setDeliveryGpsUrl] = useState('');
  const [receiverIsDifferent, setReceiverIsDifferent] = useState(false);
  const [receiverName, setReceiverName] = useState('');
  const [receiverPhone, setReceiverPhone] = useState('');
  const [note, setNote] = useState('');
  const [scheduleMode, setScheduleMode] = useState<'now' | 'scheduled'>('now');
  const [scheduledDate, setScheduledDate] = useState(getTodayKey());
  const [scheduledTime, setScheduledTime] = useState('');
  const [paymentMethod, setPaymentMethod] = useState('pos');
  const [paymentCurrency, setPaymentCurrency] = useState<'USD' | 'VES'>('VES');
  const [paymentRequiresChange, setPaymentRequiresChange] = useState(false);
  const [paymentChangeFor, setPaymentChangeFor] = useState('');
  const [paymentChangeCurrency, setPaymentChangeCurrency] = useState<'USD' | 'VES'>('USD');
  const [paymentNote, setPaymentNote] = useState('');
  const [discountRuleId, setDiscountRuleId] = useState('');
  const [openPaymentAfterCreate, setOpenPaymentAfterCreate] = useState(true);
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const [hasDeliveryNote, setHasDeliveryNote] = useState(false);
  const [hasInvoice, setHasInvoice] = useState(false);
  const [invoiceTaxPct, setInvoiceTaxPct] = useState('16');
  const [invoiceDataNote, setInvoiceDataNote] = useState('');
  const [invoiceCompanyName, setInvoiceCompanyName] = useState('');
  const [invoiceTaxId, setInvoiceTaxId] = useState('');
  const [invoiceAddress, setInvoiceAddress] = useState('');
  const [invoicePhone, setInvoicePhone] = useState('');
  const [deliveryNoteName, setDeliveryNoteName] = useState('');
  const [deliveryNoteDocumentId, setDeliveryNoteDocumentId] = useState('');
  const [deliveryNoteAddress, setDeliveryNoteAddress] = useState('');
  const [deliveryNotePhone, setDeliveryNotePhone] = useState('');
  const [productSearch, setProductSearch] = useState('');
  const [selectedProductId, setSelectedProductId] = useState('');
  const [qty, setQty] = useState('1');
  const [itemNotes, setItemNotes] = useState('');
  const [cartItems, setCartItems] = useState<CounterQuickSaleCartItem[]>([]);
  const [configProductId, setConfigProductId] = useState<number | null>(null);
  const [configAlias, setConfigAlias] = useState('');
  const [configSelections, setConfigSelections] = useState<Array<{
    localId: string;
    componentProductId: number;
    componentName: string;
    qty: number;
  }>>([]);
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    const nextCurrency = getQuickSalePaymentCurrency(paymentMethod);
    if (nextCurrency) setPaymentCurrency(nextCurrency);
  }, [paymentMethod]);

  const productsById = useMemo(
    () => new Map(products.map((product) => [product.id, product])),
    [products]
  );
  const componentsByParentId = useMemo(() => {
    const map = new Map<number, CounterQuickSaleProductComponent[]>();
    for (const component of productComponents) {
      const current = map.get(component.parentProductId) ?? [];
      current.push(component);
      map.set(component.parentProductId, current);
    }
    return map;
  }, [productComponents]);
  const selectedProduct = selectedProductId ? productsById.get(Number(selectedProductId)) ?? null : null;
  const configProduct = configProductId ? productsById.get(configProductId) ?? null : null;
  const configComponents = configProductId ? componentsByParentId.get(configProductId) ?? [] : [];
  const configSelectableComponents = configComponents.filter(
    (component) => component.componentMode === 'selectable' || (component.componentMode === 'fixed' && !component.isRequired)
  );
  const configSelectedUnits = configSelections.reduce((sum, row) => {
    const component = configComponents.find((item) => item.componentProductId === row.componentProductId);
    return sum + (component?.countsTowardDetailLimit ? Number(row.qty || 0) : 0);
  }, 0);
  const filteredProducts = useMemo(() => {
    const term = productSearch.trim().toLocaleLowerCase('es-VE');
    if (!term) return products.slice(0, 80);
    return products
      .filter((product) =>
        [product.name, product.sku, product.type]
          .filter(Boolean)
          .some((value) => String(value).toLocaleLowerCase('es-VE').includes(term))
      )
      .slice(0, 80);
  }, [productSearch, products]);
  const lineRows = useMemo(() => {
    return cartItems.map((item) => {
      const product = productsById.get(item.productId) ?? null;
      const itemQty = Math.max(0, toDecimalInput(item.qty));
      const sourceAmount =
        product?.sourcePriceCurrency === 'VES'
          ? product.sourcePriceAmount || product.basePriceBs
          : product?.sourcePriceAmount || product?.basePriceUsd || 0;
      const snapshot = product
        ? calculateOrderLineSnapshot({
            sourceCurrency: product.sourcePriceCurrency,
            sourceAmount,
            quantity: itemQty,
            fxRate: activeBsRate,
            fallbackUnitUsd: product.basePriceUsd,
          })
        : { unitUsd: 0, lineUsd: 0, unitBs: 0, lineBs: 0 };

      return {
        item,
        product,
        qty: itemQty,
        snapshot,
      };
    });
  }, [activeBsRate, cartItems, productsById]);
  const cartSubtotal = useMemo(
    () => ({
      usd: lineRows.reduce((sum, row) => sum + row.snapshot.lineUsd, 0),
      bs: lineRows.reduce((sum, row) => sum + row.snapshot.lineBs, 0),
    }),
    [lineRows]
  );
  const applicableDiscountRules = useMemo(
    () => discountRules.filter((rule) =>
      (rule.paymentMethodCodes.length === 0 || rule.paymentMethodCodes.includes(paymentMethod)) &&
      (rule.paymentCurrencies.length === 0 || rule.paymentCurrencies.includes(paymentCurrency)) &&
      (rule.fulfillments.length === 0 || rule.fulfillments.includes(fulfillment))
    ),
    [discountRules, fulfillment, paymentCurrency, paymentMethod]
  );
  const selectedDiscountRule =
    applicableDiscountRules.find((rule) => rule.id === Number(discountRuleId)) ?? null;
  const totals = useMemo(() => {
    return calculateOrderTotalsSnapshot({
      subtotalUsd: cartSubtotal.usd,
      subtotalBs: cartSubtotal.bs,
      discountPct: selectedDiscountRule?.discountPct ?? 0,
      invoiceTaxPct: hasInvoice ? toDecimalInput(invoiceTaxPct) : 0,
    });
  }, [cartSubtotal.bs, cartSubtotal.usd, hasInvoice, invoiceTaxPct, selectedDiscountRule]);

  useEffect(() => {
    if (discountRuleId && !selectedDiscountRule) setDiscountRuleId('');
  }, [discountRuleId, selectedDiscountRule]);

  async function handleClientSearch() {
    const query = clientSearch.trim();
    if (query.length < 2) {
      setLocalError('Escribe telefono o nombre para buscar el cliente.');
      return;
    }

    setClientSearchLoading(true);
    setLocalError(null);
    try {
      const results = await searchCounterClientsAction({ query });
      setClientSearchResults(results);
      if (results.length === 0) {
        setNewClientMode(true);
        setSelectedClient(null);
        if (query.replace(/\D/g, '').length >= 5) {
          setClientPhone(query);
        } else {
          setClientName(query);
        }
      }
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : 'No se pudo buscar el cliente.');
    } finally {
      setClientSearchLoading(false);
    }
  }

  function selectClient(client: CounterClientSearchResult) {
    setSelectedClient(client);
    setNewClientMode(false);
    setClientSearchResults([]);
    setClientName(client.fullName);
    setClientPhone(client.phone || '');
    setClientType(
      client.clientType === 'assigned' || client.clientType === 'legacy' || client.clientType === 'own'
        ? client.clientType
        : 'own'
    );
    setLocalError(null);
  }

  function startNewClient() {
    const query = clientSearch.trim();
    setSelectedClient(null);
    setNewClientMode(true);
    setClientSearchResults([]);
    if (!clientName && query && query.replace(/\D/g, '').length < 5) setClientName(query);
    if (!clientPhone && query.replace(/\D/g, '').length >= 5) setClientPhone(query);
    setLocalError(null);
  }

  function addCartItem() {
    const productId = Number(selectedProductId || 0);
    const product = productsById.get(productId);
    const productConfigComponents = componentsByParentId.get(productId) ?? [];
    const itemQty = toDecimalInput(qty);

    if (!product) {
      setLocalError('Selecciona un producto valido.');
      return;
    }
    if (!Number.isFinite(itemQty) || itemQty <= 0) {
      setLocalError('Indica una cantidad valida.');
      return;
    }

    if (product.isDetailEditable) {
      if (itemQty !== 1) {
        setLocalError('Los productos configurables se cargan uno por uno. Usa cantidad 1.');
        return;
      }

      const optionalFixedSelections = productConfigComponents
        .filter((component) => component.componentMode === 'fixed' && !component.isRequired && Number(component.quantity || 0) > 0)
        .map((component) => ({
          localId: `fixed-${component.componentProductId}`,
          componentProductId: component.componentProductId,
          componentName: component.componentName,
          qty: Number(component.quantity || 0),
        }));

      setConfigProductId(product.id);
      setConfigAlias('');
      setConfigSelections(optionalFixedSelections);
      setLocalError(null);
      return;
    }

    setCartItems((current) => [
      ...current,
      {
        id: `cart-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        productId,
        qty,
        notes: itemNotes.trim(),
        editableDetailLines: buildComponentDetailLines(productConfigComponents, {
          totalMultiplier: itemQty,
        }),
      },
    ]);
    setQty('1');
    setItemNotes('');
    setProductSearch('');
    setSelectedProductId('');
    setLocalError(null);
  }

  function setConfigSelectionQty(
    componentProductId: number,
    componentName: string,
    qtyValue: number
  ) {
    const safeQty = Math.max(0, Math.floor(Number(qtyValue || 0)));
    setConfigSelections((current) => {
      const others = current.filter((row) => row.componentProductId !== componentProductId);
      if (safeQty === 0) return others;
      return [
        ...others,
        {
          localId: String(componentProductId),
          componentProductId,
          componentName,
          qty: safeQty,
        },
      ];
    });
  }

  function closeProductConfig() {
    setConfigProductId(null);
    setConfigAlias('');
    setConfigSelections([]);
  }

  function confirmProductConfig() {
    if (!configProduct) return;

    const limit = Number(configProduct.detailUnitsLimit || 0);
    if (limit > 0 && configSelectedUnits !== limit) {
      setLocalError(`Debes seleccionar exactamente ${limit} piezas.`);
      return;
    }

    const selectedByProductId = new Map(
      configSelections
        .filter((row) => row.qty > 0)
        .map((row) => [row.componentProductId, row.qty] as const)
    );
    const detailLines: string[] = [];

    if (configAlias.trim()) {
      detailLines.push(`Para: ${configAlias.trim()}`);
    }

    detailLines.push(
      ...buildComponentDetailLines(configComponents, {
        selectedByProductId,
        includeMetadata: true,
      })
    );

    setCartItems((current) => [
      ...current,
      {
        id: `cart-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        productId: configProduct.id,
        qty: '1',
        notes: itemNotes.trim(),
        editableDetailLines: detailLines,
      },
    ]);
    setQty('1');
    setItemNotes('');
    setProductSearch('');
    setSelectedProductId('');
    closeProductConfig();
    setLocalError(null);
  }

  function submitQuickSale() {
    if (!selectedClient && !newClientMode) {
      setLocalError('Busca un cliente existente o marca crear cliente nuevo.');
      return;
    }
    if (!clientName.trim()) {
      setLocalError('Indica el nombre del cliente.');
      return;
    }
    if (!clientPhone.trim()) {
      setLocalError('Indica el telefono del cliente.');
      return;
    }
    if (fulfillment === 'delivery' && !deliveryAddress.trim()) {
      setLocalError('Indica la direccion para delivery.');
      return;
    }
    if (scheduleMode === 'scheduled' && (!scheduledDate || !scheduledTime)) {
      setLocalError('Indica fecha y hora para agendar el pedido.');
      return;
    }
    if (cartItems.length === 0) {
      setLocalError('Agrega al menos un producto.');
      return;
    }

    onSubmit({
      idempotencyKey,
      openPaymentAfterCreate,
      clientId: selectedClient?.id ?? null,
      clientName: clientName.trim(),
      clientPhone: clientPhone.trim(),
      clientType,
      fulfillment,
      deliveryAddress: deliveryAddress.trim(),
      deliveryGpsUrl: deliveryGpsUrl.trim(),
      receiverName: receiverIsDifferent ? receiverName.trim() : '',
      receiverPhone: receiverIsDifferent ? receiverPhone.trim() : '',
      note: note.trim(),
      scheduleAsap: scheduleMode === 'now',
      scheduledDate,
      scheduledTime,
      paymentMethod,
      paymentCurrency,
      paymentRequiresChange,
      paymentChangeFor,
      paymentChangeCurrency,
      paymentNote: paymentNote.trim(),
      discountRuleId: selectedDiscountRule?.id ?? null,
      hasDeliveryNote,
      hasInvoice,
      invoiceTaxPct,
      invoiceDataNote: invoiceDataNote.trim(),
      invoiceCompanyName: invoiceCompanyName.trim(),
      invoiceTaxId: invoiceTaxId.trim(),
      invoiceAddress: invoiceAddress.trim(),
      invoicePhone: invoicePhone.trim(),
      deliveryNoteName: deliveryNoteName.trim(),
      deliveryNoteDocumentId: deliveryNoteDocumentId.trim(),
      deliveryNoteAddress: deliveryNoteAddress.trim(),
      deliveryNotePhone: deliveryNotePhone.trim(),
      items: cartItems.map((item) => ({
        productId: item.productId,
        qty: toDecimalInput(item.qty),
        notes: item.notes.trim() || null,
        editableDetailLines: item.editableDetailLines,
      })),
    });
  }

  return (
    <section className="rounded-[8px] border border-[#FEEF00]/35 bg-[#15150F] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Nueva venta</h2>
          <p className="mt-1 text-xs text-[#B9B9A8]">
            Crea una orden directa, calcula con la tasa activa y la envia a cocina.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <span className="rounded-full border border-[#303044] px-3 py-1 text-xs font-semibold text-[#C7C8D1]">
            Tasa {activeBsRate > 0 ? moneyBs(activeBsRate) : 'sin tasa'}
          </span>
          <button
            type="button"
            onClick={onCancel}
            className="rounded-full border border-[#303044] bg-[#0B0B0D] px-3 py-1.5 text-sm font-semibold text-[#F5F5F7] hover:border-[#FEEF00]/50"
          >
            Cerrar
          </button>
        </div>
      </div>

      {localError ? (
        <div className="mt-4 rounded-[8px] border border-red-400/40 bg-red-400/10 px-4 py-3 text-sm font-semibold text-red-200">
          {localError}
        </div>
      ) : null}

      <div className="mt-4 space-y-3">
        <div className="space-y-2 rounded-[8px] border border-[#242433] bg-[#0B0B0D] p-3">
          <h3 className="text-sm font-semibold">Cliente</h3>
          <div className="grid gap-2 md:grid-cols-[1fr_120px_145px]">
            <input
              value={clientSearch}
              onChange={(event) => setClientSearch(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void handleClientSearch();
                }
              }}
              placeholder="Buscar por telefono o nombre"
              className="rounded-[8px] border border-[#303044] bg-[#111118] px-3 py-2 text-sm text-[#F5F5F7] outline-none placeholder:text-[#666878] focus:border-[#FEEF00]/70"
            />
            <button
              type="button"
              onClick={() => void handleClientSearch()}
              disabled={clientSearchLoading}
              className="rounded-[8px] border border-[#303044] bg-[#15151C] px-3 py-2 text-sm font-semibold text-[#F5F5F7] hover:border-[#FEEF00]/50 disabled:opacity-60"
            >
              {clientSearchLoading ? 'Buscando...' : 'Buscar'}
            </button>
            <button
              type="button"
              onClick={startNewClient}
              className="rounded-[8px] border border-[#FEEF00]/60 bg-[#FEEF00]/10 px-3 py-2 text-sm font-semibold text-[#FEEF00] hover:bg-[#FEEF00]/15"
            >
              Crear cliente
            </button>
          </div>
          {clientSearchResults.length > 0 ? (
            <div className="max-h-[180px] overflow-y-auto rounded-[8px] border border-[#242433] bg-[#111118]">
              {clientSearchResults.map((client) => (
                <button
                  key={client.id}
                  type="button"
                  onClick={() => selectClient(client)}
                  className="w-full border-b border-[#242433] px-3 py-2 text-left last:border-b-0 hover:bg-[#1A1A22]"
                >
                  <div className="text-sm font-semibold text-[#F5F5F7]">{client.fullName}</div>
                  <div className="mt-0.5 text-xs text-[#9FA0AA]">
                    {client.phone || 'Sin telefono'} - {client.clientType || 'sin tipo'} - Fondo {moneyUsd(client.fundBalanceUsd)}
                  </div>
                </button>
              ))}
            </div>
          ) : null}
          {selectedClient ? (
            <div className="space-y-2 rounded-[8px] border border-emerald-400/30 bg-emerald-400/10 px-3 py-2">
              <div className="text-sm font-semibold text-emerald-100">{selectedClient.fullName}</div>
              <div className="mt-1 text-xs text-emerald-100/75">
                {selectedClient.phone || 'Sin telefono'} - {selectedClient.clientType || 'sin tipo'} - Fondo {moneyUsd(selectedClient.fundBalanceUsd)}
              </div>
              <label className="block text-xs text-emerald-100/75">
                Teléfono confirmado para esta venta
                <input
                  value={clientPhone}
                  onChange={(event) => setClientPhone(event.target.value)}
                  inputMode="tel"
                  placeholder="Obligatorio"
                  className="mt-1 w-full rounded-[8px] border border-emerald-200/30 bg-[#0B0B0D] px-3 py-2 text-sm text-[#F5F5F7] outline-none placeholder:text-[#666878] focus:border-[#FEEF00]/70"
                />
              </label>
            </div>
          ) : null}
          {newClientMode ? (
            <div className="space-y-2 rounded-[8px] border border-[#303044] bg-[#111118] p-3">
              <div className="text-xs font-semibold uppercase tracking-[0.12em] text-[#9FA0AA]">Cliente nuevo</div>
              <div className="grid gap-2 sm:grid-cols-2">
                <label className="text-xs text-[#9FA0AA]">
                  Nombre
                  <input
                    value={clientName}
                    onChange={(event) => setClientName(event.target.value)}
                    className="mt-1 w-full rounded-[8px] border border-[#303044] bg-[#0B0B0D] px-3 py-2 text-sm text-[#F5F5F7] outline-none focus:border-[#FEEF00]/70"
                  />
                </label>
                <label className="text-xs text-[#9FA0AA]">
                  Telefono
                  <input
                    value={clientPhone}
                    onChange={(event) => setClientPhone(event.target.value)}
                    inputMode="tel"
                    className="mt-1 w-full rounded-[8px] border border-[#303044] bg-[#0B0B0D] px-3 py-2 text-sm text-[#F5F5F7] outline-none focus:border-[#FEEF00]/70"
                  />
                </label>
              </div>
              <label className="text-xs text-[#9FA0AA]">
                Tipo
                <select
                  value={clientType}
                  onChange={(event) =>
                    setClientType(
                      event.target.value === 'assigned' || event.target.value === 'legacy' ? event.target.value : 'own'
                    )
                  }
                  className="mt-1 w-full rounded-[8px] border border-[#303044] bg-[#0B0B0D] px-3 py-2 text-sm text-[#F5F5F7] outline-none focus:border-[#FEEF00]/70"
                >
                  <option value="own">Propio</option>
                  <option value="assigned">Asignado</option>
                  <option value="legacy">Antiguo</option>
                </select>
              </label>
            </div>
          ) : null}
        </div>

        <div className="space-y-2 rounded-[8px] border border-[#242433] bg-[#0B0B0D] p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold">Pedido</h3>
            <span className="text-sm font-semibold text-[#F5F5F7]">{cartItems.length} item(s)</span>
          </div>
          <div className="grid gap-2 md:grid-cols-[1fr_110px]">
            <input
              value={productSearch}
              onChange={(event) => setProductSearch(event.target.value)}
              placeholder="Buscar producto"
              className="rounded-[8px] border border-[#303044] bg-[#111118] px-3 py-2 text-sm text-[#F5F5F7] outline-none placeholder:text-[#666878] focus:border-[#FEEF00]/70"
            />
            <input
              value={qty}
              onChange={(event) => setQty(event.target.value)}
              inputMode="decimal"
              className="rounded-[8px] border border-[#303044] bg-[#111118] px-3 py-2 text-sm text-[#F5F5F7] outline-none focus:border-[#FEEF00]/70"
            />
          </div>
          {productSearch.trim() ? (
            <div className="max-h-[210px] overflow-y-auto rounded-[8px] border border-[#242433] bg-[#111118]">
              {filteredProducts.length === 0 ? (
                <div className="px-3 py-3 text-sm text-[#9FA0AA]">Sin resultados.</div>
              ) : (
                filteredProducts.map((product) => (
                  <button
                    key={product.id}
                    type="button"
                    onClick={() => {
                      setSelectedProductId(String(product.id));
                      setProductSearch(product.name);
                    }}
                    className={[
                      'w-full border-b border-[#242433] px-3 py-2 text-left last:border-b-0 hover:bg-[#1A1A22]',
                      selectedProductId === String(product.id) ? 'bg-[#1A1A22]' : '',
                    ].join(' ')}
                  >
                    <div className="truncate text-sm font-semibold text-[#F5F5F7]">{product.name}</div>
                    <div className="mt-0.5 text-xs text-[#9FA0AA]">
                      {product.unitsPerService > 0 ? `${product.unitsPerService} und/serv` : 'Sin unidades'} -{' '}
                      {moneyUsd(product.basePriceUsd)} / {moneyBs(product.basePriceBs)}
                    </div>
                  </button>
                ))
              )}
            </div>
          ) : null}

          {selectedProduct ? (
            <div className="rounded-[8px] border border-emerald-400/30 bg-emerald-400/10 px-3 py-2 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <div className="font-semibold text-emerald-100">{selectedProduct.name}</div>
                {selectedProduct.isDetailEditable ? (
                  <span className="rounded-full border border-emerald-200/30 px-2 py-0.5 text-[11px] font-semibold text-emerald-100">
                    Armable
                  </span>
                ) : (componentsByParentId.get(selectedProduct.id) ?? []).length > 0 ? (
                  <span className="rounded-full border border-emerald-200/30 px-2 py-0.5 text-[11px] font-semibold text-emerald-100">
                    Combo
                  </span>
                ) : null}
              </div>
              <div className="mt-1 text-xs text-emerald-100/75">
                {selectedProduct.unitsPerService > 0 ? `${selectedProduct.unitsPerService} und/serv` : 'Sin unidades'} -{' '}
                {moneyUsd(selectedProduct.basePriceUsd)} / {moneyBs(selectedProduct.basePriceBs)}
              </div>
            </div>
          ) : null}
          {configProduct ? (
            <div className="space-y-3 rounded-[8px] border border-[#FEEF00]/40 bg-[#181807] p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <div className="text-sm font-semibold text-[#F5F5F7]">Armar {configProduct.name}</div>
                  <div className="mt-1 text-xs text-[#B9B9A8]">
                    {configProduct.detailUnitsLimit > 0
                      ? `${configSelectedUnits}/${configProduct.detailUnitsLimit} piezas seleccionadas`
                      : `${configSelectedUnits} piezas seleccionadas`}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={closeProductConfig}
                  className="rounded-full border border-[#303044] bg-[#0B0B0D] px-3 py-1 text-xs font-semibold text-[#F5F5F7]"
                >
                  Cerrar
                </button>
              </div>
              <input
                value={configAlias}
                onChange={(event) => setConfigAlias(event.target.value)}
                placeholder="Para / nombre dentro del pedido (opcional)"
                className="w-full rounded-[8px] border border-[#303044] bg-[#0B0B0D] px-3 py-2 text-sm text-[#F5F5F7] outline-none placeholder:text-[#666878] focus:border-[#FEEF00]/70"
              />
              <div className="grid gap-2 md:grid-cols-2">
                {configSelectableComponents.map((component) => {
                  const currentQty =
                    configSelections.find((row) => row.componentProductId === component.componentProductId)?.qty ?? 0;

                  return (
                    <label
                      key={component.componentProductId}
                      className="rounded-[8px] border border-[#303044] bg-[#0B0B0D] p-2 text-sm text-[#F5F5F7]"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-semibold">{component.componentName}</span>
                        <input
                          value={currentQty ? String(currentQty) : ''}
                          onChange={(event) =>
                            setConfigSelectionQty(
                              component.componentProductId,
                              component.componentName,
                              Number(event.target.value || 0)
                            )
                          }
                          inputMode="numeric"
                          className="h-9 w-20 rounded-[8px] border border-[#303044] bg-[#111118] px-2 text-right text-sm outline-none focus:border-[#FEEF00]/70"
                        />
                      </div>
                      <div className="mt-1 text-[11px] text-[#9FA0AA]">
                        {component.componentMode === 'fixed' ? 'Fijo opcional' : 'Seleccionable'}
                        {component.countsTowardDetailLimit ? ' · cuenta para limite' : ''}
                      </div>
                    </label>
                  );
                })}
              </div>
              <button
                type="button"
                onClick={confirmProductConfig}
                className="w-full rounded-[8px] border border-[#FEEF00]/70 bg-[#FEEF00] px-4 py-2 text-sm font-bold text-black transition hover:bg-[#fff45c]"
              >
                Guardar armado
              </button>
            </div>
          ) : null}
          <div className="grid gap-2 md:grid-cols-[1fr_130px]">
            <input
              value={itemNotes}
              onChange={(event) => setItemNotes(event.target.value)}
              placeholder="Nota del item (opcional)"
              className="rounded-[8px] border border-[#303044] bg-[#111118] px-3 py-2 text-sm text-[#F5F5F7] outline-none placeholder:text-[#666878] focus:border-[#FEEF00]/70"
            />
            <button
              type="button"
              onClick={addCartItem}
              disabled={products.length === 0 || activeBsRate <= 0}
              className="rounded-[8px] border border-[#FEEF00]/70 bg-[#FEEF00] px-4 py-2 text-sm font-bold text-black transition hover:bg-[#fff45c] disabled:cursor-not-allowed disabled:opacity-50"
            >
              Agregar
            </button>
          </div>

          <div className="max-h-[240px] overflow-y-auto rounded-[8px] border border-[#242433]">
            {lineRows.length === 0 ? (
              <div className="p-4 text-sm text-[#9FA0AA]">Sin productos agregados.</div>
            ) : (
              <div className="divide-y divide-[#242433]">
                {lineRows.map((row) => (
                  <div key={row.item.id} className="grid gap-2 p-3 sm:grid-cols-[60px_1fr_145px_auto]">
                    <div className="text-sm font-semibold text-[#FEEF00]">x{qtyLabel(row.qty)}</div>
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold">{row.product?.name || 'Producto'}</div>
                      <div className="mt-1 text-xs text-[#9FA0AA]">
                        Unit. {moneyUsd(row.snapshot.unitUsd)} / {moneyBs(row.snapshot.unitBs)}
                      </div>
                      {row.item.notes ? <div className="mt-1 text-xs text-[#9FA0AA]">{row.item.notes}</div> : null}
                      {getVisibleEditableDetailLines(row.item.editableDetailLines).length > 0 ? (
                        <ul className="mt-1 space-y-0.5 text-xs text-[#C7C8D1]">
                          {getVisibleEditableDetailLines(row.item.editableDetailLines).map((detail, detailIdx) => (
                            <li key={`${row.item.id}-${detailIdx}`}>• {detail}</li>
                          ))}
                        </ul>
                      ) : null}
                    </div>
                    <div className="text-sm font-semibold sm:text-right">
                      <div>{moneyUsd(row.snapshot.lineUsd)}</div>
                      <div className="mt-0.5 text-xs text-[#9FA0AA]">{moneyBs(row.snapshot.lineBs)}</div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setCartItems((current) => current.filter((item) => item.id !== row.item.id))}
                      className="rounded-[8px] border border-red-400/40 px-3 py-2 text-xs font-semibold text-red-200 hover:bg-red-400/10"
                    >
                      Quitar
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="rounded-[8px] border border-[#303044] bg-[#111118] p-3">
            <label className="text-xs text-[#9FA0AA]">
              Regla de descuento
              <select
                value={discountRuleId}
                onChange={(event) => setDiscountRuleId(event.target.value)}
                disabled={applicableDiscountRules.length === 0}
                className="mt-1 w-full rounded-[8px] border border-[#303044] bg-[#0B0B0D] px-3 py-2 text-sm text-[#F5F5F7] outline-none focus:border-[#FEEF00]/70 disabled:opacity-60"
              >
                <option value="">
                  {applicableDiscountRules.length === 0
                    ? 'No hay reglas activas aplicables'
                    : 'Sin descuento'}
                </option>
                {applicableDiscountRules.map((rule) => (
                  <option key={rule.id} value={rule.id}>
                    {rule.name} ({rule.discountPct}%)
                  </option>
                ))}
              </select>
            </label>
            <p className="mt-2 text-[11px] text-[#9FA0AA]">
              Mostrador solo puede aplicar reglas generales activas. La vigencia se vuelve a validar al confirmar.
            </p>
          </div>
        </div>

        <div className="space-y-2 rounded-[8px] border border-[#242433] bg-[#0B0B0D] p-3">
          <h3 className="text-sm font-semibold">Entrega</h3>
          <div className="grid grid-cols-2 gap-2">
            {(['pickup', 'delivery'] as const).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setFulfillment(option)}
                className={[
                  'rounded-[8px] border px-3 py-2 text-sm font-semibold',
                  fulfillment === option
                    ? 'border-[#FEEF00] bg-[#FEEF00]/10 text-[#FEEF00]'
                    : 'border-[#303044] bg-[#111118] text-[#C7C8D1]',
                ].join(' ')}
              >
                {option === 'pickup' ? 'Pickup' : 'Delivery'}
              </button>
            ))}
          </div>
          {fulfillment === 'delivery' ? (
            <div className="space-y-2">
              <label className="text-sm text-[#9FA0AA]">
                Direccion
                <textarea
                  value={deliveryAddress}
                  onChange={(event) => setDeliveryAddress(event.target.value)}
                  rows={2}
                  className="mt-1 w-full resize-none rounded-[8px] border border-[#303044] bg-[#111118] px-3 py-2 text-sm text-[#F5F5F7] outline-none focus:border-[#FEEF00]/70"
                />
              </label>
              <label className="text-sm text-[#9FA0AA]">
                GPS
                <input
                  value={deliveryGpsUrl}
                  onChange={(event) => setDeliveryGpsUrl(event.target.value)}
                  placeholder="Link de ubicacion (opcional)"
                  className="mt-1 w-full rounded-[8px] border border-[#303044] bg-[#111118] px-3 py-2 text-sm text-[#F5F5F7] outline-none placeholder:text-[#666878] focus:border-[#FEEF00]/70"
                />
              </label>
              <label className="flex items-center gap-2 rounded-[8px] border border-[#303044] bg-[#111118] px-3 py-3 text-sm text-[#F5F5F7]">
                <input
                  type="checkbox"
                  checked={receiverIsDifferent}
                  onChange={(event) => setReceiverIsDifferent(event.target.checked)}
                />
                Recibe otra persona
              </label>
              {receiverIsDifferent ? (
                <div className="grid gap-2 sm:grid-cols-2">
                  <label className="text-xs text-[#9FA0AA]">
                    Nombre recibe
                    <input
                      value={receiverName}
                      onChange={(event) => setReceiverName(event.target.value)}
                      className="mt-1 w-full rounded-[8px] border border-[#303044] bg-[#111118] px-3 py-2 text-sm text-[#F5F5F7] outline-none focus:border-[#FEEF00]/70"
                    />
                  </label>
                  <label className="text-xs text-[#9FA0AA]">
                    Telefono recibe
                    <input
                      value={receiverPhone}
                      onChange={(event) => setReceiverPhone(event.target.value)}
                      inputMode="tel"
                      className="mt-1 w-full rounded-[8px] border border-[#303044] bg-[#111118] px-3 py-2 text-sm text-[#F5F5F7] outline-none focus:border-[#FEEF00]/70"
                    />
                  </label>
                </div>
              ) : null}
            </div>
          ) : null}
          <div className="rounded-[8px] border border-[#303044] bg-[#111118] p-2">
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setScheduleMode('now')}
                className={[
                  'rounded-[8px] border px-3 py-1.5 text-sm font-semibold',
                  scheduleMode === 'now'
                    ? 'border-[#FEEF00] bg-[#FEEF00]/10 text-[#FEEF00]'
                    : 'border-[#303044] bg-[#0B0B0D] text-[#C7C8D1]',
                ].join(' ')}
              >
                Ahora
              </button>
              <button
                type="button"
                onClick={() => setScheduleMode('scheduled')}
                className={[
                  'rounded-[8px] border px-3 py-1.5 text-sm font-semibold',
                  scheduleMode === 'scheduled'
                    ? 'border-[#FEEF00] bg-[#FEEF00]/10 text-[#FEEF00]'
                    : 'border-[#303044] bg-[#0B0B0D] text-[#C7C8D1]',
                ].join(' ')}
              >
                Agendar
              </button>
            </div>
            {scheduleMode === 'scheduled' ? (
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                <label className="text-sm text-[#9FA0AA]">
                  Fecha
                  <input
                    type="date"
                    value={scheduledDate}
                    onChange={(event) => setScheduledDate(event.target.value)}
                  className="mt-1 w-full rounded-[8px] border border-[#303044] bg-[#0B0B0D] px-3 py-2 text-sm text-[#F5F5F7] outline-none focus:border-[#FEEF00]/70"
                  />
                </label>
                <label className="text-sm text-[#9FA0AA]">
                  Hora
                  <input
                    type="time"
                    value={scheduledTime}
                    onChange={(event) => setScheduledTime(event.target.value)}
                  className="mt-1 w-full rounded-[8px] border border-[#303044] bg-[#0B0B0D] px-3 py-2 text-sm text-[#F5F5F7] outline-none focus:border-[#FEEF00]/70"
                  />
                </label>
              </div>
            ) : (
              <div className="mt-3 text-xs text-[#9FA0AA]">Se envia a cocina con la hora actual.</div>
            )}
          </div>
          <label className="text-xs text-[#9FA0AA]">
            Nota de orden
            <input
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="Opcional"
              className="mt-1 w-full rounded-[8px] border border-[#303044] bg-[#111118] px-3 py-2 text-sm text-[#F5F5F7] outline-none placeholder:text-[#666878] focus:border-[#FEEF00]/70"
            />
          </label>
        </div>

        <div className="space-y-2 rounded-[8px] border border-[#242433] bg-[#0B0B0D] p-3">
          <h3 className="text-sm font-semibold">Pago esperado</h3>
          <div className="grid gap-2 rounded-[8px] border border-[#303044] bg-[#111118] p-3 sm:grid-cols-2">
            <label className="flex items-center gap-2 text-sm text-[#F5F5F7]">
              <input
                type="checkbox"
                checked={hasDeliveryNote}
                onChange={(event) => setHasDeliveryNote(event.target.checked)}
              />
              Nota de entrega
            </label>
            <label className="flex items-center gap-2 text-sm text-[#F5F5F7]">
              <input
                type="checkbox"
                checked={hasInvoice}
                onChange={(event) => setHasInvoice(event.target.checked)}
              />
              Factura
            </label>
            {hasInvoice ? (
              <div className="space-y-2 sm:col-span-2">
                <div className="grid gap-2 sm:grid-cols-2">
                  <label className="text-xs text-[#9FA0AA]">
                    Razon social
                    <input
                      value={invoiceCompanyName}
                      onChange={(event) => setInvoiceCompanyName(event.target.value)}
                      className="mt-1 w-full rounded-[8px] border border-[#303044] bg-[#0B0B0D] px-3 py-2 text-sm text-[#F5F5F7] outline-none focus:border-[#FEEF00]/70"
                    />
                  </label>
                  <label className="text-xs text-[#9FA0AA]">
                    RIF / Cedula
                    <input
                      value={invoiceTaxId}
                      onChange={(event) => setInvoiceTaxId(event.target.value)}
                      className="mt-1 w-full rounded-[8px] border border-[#303044] bg-[#0B0B0D] px-3 py-2 text-sm text-[#F5F5F7] outline-none focus:border-[#FEEF00]/70"
                    />
                  </label>
                  <label className="text-xs text-[#9FA0AA]">
                    Telefono fiscal
                    <input
                      value={invoicePhone}
                      onChange={(event) => setInvoicePhone(event.target.value)}
                      inputMode="tel"
                      className="mt-1 w-full rounded-[8px] border border-[#303044] bg-[#0B0B0D] px-3 py-2 text-sm text-[#F5F5F7] outline-none focus:border-[#FEEF00]/70"
                    />
                  </label>
                  <label className="text-xs text-[#9FA0AA]">
                    IVA %
                    <input
                      value={invoiceTaxPct}
                      onChange={(event) => setInvoiceTaxPct(event.target.value)}
                      inputMode="decimal"
                      className="mt-1 w-full rounded-[8px] border border-[#303044] bg-[#0B0B0D] px-3 py-2 text-sm text-[#F5F5F7] outline-none focus:border-[#FEEF00]/70"
                    />
                  </label>
                </div>
                <label className="text-xs text-[#9FA0AA]">
                  Direccion fiscal
                  <textarea
                    value={invoiceAddress}
                    onChange={(event) => setInvoiceAddress(event.target.value)}
                    rows={2}
                    className="mt-1 w-full resize-none rounded-[8px] border border-[#303044] bg-[#0B0B0D] px-3 py-2 text-sm text-[#F5F5F7] outline-none focus:border-[#FEEF00]/70"
                  />
                </label>
                <label className="text-xs text-[#9FA0AA]">
                  Datos factura
                  <input
                    value={invoiceDataNote}
                    onChange={(event) => setInvoiceDataNote(event.target.value)}
                    placeholder="Observacion fiscal opcional"
                    className="mt-1 w-full rounded-[8px] border border-[#303044] bg-[#0B0B0D] px-3 py-2 text-sm text-[#F5F5F7] outline-none placeholder:text-[#666878] focus:border-[#FEEF00]/70"
                  />
                </label>
              </div>
            ) : null}
            {hasDeliveryNote ? (
              <div className="space-y-2 sm:col-span-2">
                <div className="grid gap-2 sm:grid-cols-3">
                  <label className="text-xs text-[#9FA0AA]">
                    Nombre nota
                    <input
                      value={deliveryNoteName}
                      onChange={(event) => setDeliveryNoteName(event.target.value)}
                      className="mt-1 w-full rounded-[8px] border border-[#303044] bg-[#0B0B0D] px-3 py-2 text-sm text-[#F5F5F7] outline-none focus:border-[#FEEF00]/70"
                    />
                  </label>
                  <label className="text-xs text-[#9FA0AA]">
                    Documento
                    <input
                      value={deliveryNoteDocumentId}
                      onChange={(event) => setDeliveryNoteDocumentId(event.target.value)}
                      className="mt-1 w-full rounded-[8px] border border-[#303044] bg-[#0B0B0D] px-3 py-2 text-sm text-[#F5F5F7] outline-none focus:border-[#FEEF00]/70"
                    />
                  </label>
                  <label className="text-xs text-[#9FA0AA]">
                    Telefono nota
                    <input
                      value={deliveryNotePhone}
                      onChange={(event) => setDeliveryNotePhone(event.target.value)}
                      inputMode="tel"
                      className="mt-1 w-full rounded-[8px] border border-[#303044] bg-[#0B0B0D] px-3 py-2 text-sm text-[#F5F5F7] outline-none focus:border-[#FEEF00]/70"
                    />
                  </label>
                </div>
                <label className="text-xs text-[#9FA0AA]">
                  Direccion nota de entrega
                  <textarea
                    value={deliveryNoteAddress}
                    onChange={(event) => setDeliveryNoteAddress(event.target.value)}
                    rows={2}
                    className="mt-1 w-full resize-none rounded-[8px] border border-[#303044] bg-[#0B0B0D] px-3 py-2 text-sm text-[#F5F5F7] outline-none focus:border-[#FEEF00]/70"
                  />
                </label>
              </div>
            ) : null}
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
          <label className="text-xs text-[#9FA0AA]">
            Metodo
            <select
              value={paymentMethod}
              onChange={(event) => setPaymentMethod(event.target.value)}
              className="mt-1 w-full rounded-[8px] border border-[#303044] bg-[#111118] px-3 py-2 text-sm text-[#F5F5F7] outline-none focus:border-[#FEEF00]/70"
            >
              {QUICK_SALE_PAYMENT_METHODS.map((method) => (
                <option key={method.code} value={method.code}>
                  {method.label}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs text-[#9FA0AA]">
            Moneda
            <select
              value={paymentCurrency}
              onChange={(event) => setPaymentCurrency(event.target.value === 'VES' ? 'VES' : 'USD')}
              className="mt-1 w-full rounded-[8px] border border-[#303044] bg-[#111118] px-3 py-2 text-sm text-[#F5F5F7] outline-none focus:border-[#FEEF00]/70"
            >
              <option value="VES">VES</option>
              <option value="USD">USD</option>
            </select>
          </label>
          </div>
          <label className="flex items-center gap-2 rounded-[8px] border border-[#303044] bg-[#111118] px-3 py-3 text-sm text-[#F5F5F7]">
            <input
              type="checkbox"
              checked={paymentRequiresChange}
              onChange={(event) => setPaymentRequiresChange(event.target.checked)}
            />
            Requiere cambio
          </label>
          {paymentRequiresChange ? (
            <div className="grid grid-cols-[1fr_90px] gap-2">
              <input
                value={paymentChangeFor}
                onChange={(event) => setPaymentChangeFor(event.target.value)}
                placeholder="Cambio para"
                inputMode="decimal"
                className="rounded-[8px] border border-[#303044] bg-[#111118] px-3 py-2 text-sm text-[#F5F5F7] outline-none placeholder:text-[#666878] focus:border-[#FEEF00]/70"
              />
              <select
                value={paymentChangeCurrency}
                onChange={(event) => setPaymentChangeCurrency(event.target.value === 'VES' ? 'VES' : 'USD')}
                className="rounded-[8px] border border-[#303044] bg-[#111118] px-3 py-2 text-sm text-[#F5F5F7] outline-none focus:border-[#FEEF00]/70"
              >
                <option value="USD">USD</option>
                <option value="VES">VES</option>
              </select>
            </div>
          ) : null}
          <label className="text-xs text-[#9FA0AA]">
            Nota de pago
            <input
              value={paymentNote}
              onChange={(event) => setPaymentNote(event.target.value)}
              placeholder="Opcional"
              className="mt-1 w-full rounded-[8px] border border-[#303044] bg-[#111118] px-3 py-2 text-sm text-[#F5F5F7] outline-none placeholder:text-[#666878] focus:border-[#FEEF00]/70"
            />
          </label>

          <div className="rounded-[8px] border border-[#303044] bg-[#111118] p-3">
            <div className="grid gap-2 text-sm">
              <div className="flex justify-between gap-3 text-[#C7C8D1]">
                <span>Subtotal</span>
                <span>{moneyUsd(cartSubtotal.usd)} / {moneyBs(cartSubtotal.bs)}</span>
              </div>
              {selectedDiscountRule ? (
                <div className="flex justify-between gap-3 text-emerald-200">
                  <span>Descuento ({selectedDiscountRule.discountPct}%)</span>
                  <span>-{moneyUsd(totals.discountAmountUsd)} / -{moneyBs(totals.discountAmountBs)}</span>
                </div>
              ) : null}
              {hasInvoice && toDecimalInput(invoiceTaxPct) > 0 ? (
                <div className="flex justify-between gap-3 text-[#FEEF00]">
                  <span>IVA ({toDecimalInput(invoiceTaxPct)}%)</span>
                  <span>+{moneyUsd(totals.invoiceTaxAmountUsd)} / +{moneyBs(totals.invoiceTaxAmountBs)}</span>
                </div>
              ) : null}
              <div className="flex justify-between gap-3 border-t border-[#303044] pt-2 text-base font-semibold text-[#F5F5F7]">
                <span>Total</span>
                <span>{moneyUsd(totals.totalUsd)} / {moneyBs(totals.totalBs)}</span>
              </div>
            </div>
          </div>

          <label className="flex items-start gap-2 rounded-[8px] border border-[#303044] bg-[#111118] px-3 py-3 text-sm text-[#F5F5F7]">
            <input
              type="checkbox"
              checked={openPaymentAfterCreate}
              onChange={(event) => setOpenPaymentAfterCreate(event.target.checked)}
              className="mt-0.5"
            />
            <span>
              Abrir cobro al crear
              <span className="mt-0.5 block text-xs font-normal text-[#9FA0AA]">
                La orden se crea primero y luego usa el mismo motor de pagos mixtos de Mostrador.
              </span>
            </span>
          </label>

          <button
            type="button"
            onClick={submitQuickSale}
            disabled={isWorking || activeBsRate <= 0 || cartItems.length === 0}
            className="w-full rounded-[8px] border border-[#FEEF00]/70 bg-[#FEEF00] px-5 py-2.5 text-sm font-bold text-black transition hover:bg-[#fff45c] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isWorking ? 'Creando...' : scheduleMode === 'scheduled' ? 'Crear agenda' : 'Crear y enviar a cocina'}
          </button>
        </div>
      </div>
    </section>
  );
}

function getCounterCurrentAction(order: CounterOrder) {
  const paid = order.balanceUsd <= 0.005;
  const mustCollectNow = mustSettleBeforeCounterDelivery(order);

  if (order.status === 'cancelled') {
    return {
      title: 'Orden cancelada',
      description: 'Mostrador puede consultar el expediente, pero no modificar ni cobrar esta orden.',
      tone: 'neutral' as const,
      steps: ['Informar al cliente', 'Escalar cualquier correccion a Master o Administracion'],
    };
  }

  if (order.status === 'delivered') {
    return {
      title: paid ? 'Orden entregada y pagada' : 'Cobro pendiente de una orden entregada',
      description: paid
        ? 'El expediente queda disponible solo para consulta operativa.'
        : 'Mostrador puede registrar el pago pendiente sin modificar la orden entregada.',
      tone: paid ? ('good' as const) : ('warn' as const),
      steps: paid
        ? ['Informar el estado al cliente']
        : ['Abrir Pago', 'Registrar el cobro', 'Mantener la orden sin cambios'],
    };
  }

  if (order.status === 'created') {
    return {
      title: 'Agendado para master',
      description: 'El pedido fue creado por mostrador para otro momento. Master debe enviarlo a cocina cuando corresponda.',
      tone: 'warn' as const,
      steps: ['Confirmar hora con el cliente', 'Mantenerlo en agenda', 'Esperar accion del master'],
    };
  }

  if (order.status === 'queued' || order.status === 'confirmed' || order.status === 'in_kitchen') {
    return {
      title: 'Seguimiento de cocina',
      description: 'El pedido todavia no debe entregarse. Mostrador solo informa el estado al cliente.',
      tone: 'neutral' as const,
      steps: ['Ver estado actual', 'Informar al cliente si pregunta', 'Esperar que cocina marque lista'],
    };
  }

  if (order.fulfillment === 'pickup' && order.status === 'ready') {
    return {
      title: paid ? 'Entregar pickup' : mustCollectNow ? 'Cobrar y entregar pickup' : 'Entregar pickup pendiente',
      description: paid
        ? 'El pedido esta listo y pagado. Solo falta entregarlo al cliente.'
        : mustCollectNow
          ? order.hasAdvisor
            ? 'El metodo esperado es efectivo o punto. Registra el cobro antes de entregar.'
            : 'El cliente no tiene asesor. El pago debe quedar confirmado por Master antes de entregar.'
          : 'El pedido puede entregarse pendiente; el asesor queda responsable del cobro.',
      tone: paid ? ('good' as const) : mustCollectNow ? ('warn' as const) : ('neutral' as const),
      steps: paid
        ? ['Validar cliente', 'Entregar pedido', 'Marcar retirado']
        : mustCollectNow
          ? order.hasAdvisor
            ? ['Registrar pago', 'Validar cliente', 'Entregar pedido y marcar retirado']
            : ['Registrar pago', 'Esperar confirmacion de Master', 'Entregar pedido']
          : ['Validar cliente', 'Entregar pedido', 'Marcar retirado como pendiente'],
    };
  }

  if (order.fulfillment === 'delivery' && order.status === 'ready' && !order.deliveryAssigneeName) {
    return {
      title: 'Falta asignacion de delivery',
      description: 'La orden esta lista, pero no debe salir hasta que master asigne motorizado o partner.',
      tone: 'warn' as const,
      steps: ['Avisar a master', 'Esperar asignacion', 'Entregar al motorizado cuando este asignado'],
    };
  }

  if (order.fulfillment === 'delivery' && order.status === 'ready') {
    return {
      title: order.paymentRequiresChange ? 'Preparar cambio y entregar' : 'Entregar al motorizado',
      description: order.paymentRequiresChange
        ? 'Prepara el cambio indicado antes de entregar el pedido al motorizado.'
        : 'El pedido esta listo para salir con el motorizado asignado.',
      tone: order.paymentRequiresChange ? ('warn' as const) : ('good' as const),
      steps: order.paymentRequiresChange
        ? ['Preparar cambio', 'Entregar pedido al motorizado', 'Marcar en camino']
        : ['Validar motorizado', 'Entregar pedido', 'Marcar en camino'],
    };
  }

  if (order.status === 'out_for_delivery') {
    return {
      title: 'Liquidar custodia',
      description:
        'Counter recibe el efectivo y mantiene la liquidacion abierta el tiempo necesario. Master confirma aparte la entrega al cliente.',
      tone: 'warn' as const,
      steps: [
        'Registrar lo cobrado al cliente',
        'Ingresar el efectivo recibido en caja',
        'Dejar la entrega final a Master',
      ],
    };
  }

  return {
    title: 'Sin accion inmediata',
    description: 'Esta orden no requiere una accion de mostrador en este momento.',
    tone: 'neutral' as const,
    steps: ['Revisar datos', 'Consultar con master si hace falta'],
  };
}

function getCounterWorkflowChecks(order: CounterOrder) {
  const paid = order.balanceUsd <= 0.005;
  const hasPendingReports = order.reports.pending > 0;
  const inKitchenFlow =
    order.status === 'queued' || order.status === 'confirmed' || order.status === 'in_kitchen';
  const immediatePaymentExpected = isCounterImmediatePaymentMethod(order.paymentMethod);
  const mustCollectNow = mustSettleBeforeCounterDelivery(order);

  if (order.status === 'cancelled') {
    return [
      { label: 'Orden', detail: 'Cancelada', state: 'blocked' as const },
      { label: 'Acciones', detail: 'Solo consulta', state: 'pending' as const },
    ];
  }

  if (order.status === 'delivered') {
    return [
      { label: 'Entrega', detail: 'Completada', state: 'done' as const },
      {
        label: 'Cobro',
        detail: paid ? 'Cubierto' : `Pendiente ${moneyUsd(order.balanceUsd)}`,
        state: paid ? ('done' as const) : ('current' as const),
      },
      { label: 'Edicion', detail: 'Bloqueada', state: 'blocked' as const },
    ];
  }

  if (order.status === 'created') {
    return [
      { label: 'Agenda', detail: 'Master debe enviarlo a cocina', state: 'current' as const },
      { label: 'Cocina', detail: 'Pendiente', state: 'pending' as const },
      { label: 'Entrega', detail: 'Pendiente', state: 'pending' as const },
    ];
  }

  if (inKitchenFlow) {
    return [
      { label: 'Agenda', detail: 'Enviado', state: 'done' as const },
      { label: 'Cocina', detail: order.status === 'in_kitchen' ? 'Preparando' : 'En cola', state: 'current' as const },
      { label: 'Entrega', detail: 'Esperando cocina', state: 'pending' as const },
    ];
  }

  if (order.fulfillment === 'pickup' && order.status === 'ready') {
    const paymentOk = paid && !hasPendingReports;
    return [
      { label: 'Cocina', detail: 'Lista', state: 'done' as const },
      {
        label: 'Cobro',
        detail: paymentOk
          ? 'Cubierto'
          : hasPendingReports && immediatePaymentExpected
            ? 'Pago por revisar'
            : mustCollectNow
              ? !order.hasAdvisor && hasPendingReports
                ? 'Esperar confirmacion de Master'
                : `Cobrar ${moneyUsd(order.balanceUsd)}`
              : `Pendiente asesor ${moneyUsd(order.balanceUsd)}`,
        state: paymentOk ? ('done' as const) : mustCollectNow ? ('current' as const) : ('pending' as const),
      },
      {
        label: 'Retiro',
        detail: paymentOk ? 'Marcar retirado' : mustCollectNow ? 'Bloqueado hasta cobrar' : 'Puede entregarse',
        state: paymentOk || !mustCollectNow ? ('current' as const) : ('blocked' as const),
      },
    ];
  }

  if (order.fulfillment === 'delivery' && order.status === 'ready') {
    return [
      { label: 'Cocina', detail: 'Lista', state: 'done' as const },
      {
        label: 'Asignacion',
        detail: order.deliveryAssigneeName ? deliveryAssigneeLabel(order) || 'Asignado' : 'Falta asignar',
        state: order.deliveryAssigneeName ? ('done' as const) : ('current' as const),
      },
      {
        label: 'Salida',
        detail: order.deliveryAssigneeName ? 'Entregar y marcar en camino' : 'Esperando master',
        state: order.deliveryAssigneeName ? ('current' as const) : ('blocked' as const),
      },
    ];
  }

  if (order.status === 'out_for_delivery') {
    return [
      { label: 'Salida', detail: 'En camino', state: 'done' as const },
      {
        label: 'Custodia',
        detail: 'Revisar liquidacion exacta',
        state: 'current' as const,
      },
      {
        label: 'Entrega final',
        detail: 'La confirma Master',
        state: 'pending' as const,
      },
    ];
  }

  return [
    { label: 'Revision', detail: 'Sin accion inmediata', state: 'pending' as const },
  ];
}

function OrderDetail({
  order,
  initialPaymentOpen,
  onInitialPaymentOpened,
  paymentAccounts,
  quickSaleProducts,
  quickSaleProductComponents,
  activeBsRate,
  isWorking,
  onPrimaryDeliveryAction,
  onDeliverySettlementChanged,
  onCreatePaymentReport,
  onRequestRefund,
  onExecuteRefund,
  onChangePickupItems,
  onUpdatePickupSchedule,
  onRequestCatalog,
  catalogLoading,
}: {
  order: CounterOrder;
  initialPaymentOpen: boolean;
  onInitialPaymentOpened: () => void;
  paymentAccounts: CounterPaymentAccountOption[];
  quickSaleProducts: CounterQuickSaleProductOption[];
  quickSaleProductComponents: CounterQuickSaleProductComponent[];
  activeBsRate: number;
  isWorking: boolean;
  onPrimaryDeliveryAction: (
    order: CounterOrder,
    dispatchIntent?: CounterDeliveryDispatchIntent
  ) => Promise<CounterDeliveryDispatchResult | null>;
  onDeliverySettlementChanged: () => Promise<void>;
  onCreatePaymentReport: (
    order: CounterOrder,
    input: CounterPaymentIntent
  ) => Promise<CounterPaymentOperationResult>;
  onRequestRefund: (
    order: CounterOrder,
    input: CounterRefundRequestIntent
  ) => Promise<CounterRefundRequestResult>;
  onExecuteRefund: (
    order: CounterOrder,
    input: CounterRefundExecutionIntent
  ) => Promise<CounterRefundExecutionResult>;
  onChangePickupItems: (
    order: CounterOrder,
    input: CounterPickupItemChangeIntent
  ) => Promise<CounterPickupItemChangeResult>;
  onUpdatePickupSchedule: (
    order: CounterOrder,
    input: CounterPickupScheduleIntent
  ) => Promise<CounterPickupScheduleResult>;
  onRequestCatalog: () => Promise<boolean>;
  catalogLoading: boolean;
}) {
  const paid = order.balanceUsd <= 0.005;
  const isDelivered = order.status === 'delivered';
  const isCancelled = order.status === 'cancelled';
  const isClosedOrder = isDelivered || isCancelled;
  const isDeliverySettlement = order.fulfillment === 'delivery' && order.status === 'out_for_delivery';
  const deliveryReadyWithoutAssignee =
    order.fulfillment === 'delivery' && order.status === 'ready' && !order.deliveryAssigneeName;
  const waitingForMaster = order.status === 'created';
  const notReadyForCounter =
    waitingForMaster
    || order.status === 'queued'
    || order.status === 'confirmed'
    || order.status === 'in_kitchen';
  const hasPendingReports = order.reports.pending > 0;
  const pendingPickupChange =
    order.pickupChangeRequests.find((request) => request.status === 'pending') ?? null;
  const mustCollectNow = mustSettleBeforeCounterDelivery(order);
  const pickupReadyNeedsPayment =
    order.fulfillment === 'pickup' &&
    order.status === 'ready' &&
    mustCollectNow;
  const primaryActionBlocked =
    isClosedOrder ||
    notReadyForCounter ||
    Boolean(pendingPickupChange) ||
    pickupReadyNeedsPayment ||
    deliveryReadyWithoutAssignee ||
    isDeliverySettlement;
  const primaryActionBlockedMessage = isCancelled
    ? 'La orden esta cancelada. Counter solo puede consultar el expediente.'
    : isDelivered
      ? 'La orden ya fue entregada. Counter solo puede consultar y registrar pagos pendientes.'
    : pendingPickupChange
    ? 'Master debe aprobar o rechazar el cambio solicitado antes de entregar este pickup.'
    : order.fulfillment === 'pickup' && order.pendingDigitalChangeUsd > 0.005
      ? 'Todavia existe cambio digital pendiente de entregar al cliente. Completa ese cambio antes de marcar el pickup como retirado.'
    : waitingForMaster
    ? 'Esta orden quedo agendada. Master debe enviarla a cocina cuando corresponda.'
    : notReadyForCounter
      ? 'Esta orden aun esta en cocina. Cuando quede lista aparecera para entrega.'
    : pickupReadyNeedsPayment
      ? isCounterImmediatePaymentMethod(order.paymentMethod) && order.balanceUsd > 0.005
        ? 'El metodo esperado es efectivo o punto. Primero registra el cobro antes de marcar el pickup como retirado.'
        : hasPendingReports
        ? !order.hasAdvisor
          ? 'El cliente no tiene asesor. Master debe confirmar el pago antes de que Counter entregue el pedido.'
          : 'Hay pagos pendientes de revision. No marques retirado hasta que queden confirmados.'
        : 'Master debe confirmar el cobro antes de marcar el pickup como retirado.'
    : deliveryReadyWithoutAssignee
      ? 'Este delivery no tiene motorizado o partner asignado. Asignalo desde master antes de entregarlo.'
      : isDeliverySettlement
        ? 'Counter liquida la custodia y recibe el efectivo. Solo Master confirma la entrega final al cliente.'
        : mustCollectNow
          ? !order.hasAdvisor && hasPendingReports
            ? 'El cliente no tiene asesor. Master debe confirmar el pago antes de cerrar la entrega.'
            : 'El metodo esperado es efectivo o punto. Primero registra el cobro recibido del motorizado.'
          : 'Hay pagos pendientes de revision antes de cerrar la entrega.';
  const [paymentOpen, setPaymentOpen] = useState(initialPaymentOpen);
  const [addItemsOpen, setAddItemsOpen] = useState(false);
  const [deliveryDispatchOpen, setDeliveryDispatchOpen] = useState(false);
  const currentAction = getCounterCurrentAction(order);
  const canModifyPickup =
    order.fulfillment === 'pickup' &&
    (
      order.status === 'created' ||
      order.status === 'queued' ||
      order.status === 'confirmed' ||
      order.status === 'in_kitchen' ||
      order.status === 'ready'
    ) &&
    !pendingPickupChange;
  const canCorrectPickupSchedule =
    order.fulfillment === 'pickup' &&
    (
      order.status === 'created'
      || order.status === 'queued'
      || order.status === 'confirmed'
      || order.status === 'in_kitchen'
    );
  const isReadyDeliveryAction = order.fulfillment === 'delivery' && order.status === 'ready';
  const reservedRefundUsd = order.refundAuthorizations.reduce(
    (sum, authorization) =>
      authorization.status === 'pending' || authorization.status === 'approved'
        ? sum + authorization.amountUsdEquivalent
        : sum,
    0
  );
  const showRefundPanel =
    !isClosedOrder
    && (
      order.overpaidUsd - order.pendingDigitalChangeUsd - reservedRefundUsd > 0.005
      || order.refundAuthorizations.some(
        (authorization) => authorization.status === 'pending' || authorization.status === 'approved'
      )
    );

  useEffect(() => {
    if (initialPaymentOpen) onInitialPaymentOpened();
  }, [initialPaymentOpen, onInitialPaymentOpened]);

  function handlePrimaryActionClick() {
    if (isReadyDeliveryAction) {
      setDeliveryDispatchOpen(true);
      return;
    }

    void onPrimaryDeliveryAction(order);
  }

  async function handleToggleAddItems() {
    if (addItemsOpen) {
      setAddItemsOpen(false);
      return;
    }
    if (await onRequestCatalog()) setAddItemsOpen(true);
  }

  return (
    <div>
      <div className="border-b border-[#242433] p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-xl font-semibold">Orden #{order.displayNumber}</h2>
              <span className={['rounded-full border px-2.5 py-0.5 text-xs font-semibold', counterStatusClass(order)].join(' ')}>
                {getOperationalStatusLabel(order)}
              </span>
              <span className="rounded-full border border-[#303044] px-2.5 py-0.5 text-xs text-[#C7C8D1]">
                {fulfillmentLabel(order.fulfillment)}
              </span>
            </div>
            <div className="mt-1 truncate text-sm text-[#9FA0AA]">
              {order.clientName}
              {order.clientPhone ? ` · ${order.clientPhone}` : ''}
            </div>
            <div className="mt-1 text-xs text-[#9FA0AA]">
              Asesor: <span className="font-semibold text-[#F5F5F7]">{order.advisorName || 'Sin asesor'}</span>
            </div>
            <div className="mt-1 text-xs text-[#9FA0AA]">Lista: {formatDateTime(order.readyAt)}</div>
          </div>
          <span className={['rounded-full border px-3 py-1 text-xs font-semibold', paymentClass(order)].join(' ')}>
            {paymentLabel(order)}
          </span>
        </div>
      </div>

      <div className="grid gap-4 p-4 xl:grid-cols-[minmax(0,1fr)_280px]">
        <div className="space-y-3">
          <div className="rounded-[8px] border border-[#242433] bg-[#0B0B0D] p-3">
            <h3 className="font-semibold">Recorrido operativo</h3>
            <div className="mt-2 grid gap-2 text-xs text-[#C7C8D1] sm:grid-cols-2 xl:grid-cols-3">
              <div><span className="text-[#777988]">Creada: </span>{formatDateTime(order.createdAt)}</div>
              <div>
                <span className="text-[#777988]">Agenda: </span>
                {order.scheduledDate || 'Sin fecha'} {order.scheduledTime || ''}
              </div>
              <div><span className="text-[#777988]">Enviada a cocina: </span>{formatDateTime(order.sentToKitchenAt)}</div>
              <div><span className="text-[#777988]">Preparación: </span>{formatDateTime(order.kitchenStartedAt)}</div>
              <div><span className="text-[#777988]">Lista: </span>{formatDateTime(order.readyAt)}</div>
              <div><span className="text-[#777988]">Entregada: </span>{formatDateTime(order.deliveredAt)}</div>
            </div>
          </div>

          <div className="rounded-[8px] border border-[#242433] bg-[#0B0B0D] p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="font-semibold">Pedido</h3>
              <span className="text-sm font-semibold text-[#C7C8D1]">{order.items.length} item(s)</span>
            </div>
            <div className="mt-2 divide-y divide-[#242433]">
              {order.items.length === 0 ? (
                <div className="py-3 text-sm text-[#9FA0AA]">Sin items cargados.</div>
              ) : (
                order.items.map((item) => (
                  <div key={item.id} className="grid gap-2 py-2 sm:grid-cols-[56px_1fr_84px]">
                    <div className="rounded-[8px] border border-[#FEEF00]/35 bg-[#FEEF00]/10 px-2 py-1 text-center text-sm font-bold text-[#FEEF00]">
                      x{qtyLabel(item.qty)}
                    </div>
                    <div>
                      <div className="text-sm font-semibold">{item.name}</div>
                      {item.notes ? (
                        <ul className="mt-1 space-y-0.5 text-xs text-[#9FA0AA]">
                          {getVisibleEditableDetailLines(item.notes.split('\n')).map((detail, detailIdx) => (
                            <li key={`${item.id}-note-${detailIdx}`}>• {detail}</li>
                          ))}
                        </ul>
                      ) : null}
                    </div>
                    <div className="text-left text-sm font-semibold sm:text-right">{moneyUsd(item.lineTotalUsd)}</div>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <Metric label="Total" value={moneyUsd(order.totalUsd)} note={moneyBs(order.totalBs)} />
            <Metric label="Confirmado" value={moneyUsd(order.confirmedPaidUsd)} tone="good" />
            <Metric label="Pendiente" value={moneyUsd(order.balanceUsd)} tone={paid ? 'good' : 'warn'} />
          </div>

          {order.pendingReportsUsd > 0.005 ||
          order.pendingDigitalChangeUsd > 0.005 ||
          order.overpaidUsd > 0.005 ? (
            <div className="grid gap-2 sm:grid-cols-3">
              {order.pendingReportsUsd > 0.005 ? (
                <Metric
                  label="Pago por revisar"
                  value={moneyUsd(order.pendingReportsUsd)}
                  note={order.hasAdvisor ? 'Seguimiento del asesor' : 'Master debe confirmar'}
                  tone="warn"
                />
              ) : null}
              {order.pendingDigitalChangeUsd > 0.005 ? (
                <Metric
                  label="Cambio digital pendiente"
                  value={moneyUsd(order.pendingDigitalChangeUsd)}
                  note={order.hasAdvisor ? 'Responsable: asesor' : 'Responsable: Master'}
                  tone="warn"
                />
              ) : null}
              {order.overpaidUsd > 0.005 ? (
                <Metric
                  label="Saldo a favor"
                  value={moneyUsd(order.overpaidUsd)}
                  note="Puede ir a fondo o devolucion autorizada"
                />
              ) : null}
            </div>
          ) : null}

          <div className="rounded-[8px] border border-[#242433] bg-[#0B0B0D] p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="font-semibold">Pago esperado</h3>
              <span className="text-sm font-semibold text-[#F5F5F7]">{getPaymentMethodLabel(order.paymentMethod)}</span>
            </div>
            <div className="mt-2 grid gap-2 text-xs text-[#9FA0AA] sm:grid-cols-2">
              <div>Moneda: {order.paymentCurrency || 'Sin definir'}</div>
              <div>Tasa orden: {order.fxRate > 0 ? moneyBs(order.fxRate) : 'Sin tasa'}</div>
              {order.paymentRequiresChange ? (
                <div className="sm:col-span-2">
                  Cambio para: {order.paymentChangeFor || '-'} {order.paymentChangeCurrency || ''}
                </div>
              ) : null}
              {order.paymentNote ? <div className="sm:col-span-2">Nota: {order.paymentNote}</div> : null}
            </div>
          </div>

          {order.fulfillment === 'delivery' || order.deliveryAddress ? (
            <div className="rounded-[8px] border border-[#242433] bg-[#0B0B0D] p-3">
              <h3 className="font-semibold">Entrega</h3>
              <div className="mt-2 grid gap-2 text-xs text-[#C7C8D1] sm:grid-cols-2">
                <div className="sm:col-span-2">{order.deliveryAddress || 'Sin direccion'}</div>
                {order.receiverName || order.receiverPhone ? (
                  <div className="sm:col-span-2">
                    Recibe: {order.receiverName || 'Sin nombre'}
                    {order.receiverPhone ? ` · ${order.receiverPhone}` : ''}
                  </div>
                ) : null}
                {order.fulfillment === 'delivery' ? (
                  <>
                    <div>
                      Asignacion:{' '}
                      <span className={order.deliveryAssigneeName ? 'font-semibold text-[#F5F5F7]' : 'font-semibold text-red-200'}>
                        {deliveryAssigneeLabel(order)}
                      </span>
                    </div>
                    {order.externalReference ? <div>Ref. externa: {order.externalReference}</div> : null}
                  </>
                ) : null}
              </div>
            </div>
          ) : null}

          {deliveryDispatchOpen && isReadyDeliveryAction && !primaryActionBlocked ? (
            <CounterDeliveryDispatchPanel
              order={order}
              paymentAccounts={paymentAccounts}
              activeBsRate={activeBsRate}
              isWorking={isWorking}
              onCancel={() => setDeliveryDispatchOpen(false)}
              onSubmit={async (intent) => {
                const result = await onPrimaryDeliveryAction(order, intent);
                if (!result) throw new Error('No se pudo confirmar la salida.');
                setDeliveryDispatchOpen(false);
                return result;
              }}
            />
          ) : null}

          {isDeliverySettlement ? (
            <CounterDeliverySettlementBox
              orderId={order.id}
              paymentAccounts={paymentAccounts}
              activeBsRate={activeBsRate}
              onChanged={onDeliverySettlementChanged}
            />
          ) : null}

          {pendingPickupChange ? (
            <CounterPendingPickupChange request={pendingPickupChange} />
          ) : null}

          {canCorrectPickupSchedule ? (
            <CounterPickupScheduleBox
              order={order}
              isWorking={isWorking}
              onSubmit={(input) => onUpdatePickupSchedule(order, input)}
            />
          ) : null}

          {order.notes ? (
            <div className="rounded-[8px] border border-[#242433] bg-[#0B0B0D] p-3">
              <h3 className="font-semibold">Notas</h3>
              <div className="mt-2 text-xs text-[#C7C8D1]">{order.notes}</div>
            </div>
          ) : null}
        </div>

        <aside className="space-y-2 xl:sticky xl:top-4 xl:self-start">
          <CurrentActionCard action={currentAction} />
          <CounterWorkflowChecklist items={getCounterWorkflowChecks(order)} />
          <button
            type="button"
            onClick={handlePrimaryActionClick}
            disabled={isWorking || primaryActionBlocked}
            className="w-full rounded-[8px] border border-[#FEEF00]/70 bg-[#FEEF00] px-3 py-2 text-sm font-bold text-black transition hover:bg-[#fff45c] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isWorking ? 'Guardando...' : primaryCounterActionLabel(order)}
          </button>
          {primaryActionBlocked ? (
            <div className="rounded-[8px] border border-orange-400/30 bg-orange-950/20 p-3 text-xs leading-relaxed text-orange-100">
              {primaryActionBlockedMessage}
            </div>
          ) : null}
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => setPaymentOpen((current) => !current)}
              disabled={isCancelled || isWorking}
              className="rounded-[8px] border border-[#303044] bg-[#0B0B0D] px-3 py-2 text-xs font-semibold text-[#F5F5F7] transition hover:border-[#FEEF00]/60 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {paymentOpen ? 'Ocultar pago' : 'Pago'}
            </button>
            <button
              type="button"
              onClick={() => void handleToggleAddItems()}
              disabled={!canModifyPickup || isWorking || catalogLoading}
              className="rounded-[8px] border border-[#303044] bg-[#0B0B0D] px-3 py-2 text-xs font-semibold text-[#F5F5F7] transition hover:border-[#FEEF00]/60 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {catalogLoading ? 'Cargando...' : addItemsOpen ? 'Ocultar edicion' : 'Modificar'}
            </button>
          </div>
          {order.paymentRequiresChange ? (
            <ActionHint
              title="Preparar cambio"
              text={`Cambio para ${order.paymentChangeFor || '-'} ${order.paymentChangeCurrency || ''}. El egreso se registra al confirmar la salida.`}
              tone="warn"
            />
          ) : null}
          {canModifyPickup ? (
            <ActionHint
              title={order.status === 'ready' ? 'Cambio con autorizacion' : 'Modificar pickup'}
              text={
                order.status === 'ready'
                  ? 'El pedido ya esta empacado. Counter solicita el cambio y Master decide antes de aplicarlo.'
                  : 'Puedes agregar, reducir o retirar productos. Toda reduccion exige motivo.'
              }
            />
          ) : null}
          <div className="rounded-[8px] border border-[#303044] bg-[#0B0B0D] p-3 text-xs leading-relaxed text-[#9FA0AA]">
            En delivery, Counter controla salida y custodia. Master controla la entrega final al cliente.
          </div>
        </aside>
      </div>

      {paymentOpen && !isCancelled ? (
        <div className="border-t border-[#242433] p-5">
          <CounterPaymentEngine
            key={`${order.id}-${order.confirmedPaidUsd}-${order.balanceUsd}-${order.reports.pending}`}
            order={order}
            paymentAccounts={paymentAccounts}
            isWorking={isWorking}
            onSubmit={(input) => onCreatePaymentReport(order, input)}
          />
        </div>
      ) : null}

      {showRefundPanel ? (
        <div className="border-t border-[#242433] p-5">
          <CounterRefundPanel
            key={`${order.id}-${order.overpaidUsd}-${order.refundAuthorizations.map((item) => `${item.movementGroupId}:${item.status}`).join('|')}`}
            order={order}
            paymentAccounts={paymentAccounts}
            isWorking={isWorking}
            onRequest={(input) => onRequestRefund(order, input)}
            onExecute={(input) => onExecuteRefund(order, input)}
          />
        </div>
      ) : null}

      {addItemsOpen ? (
        <div className="border-t border-[#242433] p-5">
          <CounterPickupItemsEditor
            key={`${order.id}-${order.items.map((item) => `${item.id}:${item.qty}`).join('|')}`}
            order={order}
            products={quickSaleProducts}
            productComponents={quickSaleProductComponents}
            activeBsRate={activeBsRate}
            isWorking={isWorking}
            onSubmit={(input) => onChangePickupItems(order, input)}
          />
        </div>
      ) : null}
    </div>
  );
}

function CounterPendingPickupChange({
  request,
}: {
  request: CounterPickupChangeRequest;
}) {
  const changedExisting = request.preview.existingItems.filter(
    (item) => item.previousQty != null && Math.abs(item.qty - item.previousQty) > 0.0001
  );

  return (
    <div className="rounded-[8px] border border-violet-400/35 bg-violet-950/20 p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold text-violet-100">Cambio esperando autorizacion</h3>
          <p className="mt-1 text-sm text-violet-100/75">{request.reason}</p>
        </div>
        <span className="rounded-full border border-violet-300/40 bg-violet-300/10 px-3 py-1 text-xs font-semibold text-violet-100">
          Master
        </span>
      </div>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        {changedExisting.map((item) => (
          <div key={`existing-${item.itemId}`} className="rounded-[8px] border border-violet-300/20 bg-[#0B0B0D] px-3 py-2 text-xs">
            <span className="font-semibold text-[#F5F5F7]">{item.name}</span>
            <span className="ml-2 text-violet-100">
              x{qtyLabel(item.previousQty ?? 0)} → x{qtyLabel(item.qty)}
            </span>
          </div>
        ))}
        {request.preview.addedItems.map((item, index) => (
          <div key={`added-${item.productId}-${index}`} className="rounded-[8px] border border-violet-300/20 bg-[#0B0B0D] px-3 py-2 text-xs">
            <span className="font-semibold text-[#F5F5F7]">{item.name}</span>
            <span className="ml-2 text-emerald-200">+x{qtyLabel(item.qty)}</span>
          </div>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-violet-100/75">
        <span>Solicitado por {request.requestedByName}</span>
        <span>
          Nuevo total: {moneyUsd(request.preview.totalUsd)} · {moneyBs(request.preview.totalBs)}
        </span>
      </div>
    </div>
  );
}

function getCaracasTimeInput() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Caracas',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date());
  const hour = parts.find((part) => part.type === 'hour')?.value ?? '00';
  const minute = parts.find((part) => part.type === 'minute')?.value ?? '00';
  return `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`;
}

function scheduleTimeInput(value: string | null) {
  const normalized = String(value || '').trim();
  if (/^\d{2}:\d{2}$/.test(normalized)) return normalized;
  const match = normalized.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!match) return getCaracasTimeInput();
  let hour = Number(match[1]);
  const minute = match[2];
  const period = match[3].toUpperCase();
  if (period === 'AM' && hour === 12) hour = 0;
  if (period === 'PM' && hour !== 12) hour += 12;
  return `${String(hour).padStart(2, '0')}:${minute}`;
}

function CounterPickupScheduleBox({
  order,
  isWorking,
  onSubmit,
}: {
  order: CounterOrder;
  isWorking: boolean;
  onSubmit: (input: CounterPickupScheduleIntent) => Promise<CounterPickupScheduleResult>;
}) {
  const [scheduledDate, setScheduledDate] = useState(order.scheduledDate || getTodayKey());
  const [scheduledTime, setScheduledTime] = useState(scheduleTimeInput(order.scheduledTime));
  const [reason, setReason] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  async function submit(sendToKitchen: boolean) {
    if (!scheduledDate || !scheduledTime) {
      setLocalError('Indica la fecha y la hora correctas.');
      return;
    }
    if (reason.trim().length < 4) {
      setLocalError('Indica el motivo de la correccion.');
      return;
    }

    setLocalError(null);
    try {
      await onSubmit({
        idempotencyKey: crypto.randomUUID(),
        orderId: order.id,
        scheduledDate,
        scheduledTime,
        reason: reason.trim(),
        sendToKitchen,
      });
      setReason('');
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : 'No se pudo corregir la fecha.');
    }
  }

  return (
    <div className="rounded-[8px] border border-sky-400/25 bg-sky-950/15 p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold text-sky-100">Fecha y entrada a cocina</h3>
          <p className="mt-1 text-xs leading-relaxed text-sky-100/70">
            Corrige una agenda equivocada. El sistema deja motivo y avisa a cocina y asesor.
          </p>
        </div>
        <span className="rounded-full border border-sky-300/30 bg-sky-300/10 px-3 py-1 text-xs font-semibold text-sky-100">
          {order.status === 'created' ? 'Agendado' : 'En cocina'}
        </span>
      </div>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <label className="text-xs text-sky-100/75">
          Fecha
          <input
            type="date"
            value={scheduledDate}
            onChange={(event) => setScheduledDate(event.target.value)}
            className="mt-1 w-full rounded-[8px] border border-sky-300/25 bg-[#0B0B0D] px-3 py-2 text-sm text-[#F5F5F7] outline-none focus:border-sky-300"
          />
        </label>
        <label className="text-xs text-sky-100/75">
          Hora
          <input
            type="time"
            value={scheduledTime}
            onChange={(event) => setScheduledTime(event.target.value)}
            className="mt-1 w-full rounded-[8px] border border-sky-300/25 bg-[#0B0B0D] px-3 py-2 text-sm text-[#F5F5F7] outline-none focus:border-sky-300"
          />
        </label>
      </div>
      <label className="mt-2 block text-xs text-sky-100/75">
        Motivo
        <textarea
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          maxLength={1200}
          placeholder="Ej.: el cliente confirma que el pedido era para hoy."
          className="mt-1 min-h-16 w-full resize-y rounded-[8px] border border-sky-300/25 bg-[#0B0B0D] px-3 py-2 text-sm text-[#F5F5F7] outline-none placeholder:text-[#666878] focus:border-sky-300"
        />
      </label>
      {localError ? <div className="mt-2 text-xs font-semibold text-red-200">{localError}</div> : null}
      <div className={['mt-3 grid gap-2', ['created', 'queued'].includes(order.status) ? 'sm:grid-cols-2' : ''].join(' ')}>
        <button
          type="button"
          onClick={() => void submit(false)}
          disabled={isWorking}
          className="rounded-[8px] border border-sky-300/35 bg-[#0B0B0D] px-3 py-2 text-xs font-semibold text-sky-100 disabled:cursor-wait disabled:opacity-60"
        >
          Guardar correccion
        </button>
        {order.status === 'created' || order.status === 'queued' ? (
          <button
            type="button"
            onClick={() => void submit(true)}
            disabled={isWorking}
            className="rounded-[8px] border border-sky-300/50 bg-sky-300/15 px-3 py-2 text-xs font-bold text-sky-100 disabled:cursor-wait disabled:opacity-60"
          >
            Corregir y enviar a cocina
          </button>
        ) : null}
      </div>
    </div>
  );
}

function CounterPickupItemsEditor({
  order,
  products,
  productComponents,
  activeBsRate,
  isWorking,
  onSubmit,
}: {
  order: CounterOrder;
  products: CounterQuickSaleProductOption[];
  productComponents: CounterQuickSaleProductComponent[];
  activeBsRate: number;
  isWorking: boolean;
  onSubmit: (input: CounterPickupItemChangeIntent) => Promise<CounterPickupItemChangeResult>;
}) {
  const [productSearch, setProductSearch] = useState('');
  const [selectedProductId, setSelectedProductId] = useState('');
  const [qty, setQty] = useState('1');
  const [notes, setNotes] = useState('');
  const [cartItems, setCartItems] = useState<CounterQuickSaleCartItem[]>([]);
  const [existingQty, setExistingQty] = useState<Record<number, string>>(
    () => Object.fromEntries(order.items.map((item) => [item.id, String(item.qty)]))
  );
  const [reason, setReason] = useState('');
  const [configProductId, setConfigProductId] = useState<number | null>(null);
  const [configAlias, setConfigAlias] = useState('');
  const [configSelections, setConfigSelections] = useState<Array<{
    localId: string;
    componentProductId: number;
    componentName: string;
    qty: number;
  }>>([]);
  const [localError, setLocalError] = useState<string | null>(null);
  const productsById = useMemo(() => new Map(products.map((product) => [product.id, product])), [products]);
  const componentsByParentId = useMemo(() => {
    const map = new Map<number, CounterQuickSaleProductComponent[]>();
    for (const component of productComponents) {
      const current = map.get(component.parentProductId) ?? [];
      current.push(component);
      map.set(component.parentProductId, current);
    }
    return map;
  }, [productComponents]);
  const configProduct = configProductId ? productsById.get(configProductId) ?? null : null;
  const configComponents = configProductId ? componentsByParentId.get(configProductId) ?? [] : [];
  const configSelectableComponents = configComponents.filter(
    (component) => component.componentMode === 'selectable' || (component.componentMode === 'fixed' && !component.isRequired)
  );
  const configSelectedUnits = configSelections.reduce((sum, row) => {
    const component = configComponents.find((item) => item.componentProductId === row.componentProductId);
    return sum + (component?.countsTowardDetailLimit ? Number(row.qty || 0) : 0);
  }, 0);
  const filteredProducts = useMemo(() => {
    const term = productSearch.trim().toLocaleLowerCase('es-VE');
    if (!term) return products.slice(0, 80);
    return products
      .filter((product) =>
        [product.name, product.sku, product.type]
          .filter(Boolean)
          .some((value) => String(value).toLocaleLowerCase('es-VE').includes(term))
      )
      .slice(0, 80);
  }, [productSearch, products]);
  const lineRows = useMemo(() => {
    return cartItems.map((item) => {
      const product = productsById.get(item.productId) ?? null;
      const itemQty = Math.max(0, toDecimalInput(item.qty));
      const sourceAmount =
        product?.sourcePriceCurrency === 'VES'
          ? product.sourcePriceAmount || product.basePriceBs
          : product?.sourcePriceAmount || product?.basePriceUsd || 0;
      const snapshot = product
        ? calculateOrderLineSnapshot({
            sourceCurrency: product.sourcePriceCurrency,
            sourceAmount,
            quantity: itemQty,
            fxRate: activeBsRate,
            fallbackUnitUsd: product.basePriceUsd,
          })
        : { unitUsd: 0, lineUsd: 0, unitBs: 0, lineBs: 0 };

      return { item, product, qty: itemQty, snapshot };
    });
  }, [activeBsRate, cartItems, productsById]);
  const addedUsd = lineRows.reduce((sum, row) => sum + row.snapshot.lineUsd, 0);
  const addedBs = lineRows.reduce((sum, row) => sum + row.snapshot.lineBs, 0);
  const existingRows = order.items.map((item) => {
    const rawQty = String(existingQty[item.id] ?? '').trim();
    const parsedQty = toDecimalInput(rawQty);
    const isValid =
      rawQty.length > 0 &&
      Number.isFinite(parsedQty) &&
      parsedQty >= 0 &&
      parsedQty <= 999;
    const nextQty = isValid ? parsedQty : item.qty;
    const unitUsd = item.qty > 0 ? item.lineTotalUsd / item.qty : 0;
    const unitBs = item.qty > 0 ? item.lineTotalBs / item.qty : 0;
    return {
      item,
      nextQty,
      isValid,
      lineUsd: unitUsd * nextQty,
      lineBs: unitBs * nextQty,
    };
  });
  const hasInvalidExistingQty = existingRows.some((row) => !row.isValid);
  const hasExistingChange = existingRows.some((row) => Math.abs(row.nextQty - row.item.qty) > 0.0001);
  const hasReduction = existingRows.some((row) => row.nextQty < row.item.qty);
  const hasChanges = hasExistingChange || cartItems.length > 0;
  const estimatedSubtotalUsd = existingRows.reduce((sum, row) => sum + row.lineUsd, 0) + addedUsd;
  const estimatedSubtotalBs = existingRows.reduce((sum, row) => sum + row.lineBs, 0) + addedBs;

  function addLine() {
    const productId = Number(selectedProductId || 0);
    const product = productsById.get(productId);
    const productConfigComponents = componentsByParentId.get(productId) ?? [];
    const itemQty = toDecimalInput(qty);

    if (!product) {
      setLocalError('Selecciona un producto valido.');
      return;
    }
    if (!Number.isFinite(itemQty) || itemQty <= 0) {
      setLocalError('Indica una cantidad valida.');
      return;
    }

    if (product.isDetailEditable) {
      if (itemQty !== 1) {
        setLocalError('Los productos configurables se cargan uno por uno. Usa cantidad 1.');
        return;
      }

      const optionalFixedSelections = productConfigComponents
        .filter((component) => component.componentMode === 'fixed' && !component.isRequired && Number(component.quantity || 0) > 0)
        .map((component) => ({
          localId: `fixed-${component.componentProductId}`,
          componentProductId: component.componentProductId,
          componentName: component.componentName,
          qty: Number(component.quantity || 0),
        }));

      setConfigProductId(product.id);
      setConfigAlias('');
      setConfigSelections(optionalFixedSelections);
      setLocalError(null);
      return;
    }

    setCartItems((current) => [
      ...current,
      {
        id: `add-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        productId,
        qty,
        notes: notes.trim(),
        editableDetailLines: buildComponentDetailLines(productConfigComponents, {
          totalMultiplier: itemQty,
        }),
      },
    ]);
    setQty('1');
    setNotes('');
    setLocalError(null);
  }

  function setConfigSelectionQty(
    componentProductId: number,
    componentName: string,
    qtyValue: number
  ) {
    const safeQty = Math.max(0, Math.floor(Number(qtyValue || 0)));
    setConfigSelections((current) => {
      const others = current.filter((row) => row.componentProductId !== componentProductId);
      if (safeQty === 0) return others;
      return [
        ...others,
        {
          localId: String(componentProductId),
          componentProductId,
          componentName,
          qty: safeQty,
        },
      ];
    });
  }

  function closeProductConfig() {
    setConfigProductId(null);
    setConfigAlias('');
    setConfigSelections([]);
  }

  function confirmProductConfig() {
    if (!configProduct) return;

    const limit = Number(configProduct.detailUnitsLimit || 0);
    if (limit > 0 && configSelectedUnits !== limit) {
      setLocalError(`Debes seleccionar exactamente ${limit} piezas.`);
      return;
    }

    const selectedByProductId = new Map(
      configSelections
        .filter((row) => row.qty > 0)
        .map((row) => [row.componentProductId, row.qty] as const)
    );
    const detailLines: string[] = [];

    if (configAlias.trim()) {
      detailLines.push(`Para: ${configAlias.trim()}`);
    }

    detailLines.push(
      ...buildComponentDetailLines(configComponents, {
        selectedByProductId,
        includeMetadata: true,
      })
    );

    setCartItems((current) => [
      ...current,
      {
        id: `add-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        productId: configProduct.id,
        qty: '1',
        notes: notes.trim(),
        editableDetailLines: detailLines,
      },
    ]);
    setQty('1');
    setNotes('');
    closeProductConfig();
    setLocalError(null);
  }

  async function submitItems() {
    if (hasInvalidExistingQty) {
      setLocalError('Revisa las cantidades actuales. Deben estar entre 0 y 999.');
      return;
    }

    if (!hasChanges) {
      setLocalError('Modifica una cantidad o agrega al menos una linea.');
      return;
    }

    if (
      existingRows.every((row) => row.nextQty <= 0) &&
      cartItems.length === 0
    ) {
      setLocalError('El pedido debe conservar al menos un producto.');
      return;
    }

    if ((hasReduction || order.status === 'ready') && reason.trim().length < 4) {
      setLocalError(
        order.status === 'ready'
          ? 'Explica el cambio para que Master pueda autorizarlo.'
          : 'Indica el motivo de la reduccion o retiro.'
      );
      return;
    }

    setLocalError(null);
    try {
      await onSubmit({
        idempotencyKey: crypto.randomUUID(),
        orderId: order.id,
        existingItems: existingRows.map((row) => ({
          itemId: row.item.id,
          qty: row.nextQty,
        })),
        addedItems: cartItems.map((item) => ({
          productId: item.productId,
          qty: toDecimalInput(item.qty),
          notes: item.notes.trim() || null,
          editableDetailLines: item.editableDetailLines,
        })),
        reason: reason.trim() || null,
      });
      setCartItems([]);
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : 'No se pudo modificar el pickup.');
    }
  }

  return (
    <div className="rounded-[8px] border border-[#303044] bg-[#0B0B0D] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold">Modificar pickup</h3>
          <p className="mt-1 text-sm text-[#9FA0AA]">
            {order.status === 'ready'
              ? 'El pedido esta listo: el cambio se enviara a Master y no se aplicara hasta que lo autorice.'
              : 'Ajusta cantidades, retira lineas o agrega productos. El total se recalcula de forma atomica.'}
          </p>
        </div>
        <div className="rounded-[8px] border border-[#303044] bg-[#111118] px-3 py-2 text-right">
          <div className="text-xs text-[#9FA0AA]">Subtotal estimado</div>
          <div className="text-sm font-semibold text-[#F5F5F7]">{moneyUsd(estimatedSubtotalUsd)}</div>
          <div className="text-xs text-[#9FA0AA]">{moneyBs(estimatedSubtotalBs)}</div>
        </div>
      </div>

      {localError ? (
        <div className="mt-3 rounded-[8px] border border-red-400/40 bg-red-400/10 px-3 py-2 text-sm font-semibold text-red-200">
          {localError}
        </div>
      ) : null}

      <div className="mt-4 rounded-[8px] border border-[#242433] bg-[#111118] p-3">
        <div className="text-sm font-semibold text-[#F5F5F7]">Lineas actuales</div>
        <div className="mt-2 divide-y divide-[#242433]">
          {existingRows.map((row) => (
            <div key={row.item.id} className="grid gap-2 py-2 sm:grid-cols-[1fr_110px_92px] sm:items-center">
              <div>
                <div className="text-sm font-semibold">{row.item.name}</div>
                <div className="mt-0.5 text-xs text-[#9FA0AA]">
                  Antes: x{qtyLabel(row.item.qty)} · Ahora: {moneyUsd(row.lineUsd)}
                </div>
              </div>
              <input
                value={existingQty[row.item.id] ?? ''}
                onChange={(event) =>
                  setExistingQty((current) => ({ ...current, [row.item.id]: event.target.value }))
                }
                inputMode="decimal"
                aria-label={`Cantidad de ${row.item.name}`}
                className="w-full rounded-[8px] border border-[#303044] bg-[#0B0B0D] px-3 py-2 text-right text-sm text-[#F5F5F7] outline-none focus:border-[#FEEF00]/70"
              />
              <button
                type="button"
                onClick={() =>
                  setExistingQty((current) => ({ ...current, [row.item.id]: '0' }))
                }
                className="rounded-[8px] border border-red-400/40 px-3 py-2 text-xs font-semibold text-red-200 transition hover:bg-red-400/10"
              >
                Retirar
              </button>
            </div>
          ))}
        </div>
      </div>

      <div className="mt-4 text-sm font-semibold text-[#F5F5F7]">Agregar productos</div>
      <div className="mt-2 grid gap-3 lg:grid-cols-[1fr_110px_1fr_130px]">
        <label className="text-sm text-[#9FA0AA]">
          Producto
          <input
            value={productSearch}
            onChange={(event) => setProductSearch(event.target.value)}
            placeholder="Buscar producto"
            className="mt-1 w-full rounded-[8px] border border-[#303044] bg-[#111118] px-3 py-3 text-[#F5F5F7] outline-none placeholder:text-[#666878] focus:border-[#FEEF00]/70"
          />
          <select
            value={selectedProductId}
            onChange={(event) => setSelectedProductId(event.target.value)}
            className="mt-2 w-full rounded-[8px] border border-[#303044] bg-[#111118] px-3 py-3 text-[#F5F5F7] outline-none focus:border-[#FEEF00]/70"
          >
            {filteredProducts.map((product) => (
              <option key={product.id} value={product.id}>
                {product.name}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm text-[#9FA0AA]">
          Cant.
          <input
            value={qty}
            onChange={(event) => setQty(event.target.value)}
            inputMode="decimal"
            className="mt-1 w-full rounded-[8px] border border-[#303044] bg-[#111118] px-3 py-3 text-[#F5F5F7] outline-none focus:border-[#FEEF00]/70"
          />
        </label>
        <label className="text-sm text-[#9FA0AA]">
          Nota
          <input
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            placeholder="Opcional"
            className="mt-1 w-full rounded-[8px] border border-[#303044] bg-[#111118] px-3 py-3 text-[#F5F5F7] outline-none placeholder:text-[#666878] focus:border-[#FEEF00]/70"
          />
        </label>
        <div className="flex items-end">
          <button
            type="button"
            onClick={addLine}
            disabled={products.length === 0}
            className="w-full rounded-[8px] border border-[#303044] bg-[#111118] px-4 py-3 text-sm font-semibold text-[#F5F5F7] transition hover:border-[#FEEF00]/60 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Agregar
          </button>
        </div>
      </div>

      {configProduct ? (
        <div className="mt-4 space-y-3 rounded-[8px] border border-[#FEEF00]/40 bg-[#181807] p-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <div className="text-sm font-semibold text-[#F5F5F7]">Armar {configProduct.name}</div>
              <div className="mt-1 text-xs text-[#B9B9A8]">
                {configProduct.detailUnitsLimit > 0
                  ? `${configSelectedUnits}/${configProduct.detailUnitsLimit} piezas seleccionadas`
                  : `${configSelectedUnits} piezas seleccionadas`}
              </div>
            </div>
            <button
              type="button"
              onClick={closeProductConfig}
              className="rounded-full border border-[#303044] bg-[#0B0B0D] px-3 py-1 text-xs font-semibold text-[#F5F5F7]"
            >
              Cerrar
            </button>
          </div>
          <input
            value={configAlias}
            onChange={(event) => setConfigAlias(event.target.value)}
            placeholder="Para / nombre dentro del pedido (opcional)"
            className="w-full rounded-[8px] border border-[#303044] bg-[#0B0B0D] px-3 py-2 text-sm text-[#F5F5F7] outline-none placeholder:text-[#666878] focus:border-[#FEEF00]/70"
          />
          <div className="grid gap-2 md:grid-cols-2">
            {configSelectableComponents.map((component) => {
              const currentQty =
                configSelections.find((row) => row.componentProductId === component.componentProductId)?.qty ?? 0;

              return (
                <label
                  key={component.componentProductId}
                  className="rounded-[8px] border border-[#303044] bg-[#0B0B0D] p-2 text-sm text-[#F5F5F7]"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold">{component.componentName}</span>
                    <input
                      value={currentQty ? String(currentQty) : ''}
                      onChange={(event) =>
                        setConfigSelectionQty(
                          component.componentProductId,
                          component.componentName,
                          Number(event.target.value || 0)
                        )
                      }
                      inputMode="numeric"
                      className="h-9 w-20 rounded-[8px] border border-[#303044] bg-[#111118] px-2 text-right text-sm outline-none focus:border-[#FEEF00]/70"
                    />
                  </div>
                  <div className="mt-1 text-[11px] text-[#9FA0AA]">
                    {component.componentMode === 'fixed' ? 'Fijo opcional' : 'Seleccionable'}
                    {component.countsTowardDetailLimit ? ' · cuenta para limite' : ''}
                  </div>
                </label>
              );
            })}
          </div>
          <button
            type="button"
            onClick={confirmProductConfig}
            className="w-full rounded-[8px] border border-[#FEEF00]/70 bg-[#FEEF00] px-4 py-2 text-sm font-bold text-black transition hover:bg-[#fff45c]"
          >
            Guardar armado
          </button>
        </div>
      ) : null}

      <div className="mt-4 divide-y divide-[#242433] rounded-[8px] border border-[#242433]">
        {lineRows.length === 0 ? (
          <div className="p-4 text-sm text-[#9FA0AA]">Sin lineas por agregar.</div>
        ) : (
          lineRows.map((row) => (
            <div key={row.item.id} className="grid gap-3 p-3 sm:grid-cols-[70px_1fr_110px_90px]">
              <div className="text-sm font-semibold text-[#FEEF00]">x{qtyLabel(row.qty)}</div>
              <div>
                <div className="text-sm font-semibold">{row.product?.name || 'Producto'}</div>
                {row.item.notes ? <div className="mt-1 text-xs text-[#9FA0AA]">{row.item.notes}</div> : null}
                {getVisibleEditableDetailLines(row.item.editableDetailLines).length > 0 ? (
                  <ul className="mt-1 space-y-0.5 text-xs text-[#C7C8D1]">
                    {getVisibleEditableDetailLines(row.item.editableDetailLines).map((detail, detailIdx) => (
                      <li key={`${row.item.id}-${detailIdx}`}>• {detail}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
              <div className="text-sm font-semibold">{moneyUsd(row.snapshot.lineUsd)}</div>
              <button
                type="button"
                onClick={() => setCartItems((current) => current.filter((item) => item.id !== row.item.id))}
                className="rounded-[8px] border border-red-400/40 px-3 py-2 text-sm font-semibold text-red-200 transition hover:bg-red-400/10"
              >
                Quitar
              </button>
            </div>
          ))
        )}
      </div>

      <label className="mt-4 block text-sm text-[#9FA0AA]">
        Motivo {hasReduction || order.status === 'ready' ? '(obligatorio)' : '(opcional)'}
        <textarea
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          maxLength={1200}
          placeholder={
            order.status === 'ready'
              ? 'Explica que solicito el cliente para que Master pueda decidir.'
              : 'Ej.: cliente retiro una unidad del pedido.'
          }
          className="mt-1 min-h-20 w-full resize-y rounded-[8px] border border-[#303044] bg-[#111118] px-3 py-3 text-[#F5F5F7] outline-none placeholder:text-[#666878] focus:border-[#FEEF00]/70"
        />
      </label>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm text-[#9FA0AA]">
          {order.status === 'ready'
            ? `Orden #${order.displayNumber}: Master vera el cambio antes de aplicarlo.`
            : `Orden #${order.displayNumber}: el saldo financiero se recalculara al confirmar.`}
        </div>
        <button
          type="button"
          onClick={() => void submitItems()}
          disabled={isWorking || !hasChanges || activeBsRate <= 0}
          className="rounded-[8px] border border-[#FEEF00]/70 bg-[#FEEF00] px-5 py-3 text-sm font-bold text-black transition hover:bg-[#fff45c] disabled:cursor-wait disabled:opacity-60"
        >
          {isWorking
            ? 'Guardando...'
            : order.status === 'ready'
              ? 'Solicitar autorizacion'
              : 'Aplicar modificacion'}
        </button>
      </div>
    </div>
  );
}

function CounterWorkflowChecklist({
  items,
}: {
  items: Array<{
    label: string;
    detail: string;
    state: 'done' | 'current' | 'blocked' | 'pending';
  }>;
}) {
  const stateClass = {
    done: 'border-emerald-400/30 bg-emerald-400/10 text-emerald-100',
    current: 'border-[#FEEF00]/50 bg-[#FEEF00]/10 text-[#FEEF00]',
    blocked: 'border-orange-400/35 bg-orange-950/20 text-orange-100',
    pending: 'border-[#303044] bg-[#0B0B0D] text-[#9FA0AA]',
  };
  const dotClass = {
    done: 'bg-emerald-300',
    current: 'bg-[#FEEF00]',
    blocked: 'bg-orange-300',
    pending: 'bg-[#666878]',
  };

  return (
    <div className="grid gap-1.5">
      {items.map((item) => (
        <div
          key={item.label}
          className={['rounded-[8px] border px-2.5 py-1.5', stateClass[item.state]].join(' ')}
        >
          <div className="flex items-center justify-between gap-2">
            <span className="flex min-w-0 items-center gap-2">
              <span className={['h-2 w-2 shrink-0 rounded-full', dotClass[item.state]].join(' ')} />
              <span className="truncate text-[10px] font-semibold uppercase tracking-[0.12em]">{item.label}</span>
            </span>
            <span className="truncate text-xs font-semibold text-[#F5F5F7]">{item.detail}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function Metric({
  label,
  value,
  note,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  note?: string;
  tone?: 'neutral' | 'good' | 'warn';
}) {
  const toneClass =
    tone === 'good' ? 'text-emerald-300' : tone === 'warn' ? 'text-orange-300' : 'text-[#F5F5F7]';

  return (
    <div className="rounded-[8px] border border-[#242433] bg-[#0B0B0D] p-3">
      <div className="text-xs text-[#9FA0AA]">{label}</div>
      <div className={['mt-1 text-base font-semibold', toneClass].join(' ')}>{value}</div>
      {note ? <div className="mt-1 text-xs text-[#9FA0AA]">{note}</div> : null}
    </div>
  );
}

function CurrentActionCard({
  action,
}: {
  action: ReturnType<typeof getCounterCurrentAction>;
}) {
  const toneClass =
    action.tone === 'good'
      ? 'border-emerald-400/30 bg-emerald-400/10'
      : action.tone === 'warn'
        ? 'border-orange-400/35 bg-orange-950/20'
        : 'border-sky-400/25 bg-sky-950/15';
  const badgeClass =
    action.tone === 'good'
      ? 'border-emerald-300/40 bg-emerald-300/10 text-emerald-100'
      : action.tone === 'warn'
        ? 'border-orange-300/40 bg-orange-300/10 text-orange-100'
        : 'border-sky-300/30 bg-sky-300/10 text-sky-100';

  return (
    <div className={['rounded-[8px] border px-3 py-2', toneClass].join(' ')}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#9FA0AA]">Accion actual</div>
          <h3 className="mt-1 text-sm font-semibold leading-tight text-[#F5F5F7]">{action.title}</h3>
          <p className="mt-1 text-xs leading-snug text-[#C7C8D1]">{action.description}</p>
        </div>
        <span className={['shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-semibold', badgeClass].join(' ')}>
          {action.tone === 'good' ? 'Listo' : action.tone === 'warn' ? 'Atencion' : 'Seguimiento'}
        </span>
      </div>
    </div>
  );
}

function ActionHint({
  title,
  text,
  tone = 'neutral',
}: {
  title: string;
  text: string;
  tone?: 'neutral' | 'warn';
}) {
  const toneClass =
    tone === 'warn'
      ? 'border-orange-300/30 bg-orange-950/20 text-orange-100'
      : 'border-[#303044] bg-[#0B0B0D] text-[#C7C8D1]';

  return (
    <div className={['rounded-[8px] border p-3 text-xs leading-relaxed', toneClass].join(' ')}>
      <div className="text-sm font-semibold text-[#F5F5F7]">{title}</div>
      <div className="mt-1">{text}</div>
    </div>
  );
}
