'use client';

import { useState } from 'react';
import { useFormStatus } from 'react-dom';
import { parseDecimalInput } from '@/lib/number-input';
import { registerCommissionPaymentAction } from './actions';

export type CommissionPaymentAccountOption = {
  id: number;
  name: string;
  currencyCode: 'USD' | 'VES';
};

type Props = {
  closureId: number;
  periodId: number;
  paymentBalanceUsd: number;
  defaultDate: string;
  activeRate: number | null;
  accounts: CommissionPaymentAccountOption[];
};

const numberFormatter = new Intl.NumberFormat('es-VE', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function roundMoney(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function formatUsd(value: number) {
  return `$${numberFormatter.format(roundMoney(value))}`;
}

function formatVes(value: number) {
  return `Bs ${numberFormatter.format(roundMoney(value))}`;
}

function SubmitButton() {
  const { pending } = useFormStatus();

  return (
    <button
      className="h-10 rounded-xl bg-[#F0D000] px-4 text-sm font-semibold text-[#111113] transition hover:bg-[#FFE44F] disabled:cursor-wait disabled:opacity-60 sm:col-span-2"
      disabled={pending}
      type="submit"
    >
      {pending ? 'Registrando…' : 'Registrar abono'}
    </button>
  );
}

export default function CommissionPaymentForm({
  closureId,
  periodId,
  paymentBalanceUsd,
  defaultDate,
  activeRate,
  accounts,
}: Props) {
  const [accountId, setAccountId] = useState('');
  const [amountUsd, setAmountUsd] = useState(paymentBalanceUsd.toFixed(2));
  const [exchangeRate, setExchangeRate] = useState(activeRate ? String(activeRate) : '');
  const [bankFee, setBankFee] = useState('');

  const selectedAccount = accounts.find((account) => String(account.id) === accountId) ?? null;
  const amountUsdValue = Math.max(0, parseDecimalInput(amountUsd, 0));
  const exchangeRateValue = Math.max(0, parseDecimalInput(exchangeRate, 0));
  const bankFeeValue = Math.max(0, parseDecimalInput(bankFee, 0));
  const equivalentVes = exchangeRateValue > 0
    ? roundMoney(amountUsdValue * exchangeRateValue)
    : 0;
  const paymentNativeAmount = selectedAccount?.currencyCode === 'VES'
    ? equivalentVes
    : amountUsdValue;
  const totalNativeAmount = roundMoney(paymentNativeAmount + bankFeeValue);
  const bankFeeUsdEquivalent = selectedAccount?.currencyCode === 'VES' && exchangeRateValue > 0
    ? roundMoney(bankFeeValue / exchangeRateValue)
    : bankFeeValue;

  if (accounts.length === 0) {
    return (
      <div className="mt-3 rounded-xl border border-amber-400/25 bg-amber-400/5 px-4 py-3 text-xs text-amber-100">
        No hay cuentas activas disponibles para registrar este pago.
      </div>
    );
  }

  return (
    <form action={registerCommissionPaymentAction} className="mt-3 grid gap-3 sm:grid-cols-2">
      <input name="closureId" type="hidden" value={closureId} />
      <input name="periodId" type="hidden" value={periodId} />

      <label className="block sm:col-span-2">
        <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#8F8F9B]">
          Cuenta de pago
        </span>
        <select
          className="mt-1 h-10 w-full rounded-xl border border-[#32323D] bg-[#0E0E12] px-3 text-sm text-[#F7F7F8] outline-none focus:border-[#F0D000]"
          name="moneyAccountId"
          onChange={(event) => {
            setAccountId(event.target.value);
            setBankFee('');
          }}
          required
          value={accountId}
        >
          <option value="">Seleccionar cuenta</option>
          {accounts.map((account) => (
            <option key={account.id} value={account.id}>
              {account.name} · {account.currencyCode}
            </option>
          ))}
        </select>
      </label>

      <label className="block">
        <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#8F8F9B]">
          Abono USD
        </span>
        <input
          autoComplete="off"
          className="mt-1 h-10 w-full rounded-xl border border-[#32323D] bg-[#0E0E12] px-3 text-sm text-[#F7F7F8] outline-none focus:border-[#F0D000]"
          inputMode="decimal"
          name="amountUsd"
          onChange={(event) => setAmountUsd(event.target.value)}
          required
          value={amountUsd}
        />
      </label>

      <label className="block">
        <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#8F8F9B]">
          Tasa Bs/USD
        </span>
        <input
          autoComplete="off"
          className="mt-1 h-10 w-full rounded-xl border border-[#32323D] bg-[#0E0E12] px-3 text-sm text-[#F7F7F8] outline-none focus:border-[#F0D000]"
          inputMode="decimal"
          name="exchangeRateVesPerUsd"
          onChange={(event) => setExchangeRate(event.target.value)}
          placeholder="Ej. 773"
          required={selectedAccount?.currencyCode === 'VES'}
          value={exchangeRate}
        />
      </label>

      <label className="block">
        <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#8F8F9B]">
          Fecha
        </span>
        <input
          className="mt-1 h-10 w-full rounded-xl border border-[#32323D] bg-[#0E0E12] px-3 text-sm text-[#F7F7F8] outline-none focus:border-[#F0D000]"
          defaultValue={defaultDate}
          name="movementDate"
          required
          type="date"
        />
      </label>

      <label className="block">
        <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#8F8F9B]">
          Comisión bancaria {selectedAccount ? `(${selectedAccount.currencyCode})` : ''}
        </span>
        <input
          autoComplete="off"
          className="mt-1 h-10 w-full rounded-xl border border-[#32323D] bg-[#0E0E12] px-3 text-sm text-[#F7F7F8] outline-none focus:border-[#F0D000]"
          inputMode="decimal"
          name="bankFeeNativeAmount"
          onChange={(event) => setBankFee(event.target.value)}
          placeholder="Opcional"
          value={bankFee}
        />
      </label>

      <label className="block sm:col-span-2">
        <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#8F8F9B]">
          Referencia
        </span>
        <input
          className="mt-1 h-10 w-full rounded-xl border border-[#32323D] bg-[#0E0E12] px-3 text-sm text-[#F7F7F8] outline-none focus:border-[#F0D000]"
          maxLength={120}
          name="referenceCode"
          placeholder="Opcional"
        />
      </label>

      <div
        aria-live="polite"
        className="rounded-xl border border-[#30303A] bg-[#0B0B0F] p-3 text-xs text-[#A9A9B4] sm:col-span-2"
      >
        <div className="flex items-center justify-between gap-3">
          <span>Abono al asesor</span>
          <strong className="text-[#F7F7F8]">{formatUsd(amountUsdValue)}</strong>
        </div>
        <div className="mt-1.5 flex items-center justify-between gap-3">
          <span>Equivalente a la tasa indicada</span>
          <strong className="text-[#F7DA66]">
            {exchangeRateValue > 0 ? formatVes(equivalentVes) : 'Indica la tasa'}
          </strong>
        </div>
        {selectedAccount ? (
          <>
            <div className="mt-1.5 flex items-center justify-between gap-3">
              <span>Comisión bancaria</span>
              <strong className="text-[#F7F7F8]">
                {selectedAccount.currencyCode === 'VES'
                  ? formatVes(bankFeeValue)
                  : formatUsd(bankFeeValue)}
              </strong>
            </div>
            <div className="mt-2 flex items-center justify-between gap-3 border-t border-[#292933] pt-2">
              <span>Salida total de la cuenta</span>
              <strong className="text-[#F7F7F8]">
                {selectedAccount.currencyCode === 'VES'
                  ? formatVes(totalNativeAmount)
                  : formatUsd(totalNativeAmount)}
              </strong>
            </div>
            {bankFeeValue > 0 ? (
              <p className="mt-2 leading-5 text-[#858591]">
                La comisión equivale a {formatUsd(bankFeeUsdEquivalent)} y se registrará como un gasto bancario separado, ligado a este abono.
              </p>
            ) : null}
          </>
        ) : (
          <p className="mt-2 leading-5 text-[#858591]">
            Selecciona la cuenta para calcular la salida real y la moneda de la comisión bancaria.
          </p>
        )}
      </div>

      <SubmitButton />
    </form>
  );
}
