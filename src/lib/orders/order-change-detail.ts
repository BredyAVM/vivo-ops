export const ORDER_CHANGE_SECTIONS = [
  "pedido",
  "cliente",
  "entrega",
  "direccion",
  "pago",
  "precio",
  "factura",
  "nota_entrega",
  "nota",
] as const;

export type OrderChangeSection = (typeof ORDER_CHANGE_SECTIONS)[number];
export type OrderChangeKind = "changed" | "added" | "removed";

export type OrderChangeDetail = {
  section: OrderChangeSection;
  field: string;
  label: string;
  kind: OrderChangeKind;
  before: string | null;
  after: string | null;
};

const ORDER_CHANGE_KINDS = new Set<OrderChangeKind>(["changed", "added", "removed"]);
const ORDER_CHANGE_SECTION_SET = new Set<OrderChangeSection>(ORDER_CHANGE_SECTIONS);
const MAX_ORDER_CHANGE_DETAILS = 48;
const MAX_ORDER_CHANGE_VALUE_LENGTH = 280;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function cleanText(value: unknown, maxLength: number) {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, maxLength) : "";
}

function optionalChangeValue(value: unknown) {
  const normalized = cleanText(value, MAX_ORDER_CHANGE_VALUE_LENGTH);
  return normalized || null;
}

export function sanitizeOrderChangeDetails(value: unknown): OrderChangeDetail[] {
  if (!Array.isArray(value)) return [];

  const details: OrderChangeDetail[] = [];
  for (const item of value.slice(0, MAX_ORDER_CHANGE_DETAILS)) {
    const source = record(item);
    const section = cleanText(source.section, 40) as OrderChangeSection;
    const kind = cleanText(source.kind, 20) as OrderChangeKind;
    const field = cleanText(source.field, 80);
    const label = cleanText(source.label, 120);

    if (!ORDER_CHANGE_SECTION_SET.has(section) || !ORDER_CHANGE_KINDS.has(kind) || !field || !label) {
      continue;
    }

    const before = optionalChangeValue(source.before);
    const after = optionalChangeValue(source.after);
    if (before === after) continue;

    details.push({ section, field, label, kind, before, after });
  }

  return details;
}

export function summarizeOrderChangeDetails(detailsInput: unknown) {
  const details = sanitizeOrderChangeDetails(detailsInput);
  if (details.length === 0) return "El asesor corrigio la orden y la reenvio para aprobacion.";

  const labels = Array.from(new Set(details.map((detail) => detail.label)));
  const visible = labels.slice(0, 3);
  const remaining = labels.length - visible.length;
  const suffix = remaining > 0 ? ` y ${remaining} ${remaining === 1 ? "cambio mas" : "cambios mas"}` : "";
  return `Se modifico: ${visible.join(", ")}${suffix}.`;
}

export function formatOrderChangeDetailCompact(detail: OrderChangeDetail) {
  if (detail.kind === "added") return `${detail.label}: agregado ${detail.after ?? "Sin indicar"}`;
  if (detail.kind === "removed") return `${detail.label}: eliminado ${detail.before ?? "Sin indicar"}`;
  return `${detail.label}: ${detail.before ?? "Sin indicar"} -> ${detail.after ?? "Sin indicar"}`;
}
