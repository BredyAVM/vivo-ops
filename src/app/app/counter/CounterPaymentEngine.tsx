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

function paymentAccountKey(account: CounterPaymentAccountOption) {
  return `${account.accountId}|${account.paymentMethodCode}`;
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
  if (!account.canConfirmPayment && !account.autoConfirmsReport) return false;
  const name = account.accountName.toLocaleLowerCase('es-VE');
  return name.includes('dar') || name.includes('dark');
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
        const leftImmediate =
          left.canConfirmPayment && left.autoConfirmsReport && !left.reviewRequired ? 1 : 0;
        const rightImmediate =
          right.canConfirmPayment && right.autoConfirmsReport && !right.reviewRequired ? 1 : 0;
        return rightImmediate - leftImmediate || left.accountName.localeCompare(right.accountName, 'es');
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

  const firstAccount = reportAccounts[0] ?? null;
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

  function invalidateIntent() {
    idempotencyKey.current = null;
    setReviewOpen(false);
    setReceipt(null);
    setError(null);
  }

  function accountForPayment(line: PaymentDraft) {
    return reportAccounts.find((account) => paymentAccountKey(account) === line.accountKey) ?? null;
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
  const projectedNetConfirmedUsd = roundMoney(paymentSummary.confirmed - totalChangeUsd);
  const projectedPendingUsd = Math.max(0, roundMoney(order.balanceUsd - projectedNetConfirmedUsd));
  const projectedOverpaidUsd = Math.max(0, roundMoney(projectedNetConfirmedUsd - order.balanceUsd));
  const fundCreditUsd = changeLines.length > 0
    ? projectedOverpaidUsd
    : Math.max(0, roundMoney(paymentSummary.confirmed - order.balanceUsd));

  function addPaymentLine() {
    invalidateIntent();
    if (!firstAccount) return;
    const remaining = Math.max(0, order.balanceUsd - paymentSummary.reported);
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

  function addChangeLine(mode: 'cash' | 'digital_pending') {
    invalidateIntent();
    const optionKey =
      mode === 'cash'
        ? firstCashChangeAccount ? paymentAccountKey(firstCashChangeAccount) : ''
        : firstDigitalChange?.key ?? '';
    if (!optionKey) {
      setError(
        mode === 'cash'
          ? 'No hay una caja DAR habilitada para entregar cambio.'
          : 'No hay un metodo digital habilitado para registrar cambio pendiente.'
      );
      return;
    }
    const id = `change-${nextChangeId.current}`;
    nextChangeId.current += 1;
    setChangeLines((current) => [...current, {
      id,
      mode,
      optionKey,
      amount: '',
      exchangeRate: String(roundMoney(order.fxRate)),
      notes: '',
    }]);
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

    const handling =
      preparedChange.length > 0
        ? 'change_given'
        : paymentSummary.confirmed > order.balanceUsd + 0.005
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
        <div className="text-sm font-semibold text-emerald-100">Cobro registrado una sola vez</div>
        <div className="mt-1 text-xs text-emerald-100/70">
          Comprobante {receipt.idempotencyKey.slice(0, 8).toUpperCase()} · Orden #{order.displayNumber}
        </div>
        <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <ReceiptMetric label="Confirmado" value={moneyUsd(receipt.confirmedPaymentUsd)} />
          <ReceiptMetric label="Por revisar" value={moneyUsd(receipt.pendingPaymentUsd)} />
          <ReceiptMetric label="Cambio efectivo" value={moneyUsd(receipt.cashChangeUsd)} />
          <ReceiptMetric label="Cambio digital pendiente" value={moneyUsd(receipt.digitalChangePendingUsd)} />
          <ReceiptMetric label="Fondo cliente" value={moneyUsd(receipt.fundCreditUsd)} />
          <ReceiptMetric label="Saldo orden" value={moneyUsd(receipt.pendingUsd)} />
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-[8px] border border-[#242433] bg-[#0B0B0D] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold">Caja registradora</h3>
          <p className="mt-1 text-sm text-[#9FA0AA]">
            Registra el pago, el cambio real y cualquier parte digital pendiente como una sola operacion.
          </p>
        </div>
        <div className="flex flex-wrap gap-2 text-xs">
          <SummaryPill label="Recibido" value={moneyUsd(paymentSummary.reported)} />
          <SummaryPill label="Confirma ahora" value={moneyUsd(paymentSummary.confirmed)} tone="good" />
          <SummaryPill label="Por revisar" value={moneyUsd(paymentSummary.pending)} tone="warn" />
        </div>
      </div>

      <div className="mt-4 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div className="text-xs font-semibold uppercase tracking-[0.12em] text-[#9FA0AA]">
            Lineas de pago
          </div>
          <button
            type="button"
            onClick={addPaymentLine}
            className="rounded-full border border-[#FEEF00]/50 bg-[#FEEF00]/10 px-3 py-1.5 text-xs font-semibold text-[#FEEF00]"
          >
            Agregar pago
          </button>
        </div>

        {paymentLines.map((line, index) => {
          const account = accountForPayment(line) ?? firstAccount;
          const requirements = getPaymentReportRequirements(account?.paymentMethodCode);
          return (
            <div key={line.id} className="rounded-[8px] border border-[#242433] bg-[#111118] p-3">
              <div className="grid gap-3 lg:grid-cols-[1.4fr_0.7fr_0.55fr_0.7fr_auto]">
                <Field label="Cuenta">
                  <select
                    value={line.accountKey}
                    onChange={(event) => updatePaymentLine(line.id, { accountKey: event.target.value })}
                    className="counter-field"
                  >
                    {reportAccounts.map((item) => (
                      <option key={paymentAccountKey(item)} value={paymentAccountKey(item)}>
                        {item.accountName} - {getPaymentMethodLabel(item.paymentMethodCode)}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={`Monto ${account?.currencyCode ?? ''}`}>
                  <input
                    value={line.amount}
                    onChange={(event) => updatePaymentLine(line.id, { amount: event.target.value })}
                    inputMode="decimal"
                    className="counter-field"
                  />
                </Field>
                {account?.currencyCode === 'VES' ? (
                  <Field label="Tasa">
                    <input
                      value={line.exchangeRate}
                      onChange={(event) => updatePaymentLine(line.id, { exchangeRate: event.target.value })}
                      inputMode="decimal"
                      className="counter-field"
                    />
                  </Field>
                ) : <div />}
                <Field label="Fecha">
                  <input
                    type="date"
                    value={line.operationDate}
                    onChange={(event) => updatePaymentLine(line.id, { operationDate: event.target.value })}
                    className="counter-field"
                  />
                </Field>
                <div className="flex items-end">
                  <button
                    type="button"
                    disabled={paymentLines.length === 1}
                    onClick={() => {
                      invalidateIntent();
                      setPaymentLines((current) => current.filter((item) => item.id !== line.id));
                    }}
                    className="w-full rounded-[8px] border border-red-400/35 px-3 py-3 text-xs font-semibold text-red-200 disabled:opacity-40"
                  >
                    {index === 0 && paymentLines.length === 1 ? 'Linea unica' : 'Quitar'}
                  </button>
                </div>
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
                <Field label="Nota">
                  <input
                    value={line.notes}
                    onChange={(event) => updatePaymentLine(line.id, { notes: event.target.value })}
                    className="counter-field"
                  />
                </Field>
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-4 rounded-[8px] border border-sky-400/25 bg-sky-400/5 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="text-sm font-semibold text-sky-100">Cambio</div>
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
              Efectivo
            </button>
            <button
              type="button"
              onClick={() => addChangeLine('digital_pending')}
              className="rounded-full border border-sky-300/35 px-3 py-1.5 text-xs font-semibold text-sky-100"
            >
              Digital pendiente
            </button>
          </div>
        </div>

        {changeLines.length === 0 ? (
          <div className="mt-3 text-xs text-[#9FA0AA]">Sin cambio en esta operacion.</div>
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

      <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
        <ReceiptMetric label="Neto confirmado" value={moneyUsd(projectedNetConfirmedUsd)} />
        <ReceiptMetric label="Cambio efectivo" value={moneyUsd(changeSummary.cash)} />
        <ReceiptMetric label="Digital pendiente" value={moneyUsd(changeSummary.digital)} />
        <ReceiptMetric label="Fondo" value={moneyUsd(fundCreditUsd)} />
        <ReceiptMetric label="Saldo resultante" value={moneyUsd(projectedPendingUsd)} />
      </div>

      {error ? (
        <div className="mt-3 rounded-[8px] border border-red-400/35 bg-red-400/10 px-3 py-2 text-sm text-red-200">
          {error}
        </div>
      ) : null}

      {reviewOpen ? (
        <div className="mt-4 rounded-[8px] border border-[#FEEF00]/35 bg-[#FEEF00]/5 p-4">
          <div className="text-sm font-semibold text-[#FEEF00]">Confirmar una sola operacion</div>
          <p className="mt-1 text-xs leading-relaxed text-[#C7C8D1]">
            Se registrarán {paymentLines.length} pago(s), {changeLines.length} linea(s) de cambio,
            {` ${moneyUsd(fundCreditUsd)}`} a fondo y un saldo resultante estimado de {moneyUsd(projectedPendingUsd)}.
          </p>
          {changeSummary.digital > 0.005 ? (
            <div className="mt-2 rounded-[8px] border border-orange-400/30 bg-orange-400/10 px-3 py-2 text-xs text-orange-100">
              El cambio digital quedará pendiente. No se mostrará como dinero entregado hasta que sea confirmado.
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
              {isWorking ? 'Registrando...' : 'Confirmar cobro'}
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
            Revisar cobro
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

function SummaryPill({
  label,
  value,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  tone?: 'neutral' | 'good' | 'warn';
}) {
  const toneClass =
    tone === 'good'
      ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-100'
      : tone === 'warn'
        ? 'border-orange-400/30 bg-orange-400/10 text-orange-100'
        : 'border-[#303044] text-[#C7C8D1]';
  return (
    <span className={`rounded-full border px-3 py-1 ${toneClass}`}>
      {label}: {value}
    </span>
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
