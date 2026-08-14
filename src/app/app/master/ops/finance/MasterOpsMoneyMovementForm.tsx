"use client";

import { useMemo, useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { parseDecimalInput } from "@/lib/number-input";
import { MASTER_OPS_OUTFLOW_AUTO_APPROVAL_MAX_USD } from "@/lib/finance/master-ops-movement-policy";
import { createMasterOpsMoneyMovementAction } from "./actions";

export type MasterOpsMovementAccountOption = {
  id: number;
  name: string;
  currencyCode: "USD" | "VES";
};

type Props = {
  accounts: MasterOpsMovementAccountOption[];
  activeRate: number | null;
  defaultDate: string;
  isAdmin: boolean;
};

function formatUsd(value: number) {
  return new Intl.NumberFormat("es-VE", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function roundMoney(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export default function MasterOpsMoneyMovementForm({ accounts, activeRate, defaultDate, isAdmin }: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [direction, setDirection] = useState<"inflow" | "outflow">("inflow");
  const [accountId, setAccountId] = useState("");
  const [amount, setAmount] = useState("");
  const [feeAmount, setFeeAmount] = useState("");
  const [movementDate, setMovementDate] = useState(defaultDate);
  const [exchangeRate, setExchangeRate] = useState(activeRate ? String(activeRate) : "");
  const [referenceCode, setReferenceCode] = useState("");
  const [counterpartyName, setCounterpartyName] = useState("");
  const [description, setDescription] = useState("");
  const [notes, setNotes] = useState("");
  const [feedback, setFeedback] = useState<{ tone: "success" | "pending" | "error"; message: string } | null>(null);

  const selectedAccount = useMemo(
    () => accounts.find((account) => String(account.id) === accountId) ?? null,
    [accountId, accounts],
  );
  const amountValue = parseDecimalInput(amount, 0);
  const feeValue = direction === "outflow" ? parseDecimalInput(feeAmount, 0) : 0;
  const rateValue = selectedAccount?.currencyCode === "VES" ? parseDecimalInput(exchangeRate, 0) : 1;
  const totalUsd = rateValue > 0
    ? roundMoney(roundMoney(amountValue / rateValue) + roundMoney(feeValue / rateValue))
    : 0;
  const willRequireApproval = !isAdmin && direction === "outflow" && totalUsd > MASTER_OPS_OUTFLOW_AUTO_APPROVAL_MAX_USD;

  function submitMovement(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFeedback(null);

    startTransition(async () => {
      try {
        const result = await createMasterOpsMoneyMovementAction({
          direction,
          moneyAccountId: Number(accountId),
          amount: parseDecimalInput(amount),
          feeAmount: direction === "outflow" ? parseDecimalInput(feeAmount, 0) : 0,
          movementDate,
          exchangeRateVesPerUsd: selectedAccount?.currencyCode === "VES" ? parseDecimalInput(exchangeRate) : null,
          referenceCode,
          counterpartyName,
          description,
          notes,
        });

        setFeedback({
          tone: result.status === "pending" ? "pending" : "success",
          message: result.message,
        });
        setAmount("");
        setFeeAmount("");
        setReferenceCode("");
        setCounterpartyName("");
        setDescription("");
        setNotes("");
        router.refresh();
      } catch (error) {
        setFeedback({
          tone: "error",
          message: error instanceof Error ? error.message : "No se pudo registrar el movimiento.",
        });
      }
    });
  }

  if (accounts.length === 0) {
    return (
      <div className="rounded-2xl border border-amber-300/30 bg-amber-300/5 px-4 py-5 text-sm text-amber-100">
        No hay cuentas operativas habilitadas para registrar movimientos.
      </div>
    );
  }

  return (
    <form className="space-y-4" onSubmit={submitMovement}>
      <div className="flex flex-wrap gap-2" role="group" aria-label="Tipo de movimiento">
        {([
          ["inflow", "Ingreso"],
          ["outflow", "Egreso"],
        ] as const).map(([value, label]) => (
          <button
            key={value}
            type="button"
            aria-pressed={direction === value}
            onClick={() => setDirection(value)}
            className={[
              "rounded-xl border px-4 py-2 text-sm font-bold transition",
              direction === value
                ? "border-[#FEEF00] bg-[#FEEF00] text-[#0B0B0D]"
                : "border-[#343442] bg-[#0B0B0D] text-[#B7B7C2] hover:border-[#666675]",
            ].join(" ")}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="grid gap-3 lg:grid-cols-2 xl:grid-cols-4">
        <label className="space-y-1.5 text-xs font-semibold text-[#B7B7C2] xl:col-span-2">
          <span>Cuenta</span>
          <select
            required
            value={accountId}
            onChange={(event) => setAccountId(event.target.value)}
            className="w-full rounded-xl border border-[#343442] bg-[#0B0B0D] px-3 py-2.5 text-sm text-[#F5F5F7] outline-none focus:border-[#FEEF00]/60"
          >
            <option value="" disabled>Selecciona una cuenta</option>
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name} · {account.currencyCode}
              </option>
            ))}
          </select>
        </label>

        <label className="space-y-1.5 text-xs font-semibold text-[#B7B7C2]">
          <span>Monto en {selectedAccount?.currencyCode ?? "moneda de la cuenta"}</span>
          <input
            required
            inputMode="decimal"
            autoComplete="off"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            placeholder="0,00"
            className="w-full rounded-xl border border-[#343442] bg-[#0B0B0D] px-3 py-2.5 text-sm text-[#F5F5F7] outline-none placeholder:text-[#61616D] focus:border-[#FEEF00]/60"
          />
        </label>

        <label className="space-y-1.5 text-xs font-semibold text-[#B7B7C2]">
          <span>Fecha de operación</span>
          <input
            required
            type="date"
            value={movementDate}
            onChange={(event) => setMovementDate(event.target.value)}
            className="w-full rounded-xl border border-[#343442] bg-[#0B0B0D] px-3 py-2.5 text-sm text-[#F5F5F7] outline-none focus:border-[#FEEF00]/60"
          />
        </label>

        {selectedAccount?.currencyCode === "VES" ? (
          <label className="space-y-1.5 text-xs font-semibold text-[#B7B7C2]">
            <span>Tasa Bs/USD</span>
            <input
              required
              inputMode="decimal"
              autoComplete="off"
              value={exchangeRate}
              onChange={(event) => setExchangeRate(event.target.value)}
              placeholder="0,00"
              className="w-full rounded-xl border border-[#343442] bg-[#0B0B0D] px-3 py-2.5 text-sm text-[#F5F5F7] outline-none placeholder:text-[#61616D] focus:border-[#FEEF00]/60"
            />
          </label>
        ) : null}

        {direction === "outflow" ? (
          <label className="space-y-1.5 text-xs font-semibold text-[#B7B7C2]">
            <span>Comisión en {selectedAccount?.currencyCode ?? "moneda de la cuenta"} · opcional</span>
            <input
              inputMode="decimal"
              autoComplete="off"
              value={feeAmount}
              onChange={(event) => setFeeAmount(event.target.value)}
              placeholder="0,00"
              className="w-full rounded-xl border border-[#343442] bg-[#0B0B0D] px-3 py-2.5 text-sm text-[#F5F5F7] outline-none placeholder:text-[#61616D] focus:border-[#FEEF00]/60"
            />
          </label>
        ) : null}

        <label className="space-y-1.5 text-xs font-semibold text-[#B7B7C2] xl:col-span-2">
          <span>Motivo</span>
          <input
            required
            maxLength={240}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder={direction === "inflow" ? "Concepto del ingreso" : "Concepto del egreso"}
            className="w-full rounded-xl border border-[#343442] bg-[#0B0B0D] px-3 py-2.5 text-sm text-[#F5F5F7] outline-none placeholder:text-[#61616D] focus:border-[#FEEF00]/60"
          />
        </label>

        <label className="space-y-1.5 text-xs font-semibold text-[#B7B7C2]">
          <span>Referencia · opcional</span>
          <input
            maxLength={120}
            value={referenceCode}
            onChange={(event) => setReferenceCode(event.target.value)}
            placeholder="Número o comprobante"
            className="w-full rounded-xl border border-[#343442] bg-[#0B0B0D] px-3 py-2.5 text-sm text-[#F5F5F7] outline-none placeholder:text-[#61616D] focus:border-[#FEEF00]/60"
          />
        </label>

        <label className="space-y-1.5 text-xs font-semibold text-[#B7B7C2]">
          <span>{direction === "inflow" ? "Origen" : "Beneficiario"} · opcional</span>
          <input
            maxLength={160}
            value={counterpartyName}
            onChange={(event) => setCounterpartyName(event.target.value)}
            placeholder="Persona o comercio"
            className="w-full rounded-xl border border-[#343442] bg-[#0B0B0D] px-3 py-2.5 text-sm text-[#F5F5F7] outline-none placeholder:text-[#61616D] focus:border-[#FEEF00]/60"
          />
        </label>
      </div>

      <label className="block space-y-1.5 text-xs font-semibold text-[#B7B7C2]">
        <span>Notas · opcional</span>
        <textarea
          maxLength={800}
          rows={2}
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          placeholder="Información adicional para la auditoría"
          className="w-full resize-y rounded-xl border border-[#343442] bg-[#0B0B0D] px-3 py-2.5 text-sm text-[#F5F5F7] outline-none placeholder:text-[#61616D] focus:border-[#FEEF00]/60"
        />
      </label>

      <div className="flex flex-col gap-3 rounded-xl border border-[#2B2B39] bg-[#0B0B0D] p-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="text-xs leading-5 text-[#9A9AA6]">
          {direction === "outflow" ? (
            <>
              Total estimado: <strong className="text-[#F5F5F7]">{formatUsd(totalUsd)}</strong>.{" "}
              {isAdmin
                ? "Administración confirma el egreso al registrarlo."
                : willRequireApproval
                  ? `Supera ${formatUsd(MASTER_OPS_OUTFLOW_AUTO_APPROVAL_MAX_USD)} y quedará pendiente para Administración.`
                  : `El máster puede confirmarlo hasta ${formatUsd(MASTER_OPS_OUTFLOW_AUTO_APPROVAL_MAX_USD)} inclusive.`}
            </>
          ) : (
            "El ingreso quedará confirmado y afectará el saldo de la cuenta seleccionada."
          )}
        </div>
        <button
          type="submit"
          disabled={isPending}
          className="shrink-0 rounded-xl border border-[#FEEF00] bg-[#FEEF00] px-5 py-2.5 text-sm font-black text-[#0B0B0D] disabled:cursor-wait disabled:opacity-60"
        >
          {isPending ? "Registrando..." : `Registrar ${direction === "inflow" ? "ingreso" : "egreso"}`}
        </button>
      </div>

      {feedback ? (
        <div
          role={feedback.tone === "error" ? "alert" : "status"}
          className={[
            "rounded-xl border px-4 py-3 text-sm font-semibold",
            feedback.tone === "error"
              ? "border-red-400/40 bg-red-400/10 text-red-100"
              : feedback.tone === "pending"
                ? "border-orange-300/40 bg-orange-300/10 text-orange-100"
                : "border-emerald-400/40 bg-emerald-400/10 text-emerald-100",
          ].join(" ")}
        >
          {feedback.message}
        </div>
      ) : null}
    </form>
  );
}
