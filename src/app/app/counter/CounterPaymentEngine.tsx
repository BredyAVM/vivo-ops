'use client';

import { useMemo, useRef, useState, useTransition, type ReactNode } from 'react';
import { getPaymentMethodLabel } from '@/lib/orders/order-labels';
import {
  getPaymentReportRequirements,
  validatePaymentReportDetails,
} from '@/lib/payments/payment-report-rules';
import type {
  CounterOrder,
  CounterPaymentAccountOption,
  CounterPaymentQuote,
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

type PaymentStep = 'payment' | 'change' | 'review';

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

function moneyBs(value: number) {
  return new Intl.NumberFormat('es-VE', {
    style: 'currency',
    currency: 'VES',
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

function amountForCurrency(currency: 'USD' | 'VES', usd: number, rate: number) {
  return currency === 'VES'
    ? roundMoney(Math.max(0, usd) * Math.max(rate, 0)).toFixed(2)
    : roundMoney(Math.max(0, usd)).toFixed(2);
}

function canonicalPaymentAmount(currency: 'USD' | 'VES', quote: CounterPaymentQuote) {
  return currency === 'VES'
    ? roundMoney(Math.max(0, quote.pendingBs)).toFixed(2)
    : roundMoney(Math.max(0, quote.pendingUsd)).toFixed(2);
}

function paymentValueRate(quote: CounterPaymentQuote) {
  if (quote.collectionMode === 'post_delivery_usd') return quote.exchangeRate;
  return quote.snapshotRate || quote.exchangeRate;
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
  onLoadPaymentQuote,
}: {
  order: CounterOrder;
  paymentAccounts: CounterPaymentAccountOption[];
  isWorking: boolean;
  onSubmit: (intent: CounterPaymentIntent) => Promise<CounterPaymentOperationResult>;
  onLoadPaymentQuote: (input: {
    orderId: number;
    operationDate: string;
  }) => Promise<CounterPaymentQuote>;
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
  const paymentQuoteRequestId = useRef(0);
  const [paymentQuote, setPaymentQuote] = useState(order.paymentQuote);
  const [quoteLoading, startQuoteTransition] = useTransition();
  const [paymentLines, setPaymentLines] = useState<PaymentDraft[]>(() =>
    firstAccount
      ? [{
          id: 'payment-1',
          accountKey: paymentAccountKey(firstAccount),
          amount: canonicalPaymentAmount(firstAccount.currencyCode, order.paymentQuote),
          exchangeRate: firstAccount.currencyCode === 'VES'
            ? String(roundMoney(order.paymentQuote.exchangeRate))
            : '',
          operationDate: todayCaracas(),
          referenceCode: '',
          bankName: '',
          payerName: '',
          notes: '',
        }]
      : []
  );
  const [changeLines, setChangeLines] = useState<ChangeDraft[]>([]);
  const [step, setStep] = useState<PaymentStep>('payment');
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<CounterPaymentOperationResult | null>(null);
  const [fundRemainderAccepted, setFundRemainderAccepted] = useState(false);

  function invalidateIntent() {
    idempotencyKey.current = null;
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

  const canonicalPendingUsd = paymentQuote.pendingUsd;
  const canonicalPendingBs = paymentQuote.pendingBs;
  const canonicalValueRate = paymentValueRate(paymentQuote);

  const paymentSummary = paymentLines.reduce(
    (summary, line) => {
      const account = accountForPayment(line);
      const amount = decimal(line.amount);
      if (!account) return summary;
      const isWholeCanonicalVesPayment =
        account.currencyCode === 'VES'
        && paymentLines.length === 1
        && canonicalPendingUsd > 0.005
        && Math.abs(amount - canonicalPendingBs) <= 0.01;
      const usd = isWholeCanonicalVesPayment
        ? canonicalPendingUsd
        : amountUsd(
            amount,
            account.currencyCode,
            account.currencyCode === 'VES' ? canonicalValueRate : null
          );
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
  const unallocatedOverpaymentUsd = Math.max(0, roundMoney(registeredNetUsd - canonicalPendingUsd));
  const projectedNetConfirmedUsd = roundMoney(paymentSummary.confirmed - totalChangeUsd);
  const projectedPendingUsd = Math.max(0, roundMoney(canonicalPendingUsd - projectedNetConfirmedUsd));
  const projectedOverpaidUsd = Math.max(0, roundMoney(projectedNetConfirmedUsd - canonicalPendingUsd));
  const fundCreditUsd = fundRemainderAccepted ? projectedOverpaidUsd : 0;
  const confirmedOverpaymentBeforeChangeUsd = Math.max(
    0,
    roundMoney(paymentSummary.confirmed - canonicalPendingUsd)
  );
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
  const canStoreGrossOverpaymentAsFund =
    confirmedOverpaymentBeforeChangeUsd + 0.005 >= Math.max(totalChangeUsd, unallocatedOverpaymentUsd);

  function addPaymentLine() {
    invalidateIntent();
    if (!firstAccount) return;
    const id = `payment-${nextPaymentId.current}`;
    nextPaymentId.current += 1;
    setPaymentLines((current) => [...current, {
      id,
      accountKey: paymentAccountKey(firstAccount),
      // A second tender must be entered by the cashier. It is not safe to
      // derive a VES remainder locally for a mixed order.
      amount: '',
      exchangeRate: firstAccount.currencyCode === 'VES'
        ? String(roundMoney(paymentQuote.exchangeRate))
        : '',
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
      const isOnlyTender = current.length === 1;
      return {
        ...line,
        accountKey: paymentAccountKey(account),
        amount: isOnlyTender ? canonicalPaymentAmount(account.currencyCode, paymentQuote) : '',
        exchangeRate: account.currencyCode === 'VES'
          ? String(roundMoney(paymentQuote.exchangeRate))
          : '',
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
        next.amount = paymentLines.length === 1 && account
          ? canonicalPaymentAmount(account.currencyCode, paymentQuote)
          : '';
        next.exchangeRate = account?.currencyCode === 'VES'
          ? String(roundMoney(paymentQuote.exchangeRate))
          : '';
      }
      return next;
    }));
  }

  function refreshPaymentQuote(paymentLineId: string, operationDate: string) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(operationDate)) return;

    const requestId = paymentQuoteRequestId.current + 1;
    paymentQuoteRequestId.current = requestId;
    startQuoteTransition(async () => {
      try {
        const nextQuote = await onLoadPaymentQuote({
          orderId: order.id,
          operationDate,
        });
        if (paymentQuoteRequestId.current !== requestId) return;
        invalidateIntent();
        setPaymentQuote(nextQuote);
        setPaymentLines((current) => current.map((line) => {
          if (line.id !== paymentLineId) return line;
          const account = accountForPayment(line);
          if (account?.currencyCode !== 'VES') return line;
          return {
            ...line,
            amount: current.length === 1
              ? canonicalPaymentAmount('VES', nextQuote)
              : line.amount,
            exchangeRate: String(roundMoney(nextQuote.exchangeRate)),
          };
        }));
      } catch (quoteError) {
        if (paymentQuoteRequestId.current !== requestId) return;
        setError(
          quoteError instanceof Error
            ? quoteError.message
            : 'No se pudo actualizar la cotización canónica.'
        );
      }
    });
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
        ? amountForCurrency(currencyCode, suggestedUsd, paymentQuote.exchangeRate)
        : '',
      exchangeRate: String(roundMoney(paymentQuote.exchangeRate)),
      notes: '',
    }]);
  }

  function acceptFundRemainder() {
    if (!canStoreGrossOverpaymentAsFund) {
      setError('Solo el dinero confirmado puede guardarse como saldo a favor.');
      return;
    }
    idempotencyKey.current = null;
    setReceipt(null);
    setError(null);
    setChangeLines([]);
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
        next.exchangeRate = option?.currencyCode === 'VES'
          ? String(roundMoney(paymentQuote.exchangeRate))
          : '';
      }
      return next;
    }));
  }

  function preparePaymentLines(): CounterPaymentIntent['paymentLines'] | null {
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
      const referenceCode = line.referenceCode.trim();
      if (account.paymentMethodCode === 'pos' && !/^\d{4}$/.test(referenceCode)) {
        setError('Indica los ultimos cuatro digitos de la referencia del punto.');
        return null;
      }
      const validationError = validatePaymentReportDetails({
        method: account.paymentMethodCode,
        operationDate: line.operationDate,
        referenceCode,
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
        referenceCode: referenceCode || null,
        bankName: line.bankName.trim() || null,
        payerName: line.payerName.trim() || null,
        notes: line.notes.trim() || null,
      });
    }

    setError(null);
    return preparedPayments;
  }

  function buildIntent(): CounterPaymentIntent | null {
    const preparedPayments = preparePaymentLines();
    if (!preparedPayments) return null;

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
        : fundRemainderAccepted && paymentSummary.confirmed > canonicalPendingUsd + 0.005
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

  function continueFromPayment() {
    if (!preparePaymentLines()) return;
    if (unallocatedOverpaymentUsd > 0.005 || changeLines.length > 0) {
      if (changeLines.length === 0 && !fundRemainderAccepted) {
        addChangeLine(
          'cash',
          unallocatedOverpaymentUsd,
          firstPaymentAccount?.currencyCode
        );
      }
      setStep('change');
      return;
    }
    if (!buildIntent()) return;
    setStep('review');
  }

  function continueFromChange() {
    if (!buildIntent()) return;
    setStep('review');
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
    <div>
      <div className="mb-4 grid grid-cols-3 gap-2" aria-label="Progreso del cobro">
        {([
          ['payment', '1', 'Cobro'],
          ['change', '2', 'Cambio'],
          ['review', '3', 'Confirmar'],
        ] as const).map(([key, number, label]) => {
          const active = step === key;
          const completed =
            (key === 'payment' && step !== 'payment')
            || (key === 'change' && step === 'review');
          return (
            <div
              key={key}
              className={[
                'rounded-[8px] border px-3 py-2 text-center text-xs font-semibold',
                active
                  ? 'border-[#FEEF00] bg-[#FEEF00] text-black'
                  : completed
                    ? 'border-emerald-400/35 bg-emerald-400/10 text-emerald-200'
                    : 'border-[#303044] bg-[#111118] text-[#777988]',
              ].join(' ')}
            >
              {number}. {label}
            </div>
          );
        })}
      </div>

      {step === 'payment' ? (
        <div>
          <div className="rounded-[10px] border border-[#FEEF00]/35 bg-[#FEEF00]/[0.06] p-4 text-center">
            <div className="text-xs font-semibold uppercase tracking-[0.12em] text-[#FEEF00]/75">
              Falta por cobrar
            </div>
            <div className="mt-1 text-3xl font-bold text-[#F5F5F7]">{moneyUsd(canonicalPendingUsd)}</div>
            <div className="mt-1 text-sm text-[#C7C8D1]">{moneyBs(canonicalPendingBs)}</div>
            {quoteLoading ? <div className="mt-1 text-xs text-sky-200">Actualizando monto...</div> : null}
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
                  disabled={isWorking || quoteLoading}
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
                {paymentLines.length > 1 ? 'Pagos del cliente' : 'Datos del cobro'}
              </div>
              <button
                type="button"
                onClick={addPaymentLine}
                disabled={quoteLoading}
                className="rounded-full border border-[#FEEF00]/50 bg-[#FEEF00]/10 px-3 py-1.5 text-xs font-semibold text-[#FEEF00]"
              >
                + Pago mixto
              </button>
            </div>

            {paymentLines.map((line, index) => {
          const account = accountForPayment(line) ?? firstAccount;
          const requirements = getPaymentReportRequirements(account?.paymentMethodCode);
          const isPosPayment = account?.paymentMethodCode === 'pos';
          const methodAccounts = account ? accountsForMethod(account.paymentMethodCode) : [];
          const immediate = isImmediateAccount(account);
          return (
            <div key={line.id} className="rounded-[10px] border border-[#303044] bg-[#111118] p-3">
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
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
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
                {account?.currencyCode === 'VES' ? (
                  <Field label="Tasa Bs (canónica)">
                    <input
                      value={line.exchangeRate}
                      readOnly
                      aria-label="Tasa en bolívares definida por el servidor"
                      className="counter-field cursor-not-allowed text-[#9FA0AA]"
                    />
                  </Field>
                ) : null}
                {requirements.requiresOperationDate ? (
                  <Field label="Fecha de operación">
                    <input
                      type="date"
                      value={line.operationDate}
                      onChange={(event) => {
                        const operationDate = event.target.value;
                        updatePaymentLine(line.id, { operationDate });
                        if (account?.currencyCode === 'VES') {
                          refreshPaymentQuote(line.id, operationDate);
                        }
                      }}
                      className="counter-field"
                    />
                  </Field>
                ) : null}
              </div>
              <div className="mt-3 grid gap-3 lg:grid-cols-3">
                {requirements.requiresReference || isPosPayment ? (
                  <Field label={isPosPayment ? 'Ultimos 4 del punto' : 'Referencia'}>
                    <input
                      value={line.referenceCode}
                      onChange={(event) => updatePaymentLine(line.id, {
                        referenceCode: isPosPayment
                          ? event.target.value.replace(/\D/g, '').slice(0, 4)
                          : event.target.value,
                      })}
                      inputMode={isPosPayment ? 'numeric' : undefined}
                      maxLength={isPosPayment ? 4 : undefined}
                      pattern={isPosPayment ? '\\d{4}' : undefined}
                      placeholder={isPosPayment ? 'Ej. 4821' : undefined}
                      autoComplete="off"
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

          <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
            <button
              type="button"
              onClick={() => {
                if (changeLines.length === 0) addChangeLine('cash');
                setStep('change');
              }}
              className="min-h-11 rounded-[8px] border border-[#303044] px-4 py-2 text-xs font-semibold text-[#C7C8D1]"
            >
              Este cobro lleva cambio
            </button>
            <button
              type="button"
              onClick={continueFromPayment}
              disabled={isWorking || quoteLoading || paymentLines.length === 0}
              className="min-h-12 rounded-[8px] border border-[#FEEF00] bg-[#FEEF00] px-5 py-3 text-sm font-bold text-black disabled:cursor-wait disabled:opacity-60"
            >
              {unallocatedOverpaymentUsd > 0.005
                ? `Continuar · Dar ${moneyUsd(unallocatedOverpaymentUsd)} de cambio`
                : 'Continuar'}
            </button>
          </div>
        </div>
      ) : null}

      {step === 'change' ? (
        <div>
          <div className="rounded-[10px] border border-[#FEEF00]/40 bg-[#FEEF00]/[0.07] p-4 text-center">
            <div className="text-xs font-semibold uppercase tracking-[0.12em] text-[#FEEF00]/75">
              Cambio que debes entregar
            </div>
            <div className="mt-1 text-3xl font-bold text-[#FEEF00]">
              {moneyUsd(Math.max(totalChangeUsd, unallocatedOverpaymentUsd))}
            </div>
            <div className="mt-1 text-xs text-[#C7C8D1]">
              Recibes {moneyUsd(paymentSummary.reported)} · La orden cubre {moneyUsd(canonicalPendingUsd)}
            </div>
          </div>

          {fundRemainderAccepted ? (
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-[8px] border border-violet-300/30 bg-violet-300/10 px-3 py-2 text-sm text-violet-100">
              <span>Se guardará como saldo a favor del cliente.</span>
              <button
                type="button"
                onClick={() => {
                  invalidateIntent();
                  setFundRemainderAccepted(false);
                  addChangeLine('cash', projectedOverpaidUsd, firstPaymentAccount?.currencyCode);
                }}
                className="rounded-full border border-violet-200/30 px-3 py-1 text-xs font-semibold"
              >
                Entregarlo como cambio
              </button>
            </div>
          ) : (
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => addChangeLine('cash')}
                className="rounded-full border border-emerald-300/35 px-3 py-2 text-xs font-semibold text-emerald-100"
              >
                + Otra caja
              </button>
              <button
                type="button"
                onClick={() => addChangeLine('digital_pending')}
                className="rounded-full border border-sky-300/35 px-3 py-2 text-xs font-semibold text-sky-100"
              >
                + Parte digital
              </button>
              {canStoreGrossOverpaymentAsFund ? (
                <button
                  type="button"
                  onClick={acceptFundRemainder}
                  className="rounded-full border border-violet-300/35 px-3 py-2 text-xs font-semibold text-violet-100"
                >
                  Dejar como saldo a favor
                </button>
              ) : null}
            </div>
          )}

          {!fundRemainderAccepted ? (
          <div className="mt-3 space-y-2">
            {changeLines.map((line) => {
              const option = changeOption(line);
              return (
                <div key={line.id} className="grid gap-3 rounded-[10px] border border-sky-300/20 bg-[#111118] p-3 sm:grid-cols-2">
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
                  ) : null}
                  <div className="flex items-end sm:col-span-2 sm:justify-end">
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
          ) : null}

          <div className="mt-4 flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => setStep('payment')}
              className="min-h-11 rounded-[8px] border border-[#303044] px-4 py-2 text-sm font-semibold text-[#C7C8D1]"
            >
              Volver
            </button>
            <button
              type="button"
              onClick={continueFromChange}
              className="min-h-12 rounded-[8px] border border-[#FEEF00] bg-[#FEEF00] px-5 py-3 text-sm font-bold text-black"
            >
              Continuar
            </button>
          </div>
        </div>
      ) : null}

      {error ? (
        <div className="mt-3 rounded-[8px] border border-red-400/35 bg-red-400/10 px-3 py-2 text-sm text-red-200">
          {error}
        </div>
      ) : null}

      {step === 'review' ? (
        <div>
          <div className="rounded-[10px] border border-[#FEEF00]/35 bg-[#FEEF00]/5 p-4">
            <div className="text-center text-sm font-semibold text-[#FEEF00]">Confirma el cobro</div>
            <div className="mt-4 grid gap-2 sm:grid-cols-2">
              <ReceiptMetric label="Cliente entrega" value={moneyUsd(paymentSummary.reported)} />
              <ReceiptMetric label="Cambio" value={moneyUsd(totalChangeUsd)} />
              <ReceiptMetric label="Se confirma ahora" value={moneyUsd(projectedNetConfirmedUsd)} />
              <ReceiptMetric label="Saldo pendiente" value={moneyUsd(projectedPendingUsd)} />
              {fundCreditUsd > 0.005 ? (
                <ReceiptMetric label="Saldo a favor" value={moneyUsd(fundCreditUsd)} />
              ) : null}
            </div>
          {paymentSummary.pending > 0.005 ? (
            <div className="mt-2 rounded-[8px] border border-orange-400/30 bg-orange-400/10 px-3 py-2 text-xs text-orange-100">
              {moneyUsd(paymentSummary.pending)} quedará pendiente de confirmación por Master.
            </div>
          ) : null}
          {paymentLines.some((line) => accountForPayment(line)?.paymentMethodCode === 'pos') ? (
            <div className="mt-2 rounded-[8px] border border-sky-300/25 bg-sky-300/5 px-3 py-2 text-xs text-sky-100">
              {paymentLines
                .filter((line) => accountForPayment(line)?.paymentMethodCode === 'pos')
                .map((line) => {
                  const account = accountForPayment(line);
                  return `${account?.accountName || 'Punto'} · Ref. ${line.referenceCode}`;
                })
                .join(' · ')}
            </div>
          ) : null}
          {changeSummary.digital > 0.005 ? (
            <div className="mt-2 rounded-[8px] border border-orange-400/30 bg-orange-400/10 px-3 py-2 text-xs text-orange-100">
              El cambio digital queda asignado como pendiente; todavía no cuenta como dinero entregado.
            </div>
          ) : null}
          </div>
          <div className="mt-4 flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => setStep(totalChangeUsd > 0.005 || fundRemainderAccepted ? 'change' : 'payment')}
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
      ) : null}

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
