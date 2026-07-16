export type WhatsAppSummaryLine = {
  text: string;
  detailLines?: string[];
};

export type WhatsAppSummaryDocument = {
  enabled?: boolean;
  companyName?: string | null;
  taxId?: string | null;
  address?: string | null;
  phone?: string | null;
};

export type WhatsAppSummaryDeliveryNote = {
  enabled?: boolean;
  name?: string | null;
  documentId?: string | null;
  address?: string | null;
  phone?: string | null;
};

export type WhatsAppSummaryPrice = {
  subtotalBs?: number | null;
  subtotalUsd?: number | null;
  discountPct?: number | null;
  discountAmountBs?: number | null;
  discountAmountUsd?: number | null;
  invoiceTaxPct?: number | null;
  invoiceTaxAmountBs?: number | null;
  invoiceTaxAmountUsd?: number | null;
  totalBs: number;
  totalUsd: number;
};

export type WhatsAppOrderSummaryInput = {
  title?: string;
  orderLabel?: string | null;
  advisorName?: string | null;
  clientName: string;
  clientPhone?: string | null;
  receiverName?: string | null;
  receiverPhone?: string | null;
  lines: WhatsAppSummaryLine[];
  price: WhatsAppSummaryPrice;
  fulfillment: 'pickup' | 'delivery';
  deliveryText: string;
  deliveryDateText?: string | null;
  deliveryTimeText?: string | null;
  address?: string | null;
  gpsUrl?: string | null;
  paymentMethodLabel?: string | null;
  paymentChangeText?: string | null;
  paymentNote?: string | null;
  paymentStatus?: string | null;
  invoice?: WhatsAppSummaryDocument | null;
  deliveryNote?: WhatsAppSummaryDeliveryNote | null;
  notes?: string | null;
};

function clean(value: string | null | undefined) {
  return String(value || '').trim();
}

function hasText(value: string | null | undefined) {
  return clean(value).length > 0;
}

export function formatWhatsAppUsd(value: number) {
  const amount = Number(value);
  return `$${Number.isFinite(amount) ? amount.toFixed(2) : '0.00'}`;
}

export function formatWhatsAppBs(value: number) {
  const amount = Number(value);
  const rounded = Math.round(Number.isFinite(amount) ? amount : 0);
  const chars = String(rounded).split('');
  let output = '';

  for (let index = 0; index < chars.length; index += 1) {
    const indexFromEnd = chars.length - index;
    output += chars[index];
    if (indexFromEnd > 1 && indexFromEnd % 3 === 1) output += '.';
  }

  return `Bs ${output}`;
}

export function formatWhatsAppQuantity(value: number | string | null | undefined) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) return '0';

  const rounded = Math.round(amount * 100) / 100;
  return Number.isInteger(rounded)
    ? String(rounded)
    : rounded.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

export function formatWhatsAppDateVE(value: string | null | undefined) {
  const normalized = clean(value);
  if (!normalized) return '';

  const dateOnly = normalized.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const date = dateOnly
    ? new Date(`${dateOnly[1]}-${dateOnly[2]}-${dateOnly[3]}T12:00:00-04:00`)
    : new Date(normalized);

  if (Number.isNaN(date.getTime())) return normalized;

  const parts = new Intl.DateTimeFormat('es-VE', {
    timeZone: 'America/Caracas',
    weekday: 'long',
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
  }).formatToParts(date);
  const getPart = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value;
  const weekday = getPart('weekday');
  const day = getPart('day');
  const month = getPart('month');
  const year = getPart('year');

  if (weekday && day && month && year) return `${weekday} ${day}/${month}/${year}`;

  return new Intl.DateTimeFormat('es-VE', {
    timeZone: 'America/Caracas',
    weekday: 'long',
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
  }).format(date);
}

