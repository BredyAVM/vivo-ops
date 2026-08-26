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
  CounterGiveChangeIntent,
  CounterGiveChangeResult,
  CounterPaymentIntent,
  CounterPaymentOperationResult,
} from './payment-contract';

type PaymentDraft = {
  accountKey: string;
  amount: string;
  exchangeRate: string;
  operationDate: string;
  referenceCode: string;
  bankName: string;
  payerName: string;
  notes: string;
};

type CashierView = 'payment' | 'change' | 'finished';
type PaymentStage = 'input' | 'review' | 'receipt';
type ChangeStage = 'input' | 'review' | 'receipt';

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

function isDirectCashAccount(account: CounterPaymentAccountOption) {
  return account.accountKind === 'cash' && isImmediateAccount(account);
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
  if (currency === 'USD') return roundMoney(amount);
  if (!exchangeRate || !Number.isFinite(exchangeRate) || exchangeRate <= 0) return 0;
  return roundMoney(amount / exchangeRate);
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

function createPaymentDraft(
  account: CounterPaymentAccountOption,
  quote: CounterPaymentQuote
): PaymentDraft {
  return {
    accountKey: paymentAccountKey(account),
    amount: canonicalPaymentAmount(account.currencyCode, quote),
    exchangeRate: account.currencyCode === 'VES'
      ? String(roundMoney(quote.exchangeRate))
      : '',
    operationDate: todayCaracas(),
    referenceCode: '',
    bankName: '',
    payerName: '',
    notes: '',
  };
}

export function CounterPaymentEngine({
  order,
  paymentAccounts,
  isWorking,
  onSubmit,
  onGiveChange,
  onLoadPaymentQuote,
  onFinish,
}: {
  order: CounterOrder;
  paymentAccounts: CounterPaymentAccountOption[];
  isWorking: boolean;
  onSubmit: (intent: CounterPaymentIntent) => Promise<CounterPaymentOperationResult>;
  onGiveChange: (intent: CounterGiveChangeIntent) => Promise<CounterGiveChangeResult>;
  onLoadPaymentQuote: (input: {
    orderId: number;
    operationDate: string;
  }) => Promise<CounterPaymentQuote>;
  onFinish: () => void;
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

  const paymentKeyRef = useRef<string | null>(null);
  const changeKeyRef = useRef<string | null>(null);
  const paymentQuoteRequestId = useRef(0);
  const [paymentQuote, setPaymentQuote] = useState(order.paymentQuote);
  const [quoteLoading, startQuoteTransition] = useTransition();
  const [view, setView] = useState<CashierView>(
    order.paymentQuote.pendingUsd <= 0.005 && order.changeAvailableUsd > 0.005
      ? 'change'
      : 'payment'
  );
  const [paymentStage, setPaymentStage] = useState<PaymentStage>('input');
  const [changeStage, setChangeStage] = useState<ChangeStage>('input');
  const [paymentDraft, setPaymentDraft] = useState<PaymentDraft | null>(
    firstAccount ? createPaymentDraft(firstAccount, order.paymentQuote) : null
  );
  const [paymentReceipt, setPaymentReceipt] = useState<CounterPaymentOperationResult | null>(null);
  const [changeAvailableUsd, setChangeAvailableUsd] = useState(
    roundMoney(order.changeAvailableUsd)
  );
  const [changeAccountKey, setChangeAccountKey] = useState(
    firstCashChangeAccount ? paymentAccountKey(firstCashChangeAccount) : ''
  );
  const [changeAmount, setChangeAmount] = useState(
    firstCashChangeAccount
      ? amountForCurrency(
          firstCashChangeAccount.currencyCode,
          order.changeAvailableUsd,
          order.paymentQuote.exchangeRate
        )
      : ''
  );
  const [changeNotes, setChangeNotes] = useState('');
  const [changeReceipt, setChangeReceipt] = useState<CounterGiveChangeResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const paymentAccount = paymentDraft
    ? reportAccounts.find((account) => paymentAccountKey(account) === paymentDraft.accountKey) ?? null
    : null;
  const selectedMethod = paymentAccount?.paymentMethodCode ?? '';
  const selectedMethodAccounts = reportAccounts.filter(
    (account) => account.paymentMethodCode === selectedMethod
  );
  const paymentRequirements = getPaymentReportRequirements(selectedMethod);
  const paymentAmount = decimal(paymentDraft?.amount ?? '');
  const canonicalValueRate = paymentValueRate(paymentQuote);
  const paymentAmountUsd = paymentAccount
    ? (
        paymentAccount.currencyCode === 'VES'
        && Math.abs(paymentAmount - paymentQuote.pendingBs) <= 0.01
        && paymentQuote.pendingUsd > 0.005
      )
      ? paymentQuote.pendingUsd
      : amountUsd(
          paymentAmount,
          paymentAccount.currencyCode,
          paymentAccount.currencyCode === 'VES' ? canonicalValueRate : null
        )
    : 0;
  const paymentConfirmsNow = isImmediateAccount(paymentAccount);
  const paymentConfirmedUsd = paymentConfirmsNow ? paymentAmountUsd : 0;
  const projectedAppliedUsd = Math.min(paymentConfirmedUsd, paymentQuote.pendingUsd);
  const projectedPendingUsd = Math.max(0, roundMoney(paymentQuote.pendingUsd - projectedAppliedUsd));
  const projectedFundUsd = Math.max(0, roundMoney(paymentConfirmedUsd - paymentQuote.pendingUsd));
  const expectedMethodChanged =
    Boolean(order.paymentMethod)
    && order.paymentMethod !== 'mixed'
    && order.paymentMethod !== 'pending'
    && Boolean(selectedMethod)
    && selectedMethod !== order.paymentMethod;

  const changeAccount = cashChangeAccounts.find(
    (account) => paymentAccountKey(account) === changeAccountKey
  ) ?? null;
  const changeRate = paymentQuote.exchangeRate;
  const changeAmountNumber = decimal(changeAmount);
  const changeAmountUsd = changeAccount
    ? amountUsd(
        changeAmountNumber,
        changeAccount.currencyCode,
        changeAccount.currencyCode === 'VES' ? changeRate : null
      )
    : 0;

  function invalidatePayment() {
    paymentKeyRef.current = null;
    setPaymentReceipt(null);
    setError(null);
  }

  function updatePayment(patch: Partial<PaymentDraft>) {
    invalidatePayment();
    setPaymentDraft((current) => current ? { ...current, ...patch } : current);
  }

  function accountsForMethod(method: string) {
    return reportAccounts.filter((account) => account.paymentMethodCode === method);
  }

  function selectPaymentMethod(method: string) {
    const account = accountsForMethod(method)[0] ?? null;
    if (!account) return;
    invalidatePayment();
    setPaymentDraft(createPaymentDraft(account, paymentQuote));
  }

  function selectPaymentAccount(accountKey: string) {
    const account = reportAccounts.find((item) => paymentAccountKey(item) === accountKey) ?? null;
    if (!account) return;
    invalidatePayment();
    setPaymentDraft(createPaymentDraft(account, paymentQuote));
  }

  function refreshPaymentQuote(operationDate: string) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(operationDate)) return;
    const requestId = paymentQuoteRequestId.current + 1;
    paymentQuoteRequestId.current = requestId;
    startQuoteTransition(async () => {
      try {
        const nextQuote = await onLoadPaymentQuote({ orderId: order.id, operationDate });
        if (paymentQuoteRequestId.current !== requestId) return;
        setPaymentQuote(nextQuote);
        setPaymentDraft((current) => {
          if (!current) return current;
          const account = reportAccounts.find(
            (item) => paymentAccountKey(item) === current.accountKey
          ) ?? null;
          return account
            ? { ...createPaymentDraft(account, nextQuote), operationDate }
            : current;
        });
        invalidatePayment();
      } catch (quoteError) {
        if (paymentQuoteRequestId.current !== requestId) return;
        setError(
          quoteError instanceof Error
            ? quoteError.message
            : 'No se pudo actualizar el monto canonico.'
        );
      }
    });
  }

  function buildPaymentIntent(): CounterPaymentIntent | null {
    if (!paymentDraft || !paymentAccount || paymentAmount <= 0) {
      setError('Revisa la cuenta y el monto recibido.');
      return null;
    }
    if (
      paymentAccount.currencyCode === 'VES'
      && (!decimal(paymentDraft.exchangeRate) || decimal(paymentDraft.exchangeRate) <= 0)
    ) {
      setError('No hay una tasa valida para este pago en bolivares.');
      return null;
    }
    const referenceCode = paymentDraft.referenceCode.trim();
    if (paymentAccount.paymentMethodCode === 'pos' && !/^\d{4}$/.test(referenceCode)) {
      setError('Indica los ultimos cuatro digitos de la referencia del punto.');
      return null;
    }
    const validationError = validatePaymentReportDetails({
      method: paymentAccount.paymentMethodCode,
      operationDate: paymentDraft.operationDate,
      referenceCode,
      bankName: paymentDraft.bankName.trim(),
      holderName: paymentDraft.payerName.trim(),
    });
    if (validationError) {
      setError(validationError);
      return null;
    }

    setError(null);
    return {
      idempotencyKey: paymentKeyRef.current ?? '',
      orderId: order.id,
      paymentLines: [{
        lineKey: 'payment',
        moneyAccountId: paymentAccount.accountId,
        paymentMethod: paymentAccount.paymentMethodCode,
        currencyCode: paymentAccount.currencyCode,
        amount: roundMoney(paymentAmount),
        exchangeRateVesPerUsd:
          paymentAccount.currencyCode === 'VES'
            ? decimal(paymentDraft.exchangeRate)
            : null,
        operationDate: paymentDraft.operationDate,
        referenceCode: referenceCode || null,
        bankName: paymentDraft.bankName.trim() || null,
        payerName: paymentDraft.payerName.trim() || null,
        notes: paymentDraft.notes.trim() || null,
      }],
      overpaymentHandling: projectedFundUsd > 0.005 ? 'store_fund' : null,
      changeLines: [],
      notes: null,
    };
  }

  async function confirmPayment() {
    const intent = buildPaymentIntent();
    if (!intent) return;
    if (!paymentKeyRef.current) paymentKeyRef.current = crypto.randomUUID();
    try {
      const result = await onSubmit({
        ...intent,
        idempotencyKey: paymentKeyRef.current,
      });
      setPaymentReceipt(result);
      setChangeAvailableUsd((current) => roundMoney(current + result.fundCreditUsd));
      setPaymentStage('receipt');
      setError(null);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'No se pudo registrar el cobro.');
    }
  }

  async function startAnotherPayment() {
    if (!firstAccount) return;
    setError(null);
    startQuoteTransition(async () => {
      try {
        const nextQuote = await onLoadPaymentQuote({
          orderId: order.id,
          operationDate: todayCaracas(),
        });
        setPaymentQuote(nextQuote);
        const nextAccount = paymentAccount ?? firstAccount;
        setPaymentDraft(createPaymentDraft(nextAccount, nextQuote));
        paymentKeyRef.current = null;
        setPaymentReceipt(null);
        setPaymentStage('input');
      } catch (quoteError) {
        setError(
          quoteError instanceof Error
            ? quoteError.message
            : 'No se pudo preparar el siguiente pago.'
        );
      }
    });
  }

  function selectChangeAccount(accountKey: string) {
    const account = cashChangeAccounts.find(
      (item) => paymentAccountKey(item) === accountKey
    ) ?? null;
    changeKeyRef.current = null;
    setChangeReceipt(null);
    setError(null);
    setChangeAccountKey(accountKey);
    setChangeAmount(
      account
        ? amountForCurrency(account.currencyCode, changeAvailableUsd, changeRate)
        : ''
    );
  }

  function reviewChange() {
    if (!changeAccount || !Number.isFinite(changeAmountNumber) || changeAmountNumber <= 0) {
      setError('Selecciona la caja e indica el monto que vas a entregar.');
      return;
    }
    if (changeAccount.currencyCode === 'VES' && changeRate <= 0) {
      setError('No hay una tasa activa para calcular este cambio en bolivares.');
      return;
    }
    if (changeAmountUsd > changeAvailableUsd + 0.005) {
      setError(`Solo quedan ${moneyUsd(changeAvailableUsd)} disponibles para cambio.`);
      return;
    }
    setError(null);
    setChangeStage('review');
  }

  async function confirmChange() {
    if (!changeAccount) return;
    if (!changeKeyRef.current) changeKeyRef.current = crypto.randomUUID();
    try {
      const result = await onGiveChange({
        idempotencyKey: changeKeyRef.current,
        orderId: order.id,
        moneyAccountId: changeAccount.accountId,
        amount: roundMoney(changeAmountNumber),
        operationDate: todayCaracas(),
        notes: changeNotes.trim() || null,
      });
      setChangeReceipt(result);
      setChangeAvailableUsd(result.remainingChangeUsd);
      setChangeStage('receipt');
      setError(null);
    } catch (submitError) {
      setError(
        submitError instanceof Error
          ? submitError.message
          : 'No se pudo registrar esta entrega de cambio.'
      );
    }
  }

  function startAnotherChange() {
    const account = changeAccount ?? firstCashChangeAccount;
    changeKeyRef.current = null;
    setChangeReceipt(null);
    setChangeNotes('');
    setChangeStage('input');
    setError(null);
    if (account) {
      setChangeAccountKey(paymentAccountKey(account));
      setChangeAmount(amountForCurrency(account.currencyCode, changeAvailableUsd, changeRate));
    }
  }

  if (reportAccounts.length === 0 && changeAvailableUsd <= 0.005) {
    return (
      <div className="rounded-[8px] border border-orange-400/40 bg-orange-400/10 p-4 text-sm text-orange-200">
        No hay cuentas habilitadas para registrar pagos desde mostrador.
      </div>
    );
  }

  return (
    <div>
      <div className="mb-4 grid grid-cols-3 gap-2" aria-label="Proceso de caja">
        <ProgressStep active={view === 'payment'} completed={view !== 'payment'} label="1. Recibir" />
        <ProgressStep active={view === 'change'} completed={view === 'finished'} label="2. Dar cambio" />
        <ProgressStep active={view === 'finished'} completed={false} label="3. Terminar" />
      </div>

      {view === 'payment' ? (
        <div>
          {paymentStage === 'input' ? (
            <>
              <div className="rounded-[10px] border border-[#FEEF00]/35 bg-[#FEEF00]/[0.06] p-4 text-center">
                <div className="text-xs font-semibold uppercase tracking-[0.12em] text-[#FEEF00]/75">Falta por cobrar</div>
                <div className="mt-1 text-3xl font-bold text-[#F5F5F7]">{moneyUsd(paymentQuote.pendingUsd)}</div>
                <div className="mt-1 text-sm text-[#C7C8D1]">{moneyBs(paymentQuote.pendingBs)}</div>
                {quoteLoading ? <div className="mt-1 text-xs text-sky-200">Actualizando monto...</div> : null}
              </div>

              {paymentDraft && paymentAccount ? (
                <>
                  <div className="mt-4">
                    <div className="text-sm font-semibold">¿Como esta pagando ahora?</div>
                    <div className="mt-1 text-xs text-[#9FA0AA]">
                      Cada medio se confirma por separado. Si el pago es mixto, registra uno y luego el siguiente.
                    </div>
                    <div className="mt-3 grid grid-cols-2 gap-2 lg:grid-cols-4">
                      {paymentMethods.map((method) => {
                        const methodAccount = accountsForMethod(method)[0] ?? null;
                        const selected = selectedMethod === method;
                        return (
                          <button
                            key={method}
                            type="button"
                            onClick={() => selectPaymentMethod(method)}
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

                  <div className="mt-4 rounded-[10px] border border-[#303044] bg-[#111118] p-3">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <div className="text-sm font-semibold">{getPaymentMethodLabel(selectedMethod)}</div>
                        <div className={['mt-1 text-xs', paymentConfirmsNow ? 'text-emerald-300' : 'text-orange-200'].join(' ')}>
                          {paymentConfirmsNow
                            ? 'Este pago se cierra inmediatamente.'
                            : 'Este pago queda pendiente hasta que Master lo confirme.'}
                        </div>
                      </div>
                      <span className="rounded-full border border-[#303044] px-3 py-1 text-xs text-[#C7C8D1]">Una operacion</span>
                    </div>
                    <div className="mt-3 grid gap-3 sm:grid-cols-2">
                      <Field label={paymentDestinationLabel(selectedMethod)}>
                        <select
                          value={paymentDraft.accountKey}
                          onChange={(event) => selectPaymentAccount(event.target.value)}
                          className="counter-field"
                        >
                          {selectedMethodAccounts.map((account) => (
                            <option key={paymentAccountKey(account)} value={paymentAccountKey(account)}>
                              {account.accountName}
                            </option>
                          ))}
                        </select>
                      </Field>
                      <Field label={`Monto recibido (${paymentAccount.currencyCode})`}>
                        <input
                          value={paymentDraft.amount}
                          onChange={(event) => updatePayment({ amount: event.target.value })}
                          onFocus={(event) => event.currentTarget.select()}
                          inputMode="decimal"
                          className="counter-field text-lg font-semibold"
                        />
                      </Field>
                      {paymentAccount.currencyCode === 'VES' ? (
                        <Field label="Tasa Bs (canonica)">
                          <input value={paymentDraft.exchangeRate} readOnly className="counter-field cursor-not-allowed text-[#9FA0AA]" />
                        </Field>
                      ) : null}
                      {paymentRequirements.requiresOperationDate ? (
                        <Field label="Fecha de operacion">
                          <input
                            type="date"
                            value={paymentDraft.operationDate}
                            onChange={(event) => {
                              const operationDate = event.target.value;
                              updatePayment({ operationDate });
                              if (paymentAccount.currencyCode === 'VES') refreshPaymentQuote(operationDate);
                            }}
                            className="counter-field"
                          />
                        </Field>
                      ) : null}
                    </div>
                    <div className="mt-3 grid gap-3 lg:grid-cols-3">
                      {paymentRequirements.requiresReference || selectedMethod === 'pos' ? (
                        <Field label={selectedMethod === 'pos' ? 'Ultimos 4 del punto' : 'Referencia'}>
                          <input
                            value={paymentDraft.referenceCode}
                            onChange={(event) => updatePayment({
                              referenceCode: selectedMethod === 'pos'
                                ? event.target.value.replace(/\D/g, '').slice(0, 4)
                                : event.target.value,
                            })}
                            inputMode={selectedMethod === 'pos' ? 'numeric' : undefined}
                            maxLength={selectedMethod === 'pos' ? 4 : undefined}
                            placeholder={selectedMethod === 'pos' ? 'Ej. 4821' : undefined}
                            autoComplete="off"
                            className="counter-field"
                          />
                        </Field>
                      ) : null}
                      {paymentRequirements.requiresBank ? (
                        <Field label="Banco">
                          <input value={paymentDraft.bankName} onChange={(event) => updatePayment({ bankName: event.target.value })} className="counter-field" />
                        </Field>
                      ) : null}
                      {paymentRequirements.requiresHolderName || paymentRequirements.requiresInvoiceNumber ? (
                        <Field label={paymentRequirements.requiresInvoiceNumber ? 'Factura' : 'Titular'}>
                          <input value={paymentDraft.payerName} onChange={(event) => updatePayment({ payerName: event.target.value })} className="counter-field" />
                        </Field>
                      ) : null}
                      {!paymentConfirmsNow ? (
                        <Field label="Nota opcional">
                          <input value={paymentDraft.notes} onChange={(event) => updatePayment({ notes: event.target.value })} className="counter-field" />
                        </Field>
                      ) : null}
                    </div>
                  </div>

                  {expectedMethodChanged ? (
                    <div className="mt-3 rounded-[8px] border border-sky-300/30 bg-sky-300/10 px-3 py-2 text-sm text-sky-100">
                      La orden indicaba {getPaymentMethodLabel(order.paymentMethod)}, pero puedes registrar {getPaymentMethodLabel(selectedMethod)} como el pago real.
                    </div>
                  ) : null}

                  <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
                    {changeAvailableUsd > 0.005 ? (
                      <button
                        type="button"
                        onClick={() => {
                          startAnotherChange();
                          setView('change');
                        }}
                        className="min-h-11 rounded-[8px] border border-sky-300/35 px-4 py-2 text-sm font-semibold text-sky-100"
                      >
                        Entregar cambio disponible
                      </button>
                    ) : <span />}
                    <button
                      type="button"
                      onClick={() => { if (buildPaymentIntent()) setPaymentStage('review'); }}
                      disabled={isWorking || quoteLoading}
                      className="min-h-12 rounded-[8px] border border-[#FEEF00] bg-[#FEEF00] px-5 py-3 text-sm font-bold text-black disabled:opacity-60"
                    >
                      Revisar este pago
                    </button>
                  </div>
                </>
              ) : null}
            </>
          ) : null}

          {paymentStage === 'review' ? (
            <div>
              <div className="rounded-[10px] border border-[#FEEF00]/35 bg-[#FEEF00]/5 p-4">
                <div className="text-center text-sm font-semibold text-[#FEEF00]">Confirma solo este ingreso</div>
                <div className="mt-4 grid gap-2 sm:grid-cols-2">
                  <ReceiptMetric label="Cliente entrega" value={moneyUsd(paymentAmountUsd)} />
                  <ReceiptMetric label="Aplicado a la orden" value={moneyUsd(projectedAppliedUsd)} />
                  <ReceiptMetric label="Saldo pendiente" value={moneyUsd(projectedPendingUsd)} />
                  <ReceiptMetric label="Excedente a fondo" value={moneyUsd(projectedFundUsd)} />
                </div>
                {paymentAccount?.currencyCode === 'VES' ? (
                  <div className="mt-2 text-xs text-[#C7C8D1]">Recibes {moneyBs(paymentAmount)} en {paymentAccount.accountName}.</div>
                ) : null}
                {!paymentConfirmsNow ? (
                  <div className="mt-2 rounded-[8px] border border-orange-400/30 bg-orange-400/10 px-3 py-2 text-xs text-orange-100">
                    Master debe confirmar este pago. Hasta entonces no produce saldo disponible para cambio.
                  </div>
                ) : null}
              </div>
              <div className="mt-4 flex items-center justify-between gap-2">
                <button type="button" onClick={() => setPaymentStage('input')} className="min-h-11 rounded-[8px] border border-[#303044] px-4 py-2 text-sm font-semibold text-[#C7C8D1]">Volver</button>
                <button
                  type="button"
                  onClick={() => void confirmPayment()}
                  disabled={isWorking}
                  className="min-h-12 rounded-[8px] border border-[#FEEF00] bg-[#FEEF00] px-5 py-3 text-sm font-bold text-black disabled:opacity-60"
                >
                  {isWorking ? 'Registrando...' : 'Confirmar ingreso'}
                </button>
              </div>
            </div>
          ) : null}

          {paymentStage === 'receipt' && paymentReceipt ? (
            <div className="rounded-[10px] border border-emerald-400/35 bg-emerald-400/10 p-4">
              <div className="text-base font-semibold text-emerald-100">Ingreso registrado</div>
              <div className="mt-1 text-xs text-emerald-100/70">
                Comprobante {paymentReceipt.idempotencyKey.slice(0, 8).toUpperCase()} · Esta operacion ya quedo cerrada
              </div>
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                <ReceiptMetric label="Confirmado" value={moneyUsd(paymentReceipt.confirmedPaymentUsd)} />
                <ReceiptMetric label="Master revisa" value={moneyUsd(paymentReceipt.pendingPaymentUsd)} />
                <ReceiptMetric label="Falta por cobrar" value={moneyUsd(paymentReceipt.pendingUsd)} />
                <ReceiptMetric label="Disponible para cambio" value={moneyUsd(changeAvailableUsd)} />
              </div>
              <div className="mt-4 flex flex-wrap justify-end gap-2">
                {paymentReceipt.pendingUsd > 0.005 ? (
                  <button type="button" onClick={() => void startAnotherPayment()} disabled={quoteLoading} className="min-h-11 rounded-[8px] border border-emerald-200/40 px-4 py-2 text-sm font-semibold text-emerald-50 disabled:opacity-60">
                    Registrar otro pago
                  </button>
                ) : null}
                {changeAvailableUsd > 0.005 ? (
                  <button
                    type="button"
                    onClick={() => { startAnotherChange(); setView('change'); }}
                    className="min-h-11 rounded-[8px] border border-[#FEEF00] bg-[#FEEF00] px-4 py-2 text-sm font-bold text-black"
                  >
                    Entregar cambio
                  </button>
                ) : (
                  <button type="button" onClick={onFinish} className="min-h-11 rounded-[8px] border border-emerald-200/40 px-4 py-2 text-sm font-semibold text-emerald-50">Terminar</button>
                )}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {view === 'change' ? (
        <div>
          <div className="rounded-[10px] border border-sky-300/35 bg-sky-300/[0.07] p-4 text-center">
            <div className="text-xs font-semibold uppercase tracking-[0.12em] text-sky-100/70">Disponible para entregar</div>
            <div className="mt-1 text-3xl font-bold text-sky-100">{moneyUsd(changeAvailableUsd)}</div>
            <div className="mt-1 text-xs text-sky-100/70">Cada caja se guarda como una operacion independiente.</div>
          </div>

          {changeStage === 'input' ? (
            <div className="mt-4 rounded-[10px] border border-[#303044] bg-[#111118] p-4">
              {cashChangeAccounts.length > 0 && changeAccount ? (
                <>
                  <div className="text-sm font-semibold">¿Desde que caja entregas ahora?</div>
                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    <Field label="Caja">
                      <select value={changeAccountKey} onChange={(event) => selectChangeAccount(event.target.value)} className="counter-field">
                        {cashChangeAccounts.map((account) => (
                          <option key={paymentAccountKey(account)} value={paymentAccountKey(account)}>
                            {account.accountName} · {account.currencyCode}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label={`Monto que entregas (${changeAccount.currencyCode})`}>
                      <input
                        value={changeAmount}
                        onChange={(event) => {
                          changeKeyRef.current = null;
                          setChangeReceipt(null);
                          setError(null);
                          setChangeAmount(event.target.value);
                        }}
                        onFocus={(event) => event.currentTarget.select()}
                        inputMode="decimal"
                        className="counter-field text-lg font-semibold"
                      />
                    </Field>
                    {changeAccount.currencyCode === 'VES' ? (
                      <Field label="Tasa activa">
                        <input value={roundMoney(changeRate).toFixed(2)} readOnly className="counter-field cursor-not-allowed text-[#9FA0AA]" />
                      </Field>
                    ) : null}
                    <Field label="Nota opcional">
                      <input
                        value={changeNotes}
                        onChange={(event) => {
                          changeKeyRef.current = null;
                          setError(null);
                          setChangeNotes(event.target.value);
                        }}
                        placeholder="Ej.: cambio parcial en bolivares"
                        className="counter-field"
                      />
                    </Field>
                  </div>
                  <div className="mt-3 rounded-[8px] border border-sky-300/20 bg-sky-300/5 px-3 py-2 text-sm text-sky-100">
                    Esta entrega equivale a {moneyUsd(changeAmountUsd)}. Al confirmarla quedara cerrada por separado.
                  </div>
                  <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
                    {paymentQuote.pendingUsd > 0.005 ? (
                      <button type="button" onClick={() => setView('payment')} className="min-h-11 rounded-[8px] border border-[#303044] px-4 py-2 text-sm font-semibold text-[#C7C8D1]">Volver al cobro</button>
                    ) : <span />}
                    <button type="button" onClick={reviewChange} className="min-h-12 rounded-[8px] border border-[#FEEF00] bg-[#FEEF00] px-5 py-3 text-sm font-bold text-black">Revisar esta entrega</button>
                  </div>
                </>
              ) : (
                <div className="rounded-[8px] border border-orange-400/35 bg-orange-400/10 p-3 text-sm text-orange-100">
                  No hay una caja de efectivo habilitada para entregar cambio. El saldo permanece seguro en el fondo del cliente.
                </div>
              )}
            </div>
          ) : null}

          {changeStage === 'review' && changeAccount ? (
            <div className="mt-4">
              <div className="rounded-[10px] border border-[#FEEF00]/35 bg-[#FEEF00]/5 p-4">
                <div className="text-center text-sm font-semibold text-[#FEEF00]">Confirma esta entrega de cambio</div>
                <div className="mt-4 grid gap-2 sm:grid-cols-2">
                  <ReceiptMetric label="Sale de" value={changeAccount.accountName} />
                  <ReceiptMetric label="Entregas" value={changeAccount.currencyCode === 'VES' ? moneyBs(changeAmountNumber) : moneyUsd(changeAmountNumber)} />
                  <ReceiptMetric label="Equivale a" value={moneyUsd(changeAmountUsd)} />
                  <ReceiptMetric label="Quedara en fondo" value={moneyUsd(Math.max(0, changeAvailableUsd - changeAmountUsd))} />
                </div>
              </div>
              <div className="mt-4 flex items-center justify-between gap-2">
                <button type="button" onClick={() => setChangeStage('input')} className="min-h-11 rounded-[8px] border border-[#303044] px-4 py-2 text-sm font-semibold text-[#C7C8D1]">Volver</button>
                <button
                  type="button"
                  onClick={() => void confirmChange()}
                  disabled={isWorking}
                  className="min-h-12 rounded-[8px] border border-[#FEEF00] bg-[#FEEF00] px-5 py-3 text-sm font-bold text-black disabled:opacity-60"
                >
                  {isWorking ? 'Registrando...' : 'Confirmar entrega'}
                </button>
              </div>
            </div>
          ) : null}

          {changeStage === 'receipt' && changeReceipt ? (
            <div className="mt-4 rounded-[10px] border border-emerald-400/35 bg-emerald-400/10 p-4">
              <div className="text-base font-semibold text-emerald-100">Cambio entregado</div>
              <div className="mt-1 text-xs text-emerald-100/70">
                Comprobante {changeReceipt.idempotencyKey.slice(0, 8).toUpperCase()} · Esta salida ya quedo cerrada
              </div>
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                <ReceiptMetric label="Caja" value={changeReceipt.accountName} />
                <ReceiptMetric label="Entregado" value={changeReceipt.currencyCode === 'VES' ? moneyBs(changeReceipt.amount) : moneyUsd(changeReceipt.amount)} />
                <ReceiptMetric label="Equivalente" value={moneyUsd(changeReceipt.amountUsdEquivalent)} />
                <ReceiptMetric label="Permanece en fondo" value={moneyUsd(changeReceipt.remainingChangeUsd)} />
              </div>
              <div className="mt-4 flex flex-wrap justify-end gap-2">
                {changeReceipt.remainingChangeUsd > 0.005 ? (
                  <button type="button" onClick={startAnotherChange} className="min-h-11 rounded-[8px] border border-emerald-200/40 px-4 py-2 text-sm font-semibold text-emerald-50">Entregar desde otra caja</button>
                ) : null}
                <button type="button" onClick={onFinish} className="min-h-11 rounded-[8px] border border-[#FEEF00] bg-[#FEEF00] px-4 py-2 text-sm font-bold text-black">
                  {changeReceipt.remainingChangeUsd > 0.005
                    ? `Terminar y dejar ${moneyUsd(changeReceipt.remainingChangeUsd)} en fondo`
                    : 'Terminar'}
                </button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {view === 'finished' ? (
        <div className="rounded-[10px] border border-emerald-400/35 bg-emerald-400/10 p-4 text-center text-emerald-100">Atencion terminada.</div>
      ) : null}

      {error ? (
        <div className="mt-3 rounded-[8px] border border-red-400/35 bg-red-400/10 px-3 py-2 text-sm text-red-200">{error}</div>
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

function ProgressStep({ active, completed, label }: { active: boolean; completed: boolean; label: string }) {
  return (
    <div
      className={[
        'rounded-full border px-3 py-2 text-center text-xs font-semibold',
        active
          ? 'border-[#FEEF00] bg-[#FEEF00]/10 text-[#FEEF00]'
          : completed
            ? 'border-emerald-400/35 bg-emerald-400/10 text-emerald-200'
            : 'border-[#303044] bg-[#111118] text-[#777988]',
      ].join(' ')}
    >
      {label}
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
