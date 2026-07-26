'use client';

import { useRef, useState } from 'react';
import type {
  CounterOrder,
  CounterPaymentAccountOption,
} from './CounterClient';
import type {
  CounterRefundExecutionIntent,
  CounterRefundExecutionResult,
  CounterRefundRequestIntent,
  CounterRefundRequestResult,
} from './payment-contract';

type RefundDraft = {
  id: string;
  accountId: number;
  amount: string;
  exchangeRate: string;
  referenceCode: string;
  notes: string;
};

function roundMoney(value: number) {
  return Number((Number.isFinite(value) ? value : 0).toFixed(2));
}

function decimal(value: string) {
  return Number(String(value || '').replace(',', '.'));
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

function isDirectCashAccount(account: CounterPaymentAccountOption) {
  if (account.accountKind !== 'cash') return false;
  if (!account.canConfirmPayment && !account.autoConfirmsReport) return false;
  const name = account.accountName.toLocaleLowerCase('es-VE');
  return name.includes('dar') || name.includes('dark');
}

export function CounterRefundPanel({
  order,
  paymentAccounts,
  isWorking,
  onRequest,
  onExecute,
}: {
  order: CounterOrder;
  paymentAccounts: CounterPaymentAccountOption[];
  isWorking: boolean;
  onRequest: (intent: CounterRefundRequestIntent) => Promise<CounterRefundRequestResult>;
  onExecute: (intent: CounterRefundExecutionIntent) => Promise<CounterRefundExecutionResult>;
}) {
  const cashAccounts = paymentAccounts.filter(isDirectCashAccount);
  const firstAccount = cashAccounts[0] ?? null;
  const reservedRefundUsd = order.refundAuthorizations.reduce(
    (sum, authorization) =>
      authorization.status === 'pending' || authorization.status === 'approved'
        ? sum + authorization.amountUsdEquivalent
        : sum,
    0
  );
  const availableRefundUsd = Math.max(
    0,
    roundMoney(order.overpaidUsd - order.pendingDigitalChangeUsd - reservedRefundUsd)
  );
  const nextLineId = useRef(2);
  const requestKey = useRef<string | null>(null);
  const executionKeys = useRef(new Map<string, string>());
  const [requestOpen, setRequestOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [lines, setLines] = useState<RefundDraft[]>(() =>
    firstAccount
      ? [{
          id: 'refund-1',
          accountId: firstAccount.accountId,
          amount:
            firstAccount.currencyCode === 'VES'
              ? roundMoney(availableRefundUsd * order.fxRate).toFixed(2)
              : roundMoney(availableRefundUsd).toFixed(2),
          exchangeRate: firstAccount.currencyCode === 'VES' ? String(roundMoney(order.fxRate)) : '',
          referenceCode: '',
          notes: '',
        }]
      : []
  );
  const [operationDate, setOperationDate] = useState(todayCaracas());
  const [executionNotes, setExecutionNotes] = useState('');
  const [message, setMessage] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);

  const refundableUsd = lines.reduce((sum, line) => {
    const account = cashAccounts.find((item) => item.accountId === line.accountId);
    const amount = decimal(line.amount);
    if (!account || !Number.isFinite(amount) || amount <= 0) return sum;
    if (account.currencyCode === 'USD') return sum + amount;
    const rate = decimal(line.exchangeRate);
    return rate > 0 ? sum + amount / rate : sum;
  }, 0);

  function invalidateRequest() {
    requestKey.current = null;
    setReviewOpen(false);
    setMessage(null);
  }

  function addLine() {
    invalidateRequest();
    if (!firstAccount) return;
    const id = `refund-${nextLineId.current}`;
    nextLineId.current += 1;
    setLines((current) => [...current, {
      id,
      accountId: firstAccount.accountId,
      amount: '',
      exchangeRate: firstAccount.currencyCode === 'VES' ? String(roundMoney(order.fxRate)) : '',
      referenceCode: '',
      notes: '',
    }]);
  }

  function updateLine(id: string, patch: Partial<RefundDraft>) {
    invalidateRequest();
    setLines((current) => current.map((line) => {
      if (line.id !== id) return line;
      const next = { ...line, ...patch };
      if (patch.accountId) {
        const account = cashAccounts.find((item) => item.accountId === patch.accountId);
        next.exchangeRate = account?.currencyCode === 'VES' ? String(roundMoney(order.fxRate)) : '';
      }
      return next;
    }));
  }

  function validateRequest() {
    if (!reason.trim()) {
      setMessage({ tone: 'error', text: 'La devolucion requiere un motivo.' });
      return false;
    }
    if (lines.length < 1) {
      setMessage({ tone: 'error', text: 'Agrega al menos una linea de devolucion.' });
      return false;
    }
    for (const line of lines) {
      const account = cashAccounts.find((item) => item.accountId === line.accountId);
      const amount = decimal(line.amount);
      const rate = decimal(line.exchangeRate);
      if (!account || !Number.isFinite(amount) || amount <= 0) {
        setMessage({ tone: 'error', text: 'Revisa la cuenta y el monto de cada devolucion.' });
        return false;
      }
      if (account.currencyCode === 'VES' && (!Number.isFinite(rate) || rate <= 0)) {
        setMessage({ tone: 'error', text: 'Indica una tasa valida para la devolucion en bolivares.' });
        return false;
      }
    }
    if (refundableUsd > availableRefundUsd + 0.01) {
      setMessage({
        tone: 'error',
        text: `La solicitud no puede superar el saldo disponible de ${moneyUsd(availableRefundUsd)}.`,
      });
      return false;
    }
    setMessage(null);
    return true;
  }

  async function requestRefund() {
    if (!validateRequest()) return;
    if (!requestKey.current) requestKey.current = crypto.randomUUID();
    const intent: CounterRefundRequestIntent = {
      idempotencyKey: requestKey.current,
      orderId: order.id,
      reason: reason.trim(),
      refundLines: lines.map((line) => {
        const account = cashAccounts.find((item) => item.accountId === line.accountId)!;
        return {
          lineKey: line.id,
          moneyAccountId: account.accountId,
          currencyCode: account.currencyCode,
          amount: roundMoney(decimal(line.amount)),
          exchangeRateVesPerUsd:
            account.currencyCode === 'VES' ? decimal(line.exchangeRate) : null,
          referenceCode: line.referenceCode.trim() || null,
          notes: line.notes.trim() || null,
        };
      }),
    };

    try {
      const result = await onRequest(intent);
      setReviewOpen(false);
      setRequestOpen(false);
      setMessage({
        tone: 'success',
        text: `Solicitud ${result.movementGroupId.slice(0, 8).toUpperCase()} enviada por ${moneyUsd(result.amountUsdEquivalent)}.`,
      });
    } catch (requestError) {
      setMessage({
        tone: 'error',
        text: requestError instanceof Error ? requestError.message : 'No se pudo solicitar la devolucion.',
      });
    }
  }

  async function executeRefund(groupId: string) {
    let key = executionKeys.current.get(groupId);
    if (!key) {
      key = crypto.randomUUID();
      executionKeys.current.set(groupId, key);
    }
    try {
      const result = await onExecute({
        idempotencyKey: key,
        refundGroupId: groupId,
        operationDate,
        notes: executionNotes.trim() || null,
      });
      setMessage({
        tone: 'success',
        text: `Devolucion ejecutada por ${moneyUsd(result.amountUsdEquivalent)}.`,
      });
    } catch (executionError) {
      setMessage({
        tone: 'error',
        text: executionError instanceof Error ? executionError.message : 'No se pudo ejecutar la devolucion.',
      });
    }
  }

  const openAuthorizations = order.refundAuthorizations.filter(
    (authorization) => authorization.status === 'pending' || authorization.status === 'approved'
  );

  if (availableRefundUsd <= 0.005 && openAuthorizations.length === 0) return null;

  return (
    <div className="rounded-[8px] border border-violet-400/30 bg-violet-400/5 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold text-violet-100">Devolucion autorizada</h3>
          <p className="mt-1 text-xs leading-relaxed text-violet-100/65">
            Counter solicita la devolucion; Master o Administracion debe autorizarla antes de entregar efectivo.
          </p>
        </div>
        {availableRefundUsd > 0.005 ? (
          <span className="rounded-full border border-violet-300/30 px-3 py-1 text-xs font-semibold text-violet-100">
            Disponible {moneyUsd(availableRefundUsd)}
          </span>
        ) : null}
      </div>

      {openAuthorizations.length > 0 ? (
        <div className="mt-3 space-y-2">
          {openAuthorizations.map((authorization) => (
            <div
              key={authorization.movementGroupId}
              className="rounded-[8px] border border-violet-300/20 bg-[#0B0B0D] p-3"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="text-sm font-semibold text-[#F5F5F7]">
                    {moneyUsd(authorization.amountUsdEquivalent)}
                  </div>
                  <div className="mt-1 text-xs text-[#9FA0AA]">
                    {authorization.status === 'approved'
                      ? 'Autorizada: ya puede entregarse'
                      : 'Esperando autorizacion'}
                  </div>
                </div>
                <span
                  className={[
                    'rounded-full border px-3 py-1 text-xs font-semibold',
                    authorization.status === 'approved'
                      ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-100'
                      : 'border-orange-400/30 bg-orange-400/10 text-orange-100',
                  ].join(' ')}
                >
                  {authorization.status === 'approved' ? 'Aprobada' : 'Pendiente'}
                </span>
              </div>
              {authorization.status === 'approved' ? (
                <div className="mt-3 grid gap-2 sm:grid-cols-[160px_1fr_auto]">
                  <input
                    type="date"
                    value={operationDate}
                    onChange={(event) => setOperationDate(event.target.value)}
                    className="rounded-[8px] border border-[#303044] bg-[#111118] px-3 py-2 text-sm text-[#F5F5F7]"
                  />
                  <input
                    value={executionNotes}
                    onChange={(event) => setExecutionNotes(event.target.value)}
                    placeholder="Nota de entrega del efectivo"
                    className="rounded-[8px] border border-[#303044] bg-[#111118] px-3 py-2 text-sm text-[#F5F5F7]"
                  />
                  <button
                    type="button"
                    onClick={() => void executeRefund(authorization.movementGroupId)}
                    disabled={isWorking}
                    className="rounded-[8px] border border-emerald-400/40 bg-emerald-400/10 px-4 py-2 text-sm font-bold text-emerald-100 disabled:opacity-50"
                  >
                    {isWorking ? 'Ejecutando...' : 'Entregar efectivo'}
                  </button>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      {availableRefundUsd > 0.005 ? (
        <>
          <button
            type="button"
            onClick={() => setRequestOpen((current) => !current)}
            className="mt-3 rounded-[8px] border border-violet-300/35 px-4 py-2 text-sm font-semibold text-violet-100"
          >
            {requestOpen ? 'Ocultar solicitud' : 'Solicitar devolucion'}
          </button>

          {requestOpen ? (
            <div className="mt-3 space-y-3 border-t border-violet-300/15 pt-3">
              {cashAccounts.length === 0 ? (
                <div className="text-sm text-orange-200">No hay cajas DAR habilitadas para devolver efectivo.</div>
              ) : null}
              {lines.map((line, index) => {
                const account = cashAccounts.find((item) => item.accountId === line.accountId) ?? firstAccount;
                return (
                  <div key={line.id} className="grid gap-2 lg:grid-cols-[1.3fr_0.7fr_0.55fr_1fr_auto]">
                    <select
                      value={line.accountId}
                      onChange={(event) => updateLine(line.id, { accountId: Number(event.target.value) })}
                      className="rounded-[8px] border border-[#303044] bg-[#0B0B0D] px-3 py-2 text-sm text-[#F5F5F7]"
                    >
                      {cashAccounts.map((item) => (
                        <option key={item.accountId} value={item.accountId}>{item.accountName}</option>
                      ))}
                    </select>
                    <input
                      value={line.amount}
                      onChange={(event) => updateLine(line.id, { amount: event.target.value })}
                      placeholder={`Monto ${account?.currencyCode ?? ''}`}
                      inputMode="decimal"
                      className="rounded-[8px] border border-[#303044] bg-[#0B0B0D] px-3 py-2 text-sm text-[#F5F5F7]"
                    />
                    {account?.currencyCode === 'VES' ? (
                      <input
                        value={line.exchangeRate}
                        onChange={(event) => updateLine(line.id, { exchangeRate: event.target.value })}
                        placeholder="Tasa"
                        inputMode="decimal"
                        className="rounded-[8px] border border-[#303044] bg-[#0B0B0D] px-3 py-2 text-sm text-[#F5F5F7]"
                      />
                    ) : <div />}
                    <input
                      value={line.notes}
                      onChange={(event) => updateLine(line.id, { notes: event.target.value })}
                      placeholder="Nota de la linea"
                      className="rounded-[8px] border border-[#303044] bg-[#0B0B0D] px-3 py-2 text-sm text-[#F5F5F7]"
                    />
                    <button
                      type="button"
                      disabled={lines.length === 1}
                      onClick={() => {
                        invalidateRequest();
                        setLines((current) => current.filter((item) => item.id !== line.id));
                      }}
                      className="rounded-[8px] border border-red-400/35 px-3 py-2 text-xs font-semibold text-red-200 disabled:opacity-40"
                    >
                      {index === 0 && lines.length === 1 ? 'Linea unica' : 'Quitar'}
                    </button>
                  </div>
                );
              })}
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={addLine}
                  disabled={!firstAccount}
                  className="rounded-full border border-violet-300/30 px-3 py-1.5 text-xs font-semibold text-violet-100 disabled:opacity-40"
                >
                  Agregar caja
                </button>
                <span className="rounded-full border border-[#303044] px-3 py-1.5 text-xs text-[#C7C8D1]">
                  Solicitud {moneyUsd(refundableUsd)}
                </span>
              </div>
              <textarea
                value={reason}
                onChange={(event) => {
                  invalidateRequest();
                  setReason(event.target.value);
                }}
                placeholder="Motivo obligatorio"
                rows={2}
                className="w-full rounded-[8px] border border-[#303044] bg-[#0B0B0D] px-3 py-2 text-sm text-[#F5F5F7]"
              />
              {reviewOpen ? (
                <div className="rounded-[8px] border border-[#FEEF00]/30 bg-[#FEEF00]/5 p-3">
                  <div className="text-sm font-semibold text-[#FEEF00]">
                    Confirmar solicitud por {moneyUsd(refundableUsd)}
                  </div>
                  <div className="mt-2 flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => setReviewOpen(false)}
                      className="rounded-[8px] border border-[#303044] px-3 py-2 text-xs font-semibold text-[#C7C8D1]"
                    >
                      Volver
                    </button>
                    <button
                      type="button"
                      onClick={() => void requestRefund()}
                      disabled={isWorking}
                      className="rounded-[8px] border border-[#FEEF00] bg-[#FEEF00] px-3 py-2 text-xs font-bold text-black disabled:opacity-50"
                    >
                      {isWorking ? 'Enviando...' : 'Enviar a autorizacion'}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex justify-end">
                  <button
                    type="button"
                    onClick={() => {
                      if (validateRequest()) setReviewOpen(true);
                    }}
                    disabled={isWorking || cashAccounts.length === 0}
                    className="rounded-[8px] border border-violet-300/40 bg-violet-300/10 px-4 py-2 text-sm font-bold text-violet-100 disabled:opacity-50"
                  >
                    Revisar solicitud
                  </button>
                </div>
              )}
            </div>
          ) : null}
        </>
      ) : null}

      {message ? (
        <div
          className={[
            'mt-3 rounded-[8px] border px-3 py-2 text-sm',
            message.tone === 'success'
              ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-100'
              : 'border-red-400/30 bg-red-400/10 text-red-100',
          ].join(' ')}
        >
          {message.text}
        </div>
      ) : null}
    </div>
  );
}
