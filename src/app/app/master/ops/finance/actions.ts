"use server";

import { revalidatePath } from "next/cache";
import { requireMasterOrAdminContext } from "@/lib/auth";
import {
  MASTER_OPS_OUTFLOW_AUTO_APPROVAL_MAX_USD,
  requiresMasterOpsAdminApproval,
} from "@/lib/finance/master-ops-movement-policy";
import { sendPushToRoleDevices } from "@/lib/push";

type MasterOpsMoneyMovementInput = {
  direction: "inflow" | "outflow";
  moneyAccountId: number;
  amount: number;
  feeAmount?: number | null;
  movementDate: string;
  exchangeRateVesPerUsd?: number | null;
  referenceCode?: string | null;
  counterpartyName?: string | null;
  description: string;
  notes?: string | null;
};

export type MasterOpsMoneyMovementResult = {
  status: "confirmed" | "pending";
  totalUsd: number;
  message: string;
};

function roundMoney(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function optionalText(value: unknown, maxLength: number) {
  const text = String(value ?? "").trim();
  if (text.length > maxLength) {
    throw new Error(`El texto no puede superar ${maxLength} caracteres.`);
  }
  return text || null;
}

function requiredText(value: unknown, maxLength: number, message: string) {
  const text = optionalText(value, maxLength);
  if (!text) throw new Error(message);
  return text;
}

function assertMovementDate(value: unknown) {
  const date = String(value ?? "").trim();
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(date) ? new Date(`${date}T00:00:00.000Z`) : null;
  if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new Error("Debes indicar una fecha de movimiento válida.");
  }
  return date;
}

