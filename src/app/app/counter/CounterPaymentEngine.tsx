'use client';

import { useMemo, useRef, useState, type ReactNode } from 'react';
import { getPaymentMethodLabel } from '@/lib/orders/order-labels';
import {
  getPaymentReportRequirements,
  validatePaymentReportDetails,
} from '@/lib/payments/payment-report-rules';
import type {
  CounterOrder,
  CounterPaymentAccountOption,
} from './CounterClient';
import type {
  CounterChangeLineInput,
  CounterPaymentIntent,
  CounterPaymentOperationResult,
} from './payment-contract';

type PaymentDraft = {
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

type ChangeDraft = {
  id: string;
  mode: 'cash' | 'digital_pending';
  optionKey: string;
  amount: string;
  exchangeRate: string;
  notes: string;
};

type DigitalChangeOption = {
  key: string;
  paymentMethod: string;
  currencyCode: 'USD' | 'VES';
  label: string;
};

const PAYMENT_METHOD_PRIORITY = [
  'pos',
  'cash_usd',
  'cash_ves',
  'payment_mobile',
  'transfer',
  'zelle',
  'wallet_usd',
] as const;

function paymentAccountKey(account: CounterPaymentAccountOption) {
  return `${account.accountId}|${account.paymentMethodCode}`;
}

function paymentMethodPriority(method: string) {
  const index = PAYMENT_METHOD_PRIORITY.indexOf(
    method as (typeof PAYMENT_METHOD_PRIORITY)[number]
  );
  return index < 0 ? PAYMENT_METHOD_PRIORITY.length : index;
}

function isImmediateAccount(account: CounterPaymentAccountOption | null) {
  return Boolean(
    account
    && account.canConfirmPayment
    && account.autoConfirmsReport
    && !account.reviewRequired
  );
}

function paymentDestinationLabel(method: string) {
  if (method === 'pos') return 'Punto utilizado';
  if (method === 'cash_usd' || method === 'cash_ves') return 'Caja';
  return 'Cuenta receptora';
}

function decimal(value: string) {
  return Number(String(value || '').replace(',', '.'));
}

function roundMoney(value: number) {
  return Number((Number.isFinite(value) ? value : 0).toFixed(2));
}

function amountUsd(amount: number, currency: 'USD' | 'VES', exchangeRate: number | null) {
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  if (currency === 'USD') return amount;
  if (!exchangeRate || !Number.isFinite(exchangeRate) || exchangeRate <= 0) return 0;
  return amount / exchangeRate;
}

function moneyUsd(value: number) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
  }).format(Number(value || 0));
}

function todayCaracas() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Caracas',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function nativeAmount(currency: 'USD' | 'VES', usd: number, rate: number) {
  return currency === 'VES'
    ? roundMoney(Math.max(0, usd) * Math.max(rate, 0)).toFixed(2)
    : roundMoney(Math.max(0, usd)).toFixed(2);
}

function isDirectCashAccount(account: CounterPaymentAccountOption) {
  if (account.accountKind !== 'cash') return false;
  return account.canConfirmPayment && account.autoConfirmsReport && !account.reviewRequired;
}

