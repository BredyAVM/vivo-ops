'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  recordCounterDeliveryReturnAction,
} from './actions';
import {
  loadCounterDeliverySettlementDetailAction,
  loadCounterPendingSettlementsAction,
} from './read-actions';
import { requiresCounterDeliveryMoneyHandling } from './delivery-contract';
import type {
  CounterDeliveryCashLine,
  CounterDeliveryCurrency,
  CounterDeliveryDigitalChangeLine,
  CounterDeliveryDispatchIntent,
  CounterDeliveryDispatchResult,
  CounterDeliveryReturnIntent,
  CounterDeliverySettlementDetail,
  CounterDeliveryValueLine,
} from './delivery-contract';
import type {
  CounterOrder,
  CounterPaymentAccountOption,
} from './CounterClient';
import type {
  CounterPendingSettlementCursor,
  CounterPendingSettlementRead,
} from './read-model';

type ValueDraft = {
  id: string;
  currencyCode: CounterDeliveryCurrency;
  amount: string;
  referenceCode: string;
};

type CashDraft = {
  id: string;
  accountId: number;
  amount: string;
  referenceCode: string;
};

type DigitalDraft = ValueDraft & {
  paymentMethodCode: CounterDeliveryDigitalChangeLine['paymentMethodCode'];
};

const DELIVERY_ETA_PRESETS = [10, 15, 20, 30, 45, 60] as const;

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

function amountLabel(value: number, currency: CounterDeliveryCurrency) {
  if (currency === 'VES') {
    return `${new Intl.NumberFormat('es-VE', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(Number(value || 0))} Bs`;
  }
  return moneyUsd(value);
}

