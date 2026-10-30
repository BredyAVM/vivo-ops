'use client';

import { useEffect, useRef, useState } from 'react';
import { getPaymentMethodLabel } from '@/lib/orders/order-labels';
import { loadCounterCashMovementsAction } from './read-actions';
import type {
  CounterCashAccountSummary,
  CounterCashMovement,
  CounterCashMovementCursor,
} from './CounterClient';

export type CounterCashMovementInput = {
  idempotencyKey: string;
  direction: 'inflow' | 'outflow';
  moneyAccountId: number;
  amount: number;
  movementDate: string;
  exchangeRateVesPerUsd: number | null;
  referenceCode: string | null;
  counterpartyName: string | null;
  description: string;
  notes: string | null;
};

export type CounterCashClosureInput = {
  idempotencyKey: string;
  moneyAccountId: number;
  closureDate: string;
  closureTime: string;
  countedAmount: number;
  exchangeRateVesPerUsd: number | null;
  reason: string;
  notes: string | null;
};

type StableCommandKey = {
  fingerprint: string;
  key: string;
};

function stableCommandKey(
  current: StableCommandKey | null,
  payload: unknown
): StableCommandKey {
  const fingerprint = JSON.stringify(payload);
  if (current?.fingerprint === fingerprint) return current;
  return { fingerprint, key: crypto.randomUUID() };
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

function formatDateTime(value: string | null) {
  if (!value) return 'Sin hora';
  return new Date(value).toLocaleString('es-VE', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: 'America/Caracas',
  });
}

function accountKindLabel(value: string | null) {
  if (value === 'cash') return 'Caja';
  if (value === 'pos') return 'Punto';
  if (value === 'bank') return 'Banco';
  if (value === 'wallet') return 'Wallet';
  return 'Cuenta';
}

