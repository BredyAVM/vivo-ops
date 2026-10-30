export type ReceiptCaptureInput = {
  quantityUnknown?: boolean;
  sourceName?: string | null;
  looseUnits?: number | null;
  presentations?: Array<{
    presentationId: number;
    quantity: number;
    baseUnitsPerPresentation?: number | null;
  }>;
};

export type ReceiptCaptureIssue = { field: string; message: string };

export class ReceiptCaptureError extends Error {
  issue: ReceiptCaptureIssue;
  constructor(issue: ReceiptCaptureIssue) {
    super(issue.message);
    this.issue = issue;
  }
}

// Shared by the form and Server Actions. The server never trusts UI validation.
export function normalizeReceiptCapture(value: unknown, allowUnknown: boolean) {
  const fail = (field: string, message: string): never => { throw new ReceiptCaptureError({ field, message }); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return fail('capture', 'Revisa las cantidades de la mercancía.');
  }
  const capture = value as ReceiptCaptureInput;
  const quantityUnknown = capture.quantityUnknown === true;
  if (quantityUnknown && !allowUnknown) return fail('looseUnits', 'Indica la cantidad exacta recibida. No puede quedar como desconocida.');
  const sourceName = String(capture.sourceName ?? '').trim();
  if (sourceName.length > 160) return fail('sourceName', 'La fuente no puede superar 160 caracteres.');
  const looseUnits = Number(capture.looseUnits ?? 0);
  if (!Number.isFinite(looseUnits) || looseUnits < 0) {
    return fail('looseUnits', 'Revisa «Unidades sueltas»: escribe cero o una cantidad positiva.');
  }
  const raw = capture.presentations ?? [];
  if (!Array.isArray(raw) || raw.length > 20) return fail('capture', 'La captura admite hasta 20 presentaciones.');
  const seen = new Set<number>();
  const presentations = raw.map((line, index) => {
    const label = `Presentación ${index + 1}`;
    if (!line || typeof line !== 'object') return fail(`presentations.${index}.presentationId`, `${label}: selecciona una presentación válida.`);
    const id = Number(line.presentationId);
    const quantity = Number(line.quantity);
    const conversion = line.baseUnitsPerPresentation == null ? null : Number(line.baseUnitsPerPresentation);
    if (!Number.isSafeInteger(id) || id <= 0) return fail(`presentations.${index}.presentationId`, `${label}: selecciona una presentación válida.`);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      return fail(`presentations.${index}.quantity`, `${label}: falta una cantidad mayor que cero. Si no la vas a ingresar, pulsa «Quitar».`);
    }
    if (conversion != null && (!Number.isFinite(conversion) || conversion <= 0)) {
      return fail(`presentations.${index}.factor`, `${label}: indica cuántas unidades contiene cada presentación en «Conversión». Debe ser mayor que cero.`);
    }
    if (seen.has(id)) return fail(`presentations.${index}.presentationId`, `${label}: está repetida. Une las cantidades en una sola fila.`);
    seen.add(id);
    return { presentation_id: id, quantity, base_units_per_presentation: conversion };
  });
  if (quantityUnknown && (looseUnits !== 0 || presentations.length !== 0)) {
    return fail('capture', 'Una cantidad desconocida no puede mezclarse con cantidades capturadas.');
  }
  if (!quantityUnknown && looseUnits === 0 && presentations.length === 0) {
    return fail('looseUnits', allowUnknown
      ? 'Falta la cantidad esperada: indica unidades sueltas, añade una presentación o marca «Cantidad todavía desconocida».'
      : 'Falta la cantidad recibida: escribe las unidades sueltas o añade una presentación e indica cuántas recibiste.');
  }
  return { quantity_unknown: quantityUnknown, source_name: sourceName || null, loose_units: looseUnits, presentations };
}

export function receiptCaptureIssue(value: unknown, allowUnknown: boolean): ReceiptCaptureIssue | null {
  try { normalizeReceiptCapture(value, allowUnknown); return null; }
  catch (error) { if (error instanceof ReceiptCaptureError) return error.issue; throw error; }
}

export const RECEIPT_UNCONFIRMED_MESSAGE = 'No se pudo confirmar la operación. Revisa las recepciones recientes antes de volver a registrar la mercancía; si persiste, consulta a Administración.';

export function receiptActionFailure(error: unknown) {
  if (error instanceof ReceiptCaptureError) return { ok: false as const, message: error.message, issue: error.issue };
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  // Only known business messages cross the server boundary, never SQL/React details.
  const safe = [
    /^Solo (cocina o administración|Master o administración) pueden (registrar mercancía recibida|declarar recepciones esperadas|cancelar expectativas)\.$/,
    /^La (nota|fuente|fecha esperada|fecha de recepción|fecha de vencimiento) (no puede superar [\d.,]+ caracteres|no es válida)\.$/,
    /^El código de lote (no puede superar 120 caracteres|admite entre 1 y 120 caracteres)\.$/,
    /^El vencimiento debe ser posterior a la recepción\.$/,
    /^La fecha real de recepción no puede estar en el futuro\.$/,
    /^El ítem (requiere una apertura aceptada antes de recibir mercancía|no admite entradas operativas|no admite recepciones esperadas)\.$/,
    /^La expectativa (ya no está activa o no corresponde al ítem|reemplazada no está activa o no corresponde al ítem|ya fue conciliada y no puede cancelarse)\.$/,
    /^(Ítem de inventario|Expectativa de recepción) no encontrad[oa]\.$/,
    /^La presentación no pertenece al ítem o está inactiva\.$/,
  ].some(pattern => pattern.test(message));
  return { ok: false as const, message: safe ? message : RECEIPT_UNCONFIRMED_MESSAGE, issue: null };
}