export function formatWhatsAppTimeAmPm(value: string | null | undefined) {
  const normalized = clean(value);
  if (!normalized) return '';

  const explicit = normalized.match(/^(\d{1,2}):(\d{2})\s*([ap])(?:\.?\s*m\.?|m)?\.?$/i);
  if (explicit) {
    const hour = Math.max(1, Math.min(12, Number(explicit[1])));
    return `${hour}:${explicit[2]} ${explicit[3].toUpperCase()}M`;
  }

  const time24 = normalized.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (time24) {
    const hour24 = Math.max(0, Math.min(23, Number(time24[1])));
    const amPm = hour24 >= 12 ? 'PM' : 'AM';
    const hour12 = hour24 % 12 || 12;
    return `${hour12}:${time24[2]} ${amPm}`;
  }

  const date = new Date(normalized);
  if (!Number.isNaN(date.getTime()) && normalized.includes('T')) {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Caracas',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    })
      .format(date)
      .replace(/\s/g, ' ');
  }

  return normalized;
}

export function extractWhatsAppUnitsPerServiceFromName(name: string | null | undefined) {
  const normalized = clean(name);
  const match = normalized.match(/\((\d+(?:[.,]\d+)?)\s*(?:und|unidad|unidades|pzas?|piezas?)\)/i);
  if (!match) return 0;

  const units = Number(match[1].replace(',', '.'));
  return Number.isFinite(units) && units > 0 ? units : 0;
}

export function cleanWhatsAppUnitsFromName(name: string | null | undefined) {
  return clean(name).replace(/\s*\(\d+(?:[.,]\d+)?\s*(?:und|unidad|unidades|pzas?|piezas?)\)\s*/i, ' ').trim();
}

export function getWhatsAppDisplayPieces(qty: number | string | null | undefined, unitsPerService: number | string | null | undefined) {
  const quantity = Number(qty);
  const units = Number(unitsPerService);
  if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(units) || units <= 0) return 0;

  const fullServices = Math.trunc(quantity);
  const fractional = quantity - fullServices;
  let pieces = fullServices * units;

  if (fractional >= 0.5) {
    pieces += Math.floor(units / 2);
  }

  return pieces;
}

export function getWhatsAppLineUnits(input: {
  qty: number | string | null | undefined;
  name: string | null | undefined;
  unitsPerService?: number | string | null;
}) {
  const explicitUnits = Number(input.unitsPerService || 0);
  const unitsPerService =
    Number.isFinite(explicitUnits) && explicitUnits > 0
      ? explicitUnits
      : extractWhatsAppUnitsPerServiceFromName(input.name);

  if (unitsPerService <= 0) return null;

  const units = getWhatsAppDisplayPieces(input.qty, unitsPerService);
  return units > 0 ? units : null;
}

function pushField(parts: string[], label: string, value: string | null | undefined) {
  const normalized = clean(value);
  if (!normalized) return;
  parts.push(`*${label}:* ${normalized}`);
}

function pushSeparatedField(parts: string[], label: string, value: string | null | undefined) {
  const before = parts.length;
  pushField(parts, label, value);
  if (parts.length > before) parts.splice(before, 0, '');
}

function buildDocumentText(document: WhatsAppSummaryDocument | null | undefined) {
  if (!document?.enabled) return null;

  const values = [
    hasText(document.companyName) ? `Empresa: ${clean(document.companyName)}` : '',
    hasText(document.taxId) ? `RIF: ${clean(document.taxId)}` : '',
    hasText(document.address) ? `Direccion fiscal: ${clean(document.address)}` : '',
    hasText(document.phone) ? `Telefono fiscal: ${clean(document.phone)}` : '',
  ].filter(Boolean);

  return values.length > 0 ? values.join(' | ') : 'Solicitada';
}

function buildDeliveryNoteText(note: WhatsAppSummaryDeliveryNote | null | undefined) {
  if (!note?.enabled) return null;

  const values = [
    hasText(note.name) ? `Nombre: ${clean(note.name)}` : '',
    hasText(note.documentId) ? `Documento: ${clean(note.documentId)}` : '',
    hasText(note.address) ? `Direccion: ${clean(note.address)}` : '',
    hasText(note.phone) ? `Telefono: ${clean(note.phone)}` : '',
  ].filter(Boolean);

  return values.length > 0 ? values.join(' | ') : 'Solicitada';
}

function buildDeliveryScheduleText(input: WhatsAppOrderSummaryInput) {
  const deliveryDate = clean(input.deliveryDateText);
  const deliveryTime = clean(input.deliveryTimeText);
  if (deliveryDate || deliveryTime) {
    return {
      date: deliveryDate || 'Sin fecha',
      time: deliveryTime || 'Sin hora',
    };
  }

  const fallback = clean(input.deliveryText);
  if (!fallback) return { date: 'Sin fecha', time: 'Sin hora' };

  const [datePart, ...timeParts] = fallback.split(/\s+-\s+/);
  const timePart = timeParts.join(' - ').trim();
  return {
    date: datePart.trim() || fallback,
    time: timePart || 'Sin hora',
  };
}

