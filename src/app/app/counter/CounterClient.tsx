'use client';

import { useEffect, useMemo, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { getOperationalStatusLabel, getPaymentMethodLabel } from '@/lib/orders/order-labels';
import {
  buildComponentDetailLines,
  getVisibleEditableDetailLines,
  type OrderComposerProductComponent,
} from '@/lib/orders/order-composer';
import { getPaymentReportRequirements, validatePaymentReportDetails } from '@/lib/payments/payment-report-rules';
import { calculateOrderLineSnapshot, calculateOrderTotalsSnapshot } from '@/lib/pricing/order-snapshots';
import { ModulePreference } from '../ModulePreference';
import {
  confirmPaymentReportAction,
  createPaymentReportAction,
  markDeliveredAction,
  outForDeliveryAction,
} from '../master/dashboard/actions';
import {
  addCounterOrderItemsAction,
  createCounterCashMovementAction,
  createCounterQuickSaleAction,
  searchCounterClientsAction,
  searchCounterAgendaAction,
  type CounterAgendaSearchResult,
  type CounterClientSearchResult,
} from './actions';

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
  status: 'created' | 'confirmed' | 'in_kitchen' | 'ready' | 'out_for_delivery';
  source: string | null;
  isCounterSale: boolean;
  isCounterScheduled: boolean;
  fulfillment: 'pickup' | 'delivery';
  clientName: string;
  clientPhone: string | null;
  advisorName: string | null;
  deliveryAddress: string | null;
  deliveryMode: string | null;
  deliveryAssigneeKind: 'internal' | 'external' | null;
  deliveryAssigneeName: string | null;
  externalReference: string | null;
  notes: string | null;
  createdAt: string;
  readyAt: string | null;
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
  reports: {
    pending: number;
    confirmed: number;
    rejected: number;
  };
  items: CounterOrderItem[];
};

type CounterClientProps = {
  fullName: string;
  orders: CounterOrder[];
  paymentAccounts: CounterPaymentAccountOption[];
  cashAccounts: CounterCashAccountSummary[];
  quickSaleProducts: CounterQuickSaleProductOption[];
  quickSaleProductComponents: CounterQuickSaleProductComponent[];
  activeBsRate: number;
};

