'use client';

import { useEffect, useMemo, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { getOperationalStatusLabel, getPaymentMethodLabel } from '@/lib/orders/order-labels';
import { getPaymentReportRequirements, validatePaymentReportDetails } from '@/lib/payments/payment-report-rules';
import { ModulePreference } from '../ModulePreference';
import {
  confirmPaymentReportAction,
  createPaymentReportAction,
  markDeliveredAction,
  outForDeliveryAction,
} from '../master/dashboard/actions';

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
  status: 'ready' | 'out_for_delivery';
  fulfillment: 'pickup' | 'delivery';
  clientName: string;
  clientPhone: string | null;
  deliveryAddress: string | null;
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

type CounterFilter = 'all' | 'pickup' | 'delivery' | 'route' | 'pending' | 'paid';

const FILTERS: Array<{ key: CounterFilter; label: string }> = [
  { key: 'all', label: 'Todos' },
  { key: 'pickup', label: 'Pickup' },
  { key: 'delivery', label: 'Delivery' },
  { key: 'route', label: 'En camino' },
  { key: 'pending', label: 'Por cobrar' },
  { key: 'paid', label: 'Pagados' },
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
  return 'border-[#FEEF00]/50 bg-[#FEEF00]/10 text-[#FEEF00]';
}

function primaryCounterActionLabel(order: CounterOrder) {
  if (order.fulfillment === 'delivery' && order.status === 'ready') return 'Entregar a motorizado';
  if (order.fulfillment === 'delivery' && order.status === 'out_for_delivery') return 'Marcar entregada';
  return 'Entregar pickup';
}

function scheduleLabel(order: CounterOrder) {
  if (order.scheduledDate && order.scheduledTime) return `${order.scheduledDate} - ${order.scheduledTime}`;
  if (order.scheduledDate) return order.scheduledDate;
  return formatDateTime(order.createdAt);
}

export default function CounterClient({ fullName, orders, paymentAccounts }: CounterClientProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [workingOrderId, setWorkingOrderId] = useState<number | null>(null);
  const [message, setMessage] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const [localOrders, setLocalOrders] = useState(orders);
  const [filter, setFilter] = useState<CounterFilter>('all');
  const [search, setSearch] = useState('');
  const [selectedOrderId, setSelectedOrderId] = useState<number | null>(orders[0]?.id ?? null);

  useEffect(() => {
    setLocalOrders(orders);
  }, [orders]);

  const stats = useMemo(() => {
    const pickup = localOrders.filter((order) => order.fulfillment === 'pickup').length;
    const delivery = localOrders.filter((order) => order.fulfillment === 'delivery').length;
    const route = localOrders.filter((order) => order.status === 'out_for_delivery').length;
    const pendingUsd = localOrders.reduce((sum, order) => sum + Math.max(0, order.balanceUsd), 0);
    const paid = localOrders.filter((order) => order.balanceUsd <= 0.005).length;

    return {
      total: localOrders.length,
      pickup,
      delivery,
      route,
      pendingUsd,
      paid,
    };
  }, [localOrders]);

  const filteredOrders = useMemo(() => {
    const term = search.trim().toLocaleLowerCase('es-VE');

    return localOrders.filter((order) => {
      if (filter === 'pickup' && order.fulfillment !== 'pickup') return false;
      if (filter === 'delivery' && order.fulfillment !== 'delivery') return false;
      if (filter === 'route' && order.status !== 'out_for_delivery') return false;
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
        <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-6">
          <Summary label="Activos" value={String(stats.total)} />
          <Summary label="Pickup" value={String(stats.pickup)} />
          <Summary label="Delivery" value={String(stats.delivery)} />
          <Summary label="En camino" value={String(stats.route)} />
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
                <div className="space-y-2">
                  {filteredOrders.map((order) => (
                    <button
                      key={order.id}
                      type="button"
                      onClick={() => setSelectedOrderId(order.id)}
                      className={[
                        'w-full rounded-[8px] border p-3 text-left transition',
                        selectedOrder?.id === order.id
                          ? 'border-[#FEEF00] bg-[#FEEF00]/8'
                          : 'border-[#242433] bg-[#0B0B0D] hover:border-[#3D3D52]',
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
              <div className="mt-2 text-sm text-[#C7C8D1]">{order.deliveryAddress || 'Sin direccion'}</div>
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
            disabled={isWorking}
            className="w-full rounded-[8px] border border-[#FEEF00]/70 bg-[#FEEF00] px-4 py-3 text-sm font-bold text-black transition hover:bg-[#fff45c] disabled:cursor-wait disabled:opacity-60"
          >
            {isWorking ? 'Guardando...' : primaryCounterActionLabel(order)}
          </button>
          <button
            type="button"
            onClick={() => setPaymentOpen((current) => !current)}
            className="w-full rounded-[8px] border border-[#303044] bg-[#0B0B0D] px-4 py-3 text-sm font-semibold text-[#F5F5F7] transition hover:border-[#FEEF00]/60"
          >
            {paymentOpen ? 'Ocultar pago' : 'Registrar pago'}
          </button>
          <ActionButton label="Dar cambio" />
          <ActionButton label="Agregar producto" />
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

function ActionButton({ label }: { label: string }) {
  return (
    <button
      type="button"
      disabled
      className="w-full rounded-[8px] border border-[#303044] bg-[#0B0B0D] px-4 py-3 text-sm font-semibold text-[#777987]"
    >
      {label}
    </button>
  );
}