export function buildWhatsAppOrderSummaryText(input: WhatsAppOrderSummaryInput) {
  const parts: string[] = [];
  const price = input.price;
  const deliverySchedule = buildDeliveryScheduleText(input);
  const showSubtotal =
    Number(price.discountAmountBs || 0) > 0 ||
    Number(price.discountAmountUsd || 0) > 0 ||
    Number(price.invoiceTaxAmountBs || 0) > 0 ||
    Number(price.invoiceTaxAmountUsd || 0) > 0;

  parts.push(`*${clean(input.title) || 'Resumen de Pedido'}*`);
  if (hasText(input.orderLabel)) parts.push(`*Orden:* ${clean(input.orderLabel)}`);
  if (hasText(input.advisorName)) parts.push(`*Asesor:* ${clean(input.advisorName)}`);
  parts.push(`*Cliente:* ${clean(input.clientName) || 'Cliente'}`);
  pushField(parts, 'Telefono', input.clientPhone);
  pushField(parts, 'Recibe', input.receiverName);
  pushField(parts, 'Telefono recibe', input.receiverPhone);

  parts.push('');
  parts.push('*Pedido:*');
  parts.push('');

  if (input.lines.length === 0) {
    parts.push('- Sin items cargados');
  } else {
    input.lines.forEach((line, index) => {
      parts.push(line.text);
      for (const detail of line.detailLines ?? []) {
        const normalized = clean(detail);
        if (normalized) parts.push(`    - ${normalized}`);
      }
      if (index < input.lines.length - 1) parts.push('');
    });
  }

  parts.push('');
  if (showSubtotal && price.subtotalBs != null && price.subtotalUsd != null) {
    parts.push(`*SUBTOTAL:* ${formatWhatsAppBs(price.subtotalBs)} / ${formatWhatsAppUsd(price.subtotalUsd)}`);
  }
  if (Number(price.discountAmountBs || 0) > 0 || Number(price.discountAmountUsd || 0) > 0) {
    parts.push(
      `*DESCUENTO (${Number(price.discountPct || 0)}%):* -${formatWhatsAppBs(Number(price.discountAmountBs || 0))} / -${formatWhatsAppUsd(Number(price.discountAmountUsd || 0))}`
    );
  }
  if (Number(price.invoiceTaxAmountBs || 0) > 0 || Number(price.invoiceTaxAmountUsd || 0) > 0) {
    parts.push(
      `*IVA (${Number(price.invoiceTaxPct || 0)}%):* ${formatWhatsAppBs(Number(price.invoiceTaxAmountBs || 0))} / ${formatWhatsAppUsd(Number(price.invoiceTaxAmountUsd || 0))}`
    );
  }
  parts.push(`*TOTAL:* ${formatWhatsAppBs(price.totalBs)} / ${formatWhatsAppUsd(price.totalUsd)}`);

  parts.push('');
  parts.push(`*Entrega:* ${input.fulfillment === 'delivery' ? 'Delivery' : 'Pickup'}`);
  parts.push(`*Fecha de entrega:* ${deliverySchedule.date}`);
  parts.push(`*Hora de entrega:* ${deliverySchedule.time}`);

  if (input.fulfillment === 'delivery') {
    pushField(parts, 'Direccion', input.address);
    pushField(parts, 'GPS', input.gpsUrl);
  }

  pushSeparatedField(parts, 'Forma de pago', input.paymentMethodLabel);
  pushSeparatedField(parts, 'Cambio', input.paymentChangeText);
  pushSeparatedField(parts, 'Nota de pago', input.paymentNote);
  pushSeparatedField(parts, 'Estatus de pago', input.paymentStatus);
  pushSeparatedField(parts, 'Factura', buildDocumentText(input.invoice));
  pushSeparatedField(parts, 'Nota de entrega', buildDeliveryNoteText(input.deliveryNote));
  pushSeparatedField(parts, 'Nota', input.notes);

  return parts.join('\n');
}
