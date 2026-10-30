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
): Promise<MasterOpsMoneyMovementResult> { throw new Error('All business actions are disabled in the CPU benchmark.'); }