type CounterPaymentReportInput = {
  paymentLines: Array<{
    accountKey: string;
    amount: string;
    exchangeRate: string;
    operationDate: string;
    referenceCode: string;
    bankName: string;
    payerName: string;
    notes: string;
  }>;
  overpaymentHandling: 'store_fund' | 'change_given';
  changeLines: Array<{
    accountKey: string;
    amount: string;
    exchangeRate: string;
  }>;
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

type CounterPaymentLineDraft = {
  id: string;
  accountKey: string;
  amount: string;
  exchangeRate: string;
  operationDate: string;
  referenceCode: string;
  bankName: string;
  payerName: string;
  notes: string;
};

type CounterChangeLineDraft = {
  id: string;
  accountKey: string;
  amount: string;
  exchangeRate: string;
};

type CounterQuickSaleCartItem = {
  id: string;
  productId: number;
  qty: string;
  notes: string;
  editableDetailLines: string[];
};

type CounterFilter =
  | 'now'
  | 'all'
  | 'agenda'
  | 'kitchen'
  | 'pickup'
  | 'delivery'
  | 'route'
  | 'change'
  | 'pending'
  | 'paid';

const FILTERS: Array<{ key: CounterFilter; label: string }> = [
  { key: 'now', label: 'Ahora' },
  { key: 'all', label: 'Todos' },
  { key: 'agenda', label: 'Agenda' },
  { key: 'kitchen', label: 'En cocina' },
  { key: 'pickup', label: 'Pickup' },
  { key: 'delivery', label: 'Delivery' },
  { key: 'route', label: 'En camino' },
  { key: 'change', label: 'Con cambio' },
  { key: 'pending', label: 'Por cobrar' },
  { key: 'paid', label: 'Pagados' },
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

function getTodayKey() {
  return new Date().toLocaleDateString('en-CA', {
    timeZone: 'America/Caracas',
  });
}

function paymentAccountKey(account: CounterPaymentAccountOption) {
  return `${account.accountId}|${account.paymentMethodCode}`;
}

function toDecimalInput(value: string) {
  return Number(String(value || '').replace(',', '.'));
}

function getPaymentAmountUsd(amount: number, account: CounterPaymentAccountOption, exchangeRate: number | null) {
  return account.currencyCode === 'VES' ? amount / Number(exchangeRate || 0) : amount;
}

function canUseAccountForChange(account: CounterPaymentAccountOption) {
  return account.canConfirmPayment || account.autoConfirmsReport;
}

function paymentLabel(order: CounterOrder) {
  if (order.balanceUsd <= 0.005) return 'Pagado';
  if (order.confirmedPaidUsd > 0.005) return 'Abonado';
  if (order.reports.pending > 0) return 'Pago por revisar';
  return 'Pendiente';
}

function paymentClass(order: CounterOrder) {
  if (order.balanceUsd <= 0.005) return 'border-emerald-400/40 bg-emerald-400/10 text-emerald-200';
  if (order.reports.pending > 0) return 'border-[#FEEF00]/50 bg-[#FEEF00]/10 text-[#FEEF00]';
  if (order.confirmedPaidUsd > 0.005) return 'border-sky-400/40 bg-sky-400/10 text-sky-200';
  return 'border-orange-400/40 bg-orange-400/10 text-orange-200';
}

function isCounterImmediatePaymentMethod(method: string | null | undefined) {
  const normalized = String(method || '').trim();
  return normalized === 'pos' || normalized === 'cash_usd' || normalized === 'cash_ves';
}

function mustSettleBeforeCounterDelivery(order: CounterOrder) {
  return isCounterImmediatePaymentMethod(order.paymentMethod) && order.balanceUsd > 0.005;
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
  if (order.status === 'out_for_delivery') return 'border-sky-400/40 bg-sky-400/10 text-sky-200';
  if (order.status === 'in_kitchen') return 'border-emerald-400/40 bg-emerald-400/10 text-emerald-200';
  if (order.status === 'created') return 'border-purple-300/40 bg-purple-300/10 text-purple-100';
  if (order.status === 'confirmed') return 'border-orange-400/40 bg-orange-400/10 text-orange-200';
  return 'border-[#FEEF00]/50 bg-[#FEEF00]/10 text-[#FEEF00]';
}

function primaryCounterActionLabel(order: CounterOrder) {
  if (order.status === 'created') return 'Pendiente master';
  if (order.status === 'confirmed') return 'En cola de cocina';
  if (order.status === 'in_kitchen') return 'En preparacion';
  if (order.fulfillment === 'pickup' && order.status === 'ready' && mustSettleBeforeCounterDelivery(order)) return 'Primero cobrar';
  if (order.fulfillment === 'delivery' && order.status === 'ready') return 'Entregar a motorizado';
  if (order.fulfillment === 'delivery' && order.status === 'out_for_delivery') return 'Marcar entregada';
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

function agendaSearchStatusLabel(status: CounterAgendaSearchResult['status']) {
  if (status === 'created') return 'Agendado / pendiente master';
  if (status === 'confirmed') return 'En cola de cocina';
  if (status === 'in_kitchen') return 'En preparacion';
  if (status === 'ready') return 'Listo';
  if (status === 'out_for_delivery') return 'En camino';
  return status;
}

function agendaSearchReason(result: CounterAgendaSearchResult) {
  if (result.status === 'created') return 'Master aun no lo ha enviado a cocina.';
  if (result.status === 'confirmed') return 'Ya esta enviado a cocina; falta que lo tomen.';
  if (result.status === 'in_kitchen') return 'Cocina lo esta preparando.';
  if (result.status === 'ready') return 'Ya esta listo para entrega.';
  if (result.status === 'out_for_delivery') return 'Ya fue entregado al motorizado.';
  return null;
}

export default function CounterClient({
  fullName,
  orders,
  paymentAccounts,
  cashAccounts,
  quickSaleProducts,
  quickSaleProductComponents,
  activeBsRate,
}: CounterClientProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [workingOrderId, setWorkingOrderId] = useState<number | null>(null);
  const [message, setMessage] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const [localOrders, setLocalOrders] = useState(orders);
  const [filter, setFilter] = useState<CounterFilter>('now');
  const [search, setSearch] = useState('');
  const [selectedOrderId, setSelectedOrderId] = useState<number | null>(null);
  const [quickSaleOpen, setQuickSaleOpen] = useState(false);
  const [cashPanelOpen, setCashPanelOpen] = useState(false);
  const [masterAgendaSearch, setMasterAgendaSearch] = useState('');
  const [masterAgendaResults, setMasterAgendaResults] = useState<CounterAgendaSearchResult[]>([]);
  const [masterAgendaSearched, setMasterAgendaSearched] = useState(false);
  const [masterAgendaOpen, setMasterAgendaOpen] = useState(false);

  useEffect(() => {
    setLocalOrders(orders);
    setSelectedOrderId((current) =>
      current != null && orders.some((order) => order.id === current) ? current : null
    );
  }, [orders]);

  const filterCounts = useMemo<Record<CounterFilter, number>>(() => {
    return {
      now: localOrders.filter(isCounterActionableOrder).length,
      all: localOrders.length,
      agenda: localOrders.filter(isCounterAgendaOrder).length,
      kitchen: localOrders.filter(isKitchenFollowUpOrder).length,
      pickup: localOrders.filter((order) => order.fulfillment === 'pickup').length,
      delivery: localOrders.filter((order) => order.fulfillment === 'delivery').length,
      route: localOrders.filter((order) => order.status === 'out_for_delivery').length,
      change: localOrders.filter((order) => order.paymentRequiresChange).length,
      pending: localOrders.filter((order) => order.balanceUsd > 0.005).length,
      paid: localOrders.filter((order) => order.balanceUsd <= 0.005).length,
    };
  }, [localOrders]);

  const filteredOrders = useMemo(() => {
    const term = search.trim().toLocaleLowerCase('es-VE');

    return sortCounterOrders(localOrders.filter((order) => {
      if (filter === 'now' && !isCounterActionableOrder(order)) return false;
      if (filter === 'pickup' && order.fulfillment !== 'pickup') return false;
      if (filter === 'agenda' && !isCounterAgendaOrder(order)) return false;
      if (filter === 'kitchen' && !isKitchenFollowUpOrder(order)) return false;
      if (filter === 'delivery' && order.fulfillment !== 'delivery') return false;
      if (filter === 'route' && order.status !== 'out_for_delivery') return false;
      if (filter === 'change' && !order.paymentRequiresChange) return false;
      if (filter === 'pending' && order.balanceUsd <= 0.005) return false;
      if (filter === 'paid' && order.balanceUsd > 0.005) return false;

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
    : localOrders.find((order) => order.id === selectedOrderId) ?? null;
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

    if (filter !== 'all') {
      const filterLabel = FILTERS.find((item) => item.key === filter)?.label ?? 'Resultados';
      return [
        {
          key: `filter-${filter}`,
          title: filterLabel,
          helper: 'Pedidos que coinciden con el filtro actual.',
          orders: filteredOrders,
        },
      ];
    }

    return [
      ...actionableSections,
      {
        key: 'kitchen-follow-up',
        title: 'Seguimiento cocina',
        helper: 'Pedidos enviados a cocina, en cola o preparacion.',
        orders: filteredOrders.filter(isKitchenFollowUpOrder),
      },
      {
        key: 'counter-agenda',
        title: 'Agenda mostrador',
        helper: 'Pedidos agendados por mostrador, pendientes de master.',
        orders: filteredOrders.filter(isCounterAgendaOrder),
      },
    ].filter((section) => section.orders.length > 0);
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

  function handlePrimaryDeliveryAction(order: CounterOrder) {
    setMessage(null);
    setWorkingOrderId(order.id);
    startTransition(async () => {
      try {
        if (order.fulfillment === 'delivery' && order.status === 'ready') {
          await outForDeliveryAction({ orderId: order.id });
          updateLocalOrderStatus(order.id, 'out_for_delivery');
          setMessage({ tone: 'success', text: `Orden #${order.displayNumber} enviada a delivery.` });
        } else {
          await markDeliveredAction({ orderId: order.id });
          completeLocalOrder(order.id);
          setMessage({
            tone: 'success',
            text:
              order.fulfillment === 'pickup'
                ? `Orden #${order.displayNumber} retirada por el cliente.`
                : `Orden #${order.displayNumber} marcada como entregada.`,
          });
        }
        router.refresh();
      } catch (error) {
        setMessage({
          tone: 'error',
          text: error instanceof Error ? error.message : 'No se pudo completar la accion.',
        });
      } finally {
        setWorkingOrderId(null);
      }
    });
  }

  function handleCreatePaymentReport(order: CounterOrder, input: CounterPaymentReportInput) {
    const preparedPayments = input.paymentLines
      .map((line) => {
        const account = paymentAccounts.find((item) => paymentAccountKey(item) === line.accountKey) ?? null;
        const amount = toDecimalInput(line.amount);
        const exchangeRate =
          account?.currencyCode === 'VES' ? toDecimalInput(line.exchangeRate) : null;
        const amountUsd =
          account && Number.isFinite(amount) && amount > 0
            ? getPaymentAmountUsd(amount, account, exchangeRate)
            : 0;

        return {
          account,
          amount,
          exchangeRate,
          amountUsd,
          operationDate: line.operationDate || getTodayKey(),
          referenceCode: line.referenceCode.trim(),
          bankName: line.bankName.trim(),
          payerName: line.payerName.trim(),
          notes: line.notes.trim(),
        };
      })
      .filter((line) => line.account && Number.isFinite(line.amount) && line.amount > 0) as Array<{
        account: CounterPaymentAccountOption;
        amount: number;
        exchangeRate: number | null;
        amountUsd: number;
        operationDate: string;
        referenceCode: string;
        bankName: string;
        payerName: string;
        notes: string;
      }>;

    if (preparedPayments.length === 0) {
      setMessage({ tone: 'error', text: 'Agrega al menos una linea de pago valida.' });
      return;
    }

    if (preparedPayments.some((line) => !line.account.canReportPayment)) {
      setMessage({ tone: 'error', text: 'Una de las cuentas no esta autorizada para reportar pagos.' });
      return;
    }

    if (
      preparedPayments.some(
        (line) =>
          line.account.currencyCode === 'VES' &&
          (!line.exchangeRate || !Number.isFinite(line.exchangeRate) || line.exchangeRate <= 0)
      )
    ) {
      setMessage({ tone: 'error', text: 'Indica una tasa valida para cada pago en bolivares.' });
      return;
    }

    for (const payment of preparedPayments) {
      const validationError = validatePaymentReportDetails({
        method: payment.account.paymentMethodCode,
        operationDate: payment.operationDate,
        referenceCode: payment.referenceCode,
        bankName: payment.bankName,
        holderName: payment.payerName,
      });

      if (validationError) {
        setMessage({ tone: 'error', text: validationError });
        return;
      }
    }

    const autoConfirmedUsd = preparedPayments.reduce(
      (sum, line) => sum + (line.account.autoConfirmsReport ? line.amountUsd : 0),
      0
    );
    const hasOverpayment = autoConfirmedUsd > order.balanceUsd + 0.005;
    const preparedChangeLines: Array<{
      account: CounterPaymentAccountOption;
      amount: number;
      exchangeRate: number | null;
    }> = [];

    if (hasOverpayment && input.overpaymentHandling === 'change_given') {
      const inputChangeLines = input.changeLines
        .map((line) => {
          const changeAccount =
            paymentAccounts.find((item) => paymentAccountKey(item) === line.accountKey) ?? null;
          const changeAmount = toDecimalInput(line.amount);
          const changeExchangeRate =
            changeAccount?.currencyCode === 'VES' ? toDecimalInput(line.exchangeRate) : null;

          return {
            account: changeAccount,
            amount: changeAmount,
            exchangeRate: changeExchangeRate,
          };
        })
        .filter((line) => line.account && Number.isFinite(line.amount) && line.amount > 0) as Array<{
          account: CounterPaymentAccountOption;
          amount: number;
          exchangeRate: number | null;
        }>;

      if (inputChangeLines.length === 0) {
        setMessage({ tone: 'error', text: 'Agrega al menos una linea para entregar cambio.' });
        return;
      }

      if (inputChangeLines.some((line) => !canUseAccountForChange(line.account))) {
        setMessage({ tone: 'error', text: 'Una de las cuentas no esta autorizada para entregar cambio.' });
        return;
      }

      if (
        inputChangeLines.some(
          (line) =>
            line.account.currencyCode === 'VES' &&
            (!line.exchangeRate || !Number.isFinite(line.exchangeRate) || line.exchangeRate <= 0)
        )
      ) {
        setMessage({ tone: 'error', text: 'Indica una tasa valida para cada cambio en bolivares.' });
        return;
      }

      preparedChangeLines.push(...inputChangeLines);
    }

    setMessage(null);
    setWorkingOrderId(order.id);
    startTransition(async () => {
      try {
        let runningAutoUsd = 0;
        let changeWasApplied = false;
        let confirmedCount = 0;

        for (const payment of preparedPayments) {
          const result = await createPaymentReportAction({
            orderId: order.id,
            reportedMoneyAccountId: payment.account.accountId,
            reportedCurrency: payment.account.currencyCode,
            reportedAmount: payment.amount,
            reportedExchangeRateVesPerUsd: payment.exchangeRate,
            paymentMethod: payment.account.paymentMethodCode,
            operationDate: payment.operationDate,
            referenceCode: payment.referenceCode || null,
            bankName: payment.bankName || null,
            payerName: payment.payerName || null,
            notes: payment.notes || null,
          });

          if (!payment.account.autoConfirmsReport) continue;

          const reportId = Number(result?.reportId || 0);
          if (!Number.isFinite(reportId) || reportId <= 0) {
            throw new Error('No se pudo identificar el reporte para confirmar.');
          }

          const nextAutoUsd = runningAutoUsd + payment.amountUsd;
          const lineCreatesOverpayment = nextAutoUsd > order.balanceUsd + 0.005;
          const shouldApplyChange =
            lineCreatesOverpayment &&
            input.overpaymentHandling === 'change_given' &&
            !changeWasApplied;
          const overpaymentHandling =
            lineCreatesOverpayment
              ? shouldApplyChange
                ? 'change_given'
                : 'store_fund'
              : null;

          await confirmPaymentReportAction({
            reportId,
            orderId: order.id,
            confirmedMoneyAccountId: payment.account.accountId,
            confirmedCurrency: payment.account.currencyCode,
            confirmedAmount: payment.amount,
            movementDate: payment.operationDate,
            confirmedExchangeRateVesPerUsd: payment.exchangeRate,
            reviewNotes: 'Auto confirmado por mostrador.',
            referenceCode: payment.referenceCode || null,
            counterpartyName: order.clientName,
            description: `Pago mostrador orden ${order.displayNumber}`,
            overpaymentHandling,
            overpaymentNotes: payment.notes || null,
            changeLines:
              shouldApplyChange
                ? preparedChangeLines.map((line) => ({
                    moneyAccountId: line.account.accountId,
                    currencyCode: line.account.currencyCode,
                    amount: line.amount,
                    exchangeRateVesPerUsd: line.exchangeRate,
                    notes: payment.notes || null,
                  }))
                : undefined,
          });

          if (shouldApplyChange) changeWasApplied = true;
          runningAutoUsd = nextAutoUsd;
          confirmedCount += 1;
        }

        const pendingCount = preparedPayments.length - confirmedCount;
        setMessage({
          tone: 'success',
          text:
            pendingCount > 0
              ? `${preparedPayments.length} pago(s) registrados en orden #${order.displayNumber}. ${pendingCount} quedan por revision.`
              : `${preparedPayments.length} pago(s) registrados y confirmados en orden #${order.displayNumber}.`,
        });
        router.refresh();
      } catch (error) {
        setMessage({
          tone: 'error',
          text: error instanceof Error ? error.message : 'No se pudo reportar el pago.',
        });
      } finally {
        setWorkingOrderId(null);
      }
    });
  }

  function handleCreateQuickSale(input: {
    clientId?: number | null;
    clientName: string;
    clientPhone: string;
    clientType?: 'own' | 'assigned' | 'legacy';
    fulfillment: 'pickup' | 'delivery';
    deliveryAddress: string;
    note: string;
    scheduleAsap: boolean;
    scheduledDate: string;
    scheduledTime: string;
    paymentMethod: string;
    paymentCurrency: 'USD' | 'VES';
    paymentRequiresChange: boolean;
    paymentChangeFor: string;
    paymentChangeCurrency: 'USD' | 'VES';
    paymentNote: string;
    discountEnabled?: boolean;
    discountPct?: string | number | null;
    hasDeliveryNote?: boolean;
    hasInvoice?: boolean;
    invoiceTaxPct?: string | number | null;
    items: Array<{ productId: number; qty: number; notes?: string | null; editableDetailLines?: string[] | null }>;
  }) {
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
        router.refresh();
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

  function handleAddItemsToOrder(
    order: CounterOrder,
    items: Array<{ productId: number; qty: number; notes?: string | null; editableDetailLines?: string[] | null }>
  ) {
    setMessage(null);
    setWorkingOrderId(order.id);
    startTransition(async () => {
      try {
        const result = await addCounterOrderItemsAction({ orderId: order.id, items });
        setMessage({
          tone: 'success',
          text: result.returnedToKitchen
            ? `Se agregaron ${result.addedLines} linea(s). La orden #${order.displayNumber} regreso a cocina.`
            : `Se agregaron ${result.addedLines} linea(s) a la orden #${order.displayNumber}.`,
        });
        router.refresh();
      } catch (error) {
        setMessage({
          tone: 'error',
          text: error instanceof Error ? error.message : 'No se pudieron agregar productos.',
        });
      } finally {
        setWorkingOrderId(null);
      }
    });
  }

  function handleMasterAgendaSearch() {
    const query = masterAgendaSearch.trim();
    if (query.length < 2) {
      setMessage({ tone: 'error', text: 'Escribe al menos 2 caracteres para buscar en agenda.' });
      return;
    }

    setMessage(null);
    setMasterAgendaSearched(true);
    startTransition(async () => {
      try {
        const results = await searchCounterAgendaAction({ query });
        setMasterAgendaResults(results);
      } catch (error) {
        setMasterAgendaResults([]);
        setMessage({
          tone: 'error',
          text: error instanceof Error ? error.message : 'No se pudo consultar la agenda.',
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
        router.refresh();
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
              onClick={() => {
                setSelectedOrderId(null);
                setQuickSaleOpen((current) => !current);
              }}
              className="rounded-full border border-[#FEEF00]/70 bg-[#FEEF00] px-4 py-2 text-sm font-bold text-black hover:bg-[#fff45c]"
            >
              Nueva venta
            </button>
            <button
              type="button"
              onClick={() => setCashPanelOpen((current) => !current)}
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
              onClick={() => setMasterAgendaOpen((current) => !current)}
              className={[
                'rounded-full border px-4 py-2 text-sm font-semibold hover:border-[#FEEF00]/60',
                masterAgendaOpen
                  ? 'border-[#FEEF00] bg-[#FEEF00]/10 text-[#FEEF00]'
                  : 'border-[#303044] bg-[#111118] text-[#F5F5F7]',
              ].join(' ')}
            >
              Consultar agenda
            </button>
            <button
              type="button"
              onClick={() => router.refresh()}
              disabled={isPending}
              className="rounded-full border border-[#303044] bg-[#111118] px-4 py-2 text-sm font-semibold text-[#F5F5F7] hover:border-[#FEEF00]/60"
            >
              Actualizar
            </button>
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

        {cashPanelOpen ? (
          <CounterCashPanel
            accounts={cashAccounts}
            activeBsRate={activeBsRate}
            isWorking={workingOrderId === -2}
            onRefresh={() => router.refresh()}
            onCreateMovement={handleCreateCashMovement}
          />
        ) : null}

        {masterAgendaOpen ? (
          <MasterAgendaSearchPanel
            query={masterAgendaSearch}
            results={masterAgendaResults}
            searched={masterAgendaSearched}
            isPending={isPending}
            onQueryChange={setMasterAgendaSearch}
            onSearch={handleMasterAgendaSearch}
            onClear={() => {
              setMasterAgendaSearch('');
              setMasterAgendaResults([]);
              setMasterAgendaSearched(false);
            }}
          />
        ) : null}

        <div className="mt-5 grid gap-5 lg:grid-cols-[minmax(360px,0.92fr)_minmax(520px,1.08fr)]">
          <section className="rounded-[8px] border border-[#242433] bg-[#111118]">
            <div className="border-b border-[#242433] p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h1 className="text-lg font-semibold">Pedidos de mostrador</h1>
                  <p className="text-sm text-[#9FA0AA]">
                    Listos para entregar o en camino para liquidar al regreso.
                  </p>
                </div>
                <span className="rounded-full border border-[#303044] px-3 py-1 text-xs text-[#C7C8D1]">
                  {filteredOrders.length} visibles
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
                placeholder="Buscar orden, cliente, telefono o direccion"
                className="mt-4 w-full rounded-[8px] border border-[#303044] bg-[#0B0B0D] px-4 py-3 text-sm outline-none placeholder:text-[#666878] focus:border-[#FEEF00]/70"
              />
            </div>

            <div className="max-h-[calc(100vh-330px)] overflow-y-auto p-2">
              {filteredOrders.length === 0 ? (
                <div className="rounded-[8px] border border-dashed border-[#303044] p-6 text-sm text-[#9FA0AA]">
                  No hay pedidos listos con este filtro.
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
                            onSelect={() => {
                              setQuickSaleOpen(false);
                              setSelectedOrderId(order.id);
                            }}
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
                activeBsRate={activeBsRate}
                isWorking={workingOrderId === -1}
                onCancel={() => setQuickSaleOpen(false)}
                onSubmit={handleCreateQuickSale}
              />
            ) : selectedOrder ? (
              <OrderDetail
                order={selectedOrder}
                paymentAccounts={paymentAccounts}
                quickSaleProducts={quickSaleProducts}
                quickSaleProductComponents={quickSaleProductComponents}
                activeBsRate={activeBsRate}
                isWorking={workingOrderId === selectedOrder.id}
                onPrimaryDeliveryAction={handlePrimaryDeliveryAction}
                onCreatePaymentReport={handleCreatePaymentReport}
                onAddItems={handleAddItemsToOrder}
              />
            ) : (
              <CounterEmptyWorkSurface
                hasOrders={filteredOrders.length > 0}
                onNewSale={() => {
                  setSelectedOrderId(null);
                  setQuickSaleOpen(true);
                }}
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
  onRefresh,
  onCreateMovement,
}: {
  accounts: CounterCashAccountSummary[];
  activeBsRate: number;
  isWorking: boolean;
  onRefresh: () => void;
  onCreateMovement: (input: CounterCashMovementInput) => void;
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
  const selectedAccount =
    accounts.find((account) => String(account.accountId) === movementAccountId) ?? firstAccount;
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

  useEffect(() => {
    if (!firstAccount) return;
    setMovementAccountId((current) =>
      current && accounts.some((account) => String(account.accountId) === current)
        ? current
        : String(firstAccount.accountId)
    );
  }, [accounts, firstAccount?.accountId]);

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
                value={movementAccountId}
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

function MasterAgendaSearchPanel({
  query,
  results,
  searched,
  isPending,
  onQueryChange,
  onSearch,
  onClear,
}: {
  query: string;
  results: CounterAgendaSearchResult[];
  searched: boolean;
  isPending: boolean;
  onQueryChange: (value: string) => void;
  onSearch: () => void;
  onClear: () => void;
}) {
  return (
    <section className="mt-4 rounded-[8px] border border-[#242433] bg-[#111118] p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">Consultar agenda master</h2>
          <p className="mt-1 text-xs text-[#9FA0AA]">
            Busca una orden puntual por numero, cliente o telefono cuando no aparezca en la cola del counter.
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
                const reason = agendaSearchReason(result);

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
                            {agendaSearchStatusLabel(result.status)}
                          </span>
                        </div>
                        <div className="mt-1 truncate text-sm font-semibold">{result.clientName}</div>
                        <div className="mt-1 text-xs text-[#9FA0AA]">
                          {result.clientPhone || 'Sin telefono'} - {result.scheduledDate || 'Sin fecha'}{' '}
                          {result.scheduledTime || ''}
                        </div>
                        {reason ? <div className="mt-2 text-sm text-[#C7C8D1]">{reason}</div> : null}
                      </div>
                      <div className="shrink-0 text-right">
                        <div className="text-sm font-semibold">{moneyUsd(result.totalUsd)}</div>
                        <div className="text-xs text-[#9FA0AA]">{moneyBs(result.totalBs)}</div>
                      </div>
                    </div>
                    {result.note ? <div className="mt-2 text-xs text-[#9FA0AA]">Nota: {result.note}</div> : null}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ) : null}
    </section>
  );
}

function CounterQuickSalePanel({
  products,
  productComponents,
  activeBsRate,
  isWorking,
  onCancel,
  onSubmit,
}: {
  products: CounterQuickSaleProductOption[];
  productComponents: CounterQuickSaleProductComponent[];
  activeBsRate: number;
  isWorking: boolean;
  onCancel: () => void;
  onSubmit: (input: {
    clientId?: number | null;
    clientName: string;
    clientPhone: string;
    clientType?: 'own' | 'assigned' | 'legacy';
    fulfillment: 'pickup' | 'delivery';
    deliveryAddress: string;
    note: string;
    scheduleAsap: boolean;
    scheduledDate: string;
    scheduledTime: string;
    paymentMethod: string;
    paymentCurrency: 'USD' | 'VES';
    paymentRequiresChange: boolean;
    paymentChangeFor: string;
    paymentChangeCurrency: 'USD' | 'VES';
    paymentNote: string;
    discountEnabled?: boolean;
    discountPct?: string | number | null;
    hasDeliveryNote?: boolean;
    hasInvoice?: boolean;
    invoiceTaxPct?: string | number | null;
    items: Array<{ productId: number; qty: number; notes?: string | null; editableDetailLines?: string[] | null }>;
  }) => void;
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
  const [discountEnabled, setDiscountEnabled] = useState(false);
  const [discountPct, setDiscountPct] = useState('0');
  const [hasDeliveryNote, setHasDeliveryNote] = useState(false);
  const [hasInvoice, setHasInvoice] = useState(false);
  const [invoiceTaxPct, setInvoiceTaxPct] = useState('16');
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
  const totals = useMemo(() => {
    return calculateOrderTotalsSnapshot({
      subtotalUsd: cartSubtotal.usd,
      subtotalBs: cartSubtotal.bs,
      discountPct: discountEnabled ? toDecimalInput(discountPct) : 0,
      invoiceTaxPct: hasInvoice ? toDecimalInput(invoiceTaxPct) : 0,
    });
  }, [cartSubtotal.bs, cartSubtotal.usd, discountEnabled, discountPct, hasInvoice, invoiceTaxPct]);

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
      clientId: selectedClient?.id ?? null,
      clientName: clientName.trim(),
      clientPhone: clientPhone.trim(),
      clientType,
      fulfillment,
      deliveryAddress: deliveryAddress.trim(),
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
      discountEnabled,
      discountPct,
      hasDeliveryNote,
      hasInvoice,
      invoiceTaxPct,
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
            <div className="rounded-[8px] border border-emerald-400/30 bg-emerald-400/10 px-3 py-2">
              <div className="text-sm font-semibold text-emerald-100">{selectedClient.fullName}</div>
              <div className="mt-1 text-xs text-emerald-100/75">
                {selectedClient.phone || 'Sin telefono'} - {selectedClient.clientType || 'sin tipo'} - Fondo {moneyUsd(selectedClient.fundBalanceUsd)}
              </div>
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
          <div className="grid gap-2 rounded-[8px] border border-[#303044] bg-[#111118] p-3 sm:grid-cols-2">
            <label className="flex items-center gap-2 text-sm text-[#F5F5F7]">
              <input
                type="checkbox"
                checked={discountEnabled}
                onChange={(event) => setDiscountEnabled(event.target.checked)}
              />
              Descuento
            </label>
            <input
              value={discountPct}
              onChange={(event) => setDiscountPct(event.target.value)}
              disabled={!discountEnabled}
              inputMode="decimal"
              placeholder="% descuento"
              className="rounded-[8px] border border-[#303044] bg-[#0B0B0D] px-3 py-2 text-sm text-[#F5F5F7] outline-none placeholder:text-[#666878] focus:border-[#FEEF00]/70 disabled:opacity-50"
            />
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
            <label className="text-sm text-[#9FA0AA]">
              Direccion
              <textarea
                value={deliveryAddress}
                onChange={(event) => setDeliveryAddress(event.target.value)}
                rows={2}
                className="mt-1 w-full resize-none rounded-[8px] border border-[#303044] bg-[#111118] px-3 py-2 text-sm text-[#F5F5F7] outline-none focus:border-[#FEEF00]/70"
              />
            </label>
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
              <label className="text-xs text-[#9FA0AA] sm:col-span-2">
                IVA %
                <input
                  value={invoiceTaxPct}
                  onChange={(event) => setInvoiceTaxPct(event.target.value)}
                  inputMode="decimal"
                  className="mt-1 w-full rounded-[8px] border border-[#303044] bg-[#0B0B0D] px-3 py-2 text-sm text-[#F5F5F7] outline-none focus:border-[#FEEF00]/70"
                />
              </label>
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
              {discountEnabled && toDecimalInput(discountPct) > 0 ? (
                <div className="flex justify-between gap-3 text-emerald-200">
                  <span>Descuento ({toDecimalInput(discountPct)}%)</span>
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

          <button
            type="button"
            onClick={submitQuickSale}
            disabled={isWorking || activeBsRate <= 0 || cartItems.length === 0}
            className="w-full rounded-[8px] border border-[#FEEF00]/70 bg-[#FEEF00] px-5 py-2.5 text-sm font-bold text-black transition hover:bg-[#fff45c] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isWorking ? 'Creando...' : 'Crear y enviar a cocina'}
          </button>
        </div>
      </div>
    </section>
  );
}

function getCounterCurrentAction(order: CounterOrder) {
  const paid = order.balanceUsd <= 0.005;
  const hasPendingReports = order.reports.pending > 0;
  const immediatePaymentExpected = isCounterImmediatePaymentMethod(order.paymentMethod);
  const mustCollectNow = mustSettleBeforeCounterDelivery(order);

  if (order.status === 'created') {
    return {
      title: 'Agendado para master',
      description: 'El pedido fue creado por mostrador para otro momento. Master debe enviarlo a cocina cuando corresponda.',
      tone: 'warn' as const,
      steps: ['Confirmar hora con el cliente', 'Mantenerlo en agenda', 'Esperar accion del master'],
    };
  }

  if (order.status === 'confirmed' || order.status === 'in_kitchen') {
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
          ? 'El metodo esperado es efectivo o punto. Registra el cobro antes de entregar.'
          : 'El pedido puede entregarse pendiente; el asesor queda responsable del cobro.',
      tone: paid ? ('good' as const) : mustCollectNow ? ('warn' as const) : ('neutral' as const),
      steps: paid
        ? ['Validar cliente', 'Entregar pedido', 'Marcar retirado']
        : mustCollectNow
          ? ['Registrar pago', 'Validar cliente', 'Entregar pedido y marcar retirado']
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
    const needsSettlement = mustCollectNow || (immediatePaymentExpected && hasPendingReports);

    return {
      title: needsSettlement ? 'Liquidar delivery' : 'Cerrar entrega',
      description: needsSettlement
        ? 'Cuando el motorizado regrese, registra el cobro recibido antes de cerrar la entrega.'
        : paid
          ? 'El delivery ya esta sin saldo pendiente. Puedes marcarlo como entregado.'
          : 'Puedes marcarlo entregado; el pendiente queda bajo responsabilidad del asesor.',
      tone: needsSettlement ? ('warn' as const) : ('good' as const),
      steps: needsSettlement
        ? ['Esperar retorno del motorizado', 'Registrar cobro o revisar pago', 'Marcar entregada']
        : ['Confirmar entrega', 'Marcar entregada'],
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
  const inKitchenFlow = order.status === 'confirmed' || order.status === 'in_kitchen';
  const immediatePaymentExpected = isCounterImmediatePaymentMethod(order.paymentMethod);
  const mustCollectNow = mustSettleBeforeCounterDelivery(order);

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
              ? `Cobrar ${moneyUsd(order.balanceUsd)}`
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
    const settlementBlocked = mustCollectNow || (immediatePaymentExpected && hasPendingReports);
    return [
      { label: 'Salida', detail: 'En camino', state: 'done' as const },
      {
        label: 'Retorno',
        detail: paid
          ? 'Liquidado'
          : settlementBlocked
            ? hasPendingReports ? 'Pago por revisar' : `Cobrar ${moneyUsd(order.balanceUsd)}`
            : `Pendiente asesor ${moneyUsd(order.balanceUsd)}`,
        state: settlementBlocked ? ('current' as const) : ('done' as const),
      },
      {
        label: 'Cierre',
        detail: settlementBlocked ? 'Esperando liquidacion' : 'Marcar entregada',
        state: settlementBlocked ? ('blocked' as const) : ('current' as const),
      },
    ];
  }

  return [
    { label: 'Revision', detail: 'Sin accion inmediata', state: 'pending' as const },
  ];
}

function OrderDetail({
  order,
  paymentAccounts,
  quickSaleProducts,
  quickSaleProductComponents,
  activeBsRate,
  isWorking,
  onPrimaryDeliveryAction,
  onCreatePaymentReport,
  onAddItems,
}: {
  order: CounterOrder;
  paymentAccounts: CounterPaymentAccountOption[];
  quickSaleProducts: CounterQuickSaleProductOption[];
  quickSaleProductComponents: CounterQuickSaleProductComponent[];
  activeBsRate: number;
  isWorking: boolean;
  onPrimaryDeliveryAction: (order: CounterOrder) => void;
  onCreatePaymentReport: (order: CounterOrder, input: CounterPaymentReportInput) => void;
  onAddItems: (
    order: CounterOrder,
    items: Array<{ productId: number; qty: number; notes?: string | null; editableDetailLines?: string[] | null }>
  ) => void;
}) {
  const paid = order.balanceUsd <= 0.005;
  const isDeliverySettlement = order.fulfillment === 'delivery' && order.status === 'out_for_delivery';
  const deliveryReadyWithoutAssignee =
    order.fulfillment === 'delivery' && order.status === 'ready' && !order.deliveryAssigneeName;
  const waitingForMaster = order.status === 'created';
  const notReadyForCounter = waitingForMaster || order.status === 'confirmed' || order.status === 'in_kitchen';
  const hasPendingBalance = order.balanceUsd > 0.005;
  const hasPendingReports = order.reports.pending > 0;
  const immediatePaymentExpected = isCounterImmediatePaymentMethod(order.paymentMethod);
  const mustCollectNow = mustSettleBeforeCounterDelivery(order);
  const pickupReadyNeedsPayment =
    order.fulfillment === 'pickup' &&
    order.status === 'ready' &&
    (mustCollectNow || (immediatePaymentExpected && hasPendingReports));
  const primaryActionBlocked =
    notReadyForCounter ||
    pickupReadyNeedsPayment ||
    deliveryReadyWithoutAssignee ||
    (isDeliverySettlement && (mustCollectNow || (immediatePaymentExpected && hasPendingReports)));
  const primaryActionBlockedMessage = waitingForMaster
    ? 'Esta orden quedo agendada. Master debe enviarla a cocina cuando corresponda.'
    : notReadyForCounter
      ? 'Esta orden aun esta en cocina. Cuando quede lista aparecera para entrega.'
    : pickupReadyNeedsPayment
      ? hasPendingReports
        ? 'Hay pagos pendientes de revision. No marques retirado hasta que queden confirmados.'
        : 'El metodo esperado es efectivo o punto. Primero registra el cobro antes de marcar el pickup como retirado.'
    : deliveryReadyWithoutAssignee
      ? 'Este delivery no tiene motorizado o partner asignado. Asignalo desde master antes de entregarlo.'
      : mustCollectNow
        ? 'El metodo esperado es efectivo o punto. Primero registra el cobro recibido del motorizado.'
        : 'Hay pagos pendientes de revision antes de cerrar la entrega.';
  const [paymentOpen, setPaymentOpen] = useState(false);
  const [addItemsOpen, setAddItemsOpen] = useState(false);
  const currentAction = getCounterCurrentAction(order);
  const canAddItems = order.status !== 'out_for_delivery';

  return (
    <div>
      <div className="border-b border-[#242433] p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-2xl font-semibold">Orden #{order.displayNumber}</h2>
              <span className={['rounded-full border px-3 py-1 text-sm font-semibold', counterStatusClass(order)].join(' ')}>
                {getOperationalStatusLabel(order)}
              </span>
              <span className="rounded-full border border-[#303044] px-3 py-1 text-sm text-[#C7C8D1]">
                {fulfillmentLabel(order.fulfillment)}
              </span>
            </div>
            <div className="mt-2 text-sm text-[#9FA0AA]">
              {order.clientName}
              {order.clientPhone ? ` · ${order.clientPhone}` : ''}
            </div>
            <div className="mt-1 text-sm text-[#9FA0AA]">
              Asesor: <span className="font-semibold text-[#F5F5F7]">{order.advisorName || 'Sin asesor'}</span>
            </div>
            <div className="mt-1 text-sm text-[#9FA0AA]">Lista: {formatDateTime(order.readyAt)}</div>
          </div>
          <span className={['rounded-full border px-3 py-1 text-sm font-semibold', paymentClass(order)].join(' ')}>
            {paymentLabel(order)}
          </span>
        </div>
      </div>

      <div className="grid gap-4 p-4 xl:grid-cols-[1fr_220px]">
        <div className="space-y-3">
          <div className="rounded-[8px] border border-[#242433] bg-[#0B0B0D] p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="font-semibold">Pedido</h3>
              <span className="text-sm font-semibold text-[#C7C8D1]">{order.items.length} item(s)</span>
            </div>
            <div className="mt-3 divide-y divide-[#242433]">
              {order.items.length === 0 ? (
                <div className="py-3 text-sm text-[#9FA0AA]">Sin items cargados.</div>
              ) : (
                order.items.map((item) => (
                  <div key={item.id} className="grid gap-2 py-2.5 sm:grid-cols-[64px_1fr_92px]">
                    <div className="text-sm font-semibold text-[#FEEF00]">x{qtyLabel(item.qty)}</div>
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

          <CurrentActionCard action={currentAction} />
          <CounterWorkflowChecklist items={getCounterWorkflowChecks(order)} />

          <div className="grid gap-3 sm:grid-cols-3">
            <Metric label="Total" value={moneyUsd(order.totalUsd)} note={moneyBs(order.totalBs)} />
            <Metric label="Confirmado" value={moneyUsd(order.confirmedPaidUsd)} tone="good" />
            <Metric label="Pendiente" value={moneyUsd(order.balanceUsd)} tone={paid ? 'good' : 'warn'} />
          </div>

          <div className="rounded-[8px] border border-[#242433] bg-[#0B0B0D] p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="font-semibold">Pago esperado</h3>
              <span className="text-sm font-semibold text-[#F5F5F7]">{getPaymentMethodLabel(order.paymentMethod)}</span>
            </div>
            <div className="mt-2 grid gap-2 text-sm text-[#9FA0AA] sm:grid-cols-2">
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
            <div className="rounded-[8px] border border-[#242433] bg-[#0B0B0D] p-4">
              <h3 className="font-semibold">Entrega</h3>
              <div className="mt-2 grid gap-2 text-sm text-[#C7C8D1] sm:grid-cols-2">
                <div className="sm:col-span-2">{order.deliveryAddress || 'Sin direccion'}</div>
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

          {isDeliverySettlement ? (
            <div className="rounded-[8px] border border-sky-400/30 bg-sky-950/20 p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h3 className="font-semibold text-sky-100">Liquidacion de delivery</h3>
                  <p className="mt-1 text-sm text-sky-100/70">
                    Registra el retorno del motorizado antes de marcar la orden como entregada.
                  </p>
                </div>
                <span className="rounded-full border border-sky-300/30 bg-sky-300/10 px-3 py-1 text-xs font-semibold text-sky-100">
                  En camino
                </span>
              </div>
              <div className="mt-4 grid gap-2 sm:grid-cols-3">
                <Metric
                  label="Por cobrar"
                  value={moneyUsd(order.balanceUsd)}
                  tone={hasPendingBalance ? 'warn' : 'good'}
                />
                <Metric
                  label="Motorizado"
                  value={deliveryAssigneeLabel(order) || 'No aplica'}
                  tone={order.deliveryAssigneeName ? 'neutral' : 'warn'}
                />
                <Metric label="Metodo esperado" value={getPaymentMethodLabel(order.paymentMethod)} />
                <Metric
                  label="Pagos por revisar"
                  value={String(order.reports.pending)}
                  tone={hasPendingReports ? 'warn' : 'good'}
                />
              </div>
              {order.paymentRequiresChange ? (
                <div className="mt-3 rounded-[8px] border border-[#303044] bg-[#0B0B0D] p-3 text-sm text-[#C7C8D1]">
                  Cambio indicado: {order.paymentChangeFor || '-'} {order.paymentChangeCurrency || ''}
                </div>
              ) : null}
              <button
                type="button"
                onClick={() => setPaymentOpen(true)}
                disabled={!hasPendingBalance && !hasPendingReports}
                className="mt-4 w-full rounded-[8px] border border-sky-300/50 bg-sky-300/10 px-4 py-3 text-sm font-bold text-sky-100 transition hover:bg-sky-300/15 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Registrar retorno / cobro
              </button>
            </div>
          ) : null}

          {order.notes ? (
            <div className="rounded-[8px] border border-[#242433] bg-[#0B0B0D] p-4">
              <h3 className="font-semibold">Notas</h3>
              <div className="mt-2 text-sm text-[#C7C8D1]">{order.notes}</div>
            </div>
          ) : null}
        </div>

        <aside className="space-y-2">
          <button
            type="button"
            onClick={() => onPrimaryDeliveryAction(order)}
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
          <button
            type="button"
            onClick={() => setPaymentOpen((current) => !current)}
            className="w-full rounded-[8px] border border-[#303044] bg-[#0B0B0D] px-3 py-2 text-sm font-semibold text-[#F5F5F7] transition hover:border-[#FEEF00]/60"
          >
            {paymentOpen ? 'Ocultar pago' : isDeliverySettlement ? 'Registrar retorno / cobro' : 'Registrar pago'}
          </button>
          <button
            type="button"
            onClick={() => setAddItemsOpen((current) => !current)}
            disabled={!canAddItems || isWorking}
            className="w-full rounded-[8px] border border-[#303044] bg-[#0B0B0D] px-3 py-2 text-sm font-semibold text-[#F5F5F7] transition hover:border-[#FEEF00]/60 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {addItemsOpen ? 'Ocultar agregar' : 'Agregar productos'}
          </button>
          {order.paymentRequiresChange ? (
            <ActionHint
              title="Preparar cambio"
              text={`Cambio para ${order.paymentChangeFor || '-'} ${order.paymentChangeCurrency || ''}. El egreso se registra al liquidar el cobro.`}
              tone="warn"
            />
          ) : null}
          {canAddItems ? (
            <ActionHint
              title="Agregar productos"
              text={
                order.status === 'ready'
                  ? 'Si agregas productos a una orden lista, vuelve a cocina para preparar lo nuevo.'
                  : 'Puedes ampliar la orden mientras siga activa en mostrador.'
              }
            />
          ) : null}
          <div className="rounded-[8px] border border-[#303044] bg-[#0B0B0D] p-3 text-xs leading-relaxed text-[#9FA0AA]">
            Para delivery, esta vista mantiene la orden hasta que se marque entregada y se liquide el cobro.
          </div>
        </aside>
      </div>

      {paymentOpen ? (
        <div className="border-t border-[#242433] p-5">
          <CounterPaymentBox
            order={order}
            paymentAccounts={paymentAccounts}
            isWorking={isWorking}
            onSubmit={(input) => onCreatePaymentReport(order, input)}
          />
        </div>
      ) : null}

      {addItemsOpen ? (
        <div className="border-t border-[#242433] p-5">
          <CounterAddItemsBox
            order={order}
            products={quickSaleProducts}
            productComponents={quickSaleProductComponents}
            activeBsRate={activeBsRate}
            isWorking={isWorking}
            onSubmit={(items) => onAddItems(order, items)}
          />
        </div>
      ) : null}
    </div>
  );
}

function CounterAddItemsBox({
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
  onSubmit: (items: Array<{ productId: number; qty: number; notes?: string | null; editableDetailLines?: string[] | null }>) => void;
}) {
  const [productSearch, setProductSearch] = useState('');
  const [selectedProductId, setSelectedProductId] = useState('');
  const [qty, setQty] = useState('1');
  const [notes, setNotes] = useState('');
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

  function submitItems() {
    if (cartItems.length === 0) {
      setLocalError('Agrega al menos una linea.');
      return;
    }

    onSubmit(
      cartItems.map((item) => ({
        productId: item.productId,
        qty: toDecimalInput(item.qty),
        notes: item.notes.trim() || null,
        editableDetailLines: item.editableDetailLines,
      }))
    );
  }

  return (
    <div className="rounded-[8px] border border-[#303044] bg-[#0B0B0D] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold">Agregar al pedido</h3>
          <p className="mt-1 text-sm text-[#9FA0AA]">
            Se recalcula el total. Si la orden estaba lista, vuelve a cocina.
          </p>
        </div>
        <div className="rounded-[8px] border border-[#303044] bg-[#111118] px-3 py-2 text-right">
          <div className="text-xs text-[#9FA0AA]">Agregado</div>
          <div className="text-sm font-semibold text-[#F5F5F7]">{moneyUsd(addedUsd)}</div>
          <div className="text-xs text-[#9FA0AA]">{moneyBs(addedBs)}</div>
        </div>
      </div>

      {localError ? (
        <div className="mt-3 rounded-[8px] border border-red-400/40 bg-red-400/10 px-3 py-2 text-sm font-semibold text-red-200">
          {localError}
        </div>
      ) : null}

      <div className="mt-4 grid gap-3 lg:grid-cols-[1fr_110px_1fr_130px]">
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

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm text-[#9FA0AA]">
          Orden #{order.displayNumber} quedara con nuevo saldo al refrescar.
        </div>
        <button
          type="button"
          onClick={submitItems}
          disabled={isWorking || cartItems.length === 0 || activeBsRate <= 0}
          className="rounded-[8px] border border-[#FEEF00]/70 bg-[#FEEF00] px-5 py-3 text-sm font-bold text-black transition hover:bg-[#fff45c] disabled:cursor-wait disabled:opacity-60"
        >
          {isWorking ? 'Guardando...' : 'Aplicar agregado'}
        </button>
      </div>
    </div>
  );
}

function CounterPaymentBox({
  order,
  paymentAccounts,
  isWorking,
  onSubmit,
}: {
  order: CounterOrder;
  paymentAccounts: CounterPaymentAccountOption[];
  isWorking: boolean;
  onSubmit: (input: CounterPaymentReportInput) => void;
}) {
  const reportAccounts = paymentAccounts.filter((account) => account.canReportPayment);
  const firstAccount = reportAccounts[0] ?? null;
  const [overpaymentHandling, setOverpaymentHandling] = useState<'store_fund' | 'change_given'>('store_fund');
  const changeAccounts = paymentAccounts.filter(canUseAccountForChange);
  const firstChangeAccount = changeAccounts[0] ?? null;
  const [paymentLines, setPaymentLines] = useState<CounterPaymentLineDraft[]>([]);
  const [changeLines, setChangeLines] = useState<CounterChangeLineDraft[]>([]);

  const reportedUsd = paymentLines.reduce((sum, line) => {
    const lineAccount = reportAccounts.find((account) => paymentAccountKey(account) === line.accountKey);
    const lineAmount = toDecimalInput(line.amount);
    if (!lineAccount || !Number.isFinite(lineAmount) || lineAmount <= 0) return sum;
    const lineExchangeRate =
      lineAccount.currencyCode === 'VES' ? toDecimalInput(line.exchangeRate) : null;
    return sum + getPaymentAmountUsd(lineAmount, lineAccount, lineExchangeRate);
  }, 0);
  const autoReportedUsd = paymentLines.reduce((sum, line) => {
    const lineAccount = reportAccounts.find((account) => paymentAccountKey(account) === line.accountKey);
    const lineAmount = toDecimalInput(line.amount);
    if (!lineAccount || !lineAccount.autoConfirmsReport || !Number.isFinite(lineAmount) || lineAmount <= 0) return sum;
    const lineExchangeRate =
      lineAccount.currencyCode === 'VES' ? toDecimalInput(line.exchangeRate) : null;
    return sum + getPaymentAmountUsd(lineAmount, lineAccount, lineExchangeRate);
  }, 0);
  const excessUsd = Math.max(0, Number((autoReportedUsd - order.balanceUsd).toFixed(2)));
  const changeUsd = changeLines.reduce((sum, line) => {
    const lineAccount = changeAccounts.find((account) => paymentAccountKey(account) === line.accountKey);
    const lineAmount = toDecimalInput(line.amount);
    if (!lineAccount || !Number.isFinite(lineAmount) || lineAmount <= 0) return sum;
    const lineExchangeRate =
      lineAccount.currencyCode === 'VES' ? toDecimalInput(line.exchangeRate) : null;
    return sum + getPaymentAmountUsd(lineAmount, lineAccount, lineExchangeRate);
  }, 0);
  const remainingAfterChangeUsd =
    excessUsd > 0 && overpaymentHandling === 'change_given'
      ? Number((excessUsd - changeUsd).toFixed(2))
      : 0;
  const pendingReviewUsd = Math.max(0, Number((reportedUsd - autoReportedUsd).toFixed(2)));
  const immediateBalanceUsd =
    overpaymentHandling === 'change_given'
      ? Number((order.balanceUsd - autoReportedUsd + changeUsd).toFixed(2))
      : Math.max(0, Number((order.balanceUsd - autoReportedUsd).toFixed(2)));
  const immediatePendingUsd = Math.max(0, immediateBalanceUsd);
  const immediateFundUsd =
    overpaymentHandling === 'store_fund'
      ? excessUsd
      : Math.max(0, Number((-immediateBalanceUsd).toFixed(2)));
  const submitLabel =
    pendingReviewUsd > 0.005
      ? 'Registrar pagos'
      : immediatePendingUsd > 0.005
        ? 'Registrar abono'
        : 'Cerrar cobro';

  function nativePaymentAmount(account: CounterPaymentAccountOption | null, usdAmount: number) {
    if (!account) return '';
    return account.currencyCode === 'VES'
      ? (Math.max(0, usdAmount) * Math.max(order.fxRate, 0)).toFixed(2)
      : Math.max(0, usdAmount).toFixed(2);
  }

  function makePaymentLine(usdAmount: number): CounterPaymentLineDraft {
    return {
      id: `payment-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      accountKey: firstAccount ? paymentAccountKey(firstAccount) : '',
      amount: nativePaymentAmount(firstAccount, usdAmount),
      exchangeRate: order.fxRate > 0 ? String(Number(order.fxRate.toFixed(2))) : '',
      operationDate: getTodayKey(),
      referenceCode: '',
      bankName: '',
      payerName: '',
      notes: '',
    };
  }

  function updatePaymentLine(id: string, patch: Partial<CounterPaymentLineDraft>) {
    setPaymentLines((current) =>
      current.map((line) => {
        if (line.id !== id) return line;
        const next = { ...line, ...patch };
        if (patch.accountKey) {
          const nextAccount = reportAccounts.find((account) => paymentAccountKey(account) === patch.accountKey) ?? null;
          next.exchangeRate =
            nextAccount?.currencyCode === 'VES' && order.fxRate > 0
              ? String(Number(order.fxRate.toFixed(2)))
              : next.exchangeRate;
        }
        return next;
      })
    );
  }

  function addPaymentLine() {
    const pendingUsd = Math.max(0, order.balanceUsd - reportedUsd);
    setPaymentLines((current) => [...current, makePaymentLine(pendingUsd > 0 ? pendingUsd : 0)]);
  }

  function fillPaymentLineWithPending(id: string) {
    setPaymentLines((current) => {
      const otherReportedUsd = current.reduce((sum, line) => {
        if (line.id === id) return sum;
        const lineAccount = reportAccounts.find((account) => paymentAccountKey(account) === line.accountKey);
        const lineAmount = toDecimalInput(line.amount);
        if (!lineAccount || !Number.isFinite(lineAmount) || lineAmount <= 0) return sum;
        const lineExchangeRate =
          lineAccount.currencyCode === 'VES' ? toDecimalInput(line.exchangeRate) : null;
        return sum + getPaymentAmountUsd(lineAmount, lineAccount, lineExchangeRate);
      }, 0);
      const pendingUsd = Math.max(0, order.balanceUsd - otherReportedUsd);

      return current.map((line) => {
        if (line.id !== id) return line;
        const lineAccount = reportAccounts.find((account) => paymentAccountKey(account) === line.accountKey) ?? null;
        return {
          ...line,
          amount: nativePaymentAmount(lineAccount, pendingUsd),
          exchangeRate:
            lineAccount?.currencyCode === 'VES' && order.fxRate > 0
              ? String(Number(order.fxRate.toFixed(2)))
              : line.exchangeRate,
        };
      });
    });
  }

  function nativeChangeAmount(account: CounterPaymentAccountOption | null, usdAmount: number) {
    if (!account) return '';
    return account.currencyCode === 'VES'
      ? (Math.max(0, usdAmount) * Math.max(order.fxRate, 0)).toFixed(2)
      : Math.max(0, usdAmount).toFixed(2);
  }

  function makeChangeLine(usdAmount: number): CounterChangeLineDraft {
    return {
      id: `change-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      accountKey: firstChangeAccount ? paymentAccountKey(firstChangeAccount) : '',
      amount: nativeChangeAmount(firstChangeAccount, usdAmount),
      exchangeRate: order.fxRate > 0 ? String(Number(order.fxRate.toFixed(2))) : '',
    };
  }

  function updateChangeLine(id: string, patch: Partial<CounterChangeLineDraft>) {
    setChangeLines((current) =>
      current.map((line) => {
        if (line.id !== id) return line;
        const next = { ...line, ...patch };
        if (patch.accountKey) {
          const nextAccount = changeAccounts.find((account) => paymentAccountKey(account) === patch.accountKey) ?? null;
          next.exchangeRate =
            nextAccount?.currencyCode === 'VES' && order.fxRate > 0
              ? String(Number(order.fxRate.toFixed(2)))
              : next.exchangeRate;
        }
        return next;
      })
    );
  }

  function addChangeLine() {
    const pendingUsd = Math.max(0, remainingAfterChangeUsd);
    setChangeLines((current) => [...current, makeChangeLine(pendingUsd > 0 ? pendingUsd : 0)]);
  }

  function fillChangeLineWithExcess(id: string) {
    setChangeLines((current) => {
      const otherChangeUsd = current.reduce((sum, line) => {
        if (line.id === id) return sum;
        const lineAccount = changeAccounts.find((account) => paymentAccountKey(account) === line.accountKey);
        const lineAmount = toDecimalInput(line.amount);
        if (!lineAccount || !Number.isFinite(lineAmount) || lineAmount <= 0) return sum;
        const lineExchangeRate =
          lineAccount.currencyCode === 'VES' ? toDecimalInput(line.exchangeRate) : null;
        return sum + getPaymentAmountUsd(lineAmount, lineAccount, lineExchangeRate);
      }, 0);
      const pendingChangeUsd = Math.max(0, excessUsd - otherChangeUsd);

      return current.map((line) => {
        if (line.id !== id) return line;
        const lineAccount = changeAccounts.find((account) => paymentAccountKey(account) === line.accountKey) ?? null;
        return {
          ...line,
          amount: nativeChangeAmount(lineAccount, pendingChangeUsd),
          exchangeRate:
            lineAccount?.currencyCode === 'VES' && order.fxRate > 0
              ? String(Number(order.fxRate.toFixed(2)))
              : line.exchangeRate,
        };
      });
    });
  }

  useEffect(() => {
    setPaymentLines(firstAccount ? [makePaymentLine(order.balanceUsd)] : []);
    setChangeLines([]);
    setOverpaymentHandling('store_fund');
  }, [firstAccount?.accountId, firstAccount?.paymentMethodCode, order.balanceUsd, order.id]);

  useEffect(() => {
    if (excessUsd <= 0 || overpaymentHandling !== 'change_given' || !firstChangeAccount) return;
    if (changeLines.length > 0) return;
    setChangeLines([makeChangeLine(excessUsd)]);
  }, [changeLines.length, excessUsd, firstChangeAccount?.accountId, overpaymentHandling]);

  useEffect(() => {
    if (excessUsd > 0 || changeLines.length === 0) return;
    setChangeLines([]);
  }, [changeLines.length, excessUsd]);

  if (reportAccounts.length === 0) {
    return (
      <div className="rounded-[8px] border border-orange-400/40 bg-orange-400/10 p-4 text-sm text-orange-200">
        No hay cuentas habilitadas para que mostrador reporte pagos.
      </div>
    );
  }

  return (
    <div className="rounded-[8px] border border-[#242433] bg-[#0B0B0D] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold">
            {order.fulfillment === 'delivery' && order.status === 'out_for_delivery'
              ? 'Registrar retorno de delivery'
              : 'Registrar cobro'}
          </h3>
          <p className="mt-1 text-sm text-[#9FA0AA]">
            Puedes dividir el pago en varias cuentas y entregar cambio desde una o varias cajas.
          </p>
        </div>
        <div className="flex flex-wrap gap-2 text-xs">
          <span className="rounded-full border border-[#303044] px-3 py-1 text-[#C7C8D1]">
            Reportado {moneyUsd(reportedUsd)}
          </span>
          <span className="rounded-full border border-emerald-400/30 bg-emerald-400/10 px-3 py-1 text-emerald-200">
            Auto {moneyUsd(autoReportedUsd)}
          </span>
          <span
            className={[
              'rounded-full border px-3 py-1',
              reportedUsd >= order.balanceUsd - 0.005
                ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-200'
                : 'border-orange-400/40 bg-orange-400/10 text-orange-200',
            ].join(' ')}
          >
            Falta {moneyUsd(Math.max(0, order.balanceUsd - reportedUsd))}
          </span>
        </div>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <div className="rounded-[8px] border border-[#303044] bg-[#111118] p-3">
          <div className="text-xs text-[#9FA0AA]">Pendiente orden</div>
          <div className="mt-1 text-lg font-semibold text-orange-200">{moneyUsd(order.balanceUsd)}</div>
          <div className="text-xs text-[#9FA0AA]">{moneyBs(order.balanceUsd * Math.max(order.fxRate, 0))}</div>
        </div>
        <div className="rounded-[8px] border border-[#303044] bg-[#111118] p-3">
          <div className="text-xs text-[#9FA0AA]">Recibido ahora</div>
          <div className="mt-1 text-lg font-semibold text-[#F5F5F7]">{moneyUsd(reportedUsd)}</div>
          <div className="text-xs text-[#9FA0AA]">
            {pendingReviewUsd > 0.005 ? `${moneyUsd(pendingReviewUsd)} por revisar` : 'Todo inmediato'}
          </div>
        </div>
        <div className="rounded-[8px] border border-[#303044] bg-[#111118] p-3">
          <div className="text-xs text-[#9FA0AA]">Cambio / fondo</div>
          <div className="mt-1 text-lg font-semibold text-sky-100">
            {overpaymentHandling === 'change_given' ? moneyUsd(changeUsd) : moneyUsd(immediateFundUsd)}
          </div>
          <div className="text-xs text-[#9FA0AA]">
            {overpaymentHandling === 'change_given' ? 'Cambio entregado' : 'Fondo cliente'}
          </div>
        </div>
        <div
          className={[
            'rounded-[8px] border p-3',
            immediatePendingUsd > 0.005
              ? 'border-orange-400/40 bg-orange-400/10'
              : 'border-emerald-400/30 bg-emerald-400/10',
          ].join(' ')}
        >
          <div className="text-xs text-[#9FA0AA]">Resultado inmediato</div>
          <div
            className={[
              'mt-1 text-lg font-semibold',
              immediatePendingUsd > 0.005 ? 'text-orange-200' : 'text-emerald-200',
            ].join(' ')}
          >
            {immediatePendingUsd > 0.005 ? `Pendiente ${moneyUsd(immediatePendingUsd)}` : 'Orden cubierta'}
          </div>
          <div className="text-xs text-[#9FA0AA]">
            {immediateFundUsd > 0.005 ? `Fondo ${moneyUsd(immediateFundUsd)}` : 'Sin excedente'}
          </div>
        </div>
      </div>

      <div className="mt-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-xs font-semibold uppercase tracking-[0.12em] text-[#9FA0AA]">
            Lineas de pago
          </div>
          <button
            type="button"
            onClick={addPaymentLine}
            className="rounded-full border border-[#FEEF00]/50 bg-[#FEEF00]/10 px-3 py-1.5 text-xs font-semibold text-[#FEEF00] transition hover:bg-[#FEEF00]/20"
          >
            Agregar pago
          </button>
        </div>

        {paymentLines.map((line, index) => {
          const lineAccount =
            reportAccounts.find((account) => paymentAccountKey(account) === line.accountKey) ?? firstAccount;
          const requirements = getPaymentReportRequirements(lineAccount?.paymentMethodCode);

          return (
            <div key={line.id} className="rounded-[8px] border border-[#242433] bg-[#111118] p-3">
              <div className="grid gap-3 lg:grid-cols-[minmax(220px,1.25fr)_minmax(120px,0.65fr)_minmax(115px,0.55fr)_minmax(135px,0.65fr)_auto]">
                <label className="text-sm text-[#9FA0AA]">
                  Cuenta
                  <select
                    value={line.accountKey}
                    onChange={(event) => updatePaymentLine(line.id, { accountKey: event.target.value })}
                    className="mt-1 w-full rounded-[8px] border border-[#303044] bg-[#0B0B0D] px-3 py-3 text-[#F5F5F7] outline-none focus:border-[#FEEF00]/70"
                  >
                    {reportAccounts.map((account) => (
                      <option key={paymentAccountKey(account)} value={paymentAccountKey(account)}>
                        {account.accountName} - {getPaymentMethodLabel(account.paymentMethodCode)}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="text-sm text-[#9FA0AA]">
                  Monto {lineAccount?.currencyCode || ''}
                  <input
                    value={line.amount}
                    onChange={(event) => updatePaymentLine(line.id, { amount: event.target.value })}
                    inputMode="decimal"
                    className="mt-1 w-full rounded-[8px] border border-[#303044] bg-[#0B0B0D] px-3 py-3 text-[#F5F5F7] outline-none focus:border-[#FEEF00]/70"
                  />
                  <button
                    type="button"
                    onClick={() => fillPaymentLineWithPending(line.id)}
                    className="mt-2 w-full rounded-full border border-[#303044] px-3 py-1.5 text-xs font-semibold text-[#C7C8D1] transition hover:border-[#FEEF00]/60 hover:text-[#FEEF00]"
                  >
                    Completar pendiente
                  </button>
                </label>

                {lineAccount?.currencyCode === 'VES' ? (
                  <label className="text-sm text-[#9FA0AA]">
                    Tasa
                    <input
                      value={line.exchangeRate}
                      onChange={(event) => updatePaymentLine(line.id, { exchangeRate: event.target.value })}
                      inputMode="decimal"
                      className="mt-1 w-full rounded-[8px] border border-[#303044] bg-[#0B0B0D] px-3 py-3 text-[#F5F5F7] outline-none focus:border-[#FEEF00]/70"
                    />
                  </label>
                ) : (
                  <div className="hidden lg:block" />
                )}

                <label className="text-sm text-[#9FA0AA]">
                  Fecha
                  <input
                    type="date"
                    value={line.operationDate}
                    onChange={(event) => updatePaymentLine(line.id, { operationDate: event.target.value })}
                    className="mt-1 w-full rounded-[8px] border border-[#303044] bg-[#0B0B0D] px-3 py-3 text-[#F5F5F7] outline-none focus:border-[#FEEF00]/70"
                  />
                </label>

                <div className="flex items-end">
                  <button
                    type="button"
                    onClick={() => setPaymentLines((current) => current.filter((item) => item.id !== line.id))}
                    disabled={paymentLines.length === 1}
                    className="w-full rounded-[8px] border border-red-400/40 px-3 py-3 text-sm font-semibold text-red-200 transition hover:bg-red-400/10 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {index === 0 && paymentLines.length === 1 ? 'Linea unica' : 'Quitar'}
                  </button>
                </div>
              </div>

              <div className="mt-3 grid gap-3 lg:grid-cols-3">
                {requirements.requiresReference ? (
                  <label className="text-sm text-[#9FA0AA]">
                    Referencia
                    <input
                      value={line.referenceCode}
                      onChange={(event) => updatePaymentLine(line.id, { referenceCode: event.target.value })}
                      className="mt-1 w-full rounded-[8px] border border-[#303044] bg-[#0B0B0D] px-3 py-3 text-[#F5F5F7] outline-none focus:border-[#FEEF00]/70"
                    />
                  </label>
                ) : null}

                {requirements.requiresBank ? (
                  <label className="text-sm text-[#9FA0AA]">
                    Banco
                    <input
                      value={line.bankName}
                      onChange={(event) => updatePaymentLine(line.id, { bankName: event.target.value })}
                      className="mt-1 w-full rounded-[8px] border border-[#303044] bg-[#0B0B0D] px-3 py-3 text-[#F5F5F7] outline-none focus:border-[#FEEF00]/70"
                    />
                  </label>
                ) : null}

                {requirements.requiresHolderName || requirements.requiresInvoiceNumber ? (
                  <label className="text-sm text-[#9FA0AA]">
                    {requirements.requiresInvoiceNumber ? 'Factura' : 'Titular'}
                    <input
                      value={line.payerName}
                      onChange={(event) => updatePaymentLine(line.id, { payerName: event.target.value })}
                      className="mt-1 w-full rounded-[8px] border border-[#303044] bg-[#0B0B0D] px-3 py-3 text-[#F5F5F7] outline-none focus:border-[#FEEF00]/70"
                    />
                  </label>
                ) : null}

                <label className="text-sm text-[#9FA0AA] lg:col-span-3">
                  Nota
                  <input
                    value={line.notes}
                    onChange={(event) => updatePaymentLine(line.id, { notes: event.target.value })}
                    placeholder="Opcional"
                    className="mt-1 w-full rounded-[8px] border border-[#303044] bg-[#0B0B0D] px-3 py-3 text-[#F5F5F7] outline-none placeholder:text-[#666878] focus:border-[#FEEF00]/70"
                  />
                </label>
              </div>
            </div>
          );
        })}
      </div>

      {excessUsd > 0.005 ? (
        <div className="mt-4 rounded-[8px] border border-sky-400/30 bg-sky-400/10 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="text-sm font-semibold text-sky-100">Excedente detectado: {moneyUsd(excessUsd)}</div>
              <div className="mt-1 text-xs text-[#B9C4D6]">
                Decide si queda en fondo del cliente o si se entrega cambio desde caja.
              </div>
            </div>
          </div>

          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setOverpaymentHandling('store_fund')}
              className={[
                'rounded-full border px-3 py-1.5 text-sm font-semibold',
                overpaymentHandling === 'store_fund'
                  ? 'border-[#FEEF00] bg-[#FEEF00]/10 text-[#FEEF00]'
                  : 'border-[#303044] bg-[#0B0B0D] text-[#C7C8D1]',
              ].join(' ')}
            >
              Guardar en fondo
            </button>
            <button
              type="button"
              onClick={() => setOverpaymentHandling('change_given')}
              className={[
                'rounded-full border px-3 py-1.5 text-sm font-semibold',
                overpaymentHandling === 'change_given'
                  ? 'border-[#FEEF00] bg-[#FEEF00]/10 text-[#FEEF00]'
                  : 'border-[#303044] bg-[#0B0B0D] text-[#C7C8D1]',
              ].join(' ')}
            >
              Entregar cambio
            </button>
          </div>

          {overpaymentHandling === 'change_given' ? (
            <div className="mt-3 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-xs font-semibold uppercase tracking-[0.12em] text-[#B9C4D6]">
                  Lineas de cambio
                </div>
                <button
                  type="button"
                  onClick={addChangeLine}
                  disabled={changeAccounts.length === 0}
                  className="rounded-full border border-sky-300/50 bg-sky-400/10 px-3 py-1.5 text-xs font-semibold text-sky-100 transition hover:bg-sky-400/20 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Agregar linea
                </button>
              </div>

              {changeAccounts.length === 0 ? (
                <div className="rounded-[8px] border border-orange-400/40 bg-orange-400/10 px-3 py-2 text-sm text-orange-200">
                  No hay cuentas habilitadas para entregar cambio.
                </div>
              ) : null}

              {changeLines.map((line, index) => {
                const lineAccount =
                  changeAccounts.find((account) => paymentAccountKey(account) === line.accountKey) ?? firstChangeAccount;

                return (
                  <div
                    key={line.id}
                    className="grid gap-2 rounded-[8px] border border-sky-300/20 bg-[#0B0B0D]/70 p-3 lg:grid-cols-[minmax(210px,1.4fr)_minmax(130px,0.7fr)_minmax(120px,0.6fr)_auto]"
                  >
                    <label className="text-sm text-[#9FA0AA]">
                      Cuenta
                      <select
                        value={line.accountKey}
                        onChange={(event) => updateChangeLine(line.id, { accountKey: event.target.value })}
                        className="mt-1 w-full rounded-[8px] border border-[#303044] bg-[#111118] px-3 py-3 text-[#F5F5F7] outline-none focus:border-[#FEEF00]/70"
                      >
                        {changeAccounts.map((account) => (
                          <option key={paymentAccountKey(account)} value={paymentAccountKey(account)}>
                            {account.accountName} - {getPaymentMethodLabel(account.paymentMethodCode)}
                          </option>
                        ))}
                      </select>
                    </label>

                    <label className="text-sm text-[#9FA0AA]">
                      Monto {lineAccount?.currencyCode || ''}
                      <input
                        value={line.amount}
                        onChange={(event) => updateChangeLine(line.id, { amount: event.target.value })}
                        inputMode="decimal"
                        className="mt-1 w-full rounded-[8px] border border-[#303044] bg-[#111118] px-3 py-3 text-[#F5F5F7] outline-none focus:border-[#FEEF00]/70"
                      />
                      <button
                        type="button"
                        onClick={() => fillChangeLineWithExcess(line.id)}
                        className="mt-2 w-full rounded-full border border-sky-300/30 px-3 py-1.5 text-xs font-semibold text-sky-100 transition hover:bg-sky-400/10"
                      >
                        Cambio exacto
                      </button>
                    </label>

                    {lineAccount?.currencyCode === 'VES' ? (
                      <label className="text-sm text-[#9FA0AA]">
                        Tasa
                        <input
                          value={line.exchangeRate}
                          onChange={(event) => updateChangeLine(line.id, { exchangeRate: event.target.value })}
                          inputMode="decimal"
                          className="mt-1 w-full rounded-[8px] border border-[#303044] bg-[#111118] px-3 py-3 text-[#F5F5F7] outline-none focus:border-[#FEEF00]/70"
                        />
                      </label>
                    ) : (
                      <div className="hidden lg:block" />
                    )}

                    <div className="flex items-end">
                      <button
                        type="button"
                        onClick={() => setChangeLines((current) => current.filter((item) => item.id !== line.id))}
                        disabled={changeLines.length === 1}
                        className="w-full rounded-[8px] border border-red-400/40 px-3 py-3 text-sm font-semibold text-red-200 transition hover:bg-red-400/10 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        {index === 0 && changeLines.length === 1 ? 'Linea unica' : 'Quitar'}
                      </button>
                    </div>
                  </div>
                );
              })}

              {Math.abs(remainingAfterChangeUsd) > 0.005 ? (
                <div
                  className={[
                    'rounded-[8px] border px-3 py-2 text-sm',
                    remainingAfterChangeUsd > 0
                      ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-200'
                      : 'border-orange-400/40 bg-orange-400/10 text-orange-200',
                  ].join(' ')}
                >
                  {remainingAfterChangeUsd > 0
                    ? `Quedaran ${moneyUsd(remainingAfterChangeUsd)} en fondo del cliente.`
                    : `Se entrega ${moneyUsd(Math.abs(remainingAfterChangeUsd))} mas de lo debido; la orden quedara pendiente por ese monto.`}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="mt-4 flex justify-end">
        <button
          type="button"
          disabled={isWorking || paymentLines.length === 0}
          onClick={() =>
            onSubmit({
              paymentLines: paymentLines.map((line) => ({
                accountKey: line.accountKey,
                amount: line.amount,
                exchangeRate: line.exchangeRate,
                operationDate: line.operationDate,
                referenceCode: line.referenceCode,
                bankName: line.bankName,
                payerName: line.payerName,
                notes: line.notes,
              })),
              overpaymentHandling,
              changeLines: overpaymentHandling === 'change_given' ? changeLines : [],
            })
          }
          className="rounded-[8px] border border-[#FEEF00]/70 bg-[#FEEF00] px-5 py-3 text-sm font-bold text-black transition hover:bg-[#fff45c] disabled:cursor-wait disabled:opacity-60"
        >
          {isWorking ? 'Guardando...' : submitLabel}
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
    <div className="grid gap-2 sm:grid-cols-3">
      {items.map((item) => (
        <div key={item.label} className={['rounded-[8px] border px-3 py-2', stateClass[item.state]].join(' ')}>
          <div className="flex items-center gap-2">
            <span className={['h-2 w-2 rounded-full', dotClass[item.state]].join(' ')} />
            <span className="text-[10px] font-semibold uppercase tracking-[0.12em]">{item.label}</span>
          </div>
          <div className="mt-1 truncate text-xs font-semibold text-[#F5F5F7]">{item.detail}</div>
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
    <div className={['rounded-[8px] border px-3 py-2.5', toneClass].join(' ')}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#9FA0AA]">Accion actual</div>
          <h3 className="mt-1 text-sm font-semibold text-[#F5F5F7]">{action.title}</h3>
          <p className="mt-1 text-xs leading-relaxed text-[#C7C8D1]">{action.description}</p>
        </div>
        <span className={['rounded-full border px-3 py-1 text-xs font-semibold', badgeClass].join(' ')}>
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