export async function createMasterOpsMoneyMovementAction(
  input: MasterOpsMoneyMovementInput,
): Promise<MasterOpsMoneyMovementResult> {
  const { supabase, user, roles } = await requireMasterOrAdminContext();
  if (input.direction !== "inflow" && input.direction !== "outflow") {
    throw new Error("El tipo de movimiento no es válido.");
  }
  const direction = input.direction;
  const moneyAccountId = Number(input.moneyAccountId);
  const amount = Number(input.amount);
  const feeAmount = direction === "outflow" ? Number(input.feeAmount ?? 0) : 0;
  const movementDate = assertMovementDate(input.movementDate);
  const referenceCode = optionalText(input.referenceCode, 120);
  const counterpartyName = optionalText(input.counterpartyName, 160);
  const description = requiredText(input.description, 240, "Debes indicar el motivo del movimiento.");
  const notes = optionalText(input.notes, 800);

  if (!Number.isInteger(moneyAccountId) || moneyAccountId <= 0) {
    throw new Error("Debes seleccionar una cuenta.");
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("El monto debe ser mayor a 0.");
  }
  if (!Number.isFinite(feeAmount) || feeAmount < 0) {
    throw new Error("La comisión no es válida.");
  }

  const { data: account, error: accountError } = await supabase
    .from("money_accounts")
    .select("id,name,currency_code,is_active")
    .eq("id", moneyAccountId)
    .maybeSingle();

  if (accountError || !account) {
    throw new Error(accountError?.message || "No se pudo cargar la cuenta seleccionada.");
  }
  if (!account.is_active) {
    throw new Error("La cuenta seleccionada está inactiva.");
  }

  const isAdmin = roles.includes("admin");
  if (!isAdmin) {
    const { data: accessRule, error: accessError } = await supabase
      .from("money_account_payment_rules")
      .select("id")
      .eq("money_account_id", moneyAccountId)
      .eq("role", "master")
      .eq("can_view_account", true)
      .eq("is_active", true)
      .limit(1)
      .maybeSingle();

    if (accessError) throw new Error(accessError.message);
    if (!accessRule) {
      throw new Error("Esta cuenta no está habilitada para el máster.");
    }
  }

  const currencyCode = String(account.currency_code || "").toUpperCase();
  if (currencyCode !== "USD" && currencyCode !== "VES") {
    throw new Error("La moneda de la cuenta no es válida.");
  }

  const exchangeRate = currencyCode === "VES" ? Number(input.exchangeRateVesPerUsd ?? 0) : null;
  if (currencyCode === "VES" && (!Number.isFinite(exchangeRate) || Number(exchangeRate) <= 0)) {
    throw new Error("Debes indicar una tasa válida para movimientos en bolívares.");
  }

  const amountUsdEquivalent = currencyCode === "USD"
    ? roundMoney(amount)
    : roundMoney(amount / Number(exchangeRate));
  const feeAmountUsdEquivalent = currencyCode === "USD"
    ? roundMoney(feeAmount)
    : roundMoney(feeAmount / Number(exchangeRate));
  const totalUsd = roundMoney(amountUsdEquivalent + feeAmountUsdEquivalent);
  const requiresApproval = requiresMasterOpsAdminApproval({ roles, direction, totalUsd });
  const status = requiresApproval ? "pending" : "confirmed";
  const confirmedAt = requiresApproval ? null : new Date().toISOString();
  const approvalReason = requiresApproval
    ? `Egreso superior a USD ${MASTER_OPS_OUTFLOW_AUTO_APPROVAL_MAX_USD.toFixed(2)} requiere aprobación administrativa.`
    : null;
  const movementGroupId = feeAmount > 0 ? crypto.randomUUID() : null;

  const rows = [
    {
      movement_date: movementDate,
      created_by_user_id: user.id,
      confirmed_at: confirmedAt,
      confirmed_by_user_id: requiresApproval ? null : user.id,
      status,
      approval_required: requiresApproval,
      approval_required_reason: approvalReason,
      direction,
      movement_type: direction === "inflow" ? "other_income" : "expense_payment",
      money_account_id: moneyAccountId,
      currency_code: currencyCode,
      amount: roundMoney(amount),
      exchange_rate_ves_per_usd: currencyCode === "VES" ? Number(exchangeRate) : null,
      amount_usd_equivalent: amountUsdEquivalent,
      reference_code: referenceCode,
      counterparty_name: counterpartyName,
      description,
      notes,
      order_id: null,
      payment_report_id: null,
      movement_group_id: movementGroupId,
    },
  ];

  if (direction === "outflow" && feeAmount > 0) {
    rows.push({
      movement_date: movementDate,
      created_by_user_id: user.id,
      confirmed_at: confirmedAt,
      confirmed_by_user_id: requiresApproval ? null : user.id,
      status,
      approval_required: requiresApproval,
      approval_required_reason: approvalReason,
      direction,
      movement_type: "fee_charge",
      money_account_id: moneyAccountId,
      currency_code: currencyCode,
      amount: roundMoney(feeAmount),
      exchange_rate_ves_per_usd: currencyCode === "VES" ? Number(exchangeRate) : null,
      amount_usd_equivalent: feeAmountUsdEquivalent,
      reference_code: referenceCode,
      counterparty_name: counterpartyName,
      description: `Comisión · ${description}`,
      notes,
      order_id: null,
      payment_report_id: null,
      movement_group_id: movementGroupId,
    });
  }

  const { error: insertError } = await supabase.from("money_movements").insert(rows);
  if (insertError) throw new Error(insertError.message);

  if (requiresApproval) {
    try {
      await sendPushToRoleDevices({
        roles: ["admin"],
        title: "Egreso pendiente de aprobación",
        body: `${description} · USD ${totalUsd.toFixed(2)} requiere revisión administrativa.`,
        url: "/app/master/dashboard",
        tag: `master-ops-money-movement-${movementGroupId || moneyAccountId}-${movementDate}`,
        tone: "critical",
        requireInteraction: true,
      });
    } catch (pushError) {
      console.warn(
        "master ops money approval push skipped",
        pushError instanceof Error ? pushError.message : "unknown push error",
      );
    }
  }

  revalidatePath("/app/master/ops/finance");
  revalidatePath("/app/master/ops");
  revalidatePath("/app/master/dashboard");

  return {
    status,
    totalUsd,
    message: requiresApproval
      ? `Egreso registrado por USD ${totalUsd.toFixed(2)} y enviado a aprobación administrativa.`
      : `${direction === "inflow" ? "Ingreso" : "Egreso"} confirmado por USD ${totalUsd.toFixed(2)}.`,
  };
}