export function CounterPaymentEngine({
  order,
  paymentAccounts,
  isWorking,
  onSubmit,
}: {
  order: CounterOrder;
  paymentAccounts: CounterPaymentAccountOption[];
  isWorking: boolean;
  onSubmit: (intent: CounterPaymentIntent) => Promise<CounterPaymentOperationResult>;
}) {
  const reportAccounts = useMemo(() => (
    paymentAccounts
      .filter((account) => account.canReportPayment)
      .sort((left, right) => {
        const methodOrder =
          paymentMethodPriority(left.paymentMethodCode)
          - paymentMethodPriority(right.paymentMethodCode);
        return methodOrder || left.accountName.localeCompare(right.accountName, 'es');
      })
  ), [paymentAccounts]);
  const cashChangeAccounts = useMemo(
    () => paymentAccounts.filter(isDirectCashAccount),
    [paymentAccounts]
  );
  const digitalChangeOptions = useMemo(() => {
    const unique = new Map<string, DigitalChangeOption>();
    for (const account of paymentAccounts) {
      if (account.autoConfirmsReport || account.accountKind === 'cash' || account.accountKind === 'pos') {
        continue;
      }
      const key = `${account.paymentMethodCode}|${account.currencyCode}`;
      if (unique.has(key)) continue;
      unique.set(key, {
        key,
        paymentMethod: account.paymentMethodCode,
        currencyCode: account.currencyCode,
        label: `${getPaymentMethodLabel(account.paymentMethodCode)} ${account.currencyCode}`,
      });
    }
    return Array.from(unique.values());
  }, [paymentAccounts]);

  const paymentMethods = useMemo(() => {
    const unique = Array.from(new Set(reportAccounts.map((account) => account.paymentMethodCode)));
    return unique.sort((left, right) => {
      const leftExpected = left === order.paymentMethod ? 1 : 0;
      const rightExpected = right === order.paymentMethod ? 1 : 0;
      return (
        rightExpected - leftExpected
        || paymentMethodPriority(left) - paymentMethodPriority(right)
        || getPaymentMethodLabel(left).localeCompare(getPaymentMethodLabel(right), 'es')
      );
    });
  }, [order.paymentMethod, reportAccounts]);
  const expectedAccount =
    reportAccounts.find((account) => account.paymentMethodCode === order.paymentMethod) ?? null;
  const firstAccount =
    expectedAccount
    ?? reportAccounts.find((account) => account.paymentMethodCode === 'pos')
    ?? reportAccounts[0]
    ?? null;
  const firstCashChangeAccount = cashChangeAccounts[0] ?? null;
  const firstDigitalChange = digitalChangeOptions[0] ?? null;
  const nextPaymentId = useRef(2);
  const nextChangeId = useRef(1);
  const idempotencyKey = useRef<string | null>(null);
  const [paymentLines, setPaymentLines] = useState<PaymentDraft[]>(() =>
    firstAccount
      ? [{
          id: 'payment-1',
          accountKey: paymentAccountKey(firstAccount),
          amount: nativeAmount(firstAccount.currencyCode, order.balanceUsd, order.fxRate),
          exchangeRate: firstAccount.currencyCode === 'VES' ? String(roundMoney(order.fxRate)) : '',
          operationDate: todayCaracas(),
          referenceCode: '',
          bankName: '',
          payerName: '',
          notes: '',
        }]
      : []
  );
  const [changeLines, setChangeLines] = useState<ChangeDraft[]>([]);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<CounterPaymentOperationResult | null>(null);
  const [fundRemainderAccepted, setFundRemainderAccepted] = useState(false);

  function invalidateIntent() {
    idempotencyKey.current = null;
    setReviewOpen(false);
    setReceipt(null);
    setError(null);
    setFundRemainderAccepted(false);
  }

  function accountForPayment(line: PaymentDraft) {
    return reportAccounts.find((account) => paymentAccountKey(account) === line.accountKey) ?? null;
  }

  function accountsForMethod(method: string) {
    return reportAccounts.filter((account) => account.paymentMethodCode === method);
  }

  function changeOption(line: ChangeDraft) {
    if (line.mode === 'cash') {
      const account =
        cashChangeAccounts.find((item) => paymentAccountKey(item) === line.optionKey) ?? null;
      return account
        ? {
            currencyCode: account.currencyCode,
            paymentMethod: account.paymentMethodCode,
            account,
          }
        : null;
    }
    const option = digitalChangeOptions.find((item) => item.key === line.optionKey) ?? null;
    return option
      ? {
          currencyCode: option.currencyCode,
          paymentMethod: option.paymentMethod,
          account: null,
        }
      : null;
  }

  const paymentSummary = paymentLines.reduce(
    (summary, line) => {
      const account = accountForPayment(line);
      const amount = decimal(line.amount);
      const rate = account?.currencyCode === 'VES' ? decimal(line.exchangeRate) : null;
      if (!account) return summary;
      const usd = amountUsd(amount, account.currencyCode, rate);
      summary.reported += usd;
      if (account.canConfirmPayment && account.autoConfirmsReport && !account.reviewRequired) {
        summary.confirmed += usd;
      } else {
        summary.pending += usd;
      }
      return summary;
    },
    { reported: 0, confirmed: 0, pending: 0 }
  );

  const changeSummary = changeLines.reduce(
    (summary, line) => {
      const option = changeOption(line);
      if (!option) return summary;
      const amount = decimal(line.amount);
      const rate = option.currencyCode === 'VES' ? decimal(line.exchangeRate) : null;
      const usd = amountUsd(amount, option.currencyCode, rate);
      if (line.mode === 'cash') summary.cash += usd;
      else summary.digital += usd;
      return summary;
    },
    { cash: 0, digital: 0 }
  );

  const totalChangeUsd = roundMoney(changeSummary.cash + changeSummary.digital);
  const registeredNetUsd = roundMoney(paymentSummary.reported - totalChangeUsd);
  const remainingToRegisterUsd = Math.max(0, roundMoney(order.balanceUsd - registeredNetUsd));
  const unallocatedOverpaymentUsd = Math.max(0, roundMoney(registeredNetUsd - order.balanceUsd));
  const projectedNetConfirmedUsd = roundMoney(paymentSummary.confirmed - totalChangeUsd);
  const projectedPendingUsd = Math.max(0, roundMoney(order.balanceUsd - projectedNetConfirmedUsd));
  const projectedOverpaidUsd = Math.max(0, roundMoney(projectedNetConfirmedUsd - order.balanceUsd));
  const fundCreditUsd = fundRemainderAccepted ? projectedOverpaidUsd : 0;
  const firstPaymentLine = paymentLines[0] ?? null;
  const firstPaymentAccount = firstPaymentLine ? accountForPayment(firstPaymentLine) : null;
  const selectedMethod = firstPaymentAccount?.paymentMethodCode ?? '';
  const expectedMethodIsSpecific =
    Boolean(order.paymentMethod)
    && order.paymentMethod !== 'mixed'
    && order.paymentMethod !== 'pending';
  const expectedMethodChanged =
    expectedMethodIsSpecific
    && Boolean(selectedMethod)
    && selectedMethod !== order.paymentMethod;
  const canStoreOverpaymentAsFund =
    projectedOverpaidUsd + 0.005 >= unallocatedOverpaymentUsd;

  function addPaymentLine() {
    invalidateIntent();
    if (!firstAccount) return;
    const remaining = remainingToRegisterUsd;
    const id = `payment-${nextPaymentId.current}`;
    nextPaymentId.current += 1;
    setPaymentLines((current) => [...current, {
      id,
      accountKey: paymentAccountKey(firstAccount),
      amount: nativeAmount(firstAccount.currencyCode, remaining, order.fxRate),
      exchangeRate: firstAccount.currencyCode === 'VES' ? String(roundMoney(order.fxRate)) : '',
      operationDate: todayCaracas(),
      referenceCode: '',
      bankName: '',
      payerName: '',
      notes: '',
    }]);
  }

  function selectPaymentMethod(id: string, method: string) {
    const account = accountsForMethod(method)[0] ?? null;
    if (!account) return;
    invalidateIntent();
    setPaymentLines((current) => current.map((line) => {
      if (line.id !== id) return line;
      const currentAccount = accountForPayment(line);
      const currentUsd = currentAccount
        ? amountUsd(
            decimal(line.amount),
            currentAccount.currencyCode,
            currentAccount.currencyCode === 'VES' ? decimal(line.exchangeRate) : null
          )
        : remainingToRegisterUsd;
      const suggestedUsd = currentUsd > 0 ? currentUsd : remainingToRegisterUsd;
      return {
        ...line,
        accountKey: paymentAccountKey(account),
        amount: nativeAmount(account.currencyCode, suggestedUsd, order.fxRate),
        exchangeRate: account.currencyCode === 'VES' ? String(roundMoney(order.fxRate)) : '',
        operationDate: todayCaracas(),
        referenceCode: '',
        bankName: '',
        payerName: '',
        notes: '',
      };
    }));
  }

  function updatePaymentLine(id: string, patch: Partial<PaymentDraft>) {
    invalidateIntent();
    setPaymentLines((current) => current.map((line) => {
      if (line.id !== id) return line;
      const next = { ...line, ...patch };
      if (patch.accountKey) {
        const account =
          reportAccounts.find((item) => paymentAccountKey(item) === patch.accountKey) ?? null;
        next.exchangeRate = account?.currencyCode === 'VES' ? String(roundMoney(order.fxRate)) : '';
      }
      return next;
    }));
  }

  function addChangeLine(
    mode: 'cash' | 'digital_pending',
    suggestedUsd = 0,
    preferredCurrency?: 'USD' | 'VES'
  ) {
    invalidateIntent();
    const cashAccount =
      cashChangeAccounts.find((account) => account.currencyCode === preferredCurrency)
      ?? firstCashChangeAccount;
    const digitalOption =
      digitalChangeOptions.find((option) => option.currencyCode === preferredCurrency)
      ?? firstDigitalChange;
    const optionKey =
      mode === 'cash'
        ? cashAccount ? paymentAccountKey(cashAccount) : ''
        : digitalOption?.key ?? '';
    if (!optionKey) {
      setError(
        mode === 'cash'
          ? 'No hay una caja DAR habilitada para entregar cambio.'
          : 'No hay un metodo digital habilitado para registrar cambio pendiente.'
      );
      return;
    }
    const currencyCode =
      mode === 'cash'
        ? cashAccount?.currencyCode ?? 'USD'
        : digitalOption?.currencyCode ?? 'USD';
    const id = `change-${nextChangeId.current}`;
    nextChangeId.current += 1;
    setChangeLines((current) => [...current, {
      id,
      mode,
      optionKey,
      amount: suggestedUsd > 0
        ? nativeAmount(currencyCode, suggestedUsd, order.fxRate)
        : '',
      exchangeRate: String(roundMoney(order.fxRate)),
      notes: '',
    }]);
  }

  function acceptFundRemainder() {
    idempotencyKey.current = null;
    setReviewOpen(false);
    setReceipt(null);
    setError(null);
    setFundRemainderAccepted(true);
  }

  function updateChangeLine(id: string, patch: Partial<ChangeDraft>) {
    invalidateIntent();
    setChangeLines((current) => current.map((line) => {
      if (line.id !== id) return line;
      const next = { ...line, ...patch };
      if (patch.mode) {
        next.optionKey =
          patch.mode === 'cash'
            ? firstCashChangeAccount ? paymentAccountKey(firstCashChangeAccount) : ''
            : firstDigitalChange?.key ?? '';
      }
      if (patch.optionKey || patch.mode) {
        const option = (() => {
          if (next.mode === 'cash') {
            return cashChangeAccounts.find((item) => paymentAccountKey(item) === next.optionKey) ?? null;
          }
          return digitalChangeOptions.find((item) => item.key === next.optionKey) ?? null;
        })();
        next.exchangeRate = option?.currencyCode === 'VES' ? String(roundMoney(order.fxRate)) : '';
      }
      return next;
    }));
  }

  function buildIntent(): CounterPaymentIntent | null {
    if (paymentLines.length < 1) {
      setError('Agrega al menos una linea de pago.');
      return null;
    }

    const preparedPayments: CounterPaymentIntent['paymentLines'] = [];
    for (const line of paymentLines) {
      const account = accountForPayment(line);
      const amount = decimal(line.amount);
      const rate = account?.currencyCode === 'VES' ? decimal(line.exchangeRate) : null;
      if (!account || !Number.isFinite(amount) || amount <= 0) {
        setError('Revisa la cuenta y el monto de cada linea de pago.');
        return null;
      }
      if (account.currencyCode === 'VES' && (!rate || rate <= 0)) {
        setError('Indica una tasa valida para cada pago en bolivares.');
        return null;
      }
      const validationError = validatePaymentReportDetails({
        method: account.paymentMethodCode,
        operationDate: line.operationDate,
        referenceCode: line.referenceCode.trim(),
        bankName: line.bankName.trim(),
        holderName: line.payerName.trim(),
      });
      if (validationError) {
        setError(validationError);
        return null;
      }
      preparedPayments.push({
        lineKey: line.id,
        moneyAccountId: account.accountId,
        paymentMethod: account.paymentMethodCode,
        currencyCode: account.currencyCode,
        amount: roundMoney(amount),
        exchangeRateVesPerUsd: account.currencyCode === 'VES' ? rate : null,
        operationDate: line.operationDate,
        referenceCode: line.referenceCode.trim() || null,
        bankName: line.bankName.trim() || null,
        payerName: line.payerName.trim() || null,
        notes: line.notes.trim() || null,
      });
    }

    const preparedChange: CounterChangeLineInput[] = [];
    if (changeLines.length > 0) {
      if (changeLines.length < 1) {
        setError('Agrega al menos una linea de cambio.');
        return null;
      }
      for (const line of changeLines) {
        const option = changeOption(line);
        const amount = decimal(line.amount);
        const rate = option?.currencyCode === 'VES' ? decimal(line.exchangeRate) : null;
        if (!option || !Number.isFinite(amount) || amount <= 0) {
          setError('Revisa el metodo y el monto de cada linea de cambio.');
          return null;
        }
        if (option.currencyCode === 'VES' && (!rate || rate <= 0)) {
          setError('Indica una tasa valida para cada cambio en bolivares.');
          return null;
        }
        preparedChange.push({
          lineKey: line.id,
          changeMode: line.mode,
          moneyAccountId: option.account?.accountId ?? null,
          paymentMethod: line.mode === 'digital_pending' ? option.paymentMethod : null,
          currencyCode: option.currencyCode,
          amount: roundMoney(amount),
          exchangeRateVesPerUsd: option.currencyCode === 'VES' ? rate : null,
          notes: line.notes.trim() || null,
        });
      }
    }

    if (totalChangeUsd > paymentSummary.confirmed + 0.01) {
      setError('El cambio no puede superar el efectivo o punto confirmado en esta operacion.');
      return null;
    }

    if (unallocatedOverpaymentUsd > 0.005 && !fundRemainderAccepted) {
      setError(
        `Falta decidir que hacer con ${moneyUsd(unallocatedOverpaymentUsd)}: entregar cambio o guardarlo como saldo a favor.`
      );
      return null;
    }
    if (fundRemainderAccepted && !canStoreOverpaymentAsFund) {
      setError('Solo el dinero confirmado puede guardarse como saldo a favor.');
      return null;
    }

    const handling =
      preparedChange.length > 0
        ? 'change_given'
        : fundRemainderAccepted && paymentSummary.confirmed > order.balanceUsd + 0.005
          ? 'store_fund'
          : null;

    setError(null);
    return {
      idempotencyKey: idempotencyKey.current ?? '',
      orderId: order.id,
      paymentLines: preparedPayments,
      overpaymentHandling: handling,
      changeLines: preparedChange,
      notes: null,
    };
  }

  function openReview() {
    if (!buildIntent()) return;
    setReviewOpen(true);
  }

  async function confirmIntent() {
    const intent = buildIntent();
    if (!intent) return;
    if (!idempotencyKey.current) idempotencyKey.current = crypto.randomUUID();

    try {
      const result = await onSubmit({
        ...intent,
        idempotencyKey: idempotencyKey.current,
      });
      setReceipt(result);
      setReviewOpen(false);
      setError(null);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'No se pudo registrar el cobro.');
    }
  }

  if (reportAccounts.length === 0) {
    return (
      <div className="rounded-[8px] border border-orange-400/40 bg-orange-400/10 p-4 text-sm text-orange-200">
        No hay cuentas habilitadas para registrar pagos desde mostrador.
      </div>
    );
  }

  if (receipt) {
    return (
      <div className="rounded-[8px] border border-emerald-400/35 bg-emerald-400/10 p-4">
        <div className="text-base font-semibold text-emerald-100">Cobro registrado</div>
        <div className="mt-1 text-xs text-emerald-100/70">
          Comprobante {receipt.idempotencyKey.slice(0, 8).toUpperCase()} · Orden #{order.displayNumber}
        </div>
        <div className="mt-3 rounded-[8px] border border-emerald-300/20 bg-black/15 px-3 py-2 text-sm text-emerald-50">
          {receipt.pendingPaymentUsd > 0.005
            ? `${moneyUsd(receipt.pendingPaymentUsd)} quedó enviado a Master para confirmación.`
            : receipt.pendingUsd > 0.005
              ? `La operación quedó registrada y todavía faltan ${moneyUsd(receipt.pendingUsd)} por cobrar.`
              : 'El pago quedó confirmado. Ya puedes continuar con la entrega del pickup.'}
        </div>
        <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <ReceiptMetric label="Confirmado" value={moneyUsd(receipt.confirmedPaymentUsd)} />
          <ReceiptMetric label="Master revisa" value={moneyUsd(receipt.pendingPaymentUsd)} />
          <ReceiptMetric label="Cambio entregado" value={moneyUsd(receipt.cashChangeUsd)} />
          <ReceiptMetric label="Saldo pendiente" value={moneyUsd(receipt.pendingUsd)} />
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-[8px] border border-[#242433] bg-[#0B0B0D] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold">Cobrar pedido</h3>
          <p className="mt-1 text-sm text-[#9FA0AA]">
            Elige cómo pagó el cliente. Solo verás las cuentas necesarias para ese método.
          </p>
        </div>
      </div>

      <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <ReceiptMetric label="Falta por cobrar" value={moneyUsd(order.balanceUsd)} />
        <ReceiptMetric label="Registrado ahora" value={moneyUsd(registeredNetUsd)} />
        <ReceiptMetric label="Falta registrar" value={moneyUsd(remainingToRegisterUsd)} />
        <ReceiptMetric label="Master debe revisar" value={moneyUsd(paymentSummary.pending)} />
      </div>

      {firstPaymentLine ? (
        <div className="mt-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="text-sm font-semibold">¿Cómo está pagando?</div>
              <div className="mt-1 text-xs text-[#9FA0AA]">
                Método esperado: {getPaymentMethodLabel(order.paymentMethod || 'pending')}
              </div>
            </div>
            {paymentLines.length > 1 ? (
              <span className="rounded-full border border-sky-300/30 bg-sky-300/10 px-3 py-1 text-xs font-semibold text-sky-100">
                Pago mixto · {paymentLines.length} métodos
              </span>
            ) : null}
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2 lg:grid-cols-4">
            {paymentMethods.map((method) => {
              const methodAccount = accountsForMethod(method)[0] ?? null;
              const selected = selectedMethod === method;
              return (
                <button
                  key={method}
                  type="button"
                  onClick={() => selectPaymentMethod(firstPaymentLine.id, method)}
                  disabled={isWorking}
                  className={[
                    'min-h-16 rounded-[8px] border px-3 py-2 text-left transition disabled:opacity-50',
                    selected
                      ? 'border-[#FEEF00] bg-[#FEEF00] text-black'
                      : 'border-[#303044] bg-[#111118] text-[#F5F5F7] hover:border-[#FEEF00]/60',
                  ].join(' ')}
                >
                  <span className="block text-sm font-bold">{getPaymentMethodLabel(method)}</span>
                  <span className={['mt-1 block text-[11px]', selected ? 'text-black/65' : 'text-[#9FA0AA]'].join(' ')}>
                    {isImmediateAccount(methodAccount) ? 'Se confirma al cobrar' : 'Master confirma'}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      ) : null}

      <div className="mt-4 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div className="text-xs font-semibold uppercase tracking-[0.12em] text-[#9FA0AA]">
            {paymentLines.length > 1 ? 'Métodos registrados' : 'Datos del cobro'}
          </div>
          <button
            type="button"
            onClick={addPaymentLine}
            className="rounded-full border border-[#FEEF00]/50 bg-[#FEEF00]/10 px-3 py-1.5 text-xs font-semibold text-[#FEEF00]"
          >
            + Otro método
          </button>
        </div>

        {paymentLines.map((line, index) => {
          const account = accountForPayment(line) ?? firstAccount;
          const requirements = getPaymentReportRequirements(account?.paymentMethodCode);
          const methodAccounts = account ? accountsForMethod(account.paymentMethodCode) : [];
          const immediate = isImmediateAccount(account);
          return (
            <div key={line.id} className="rounded-[8px] border border-[#242433] bg-[#111118] p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <div className="text-sm font-semibold">
                    {paymentLines.length > 1
                      ? `Pago ${index + 1} · ${getPaymentMethodLabel(account?.paymentMethodCode || '')}`
                      : getPaymentMethodLabel(account?.paymentMethodCode || '')}
                  </div>
                  <div className={['mt-1 text-xs', immediate ? 'text-emerald-300' : 'text-orange-200'].join(' ')}>
                    {immediate
                      ? 'Se confirma inmediatamente.'
                      : 'Queda pendiente hasta que Master lo confirme.'}
                  </div>
                </div>
                <button
                  type="button"
                  disabled={paymentLines.length === 1}
                  onClick={() => {
                    invalidateIntent();
                    setPaymentLines((current) => current.filter((item) => item.id !== line.id));
                  }}
                  className="rounded-full border border-red-400/30 px-3 py-1.5 text-xs font-semibold text-red-200 disabled:hidden"
                >
                  Quitar
                </button>
              </div>
              <div className="mt-3 grid gap-3 lg:grid-cols-[0.9fr_1.3fr_0.8fr_0.55fr]">
                {paymentLines.length > 1 ? (
                  <Field label="Método">
                    <select
                      value={account?.paymentMethodCode ?? ''}
                      onChange={(event) => selectPaymentMethod(line.id, event.target.value)}
                      className="counter-field"
                    >
                      {paymentMethods.map((method) => (
                        <option key={method} value={method}>
                          {getPaymentMethodLabel(method)}
                        </option>
                      ))}
                    </select>
                  </Field>
                ) : null}
                <Field label={paymentDestinationLabel(account?.paymentMethodCode || '')}>
                  <select
                    value={line.accountKey}
                    onChange={(event) => updatePaymentLine(line.id, { accountKey: event.target.value })}
                    className="counter-field"
                  >
                    {methodAccounts.map((item) => (
                      <option key={paymentAccountKey(item)} value={paymentAccountKey(item)}>
                        {item.accountName}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={`Monto recibido (${account?.currencyCode ?? ''})`}>
                  <input
                    value={line.amount}
                    onChange={(event) => updatePaymentLine(line.id, { amount: event.target.value })}
                    onFocus={(event) => event.currentTarget.select()}
                    inputMode="decimal"
                    className="counter-field text-lg font-semibold"
                  />
                </Field>
                {account?.currencyCode === 'VES' && (!immediate || order.fxRate <= 0) ? (
                  <Field label="Tasa Bs">
                    <input
                      value={line.exchangeRate}
                      onChange={(event) => updatePaymentLine(line.id, { exchangeRate: event.target.value })}
                      inputMode="decimal"
                      className="counter-field"
                    />
                  </Field>
                ) : <div />}
                {requirements.requiresOperationDate ? (
                  <Field label="Fecha de operación">
                    <input
                      type="date"
                      value={line.operationDate}
                      onChange={(event) => updatePaymentLine(line.id, { operationDate: event.target.value })}
                      className="counter-field"
                    />
                  </Field>
                ) : null}
              </div>
              <div className="mt-3 grid gap-3 lg:grid-cols-3">
                {requirements.requiresReference ? (
                  <Field label="Referencia">
                    <input
                      value={line.referenceCode}
                      onChange={(event) => updatePaymentLine(line.id, { referenceCode: event.target.value })}
                      className="counter-field"
                    />
                  </Field>
                ) : null}
                {requirements.requiresBank ? (
                  <Field label="Banco">
                    <input
                      value={line.bankName}
                      onChange={(event) => updatePaymentLine(line.id, { bankName: event.target.value })}
                      className="counter-field"
                    />
                  </Field>
                ) : null}
                {requirements.requiresHolderName || requirements.requiresInvoiceNumber ? (
                  <Field label={requirements.requiresInvoiceNumber ? 'Factura' : 'Titular'}>
                    <input
                      value={line.payerName}
                      onChange={(event) => updatePaymentLine(line.id, { payerName: event.target.value })}
                      className="counter-field"
                    />
                  </Field>
                ) : null}
                {!immediate ? (
                  <Field label="Nota opcional">
                    <input
                      value={line.notes}
                      onChange={(event) => updatePaymentLine(line.id, { notes: event.target.value })}
                      className="counter-field"
                    />
                  </Field>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>

      {expectedMethodChanged ? (
        <div className="mt-3 rounded-[8px] border border-orange-400/30 bg-orange-400/10 px-3 py-2 text-sm text-orange-100">
          La orden esperaba {getPaymentMethodLabel(order.paymentMethod)}, pero estás registrando {getPaymentMethodLabel(selectedMethod)}.
        </div>
      ) : null}

      {unallocatedOverpaymentUsd > 0.005 ? (
        <div className="mt-4 rounded-[8px] border border-[#FEEF00]/45 bg-[#FEEF00]/10 p-3">
          <div className="text-sm font-semibold text-[#FEEF00]">
            Cambio calculado: {moneyUsd(unallocatedOverpaymentUsd)}
          </div>
          <div className="mt-1 text-xs leading-relaxed text-[#D5D5C7]">
            El dinero recibido supera lo pendiente. Debes decidir qué hacer con la diferencia.
          </div>
          {fundRemainderAccepted ? (
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-[8px] border border-violet-300/30 bg-violet-300/10 px-3 py-2 text-sm text-violet-100">
              <span>Se guardará como saldo a favor del cliente.</span>
              <button
                type="button"
                onClick={invalidateIntent}
                className="rounded-full border border-violet-200/30 px-3 py-1 text-xs font-semibold"
              >
                Cambiar decisión
              </button>
            </div>
          ) : (
            <div className="mt-3 grid gap-2 sm:grid-cols-3">
              <button
                type="button"
                onClick={() => addChangeLine(
                  'cash',
                  unallocatedOverpaymentUsd,
                  firstPaymentAccount?.currencyCode
                )}
                className="min-h-11 rounded-[8px] border border-emerald-300/35 bg-emerald-300/10 px-3 py-2 text-sm font-semibold text-emerald-100"
              >
                Entregar cambio
              </button>
              <button
                type="button"
                onClick={() => addChangeLine(
                  'digital_pending',
                  unallocatedOverpaymentUsd,
                  firstPaymentAccount?.currencyCode
                )}
                className="min-h-11 rounded-[8px] border border-sky-300/35 bg-sky-300/10 px-3 py-2 text-sm font-semibold text-sky-100"
              >
                Cambio digital
              </button>
              <button
                type="button"
                onClick={acceptFundRemainder}
                disabled={!canStoreOverpaymentAsFund}
                className="min-h-11 rounded-[8px] border border-violet-300/35 bg-violet-300/10 px-3 py-2 text-sm font-semibold text-violet-100 disabled:cursor-not-allowed disabled:opacity-45"
              >
                {canStoreOverpaymentAsFund ? 'Guardar saldo a favor' : 'Requiere pago confirmado'}
              </button>
            </div>
          )}
        </div>
      ) : null}

      <div className="mt-4 rounded-[8px] border border-sky-400/25 bg-sky-400/5 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="text-sm font-semibold text-sky-100">Cambio de esta operación</div>
            <div className="mt-1 text-xs text-sky-100/65">
              Puede existir aunque el cliente solo esté abonando una parte de la orden.
            </div>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => addChangeLine('cash')}
              className="rounded-full border border-sky-300/35 px-3 py-1.5 text-xs font-semibold text-sky-100"
            >
              Agregar efectivo
            </button>
            <button
              type="button"
              onClick={() => addChangeLine('digital_pending')}
              className="rounded-full border border-sky-300/35 px-3 py-1.5 text-xs font-semibold text-sky-100"
            >
              Agregar digital
            </button>
          </div>
        </div>

        {changeLines.length === 0 ? (
          <div className="mt-3 text-xs text-[#9FA0AA]">Sin cambio registrado.</div>
        ) : (
          <div className="mt-3 space-y-2">
            {changeLines.map((line) => {
              const option = changeOption(line);
              return (
                <div key={line.id} className="grid gap-2 rounded-[8px] border border-sky-300/15 bg-[#0B0B0D] p-3 lg:grid-cols-[0.75fr_1.3fr_0.65fr_0.55fr_1fr_auto]">
                  <Field label="Tipo">
                    <select
                      value={line.mode}
                      onChange={(event) => updateChangeLine(line.id, {
                        mode: event.target.value === 'digital_pending' ? 'digital_pending' : 'cash',
                      })}
                      className="counter-field"
                    >
                      <option value="cash">Efectivo</option>
                      <option value="digital_pending">Digital pendiente</option>
                    </select>
                  </Field>
                  <Field label={line.mode === 'cash' ? 'Caja' : 'Metodo solicitado'}>
                    <select
                      value={line.optionKey}
                      onChange={(event) => updateChangeLine(line.id, { optionKey: event.target.value })}
                      className="counter-field"
                    >
                      {line.mode === 'cash'
                        ? cashChangeAccounts.map((account) => (
                            <option key={paymentAccountKey(account)} value={paymentAccountKey(account)}>
                              {account.accountName}
                            </option>
                          ))
                        : digitalChangeOptions.map((item) => (
                            <option key={item.key} value={item.key}>{item.label}</option>
                          ))}
                    </select>
                  </Field>
                  <Field label={`Monto ${option?.currencyCode ?? ''}`}>
                    <input
                      value={line.amount}
                      onChange={(event) => updateChangeLine(line.id, { amount: event.target.value })}
                      inputMode="decimal"
                      className="counter-field"
                    />
                  </Field>
                  {option?.currencyCode === 'VES' ? (
                    <Field label="Tasa">
                      <input
                        value={line.exchangeRate}
                        onChange={(event) => updateChangeLine(line.id, { exchangeRate: event.target.value })}
                        inputMode="decimal"
                        className="counter-field"
                      />
                    </Field>
                  ) : <div />}
                  <Field label="Nota">
                    <input
                      value={line.notes}
                      onChange={(event) => updateChangeLine(line.id, { notes: event.target.value })}
                      className="counter-field"
                    />
                  </Field>
                  <div className="flex items-end">
                    <button
                      type="button"
                      onClick={() => {
                        invalidateIntent();
                        setChangeLines((current) => current.filter((item) => item.id !== line.id));
                      }}
                      className="rounded-[8px] border border-red-400/35 px-3 py-3 text-xs font-semibold text-red-200"
                    >
                      Quitar
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <ReceiptMetric label="Se confirma ahora" value={moneyUsd(projectedNetConfirmedUsd)} />
        <ReceiptMetric label="Master debe revisar" value={moneyUsd(paymentSummary.pending)} />
        <ReceiptMetric label="Cambio total" value={moneyUsd(totalChangeUsd)} />
        <ReceiptMetric label="Saldo contable" value={moneyUsd(projectedPendingUsd)} />
        {fundCreditUsd > 0.005 ? (
          <ReceiptMetric label="Saldo a favor" value={moneyUsd(fundCreditUsd)} />
        ) : null}
      </div>

      {error ? (
        <div className="mt-3 rounded-[8px] border border-red-400/35 bg-red-400/10 px-3 py-2 text-sm text-red-200">
          {error}
        </div>
      ) : null}

      {reviewOpen ? (
        <div className="mt-4 rounded-[8px] border border-[#FEEF00]/35 bg-[#FEEF00]/5 p-4">
          <div className="text-sm font-semibold text-[#FEEF00]">Revisa antes de registrar</div>
          <p className="mt-1 text-xs leading-relaxed text-[#C7C8D1]">
            Se reciben {moneyUsd(paymentSummary.reported)}, se entregan {moneyUsd(totalChangeUsd)} de cambio
            y queda un saldo contable de {moneyUsd(projectedPendingUsd)}.
          </p>
          {paymentSummary.pending > 0.005 ? (
            <div className="mt-2 rounded-[8px] border border-orange-400/30 bg-orange-400/10 px-3 py-2 text-xs text-orange-100">
              {moneyUsd(paymentSummary.pending)} quedará pendiente de confirmación por Master.
            </div>
          ) : null}
          {changeSummary.digital > 0.005 ? (
            <div className="mt-2 rounded-[8px] border border-orange-400/30 bg-orange-400/10 px-3 py-2 text-xs text-orange-100">
              El cambio digital queda asignado como pendiente; todavía no cuenta como dinero entregado.
            </div>
          ) : null}
          <div className="mt-3 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setReviewOpen(false)}
              className="rounded-[8px] border border-[#303044] px-4 py-2 text-sm font-semibold text-[#C7C8D1]"
            >
              Volver
            </button>
            <button
              type="button"
              onClick={() => void confirmIntent()}
              disabled={isWorking}
              className="rounded-[8px] border border-[#FEEF00] bg-[#FEEF00] px-4 py-2 text-sm font-bold text-black disabled:cursor-wait disabled:opacity-60"
            >
              {isWorking ? 'Registrando...' : 'Registrar cobro'}
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-4 flex justify-end">
          <button
            type="button"
            onClick={openReview}
            disabled={isWorking || paymentLines.length === 0}
            className="rounded-[8px] border border-[#FEEF00] bg-[#FEEF00] px-5 py-3 text-sm font-bold text-black disabled:cursor-wait disabled:opacity-60"
          >
            Revisar y cobrar
          </button>
        </div>
      )}

      <style jsx>{`
        :global(.counter-field) {
          margin-top: 0.25rem;
          width: 100%;
          border-radius: 8px;
          border: 1px solid #303044;
          background: #0b0b0d;
          padding: 0.75rem;
          color: #f5f5f7;
          outline: none;
        }
        :global(.counter-field:focus) {
          border-color: rgba(254, 239, 0, 0.7);
        }
      `}</style>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="text-sm text-[#9FA0AA]">
      {label}
      {children}
    </label>
  );
}

function ReceiptMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[8px] border border-[#303044] bg-[#111118] p-3">
      <div className="text-xs text-[#9FA0AA]">{label}</div>
      <div className="mt-1 text-sm font-semibold text-[#F5F5F7]">{value}</div>
    </div>
  );
}