function formatDateTime(value: string | null) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('es-VE', {
    timeZone: 'America/Caracas',
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(date);
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
  return account.accountKind === 'cash' &&
    (account.canConfirmPayment || account.autoConfirmsReport);
}

function amountUsd(
  currencyCode: CounterDeliveryCurrency,
  amount: number,
  activeBsRate: number
) {
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  if (currencyCode === 'USD') return amount;
  return activeBsRate > 0 ? amount / activeBsRate : 0;
}

function valueDraftToIntent(
  line: ValueDraft,
  activeBsRate: number
): CounterDeliveryValueLine {
  return {
    lineKey: line.id,
    currencyCode: line.currencyCode,
    amount: roundMoney(decimal(line.amount)),
    exchangeRateVesPerUsd: line.currencyCode === 'VES' ? activeBsRate : null,
    referenceCode: line.referenceCode.trim() || null,
    notes: null,
  };
}

function cashDraftToIntent(
  line: CashDraft,
  cashAccounts: CounterPaymentAccountOption[],
  activeBsRate: number
): CounterDeliveryCashLine {
  const account = cashAccounts.find((item) => item.accountId === line.accountId);
  if (!account) throw new Error('Selecciona una caja valida.');

  return {
    lineKey: line.id,
    moneyAccountId: account.accountId,
    currencyCode: account.currencyCode,
    amount: roundMoney(decimal(line.amount)),
    exchangeRateVesPerUsd: account.currencyCode === 'VES' ? activeBsRate : null,
    operationDate: todayCaracas(),
    referenceCode: line.referenceCode.trim() || null,
    notes: null,
  };
}

function createValueDraft(
  prefix: string,
  currencyCode: CounterDeliveryCurrency = 'USD',
  amount = ''
): ValueDraft {
  return {
    id: `${prefix}-${crypto.randomUUID()}`,
    currencyCode,
    amount,
    referenceCode: '',
  };
}

function settlementStatusLabel(status: CounterDeliverySettlementDetail['status']) {
  if (status === 'not_required') return 'Sin liquidacion';
  if (status === 'open') return 'Abierta';
  if (status === 'partial') return 'Parcial';
  if (status === 'settled') return 'Liquidada';
  if (status === 'discrepancy') return 'Diferencia';
  if (status === 'voided') return 'Anulada';
  return status;
}

function settlementStatusClass(status: CounterDeliverySettlementDetail['status']) {
  if (status === 'settled' || status === 'not_required') {
    return 'border-emerald-400/40 bg-emerald-400/10 text-emerald-200';
  }
  if (status === 'discrepancy') {
    return 'border-red-400/40 bg-red-400/10 text-red-200';
  }
  return 'border-orange-400/40 bg-orange-400/10 text-orange-100';
}

function dispatchInitialExpected(order: CounterOrder): ValueDraft[] {
  const changeAmount = decimal(order.paymentChangeFor || '');
  const changeCurrency = order.paymentChangeCurrency === 'VES' ? 'VES' : 'USD';
  if (order.paymentRequiresChange && changeAmount > 0) {
    return [createValueDraft('expected', changeCurrency, String(roundMoney(changeAmount)))];
  }
  if (order.paymentMethod === 'cash_usd' && order.balanceUsd > 0.005) {
    return [createValueDraft('expected', 'USD', String(roundMoney(order.balanceUsd)))];
  }
  if (order.paymentMethod === 'cash_ves' && order.balanceUsd > 0.005 && order.fxRate > 0) {
    return [
      createValueDraft(
        'expected',
        'VES',
        String(roundMoney(order.balanceUsd * order.fxRate))
      ),
    ];
  }
  return [];
}

export function CounterDeliveryDispatchPanel({
  order,
  paymentAccounts,
  activeBsRate,
  isWorking,
  onSubmit,
  onCancel,
}: {
  order: CounterOrder;
  paymentAccounts: CounterPaymentAccountOption[];
  activeBsRate: number;
  isWorking: boolean;
  onSubmit: (
    intent: CounterDeliveryDispatchIntent
  ) => Promise<CounterDeliveryDispatchResult>;
  onCancel: () => void;
}) {
  const cashAccounts = useMemo(
    () => paymentAccounts.filter(isDirectCashAccount),
    [paymentAccounts]
  );
  const [etaMinutes, setEtaMinutes] = useState('20');
  const [expectedLines, setExpectedLines] = useState<ValueDraft[]>(
    () => dispatchInitialExpected(order)
  );
  const [cashChangeLines, setCashChangeLines] = useState<CashDraft[]>([]);
  const [digitalChangeLines, setDigitalChangeLines] = useState<DigitalDraft[]>([]);
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const requestKey = useRef<string | null>(null);
  const requiresMoneyHandling = requiresCounterDeliveryMoneyHandling(order);
  const advisorOwnsCollection =
    order.hasAdvisor && !requiresMoneyHandling && order.balanceUsd > 0.005;

  function invalidate() {
    requestKey.current = null;
    setError(null);
  }

  const expectedUsd = roundMoney(expectedLines.reduce(
    (sum, line) => sum + amountUsd(line.currencyCode, decimal(line.amount), activeBsRate),
    0
  ));
  const cashChangeUsd = roundMoney(cashChangeLines.reduce((sum, line) => {
    const account = cashAccounts.find((item) => item.accountId === line.accountId);
    return sum + (account
      ? amountUsd(account.currencyCode, decimal(line.amount), activeBsRate)
      : 0);
  }, 0));
  const digitalChangeUsd = roundMoney(digitalChangeLines.reduce(
    (sum, line) => sum + amountUsd(line.currencyCode, decimal(line.amount), activeBsRate),
    0
  ));
  const requiredChangeUsd = roundMoney(Math.max(expectedUsd - order.balanceUsd, 0));
  const assignedChangeUsd = roundMoney(cashChangeUsd + digitalChangeUsd);
  const differenceUsd = roundMoney(requiredChangeUsd - assignedChangeUsd);
  const eta = Math.round(decimal(etaMinutes));
  const etaIsValid = Number.isFinite(eta) && eta >= 1 && eta <= 1440;
  const showChangeControls =
    requiresMoneyHandling
    && (
      order.paymentRequiresChange
      || requiredChangeUsd > 0.005
      || cashChangeLines.length > 0
      || digitalChangeLines.length > 0
    );

  async function submit() {
    try {
      if (!Number.isFinite(eta) || eta < 1 || eta > 1440) {
        throw new Error('Indica un ETA entre 1 y 1440 minutos.');
      }
      if (activeBsRate <= 0 && [
        ...expectedLines.map((line) => line.currencyCode),
        ...digitalChangeLines.map((line) => line.currencyCode),
        ...cashChangeLines.map((line) =>
          cashAccounts.find((account) => account.accountId === line.accountId)?.currencyCode
        ),
      ].includes('VES')) {
        throw new Error('No hay una tasa activa valida para operar en bolivares.');
      }
      if (Math.abs(differenceUsd) > 0.02) {
        throw new Error(
          differenceUsd > 0
            ? `Falta asignar ${moneyUsd(differenceUsd)} de cambio.`
            : `El cambio supera lo requerido por ${moneyUsd(Math.abs(differenceUsd))}.`
        );
      }

      const expectedCollectionLines = expectedLines
        .filter((line) => decimal(line.amount) > 0)
        .map((line) => valueDraftToIntent(line, activeBsRate));
      const cashLines = cashChangeLines
        .filter((line) => decimal(line.amount) > 0)
        .map((line) => cashDraftToIntent(line, cashAccounts, activeBsRate));
      const digitalLines = digitalChangeLines
        .filter((line) => decimal(line.amount) > 0)
        .map((line): CounterDeliveryDigitalChangeLine => ({
          ...valueDraftToIntent(line, activeBsRate),
          paymentMethodCode: line.paymentMethodCode,
        }));

      if (!requestKey.current) requestKey.current = crypto.randomUUID();
      await onSubmit({
        idempotencyKey: requestKey.current,
        orderId: order.id,
        etaMinutes: eta,
        expectedCollectionLines,
        cashChangeLines: cashLines,
        digitalChangeLines: digitalLines,
        notes: notes.trim() || null,
      });
    } catch (submitError) {
      setError(
        submitError instanceof Error
          ? submitError.message
          : 'No se pudo registrar la salida.'
      );
    }
  }

  return (
    <div className="rounded-[10px] border border-sky-400/35 bg-sky-950/20 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-base font-semibold text-sky-100">
            {requiresMoneyHandling ? 'Despachar con cobro o cambio' : 'Entregar al motorizado'}
          </div>
          <p className="mt-1 text-xs leading-relaxed text-sky-100/70">
            {requiresMoneyHandling
              ? 'Confirma el tiempo y prepara solamente el dinero indicado en la orden.'
              : 'Confirma el tiempo estimado y registra la salida. No hay dinero a cargo de Mostrador.'}
          </p>
        </div>
        <span className="rounded-full border border-sky-300/30 bg-sky-300/10 px-2.5 py-1 text-xs font-semibold text-sky-100">
          {order.deliveryAssigneeName || 'Sin asignar'}
        </span>
      </div>

      <div className="mt-4 rounded-[10px] border border-[#FEEF00]/35 bg-[#FEEF00]/[0.06] p-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#FEEF00]/75">
              Tiempo de entrega
            </div>
            <div className="mt-1 text-sm font-semibold text-[#F5F5F7]">
              ¿En cuánto tiempo llegará?
            </div>
            <p className="mt-1 text-xs text-[#C7C8D1]">
              Pregúntale al motorizado y selecciona el estimado.
            </p>
          </div>
          <div className="rounded-full border border-[#FEEF00]/40 bg-[#FEEF00]/10 px-3 py-1.5 text-sm font-bold text-[#FEEF00]">
            {etaIsValid ? `${eta} min` : 'Sin tiempo'}
          </div>
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          {DELIVERY_ETA_PRESETS.map((minutes) => {
            const selected = eta === minutes;
            return (
              <button
                key={minutes}
                type="button"
                aria-pressed={selected}
                onClick={() => {
                  invalidate();
                  setEtaMinutes(String(minutes));
                }}
                className={[
                  'min-h-10 min-w-[64px] rounded-full border px-3 py-2 text-xs font-bold transition',
                  selected
                    ? 'border-[#FEEF00] bg-[#FEEF00] text-black'
                    : 'border-[#3A3A47] bg-[#0B0B0D] text-[#C7C8D1] hover:border-[#FEEF00]/60 hover:text-[#FEEF00]',
                ].join(' ')}
              >
                {minutes} min
              </button>
            );
          })}
        </div>

        <label className="mt-3 block text-xs font-semibold text-[#C7C8D1]">
          Otro tiempo
          <div className="relative mt-1 max-w-[180px]">
            <input
              value={etaMinutes}
              onChange={(event) => {
                invalidate();
                setEtaMinutes(event.target.value);
              }}
              type="number"
              inputMode="numeric"
              min={1}
              max={1440}
              aria-label="Tiempo estimado en minutos"
              className="w-full rounded-[8px] border border-[#3A3A47] bg-[#0B0B0D] px-3 py-2.5 pr-12 text-base font-semibold text-[#F5F5F7] outline-none focus:border-[#FEEF00]"
            />
            <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-[#9FA0AA]">
              min
            </span>
          </div>
        </label>
      </div>

      {requiresMoneyHandling ? (
        <>
          <div className="mt-4 rounded-[8px] border border-orange-400/30 bg-orange-950/15 px-3 py-2.5">
            <div className="text-xs font-semibold text-orange-100">
              Dinero indicado en la orden
            </div>
            <p className="mt-1 text-[11px] leading-relaxed text-orange-100/70">
              Registra únicamente lo que el motorizado cobrará o el cambio que realmente lleva.
            </p>
          </div>

          <DeliveryValueDrafts
            title="Cobro esperado del cliente"
            helper="Lo que el motorizado recibirá del cliente. El saldo restante puede continuar con el asesor."
            lines={expectedLines}
            onChange={(lines) => {
              invalidate();
              setExpectedLines(lines);
            }}
            addLabel="Agregar moneda"
          />

          {showChangeControls ? (
            <>
              <DeliveryCashDrafts
                title="Cambio en efectivo que sale de caja"
                helper="Este monto genera el egreso exacto y queda vinculado a la orden."
                lines={cashChangeLines}
                cashAccounts={cashAccounts}
                onChange={(lines) => {
                  invalidate();
                  setCashChangeLines(lines);
                }}
                addLabel="Agregar cambio efectivo"
              />

              <DeliveryDigitalDrafts
                lines={digitalChangeLines}
                onChange={(lines) => {
                  invalidate();
                  setDigitalChangeLines(lines);
                }}
              />

              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                <DeliveryMetric label="Cambio requerido" value={moneyUsd(requiredChangeUsd)} />
                <DeliveryMetric
                  label="Cambio asignado"
                  value={moneyUsd(assignedChangeUsd)}
                  tone={Math.abs(differenceUsd) <= 0.02 ? 'good' : 'warn'}
                />
              </div>
              {Math.abs(differenceUsd) > 0.02 ? (
                <div className="mt-2 text-xs font-semibold text-orange-100">
                  {differenceUsd > 0
                    ? `Falta asignar ${moneyUsd(differenceUsd)}.`
                    : `Sobra ${moneyUsd(Math.abs(differenceUsd))}.`}
                </div>
              ) : null}

              {digitalChangeUsd > 0.005 ? (
                <div className="mt-3 rounded-[8px] border border-violet-400/30 bg-violet-950/20 p-2.5 text-xs leading-relaxed text-violet-100">
                  Counter solo registra el cambio digital: lo ejecuta el asesor asignado o Master si la orden no tiene asesor.
                </div>
              ) : null}
            </>
          ) : null}
        </>
      ) : (
        <div className="mt-4 rounded-[10px] border border-emerald-400/30 bg-emerald-950/20 p-3">
          <div className="text-sm font-semibold text-emerald-100">
            Sin liquidación de caja
          </div>
          <p className="mt-1 text-xs leading-relaxed text-emerald-100/75">
            {advisorOwnsCollection
              ? `${order.advisorName || 'El asesor'} mantiene la cobranza. Mostrador solo entrega el pedido y registra el ETA.`
              : 'Esta salida no requiere cobro ni cambio. Mostrador solo entrega el pedido y registra el ETA.'}
          </p>
        </div>
      )}

      <label className="mt-3 block text-xs font-semibold text-[#C7C8D1]">
        Nota de salida
        <textarea
          value={notes}
          onChange={(event) => {
            invalidate();
            setNotes(event.target.value);
          }}
          rows={2}
          className="mt-1 w-full rounded-[8px] border border-[#303044] bg-[#0B0B0D] px-3 py-2 text-sm text-[#F5F5F7] outline-none focus:border-sky-300"
        />
      </label>

      {error ? <div className="mt-3 text-xs font-semibold text-red-200">{error}</div> : null}

      <div className="mt-4 grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={isWorking}
          className="min-h-11 rounded-[8px] border border-[#303044] bg-[#0B0B0D] px-3 py-2 text-xs font-semibold text-[#F5F5F7] disabled:opacity-50"
        >
          Cancelar
        </button>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={
            isWorking
            || !order.deliveryAssigneeName
            || !etaIsValid
            || Math.abs(differenceUsd) > 0.02
          }
          className="min-h-11 rounded-[8px] border border-[#FEEF00] bg-[#FEEF00] px-3 py-2 text-xs font-bold text-black transition hover:bg-[#FFF45B] disabled:cursor-not-allowed disabled:border-[#3A3A47] disabled:bg-[#24242D] disabled:text-[#777988]"
        >
          {isWorking
            ? 'Registrando...'
            : etaIsValid
              ? `Confirmar salida · ${eta} min`
              : 'Indica el tiempo'}
        </button>
      </div>
    </div>
  );
}

function DeliveryValueDrafts({
  title,
  helper,
  lines,
  onChange,
  addLabel,
  disabled = false,
}: {
  title: string;
  helper: string;
  lines: ValueDraft[];
  onChange: (lines: ValueDraft[]) => void;
  addLabel: string;
  disabled?: boolean;
}) {
  return (
    <div className="mt-3 rounded-[8px] border border-[#303044] bg-[#0B0B0D] p-2.5">
      <div className="text-xs font-semibold text-[#F5F5F7]">{title}</div>
      <p className="mt-1 text-[11px] leading-relaxed text-[#9FA0AA]">{helper}</p>
      <div className="mt-2 space-y-2">
        {lines.map((line) => (
          <div key={line.id} className="grid gap-2 sm:grid-cols-[92px_1fr_1fr_auto]">
            <select
              value={line.currencyCode}
              disabled={disabled}
              onChange={(event) => onChange(lines.map((item) =>
                item.id === line.id
                  ? { ...item, currencyCode: event.target.value === 'VES' ? 'VES' : 'USD' }
                  : item
              ))}
              className="rounded-[8px] border border-[#303044] bg-[#111118] px-2 py-2 text-xs"
            >
              <option value="USD">USD</option>
              <option value="VES">Bs</option>
            </select>
            <input
              value={line.amount}
              disabled={disabled}
              onChange={(event) => onChange(lines.map((item) =>
                item.id === line.id ? { ...item, amount: event.target.value } : item
              ))}
              inputMode="decimal"
              placeholder="Monto"
              className="rounded-[8px] border border-[#303044] bg-[#111118] px-3 py-2 text-xs"
            />
            <input
              value={line.referenceCode}
              disabled={disabled}
              onChange={(event) => onChange(lines.map((item) =>
                item.id === line.id ? { ...item, referenceCode: event.target.value } : item
              ))}
              placeholder="Referencia opcional"
              className="rounded-[8px] border border-[#303044] bg-[#111118] px-3 py-2 text-xs"
            />
            <button
              type="button"
              disabled={disabled}
              onClick={() => onChange(lines.filter((item) => item.id !== line.id))}
              className="rounded-[8px] border border-red-400/30 px-2 py-2 text-xs text-red-200 disabled:opacity-50"
            >
              Quitar
            </button>
          </div>
        ))}
      </div>
      {!disabled ? (
        <button
          type="button"
          onClick={() => onChange([...lines, createValueDraft('value')])}
          className="mt-2 rounded-[8px] border border-[#303044] px-3 py-1.5 text-xs font-semibold text-[#C7C8D1]"
        >
          + {addLabel}
        </button>
      ) : null}
    </div>
  );
}

function DeliveryCashDrafts({
  title,
  helper,
  lines,
  cashAccounts,
  onChange,
  addLabel,
}: {
  title: string;
  helper: string;
  lines: CashDraft[];
  cashAccounts: CounterPaymentAccountOption[];
  onChange: (lines: CashDraft[]) => void;
  addLabel: string;
}) {
  const firstAccount = cashAccounts[0] ?? null;
  return (
    <div className="mt-3 rounded-[8px] border border-[#303044] bg-[#0B0B0D] p-2.5">
      <div className="text-xs font-semibold text-[#F5F5F7]">{title}</div>
      <p className="mt-1 text-[11px] leading-relaxed text-[#9FA0AA]">{helper}</p>
      <div className="mt-2 space-y-2">
        {lines.map((line) => (
          <div key={line.id} className="grid gap-2 sm:grid-cols-[1.2fr_1fr_1fr_auto]">
            <select
              value={line.accountId}
              onChange={(event) => onChange(lines.map((item) =>
                item.id === line.id ? { ...item, accountId: Number(event.target.value) } : item
              ))}
              className="rounded-[8px] border border-[#303044] bg-[#111118] px-2 py-2 text-xs"
            >
              {cashAccounts.map((account) => (
                <option key={account.accountId} value={account.accountId}>
                  {account.accountName} · {account.currencyCode}
                </option>
              ))}
            </select>
            <input
              value={line.amount}
              onChange={(event) => onChange(lines.map((item) =>
                item.id === line.id ? { ...item, amount: event.target.value } : item
              ))}
              inputMode="decimal"
              placeholder="Monto"
              className="rounded-[8px] border border-[#303044] bg-[#111118] px-3 py-2 text-xs"
            />
            <input
              value={line.referenceCode}
              onChange={(event) => onChange(lines.map((item) =>
                item.id === line.id ? { ...item, referenceCode: event.target.value } : item
              ))}
              placeholder="Referencia opcional"
              className="rounded-[8px] border border-[#303044] bg-[#111118] px-3 py-2 text-xs"
            />
            <button
              type="button"
              onClick={() => onChange(lines.filter((item) => item.id !== line.id))}
              className="rounded-[8px] border border-red-400/30 px-2 py-2 text-xs text-red-200"
            >
              Quitar
            </button>
          </div>
        ))}
      </div>
      {cashAccounts.length === 0 ? (
        <div className="mt-2 text-xs text-red-200">No hay cajas directas habilitadas.</div>
      ) : (
        <button
          type="button"
          onClick={() => onChange([
            ...lines,
            {
              id: `cash-${crypto.randomUUID()}`,
              accountId: firstAccount!.accountId,
              amount: '',
              referenceCode: '',
            },
          ])}
          className="mt-2 rounded-[8px] border border-[#303044] px-3 py-1.5 text-xs font-semibold text-[#C7C8D1]"
        >
          + {addLabel}
        </button>
      )}
    </div>
  );
}

function DeliveryDigitalDrafts({
  lines,
  onChange,
}: {
  lines: DigitalDraft[];
  onChange: (lines: DigitalDraft[]) => void;
}) {
  return (
    <div className="mt-3 rounded-[8px] border border-violet-400/25 bg-violet-950/10 p-2.5">
      <div className="text-xs font-semibold text-violet-100">Cambio digital pendiente</div>
      <p className="mt-1 text-[11px] leading-relaxed text-violet-100/60">
        Se registra como obligacion; Counter no ejecuta la transferencia.
      </p>
      <div className="mt-2 space-y-2">
        {lines.map((line) => (
          <div key={line.id} className="grid gap-2 sm:grid-cols-[90px_1fr_1.2fr_auto]">
            <select
              value={line.currencyCode}
              onChange={(event) => onChange(lines.map((item) =>
                item.id === line.id
                  ? { ...item, currencyCode: event.target.value === 'VES' ? 'VES' : 'USD' }
                  : item
              ))}
              className="rounded-[8px] border border-violet-400/25 bg-[#111118] px-2 py-2 text-xs"
            >
              <option value="USD">USD</option>
              <option value="VES">Bs</option>
            </select>
            <input
              value={line.amount}
              onChange={(event) => onChange(lines.map((item) =>
                item.id === line.id ? { ...item, amount: event.target.value } : item
              ))}
              inputMode="decimal"
              placeholder="Monto"
              className="rounded-[8px] border border-violet-400/25 bg-[#111118] px-3 py-2 text-xs"
            />
            <select
              value={line.paymentMethodCode}
              onChange={(event) => onChange(lines.map((item) =>
                item.id === line.id
                  ? {
                      ...item,
                      paymentMethodCode:
                        event.target.value as DigitalDraft['paymentMethodCode'],
                    }
                  : item
              ))}
              className="rounded-[8px] border border-violet-400/25 bg-[#111118] px-2 py-2 text-xs"
            >
              <option value="payment_mobile">Pago movil</option>
              <option value="transfer">Transferencia</option>
              <option value="zelle">Zelle</option>
              <option value="other">Otro</option>
            </select>
            <button
              type="button"
              onClick={() => onChange(lines.filter((item) => item.id !== line.id))}
              className="rounded-[8px] border border-red-400/30 px-2 py-2 text-xs text-red-200"
            >
              Quitar
            </button>
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={() => onChange([
          ...lines,
          {
            ...createValueDraft('digital'),
            paymentMethodCode: 'payment_mobile',
          },
        ])}
        className="mt-2 rounded-[8px] border border-violet-400/30 px-3 py-1.5 text-xs font-semibold text-violet-100"
      >
        + Agregar cambio digital
      </button>
    </div>
  );
}

function DeliveryMetric({
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
  return (
    <div className="rounded-[8px] border border-[#303044] bg-[#0B0B0D] p-2.5">
      <div className="text-[11px] uppercase tracking-wide text-[#9FA0AA]">{label}</div>
      <div className={[
        'mt-1 text-sm font-semibold',
        tone === 'good'
          ? 'text-emerald-200'
          : tone === 'warn'
            ? 'text-orange-100'
            : 'text-[#F5F5F7]',
      ].join(' ')}>
        {value}
      </div>
      {note ? <div className="mt-1 text-[11px] text-[#9FA0AA]">{note}</div> : null}
    </div>
  );
}

function buildReturnDrafts(
  detail: CounterDeliverySettlementDetail,
  cashAccounts: CounterPaymentAccountOption[]
) {
  const collectionLines: ValueDraft[] = [];
  const cashReturnLines: CashDraft[] = [];

  for (const currency of detail.currencyBreakdown) {
    const remainingExpected = roundMoney(Math.max(
      currency.expectedCollection - currency.customerCollection,
      0
    ));
    if (!detail.collectionFinalizedAt && remainingExpected > 0.005) {
      collectionLines.push(
        createValueDraft('collected', currency.currencyCode, String(remainingExpected))
      );
    }

    const amountToReturn = roundMoney(
      currency.custodyOutstanding + remainingExpected
    );
    const account = cashAccounts.find(
      (item) => item.currencyCode === currency.currencyCode
    );
    if (account && amountToReturn > 0.005) {
      cashReturnLines.push({
        id: `return-${crypto.randomUUID()}`,
        accountId: account.accountId,
        amount: String(amountToReturn),
        referenceCode: '',
      });
    }
  }

  return { collectionLines, cashReturnLines };
}

export function CounterDeliverySettlementBox({
  orderId,
  settlementId,
  paymentAccounts,
  activeBsRate,
  onChanged,
  onReadMetric,
}: {
  orderId?: number | null;
  settlementId?: number | null;
  paymentAccounts: CounterPaymentAccountOption[];
  activeBsRate: number;
  onChanged?: () => void | Promise<void>;
  onReadMetric?: (durationMs: number, succeeded: boolean) => void;
}) {
  const cashAccounts = useMemo(
    () => paymentAccounts.filter(isDirectCashAccount),
    [paymentAccounts]
  );
  const [detail, setDetail] = useState<CounterDeliverySettlementDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [collectionLines, setCollectionLines] = useState<ValueDraft[]>([]);
  const [cashReturnLines, setCashReturnLines] = useState<CashDraft[]>([]);
  const [collectionFinal, setCollectionFinal] = useState(false);
  const [notes, setNotes] = useState('');
  const [message, setMessage] = useState<{
    tone: 'success' | 'error';
    text: string;
  } | null>(null);
  const requestKey = useRef<string | null>(null);

  const loadDetail = useCallback(async () => {
    const startedAt = performance.now();
    let succeeded = false;
    setLoading(true);
    try {
      const next = await loadCounterDeliverySettlementDetailAction({
        orderId: orderId ?? null,
        settlementId: settlementId ?? null,
      });
      setDetail(next);
      const drafts = buildReturnDrafts(next, cashAccounts);
      setCollectionLines(drafts.collectionLines);
      setCashReturnLines(drafts.cashReturnLines);
      setCollectionFinal(false);
      setNotes('');
      requestKey.current = null;
      succeeded = true;
    } catch (loadError) {
      setMessage({
        tone: 'error',
        text: loadError instanceof Error
          ? loadError.message
          : 'No se pudo cargar la liquidacion.',
      });
    } finally {
      onReadMetric?.(performance.now() - startedAt, succeeded);
      setLoading(false);
    }
  }, [cashAccounts, onReadMetric, orderId, settlementId]);

  useEffect(() => {
    void loadDetail();
  }, [loadDetail]);

  function invalidate() {
    requestKey.current = null;
    setMessage(null);
  }

  async function submitReturn() {
    if (!detail) return;
    setWorking(true);
    setMessage(null);
    try {
      if (!requestKey.current) requestKey.current = crypto.randomUUID();
      const intent: CounterDeliveryReturnIntent = {
        idempotencyKey: requestKey.current,
        orderId: detail.orderId,
        customerCollectionLines: collectionLines
          .filter((line) => decimal(line.amount) > 0)
          .map((line) => valueDraftToIntent(line, activeBsRate)),
        cashReturnLines: cashReturnLines
          .filter((line) => decimal(line.amount) > 0)
          .map((line) => cashDraftToIntent(line, cashAccounts, activeBsRate)),
        collectionFinal,
        notes: notes.trim() || null,
      };
      const result = await recordCounterDeliveryReturnAction(intent);
      setMessage({
        tone: 'success',
        text: result.settlementStatus === 'settled'
          ? 'La custodia del delivery quedo liquidada.'
          : result.settlementStatus === 'discrepancy'
            ? 'La cobranza fue cerrada con una diferencia pendiente de revision.'
            : 'El retorno parcial quedo registrado y seguira visible.',
      });
      await loadDetail();
      await onChanged?.();
    } catch (submitError) {
      setMessage({
        tone: 'error',
        text: submitError instanceof Error
          ? submitError.message
          : 'No se pudo registrar el retorno.',
      });
    } finally {
      setWorking(false);
    }
  }

  if (loading && !detail) {
    return (
      <div className="rounded-[8px] border border-sky-400/30 bg-sky-950/20 p-4 text-sm text-sky-100/70">
        Cargando liquidacion exacta...
      </div>
    );
  }
  if (!detail) {
    return (
      <div className="rounded-[8px] border border-red-400/30 bg-red-950/20 p-4 text-sm text-red-100">
        {message?.text || 'No se encontro la liquidacion.'}
      </div>
    );
  }

  if (detail.status === 'not_required') {
    return (
      <div className="rounded-[10px] border border-emerald-400/30 bg-emerald-950/20 p-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="font-semibold text-emerald-100">
              En camino · sin liquidación de caja
            </h3>
            <p className="mt-1 text-xs text-emerald-100/70">
              {detail.responsibleName} · salida {formatDateTime(detail.dispatchedAt)}
              {detail.etaMinutes ? ` · ETA ${detail.etaMinutes} min` : ''}
            </p>
          </div>
          <span className="rounded-full border border-emerald-400/40 bg-emerald-400/10 px-3 py-1 text-xs font-semibold text-emerald-200">
            Sin retorno pendiente
          </span>
        </div>
        <p className="mt-3 text-xs leading-relaxed text-emerald-100/80">
          {detail.orderPendingUsd > 0.005 && detail.advisorName
            ? `${detail.advisorName} mantiene la cobranza pendiente de la orden. Counter no debe registrar efectivo ni cambio para este despacho.`
            : 'Este despacho no llevó cobro ni cambio. Counter no tiene ninguna operación de caja pendiente.'}
        </p>
      </div>
    );
  }

  const canReceiveReturn = !['settled', 'not_required', 'voided'].includes(detail.status);
  const digitalOutstanding = detail.currencyBreakdown.reduce(
    (sum, item) => sum + amountUsd(
      item.currencyCode,
      item.digitalChangeOutstanding,
      activeBsRate
    ),
    0
  );
  const custodyOutstanding = detail.currencyBreakdown.reduce(
    (sum, item) => sum + amountUsd(
      item.currencyCode,
      item.custodyOutstanding,
      activeBsRate
    ),
    0
  );

  return (
    <div className="rounded-[8px] border border-sky-400/30 bg-sky-950/15 p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold text-sky-100">
            Liquidacion de orden #{detail.displayNumber}
          </h3>
          <p className="mt-1 text-xs text-sky-100/65">
            {detail.responsibleName} · salida {formatDateTime(detail.dispatchedAt)}
            {detail.etaMinutes ? ` · ETA ${detail.etaMinutes} min` : ''}
          </p>
        </div>
        <span className={[
          'rounded-full border px-3 py-1 text-xs font-semibold',
          settlementStatusClass(detail.status),
        ].join(' ')}>
          {settlementStatusLabel(detail.status)}
        </span>
      </div>

      <div className="mt-3 grid gap-2 sm:grid-cols-3">
        <DeliveryMetric
          label="Custodia pendiente"
          value={moneyUsd(custodyOutstanding)}
          tone={custodyOutstanding > 0.005 ? 'warn' : 'good'}
        />
        <DeliveryMetric
          label="Saldo de la orden"
          value={moneyUsd(detail.orderPendingUsd)}
          note="No se confunde con la custodia"
          tone={detail.orderPendingUsd > 0.005 ? 'warn' : 'good'}
        />
        <DeliveryMetric
          label="Cambio digital pendiente"
          value={moneyUsd(digitalOutstanding)}
          note={detail.advisorName ? `Responsable: ${detail.advisorName}` : 'Responsable: Master'}
          tone={digitalOutstanding > 0.005 ? 'warn' : 'good'}
        />
      </div>

      <div className="mt-3 space-y-2">
        {detail.currencyBreakdown.map((currency) => (
          <div
            key={currency.currencyCode}
            className="grid gap-2 rounded-[8px] border border-[#303044] bg-[#0B0B0D] p-2.5 text-xs sm:grid-cols-4"
          >
            <div>
              <div className="text-[#9FA0AA]">Esperado</div>
              <div className="mt-1 font-semibold">
                {amountLabel(currency.expectedCollection, currency.currencyCode)}
              </div>
            </div>
            <div>
              <div className="text-[#9FA0AA]">Cliente entrego</div>
              <div className="mt-1 font-semibold">
                {amountLabel(currency.customerCollection, currency.currencyCode)}
              </div>
            </div>
            <div>
              <div className="text-[#9FA0AA]">Ingreso a caja</div>
              <div className="mt-1 font-semibold text-emerald-200">
                {amountLabel(currency.cashReturned, currency.currencyCode)}
              </div>
            </div>
            <div>
              <div className="text-[#9FA0AA]">Cambio enviado</div>
              <div className="mt-1 font-semibold">
                {amountLabel(currency.cashChangeSent, currency.currencyCode)}
              </div>
            </div>
          </div>
        ))}
      </div>

      {canReceiveReturn ? (
        <>
          <DeliveryValueDrafts
            title="Efectivo que el cliente entrego al motorizado"
            helper="Se registra una sola vez. Puede ser menor al saldo de la orden; la deuda restante sigue con el asesor."
            lines={collectionLines}
            onChange={(lines) => {
              invalidate();
              setCollectionLines(lines);
            }}
            addLabel="Agregar cobro del cliente"
            disabled={Boolean(detail.collectionFinalizedAt)}
          />
          <DeliveryCashDrafts
            title="Efectivo que el motorizado entrega ahora a caja"
            helper="Cada linea genera un ingreso confirmado. Puede ser parcial y continuar otro dia."
            lines={cashReturnLines}
            cashAccounts={cashAccounts}
            onChange={(lines) => {
              invalidate();
              setCashReturnLines(lines);
            }}
            addLabel="Agregar ingreso a caja"
          />

          <label className="mt-3 flex items-start gap-2 rounded-[8px] border border-[#303044] bg-[#0B0B0D] p-3 text-xs text-[#C7C8D1]">
            <input
              type="checkbox"
              checked={collectionFinal}
              disabled={Boolean(detail.collectionFinalizedAt)}
              onChange={(event) => {
                invalidate();
                setCollectionFinal(event.target.checked);
              }}
              className="mt-0.5 h-4 w-4 accent-[#FEEF00]"
            />
            <span>
              <span className="block font-semibold text-[#F5F5F7]">
                Cerrar la cobranza declarada por el motorizado
              </span>
              Si queda efectivo bajo custodia, la liquidacion pasara a diferencia. Esto no liquida por fuerza el saldo del cliente.
            </span>
          </label>

          <textarea
            value={notes}
            onChange={(event) => {
              invalidate();
              setNotes(event.target.value);
            }}
            rows={2}
            placeholder="Nota del retorno (opcional)"
            className="mt-3 w-full rounded-[8px] border border-[#303044] bg-[#0B0B0D] px-3 py-2 text-sm"
          />
          <button
            type="button"
            onClick={() => void submitReturn()}
            disabled={working}
            className="mt-3 w-full rounded-[8px] border border-sky-300/50 bg-sky-300/10 px-4 py-2.5 text-sm font-bold text-sky-100 disabled:cursor-wait disabled:opacity-50"
          >
            {working ? 'Registrando...' : 'Registrar retorno'}
          </button>
        </>
      ) : (
        <div className="mt-3 rounded-[8px] border border-emerald-400/30 bg-emerald-950/20 p-3 text-xs text-emerald-100">
          Esta custodia ya no admite retornos. La entrega fisica final sigue siendo control exclusivo de Master.
        </div>
      )}

      {message ? (
        <div className={[
          'mt-3 rounded-[8px] border p-3 text-xs font-semibold',
          message.tone === 'success'
            ? 'border-emerald-400/30 bg-emerald-950/20 text-emerald-100'
            : 'border-red-400/30 bg-red-950/20 text-red-100',
        ].join(' ')}>
          {message.text}
        </div>
      ) : null}
    </div>
  );
}

export function CounterPendingSettlementsPanel({
  paymentAccounts,
  activeBsRate,
  onChanged,
  refreshToken = 0,
  onReadMetric,
}: {
  paymentAccounts: CounterPaymentAccountOption[];
  activeBsRate: number;
  onChanged?: () => void | Promise<void>;
  refreshToken?: number;
  onReadMetric?: (durationMs: number, succeeded: boolean) => void;
}) {
  const [settlements, setSettlements] = useState<CounterPendingSettlementRead[]>([]);
  const [nextCursor, setNextCursor] = useState<CounterPendingSettlementCursor | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadFirstPageInFlightRef = useRef<Promise<void> | null>(null);
  const lastRefreshTokenRef = useRef(refreshToken);

  const loadFirstPage = useCallback(() => {
    if (loadFirstPageInFlightRef.current) return loadFirstPageInFlightRef.current;
    const request = (async () => {
      const startedAt = performance.now();
      let succeeded = false;
      setLoading(true);
      setError(null);
      try {
        const page = await loadCounterPendingSettlementsAction();
        setSettlements(page.results);
        setNextCursor(page.nextCursor);
        succeeded = true;
      } catch (loadError) {
        setError(
          loadError instanceof Error
            ? loadError.message
            : 'No se pudieron cargar las liquidaciones.'
        );
      } finally {
        onReadMetric?.(performance.now() - startedAt, succeeded);
        setLoading(false);
        loadFirstPageInFlightRef.current = null;
      }
    })();
    loadFirstPageInFlightRef.current = request;
    return request;
  }, [onReadMetric]);

  useEffect(() => {
    void loadFirstPage();
  }, [loadFirstPage]);

  useEffect(() => {
    if (refreshToken === lastRefreshTokenRef.current) return;
    lastRefreshTokenRef.current = refreshToken;
    void loadFirstPage();
  }, [loadFirstPage, refreshToken]);

  async function loadMore() {
    if (!nextCursor) return;
    const startedAt = performance.now();
    let succeeded = false;
    setLoadingMore(true);
    try {
      const page = await loadCounterPendingSettlementsAction({ cursor: nextCursor });
      setSettlements((current) => [
        ...current,
        ...page.results.filter(
          (item) => !current.some((existing) => existing.id === item.id)
        ),
      ]);
      setNextCursor(page.nextCursor);
      succeeded = true;
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : 'No se pudieron cargar mas liquidaciones.'
      );
    } finally {
      onReadMetric?.(performance.now() - startedAt, succeeded);
      setLoadingMore(false);
    }
  }

  return (
    <section className="mt-5 rounded-[8px] border border-sky-400/30 bg-[#111118] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-sky-100">Liquidaciones abiertas</h2>
          <p className="mt-1 text-sm text-[#9FA0AA]">
            Incluye pendientes de dias anteriores. Se consulta solo al abrir este panel.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void loadFirstPage()}
          disabled={loading}
          className="rounded-full border border-sky-300/30 px-3 py-1.5 text-xs font-semibold text-sky-100 disabled:opacity-50"
        >
          {loading ? 'Actualizando...' : 'Actualizar'}
        </button>
      </div>

      {error ? <div className="mt-3 text-sm text-red-200">{error}</div> : null}
      {!loading && settlements.length === 0 ? (
        <div className="mt-4 rounded-[8px] border border-emerald-400/25 bg-emerald-950/15 p-4 text-sm text-emerald-100">
          No hay custodias pendientes.
        </div>
      ) : (
        <div className="mt-4 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
          {settlements.map((settlement) => (
            <button
              key={settlement.id}
              type="button"
              onClick={() => setSelectedId(settlement.id)}
              className={[
                'rounded-[8px] border p-3 text-left transition',
                selectedId === settlement.id
                  ? 'border-sky-300 bg-sky-950/30'
                  : 'border-[#303044] bg-[#0B0B0D] hover:border-sky-300/50',
              ].join(' ')}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold">Orden #{settlement.displayNumber}</span>
                <span className="text-xs text-orange-100">
                  {settlement.status === 'discrepancy'
                    ? 'Diferencia'
                    : settlement.status === 'partial'
                      ? 'Parcial'
                      : 'Abierta'}
                </span>
              </div>
              <div className="mt-1 text-xs text-[#C7C8D1]">
                {settlement.clientName} · {settlement.responsibleName}
              </div>
              <div className="mt-2 text-xs text-[#9FA0AA]">
                Salida {formatDateTime(settlement.dispatchedAt)}
              </div>
              <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
                <span>Cliente: {moneyUsd(settlement.customerCollectionUsd)}</span>
                <span>Caja: {moneyUsd(settlement.cashReturnedUsd)}</span>
              </div>
            </button>
          ))}
        </div>
      )}

      {nextCursor ? (
        <button
          type="button"
          onClick={() => void loadMore()}
          disabled={loadingMore}
          className="mt-3 rounded-[8px] border border-[#303044] px-4 py-2 text-xs font-semibold text-[#C7C8D1] disabled:opacity-50"
        >
          {loadingMore ? 'Cargando...' : 'Cargar mas'}
        </button>
      ) : null}

      {selectedId ? (
        <div className="mt-4">
          <CounterDeliverySettlementBox
            key={selectedId}
            settlementId={selectedId}
            paymentAccounts={paymentAccounts}
            activeBsRate={activeBsRate}
            onReadMetric={onReadMetric}
            onChanged={async () => {
              await loadFirstPage();
              await onChanged?.();
            }}
          />
        </div>
      ) : null}
    </section>
  );
}