export function CounterCashPanel({
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
  onCreateMovement: (input: CounterCashMovementInput) => Promise<boolean>;
  onCreateClosure: (input: CounterCashClosureInput) => Promise<boolean>;
}) {
  const firstAccount = accounts[0] ?? null;
  const movementAccounts = accounts.filter((account) => account.accountKind === 'cash');
  const firstMovementAccount = movementAccounts[0] ?? null;
  const [movementOpen, setMovementOpen] = useState(false);
  const [movementAccountId, setMovementAccountId] = useState(
    firstMovementAccount ? String(firstMovementAccount.accountId) : ''
  );
  const [movementDirection, setMovementDirection] = useState<'inflow' | 'outflow'>('inflow');
  const [movementAmount, setMovementAmount] = useState('');
  const [movementDate, setMovementDate] = useState(getTodayKey());
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
  const [closureReason, setClosureReason] = useState('Cierre de turno');
  const [closureNotes, setClosureNotes] = useState('');
  const [closureError, setClosureError] = useState<string | null>(null);
  const [detailAccountId, setDetailAccountId] = useState(firstAccount ? String(firstAccount.accountId) : '');
  const [additionalMovements, setAdditionalMovements] = useState<CounterCashMovement[]>([]);
  const [movementCursor, setMovementCursor] = useState<CounterCashMovementCursor | null>(null);
  const [movementPageLoading, setMovementPageLoading] = useState(false);
  const [movementPageError, setMovementPageError] = useState<string | null>(null);
  const movementCommandKeyRef = useRef<StableCommandKey | null>(null);
  const closureCommandKeyRef = useRef<StableCommandKey | null>(null);
  const selectedAccount =
    movementAccounts.find((account) => String(account.accountId) === movementAccountId)
    ?? firstMovementAccount;
  const selectedClosureAccount =
    accounts.find((account) => String(account.accountId) === closureAccountId) ?? firstAccount;
  const detailAccount =
    accounts.find((account) => String(account.accountId) === detailAccountId) ?? firstAccount;
  const selectedClosureIsPos = selectedClosureAccount?.accountKind === 'pos';
  const selectedClosureExpectedAmount = selectedClosureAccount?.closureExpectedAmount ?? 0;
  const closureCountedNumber = toDecimalInput(closureAmount);
  const closureDifference =
    selectedClosureAccount && Number.isFinite(closureCountedNumber)
      ? Number((closureCountedNumber - selectedClosureExpectedAmount).toFixed(2))
      : 0;
  const closureMatches = Number.isFinite(closureCountedNumber)
    && Math.abs(closureDifference) <= 0.009;
  const movementAmountNumber = toDecimalInput(movementAmount);
  const movementUsdEquivalent =
    !selectedAccount || !Number.isFinite(movementAmountNumber) || movementAmountNumber <= 0
      ? 0
      : selectedAccount.currencyCode === 'VES'
        ? activeBsRate > 0
          ? movementAmountNumber / activeBsRate
          : 0
        : movementAmountNumber;
  const movementRequiresApproval =
    movementDirection === 'outflow' && movementUsdEquivalent > 20.005;
  const visibleMovements = detailAccount
    ? [
        ...detailAccount.movements,
        ...additionalMovements.filter(
          (movement) => !detailAccount.movements.some((current) => current.id === movement.id)
        ),
      ]
    : [];

  useEffect(() => {
    setAdditionalMovements([]);
    setMovementPageError(null);
    const lastMovement = detailAccount?.movements.at(-1);
    setMovementCursor(
      detailAccount
      && detailAccount.movementCount > detailAccount.movements.length
      && lastMovement?.createdAt
        ? { createdAt: lastMovement.createdAt, id: lastMovement.id }
        : null
    );
  }, [detailAccount]);

  async function submitMovement() {
    const moneyAccountId = selectedAccount?.accountId ?? 0;
    const amount = toDecimalInput(movementAmount);
    const description = movementDescription.trim();

    if (!moneyAccountId) {
      setMovementError('Selecciona una cuenta.');
      return;
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      setMovementError('Indica un monto valido.');
      return;
    }
    if (selectedAccount?.currencyCode === 'VES' && activeBsRate <= 0) {
      setMovementError('No hay una tasa activa para registrar el movimiento.');
      return;
    }
    if (!description) {
      setMovementError('Indica el motivo del movimiento.');
      return;
    }

    setMovementError(null);
    const payload = {
      direction: movementDirection,
      moneyAccountId,
      amount,
      movementDate,
      exchangeRateVesPerUsd: selectedAccount?.currencyCode === 'VES' ? activeBsRate : null,
      referenceCode: movementReferenceCode.trim() || null,
      counterpartyName: movementCounterpartyName.trim() || null,
      description,
      notes: movementNotes.trim() || null,
    };
    movementCommandKeyRef.current = stableCommandKey(
      movementCommandKeyRef.current,
      payload
    );
    const succeeded = await onCreateMovement({
      idempotencyKey: movementCommandKeyRef.current.key,
      ...payload,
    });
    if (!succeeded) return;
    movementCommandKeyRef.current = null;
    setMovementAmount('');
    setMovementReferenceCode('');
    setMovementCounterpartyName('');
    setMovementDescription('');
    setMovementNotes('');
  }

  async function submitClosure() {
    const moneyAccountId = selectedClosureAccount?.accountId ?? 0;
    const countedAmount = toDecimalInput(closureAmount);
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
    if (selectedClosureAccount?.currencyCode === 'VES' && activeBsRate <= 0) {
      setClosureError('No hay una tasa activa para registrar el cierre.');
      return;
    }
    if (!selectedClosureAccount?.closureReady) {
      setClosureError('Esta cuenta necesita una base financiera antes de poder cerrarse.');
      return;
    }
    if (!closureMatches) {
      setClosureError('El cierre debe coincidir exactamente con el saldo esperado.');
      return;
    }
    if (!reason) {
      setClosureError('Indica el motivo del cierre.');
      return;
    }

    setClosureError(null);
    const payload = {
      moneyAccountId,
      closureDate,
      closureTime,
      countedAmount,
      exchangeRateVesPerUsd:
        selectedClosureAccount?.currencyCode === 'VES' ? activeBsRate : null,
      reason,
      notes: closureNotes.trim() || null,
    };
    closureCommandKeyRef.current = stableCommandKey(
      closureCommandKeyRef.current,
      payload
    );
    const succeeded = await onCreateClosure({
      idempotencyKey: closureCommandKeyRef.current.key,
      ...payload,
    });
    if (!succeeded) return;
    closureCommandKeyRef.current = null;
    setClosureAmount('');
    setClosureNotes('');
    setClosureTime(getCurrentTimeKey());
  }

  async function loadMoreMovements() {
    if (!detailAccount || !movementCursor || movementPageLoading) return;
    setMovementPageLoading(true);
    setMovementPageError(null);
    try {
      const page = await loadCounterCashMovementsAction({
        moneyAccountId: detailAccount.accountId,
        cursor: movementCursor,
      });
      setAdditionalMovements((current) => {
        const knownIds = new Set(current.map((movement) => movement.id));
        return [
          ...current,
          ...page.results.filter((movement) => !knownIds.has(movement.id)),
        ];
      });
      setMovementCursor(page.nextCursor);
    } catch (error) {
      setMovementPageError(
        error instanceof Error ? error.message : 'No se pudieron cargar más movimientos.'
      );
    } finally {
      setMovementPageLoading(false);
    }
  }

  return (
    <section className="mt-5 rounded-[8px] border border-[#242433] bg-[#111118] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Caja</h2>
          <p className="mt-1 text-sm text-[#9FA0AA]">
            Cajas DAR y puntos del mostrador. Saldos exactos, solicitudes y cierre de turno.
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
            onClick={() => {
              setMovementOpen((current) => !current);
              setMovementDate(getTodayKey());
            }}
            disabled={movementAccounts.length === 0}
            className="rounded-full border border-[#FEEF00]/50 bg-[#FEEF00]/10 px-3 py-1.5 text-sm font-semibold text-[#FEEF00] hover:bg-[#FEEF00]/20 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {movementOpen ? 'Ocultar movimiento' : 'Registrar movimiento'}
          </button>
          <button
            type="button"
            onClick={() => {
              setClosureOpen((current) => !current);
              setClosureDate(getTodayKey());
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

      <div className="mt-4 rounded-[8px] border border-[#242433] bg-[#0B0B0D] px-4 py-3 text-sm text-[#C7C8D1]">
        Cada cuenta conserva su moneda. No se mezclan cajas, puntos ni históricos en un total
        financiero. Los datos detallados se cargan solamente al abrir esta sección y al pedir más
        movimientos.
      </div>

      {movementOpen ? (
        <div className="mt-4 rounded-[8px] border border-[#303044] bg-[#0B0B0D] p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold">Movimiento rapido</h3>
              <p className="mt-1 text-xs text-[#9FA0AA]">
                Solo ingresos y gastos operativos sin orden. Pagos, cambios y devoluciones se
                registran desde la orden que les da trazabilidad.
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

          <div className="mt-4 grid gap-3 lg:grid-cols-[1.2fr_0.8fr_0.75fr]">
            <label className="text-sm text-[#9FA0AA]">
              Cuenta
              <select
                value={selectedAccount ? String(selectedAccount.accountId) : ''}
                onChange={(event) => setMovementAccountId(event.target.value)}
                className="mt-1 w-full rounded-[8px] border border-[#303044] bg-[#111118] px-3 py-3 text-[#F5F5F7] outline-none focus:border-[#FEEF00]/70"
              >
                {movementAccounts.map((account) => (
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

            <label className="text-sm text-[#9FA0AA]">
              Fecha
              <input
                type="date"
                value={movementDate}
                disabled
                className="mt-1 w-full cursor-not-allowed rounded-[8px] border border-[#303044] bg-[#111118] px-3 py-3 text-[#9FA0AA]"
              />
            </label>
          </div>

          {selectedAccount?.currencyCode === 'VES' && activeBsRate > 0 ? (
            <div className="mt-3 text-xs text-[#9FA0AA]">
              Equivalente estimado: {moneyUsd(movementUsdEquivalent)}. El servidor aplicará la tasa
              activa al guardar ({moneyBs(activeBsRate)} por USD).
            </div>
          ) : null}

          {movementRequiresApproval ? (
            <div className="mt-3 rounded-[8px] border border-orange-300/40 bg-orange-300/10 px-3 py-2 text-sm text-orange-100">
              Este gasto supera USD 20 equivalentes. Se registrará como solicitud pendiente y no
              afectará el saldo hasta que Administración lo autorice.
            </div>
          ) : null}

          <div className="mt-3 grid gap-3 lg:grid-cols-3">
            <label className="text-sm text-[#9FA0AA]">
              Motivo
              <input
                value={movementDescription}
                onChange={(event) => setMovementDescription(event.target.value)}
                placeholder={movementDirection === 'inflow' ? 'Ingreso adicional' : 'Gasto operativo'}
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
              onClick={() => void submitMovement()}
              disabled={isWorking || movementAccounts.length === 0}
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
                Cuenta el efectivo o verifica el lote del punto contra el saldo exacto del sistema.
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

          <div className="mt-4 grid gap-3 lg:grid-cols-[1.2fr_0.8fr_0.8fr]">
            <label className="text-sm text-[#9FA0AA]">
              Cuenta
              <select
                value={selectedClosureAccount ? String(selectedClosureAccount.accountId) : ''}
                onChange={(event) => {
                  const nextAccount = accounts.find((account) => String(account.accountId) === event.target.value);
                  setClosureAccountId(event.target.value);
                  if (nextAccount) {
                    setClosureAmount(String(nextAccount.closureExpectedAmount));
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
                Esperado sistema
              </div>
              <div className="mt-1 text-base font-semibold text-[#F5F5F7]">
                {selectedClosureAccount?.currencyCode === 'VES'
                  ? moneyBs(selectedClosureExpectedAmount)
                  : moneyUsd(selectedClosureExpectedAmount)}
              </div>
              {selectedClosureIsPos ? (
                <div className="mt-1 text-[11px] text-[#9FA0AA]">
                  El cierre verifica el lote; no transfiere fondos al banco.
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

          </div>

          <div className="mt-3 grid gap-3 lg:grid-cols-[0.8fr_0.65fr_1fr]">
            <label className="text-sm text-[#9FA0AA]">
              Fecha
              <input
                type="date"
                value={closureDate}
                disabled
                className="mt-1 w-full cursor-not-allowed rounded-[8px] border border-[#303044] bg-[#111118] px-3 py-3 text-[#9FA0AA]"
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
              {!selectedClosureAccount?.closureReady
                ? 'La cuenta requiere regularización administrativa antes de poder cerrarse.'
                : 'Cajas y puntos deben cerrar sin diferencia. Si hay diferencia, registra primero el movimiento que la explica.'}
            </div>
            <button
              type="button"
              onClick={() => void submitClosure()}
              disabled={
                isClosing
                || accounts.length === 0
                || !selectedClosureAccount?.closureReady
                || !closureMatches
              }
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
            <button
              key={account.accountId}
              type="button"
              onClick={() => setDetailAccountId(String(account.accountId))}
              className={[
                'rounded-[8px] border bg-[#0B0B0D] p-3 text-left transition',
                detailAccount?.accountId === account.accountId
                  ? 'border-[#FEEF00]/70'
                  : 'border-[#242433] hover:border-[#45455A]',
              ].join(' ')}
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold">{account.accountName}</div>
                  <div className="mt-1 text-xs text-[#9FA0AA]">
                    {accountKindLabel(account.accountKind)} · {account.currencyCode}
                  </div>
                </div>
                {!account.closureReady ? (
                  <span className="rounded-full border border-red-300/40 bg-red-300/10 px-2 py-0.5 text-xs font-semibold text-red-200">
                    Revisar
                  </span>
                ) : account.pendingRequestCount > 0 ? (
                  <span className="rounded-full border border-orange-300/40 bg-orange-300/10 px-2 py-0.5 text-xs font-semibold text-orange-200">
                    {account.pendingRequestCount} pendiente
                    {account.pendingRequestCount === 1 ? '' : 's'}
                  </span>
                ) : (
                  <span className="rounded-full border border-emerald-300/30 bg-emerald-300/10 px-2 py-0.5 text-xs text-emerald-200">
                    Al día
                  </span>
                )}
              </div>
              <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
                <div className="col-span-3 rounded-[8px] border border-[#303044] bg-[#111118] px-2 py-2">
                  <div className="text-[#9FA0AA]">Saldo actual</div>
                  <div className="mt-1 text-base font-semibold text-[#F5F5F7]">
                    {account.currencyCode === 'VES'
                      ? moneyBs(account.balance)
                      : moneyUsd(account.balance)}
                  </div>
                </div>
                <div>
                  <div className="text-[#9FA0AA]">Entró hoy</div>
                  <div className="mt-1 font-semibold text-emerald-300">
                    {account.currencyCode === 'VES'
                      ? moneyBs(account.inflow)
                      : moneyUsd(account.inflow)}
                  </div>
                </div>
                <div>
                  <div className="text-[#9FA0AA]">Salió hoy</div>
                  <div className="mt-1 font-semibold text-orange-300">
                    {account.currencyCode === 'VES'
                      ? moneyBs(account.outflow)
                      : moneyUsd(account.outflow)}
                  </div>
                </div>
                <div>
                  <div className="text-[#9FA0AA]">Neto</div>
                  <div className="mt-1 font-semibold text-[#F5F5F7]">
                    {account.currencyCode === 'VES'
                      ? moneyBs(account.net)
                      : moneyUsd(account.net)}
                  </div>
                </div>
              </div>
              <div className="mt-3 border-t border-[#242433] pt-2 text-[11px] text-[#777988]">
                {!account.closureReady
                  ? 'Requiere revisión administrativa antes del cierre'
                  : account.lastClosure
                  ? `Último cierre ${formatDateTime(account.lastClosure.closureAt)}`
                  : 'Sin cierre previo'}
              </div>
            </button>
          ))
        )}
      </div>

      {detailAccount ? (
        <div className="mt-4 rounded-[8px] border border-[#303044] bg-[#0B0B0D] p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold">{detailAccount.accountName}</h3>
              <p className="mt-1 text-xs text-[#9FA0AA]">
                {accountKindLabel(detailAccount.accountKind)} ·{' '}
                {detailAccount.methods.map((method) => getPaymentMethodLabel(method)).join(', ')}
                {' · '}
                {detailAccount.movementCount} movimiento
                {detailAccount.movementCount === 1 ? '' : 's'} confirmado
                {detailAccount.movementCount === 1 ? '' : 's'} hoy
              </p>
            </div>
            <div className="text-right">
              <div className="text-xs text-[#9FA0AA]">Saldo verificable</div>
              <div className="mt-1 text-lg font-semibold">
                {detailAccount.currencyCode === 'VES'
                  ? moneyBs(detailAccount.balance)
                  : moneyUsd(detailAccount.balance)}
              </div>
            </div>
          </div>

          {detailAccount.pendingRequests.length > 0 ? (
            <div className="mt-4 rounded-[8px] border border-orange-300/30 bg-orange-300/10 p-3">
              <div className="text-sm font-semibold text-orange-100">
                Solicitudes pendientes de Administración
              </div>
              <p className="mt-1 text-xs text-orange-100/70">
                No están incluidas en el saldo hasta su aprobación.
              </p>
              <div className="mt-3 space-y-2">
                {detailAccount.pendingRequests.map((request) => (
                  <div
                    key={request.id}
                    className="flex flex-wrap items-start justify-between gap-3 border-t border-orange-200/15 pt-2 first:border-0 first:pt-0"
                  >
                    <div className="min-w-0 text-xs">
                      <div className="font-semibold text-orange-50">
                        {request.description || 'Gasto operativo'}
                      </div>
                      <div className="mt-1 text-orange-100/65">
                        {request.createdByName || 'Operador'} · {formatDateTime(request.createdAt)}
                        {request.referenceCode ? ` · Ref. ${request.referenceCode}` : ''}
                      </div>
                    </div>
                    <div className="shrink-0 text-sm font-semibold text-orange-100">
                      {request.currencyCode === 'VES'
                        ? moneyBs(request.amount)
                        : moneyUsd(request.amount)}
                    </div>
                  </div>
                ))}
                {detailAccount.pendingRequestCount > detailAccount.pendingRequests.length ? (
                  <div className="text-xs text-orange-100/65">
                    Hay {detailAccount.pendingRequestCount - detailAccount.pendingRequests.length}{' '}
                    solicitud(es) anterior(es) visible(s) para Administración.
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}

          <div className="mt-4">
            <div className="flex items-center justify-between gap-3">
              <div className="text-sm font-semibold">Movimientos confirmados de hoy</div>
              <div className="text-xs text-[#777988]">
                {visibleMovements.length} de {detailAccount.movementCount}
              </div>
            </div>

            {movementPageError ? (
              <div className="mt-3 rounded-[8px] border border-red-400/40 bg-red-400/10 px-3 py-2 text-sm text-red-200">
                {movementPageError}
              </div>
            ) : null}

            {visibleMovements.length > 0 ? (
              <div className="mt-3 divide-y divide-[#242433]">
                {visibleMovements.map((movement) => (
                  <div
                    key={movement.id}
                    className="flex flex-wrap items-start justify-between gap-3 py-3 first:pt-0"
                  >
                    <div className="min-w-0">
                      <div className="text-sm text-[#E7E7EC]">
                        {movement.description
                          || (movement.direction === 'inflow' ? 'Entrada' : 'Salida')}
                      </div>
                      <div className="mt-1 text-xs text-[#777988]">
                        {movement.createdByName || 'Usuario'} · {formatDateTime(movement.createdAt)}
                        {movement.referenceCode ? ` · Ref. ${movement.referenceCode}` : ''}
                        {movement.orderId ? ` · Orden ${movement.orderId}` : ''}
                        {movement.counterpartyName ? ` · ${movement.counterpartyName}` : ''}
                      </div>
                    </div>
                    <div
                      className={
                        movement.direction === 'outflow'
                          ? 'shrink-0 font-semibold text-orange-300'
                          : 'shrink-0 font-semibold text-emerald-300'
                      }
                    >
                      {movement.direction === 'outflow' ? '-' : '+'}
                      {movement.currencyCode === 'VES'
                        ? moneyBs(movement.amount)
                        : moneyUsd(movement.amount)}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="mt-3 rounded-[8px] border border-dashed border-[#303044] p-4 text-sm text-[#9FA0AA]">
                Sin movimientos confirmados hoy.
              </div>
            )}

            {movementCursor ? (
              <div className="mt-3 flex justify-center">
                <button
                  type="button"
                  onClick={() => void loadMoreMovements()}
                  disabled={movementPageLoading}
                  className="rounded-full border border-[#303044] px-4 py-2 text-sm font-semibold text-[#F5F5F7] hover:border-[#FEEF00]/50 disabled:cursor-wait disabled:opacity-60"
                >
                  {movementPageLoading ? 'Cargando...' : 'Cargar más'}
                </button>
              </div>
            ) : null}
          </div>

          {detailAccount.lastClosure ? (
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-[8px] border border-[#242433] bg-[#111118] px-3 py-2 text-xs">
              <div className="text-[#9FA0AA]">
                Último cierre: {formatDateTime(detailAccount.lastClosure.closureAt)} ·{' '}
                {detailAccount.lastClosure.createdByName || 'Usuario'}
              </div>
              <div className="font-semibold text-[#C7C8D1]">
                Contado{' '}
                {detailAccount.currencyCode === 'VES'
                  ? moneyBs(detailAccount.lastClosure.countedAmount)
                  : moneyUsd(detailAccount.lastClosure.countedAmount)}
                {' · '}Dif.{' '}
                {detailAccount.currencyCode === 'VES'
                  ? moneyBs(detailAccount.lastClosure.differenceAmount)
                  : moneyUsd(detailAccount.lastClosure.differenceAmount)}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
