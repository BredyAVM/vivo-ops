'use client';

import { useEffect, useMemo, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { getOperationalStatusLabel, getPaymentMethodLabel } from '@/lib/orders/order-labels';
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
  createCounterQuickSaleAction,
  searchCounterAgendaAction,
  type CounterAgendaSearchResult,
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
  quickSaleProducts: CounterQuickSaleProductOption[];
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
};

type CounterFilter = 'all' | 'agenda' | 'kitchen' | 'pickup' | 'delivery' | 'route' | 'change' | 'pending' | 'paid';

const FILTERS: Array<{ key: CounterFilter; label: string }> = [
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

function fulfillmentLabel(value: CounterOrder['fulfillment']) {
  return value === 'delivery' ? 'Delivery' : 'Pickup';
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
  quickSaleProducts,
  activeBsRate,
}: CounterClientProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [workingOrderId, setWorkingOrderId] = useState<number | null>(null);
  const [message, setMessage] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const [localOrders, setLocalOrders] = useState(orders);
  const [filter, setFilter] = useState<CounterFilter>('all');
  const [search, setSearch] = useState('');
  const [selectedOrderId, setSelectedOrderId] = useState<number | null>(orders[0]?.id ?? null);
  const [quickSaleOpen, setQuickSaleOpen] = useState(false);
  const [masterAgendaSearch, setMasterAgendaSearch] = useState('');
  const [masterAgendaResults, setMasterAgendaResults] = useState<CounterAgendaSearchResult[]>([]);
  const [masterAgendaSearched, setMasterAgendaSearched] = useState(false);

  useEffect(() => {
    setLocalOrders(orders);
  }, [orders]);

  const stats = useMemo(() => {
    const pickup = localOrders.filter((order) => order.fulfillment === 'pickup').length;
    const delivery = localOrders.filter((order) => order.fulfillment === 'delivery').length;
    const agenda = localOrders.filter(isCounterAgendaOrder).length;
    const kitchen = localOrders.filter(isKitchenFollowUpOrder).length;
    const route = localOrders.filter((order) => order.status === 'out_for_delivery').length;
    const change = localOrders.filter((order) => order.paymentRequiresChange).length;
    const unassignedDelivery = localOrders.filter(
      (order) => order.fulfillment === 'delivery' && order.status === 'ready' && !order.deliveryAssigneeName
    ).length;
    const pendingUsd = localOrders.reduce((sum, order) => sum + Math.max(0, order.balanceUsd), 0);
    const paid = localOrders.filter((order) => order.balanceUsd <= 0.005).length;

    return {
      total: localOrders.length,
      pickup,
      delivery,
      agenda,
      kitchen,
      route,
      change,
      unassignedDelivery,
      pendingUsd,
      paid,
    };
  }, [localOrders]);

  const filteredOrders = useMemo(() => {
    const term = search.trim().toLocaleLowerCase('es-VE');

    return localOrders.filter((order) => {
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
        order.deliveryAddress,
      ]
        .filter(Boolean)
        .some((value) => String(value).toLocaleLowerCase('es-VE').includes(term));
    });
  }, [filter, localOrders, search]);

  const selectedOrder =
    localOrders.find((order) => order.id === selectedOrderId) ?? filteredOrders[0] ?? localOrders[0] ?? null;
  const orderSections = useMemo(() => {
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
      {
        key: 'counter-agenda',
        title: 'Agenda',
        helper: 'Pedidos agendados por mostrador, pendientes de master.',
        orders: filteredOrders.filter(isCounterAgendaOrder),
      },
      {
        key: 'kitchen-follow-up',
        title: 'En cocina',
        helper: 'Pedidos enviados a cocina, en cola o preparacion.',
        orders: filteredOrders.filter(isKitchenFollowUpOrder),
      },
      {
        key: 'pickup-ready',
        title: 'Pickup listo',
        helper: 'Cliente en mostrador o por retirar.',
        orders: filteredOrders.filter((order) => order.fulfillment === 'pickup' && order.status === 'ready'),
      },
      {
        key: 'delivery-ready',
        title: 'Delivery listo',
        helper: 'Entregar al motorizado y preparar cambio si aplica.',
        orders: filteredOrders.filter((order) => order.fulfillment === 'delivery' && order.status === 'ready'),
      },
      {
        key: 'delivery-route',
        title: 'En camino',
        helper: 'Liquidar cobro al regreso del motorizado.',
        orders: filteredOrders.filter((order) => order.status === 'out_for_delivery'),
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
    clientName: string;
    clientPhone: string;
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
    items: Array<{ productId: number; qty: number; notes?: string | null }>;
  }) {
    setMessage(null);
    setWorkingOrderId(-1);
    startTransition(async () => {
      try {
        const result = await createCounterQuickSaleAction(input);
        setMessage({
          tone: 'success',
          text: `Venta creada y enviada a cocina. Orden #${result.id}.`,
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
              onClick={() => setQuickSaleOpen((current) => !current)}
              className="rounded-full border border-[#FEEF00]/70 bg-[#FEEF00] px-4 py-2 text-sm font-bold text-black hover:bg-[#fff45c]"
            >
              Nueva venta
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
        <div className="grid gap-3 md:grid-cols-4 xl:grid-cols-9">
          <Summary label="Activos" value={String(stats.total)} />
          <Summary label="Agenda" value={String(stats.agenda)} tone={stats.agenda > 0 ? 'warn' : 'neutral'} />
          <Summary label="En cocina" value={String(stats.kitchen)} tone={stats.kitchen > 0 ? 'warn' : 'neutral'} />
          <Summary label="Pickup" value={String(stats.pickup)} />
          <Summary label="Delivery" value={String(stats.delivery)} />
          <Summary label="En camino" value={String(stats.route)} />
          <Summary label="Con cambio" value={String(stats.change)} tone={stats.change > 0 ? 'warn' : 'good'} />
          <Summary label="Sin driver" value={String(stats.unassignedDelivery)} tone={stats.unassignedDelivery > 0 ? 'warn' : 'good'} />
          <Summary label="Pagados" value={String(stats.paid)} tone="good" />
          <Summary label="Por cobrar" value={moneyUsd(stats.pendingUsd)} tone={stats.pendingUsd > 0 ? 'warn' : 'good'} />
        </div>

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

        {quickSaleOpen ? (
          <CounterQuickSalePanel
            products={quickSaleProducts}
            activeBsRate={activeBsRate}
            isWorking={workingOrderId === -1}
            onCancel={() => setQuickSaleOpen(false)}
            onSubmit={handleCreateQuickSale}
          />
        ) : null}

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
                    {item.label}
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
                            onSelect={() => setSelectedOrderId(order.id)}
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
            {selectedOrder ? (
              <OrderDetail
                order={selectedOrder}
                paymentAccounts={paymentAccounts}
                isWorking={workingOrderId === selectedOrder.id}
                onPrimaryDeliveryAction={handlePrimaryDeliveryAction}
                onCreatePaymentReport={handleCreatePaymentReport}
              />
            ) : (
              <div className="p-8 text-sm text-[#9FA0AA]">Selecciona un pedido listo para operar.</div>
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
        'w-full rounded-[8px] border p-3 text-left transition',
        selected
          ? 'border-[#FEEF00] bg-[#FEEF00]/8'
          : 'border-[#242433] bg-[#111118] hover:border-[#3D3D52]',
      ].join(' ')}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-base font-semibold">#{order.displayNumber}</span>
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
          <div className="mt-1 truncate text-sm font-semibold text-[#F5F5F7]">{order.clientName}</div>
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
    </button>
  );
}

function Summary({ label, value, tone = 'neutral' }: { label: string; value: string; tone?: 'neutral' | 'good' | 'warn' }) {
  const toneClass =
    tone === 'good' ? 'text-emerald-300' : tone === 'warn' ? 'text-orange-300' : 'text-[#F5F5F7]';

  return (
    <div className="rounded-[8px] border border-[#242433] bg-[#111118] p-4">
      <div className="text-sm text-[#9FA0AA]">{label}</div>
      <div className={['mt-1 text-xl font-semibold', toneClass].join(' ')}>{value}</div>
    </div>
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
    <section className="mt-5 rounded-[8px] border border-[#242433] bg-[#111118] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Consultar agenda master</h2>
          <p className="mt-1 text-sm text-[#9FA0AA]">
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

      <div className="mt-4 grid gap-2 md:grid-cols-[1fr_150px]">
        <input
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') onSearch();
          }}
          placeholder="Orden, cliente o telefono"
          className="rounded-[8px] border border-[#303044] bg-[#0B0B0D] px-4 py-3 text-sm outline-none placeholder:text-[#666878] focus:border-[#FEEF00]/70"
        />
        <button
          type="button"
          onClick={onSearch}
          disabled={isPending}
          className="rounded-[8px] border border-[#FEEF00]/70 bg-[#FEEF00] px-4 py-3 text-sm font-bold text-black transition hover:bg-[#fff45c] disabled:cursor-wait disabled:opacity-60"
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
  activeBsRate,
  isWorking,
  onCancel,
  onSubmit,
}: {
  products: CounterQuickSaleProductOption[];
  activeBsRate: number;
  isWorking: boolean;
  onCancel: () => void;
  onSubmit: (input: {
    clientName: string;
    clientPhone: string;
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
    items: Array<{ productId: number; qty: number; notes?: string | null }>;
  }) => void;
}) {
  const [clientName, setClientName] = useState('');
  const [clientPhone, setClientPhone] = useState('');
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
  const [productSearch, setProductSearch] = useState('');
  const [selectedProductId, setSelectedProductId] = useState(products[0]?.id ? String(products[0].id) : '');
  const [qty, setQty] = useState('1');
  const [itemNotes, setItemNotes] = useState('');
  const [cartItems, setCartItems] = useState<CounterQuickSaleCartItem[]>([]);
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    if (selectedProductId || !products[0]?.id) return;
    setSelectedProductId(String(products[0].id));
  }, [products, selectedProductId]);

  const productsById = useMemo(
    () => new Map(products.map((product) => [product.id, product])),
    [products]
  );
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
  const totals = useMemo(() => {
    const subtotalUsd = lineRows.reduce((sum, row) => sum + row.snapshot.lineUsd, 0);
    const subtotalBs = lineRows.reduce((sum, row) => sum + row.snapshot.lineBs, 0);
    return calculateOrderTotalsSnapshot({ subtotalUsd, subtotalBs, discountPct: 0, invoiceTaxPct: 0 });
  }, [lineRows]);

  function addCartItem() {
    const productId = Number(selectedProductId || 0);
    const product = productsById.get(productId);
    const itemQty = toDecimalInput(qty);

    if (!product) {
      setLocalError('Selecciona un producto valido.');
      return;
    }
    if (!Number.isFinite(itemQty) || itemQty <= 0) {
      setLocalError('Indica una cantidad valida.');
      return;
    }

    setCartItems((current) => [
      ...current,
      {
        id: `cart-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        productId,
        qty,
        notes: itemNotes.trim(),
      },
    ]);
    setQty('1');
    setItemNotes('');
    setLocalError(null);
  }

  function submitQuickSale() {
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
      clientName: clientName.trim(),
      clientPhone: clientPhone.trim(),
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
      items: cartItems.map((item) => ({
        productId: item.productId,
        qty: toDecimalInput(item.qty),
        notes: item.notes.trim() || null,
      })),
    });
  }

  return (
    <section className="mt-5 rounded-[8px] border border-[#FEEF00]/35 bg-[#15150F] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Nueva venta de mostrador</h2>
          <p className="mt-1 text-sm text-[#B9B9A8]">
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

      <div className="mt-4 grid gap-4 xl:grid-cols-[1fr_1.15fr_280px]">
        <div className="space-y-3 rounded-[8px] border border-[#242433] bg-[#0B0B0D] p-4">
          <h3 className="font-semibold">Cliente</h3>
          <label className="text-sm text-[#9FA0AA]">
            Nombre
            <input
              value={clientName}
              onChange={(event) => setClientName(event.target.value)}
              className="mt-1 w-full rounded-[8px] border border-[#303044] bg-[#111118] px-3 py-3 text-[#F5F5F7] outline-none focus:border-[#FEEF00]/70"
            />
          </label>
          <label className="text-sm text-[#9FA0AA]">
            Telefono
            <input
              value={clientPhone}
              onChange={(event) => setClientPhone(event.target.value)}
              inputMode="tel"
              className="mt-1 w-full rounded-[8px] border border-[#303044] bg-[#111118] px-3 py-3 text-[#F5F5F7] outline-none focus:border-[#FEEF00]/70"
            />
          </label>
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
                rows={3}
                className="mt-1 w-full resize-none rounded-[8px] border border-[#303044] bg-[#111118] px-3 py-3 text-[#F5F5F7] outline-none focus:border-[#FEEF00]/70"
              />
            </label>
          ) : null}
          <label className="text-sm text-[#9FA0AA]">
            Nota de orden
            <input
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="Opcional"
              className="mt-1 w-full rounded-[8px] border border-[#303044] bg-[#111118] px-3 py-3 text-[#F5F5F7] outline-none placeholder:text-[#666878] focus:border-[#FEEF00]/70"
            />
          </label>
          <div className="rounded-[8px] border border-[#303044] bg-[#111118] p-3">
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setScheduleMode('now')}
                className={[
                  'rounded-[8px] border px-3 py-2 text-sm font-semibold',
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
                  'rounded-[8px] border px-3 py-2 text-sm font-semibold',
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
                    className="mt-1 w-full rounded-[8px] border border-[#303044] bg-[#0B0B0D] px-3 py-3 text-[#F5F5F7] outline-none focus:border-[#FEEF00]/70"
                  />
                </label>
                <label className="text-sm text-[#9FA0AA]">
                  Hora
                  <input
                    type="time"
                    value={scheduledTime}
                    onChange={(event) => setScheduledTime(event.target.value)}
                    className="mt-1 w-full rounded-[8px] border border-[#303044] bg-[#0B0B0D] px-3 py-3 text-[#F5F5F7] outline-none focus:border-[#FEEF00]/70"
                  />
                </label>
              </div>
            ) : (
              <div className="mt-3 text-xs text-[#9FA0AA]">Se envia a cocina con la hora actual.</div>
            )}
          </div>
        </div>

        <div className="space-y-3 rounded-[8px] border border-[#242433] bg-[#0B0B0D] p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-semibold">Pedido</h3>
            <span className="text-sm font-semibold text-[#F5F5F7]">{cartItems.length} item(s)</span>
          </div>
          <div className="grid gap-2 md:grid-cols-[1fr_110px]">
            <input
              value={productSearch}
              onChange={(event) => setProductSearch(event.target.value)}
              placeholder="Buscar producto"
              className="rounded-[8px] border border-[#303044] bg-[#111118] px-3 py-3 text-[#F5F5F7] outline-none placeholder:text-[#666878] focus:border-[#FEEF00]/70"
            />
            <input
              value={qty}
              onChange={(event) => setQty(event.target.value)}
              inputMode="decimal"
              className="rounded-[8px] border border-[#303044] bg-[#111118] px-3 py-3 text-[#F5F5F7] outline-none focus:border-[#FEEF00]/70"
            />
          </div>
          <select
            value={selectedProductId}
            onChange={(event) => setSelectedProductId(event.target.value)}
            className="w-full rounded-[8px] border border-[#303044] bg-[#111118] px-3 py-3 text-[#F5F5F7] outline-none focus:border-[#FEEF00]/70"
          >
            {filteredProducts.map((product) => (
              <option key={product.id} value={String(product.id)}>
                {product.name} {product.sku ? `(${product.sku})` : ''}
              </option>
            ))}
          </select>
          <div className="grid gap-2 md:grid-cols-[1fr_130px]">
            <input
              value={itemNotes}
              onChange={(event) => setItemNotes(event.target.value)}
              placeholder="Nota del item (opcional)"
              className="rounded-[8px] border border-[#303044] bg-[#111118] px-3 py-3 text-[#F5F5F7] outline-none placeholder:text-[#666878] focus:border-[#FEEF00]/70"
            />
            <button
              type="button"
              onClick={addCartItem}
              disabled={products.length === 0 || activeBsRate <= 0}
              className="rounded-[8px] border border-[#FEEF00]/70 bg-[#FEEF00] px-4 py-3 text-sm font-bold text-black transition hover:bg-[#fff45c] disabled:cursor-not-allowed disabled:opacity-50"
            >
              Agregar
            </button>
          </div>

          <div className="max-h-[330px] overflow-y-auto rounded-[8px] border border-[#242433]">
            {lineRows.length === 0 ? (
              <div className="p-4 text-sm text-[#9FA0AA]">Sin productos agregados.</div>
            ) : (
              <div className="divide-y divide-[#242433]">
                {lineRows.map((row) => (
                  <div key={row.item.id} className="grid gap-2 p-3 sm:grid-cols-[60px_1fr_105px_auto]">
                    <div className="text-sm font-semibold text-[#FEEF00]">x{qtyLabel(row.qty)}</div>
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold">{row.product?.name || 'Producto'}</div>
                      {row.item.notes ? <div className="mt-1 text-xs text-[#9FA0AA]">{row.item.notes}</div> : null}
                    </div>
                    <div className="text-sm font-semibold sm:text-right">{moneyUsd(row.snapshot.lineUsd)}</div>
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
        </div>

        <div className="space-y-3 rounded-[8px] border border-[#242433] bg-[#0B0B0D] p-4">
          <h3 className="font-semibold">Pago esperado</h3>
          <label className="text-sm text-[#9FA0AA]">
            Metodo
            <select
              value={paymentMethod}
              onChange={(event) => setPaymentMethod(event.target.value)}
              className="mt-1 w-full rounded-[8px] border border-[#303044] bg-[#111118] px-3 py-3 text-[#F5F5F7] outline-none focus:border-[#FEEF00]/70"
            >
              {QUICK_SALE_PAYMENT_METHODS.map((method) => (
                <option key={method.code} value={method.code}>
                  {method.label}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm text-[#9FA0AA]">
            Moneda
            <select
              value={paymentCurrency}
              onChange={(event) => setPaymentCurrency(event.target.value === 'VES' ? 'VES' : 'USD')}
              className="mt-1 w-full rounded-[8px] border border-[#303044] bg-[#111118] px-3 py-3 text-[#F5F5F7] outline-none focus:border-[#FEEF00]/70"
            >
              <option value="VES">VES</option>
              <option value="USD">USD</option>
            </select>
          </label>
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
                className="rounded-[8px] border border-[#303044] bg-[#111118] px-3 py-3 text-[#F5F5F7] outline-none placeholder:text-[#666878] focus:border-[#FEEF00]/70"
              />
              <select
                value={paymentChangeCurrency}
                onChange={(event) => setPaymentChangeCurrency(event.target.value === 'VES' ? 'VES' : 'USD')}
                className="rounded-[8px] border border-[#303044] bg-[#111118] px-3 py-3 text-[#F5F5F7] outline-none focus:border-[#FEEF00]/70"
              >
                <option value="USD">USD</option>
                <option value="VES">VES</option>
              </select>
            </div>
          ) : null}
          <label className="text-sm text-[#9FA0AA]">
            Nota de pago
            <input
              value={paymentNote}
              onChange={(event) => setPaymentNote(event.target.value)}
              placeholder="Opcional"
              className="mt-1 w-full rounded-[8px] border border-[#303044] bg-[#111118] px-3 py-3 text-[#F5F5F7] outline-none placeholder:text-[#666878] focus:border-[#FEEF00]/70"
            />
          </label>

          <div className="rounded-[8px] border border-[#303044] bg-[#111118] p-4">
            <div className="text-sm text-[#9FA0AA]">Total</div>
            <div className="mt-1 text-2xl font-semibold">{moneyUsd(totals.totalUsd)}</div>
            <div className="mt-1 text-sm font-semibold text-[#C7C8D1]">{moneyBs(totals.totalBs)}</div>
          </div>

          <button
            type="button"
            onClick={submitQuickSale}
            disabled={isWorking || activeBsRate <= 0 || cartItems.length === 0}
            className="w-full rounded-[8px] border border-[#FEEF00]/70 bg-[#FEEF00] px-5 py-3 text-sm font-bold text-black transition hover:bg-[#fff45c] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isWorking ? 'Creando...' : 'Crear y enviar a cocina'}
          </button>
        </div>
      </div>
    </section>
  );
}

function OrderDetail({
  order,
  paymentAccounts,
  isWorking,
  onPrimaryDeliveryAction,
  onCreatePaymentReport,
}: {
  order: CounterOrder;
  paymentAccounts: CounterPaymentAccountOption[];
  isWorking: boolean;
  onPrimaryDeliveryAction: (order: CounterOrder) => void;
  onCreatePaymentReport: (order: CounterOrder, input: CounterPaymentReportInput) => void;
}) {
  const paid = order.balanceUsd <= 0.005;
  const isDeliverySettlement = order.fulfillment === 'delivery' && order.status === 'out_for_delivery';
  const deliveryReadyWithoutAssignee =
    order.fulfillment === 'delivery' && order.status === 'ready' && !order.deliveryAssigneeName;
  const waitingForMaster = order.status === 'created';
  const notReadyForCounter = waitingForMaster || order.status === 'confirmed' || order.status === 'in_kitchen';
  const hasPendingBalance = order.balanceUsd > 0.005;
  const hasPendingReports = order.reports.pending > 0;
  const primaryActionBlocked =
    notReadyForCounter || deliveryReadyWithoutAssignee || (isDeliverySettlement && (hasPendingBalance || hasPendingReports));
  const primaryActionBlockedMessage = waitingForMaster
    ? 'Esta orden quedo agendada. Master debe enviarla a cocina cuando corresponda.'
    : notReadyForCounter
      ? 'Esta orden aun esta en cocina. Cuando quede lista aparecera para entrega.'
    : deliveryReadyWithoutAssignee
      ? 'Este delivery no tiene motorizado o partner asignado. Asignalo desde master antes de entregarlo.'
      : hasPendingBalance
        ? 'Primero registra el cobro recibido del motorizado.'
        : 'Hay pagos pendientes de revision antes de cerrar la entrega.';
  const [paymentOpen, setPaymentOpen] = useState(false);

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
            <div className="mt-1 text-sm text-[#9FA0AA]">Lista: {formatDateTime(order.readyAt)}</div>
          </div>
          <span className={['rounded-full border px-3 py-1 text-sm font-semibold', paymentClass(order)].join(' ')}>
            {paymentLabel(order)}
          </span>
        </div>
      </div>

      <div className="grid gap-4 p-5 xl:grid-cols-[1fr_260px]">
        <div className="space-y-4">
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

          <div className="rounded-[8px] border border-[#242433] bg-[#0B0B0D] p-4">
            <h3 className="font-semibold">Pedido</h3>
            <div className="mt-3 divide-y divide-[#242433]">
              {order.items.length === 0 ? (
                <div className="py-3 text-sm text-[#9FA0AA]">Sin items cargados.</div>
              ) : (
                order.items.map((item) => (
                  <div key={item.id} className="grid gap-2 py-3 sm:grid-cols-[70px_1fr_100px]">
                    <div className="text-sm font-semibold text-[#FEEF00]">x{qtyLabel(item.qty)}</div>
                    <div>
                      <div className="text-sm font-semibold">{item.name}</div>
                      {item.notes ? <div className="mt-1 text-xs text-[#9FA0AA]">{item.notes}</div> : null}
                    </div>
                    <div className="text-left text-sm font-semibold sm:text-right">{moneyUsd(item.lineTotalUsd)}</div>
                  </div>
                ))
              )}
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

        <aside className="space-y-3">
          <button
            type="button"
            onClick={() => onPrimaryDeliveryAction(order)}
            disabled={isWorking || primaryActionBlocked}
            className="w-full rounded-[8px] border border-[#FEEF00]/70 bg-[#FEEF00] px-4 py-3 text-sm font-bold text-black transition hover:bg-[#fff45c] disabled:cursor-not-allowed disabled:opacity-60"
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
            className="w-full rounded-[8px] border border-[#303044] bg-[#0B0B0D] px-4 py-3 text-sm font-semibold text-[#F5F5F7] transition hover:border-[#FEEF00]/60"
          >
            {paymentOpen ? 'Ocultar pago' : isDeliverySettlement ? 'Registrar retorno / cobro' : 'Registrar pago'}
          </button>
          {order.paymentRequiresChange ? (
            <ActionHint
              title="Preparar cambio"
              text={`Cambio para ${order.paymentChangeFor || '-'} ${order.paymentChangeCurrency || ''}. El egreso se registra al liquidar el cobro.`}
              tone="warn"
            />
          ) : null}
          <ActionHint
            title="Agregar productos"
            text="Pendiente del siguiente bloque: ampliar o modificar la orden desde mostrador."
          />
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
          <h3 className="font-semibold">Registrar pago recibido</h3>
          <p className="mt-1 text-sm text-[#9FA0AA]">
            Caja y punto se confirman al guardar. Transferencias y pagos remotos quedan para revision.
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
          {isWorking ? 'Guardando...' : 'Reportar pago'}
        </button>
      </div>
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
    <div className="rounded-[8px] border border-[#242433] bg-[#0B0B0D] p-4">
      <div className="text-sm text-[#9FA0AA]">{label}</div>
      <div className={['mt-1 text-lg font-semibold', toneClass].join(' ')}>{value}</div>
      {note ? <div className="mt-1 text-xs text-[#9FA0AA]">{note}</div> : null}
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
