import { formatOrderDisplayNumber } from "@/lib/orders/order-labels";
import type { MasterOrderPaymentReport } from "../_components/MasterOrderDetailCore";

const caracasTimeFormatter = new Intl.DateTimeFormat("es-VE", {
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
  timeZone: "America/Caracas",
});

function clean(value: unknown, fallback = "--") {
  const normalized = String(value ?? "").trim();
  return normalized || fallback;
}

function formatAmount(value: number) {
  return new Intl.NumberFormat("es-VE", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number(value || 0));
}

function formatUsd(value: number) {
  return `$${Number(value || 0).toFixed(2)}`;
}

function formatOperationDate(value: string | null, createdAt: string | null) {
  const dateKey = String(value || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) {
    const [year, month, day] = dateKey.split("-");
    return `${day}/${month}/${year}`;
  }

  if (!createdAt) return "--";
  const createdDate = new Date(createdAt);
  if (Number.isNaN(createdDate.getTime())) return "--";
  return createdDate.toLocaleDateString("es-VE", { timeZone: "America/Caracas" });
}

function formatOperationTime(createdAt: string | null) {
  if (!createdAt) return "--";
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return "--";
  return caracasTimeFormatter.format(date);
}

function formatReportedAmount(report: MasterOrderPaymentReport) {
  const currency = clean(report.currencyCode, "").toUpperCase();
  if (currency === "VES") {
    return `VES ${formatAmount(report.amount)} · ${formatUsd(report.usdEquivalent)}`;
  }
  if (currency === "USD") {
    return formatUsd(report.amount);
  }
  return `${currency || "MONTO"} ${formatAmount(report.amount)} · ${formatUsd(report.usdEquivalent)}`;
}

export type PaymentVerificationCopyInput = {
  orderId: number;
  clientName: string;
  report: MasterOrderPaymentReport;
};

export function buildPaymentVerificationCopyText({
  orderId,
  clientName,
  report,
}: PaymentVerificationCopyInput) {
  const operationDate = formatOperationDate(report.operationDate, report.createdAt);
  const operationTime = formatOperationTime(report.createdAt);
  const lines = [
    "Verificar pago",
    `Orden #${formatOrderDisplayNumber(orderId)} · ${clean(clientName, "Sin cliente")}`,
    `Monto: ${formatReportedAmount(report)}`,
    `Operación: ${operationDate} · ${operationTime}`,
    `Cuenta: ${clean(report.moneyAccountName)}`,
    `Banco / pagador: ${clean(report.payerName)}`,
    `Referencia: ${clean(report.referenceCode)}`,
    `Reportado por: ${clean(report.reporterName, "Usuario")}`,
  ];

  const notes = clean(report.notes, "");
  if (notes) lines.push(`Notas: ${notes}`);

  return lines.join("\n");
}
