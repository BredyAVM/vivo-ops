'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  approveOrderAction,
  assignExternalPartnerAction,
  assignInternalDriverAction,
  confirmPaymentReportAction,
  createPaymentReportAction,
  rejectPaymentReportAction,
  reapproveQueuedOrderAction,
  returnToCreatedAction,
  reviewOrderChangesAction,
  sendToKitchenAction,
  kitchenTakeAction,
  markReadyAction,
  outForDeliveryAction,
  markDeliveredAction,
  clearDeliveryAssignmentAction,
  returnFromKitchenToQueueAction,
  cancelOrderAction,
  updateCatalogItemAction,
  updateCatalogPricesQuickAction,
  updateExchangeRateAction,
  createCatalogItemAction,
  createClientAction,
  createOrderClientQuickAction,
  createMoneyAccountAction,
  toggleCatalogItemActiveAction,
  toggleClientActiveAction,
  toggleMoneyAccountActiveAction,
  deleteCatalogItemAction,
  updateClientAction,
  updateMoneyAccountAction,
  createOrderAction,
  updateOrderAction,
  logoutAction,
} from './actions';

type OrderStatus =
  | 'created'
  | 'queued'
  | 'confirmed'
  | 'in_kitchen'
  | 'ready'
  | 'out_for_delivery'
  | 'delivered'
  | 'cancelled';

type Fulfillment = 'pickup' | 'delivery';
type PaymentVerify = 'none' | 'pending' | 'confirmed' | 'rejected';

type OrderLine = {
  name: string;
  qty: number;
  unitsPerService: number;
  priceBs: number;
  isDelivery?: boolean;
  editableDetailLines?: string[];
};

type DraftItem = {
  localId: string;
  productId: number;
  skuSnapshot: string | null;
  productNameSnapshot: string;
  qty: number;
  sourcePriceCurrency: 'VES' | 'USD';
  sourcePriceAmount: number;
  unitPriceUsdSnapshot: number;
  lineTotalUsd: number;
  editableDetailLines: string[];
};

type DraftEditableSelection = {
  localId: string;
  componentProductId: number;
  componentName: string;
  qty: number;
};

type MoneyAccountOption = {
  id: number;
  name: string;
  currencyCode: 'USD' | 'VES';
  accountKind: 'bank' | 'cash' | 'fund' | 'other' | 'pos' | 'wallet';
  institutionName: string;
  ownerName: string;
  notes: string;
  isActive: boolean;
  createdAt: string;
  createdByUserId: string | null;
};

type MoneyMovementItem = {
  id: number;
  movementDate: string;
  createdAt: string;
  createdByUserId: string;
  confirmedAt: string | null;
  confirmedByUserId: string | null;
  direction: 'inflow' | 'outflow';
  movementType:
    | 'adjustment'
    | 'cash_count_adjustment'
    | 'change_given'
    | 'expense_payment'
    | 'fee_charge'
    | 'order_payment'
    | 'other_income'
    | 'withdrawal';
  moneyAccountId: number;
  currencyCode: 'USD' | 'VES';
  amount: number;
  exchangeRateVesPerUsd: number | null;
  amountUsdEquivalent: number;
  referenceCode: string | null;
  counterpartyName: string | null;
  description: string | null;
  notes: string | null;
  orderId: number | null;
  paymentReportId: number | null;
  movementGroupId: string | null;
};

type ClientAddress = {
  addressText: string;
  gpsUrl: string;
};

type ClientItem = {
  id: number;
  fullName: string;
  phone: string;
  notes: string;
  primaryAdvisorId: string | null;
  createdAt: string;
  clientType: string;
  isActive: boolean;
  birthDate: string;
  importantDate: string;
  billingCompanyName: string;
  billingTaxId: string;
  billingAddress: string;
  billingPhone: string;
  deliveryNoteName: string;
  deliveryNoteDocumentId: string;
  deliveryNoteAddress: string;
  deliveryNotePhone: string;
  recentAddresses: unknown[];
  crmTags: unknown[];
  extraFields: Record<string, unknown>;
  updatedAt: string;
};

type DriverOption = {
  id: string;
  fullName: string;
};

type AdvisorOption = {
  userId: string;
  fullName: string;
  isActive: boolean;
};


type DeliveryPartnerOption = {
  id: number;
  name: string;
  partnerType: string;
  whatsappPhone: string | null;
};

type PaymentReportItem = {
  id: number;
  status: 'pending' | 'confirmed' | 'rejected';
  createdAt: string | null;
  reporterUserId: string | null;
  reporterName: string;
  currencyCode: string;
  amount: number;
  exchangeRate: number | null;
  usdEquivalent: number;
  moneyAccountId: number;
  moneyAccountName: string;
  referenceCode: string | null;
  payerName: string | null;
  notes: string | null;
};

type OrderEditMeta = {
  clientId: number | null;
  source: 'advisor' | 'master' | 'walk_in';
  attributedAdvisorUserId: string | null;
  receiverName: string | null;
  receiverPhone: string | null;
  deliveryGpsUrl: string | null;
  deliveryEtaMinutes: number | null;
  paymentMethod: string | null;
  paymentCurrency: 'USD' | 'VES' | null;
  paymentRequiresChange: boolean;
  paymentChangeFor: string | null;
  paymentChangeCurrency: 'USD' | 'VES' | null;
  paymentNote: string | null;
  hasDeliveryNote: boolean;
  hasInvoice: boolean;
  invoiceDataNote: string | null;
  invoiceSnapshot: {
    companyName: string | null;
    taxId: string | null;
    address: string | null;
    phone: string | null;
  } | null;
  deliveryNoteSnapshot: {
    name: string | null;
    documentId: string | null;
    address: string | null;
    phone: string | null;
  } | null;
  fxRate: number | null;
  discountEnabled: boolean;
  discountPct: number | null;
  invoiceTaxPct: number | null;
  invoiceTaxAmountUsd: number | null;
  invoiceTaxAmountBs: number | null;
  subtotalBs: number | null;
  subtotalUsd: number | null;
  subtotalAfterDiscountBs: number | null;
  subtotalAfterDiscountUsd: number | null;
};

type Order = {
  id: number;
  orderNumber: string;
  createdAtISO: string;
  deliveryAtISO: string;
  source: 'advisor' | 'master' | 'walk_in';
  clientId: number | null;
  attributedAdvisorUserId: string | null;
  advisorName: string;
  clientName: string;
  fulfillment: Fulfillment;
  address?: string;
  status: OrderStatus;
  queuedNeedsReapproval: boolean;
  totalUsd: number;
  balanceUsd: number;
  totalBs: number;
  paymentVerify: PaymentVerify;
  confirmedPaidUsd: number;
  pendingReportedUsd: number;
  rejectedReportedUsd: number;
  notes?: string;
  lines: OrderLine[];
  draftItems: DraftItem[];
  editMeta: OrderEditMeta;
  paymentReports: PaymentReportItem[];
  riderName?: string;
  externalPartner?: string;
};
type MasterTray =
  | 'pending_created'
  | 'reapproval'
  | 'queued'
  | 'kitchen'
  | 'delivery'
  | 'finalized'
  | 'all';

type NotificationType = 'APROBAR' | 'RE-APROBAR' | 'CONFIRMAR PAGO';

type MasterNotification = {
  id: string;
  type: NotificationType;
  orderId: number;
  label: string;
  deliveryText: string;
  advisorName: string;
};

 type ViewMode = 'operations' | 'settings' | 'calculations';
type ToastState = {
  type: 'success' | 'error';
  message: string;
} | null;
type SettingsTab = 'catalog' | 'exchange_rate' | 'accounts' | 'clients';
type CalculationsTab = 'advisors';
type CalculationsSource = '' | 'advisor' | 'master' | 'walk_in';

type QuickCatalogPriceRow = {
  productId: number;
  name: string;
  sku: string;
  sourcePriceCurrency: 'VES' | 'USD';
  originalAmount: string;
  nextAmount: string;
};

type CatalogItem = {
  id: number;
  sku: string;
  name: string;
  type: 'product' | 'combo' | 'service' | 'promo' | 'gambit';
  isActive: boolean;
  sourcePriceAmount: number;
  sourcePriceCurrency: 'VES' | 'USD';
  basePriceUsd: number;
  basePriceBs: number;
  unitsPerService: number;
  isDetailEditable: boolean;
  detailUnitsLimit: number;
  isInventoryItem: boolean;
  isTemporary: boolean;
  isComboComponentSelectable: boolean;
  commissionMode: 'default' | 'fixed_item' | 'fixed_order';
  commissionValue: number | null;
  commissionNotes: string | null;
};

type ProductComponent = {
  id: number;
  parentProductId: number;
  componentProductId: number;
  componentMode: 'fixed' | 'selectable';
  quantity: number;
  countsTowardDetailLimit: boolean;
  isRequired: boolean;
  sortOrder: number;
  notes: string | null;
  parentSku: string;
  parentName: string;
  componentSku: string;
  componentName: string;
  componentType: 'product' | 'combo' | 'service' | 'promo' | 'gambit';
};

type ExchangeRateInfo = {
  id: number;
  rateBsPerUsd: number;
  effectiveAt: string;
};

const MONEY_ACCOUNT_KIND_LABEL: Record<MoneyAccountOption['accountKind'], string> = {
  bank: 'Banco',
  cash: 'Caja',
  fund: 'Fondo',
  other: 'Otro',
  pos: 'Punto',
  wallet: 'Wallet',
};

const MOVEMENT_TYPE_LABEL: Record<MoneyMovementItem['movementType'], string> = {
  adjustment: 'Ajuste',
  cash_count_adjustment: 'Ajuste de caja',
  change_given: 'Cambio entregado',
  expense_payment: 'Pago de gasto',
  fee_charge: 'ComisiÃ³n',
  order_payment: 'Pago de orden',
  other_income: 'Otro ingreso',
  withdrawal: 'Retiro',
};

type EditableComponentRow = {
  localId: string;
  componentProductId: number;
  componentMode: 'fixed' | 'selectable';
  quantity: number;
  countsTowardDetailLimit: boolean;
  isRequired: boolean;
  sortOrder: number;
  notes: string;
};

const ORDER_STATUS_LABEL: Record<OrderStatus, string> = {
  created: 'Creada',
  queued: 'En cola',
  confirmed: 'Enviado a cocina',
  in_kitchen: 'En preparación',
  ready: 'Preparada',
  out_for_delivery: 'En camino',
  delivered: 'Entregado / Retirado',
  cancelled: 'Cancelado',
};

const fmtUSD = (n: number) => `$${n.toFixed(2)}`;

const fmtBs = (n: number) => {
  const s = Math.round(n).toString();
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const idxFromEnd = s.length - i;
    out += s[i];
    if (idxFromEnd > 1 && idxFromEnd % 3 === 1) out += '.';
  }
  return `Bs ${out}`;
};

const fmtRateBs = (n: number) => {
  if (!Number.isFinite(n)) return 'Bs —';

  const fixed = n.toFixed(2);
  const [intPart, decPart] = fixed.split('.');

  let out = '';
  for (let i = 0; i < intPart.length; i++) {
    const idxFromEnd = intPart.length - i;
    out += intPart[i];
    if (idxFromEnd > 1 && idxFromEnd % 3 === 1) out += '.';
  }

  return `Bs ${out}.${decPart}`;
};

const fmtMoneyByCurrency = (amount: number, currencyCode: 'USD' | 'VES') => {
  return currencyCode === 'VES' ? fmtBs(amount) : fmtUSD(amount);
};

function normalizeClientTags(tags: unknown[]) {
  return Array.from(
    new Set(
      (Array.isArray(tags) ? tags : [])
        .map((tag) => String(tag || '').trim())
        .filter(Boolean)
    )
  );
}

function normalizeClientAddresses(addresses: unknown[]): ClientAddress[] {
  const rows = Array.isArray(addresses) ? addresses : [];

  return rows
    .map((row) => {
      const data =
        row && typeof row === 'object' ? (row as Record<string, unknown>) : {};

      return {
        addressText: String(
          data.addressText ??
            data.address_text ??
            ''
        ).trim(),
        gpsUrl: String(data.gpsUrl ?? data.gps_url ?? '').trim(),
      };
    })
    .filter((row) => row.addressText || row.gpsUrl)
    .slice(0, 2);
}

function tagsToInputValue(tags: string[]) {
  return tags.join(', ');
}

function parseTagsInput(value: string) {
  return Array.from(
    new Set(
      value
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean)
    )
  );
}

const fmtTimeAMPM = (iso: string) => {
  const d = new Date(iso);
  return d.toLocaleTimeString('es-VE', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: 'America/Caracas',
  });
};

const fmtDeliveryTextES = (iso: string) => {
  const d = new Date(iso);

  const dow = d.toLocaleDateString('es-VE', {
    weekday: 'short',
    timeZone: 'America/Caracas',
  });

  const dd = d.toLocaleDateString('es-VE', {
    day: '2-digit',
    timeZone: 'America/Caracas',
  });

  const mm = d.toLocaleDateString('es-VE', {
    month: '2-digit',
    timeZone: 'America/Caracas',
  });

  const time = d.toLocaleTimeString('es-VE', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: 'America/Caracas',
  });

  const cap = dow.charAt(0).toUpperCase() + dow.slice(1);
  return `${cap} ${dd}/${mm} · ${time}`;
};

function fmtDateTimeES(iso: string | null) {
  if (!iso) return '—';

  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';

  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');

  let hour = d.getHours();
  const minute = String(d.getMinutes()).padStart(2, '0');

  const ampm = hour >= 12 ? 'p. m.' : 'a. m.';
  hour = hour % 12;
  if (hour === 0) hour = 12;

  const yy = String(year).slice(-2);

  return `${day}/${month}/${yy} · ${hour}:${minute} ${ampm}`;
}

function toDateInputValue(d: Date) {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function fmtShortOrderLabel(orderId: number) {
  return String(orderId).padStart(2, '0');
}

function splitISOToDeliveryFields(iso: string) {
  const d = new Date(iso);

  if (Number.isNaN(d.getTime())) {
    return {
      date: '',
      hour12: '',
      minute: '',
      ampm: 'AM' as 'AM' | 'PM',
    };
  }

  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Caracas',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(d);

  const getPart = (type: string) => parts.find((part) => part.type === type)?.value ?? '';

  const year = getPart('year');
  const month = getPart('month');
  const day = getPart('day');

  let hour24 = Number(getPart('hour'));
  const minute = getPart('minute');
  const ampm: 'AM' | 'PM' = hour24 >= 12 ? 'PM' : 'AM';

  let hour12 = hour24 % 12;
  if (hour12 === 0) hour12 = 12;

  return {
    date: `${year}-${month}-${day}`,
    hour12: String(hour12),
    minute,
    ampm,
  };
}

const pillLabel = (f: Fulfillment) => (f === 'delivery' ? 'Delivery' : 'Pickup');
const paymentLabel = (balanceUsd: number) => (balanceUsd <= 0 ? 'Pagado ✅' : `● Pendiente: ${fmtUSD(balanceUsd)}`);
const paymentToneClass = (balanceUsd: number) => (balanceUsd <= 0 ? 'text-emerald-400' : 'text-orange-500');

function splitTwoWordsCompact(full: string) {
  const parts = (full || '').trim().split(/\s+/).filter(Boolean);
  const first = parts[0] ?? '—';
  const second = parts[1] ?? '';
  const hasMore = parts.length > 2;
  const line2 = second ? (hasMore ? `${second}…` : second) : '';
  return { line1: first, line2 };
}

function hasDeliveryAssignment(o: Order) {
  return Boolean(
    (o.riderName && o.riderName.trim()) ||
    (o.externalPartner && o.externalPartner.trim())
  );
}

function getPaymentCurrencyByMethod(method: string): 'USD' | 'VES' {
  if (method === 'payment_mobile') return 'VES';
  if (method === 'transfer') return 'VES';
  if (method === 'cash_usd') return 'USD';
  if (method === 'cash_ves') return 'VES';
  if (method === 'zelle') return 'USD';
  if (method === 'pending') return 'USD';
  return 'USD';
}

function getPaymentMethodLabel(method: string) {
  if (method === 'pending') return 'Pendiente';
  if (method === 'payment_mobile') return 'Pago móvil';
  if (method === 'transfer') return 'Transferencia';
  if (method === 'cash_usd') return 'Efectivo USD';
  if (method === 'cash_ves') return 'Efectivo Bs';
  if (method === 'zelle') return 'Zelle';
  if (method === 'mixed') return 'Mixto';
  return '—';
}

function getCurrentOperatorLabel(
  roles: string[],
  currentUser: { fullName?: string; email: string }
) {
  const name = currentUser.fullName?.trim() || currentUser.email || 'Usuario';

  if (roles.includes('admin')) return `Admin (${name})`;
  if (roles.includes('master')) return `Máster (${name})`;

  return name;
}

function orderMainLinesForPreview(lines: OrderLine[]) {
  const services: OrderLine[] = [];
  const extras: OrderLine[] = [];
  const delivery: OrderLine[] = [];

  for (const l of lines) {
    const isDelivery = !!l.isDelivery || l.name.toLowerCase().startsWith('delivery');
    if (isDelivery) {
      delivery.push(l);
      continue;
    }

    const nameLower = l.name.toLowerCase();
    const isExtra =
      nameLower.includes('salsa') ||
      nameLower.includes('aderezo') ||
      nameLower.includes('crema') ||
      nameLower.includes('pepsi') ||
      nameLower.includes('coca') ||
      nameLower.includes('malta') ||
      nameLower.includes('lipton') ||
      nameLower.includes('yukery') ||
      nameLower.includes('jugo') ||
      nameLower.includes('dondy');

    (isExtra ? extras : services).push(l);
  }

  return [...services, ...extras, ...delivery];
}

function calcUnits(line: OrderLine) {
  if (line.unitsPerService > 0) return line.qty * line.unitsPerService;
  const m = line.name.match(/\((\d+)\s*und\)/i);
  if (m) {
    const base = Number(m[1]);
    if (!Number.isNaN(base) && base > 0) return line.qty * base;
  }
  return null;
}



function lineTextWhatsAppStyle(line: OrderLine) {
  const units = calcUnits(line);
  const bs = fmtBs(line.qty * line.priceBs);
  const isDelivery = !!line.isDelivery || line.name.toLowerCase().startsWith('delivery');

  if (isDelivery) return `▪️ ${line.qty} ${line.name}: ${bs}`;

  if (units !== null) {
    const cleanName = line.name.replace(/\s*\(\d+\s*und\)\s*/i, ' ').trim();
    return `▪️ ${line.qty} Serv. ${cleanName} (${units} und): ${bs}`;
  }

  return `▪️ ${line.qty} ${line.name}: ${bs}`;
}

function buildWhatsAppOrderSummary(order: Order) {
  const lines = orderMainLinesForPreview(order.lines);

  const parts: string[] = [];

  parts.push(`*Resumen de Pedido*`);
  parts.push('');
  parts.push(`✅ *Orden:* ${order.id}`);
  parts.push(`✅ *Asesor:* ${order.advisorName}`);
  parts.push(`✅ *Cliente:* ${order.clientName}`);

  parts.push('');
  parts.push(`✅ *Pedido:*`);
  parts.push('');

  if (lines.length === 0) {
    parts.push(`▪️ Sin ítems cargados`);
  } else {
    for (const line of lines) {
      parts.push(lineTextWhatsAppStyle(line));

      if (line.editableDetailLines && line.editableDetailLines.length > 0) {
        for (const detail of line.editableDetailLines) {
          parts.push(`- ${detail}`);
        }
      }
    }
  }

  parts.push('');
  parts.push(`*TOTAL:* ${fmtBs(order.totalBs)} / ${fmtUSD(order.totalUsd)}`);

  parts.push('');
  parts.push(`✅ *Entrega:* ${order.fulfillment === 'delivery' ? 'Delivery' : 'Pickup'}`);
  parts.push(`✅ *Día de entrega:* ${fmtDeliveryTextES(order.deliveryAtISO)}`);

  if (order.fulfillment === 'delivery' && order.address?.trim()) {
    parts.push(`✅ *Dirección:* ${order.address.trim()}`);
  }

  if (order.notes?.trim()) {
    parts.push('');
    parts.push(`✅ *Nota:* ${order.notes.trim()}`);
  }

  return parts.join('\n');
}

function isCommittedStatus(s: OrderStatus) {
  return ['created', 'queued', 'confirmed', 'in_kitchen', 'ready', 'out_for_delivery'].includes(s);
}

function computeCommittedUndByProduct(orders: Order[]) {
  const map = new Map<string, number>();
  for (const o of orders) {
    if (!isCommittedStatus(o.status)) continue;
    for (const line of o.lines) {
      const isDeliveryLine = !!line.isDelivery || line.name.toLowerCase().startsWith('delivery');
      if (isDeliveryLine) continue;
      const units = calcUnits(line);
      if (units === null) continue;
      map.set(line.name, (map.get(line.name) ?? 0) + units);
    }
  }
  return Array.from(map.entries())
    .map(([name, und]) => ({ name, und }))
    .sort((a, b) => b.und - a.und);
}

function startOfWeekMon(d: Date) {
  const day = d.getDay();
  const diff = (day === 0 ? -6 : 1) - day;
  const x = new Date(d);
  x.setDate(d.getDate() + diff);
  x.setHours(0, 0, 0, 0);
  return x;
}
function endOfWeekSun(d: Date) {
  const start = startOfWeekMon(d);
  const x = new Date(start);
  x.setDate(start.getDate() + 6);
  x.setHours(23, 59, 59, 999);
  return x;
}
function fmtWeekRangeES(d: Date) {
  const s = startOfWeekMon(d);
  const e = endOfWeekSun(d);
  const dd1 = String(s.getDate()).padStart(2, '0');
  const mm1 = String(s.getMonth() + 1).padStart(2, '0');
  const dd2 = String(e.getDate()).padStart(2, '0');
  const mm2 = String(e.getMonth() + 1).padStart(2, '0');
  return `Semana: Lun ${dd1}/${mm1} – Dom ${dd2}/${mm2}`;
}

function withinDay(dISO: string, day: Date) {
  const d = new Date(dISO);
  const a = new Date(day);
  a.setHours(0, 0, 0, 0);
  const b = new Date(day);
  b.setHours(23, 59, 59, 999);
  return d >= a && d <= b;
}
function withinWeek(dISO: string, day: Date) {
  const d = new Date(dISO);
  const s = startOfWeekMon(day);
  const e = endOfWeekSun(day);
  return d >= s && d <= e;
}

function matchesTray(o: Order, tray: MasterTray) {
  if (tray === 'all') return true;
  if (tray === 'pending_created') return o.status === 'created';
  if (tray === 'reapproval') return o.status === 'queued' && o.queuedNeedsReapproval;
  if (tray === 'queued') return o.status === 'queued';
  if (tray === 'kitchen') return ['confirmed', 'in_kitchen', 'ready'].includes(o.status);
  if (tray === 'delivery') return o.fulfillment === 'delivery' && ['out_for_delivery', 'delivered'].includes(o.status);
  if (tray === 'finalized') return ['delivered', 'cancelled'].includes(o.status);
  return true;
}

function canSendToKitchen(o: Order) {
  return o.status === 'queued' && o.queuedNeedsReapproval === false;
}

function canReviewQueuedChanges(o: Order) {
  return o.status === 'queued' && o.queuedNeedsReapproval;
}

function canKitchenTake(o: Order) {
  return o.status === 'confirmed';
}

function canMarkReady(o: Order) {
  return o.status === 'in_kitchen';
}

function canOutForDelivery(o: Order) {
  return o.fulfillment === 'delivery' && o.status === 'ready';
}

function canMarkDelivered(o: Order) {
  if (o.fulfillment === 'pickup') return o.status === 'ready';
  return o.status === 'out_for_delivery';
}

function kitchenTooltip(o: Order) {
  if (o.status === 'created') return 'Pendiente de aprobación';
  if (o.status === 'queued' && o.queuedNeedsReapproval) return 'Requiere re-aprobación';
  if (o.status === 'queued') return 'Listo para enviar a cocina';
  if (o.status === 'cancelled') return 'Pedido cancelado';
  if (o.status === 'delivered') return 'Pedido finalizado';
  return 'Ya está en proceso';
}
function riderEnabled(o: Order) {
  return (
    o.fulfillment === 'delivery' &&
    ['confirmed', 'in_kitchen', 'ready'].includes(o.status)
  );
}
function riderTooltip(o: Order) {
  if (o.fulfillment === 'pickup') return 'No aplica (PickUp)';
  if (!['confirmed', 'in_kitchen', 'ready'].includes(o.status)) {
    return 'Solo puedes asignar driver cuando la orden está confirmada, en cocina o preparada';
  }
  return 'Asignar delivery';
}

function payIcon(p: PaymentVerify) {
  if (p === 'pending') return '🟠';
  if (p === 'confirmed') return '✅';
  if (p === 'rejected') return '❌';
  return '—';
}
function payIconTooltip(p: PaymentVerify) {
  if (p === 'pending') return 'Por confirmar';
  if (p === 'confirmed') return 'Confirmado';
  if (p === 'rejected') return 'Rechazado';
  return 'Sin reporte';
}

function processFlag(o: Order): 'APROBAR' | 'RE-APROBAR' | null {
  if (o.status === 'created') return 'APROBAR';
  if (o.status === 'queued' && o.queuedNeedsReapproval) return 'RE-APROBAR';
  return null;
}

function canReturnFromKitchenToQueue(o: Order) {
  return ['confirmed', 'in_kitchen', 'ready'].includes(o.status);
}

function canManageDeliveryAssignment(o: Order) {
  return (
    o.fulfillment === 'delivery' &&
    ['queued', 'confirmed', 'in_kitchen', 'ready', 'out_for_delivery'].includes(o.status)
  );
}

function getProcessSteps(o: Order) {
  const isPickup = o.fulfillment === 'pickup';

  return [
    { key: 'created', label: 'Creada' },
    { key: 'queued', label: 'En cola' },
    { key: 'confirmed', label: 'En cocina' },
    { key: 'ready', label: 'Preparada' },
    { key: isPickup ? 'pickup_ready' : 'out_for_delivery', label: isPickup ? 'Lista para retiro' : 'En camino' },
    { key: 'delivered', label: isPickup ? 'Retirada' : 'Entregada' },
  ];
}

function getProcessCurrentKey(o: Order) {
  if (o.status === 'created') return 'created';
  if (o.status === 'queued') return 'queued';
if (o.status === 'confirmed' || o.status === 'in_kitchen') return 'confirmed';
if (o.fulfillment === 'pickup' && o.status === 'ready') return 'pickup_ready';
if (o.status === 'ready') return 'ready';
if (o.status === 'out_for_delivery') return 'out_for_delivery';
if (o.status === 'delivered') return 'delivered';
if (o.status === 'cancelled') return 'cancelled';
  return 'created';
}

function getProcessStepTone(stepKey: string, currentKey: string, cancelled: boolean, orderedKeys: string[]) {
  if (cancelled) {
    return stepKey === currentKey ? 'current-cancelled' : 'future';
  }

  const currentIndex = orderedKeys.indexOf(currentKey);
  const stepIndex = orderedKeys.indexOf(stepKey);

  if (stepIndex < currentIndex) return 'done';
  if (stepIndex === currentIndex) return 'current';
  return 'future';
}

function getNextPrimaryActionLabel(o: Order) {
  if (canSendToKitchen(o)) return 'Enviar a cocina';
  if (canKitchenTake(o)) return 'Tomar en cocina';
  if (canMarkReady(o)) return 'Marcar preparada';
  if (canOutForDelivery(o)) return o.fulfillment === 'pickup' ? 'Lista para retiro' : 'En camino';
  if (canMarkDelivered(o)) return o.fulfillment === 'pickup' ? 'Marcar retirado' : 'Marcar entregado';
  if (o.status === 'cancelled') return 'Orden cancelada';
  if (o.status === 'delivered') return 'Ciclo completado';
  if (o.status === 'created') return 'Pendiente de aprobación';
  if (o.status === 'queued' && o.queuedNeedsReapproval) return 'Pendiente de re-aprobación';
  return 'Sin acción principal';
}

function ProcessTimeline({ order }: { order: Order }) {
  const steps = getProcessSteps(order);
  const currentKey = getProcessCurrentKey(order);
  const orderedKeys = steps.map((s) => s.key);
  const cancelled = order.status === 'cancelled';

  return (
    <div className="rounded-lg border border-[#1D1D28] bg-[#101014] px-2.5 py-2">
      <div className="flex items-center gap-1.5">
        {steps.map((step, idx) => {
          const tone = getProcessStepTone(step.key, currentKey, cancelled, orderedKeys);

          const dotClass =
            tone === 'done'
              ? 'bg-emerald-500 border-emerald-500'
              : tone === 'current'
                ? 'bg-[#FEEF00] border-[#FEEF00]'
                : tone === 'current-cancelled'
                  ? 'bg-red-500 border-red-500'
                  : 'bg-[#191926] border-[#2A2A38]';

          const textClass =
            tone === 'done'
              ? 'text-emerald-400'
              : tone === 'current'
                ? 'text-[#FEEF00]'
                : tone === 'current-cancelled'
                  ? 'text-red-400'
                  : 'text-[#6F6F7C]';

          const lineClass =
            tone === 'done'
              ? 'bg-emerald-500/60'
              : 'bg-[#242433]';

          return (
            <div key={step.key} className="flex min-w-0 flex-1 items-center">
              <div className="flex min-w-0 items-center gap-1">
                <div className={`h-2 w-2 shrink-0 rounded-full border ${dotClass}`} />
                <div className={`truncate text-[10px] leading-none ${textClass}`}>
                  {step.label}
                </div>
              </div>

              {idx < steps.length - 1 ? (
                <div className={`mx-1 h-[1px] flex-1 rounded-full ${lineClass}`} />
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function NextActionCard({
  order,
  onSendToKitchen,
  onPrepareKitchenTake,
  onMarkReady,
  onOutForDelivery,
  onMarkDelivered,
}: {
  order: Order;
  onSendToKitchen: () => void;
  onPrepareKitchenTake: () => void;
  onMarkReady: () => void;
  onOutForDelivery: () => void;
  onMarkDelivered: () => void;
}) {
  const label = getNextPrimaryActionLabel(order);

  let button: React.ReactNode = null;

  const btnClass =
    'rounded-md border border-[#2A2A38] bg-[#0D0D11] px-2 py-1 text-[11px] text-[#F5F5F7] hover:border-[#FEEF00]';

  if (canSendToKitchen(order)) {
    button = <button className={btnClass} onClick={onSendToKitchen}>Enviar a cocina</button>;
  } else if (canKitchenTake(order)) {
    button = <button className={btnClass} onClick={onPrepareKitchenTake}>Tomar en cocina</button>;
  } else if (canMarkReady(order)) {
    button = <button className={btnClass} onClick={onMarkReady}>Marcar preparada</button>;
  } else if (canOutForDelivery(order)) {
    button = (
      <button className={btnClass} onClick={onOutForDelivery}>
        {order.fulfillment === 'pickup' ? 'Lista retiro' : 'En camino'}
      </button>
    );
  } else if (canMarkDelivered(order)) {
    button = (
      <button className={btnClass} onClick={onMarkDelivered}>
        {order.fulfillment === 'pickup' ? 'Retirado' : 'Entregado'}
      </button>
    );
  }

  return (
    <div className="rounded-lg border border-[#1D1D28] bg-[#101014] px-2.5 py-2">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[10px] text-[#8A8A96]">Próxima acción</div>
          <div className="truncate text-[11px] text-[#F5F5F7]">{label}</div>
        </div>

        <div className="shrink-0">
          {button ? button : <div className="text-[10px] text-[#6F6F7C]">Sin acción</div>}
        </div>
      </div>
    </div>
  );
}

function Drawer({
  open,
  title,
  onClose,
  children,
  widthClass = 'w-[420px]',
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  widthClass?: string;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[100]">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className={`absolute right-0 top-0 h-full ${widthClass} border-l border-[#242433] bg-[#0B0B0D]`}>
        <div className="flex items-center justify-between border-b border-[#242433] px-4 py-3">
          <div className="text-base font-semibold text-[#F5F5F7]">{title}</div>
          <button
            className="rounded-lg border border-[#242433] bg-[#121218] px-2 py-1 text-sm text-[#B7B7C2]"
            onClick={onClose}
          >
            ✕
          </button>
        </div>
        <div className="h-[calc(100%-52px)] overflow-y-auto px-4 py-4">{children}</div>
      </div>
    </div>
  );
}

function Chip({
  children,
  active,
  onClick,
}: {
  children: React.ReactNode;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={[
        'whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px]',
        active ? 'border-[#FEEF00] text-[#F5F5F7]' : 'border-[#242433] text-[#8A8A96] hover:text-[#F5F5F7]',
        'bg-[#101014]',
      ].join(' ')}
    >
      {children}
    </button>
  );
}

function SmallBadge({ label, tone }: { label: string; tone: 'brand' | 'warn' | 'muted' }) {
  const cls =
    tone === 'brand'
      ? 'bg-[#FEEF00] text-[#0B0B0D]'
      : tone === 'warn'
        ? 'bg-orange-500 text-[#0B0B0D]'
        : 'bg-[#191926] text-[#B7B7C2]';
  return <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${cls}`}>{label}</span>;
}

function productCompositionKind(item: CatalogItem | null, sku: string | undefined, components: ProductComponent[]) {
  if (!item) return 'Sin definir';
  if (sku?.startsWith('MIX_')) return 'Mixto fijo';
  if (item.isDetailEditable) {
    if (components.some((c) => c.componentMode === 'fixed')) {
      return 'Plato configurable con extras fijos';
    }
    return 'Plato configurable';
  }
  if (components.length > 0) return 'Combo fijo';
  return 'Sin composición';
}

function Card({ title, children, className }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={['rounded-2xl border border-[#242433] bg-[#121218] p-4', className || ''].join(' ')}>
      <div className="text-sm font-semibold text-[#F5F5F7]">{title}</div>
      <div className="mt-3 space-y-2">{children}</div>
    </div>
  );
}

function StatRow({
  label,
  value,
  highlight,
  highlightTone,
}: {
  label: string;
  value: number | string;
  highlight?: boolean;
  highlightTone?: 'brand' | 'warn';
}) {
  const tone =
    highlightTone === 'brand'
      ? 'text-[#FEEF00]'
      : highlightTone === 'warn'
        ? 'text-orange-500'
        : highlight
          ? 'text-[#FEEF00]'
          : 'text-[#F5F5F7]';

  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <div className="text-[#B7B7C2]">{label}</div>
      <div className={['font-semibold', tone].join(' ')}>{value}</div>
    </div>
  );
}

function Btn({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button onClick={onClick} className="rounded-2xl border border-[#242433] bg-[#0B0B0D] px-3 py-2 text-sm">
      {children}
    </button>
  );
}

function InfoCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-[#242433] bg-[#0B0B0D] px-3 py-2">
      <div className="text-xs text-[#8A8A96]">{label}</div>
      <div className="mt-1 text-sm font-medium text-[#F5F5F7]">{value}</div>
    </div>
  );
}

function ComponentCard({
  pc,
  catalogItems,
}: {
  pc: ProductComponent;
  catalogItems: CatalogItem[];
}) {
  const isSelectable = pc.componentMode === 'selectable';

  return (
    <div className="rounded-xl border border-[#242433] bg-[#0B0B0D] p-3">
      <div className="flex items-start justify-between gap-3">
<div>
  <div className="text-sm font-medium text-[#F5F5F7]">
    {pc.componentName}
  </div>
  <div className="mt-1 text-xs text-[#8A8A96]">
    {pc.componentSku ? `${pc.componentSku} · ` : ''}
    {catalogItems.find((p) => p.id === pc.componentProductId)?.unitsPerService
      ? `${catalogItems.find((p) => p.id === pc.componentProductId)?.unitsPerService} und/serv`
      : '—'}
  </div>
</div>


        <div className="flex items-center gap-2">
          <SmallBadge
            label={pc.componentMode}
            tone={pc.componentMode === 'selectable' ? 'brand' : 'muted'}
          />
          {!pc.isRequired ? <SmallBadge label="Opcional" tone="warn" /> : null}
        </div>
      </div>

      {!isSelectable ? (
        <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
          <div>
            <div className="text-[#8A8A96]">Cantidad</div>
            <div className="mt-1 text-[#F5F5F7]">{pc.quantity}</div>
          </div>
          <div>
            <div className="text-[#8A8A96]">Cuenta límite</div>
            <div className="mt-1 text-[#F5F5F7]">
              {pc.countsTowardDetailLimit ? 'Sí' : 'No'}
            </div>
          </div>
          <div>
            <div className="text-[#8A8A96]">Requerido</div>
            <div className="mt-1 text-[#F5F5F7]">{pc.isRequired ? 'Sí' : 'No'}</div>
          </div>
        </div>
      ) : (
        <div className="mt-3 text-xs text-[#B7B7C2]">
          Opción habilitada para selección dentro del límite del plato.
        </div>
      )}

      {pc.notes ? (
        <div className="mt-3 text-xs text-[#B7B7C2]">
          <span className="text-[#8A8A96]">Notas:</span> {pc.notes}
        </div>
      ) : null}
    </div>
  );
}

function FieldInput({
  label,
  value,
  onChange,
  type = 'text',
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
}) {
  return (
    <div>
      <label className="mb-1 block text-xs text-[#8A8A96]">{label}</label>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        type={type}
        className="w-full rounded-xl border border-[#242433] bg-[#0B0B0D] px-3 py-2 text-sm text-[#F5F5F7]"
      />
    </div>
  );
}

function FieldSelect({
  label,
  value,
  onChange,
  options,
  disabled = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
  disabled?: boolean;
}) {
  return (
    <div>
      <label className="mb-1 block text-xs text-[#8A8A96]">{label}</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className="w-full rounded-xl border border-[#242433] bg-[#0B0B0D] px-3 py-2 text-sm text-[#F5F5F7] disabled:opacity-60"
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </div>
  );
}


function FieldCheckbox({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 rounded-xl border border-[#242433] bg-[#0B0B0D] px-3 py-2 text-sm text-[#F5F5F7]">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      {label}
    </label>
  );
}

function parseEditableDetailLines(lines: string[]) {
  let alias = '';
  const selections: Array<{ componentName: string; qty: number }> = [];

  for (const rawLine of lines) {
    const line = String(rawLine || '').trim();
    if (!line) continue;

    if (/^para\s*:/i.test(line)) {
      alias = line.replace(/^para\s*:/i, '').trim();
      continue;
    }

    const match = line.match(/^(\d+)\s+(.+)$/i);
    if (match) {
      const qty = Number(match[1]);
      const componentName = match[2].trim();

      if (Number.isFinite(qty) && qty > 0 && componentName) {
        selections.push({ componentName, qty });
      }
    }
  }

  return { alias, selections };
}

function sumComponentUnits(
  rows: Array<{
    quantity: number;
    countsTowardDetailLimit: boolean;
    componentMode: 'fixed' | 'selectable';
  }>
) {
  return rows
    .filter((r) => r.countsTowardDetailLimit)
    .reduce((acc, r) => acc + Number(r.quantity || 0), 0);
}

function getCatalogOperationalModel(
  item: CatalogItem | null,
  components: Array<{
    componentMode: 'fixed' | 'selectable';
    quantity: number;
    countsTowardDetailLimit: boolean;
  }>
) {
  if (!item) {
    return {
      kind: 'unknown',
      label: 'Sin definir',
      summary: 'Sin información',
    };
  }

  const selectable = components.filter((c) => c.componentMode === 'selectable');
  const fixed = components.filter((c) => c.componentMode === 'fixed');

  if (item.sku?.startsWith('MIX_')) {
    return {
      kind: 'mix',
      label: 'Mixto fijo',
      summary: 'Composición cerrada con cantidades exactas por componente.',
    };
  }

  if (item.isDetailEditable) {
    if (fixed.length > 0) {
      return {
        kind: 'configurable_with_fixed',
        label: 'Plato configurable con extras fijos',
        summary:
          'El cliente puede escoger piezas seleccionables dentro del límite. Además puede incluir componentes fijos u opcionales.',
      };
    }

    return {
      kind: 'configurable',
      label: 'Plato configurable',
      summary:
        'El cliente puede escoger piezas seleccionables dentro del límite permitido.',
    };
  }

  if (components.length > 0) {
    return {
      kind: 'fixed_combo',
      label: 'Combo fijo',
      summary: 'Receta cerrada. Debe comprometer exactamente los componentes definidos.',
    };
  }

  return {
    kind: 'simple',
    label: 'Ítem simple',
    summary: 'Producto sin composición cargada.',
  };
}

function validateCatalogBeforeSave(params: {
  item: CatalogItem | null;
  editIsDetailEditable: boolean;
  editDetailUnitsLimit: string;
  editComponents: EditableComponentRow[];
}) {
  const { item, editIsDetailEditable, editDetailUnitsLimit, editComponents } = params;

  if (!item) {
    return 'Producto inválido.';
  }

  const normalized = editComponents.map((row) => ({
    ...row,
    componentProductId: Number(row.componentProductId || 0),
    quantity: Number(row.quantity || 0),
    sortOrder: Number(row.sortOrder || 0),
  }));

  if (normalized.some((row) => row.componentProductId <= 0)) {
    return 'Todos los componentes deben tener un producto válido.';
  }

  if (normalized.some((row) => row.componentMode === 'fixed' && row.quantity <= 0)) {
  return 'Todos los componentes fijos deben tener cantidad mayor a 0.';
}

  const seen = new Set<string>();
  for (const row of normalized) {
    const key = `${row.componentProductId}::${row.componentMode}`;
    if (seen.has(key)) {
      return 'No repitas el mismo componente con el mismo modo. Edítalo en una sola fila.';
    }
    seen.add(key);
  }

  if (editIsDetailEditable) {
    const selectable = normalized.filter((row) => row.componentMode === 'selectable');
    if (selectable.length === 0) {
      return 'Un plato editable debe tener al menos un componente seleccionable.';
    }

    const detailLimit = Number(editDetailUnitsLimit || 0);
    if (detailLimit <= 0) {
      return 'El límite de detalle debe ser mayor a 0 para un plato editable.';
    }
  }

  return null;
}

export default function MasterDashboardClient({
  currentUser,
  roles,
  advisors = [],
  initialOrders,
  moneyAccounts,
  moneyMovements = [],
  clients = [],
  drivers = [],
  deliveryPartners = [],
  catalogItems = [],
  productComponents = [],
  activeExchangeRate = null,
}: {
  currentUser: { id: string; email: string; fullName?: string };
  roles: string[];
  advisors?: AdvisorOption[];
  initialOrders: Order[];
  moneyAccounts: MoneyAccountOption[];
  moneyMovements?: MoneyMovementItem[];
  clients?: ClientItem[];
  drivers?: DriverOption[];
  deliveryPartners?: DeliveryPartnerOption[];
  catalogItems?: CatalogItem[];
  productComponents?: ProductComponent[];
  activeExchangeRate?: ExchangeRateInfo | null;
}) {

  const router = useRouter();
  const searchParams = useSearchParams();

  const [isMounted, setIsMounted] = useState(false);
  const [selectedDay, setSelectedDay] = useState<Date | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('operations');
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('catalog');
  const [calculationsTab, setCalculationsTab] = useState<CalculationsTab>('advisors');
  const [advisorCalcDateFrom, setAdvisorCalcDateFrom] = useState('');
  const [advisorCalcDateTo, setAdvisorCalcDateTo] = useState('');
  const [advisorCalcSource, setAdvisorCalcSource] = useState<CalculationsSource>('');
  const [advisorCalcAdvisorId, setAdvisorCalcAdvisorId] = useState('');
  const [accountSearch, setAccountSearch] = useState('');
  const [accountDateFrom, setAccountDateFrom] = useState('');
  const [accountDateTo, setAccountDateTo] = useState('');
  const [selectedAccountId, setSelectedAccountId] = useState<number | null>(null);
  const [accountDetailOpen, setAccountDetailOpen] = useState(false);
  const [accountEditOpen, setAccountEditOpen] = useState(false);
  const [accountCreateOpen, setAccountCreateOpen] = useState(false);
  const [accountSaving, setAccountSaving] = useState(false);
  const [accountFormName, setAccountFormName] = useState('');
  const [accountFormCurrencyCode, setAccountFormCurrencyCode] = useState<'USD' | 'VES'>('VES');
  const [accountFormKind, setAccountFormKind] = useState<MoneyAccountOption['accountKind']>('bank');
  const [accountFormInstitutionName, setAccountFormInstitutionName] = useState('');
  const [accountFormOwnerName, setAccountFormOwnerName] = useState('');
  const [accountFormNotes, setAccountFormNotes] = useState('');
  const [accountFormIsActive, setAccountFormIsActive] = useState(true);
  const [clientSearch, setClientSearch] = useState('');
  const [selectedClientId, setSelectedClientId] = useState<number | null>(null);
  const [clientDetailOpen, setClientDetailOpen] = useState(false);
  const [clientEditOpen, setClientEditOpen] = useState(false);
  const [clientCreateOpen, setClientCreateOpen] = useState(false);
  const [clientSaving, setClientSaving] = useState(false);
  const [clientFormFullName, setClientFormFullName] = useState('');
  const [clientFormPhone, setClientFormPhone] = useState('');
  const [clientFormNotes, setClientFormNotes] = useState('');
  const [clientFormPrimaryAdvisorId, setClientFormPrimaryAdvisorId] = useState('');
  const [clientFormType, setClientFormType] = useState('');
  const [clientFormIsActive, setClientFormIsActive] = useState(true);
  const [clientFormBirthDate, setClientFormBirthDate] = useState('');
  const [clientFormImportantDate, setClientFormImportantDate] = useState('');
  const [clientFormTagsInput, setClientFormTagsInput] = useState('');
  const [clientFormBillingCompanyName, setClientFormBillingCompanyName] = useState('');
  const [clientFormBillingTaxId, setClientFormBillingTaxId] = useState('');
  const [clientFormBillingAddress, setClientFormBillingAddress] = useState('');
  const [clientFormBillingPhone, setClientFormBillingPhone] = useState('');
  const [clientFormDeliveryNoteName, setClientFormDeliveryNoteName] = useState('');
  const [clientFormDeliveryNoteDocumentId, setClientFormDeliveryNoteDocumentId] = useState('');
  const [clientFormDeliveryNoteAddress, setClientFormDeliveryNoteAddress] = useState('');
  const [clientFormDeliveryNotePhone, setClientFormDeliveryNotePhone] = useState('');
  const [clientFormAddress1Text, setClientFormAddress1Text] = useState('');
  const [clientFormAddress1Gps, setClientFormAddress1Gps] = useState('');
  const [clientFormAddress2Text, setClientFormAddress2Text] = useState('');
  const [clientFormAddress2Gps, setClientFormAddress2Gps] = useState('');
  const [catalogSearch, setCatalogSearch] = useState('');
  const [catalogTypeFilter, setCatalogTypeFilter] = useState<'all' | CatalogItem['type']>('all');
  const [selectedCatalogItemId, setSelectedCatalogItemId] = useState<number | null>(null);
  const [catalogDetailOpen, setCatalogDetailOpen] = useState(false);
  const [catalogEditMode, setCatalogEditMode] = useState(false);
  const [catalogSaving, setCatalogSaving] = useState(false);
  const [createCatalogOpen, setCreateCatalogOpen] = useState(false);
const [quickCatalogOpen, setQuickCatalogOpen] = useState(false);
const [quickCatalogSaving, setQuickCatalogSaving] = useState(false);
const [quickCatalogRows, setQuickCatalogRows] = useState<QuickCatalogPriceRow[]>([]);
const [createCatalogSaving, setCreateCatalogSaving] = useState(false);

const [newSku, setNewSku] = useState('');
const [newName, setNewName] = useState('');
const [newType, setNewType] = useState<'product' | 'combo' | 'service' | 'promo' | 'gambit'>('product');
const [newSourcePriceAmount, setNewSourcePriceAmount] = useState('0');
const [newSourcePriceCurrency, setNewSourcePriceCurrency] = useState<'VES' | 'USD'>('VES');
const [newUnitsPerService, setNewUnitsPerService] = useState('0');
const [newIsActive, setNewIsActive] = useState(true);
const [newIsDetailEditable, setNewIsDetailEditable] = useState(false);
const [newDetailUnitsLimit, setNewDetailUnitsLimit] = useState('0');
const [newIsInventoryItem, setNewIsInventoryItem] = useState(true);
const [newIsTemporary, setNewIsTemporary] = useState(false);
const [newIsComboComponentSelectable, setNewIsComboComponentSelectable] = useState(false);
const [newCommissionMode, setNewCommissionMode] = useState<'default' | 'fixed_item' | 'fixed_order'>('default');
const [newCommissionValue, setNewCommissionValue] = useState('');
const [newCommissionNotes, setNewCommissionNotes] = useState('');

  const [editIsActive, setEditIsActive] = useState(true);
  const [editSourcePriceCurrency, setEditSourcePriceCurrency] = useState<'VES' | 'USD'>('VES');
  const [editSourcePriceAmount, setEditSourcePriceAmount] = useState<string>('0');
  const [editUnitsPerService, setEditUnitsPerService] = useState<string>('0');
  const [editIsDetailEditable, setEditIsDetailEditable] = useState(false);
  const [editDetailUnitsLimit, setEditDetailUnitsLimit] = useState<string>('0');
  const [editIsInventoryItem, setEditIsInventoryItem] = useState(true);
  const [editIsTemporary, setEditIsTemporary] = useState(false);
  const [editIsComboComponentSelectable, setEditIsComboComponentSelectable] = useState(false);
  const [editCommissionMode, setEditCommissionMode] = useState<'default' | 'fixed_item' | 'fixed_order'>('default');
  const [editCommissionValue, setEditCommissionValue] = useState('');
  const [editCommissionNotes, setEditCommissionNotes] = useState('');
  const [editComponents, setEditComponents] = useState<EditableComponentRow[]>([]);

  useEffect(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const focusDate = searchParams.get('focusDate');

    if (focusDate) {
      const focused = new Date(`${focusDate}T00:00:00`);
      if (!Number.isNaN(focused.getTime())) {
        focused.setHours(0, 0, 0, 0);
        setSelectedDay(focused);
        setIsMounted(true);
        return;
      }
    }

    setSelectedDay(new Date(today.getTime()));
    setIsMounted(true);
  }, [searchParams.toString()]);

  const dateInputRef = useRef<HTMLInputElement | null>(null);

  const createOrderProductSearchRef = useRef<HTMLInputElement | null>(null);
  const createOrderQtyRef = useRef<HTMLInputElement | null>(null);

  const createOrderConfigAliasRef = useRef<HTMLInputElement | null>(null);
  const createOrderConfigQtyRefs = useRef<Array<HTMLInputElement | null>>([]);

  const [tray, setTray] = useState<MasterTray>('all');
  const [search, setSearch] = useState('');
  const [selectedOrderId, setSelectedOrderId] = useState<number | null>(null);

  const [detailOpen, setDetailOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const [detailTab, setDetailTab] = useState<'detalle' | 'entrega' | 'pagos' | 'notas'>('detalle');

  const [returnMode, setReturnMode] = useState(false);
  const [returnReason, setReturnReason] = useState('');

const [deliveryAssignMode, setDeliveryAssignMode] = useState<null | 'internal' | 'external'>(null);
const [deliveryAssignDriverId, setDeliveryAssignDriverId] = useState('');
const [deliveryAssignPartnerId, setDeliveryAssignPartnerId] = useState('');
const [deliveryAssignReference, setDeliveryAssignReference] = useState('');

const [paymentReportBoxOpen, setPaymentReportBoxOpen] = useState(false);
const [paymentReportMoneyAccountId, setPaymentReportMoneyAccountId] = useState('');
const [paymentReportAmount, setPaymentReportAmount] = useState('');
const [paymentReportExchangeRate, setPaymentReportExchangeRate] = useState('');
const [paymentReportReferenceCode, setPaymentReportReferenceCode] = useState('');
const [paymentReportPayerName, setPaymentReportPayerName] = useState('');
const [paymentReportNotes, setPaymentReportNotes] = useState('');

  const [movementOpen, setMovementOpen] = useState(false);
  const [movementType, setMovementType] = useState<'Ingreso' | 'Egreso' | 'Transferencia'>('Ingreso');

  const [createOrderOpen, setCreateOrderOpen] = useState(false);

  const [orderEditorMode, setOrderEditorMode] = useState<'create' | 'edit'>('create');
const [editingOrderId, setEditingOrderId] = useState<number | null>(null);

  const isAdmin = roles.includes('admin');
const isMaster = roles.includes('master');

const [createOrderSource, setCreateOrderSource] = useState<'advisor' | 'master' | 'walk_in'>('master');
const [createOrderAdvisorUserId, setCreateOrderAdvisorUserId] = useState('');
const [createOrderFulfillment, setCreateOrderFulfillment] = useState<'pickup' | 'delivery'>('pickup');
const [createOrderClientSearch, setCreateOrderClientSearch] = useState('');
const [createOrderClientResults, setCreateOrderClientResults] = useState<
  ClientItem[]
>([]);
const [createOrderSelectedClientId, setCreateOrderSelectedClientId] = useState<number | null>(null);
const [createOrderSelectedClientName, setCreateOrderSelectedClientName] = useState('');
const [createOrderSelectedClientPhone, setCreateOrderSelectedClientPhone] = useState('');
const [createOrderSelectedClientType, setCreateOrderSelectedClientType] = useState<string | null>(null);
const [createOrderClientSearchLoading, setCreateOrderClientSearchLoading] = useState(false);
const [createOrderNewClientMode, setCreateOrderNewClientMode] = useState(false);
const [createOrderNewClientName, setCreateOrderNewClientName] = useState('');
const [createOrderNewClientPhone, setCreateOrderNewClientPhone] = useState('');
const [createOrderNewClientType, setCreateOrderNewClientType] = useState<'assigned' | 'own' | 'legacy'>('assigned');
const [createOrderProductSearch, setCreateOrderProductSearch] = useState('');
const [createOrderProductActiveIndex, setCreateOrderProductActiveIndex] = useState<number>(-1);
const [createOrderSelectedProductId, setCreateOrderSelectedProductId] = useState<number | ''>('');
const [createOrderQty, setCreateOrderQty] = useState<number>(1);
const [createOrderDiscountEnabled, setCreateOrderDiscountEnabled] = useState(false);
const [createOrderDiscountPct, setCreateOrderDiscountPct] = useState('0');
const [createOrderInvoiceTaxPct, setCreateOrderInvoiceTaxPct] = useState('16');
const [createOrderFxRate, setCreateOrderFxRate] = useState(
  activeExchangeRate ? String(activeExchangeRate.rateBsPerUsd) : '0'
);


const [createOrderDraftItems, setCreateOrderDraftItems] = useState<DraftItem[]>([]);
const [createOrderConfigOpen, setCreateOrderConfigOpen] = useState(false);
const [createOrderConfigProductId, setCreateOrderConfigProductId] = useState<number | null>(null);
const [createOrderConfigProductName, setCreateOrderConfigProductName] = useState('');
const [createOrderConfigSourcePriceCurrency, setCreateOrderConfigSourcePriceCurrency] = useState<'VES' | 'USD'>('VES');
const [createOrderConfigSourcePriceAmount, setCreateOrderConfigSourcePriceAmount] = useState(0);
const [createOrderConfigQty, setCreateOrderConfigQty] = useState(1);
const [createOrderConfigUnitPriceUsd, setCreateOrderConfigUnitPriceUsd] = useState(0);
const [createOrderConfigSku, setCreateOrderConfigSku] = useState<string | null>(null);
const [createOrderConfigLimit, setCreateOrderConfigLimit] = useState(0);
const [createOrderConfigSelections, setCreateOrderConfigSelections] = useState<DraftEditableSelection[]>([]);
const [createOrderConfigAlias, setCreateOrderConfigAlias] = useState('');
const [createOrderConfigEditingLocalId, setCreateOrderConfigEditingLocalId] = useState<string | null>(null);

const [createOrderDeliveryDate, setCreateOrderDeliveryDate] = useState('');
const [createOrderDeliveryHour12, setCreateOrderDeliveryHour12] = useState('');
const [createOrderDeliveryMinute, setCreateOrderDeliveryMinute] = useState('');
const [createOrderDeliveryAmPm, setCreateOrderDeliveryAmPm] = useState<'AM' | 'PM'>('AM');

const [createOrderReceiverIsDifferent, setCreateOrderReceiverIsDifferent] = useState(false);
const [createOrderReceiverName, setCreateOrderReceiverName] = useState('');
const [createOrderReceiverPhone, setCreateOrderReceiverPhone] = useState('');
const [createOrderDeliveryAddress, setCreateOrderDeliveryAddress] = useState('');
const [createOrderDeliveryGpsUrl, setCreateOrderDeliveryGpsUrl] = useState('');
const [createOrderNote, setCreateOrderNote] = useState('');

const [createOrderPaymentMethod, setCreateOrderPaymentMethod] = useState('payment_mobile');
const [createOrderPaymentCurrency, setCreateOrderPaymentCurrency] = useState<'USD' | 'VES'>('VES');
const [createOrderPaymentRequiresChange, setCreateOrderPaymentRequiresChange] = useState(false);
const [createOrderPaymentChangeFor, setCreateOrderPaymentChangeFor] = useState('');
const [createOrderPaymentChangeCurrency, setCreateOrderPaymentChangeCurrency] = useState<'USD' | 'VES'>('USD');
const [createOrderPaymentNote, setCreateOrderPaymentNote] = useState('');

const [cancelOrderBoxOpen, setCancelOrderBoxOpen] = useState(false);
const [cancelOrderReason, setCancelOrderReason] = useState('');

const [toast, setToast] = useState<ToastState>(null);

const [createOrderHasDeliveryNote, setCreateOrderHasDeliveryNote] = useState(false);
const [createOrderHasInvoice, setCreateOrderHasInvoice] = useState(false);
const [createOrderInvoiceDataNote, setCreateOrderInvoiceDataNote] = useState('');
const [createOrderInvoiceCompanyName, setCreateOrderInvoiceCompanyName] = useState('');
const [createOrderInvoiceTaxId, setCreateOrderInvoiceTaxId] = useState('');
const [createOrderInvoiceAddress, setCreateOrderInvoiceAddress] = useState('');
const [createOrderInvoicePhone, setCreateOrderInvoicePhone] = useState('');
const [createOrderDeliveryNoteName, setCreateOrderDeliveryNoteName] = useState('');
const [createOrderDeliveryNoteDocumentId, setCreateOrderDeliveryNoteDocumentId] = useState('');
const [createOrderDeliveryNoteAddress, setCreateOrderDeliveryNoteAddress] = useState('');
const [createOrderDeliveryNotePhone, setCreateOrderDeliveryNotePhone] = useState('');

const [kitchenTakeBoxOpen, setKitchenTakeBoxOpen] = useState(false);
const [kitchenEtaMinutes, setKitchenEtaMinutes] = useState('15');
const [deliveryEtaBoxOpen, setDeliveryEtaBoxOpen] = useState(false);
const [deliveryEtaMinutes, setDeliveryEtaMinutes] = useState('25');

const [returnToQueueBoxOpen, setReturnToQueueBoxOpen] = useState(false);
const [returnToQueueReason, setReturnToQueueReason] = useState('');

const [reviewActionMode, setReviewActionMode] = useState<
  null | 'approve' | 'reapprove' | 'return' | 'approve_changes' | 'reject_changes'
>(null);
const [reviewActionNotes, setReviewActionNotes] = useState('');


const [createOrderStatus, setCreateOrderStatus] = useState<'created' | 'queued'>('created');


  const [exchangeRateInput, setExchangeRateInput] = useState(
  activeExchangeRate ? String(activeExchangeRate.rateBsPerUsd) : ''
);
const [exchangeRateSaving, setExchangeRateSaving] = useState(false);

  const orders = initialOrders;

  const currentOperatorLabel = getCurrentOperatorLabel(roles, currentUser);

  useEffect(() => {
  if (createOrderPaymentMethod !== 'mixed') {
    setCreateOrderPaymentCurrency(getPaymentCurrencyByMethod(createOrderPaymentMethod));
  }
}, [createOrderPaymentMethod]);

  const selectedOrder = useMemo(() => orders.find((o) => o.id === selectedOrderId) ?? null, [orders, selectedOrderId]);

  const selectedCatalogItem = useMemo(
    () => catalogItems.find((x) => x.id === selectedCatalogItemId) ?? null,
    [catalogItems, selectedCatalogItemId]
  );

  const searchResults = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return [];
    return orders
      .filter((o) => String(o.id).includes(q) || o.clientName.toLowerCase().includes(q))
      .slice(0, 7)
      .map((o) => ({
        id: o.id,
        label: `${o.id} · ${o.clientName}`,
        sub: `Entrega: ${fmtDeliveryTextES(o.deliveryAtISO)}`,
      }));
  }, [orders, search]);

  const dayOrders = useMemo(() => {
    if (!selectedDay) return [];
    return orders.filter((o) => withinDay(o.deliveryAtISO, selectedDay));
  }, [orders, selectedDay]);

  const trayOrders = useMemo(() => dayOrders.filter((o) => matchesTray(o, tray)), [dayOrders, tray]);

  const tableOrders = useMemo(
    () => trayOrders
      .slice()
      .sort((a, b) => new Date(b.deliveryAtISO).getTime() - new Date(a.deliveryAtISO).getTime()),
    [trayOrders]
  );

  const weekOrders = useMemo(() => {
    if (!selectedDay) return [];
    return orders.filter((o) => withinWeek(o.deliveryAtISO, selectedDay));
  }, [orders, selectedDay]);

  const dayStats = useMemo(() => {
    const list = dayOrders;
    const cierres = list.length;
    const fact = list.reduce((s, o) => s + o.totalUsd, 0);
    const abonadoConfirmado = list.reduce((s, o) => s + o.confirmedPaidUsd, 0);
    const pendiente = list.reduce((s, o) => s + o.balanceUsd, 0);
    return { cierres, fact, abonadoConfirmado, pendiente };
  }, [dayOrders]);

  const weekStats = useMemo(() => {
    const list = weekOrders;
    const cierres = list.length;
    const fact = list.reduce((s, o) => s + o.totalUsd, 0);
    const abonadoConfirmado = list.reduce((s, o) => s + o.confirmedPaidUsd, 0);
    const pendiente = list.reduce((s, o) => s + o.balanceUsd, 0);
    return { cierres, fact, abonadoConfirmado, pendiente };
  }, [weekOrders]);

  const approvalsStats = useMemo(() => {
    const list = weekOrders;
    const porAprobar = list.filter((o) => o.status === 'created').length;
    const reaprobar = list.filter((o) => o.status === 'queued' && o.queuedNeedsReapproval).length;
    const listasCocina = list.filter((o) => o.status === 'queued' && !o.queuedNeedsReapproval).length;
    return { porAprobar, reaprobar, listasCocina };
  }, [weekOrders]);

  const paymentsStats = useMemo(() => {
    const list = weekOrders;
    const porConfirmar = list.filter((o) => o.paymentVerify === 'pending').length;
    const confirmados = list.filter((o) => o.paymentVerify === 'confirmed').length;
    const rechazados = list.filter((o) => o.paymentVerify === 'rejected').length;
    return { porConfirmar, confirmados, rechazados };
  }, [weekOrders]);

  const committedList = useMemo(() => computeCommittedUndByProduct(dayOrders), [dayOrders]);
  const top3 = committedList.slice(0, 3);
  const maxUnd = top3[0]?.und ?? 1;

  const [productsExpanded, setProductsExpanded] = useState(false);

  const notifications: MasterNotification[] = useMemo(() => {
    const out: MasterNotification[] = [];
    for (const o of orders) {
      const delText = fmtDeliveryTextES(o.deliveryAtISO);
      if (o.status === 'created') {
        out.push({
          id: `n-ap-${o.id}`,
          type: 'APROBAR',
          orderId: o.id,
          label: `${o.id} · ${o.clientName}`,
          deliveryText: `Entrega: ${delText}`,
          advisorName: o.advisorName,
        });
      }
      if (o.status === 'queued' && o.queuedNeedsReapproval) {
        out.push({
          id: `n-re-${o.id}`,
          type: 'RE-APROBAR',
          orderId: o.id,
          label: `${o.id} · ${o.clientName}`,
          deliveryText: `Entrega: ${delText}`,
          advisorName: o.advisorName,
        });
      }
      if (o.paymentVerify === 'pending') {
        out.push({
          id: `n-pay-${o.id}`,
          type: 'CONFIRMAR PAGO',
          orderId: o.id,
          label: `${o.id} · ${o.clientName}`,
          deliveryText: `Entrega: ${delText}`,
          advisorName: o.advisorName,
        });
      }
    }
    const pr = (t: NotificationType) => (t === 'RE-APROBAR' ? 0 : t === 'CONFIRMAR PAGO' ? 1 : 2);
    return out.sort((a, b) => pr(a.type) - pr(b.type));
  }, [orders]);

  const filteredCatalogItems = useMemo(() => {
    const q = catalogSearch.trim().toLowerCase();

    return catalogItems.filter((item) => {
      const matchesType = catalogTypeFilter === 'all' ? true : item.type === catalogTypeFilter;
      const matchesSearch =
        !q ||
        item.name.toLowerCase().includes(q) ||
        item.sku.toLowerCase().includes(q);

      return matchesType && matchesSearch;
    });
  }, [catalogItems, catalogSearch, catalogTypeFilter]);

  const catalogStats = useMemo(() => {
    return {
      total: catalogItems.length,
      active: catalogItems.filter((x) => x.isActive).length,
      products: catalogItems.filter((x) => x.type === 'product').length,
      combos: catalogItems.filter((x) => x.type === 'combo').length,
      services: catalogItems.filter((x) => x.type === 'service').length,
      promos: catalogItems.filter((x) => x.type === 'promo').length,
      gambits: catalogItems.filter((x) => x.type === 'gambit').length,
    };
  }, [catalogItems]);

const createOrderConfigSelectableOptions = useMemo(() => {
  if (!createOrderConfigProductId) return [];

  return productComponents
    .filter(
      (pc) =>
        pc.parentProductId === createOrderConfigProductId &&
        pc.componentMode === 'selectable'
    )
    .map((pc) => ({
      id: pc.componentProductId,
      name: pc.componentName,
      sku: pc.componentSku,
      qty: 0,
    }));
}, [createOrderConfigProductId, productComponents]);

  const componentsByParentId = useMemo(() => {
    const map = new Map<number, ProductComponent[]>();
    for (const pc of productComponents) {
      const arr = map.get(pc.parentProductId) ?? [];
      arr.push(pc);
      map.set(pc.parentProductId, arr);
    }
    for (const [key, arr] of map.entries()) {
      arr.sort((a, b) => a.sortOrder - b.sortOrder || a.componentName.localeCompare(b.componentName));
      map.set(key, arr);
    }
    return map;
  }, [productComponents]);

  const selectedCatalogComponents = useMemo(
    () => (selectedCatalogItem ? componentsByParentId.get(selectedCatalogItem.id) ?? [] : []),
    [selectedCatalogItem, componentsByParentId]
  );

  const selectedFixedComponents = useMemo(
    () => selectedCatalogComponents.filter((x) => x.componentMode === 'fixed'),
    [selectedCatalogComponents]
  );

  const selectedSelectableComponents = useMemo(
    () => selectedCatalogComponents.filter((x) => x.componentMode === 'selectable'),
    [selectedCatalogComponents]
  );

  const createOrderSelectedCatalogItem =
  createOrderSelectedProductId === ''
    ? null
    : catalogItems.find((item) => item.id === createOrderSelectedProductId) ?? null;

const createOrderSelectedProductIsEditable = !!createOrderSelectedCatalogItem?.isDetailEditable;

    const editFixedComponents = useMemo(
    () => editComponents.filter((x) => x.componentMode === 'fixed'),
    [editComponents]
  );

  const editSelectableComponents = useMemo(
    () => editComponents.filter((x) => x.componentMode === 'selectable'),
    [editComponents]
  );

  const selectedOperationalModel = useMemo(
    () => getCatalogOperationalModel(selectedCatalogItem, selectedCatalogComponents),
    [selectedCatalogItem, selectedCatalogComponents]
  );

  const editOperationalModel = useMemo(
    () =>
      getCatalogOperationalModel(selectedCatalogItem, editComponents.map((x) => ({
        componentMode: x.componentMode,
        quantity: x.quantity,
        countsTowardDetailLimit: x.countsTowardDetailLimit,
      }))),
    [selectedCatalogItem, editComponents]
  );

  const editSelectableUnitsCount = useMemo(
    () => sumComponentUnits(editSelectableComponents),
    [editSelectableComponents]
  );

  const editFixedUnitsCount = useMemo(
    () => sumComponentUnits(editFixedComponents),
    [editFixedComponents]
  );

  useEffect(() => {
    if (!selectedCatalogItem) return;

    setEditIsActive(selectedCatalogItem.isActive);
    setEditSourcePriceCurrency(selectedCatalogItem.sourcePriceCurrency);
    setEditSourcePriceAmount(String(selectedCatalogItem.sourcePriceAmount));
    setEditUnitsPerService(String(selectedCatalogItem.unitsPerService));
    setEditIsDetailEditable(selectedCatalogItem.isDetailEditable);
    setEditDetailUnitsLimit(String(selectedCatalogItem.detailUnitsLimit));
    setEditIsInventoryItem(selectedCatalogItem.isInventoryItem);
    setEditIsTemporary(selectedCatalogItem.isTemporary);
    setEditIsComboComponentSelectable(selectedCatalogItem.isComboComponentSelectable);
    setEditCommissionMode(selectedCatalogItem.commissionMode);
    setEditCommissionValue(
      selectedCatalogItem.commissionValue == null ? '' : String(selectedCatalogItem.commissionValue)
    );
    setEditCommissionNotes(selectedCatalogItem.commissionNotes || '');

    setEditComponents(
      selectedCatalogComponents.map((pc, idx) => ({
        localId: `${pc.id}-${idx}`,
        componentProductId: pc.componentProductId,
        componentMode: pc.componentMode,
        quantity: pc.quantity,
        countsTowardDetailLimit: pc.countsTowardDetailLimit,
        isRequired: pc.isRequired,
        sortOrder: pc.sortOrder,
        notes: pc.notes ?? '',
      }))
    );
  }, [selectedCatalogItem, selectedCatalogComponents]);

  const selectableComponentOptions = useMemo(
    () =>
      catalogItems
        .filter((item) => item.isActive)
        .map((item) => ({
          id: item.id,
          label: item.name,
          sku: item.sku,
        })),
    [catalogItems]
  );

const openOrderPanel = (orderId: number, tab?: typeof detailTab) => {
  setSelectedOrderId(orderId);
  setDetailTab(tab ?? 'detalle');
  resetDeliveryAssignBox();
  resetPaymentReportBox();
  resetReviewActionBox();
  resetKitchenTakeBox();
  resetCancelOrderBox();
  resetReturnToQueueBox();
  setDetailOpen(true);
};

const openCreateOrderDrawer = () => {
  setOrderEditorMode('create');
  setEditingOrderId(null);
  setCreateOrderOpen(true);
};

const loadOrderIntoCreateForm = (order: Order) => {
  const deliveryFields = splitISOToDeliveryFields(order.deliveryAtISO);

  setCreateOrderSource(order.source);
  setCreateOrderAdvisorUserId(order.attributedAdvisorUserId ?? '');
  setCreateOrderFulfillment(order.fulfillment);

  setCreateOrderClientSearch('');
  setCreateOrderClientResults([]);
  setCreateOrderClientSearchLoading(false);

  setCreateOrderSelectedClientId(order.clientId ?? null);
  setCreateOrderSelectedClientName(order.clientName || '');
  setCreateOrderSelectedClientPhone('');
  setCreateOrderSelectedClientType(null);

  setCreateOrderNewClientMode(false);
  setCreateOrderNewClientName('');
  setCreateOrderNewClientPhone('');
  setCreateOrderNewClientType('assigned');

  setCreateOrderProductSearch('');
  setCreateOrderProductActiveIndex(-1);
  setCreateOrderSelectedProductId('');
  setCreateOrderQty(1);

  setCreateOrderDraftItems(order.draftItems ?? []);

  setCreateOrderDeliveryDate(deliveryFields.date);
  setCreateOrderDeliveryHour12(deliveryFields.hour12);
  setCreateOrderDeliveryMinute(deliveryFields.minute);
  setCreateOrderDeliveryAmPm(deliveryFields.ampm);

  const receiverName = order.editMeta?.receiverName?.trim() ?? '';
  const receiverPhone = order.editMeta?.receiverPhone?.trim() ?? '';
  const hasDifferentReceiver = !!receiverName || !!receiverPhone;

  setCreateOrderReceiverIsDifferent(hasDifferentReceiver);
  setCreateOrderReceiverName(receiverName);
  setCreateOrderReceiverPhone(receiverPhone);

  setCreateOrderDeliveryAddress(order.address ?? '');
  setCreateOrderDeliveryGpsUrl(order.editMeta?.deliveryGpsUrl ?? '');
  setCreateOrderNote(order.notes ?? '');

  setCreateOrderPaymentMethod(order.editMeta?.paymentMethod ?? 'payment_mobile');
  setCreateOrderPaymentCurrency(order.editMeta?.paymentCurrency ?? 'VES');
  setCreateOrderPaymentRequiresChange(Boolean(order.editMeta?.paymentRequiresChange));
  setCreateOrderPaymentChangeFor(order.editMeta?.paymentChangeFor ?? '');
  setCreateOrderPaymentChangeCurrency(order.editMeta?.paymentChangeCurrency ?? 'USD');
  setCreateOrderPaymentNote(order.editMeta?.paymentNote ?? '');

  setCreateOrderHasDeliveryNote(Boolean(order.editMeta?.hasDeliveryNote));
  setCreateOrderHasInvoice(Boolean(order.editMeta?.hasInvoice));
  setCreateOrderInvoiceCompanyName(order.editMeta?.invoiceSnapshot?.companyName ?? '');
  setCreateOrderInvoiceTaxId(order.editMeta?.invoiceSnapshot?.taxId ?? '');
  setCreateOrderInvoiceAddress(order.editMeta?.invoiceSnapshot?.address ?? '');
  setCreateOrderInvoicePhone(order.editMeta?.invoiceSnapshot?.phone ?? '');
  setCreateOrderDeliveryNoteName(order.editMeta?.deliveryNoteSnapshot?.name ?? '');
  setCreateOrderDeliveryNoteDocumentId(order.editMeta?.deliveryNoteSnapshot?.documentId ?? '');
  setCreateOrderDeliveryNoteAddress(order.editMeta?.deliveryNoteSnapshot?.address ?? '');
  setCreateOrderDeliveryNotePhone(order.editMeta?.deliveryNoteSnapshot?.phone ?? '');
  setCreateOrderInvoiceDataNote(
    order.editMeta?.invoiceDataNote ??
      [
        order.editMeta?.invoiceSnapshot?.companyName,
        order.editMeta?.invoiceSnapshot?.taxId,
        order.editMeta?.invoiceSnapshot?.address,
        order.editMeta?.invoiceSnapshot?.phone,
      ]
        .filter(Boolean)
        .join(' | ')
  );

  setCreateOrderDiscountEnabled(Boolean(order.editMeta?.discountEnabled));
  setCreateOrderDiscountPct(
    order.editMeta?.discountPct != null ? String(order.editMeta.discountPct) : '0'
  );
  setCreateOrderInvoiceTaxPct(
    order.editMeta?.invoiceTaxPct != null ? String(order.editMeta.invoiceTaxPct) : '16'
  );

  setCreateOrderFxRate(
    order.editMeta?.fxRate != null
      ? String(order.editMeta.fxRate)
      : activeExchangeRate
        ? String(activeExchangeRate.rateBsPerUsd)
        : '0'
  );
};

const openEditOrderDrawer = (order: Order) => {
  setDetailOpen(false);
  setOrderEditorMode('edit');
  setEditingOrderId(order.id);
  loadOrderIntoCreateForm(order);
  setCreateOrderOpen(true);
};

const showToast = (type: 'success' | 'error', message: string) => {
  setToast({ type, message });
};

const handleCopyOrderWhatsApp = async (order: Order) => {
  try {
    const text = buildWhatsAppOrderSummary(order);
    await navigator.clipboard.writeText(text);
    showToast('success', 'Resumen copiado para WhatsApp.');
  } catch (err) {
    showToast('error', 'No se pudo copiar el resumen.');
  }
};

const openCatalogDetail = (productId: number) => {
  setSelectedCatalogItemId(productId);
  setCatalogEditMode(false);
  setCatalogDetailOpen(true);
};

const closeCatalogDetail = () => {
  setCatalogDetailOpen(false);
  setCatalogEditMode(false);
};

const onRowClick = (orderId: number) => openOrderPanel(orderId, 'detalle');

const handleLogout = async () => {
  try {
    await logoutAction();
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Error cerrando sesión.';
    showToast('error', message);
  }
};

const resetDeliveryAssignBox = () => {
  setDeliveryAssignMode(null);
  setDeliveryAssignDriverId('');
  setDeliveryAssignPartnerId('');
  setDeliveryAssignReference('');
};

const resetPaymentReportBox = () => {
  setPaymentReportBoxOpen(false);
  setPaymentReportMoneyAccountId('');
  setPaymentReportAmount('');
  setPaymentReportExchangeRate('');
  setPaymentReportReferenceCode('');
  setPaymentReportPayerName('');
  setPaymentReportNotes('');
};

const resetReviewActionBox = () => {
  setReviewActionMode(null);
  setReviewActionNotes('');
};

const resetKitchenTakeBox = () => {
  setKitchenTakeBoxOpen(false);
  setKitchenEtaMinutes('15');
};

const resetDeliveryEtaBox = () => {
  setDeliveryEtaBoxOpen(false);
  setDeliveryEtaMinutes('25');
};

const resetCancelOrderBox = () => {
  setCancelOrderBoxOpen(false);
  setCancelOrderReason('');
};

const resetReturnToQueueBox = () => {
  setReturnToQueueBoxOpen(false);
  setReturnToQueueReason('');
};

const handleSendToKitchen = async (orderId: number) => {
  try {
    await sendToKitchenAction({ orderId });
    showToast('success', 'Enviado a cocina.');
    router.refresh();
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Error enviando a cocina.';
    showToast('error', message);
  }
};

const createOrderConfigSelectedUnits = useMemo(() => {
  return createOrderConfigSelections.reduce((sum, item) => sum + Number(item.qty || 0), 0);
}, [createOrderConfigSelections]);

const handleAssignInternal = async (o: Order) => {
  try {
    if (!deliveryAssignDriverId) {
      showToast('error', 'Debes seleccionar un driver interno.');
      return;
    }

    await assignInternalDriverAction({
      orderId: o.id,
      driverUserId: deliveryAssignDriverId,
    });

    showToast('success', 'Driver interno asignado.');
    resetDeliveryAssignBox();
    router.refresh();
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Error asignando driver interno.';
    showToast('error', message);
  }
};

const handleAssignExternal = async (o: Order) => {
  try {
    if (!deliveryAssignPartnerId) {
      showToast('error', 'Debes seleccionar un partner externo.');
      return;
    }

    await assignExternalPartnerAction({
      orderId: o.id,
      partnerId: Number(deliveryAssignPartnerId),
      reference: deliveryAssignReference.trim() || null,
    });

    showToast('success', 'Partner externo asignado.');
    resetDeliveryAssignBox();
    router.refresh();
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Error asignando partner externo.';
    showToast('error', message);
  }
};

const handleApprove = async (o: Order) => {
  try {
    if (o.status === 'created') {
      await approveOrderAction({ orderId: o.id });
      showToast('success', 'Pedido aprobado.');
      resetReviewActionBox();
      router.refresh();
      return;
    }

    if (o.status === 'queued' && o.queuedNeedsReapproval) {
      await reapproveQueuedOrderAction({
        orderId: o.id,
        notes: reviewActionNotes.trim(),
      });
      showToast('success', 'Pedido re-aprobado.');
      resetReviewActionBox();
      router.refresh();
      return;
    }

    showToast('error', 'Esta orden no requiere aprobación.');
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Error aprobando la orden.';
    showToast('error', message);
  }
};

const handleReturn = async (o: Order) => {
  try {
    if (!reviewActionNotes.trim()) {
      showToast('error', 'Motivo obligatorio.');
      return;
    }

    await returnToCreatedAction({
      orderId: o.id,
      reason: reviewActionNotes.trim(),
    });

    showToast('success', 'Pedido devuelto a revisión.');
    resetReviewActionBox();
    router.refresh();
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Error devolviendo la orden.';
    showToast('error', message);
  }
};

const handleCreatePaymentReport = async (o: Order) => {
  try {
    if (o.balanceUsd <= 0.01) {
      showToast('error', 'Esta orden ya no tiene saldo pendiente.');
      return;
    }

    if (!paymentReportMoneyAccountId) {
      showToast('error', 'Debes seleccionar una cuenta.');
      return;
    }

    const selectedAccount = moneyAccounts.find(
      (a) => a.id === Number(paymentReportMoneyAccountId)
    );

    if (!selectedAccount) {
      showToast('error', 'Cuenta inválida.');
      return;
    }

    const reportedAmount = Number(paymentReportAmount || 0);
    if (!Number.isFinite(reportedAmount) || reportedAmount <= 0) {
      showToast('error', 'Monto inválido.');
      return;
    }

    let exchangeRate: number | null = null;

    if (selectedAccount.currencyCode === 'VES') {
      exchangeRate = Number(paymentReportExchangeRate || 0);
      if (!Number.isFinite(exchangeRate) || exchangeRate <= 0) {
        showToast('error', 'Debes indicar una tasa válida para pagos en VES.');
        return;
      }
    }

    await createPaymentReportAction({
      orderId: o.id,
      reportedMoneyAccountId: selectedAccount.id,
      reportedCurrency: selectedAccount.currencyCode,
      reportedAmount,
      reportedExchangeRateVesPerUsd: exchangeRate,
      referenceCode: paymentReportReferenceCode.trim() || null,
      payerName: paymentReportPayerName.trim() || null,
      notes: paymentReportNotes.trim() || null,
    });

    showToast('success', 'Pago reportado.');
    resetPaymentReportBox();
    router.refresh();
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Error reportando el pago.';
    showToast('error', message);
  }
};

const handleConfirmPayment = async (o: Order, rp: PaymentReportItem) => {
  try {
    const reviewNotes = window.prompt('Notas de confirmación (opcional):', '') ?? '';
    const today = new Date().toISOString().slice(0, 10);

    await confirmPaymentReportAction({
      reportId: rp.id,
      confirmedMoneyAccountId: rp.moneyAccountId,
      confirmedCurrency: rp.currencyCode,
      confirmedAmount: rp.amount,
      movementDate: today,
      confirmedExchangeRateVesPerUsd: rp.exchangeRate ?? null,
      reviewNotes,
      referenceCode: rp.referenceCode ?? null,
      counterpartyName: rp.payerName ?? null,
      description: `Pago confirmado desde Master Dashboard · orden ${o.id} · reporte ${rp.id}`,
    });

    showToast('success', 'Pago confirmado.');
    router.refresh();
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Error confirmando el pago.';
    showToast('error', message);
  }
};

const handleRejectPayment = async (rp: PaymentReportItem) => {
  try {
    const reviewNotes = window.prompt('Motivo del rechazo (obligatorio):', '') ?? '';
    if (!reviewNotes.trim()) {
      showToast('error', 'Debes indicar un motivo de rechazo.');
      return;
    }

    await rejectPaymentReportAction({
      reportId: rp.id,
      reviewNotes,
    });

    showToast('success', 'Pago rechazado.');
    router.refresh();
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Error rechazando el pago.';
    showToast('error', message);
  }
};

const handleReviewChanges = async (o: Order, approved: boolean) => {
  try {
    if (!approved && !reviewActionNotes.trim()) {
      showToast('error', 'Debes indicar una nota para rechazar cambios.');
      return;
    }

    await reviewOrderChangesAction({
      orderId: o.id,
      approved,
      notes: reviewActionNotes.trim(),
    });

    showToast('success', approved ? 'Cambios aprobados.' : 'Cambios rechazados.');
    resetReviewActionBox();
    router.refresh();
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Error revisando cambios.';
    showToast('error', message);
  }
};

const handleKitchenTake = async (o: Order) => {
  try {
    const etaMinutes = Number(kitchenEtaMinutes || 0);

    if (!Number.isFinite(etaMinutes) || etaMinutes <= 0) {
      showToast('error', 'ETA inválido.');
      return;
    }

    await kitchenTakeAction({
      orderId: o.id,
      etaMinutes,
    });

    showToast('success', 'Pedido tomado por cocina.');
    resetKitchenTakeBox();
    router.refresh();
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Error tomando pedido en cocina.';
    showToast('error', message);
  }
};

const handleMarkReady = async (o: Order) => {
  try {
    await markReadyAction({
      orderId: o.id,
    });

    showToast('success', 'Pedido marcado como preparado.');
    router.refresh();
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Error marcando como preparado.';
    showToast('error', message);
  }
};

const handleOutForDelivery = async (o: Order) => {
  try {
    const etaMinutes =
      o.fulfillment === 'delivery' ? Number(deliveryEtaMinutes || 0) : null;

    if (
      o.fulfillment === 'delivery' &&
      (!Number.isFinite(etaMinutes) || etaMinutes == null || etaMinutes <= 0)
    ) {
      showToast('error', 'Tiempo estimado inválido.');
      return;
    }

    await outForDeliveryAction({
      orderId: o.id,
      etaMinutes,
    });

    showToast('success', 'Pedido marcado en camino.');
    resetDeliveryEtaBox();
    router.refresh();
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Error enviando a delivery.';
    showToast('error', message);
  }
};

const openDeliveryEtaBox = (o: Order) => {
  if (o.fulfillment === 'pickup') {
    void handleOutForDelivery(o);
    return;
  }

  const suggestedEta =
    o.editMeta?.deliveryEtaMinutes != null && o.editMeta.deliveryEtaMinutes > 0
      ? String(o.editMeta.deliveryEtaMinutes)
      : o.externalPartner
        ? '35'
        : '25';

  setDeliveryEtaMinutes(suggestedEta);
  setDeliveryEtaBoxOpen(true);
};

const handleMarkDelivered = async (o: Order) => {
  try {
    await markDeliveredAction({
      orderId: o.id,
    });

    showToast(
      'success',
      o.fulfillment === 'pickup' ? 'Pedido retirado.' : 'Pedido entregado.'
    );
    router.refresh();
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Error marcando entregado.';
    showToast('error', message);
  }
};

const handleReturnFromKitchenToQueue = async (o: Order) => {
  try {
    if (!returnToQueueReason.trim()) {
      showToast('error', 'Debes indicar un motivo.');
      return;
    }

    await returnFromKitchenToQueueAction({
      orderId: o.id,
      reason: returnToQueueReason.trim(),
    });

    showToast('success', 'Orden regresada a cola.');
    resetReturnToQueueBox();
    router.refresh();
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Error regresando la orden a cola.';
    showToast('error', message);
  }
};

const handleCancelOrder = async (o: Order) => {
  try {
    if (!cancelOrderReason.trim()) {
      showToast('error', 'Debes indicar un motivo.');
      return;
    }

    await cancelOrderAction({
      orderId: o.id,
      reason: cancelOrderReason.trim(),
    });

    showToast('success', 'Orden cancelada.');
    resetCancelOrderBox();
    setDetailOpen(false);
    router.refresh();
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Error cancelando la orden.';
    showToast('error', message);
  }
};


const handleClearDeliveryAssignment = async (o: Order) => {
  try {
    const notes =
      window.prompt('Motivo para quitar la asignación (opcional):', '') ?? '';

    await clearDeliveryAssignmentAction({
      orderId: o.id,
      notes,
    });

    showToast('success', 'Asignación de delivery quitada.');
    router.refresh();
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Error quitando la asignación.';
    showToast('error', message);
  }
};

const handleSaveCatalog = async () => {
  if (!selectedCatalogItem) return;

  const validationError = validateCatalogBeforeSave({
    item: selectedCatalogItem,
    editIsDetailEditable,
    editDetailUnitsLimit,
    editComponents,
  });

  if (validationError) {
    showToast('error', validationError);
    return;
  }

  try {
    setCatalogSaving(true);
    const normalizedSourcePriceAmount = Number(
      String(editSourcePriceAmount || '').trim().replace(',', '.')
    );

    if (!Number.isFinite(normalizedSourcePriceAmount) || normalizedSourcePriceAmount < 0) {
      showToast('error', 'El monto fuente no es válido.');
      return;
    }

    await updateCatalogItemAction({
      productId: selectedCatalogItem.id,
      sourcePriceAmount: normalizedSourcePriceAmount,
      sourcePriceCurrency: editSourcePriceCurrency,
      isActive: editIsActive,
      unitsPerService: Number(editUnitsPerService || 0),
      isDetailEditable: editIsDetailEditable,
      detailUnitsLimit: Number(editDetailUnitsLimit || 0),
      isInventoryItem: editIsInventoryItem,
      isTemporary: editIsTemporary,
      isComboComponentSelectable: editIsComboComponentSelectable,
      commissionMode: editCommissionMode,
      commissionValue:
        editCommissionMode === 'default'
          ? null
          : editCommissionValue.trim()
            ? Number(String(editCommissionValue).trim().replace(',', '.'))
            : null,
      commissionNotes: editCommissionNotes.trim() || null,
      components: editComponents.map((row, idx) => ({
        componentProductId: Number(row.componentProductId),
        componentMode: row.componentMode,
        quantity: row.componentMode === 'selectable' ? 1 : Number(row.quantity || 0),
        countsTowardDetailLimit:
          row.componentMode === 'selectable' ? true : !!row.countsTowardDetailLimit,
        isRequired: !!row.isRequired,
        sortOrder: Number(row.sortOrder || idx + 1),
        notes: row.notes?.trim() || null,
      })),
    });

    showToast('success', 'Catálogo actualizado.');
    setCatalogEditMode(false);
    router.refresh();
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Error guardando catálogo.';
    showToast('error', message);
  } finally {
    setCatalogSaving(false);
  }
};

const openQuickCatalog = () => {
  setQuickCatalogRows(
    filteredCatalogItems.map((item) => ({
      productId: item.id,
      name: item.name,
      sku: item.sku,
      sourcePriceCurrency: item.sourcePriceCurrency,
      originalAmount: String(item.sourcePriceAmount ?? 0),
      nextAmount: String(item.sourcePriceAmount ?? 0),
    }))
  );
  setQuickCatalogOpen(true);
};

const handleQuickCatalogRowChange = (productId: number, value: string) => {
  setQuickCatalogRows((prev) =>
    prev.map((row) => (row.productId === productId ? { ...row, nextAmount: value } : row))
  );
};

const handleSaveQuickCatalog = async () => {
  try {
    const changedItems = quickCatalogRows
      .map((row) => {
        const normalized = Number(String(row.nextAmount || '').replace(',', '.'));
        const original = Number(String(row.originalAmount || '').replace(',', '.'));

        return {
          productId: row.productId,
          normalized,
          original,
        };
      })
      .filter(
        (row) =>
          Number.isFinite(row.normalized) &&
          row.normalized >= 0 &&
          Math.abs(row.normalized - row.original) > 0.000001
      )
      .map((row) => ({
        productId: row.productId,
        sourcePriceAmount: row.normalized,
      }));

    if (changedItems.length === 0) {
      showToast('error', 'No hay cambios de precio para guardar.');
      return;
    }

    setQuickCatalogSaving(true);
    await updateCatalogPricesQuickAction({
      items: changedItems,
    });
    showToast('success', `Catálogo actualizado por bloque (${changedItems.length}).`);
    setQuickCatalogOpen(false);
    router.refresh();
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Error actualizando precios rápidos.';
    showToast('error', message);
  } finally {
    setQuickCatalogSaving(false);
  }
};

  const handleUpdateExchangeRate = async () => {
  try {
    const normalizedRate = String(exchangeRateInput || '').trim().replace(',', '.');
    const rate = Number(normalizedRate || 0);

    if (!Number.isFinite(rate) || rate <= 0) {
      showToast('error', 'La tasa debe ser mayor a 0.');
      return;
    }

    setExchangeRateSaving(true);
    await updateExchangeRateAction({
      rateBsPerUsd: rate,
    });

    showToast('success', 'Tasa actualizada.');
    router.refresh();
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Error actualizando la tasa.';
    showToast('error', message);
    } finally {
      setExchangeRateSaving(false);
    }
  };

  const resetAccountForm = () => {
    setAccountFormName('');
    setAccountFormCurrencyCode('VES');
    setAccountFormKind('bank');
    setAccountFormInstitutionName('');
    setAccountFormOwnerName('');
    setAccountFormNotes('');
    setAccountFormIsActive(true);
  };

  const openCreateAccount = () => {
    resetAccountForm();
    setAccountCreateOpen(true);
  };

  const openEditAccount = (account: MoneyAccountOption) => {
    setSelectedAccountId(account.id);
    setAccountFormName(account.name);
    setAccountFormCurrencyCode(account.currencyCode);
    setAccountFormKind(account.accountKind);
    setAccountFormInstitutionName(account.institutionName);
    setAccountFormOwnerName(account.ownerName);
    setAccountFormNotes(account.notes);
    setAccountFormIsActive(account.isActive);
    setAccountEditOpen(true);
  };

  const handleCreateMoneyAccount = async () => {
    try {
      setAccountSaving(true);
      await createMoneyAccountAction({
        name: accountFormName,
        currencyCode: accountFormCurrencyCode,
        accountKind: accountFormKind,
        institutionName: accountFormInstitutionName,
        ownerName: accountFormOwnerName,
        notes: accountFormNotes,
        isActive: accountFormIsActive,
      });
      showToast('success', 'Cuenta creada.');
      setAccountCreateOpen(false);
      resetAccountForm();
      router.refresh();
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'No se pudo crear la cuenta.');
    } finally {
      setAccountSaving(false);
    }
  };

  const handleUpdateMoneyAccount = async () => {
    if (!selectedAccount) return;

    try {
      setAccountSaving(true);
      await updateMoneyAccountAction({
        accountId: selectedAccount.id,
        name: accountFormName,
        currencyCode: accountFormCurrencyCode,
        accountKind: accountFormKind,
        institutionName: accountFormInstitutionName,
        ownerName: accountFormOwnerName,
        notes: accountFormNotes,
        isActive: accountFormIsActive,
      });
      showToast('success', 'Cuenta actualizada.');
      setAccountEditOpen(false);
      router.refresh();
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'No se pudo actualizar la cuenta.');
    } finally {
      setAccountSaving(false);
    }
  };

  const handleToggleMoneyAccountActive = async (account: MoneyAccountOption) => {
    try {
      await toggleMoneyAccountActiveAction({
        accountId: account.id,
        nextIsActive: !account.isActive,
      });
      showToast('success', account.isActive ? 'Cuenta desactivada.' : 'Cuenta activada.');
      router.refresh();
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'No se pudo cambiar el estado.');
    }
  };

  const resetClientForm = () => {
    setClientFormFullName('');
    setClientFormPhone('');
    setClientFormNotes('');
    setClientFormPrimaryAdvisorId('');
    setClientFormType('');
    setClientFormIsActive(true);
    setClientFormBirthDate('');
    setClientFormImportantDate('');
    setClientFormTagsInput('');
    setClientFormBillingCompanyName('');
    setClientFormBillingTaxId('');
    setClientFormBillingAddress('');
    setClientFormBillingPhone('');
    setClientFormDeliveryNoteName('');
    setClientFormDeliveryNoteDocumentId('');
    setClientFormDeliveryNoteAddress('');
    setClientFormDeliveryNotePhone('');
    setClientFormAddress1Text('');
    setClientFormAddress1Gps('');
    setClientFormAddress2Text('');
    setClientFormAddress2Gps('');
  };

  const openCreateClient = () => {
    resetClientForm();
    setClientCreateOpen(true);
  };

  const openEditClient = (client: ClientItem) => {
    const addresses = normalizeClientAddresses(client.recentAddresses);
    setSelectedClientId(client.id);
    setClientFormFullName(client.fullName);
    setClientFormPhone(client.phone);
    setClientFormNotes(client.notes);
    setClientFormPrimaryAdvisorId(client.primaryAdvisorId ?? '');
    setClientFormType(client.clientType);
    setClientFormIsActive(client.isActive);
    setClientFormBirthDate(client.birthDate);
    setClientFormImportantDate(client.importantDate);
    setClientFormTagsInput(tagsToInputValue(normalizeClientTags(client.crmTags)));
    setClientFormBillingCompanyName(client.billingCompanyName);
    setClientFormBillingTaxId(client.billingTaxId);
    setClientFormBillingAddress(client.billingAddress);
    setClientFormBillingPhone(client.billingPhone);
    setClientFormDeliveryNoteName(client.deliveryNoteName);
    setClientFormDeliveryNoteDocumentId(client.deliveryNoteDocumentId);
    setClientFormDeliveryNoteAddress(client.deliveryNoteAddress);
    setClientFormDeliveryNotePhone(client.deliveryNotePhone);
    setClientFormAddress1Text(addresses[0]?.addressText ?? '');
    setClientFormAddress1Gps(addresses[0]?.gpsUrl ?? '');
    setClientFormAddress2Text(addresses[1]?.addressText ?? '');
    setClientFormAddress2Gps(addresses[1]?.gpsUrl ?? '');
    setClientEditOpen(true);
  };

  const buildClientPayload = () => ({
    fullName: clientFormFullName,
    phone: clientFormPhone,
    notes: clientFormNotes,
    primaryAdvisorId: clientFormPrimaryAdvisorId || null,
    clientType: clientFormType,
    isActive: clientFormIsActive,
    birthDate: clientFormBirthDate,
    importantDate: clientFormImportantDate,
    billingCompanyName: clientFormBillingCompanyName,
    billingTaxId: clientFormBillingTaxId,
    billingAddress: clientFormBillingAddress,
    billingPhone: clientFormBillingPhone,
    deliveryNoteName: clientFormDeliveryNoteName,
    deliveryNoteDocumentId: clientFormDeliveryNoteDocumentId,
    deliveryNoteAddress: clientFormDeliveryNoteAddress,
    deliveryNotePhone: clientFormDeliveryNotePhone,
    recentAddresses: [
      { addressText: clientFormAddress1Text, gpsUrl: clientFormAddress1Gps },
      { addressText: clientFormAddress2Text, gpsUrl: clientFormAddress2Gps },
    ],
    crmTags: parseTagsInput(clientFormTagsInput),
  });

  const handleCreateClient = async () => {
    try {
      setClientSaving(true);
      await createClientAction(buildClientPayload());
      showToast('success', 'Cliente creado.');
      setClientCreateOpen(false);
      resetClientForm();
      router.refresh();
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'No se pudo crear el cliente.');
    } finally {
      setClientSaving(false);
    }
  };

  const handleUpdateClient = async () => {
    if (!selectedClient) return;

    try {
      setClientSaving(true);
      await updateClientAction({
        clientId: selectedClient.id,
        ...buildClientPayload(),
      });
      showToast('success', 'Cliente actualizado.');
      setClientEditOpen(false);
      router.refresh();
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'No se pudo actualizar el cliente.');
    } finally {
      setClientSaving(false);
    }
  };

  const handleToggleClientActive = async (client: ClientItem) => {
    try {
      await toggleClientActiveAction({
        clientId: client.id,
        nextIsActive: !client.isActive,
      });
      showToast('success', client.isActive ? 'Cliente desactivado.' : 'Cliente activado.');
      router.refresh();
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'No se pudo cambiar el estado del cliente.');
    }
  };

const resetCreateCatalogForm = () => {
  setNewSku('');
  setNewName('');
  setNewType('product');
  setNewSourcePriceAmount('0');
  setNewSourcePriceCurrency('VES');
  setNewUnitsPerService('0');
  setNewIsActive(true);
  setNewIsDetailEditable(false);
  setNewDetailUnitsLimit('0');
  setNewIsInventoryItem(true);
  setNewIsTemporary(false);
  setNewIsComboComponentSelectable(false);
  setNewCommissionMode('default');
  setNewCommissionValue('');
  setNewCommissionNotes('');
};

const handleCreateCatalogItem = async () => {
  try {
    setCreateCatalogSaving(true);

    const result = await createCatalogItemAction({
      sku: newSku,
      name: newName,
      type: newType,
      sourcePriceAmount: Number(String(newSourcePriceAmount).trim().replace(',', '.')),
      sourcePriceCurrency: newSourcePriceCurrency,
      unitsPerService: Number(newUnitsPerService || 0),
      isActive: newIsActive,
      isDetailEditable: newIsDetailEditable,
      detailUnitsLimit: Number(newDetailUnitsLimit || 0),
      isInventoryItem: newIsInventoryItem,
      isTemporary: newIsTemporary,
      isComboComponentSelectable: newIsComboComponentSelectable,
      commissionMode: newCommissionMode,
      commissionValue:
        newCommissionMode === 'default'
          ? null
          : newCommissionValue.trim()
            ? Number(String(newCommissionValue).trim().replace(',', '.'))
            : null,
      commissionNotes: newCommissionNotes.trim() || null,
    });

    showToast('success', 'Ítem creado.');
    setCreateCatalogOpen(false);
    resetCreateCatalogForm();
    router.refresh();

    if (result?.id) {
      setSelectedCatalogItemId(result.id);
      setCatalogDetailOpen(true);
      setCatalogEditMode(true);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Error creando ítem.';
    showToast('error', message);
  } finally {
    setCreateCatalogSaving(false);
  }
};

const handleToggleCatalogItemActive = async () => {
  if (!selectedCatalogItem) return;

  try {
    const nextIsActive = !selectedCatalogItem.isActive;

    await toggleCatalogItemActiveAction({
      productId: selectedCatalogItem.id,
      nextIsActive,
    });

    showToast('success', nextIsActive ? 'Ítem activado.' : 'Ítem desactivado.');
    router.refresh();
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Error cambiando estado del ítem.';
    showToast('error', message);
  }
};

const handleDeleteCatalogItem = async () => {
  if (!selectedCatalogItem) return;

  const confirmed = window.confirm(
    `¿Seguro que deseas eliminar "${selectedCatalogItem.name}"?\n\nEsto solo funcionará si no tiene uso ni dependencias.`
  );

  if (!confirmed) return;

  try {
    await deleteCatalogItemAction({
      productId: selectedCatalogItem.id,
    });

    showToast('success', 'Ítem eliminado.');
    setCatalogDetailOpen(false);
    setSelectedCatalogItemId(null);
    router.refresh();
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Error eliminando ítem.';
    showToast('error', message);
  }
};

const updateEditComponent = (
  localId: string,
  patch: Partial<EditableComponentRow>
) => {
  setEditComponents((prev) =>
    prev.map((row) => (row.localId === localId ? { ...row, ...patch } : row))
  );
};

const addEditComponent = () => {
  setEditComponents((prev) => [
    ...prev,
    {
      localId: `new-${Date.now()}-${Math.random()}`,
      componentProductId: selectableComponentOptions[0]?.id ?? 0,
      componentMode: 'fixed',
      quantity: 1,
      countsTowardDetailLimit: false,
      isRequired: true,
      sortOrder: prev.length + 1,
      notes: '',
    },
  ]);
};

const removeEditComponent = (localId: string) => {
  setEditComponents((prev) =>
    prev
      .filter((row) => row.localId !== localId)
      .map((row, idx) => ({ ...row, sortOrder: idx + 1 }))
  );
};

const handleSearchCreateOrderClients = async () => {
  const q = createOrderClientSearch.trim();
  if (!q) {
    setCreateOrderClientResults([]);
    return;
  }

  try {
    setCreateOrderClientSearchLoading(true);
    const query = q.toLowerCase();
    const nextResults = clients
      .filter((client) => {
        const tags = normalizeClientTags(client.crmTags);
        return [
          client.fullName,
          client.phone,
          client.clientType,
          client.billingCompanyName,
          client.billingTaxId,
          ...tags,
        ]
          .filter(Boolean)
          .some((value) => value.toLowerCase().includes(query));
      })
      .slice(0, 15);

    setCreateOrderClientResults(nextResults);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Error buscando clientes.';
    showToast('error', message);
  } finally {
    setCreateOrderClientSearchLoading(false);
  }
};

const handleApplyClientAddress = (address: ClientAddress) => {
  setCreateOrderFulfillment('delivery');
  setCreateOrderDeliveryAddress(address.addressText);
  setCreateOrderDeliveryGpsUrl(address.gpsUrl);
};

const handleSelectCreateOrderClient = (client: ClientItem) => {
  const addresses = normalizeClientAddresses(client.recentAddresses);
  setCreateOrderSelectedClientId(client.id);
  setCreateOrderSelectedClientName(client.fullName);
  setCreateOrderSelectedClientPhone(client.phone ?? '');
  setCreateOrderSelectedClientType(client.clientType ?? null);
  setCreateOrderNewClientMode(false);
  setCreateOrderClientResults([]);

  if (!createOrderReceiverName.trim()) {
    setCreateOrderReceiverName(client.deliveryNoteName || '');
  }

  if (!createOrderReceiverPhone.trim()) {
    setCreateOrderReceiverPhone(client.deliveryNotePhone || client.phone || '');
  }

  if (!createOrderDeliveryAddress.trim() && addresses[0]) {
    handleApplyClientAddress(addresses[0]);
  }

  if (!createOrderHasInvoice && client.billingCompanyName) {
    setCreateOrderHasInvoice(true);
  }

  if (!createOrderHasDeliveryNote && client.deliveryNoteName) {
    setCreateOrderHasDeliveryNote(true);
  }

  setCreateOrderInvoiceCompanyName(client.billingCompanyName || '');
  setCreateOrderInvoiceTaxId(client.billingTaxId || '');
  setCreateOrderInvoiceAddress(client.billingAddress || '');
  setCreateOrderInvoicePhone(client.billingPhone || '');
  setCreateOrderDeliveryNoteName(client.deliveryNoteName || '');
  setCreateOrderDeliveryNoteDocumentId(client.deliveryNoteDocumentId || '');
  setCreateOrderDeliveryNoteAddress(client.deliveryNoteAddress || '');
  setCreateOrderDeliveryNotePhone(client.deliveryNotePhone || client.phone || '');
};

const handleActivateCreateOrderNewClient = () => {
  setCreateOrderSelectedClientId(null);
  setCreateOrderSelectedClientName('');
  setCreateOrderSelectedClientPhone('');
  setCreateOrderSelectedClientType(null);
  setCreateOrderNewClientMode(true);

  if (createOrderClientSearch.trim() && !createOrderNewClientPhone.trim()) {
    setCreateOrderNewClientPhone(createOrderClientSearch.trim());
  }
};

const handleCreateOrderClientNow = async () => {
  try {
    const fullName = createOrderNewClientName.trim();
    const phone = createOrderNewClientPhone.trim();

    if (!fullName) {
      showToast('error', 'Debes colocar el nombre del cliente.');
      return;
    }

    if (!phone) {
      showToast('error', 'Debes colocar el teléfono del cliente.');
      return;
    }

    const quickClient = await createOrderClientQuickAction({
      fullName,
      phone,
      clientType: createOrderNewClientType,
    });

    handleSelectCreateOrderClient({
      id: Number(quickClient.client.id),
      fullName: quickClient.client.full_name ?? 'Sin nombre',
      phone: quickClient.client.phone ?? '',
      notes: quickClient.client.notes ?? '',
      primaryAdvisorId: quickClient.client.primary_advisor_id ?? null,
      createdAt: quickClient.client.created_at ?? '',
      clientType: String(quickClient.client.client_type ?? ''),
      isActive: Boolean(quickClient.client.is_active ?? true),
      birthDate: quickClient.client.birth_date ?? '',
      importantDate: quickClient.client.important_date ?? '',
      billingCompanyName: quickClient.client.billing_company_name ?? '',
      billingTaxId: quickClient.client.billing_tax_id ?? '',
      billingAddress: quickClient.client.billing_address ?? '',
      billingPhone: quickClient.client.billing_phone ?? '',
      deliveryNoteName: quickClient.client.delivery_note_name ?? '',
      deliveryNoteDocumentId: quickClient.client.delivery_note_document_id ?? '',
      deliveryNoteAddress: quickClient.client.delivery_note_address ?? '',
      deliveryNotePhone: quickClient.client.delivery_note_phone ?? '',
      recentAddresses: Array.isArray(quickClient.client.recent_addresses)
        ? quickClient.client.recent_addresses
        : [],
      crmTags: Array.isArray(quickClient.client.crm_tags)
        ? quickClient.client.crm_tags
        : [],
      extraFields:
        quickClient.client.extra_fields &&
        typeof quickClient.client.extra_fields === 'object'
          ? (quickClient.client.extra_fields as Record<string, unknown>)
          : {},
      updatedAt: quickClient.client.updated_at ?? '',
    });

    setCreateOrderNewClientName('');
    setCreateOrderNewClientPhone('');
    setCreateOrderNewClientType('assigned');

    showToast(
      'success',
      quickClient.alreadyExisted
        ? 'Ese cliente ya existía y fue seleccionado.'
        : 'Cliente creado.'
    );
    return;

  } catch (err) {
    const message = err instanceof Error ? err.message : 'Error creando cliente.';
    showToast('error', message);
  }
};

const openCreateOrderConfig = (product: CatalogItem, qty: number) => {
  setCreateOrderConfigProductId(product.id);
  setCreateOrderConfigProductName(product.name);
  setCreateOrderConfigSourcePriceCurrency(product.sourcePriceCurrency === 'VES' ? 'VES' : 'USD');
  setCreateOrderConfigSourcePriceAmount(
    product.sourcePriceCurrency === 'VES'
      ? Number(product.basePriceBs || 0)
      : Number(product.basePriceUsd || 0)
  );
  setCreateOrderConfigQty(qty);
  setCreateOrderConfigUnitPriceUsd(Number(product.basePriceUsd || 0));
  setCreateOrderConfigSku(product.sku || null);
  setCreateOrderConfigLimit(Number(product.detailUnitsLimit || 0));
  setCreateOrderConfigSelections([]);
  setCreateOrderConfigAlias('');
  setCreateOrderConfigOpen(true);
};

const openEditCreateOrderConfig = (draftItem: DraftItem) => {
  const product = catalogItems.find((item) => item.id === draftItem.productId);

  if (!product) {
    showToast('error', 'No se pudo encontrar el producto base para reconfigurar este ítem.');
    return;
  }

  const selectableOptions = productComponents.filter(
    (pc) =>
      pc.parentProductId === product.id &&
      pc.componentMode === 'selectable'
  );

  const parsed = parseEditableDetailLines(draftItem.editableDetailLines);

  const nextSelections: DraftEditableSelection[] = parsed.selections
    .map((parsedRow) => {
      const matchingOption = selectableOptions.find(
        (option) =>
          option.componentName.trim().toLowerCase() ===
          parsedRow.componentName.trim().toLowerCase()
      );

      if (!matchingOption) return null;

      return {
        localId: String(matchingOption.componentProductId),
        componentProductId: matchingOption.componentProductId,
        componentName: matchingOption.componentName,
        qty: parsedRow.qty,
      };
    })
    .filter((row): row is DraftEditableSelection => !!row);

  setCreateOrderConfigEditingLocalId(draftItem.localId);
  setCreateOrderConfigProductId(product.id);
  setCreateOrderConfigProductName(product.name);
  setCreateOrderConfigSourcePriceCurrency(
    draftItem.sourcePriceCurrency === 'VES' ? 'VES' : 'USD'
  );
  setCreateOrderConfigSourcePriceAmount(Number(draftItem.sourcePriceAmount || 0));
  setCreateOrderConfigQty(draftItem.qty);
  setCreateOrderConfigUnitPriceUsd(Number(draftItem.unitPriceUsdSnapshot || 0));
  setCreateOrderConfigSku(draftItem.skuSnapshot || null);
  setCreateOrderConfigLimit(Number(product.detailUnitsLimit || 0));
  setCreateOrderConfigSelections(nextSelections);
  setCreateOrderConfigAlias(parsed.alias);
  setCreateOrderConfigOpen(true);
};

const closeCreateOrderConfig = () => {
  setCreateOrderConfigOpen(false);
  setCreateOrderConfigProductId(null);
  setCreateOrderConfigProductName('');
  setCreateOrderConfigSourcePriceCurrency('VES');
  setCreateOrderConfigSourcePriceAmount(0);
  setCreateOrderConfigQty(1);
  setCreateOrderConfigUnitPriceUsd(0);
  setCreateOrderConfigSku(null);
  setCreateOrderConfigLimit(0);
  setCreateOrderConfigSelections([]);
  setCreateOrderConfigAlias('');
  setCreateOrderConfigEditingLocalId(null);
};

const handleAddCreateOrderItem = () => {
  if (createOrderSelectedProductId === '') {
    showToast('error', 'Selecciona un producto.');
    return;
  }

  if (!Number.isFinite(createOrderQty) || createOrderQty <= 0) {
    showToast('error', 'La cantidad debe ser mayor a 0.');
    return;
  }

  const product = catalogItems.find((item) => item.id === createOrderSelectedProductId);
  if (!product) {
    showToast('error', 'Producto no encontrado.');
    return;
  }

  if (product.isDetailEditable) {
    if (createOrderQty !== 1) {
      showToast('error', 'Los productos configurables se cargan uno por uno. Debes usar cantidad 1.');
      return;
    }

    openCreateOrderConfig(product, 1);

    setCreateOrderProductSearch('');
    setCreateOrderProductActiveIndex(-1);
    setCreateOrderSelectedProductId('');
    setCreateOrderQty(1);

    return;
  }

setCreateOrderDraftItems((prev) => [
  ...prev,
  {
    localId: `${Date.now()}-${Math.random()}`,
    productId: product.id,
    skuSnapshot: product.sku || null,
    productNameSnapshot: product.name,
    qty: createOrderQty,
    sourcePriceCurrency: product.sourcePriceCurrency === 'VES' ? 'VES' : 'USD',
    sourcePriceAmount:
      product.sourcePriceCurrency === 'VES'
        ? Number(product.basePriceBs || 0)
        : Number(product.basePriceUsd || 0),
    unitPriceUsdSnapshot: Number(product.basePriceUsd || 0),
    lineTotalUsd: Number(product.basePriceUsd || 0) * createOrderQty,
    editableDetailLines: [],
  },
]);

  setCreateOrderProductSearch('');
  setCreateOrderProductActiveIndex(-1);
  setCreateOrderSelectedProductId('');
  setCreateOrderQty(1);

  setTimeout(() => {
    createOrderProductSearchRef.current?.focus();
  }, 0);
};

const handleSetCreateOrderConfigSelectionQty = (
  componentProductId: number,
  componentName: string,
  qty: number
) => {
  const safeQty = Math.max(0, Math.floor(Number(qty || 0)));

  setCreateOrderConfigSelections((prev) => {
    const others = prev.filter((x) => x.componentProductId !== componentProductId);

    if (safeQty === 0) {
      return others;
    }

    return [
      ...others,
      {
        localId: `${componentProductId}`,
        componentProductId,
        componentName,
        qty: safeQty,
      },
    ];
  });
};

const handleRemoveCreateOrderConfigSelection = (localId: string) => {
  setCreateOrderConfigSelections((prev) => prev.filter((x) => x.localId !== localId));
};

const handleConfirmCreateOrderConfig = () => {
  if (!createOrderConfigProductId) return;

  if (createOrderConfigLimit > 0 && createOrderConfigSelectedUnits !== createOrderConfigLimit) {
    showToast('error', `Debes seleccionar exactamente ${createOrderConfigLimit} piezas.`);
    return;
  }

  const detailLines: string[] = [];

  if (createOrderConfigAlias.trim()) {
    detailLines.push(`Para: ${createOrderConfigAlias.trim()}`);
  }

  createOrderConfigSelections
    .filter((x) => x.qty > 0)
    .sort((a, b) => a.componentName.localeCompare(b.componentName))
    .forEach((x) => {
      detailLines.push(`${x.qty} ${x.componentName}`);
    });

const nextItem: DraftItem = {
  localId: createOrderConfigEditingLocalId ?? `${Date.now()}-${Math.random()}`,
  productId: createOrderConfigProductId,
  skuSnapshot: createOrderConfigSku,
  productNameSnapshot: createOrderConfigProductName,
  qty: createOrderConfigQty,
  sourcePriceCurrency: createOrderConfigSourcePriceCurrency,
  sourcePriceAmount: createOrderConfigSourcePriceAmount,
  unitPriceUsdSnapshot: createOrderConfigUnitPriceUsd,
  lineTotalUsd: createOrderConfigUnitPriceUsd * createOrderConfigQty,
  editableDetailLines: detailLines,
};

  setCreateOrderDraftItems((prev) => {
    if (createOrderConfigEditingLocalId) {
      return prev.map((item) =>
        item.localId === createOrderConfigEditingLocalId ? nextItem : item
      );
    }

    return [...prev, nextItem];
  });

  closeCreateOrderConfig();

  setTimeout(() => {
    createOrderProductSearchRef.current?.focus();
  }, 0);
};

const handleRemoveCreateOrderItem = (localId: string) => {
  setCreateOrderDraftItems((prev) => prev.filter((item) => item.localId !== localId));
};

const handleCreateOrder = async () => {
  try {
    if (!createOrderCanSave) {
      showToast('error', 'Faltan datos obligatorios.');
      return;
    }

    const result = await createOrderAction({
      source: createOrderSource,
      attributedAdvisorUserId: createOrderSource === 'advisor' ? createOrderAdvisorUserId : null,
      fulfillment: createOrderFulfillment,

      selectedClientId: createOrderSelectedClientId,
      newClientName: createOrderNewClientName,
      newClientPhone: createOrderNewClientPhone,
      newClientType: createOrderNewClientType,

      deliveryDate: createOrderDeliveryDate,
      deliveryHour12: createOrderDeliveryHour12,
      deliveryMinute: createOrderDeliveryMinute,
      deliveryAmPm: createOrderDeliveryAmPm,
      receiverName: createOrderReceiverIsDifferent ? createOrderReceiverName : '',
      receiverPhone: createOrderReceiverIsDifferent ? createOrderReceiverPhone : '',
      deliveryAddress: createOrderDeliveryAddress,
      deliveryGpsUrl: createOrderDeliveryGpsUrl,
      note: createOrderNote,

      discountEnabled: createOrderDiscountEnabled,
      discountPct: createOrderDiscountPct,
      invoiceTaxPct: createOrderInvoiceTaxPct,
      fxRate: createOrderFxRate,

      paymentMethod: createOrderPaymentMethod,
      paymentCurrency: createOrderPaymentCurrency,
      paymentRequiresChange: createOrderPaymentRequiresChange,
      paymentChangeFor: createOrderPaymentChangeFor,
      paymentChangeCurrency: createOrderPaymentChangeCurrency,
      paymentNote: createOrderPaymentNote,
      hasDeliveryNote: createOrderHasDeliveryNote,
      hasInvoice: createOrderHasInvoice,
      invoiceDataNote: [
        createOrderInvoiceCompanyName,
        createOrderInvoiceTaxId,
        createOrderInvoiceAddress,
        createOrderInvoicePhone,
      ]
        .filter(Boolean)
        .join(' | '),
      invoiceCompanyName: createOrderInvoiceCompanyName,
      invoiceTaxId: createOrderInvoiceTaxId,
      invoiceAddress: createOrderInvoiceAddress,
      invoicePhone: createOrderInvoicePhone,
      deliveryNoteName: createOrderDeliveryNoteName,
      deliveryNoteDocumentId: createOrderDeliveryNoteDocumentId,
      deliveryNoteAddress: createOrderDeliveryNoteAddress,
      deliveryNotePhone: createOrderDeliveryNotePhone,

items: createOrderDraftItems.map((item) => ({
  productId: item.productId,
  skuSnapshot: item.skuSnapshot,
  productNameSnapshot: item.productNameSnapshot,
  qty: item.qty,
  sourcePriceCurrency: item.sourcePriceCurrency,
  sourcePriceAmount: item.sourcePriceAmount,
  unitPriceUsdSnapshot: item.unitPriceUsdSnapshot,
  lineTotalUsd: item.lineTotalUsd,
  editableDetailLines: item.editableDetailLines,
})),
    });

    showToast('success', `Orden creada #${result.orderNumber}.`);
    setCreateOrderOpen(false);
    router.refresh();
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Error creando la orden.';
    showToast('error', message);
  }
};

const handleUpdateOrder = async () => {
  try {
    if (!editingOrderId) {
      showToast('error', 'No hay orden seleccionada para editar.');
      return;
    }

    if (!createOrderCanSave) {
      showToast('error', 'Faltan datos obligatorios.');
      return;
    }

    await updateOrderAction({
      orderId: editingOrderId,
      source: createOrderSource,
      attributedAdvisorUserId: createOrderSource === 'advisor' ? createOrderAdvisorUserId : null,
      fulfillment: createOrderFulfillment,

      selectedClientId: createOrderSelectedClientId,
      newClientName: createOrderNewClientName,
      newClientPhone: createOrderNewClientPhone,
      newClientType: createOrderNewClientType,

      deliveryDate: createOrderDeliveryDate,
      deliveryHour12: createOrderDeliveryHour12,
      deliveryMinute: createOrderDeliveryMinute,
      deliveryAmPm: createOrderDeliveryAmPm,
      receiverName: createOrderReceiverIsDifferent ? createOrderReceiverName : '',
      receiverPhone: createOrderReceiverIsDifferent ? createOrderReceiverPhone : '',
      deliveryAddress: createOrderDeliveryAddress,
      deliveryGpsUrl: createOrderDeliveryGpsUrl,
      note: createOrderNote,

      discountEnabled: createOrderDiscountEnabled,
      discountPct: createOrderDiscountPct,
      invoiceTaxPct: createOrderInvoiceTaxPct,
      fxRate: createOrderFxRate,

      paymentMethod: createOrderPaymentMethod,
      paymentCurrency: createOrderPaymentCurrency,
      paymentRequiresChange: createOrderPaymentRequiresChange,
      paymentChangeFor: createOrderPaymentChangeFor,
      paymentChangeCurrency: createOrderPaymentChangeCurrency,
      paymentNote: createOrderPaymentNote,
      hasDeliveryNote: createOrderHasDeliveryNote,
      hasInvoice: createOrderHasInvoice,
      invoiceDataNote: [
        createOrderInvoiceCompanyName,
        createOrderInvoiceTaxId,
        createOrderInvoiceAddress,
        createOrderInvoicePhone,
      ]
        .filter(Boolean)
        .join(' | '),
      invoiceCompanyName: createOrderInvoiceCompanyName,
      invoiceTaxId: createOrderInvoiceTaxId,
      invoiceAddress: createOrderInvoiceAddress,
      invoicePhone: createOrderInvoicePhone,
      deliveryNoteName: createOrderDeliveryNoteName,
      deliveryNoteDocumentId: createOrderDeliveryNoteDocumentId,
      deliveryNoteAddress: createOrderDeliveryNoteAddress,
      deliveryNotePhone: createOrderDeliveryNotePhone,

items: createOrderDraftItems.map((item) => ({
  productId: item.productId,
  skuSnapshot: item.skuSnapshot,
  productNameSnapshot: item.productNameSnapshot,
  qty: item.qty,
  sourcePriceCurrency: item.sourcePriceCurrency,
  sourcePriceAmount: item.sourcePriceAmount,
  unitPriceUsdSnapshot: item.unitPriceUsdSnapshot,
  lineTotalUsd: item.lineTotalUsd,
  editableDetailLines: item.editableDetailLines,
})),
    });

    showToast('success', `Orden actualizada #${editingOrderId}.`);
    setCreateOrderOpen(false);
    setEditingOrderId(null);
    setOrderEditorMode('create');
    router.refresh();
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Error actualizando la orden.';
    showToast('error', message);
  }
};

const handleUpdateCreateOrderItemQty = (localId: string, nextQty: number) => {
  if (!Number.isFinite(nextQty) || nextQty <= 0) return;

  setCreateOrderDraftItems((prev) =>
    prev.map((item) =>
      item.localId === localId
        ? {
            ...item,
            qty: nextQty,
            lineTotalUsd: item.unitPriceUsdSnapshot * nextQty,
          }
        : item
    )
  );
};

const createOrderFilteredProducts = catalogItems
  .filter((item) => item.isActive)
  .filter((item) => {
    const q = createOrderProductSearch.trim().toLowerCase();
    if (!q) return true;

    const name = item.name.toLowerCase();
    const sku = (item.sku || '').toLowerCase();

    return name.includes(q) || sku.includes(q);
  })
  .slice(0, 12);


const createOrderFxRateNumber = Math.max(0, Number(createOrderFxRate || 0));

const createOrderDraftSubtotalUsd = createOrderDraftItems.reduce((sum, item) => {
  const lineTotalUsd =
    item.sourcePriceCurrency === 'VES'
      ? createOrderFxRateNumber > 0
        ? (Number(item.sourcePriceAmount || 0) * Number(item.qty || 0)) / createOrderFxRateNumber
        : 0
      : Number(item.lineTotalUsd || 0);

  return sum + lineTotalUsd;
}, 0);

const createOrderDraftSubtotalBs = createOrderDraftItems.reduce((sum, item) => {
  const lineTotalBs =
    item.sourcePriceCurrency === 'VES'
      ? Number(item.sourcePriceAmount || 0) * Number(item.qty || 0)
      : Number(item.lineTotalUsd || 0) * createOrderFxRateNumber;

  return sum + lineTotalBs;
}, 0);

const createOrderDiscountPctNumber = Math.max(
  0,
  Math.min(100, Number(createOrderDiscountPct || 0))
);

const createOrderInvoiceTaxPctNumber = createOrderHasInvoice
  ? Math.max(0, Number(String(createOrderInvoiceTaxPct || '0').replace(',', '.')) || 0)
  : 0;

const createOrderDiscountAmountBs = createOrderDiscountEnabled
  ? createOrderDraftSubtotalBs * (createOrderDiscountPctNumber / 100)
  : 0;

const createOrderDraftSubtotalAfterDiscountBs = Math.max(
  0,
  createOrderDraftSubtotalBs - createOrderDiscountAmountBs
);

const createOrderInvoiceTaxAmountBs = createOrderHasInvoice
  ? createOrderDraftSubtotalAfterDiscountBs * (createOrderInvoiceTaxPctNumber / 100)
  : 0;

const createOrderDraftTotalBs = createOrderDraftSubtotalAfterDiscountBs + createOrderInvoiceTaxAmountBs;

const createOrderDiscountAmountUsd =
  createOrderFxRateNumber > 0 ? createOrderDiscountAmountBs / createOrderFxRateNumber : 0;

const createOrderDraftSubtotalAfterDiscountUsd =
  createOrderFxRateNumber > 0 ? createOrderDraftSubtotalAfterDiscountBs / createOrderFxRateNumber : 0;

const createOrderInvoiceTaxAmountUsd =
  createOrderFxRateNumber > 0 ? createOrderInvoiceTaxAmountBs / createOrderFxRateNumber : 0;

const createOrderDraftTotalUsd =
  createOrderFxRateNumber > 0
    ? createOrderDraftTotalBs / createOrderFxRateNumber
    : 0;
    
const createOrderNeedsAdvisor =
  createOrderSource === 'advisor';

const createOrderHasValidAdvisor =
  !createOrderNeedsAdvisor || !!createOrderAdvisorUserId;

const createOrderHasClient =
  !!createOrderSelectedClientId ||
  (
    createOrderNewClientMode &&
    !!createOrderNewClientName.trim() &&
    !!createOrderNewClientPhone.trim()
  );

const createOrderHasItems = createOrderDraftItems.length > 0;

const createOrderHasDeliveryAddress =
  createOrderFulfillment === 'pickup' || !!createOrderDeliveryAddress.trim();

const selectedPaymentReportAccount =
  moneyAccounts.filter((a) => a.isActive).find((a) => a.id === Number(paymentReportMoneyAccountId)) ?? null;

  const selectedAccount = useMemo(
    () => moneyAccounts.find((account) => account.id === selectedAccountId) ?? null,
    [moneyAccounts, selectedAccountId]
  );

  const selectedClient = useMemo(
    () => clients.find((client) => client.id === selectedClientId) ?? null,
    [clients, selectedClientId]
  );

  const selectedCreateOrderClient = useMemo(
    () => clients.find((client) => client.id === createOrderSelectedClientId) ?? null,
    [clients, createOrderSelectedClientId]
  );

  const filteredMoneyMovements = useMemo(() => {
    return moneyMovements.filter((movement) => {
      if (accountDateFrom && movement.movementDate < accountDateFrom) return false;
      if (accountDateTo && movement.movementDate > accountDateTo) return false;
      return true;
    });
  }, [accountDateFrom, accountDateTo, moneyMovements]);

  const filteredAccounts = useMemo(() => {
    const query = accountSearch.trim().toLowerCase();

    return moneyAccounts.filter((account) => {
      if (!query) return true;

      return [
        account.name,
        account.currencyCode,
        account.accountKind,
        account.institutionName,
        account.ownerName,
      ]
        .filter(Boolean)
        .some((value) => value.toLowerCase().includes(query));
    });
  }, [accountSearch, moneyAccounts]);

  const filteredClients = useMemo(() => {
    const query = clientSearch.trim().toLowerCase();

    return clients.filter((client) => {
      if (!query) return true;

      const tags = normalizeClientTags(client.crmTags);
      const addresses = normalizeClientAddresses(client.recentAddresses);

      return [
        client.fullName,
        client.phone,
        client.clientType,
        client.billingCompanyName,
        client.billingTaxId,
        client.deliveryNoteName,
        ...tags,
        ...addresses.map((row) => row.addressText),
      ]
        .filter(Boolean)
        .some((value) => value.toLowerCase().includes(query));
    });
  }, [clientSearch, clients]);

  const accountStatsById = useMemo(() => {
    const stats = new Map<
      number,
      {
        balanceNative: number;
        periodInflowNative: number;
        periodOutflowNative: number;
        balanceUsdRef: number;
        periodInflowUsdRef: number;
        periodOutflowUsdRef: number;
      }
    >();

    for (const account of moneyAccounts) {
      stats.set(account.id, {
        balanceNative: 0,
        periodInflowNative: 0,
        periodOutflowNative: 0,
        balanceUsdRef: 0,
        periodInflowUsdRef: 0,
        periodOutflowUsdRef: 0,
      });
    }

    for (const movement of moneyMovements) {
      const current = stats.get(movement.moneyAccountId);
      if (!current) continue;

      current.balanceNative += movement.direction === 'inflow'
        ? movement.amount
        : movement.amount * -1;
      current.balanceUsdRef += movement.direction === 'inflow'
        ? movement.amountUsdEquivalent
        : movement.amountUsdEquivalent * -1;
    }

    for (const movement of filteredMoneyMovements) {
      const current = stats.get(movement.moneyAccountId);
      if (!current) continue;

      if (movement.direction === 'inflow') {
        current.periodInflowNative += movement.amount;
        current.periodInflowUsdRef += movement.amountUsdEquivalent;
      } else {
        current.periodOutflowNative += movement.amount;
        current.periodOutflowUsdRef += movement.amountUsdEquivalent;
      }
    }

    return stats;
  }, [filteredMoneyMovements, moneyAccounts, moneyMovements]);

  const accountSummary = useMemo(() => {
    const base = {
      USD: { activeCount: 0, balanceNative: 0, inflowNative: 0, outflowNative: 0, balanceUsdRef: 0 },
      VES: { activeCount: 0, balanceNative: 0, inflowNative: 0, outflowNative: 0, balanceUsdRef: 0 },
    };

    for (const account of filteredAccounts) {
      const stats = accountStatsById.get(account.id);
      if (!stats) continue;

      if (account.isActive) base[account.currencyCode].activeCount += 1;
      base[account.currencyCode].balanceNative += stats.balanceNative;
      base[account.currencyCode].inflowNative += stats.periodInflowNative;
      base[account.currencyCode].outflowNative += stats.periodOutflowNative;
      base[account.currencyCode].balanceUsdRef += stats.balanceUsdRef;
    }

    return base;
  }, [accountStatsById, filteredAccounts]);

  const selectedAccountMovements = useMemo(() => {
    if (!selectedAccountId) return [];
    return filteredMoneyMovements.filter((movement) => movement.moneyAccountId === selectedAccountId);
  }, [filteredMoneyMovements, selectedAccountId]);

  const clientStats = useMemo(() => {
    const base = {
      total: filteredClients.length,
      active: 0,
      withBilling: 0,
      withDeliveryNote: 0,
      withAddresses: 0,
    };

    for (const client of filteredClients) {
      if (client.isActive) base.active += 1;
      if (
        client.billingCompanyName ||
        client.billingTaxId ||
        client.billingAddress ||
        client.billingPhone
      ) {
        base.withBilling += 1;
      }
      if (
        client.deliveryNoteName ||
        client.deliveryNoteDocumentId ||
        client.deliveryNoteAddress ||
        client.deliveryNotePhone
      ) {
        base.withDeliveryNote += 1;
      }
      if (normalizeClientAddresses(client.recentAddresses).length > 0) {
        base.withAddresses += 1;
      }
    }

    return base;
  }, [filteredClients]);

  const advisorNameById = useMemo(() => {
    return new Map(advisors.map((advisor) => [advisor.userId, advisor.fullName]));
  }, [advisors]);

  const clientById = useMemo(() => {
    return new Map(clients.map((client) => [client.id, client]));
  }, [clients]);

  const orderLookupById = useMemo(() => {
    return new Map(orders.map((order) => [order.id, order]));
  }, [orders]);

  const deliveredOrders = useMemo(
    () => orders.filter((order) => order.status === 'delivered'),
    [orders]
  );

  const advisorCalcRange = useMemo(() => {
    const start = advisorCalcDateFrom ? new Date(`${advisorCalcDateFrom}T00:00:00`) : null;
    const end = advisorCalcDateTo ? new Date(`${advisorCalcDateTo}T23:59:59`) : null;

    if (start && Number.isNaN(start.getTime())) return { start: null, end: null };
    if (end && Number.isNaN(end.getTime())) return { start: null, end: null };

    return { start, end };
  }, [advisorCalcDateFrom, advisorCalcDateTo]);

  const deliveredOrderMovementsByOrderId = useMemo(() => {
    const grouped = new Map<number, MoneyMovementItem[]>();

    for (const movement of moneyMovements) {
      if (!movement.orderId || movement.direction !== 'inflow') continue;
      const arr = grouped.get(movement.orderId) ?? [];
      arr.push(movement);
      grouped.set(movement.orderId, arr);
    }

    for (const arr of grouped.values()) {
      arr.sort((a, b) => {
        const aDate = new Date(a.confirmedAt || a.createdAt).getTime();
        const bDate = new Date(b.confirmedAt || b.createdAt).getTime();
        return aDate - bDate;
      });
    }

    return grouped;
  }, [moneyMovements]);

  const firstDeliveredOrderByClientId = useMemo(() => {
    const map = new Map<number, Order>();

    for (const order of deliveredOrders) {
      if (!order.clientId) continue;
      const current = map.get(order.clientId);
      if (!current || new Date(order.deliveryAtISO).getTime() < new Date(current.deliveryAtISO).getTime()) {
        map.set(order.clientId, order);
      }
    }

    return map;
  }, [deliveredOrders]);

  const advisorCalculatedData = useMemo(() => {
    const { start, end } = advisorCalcRange;
    const selectedSource = advisorCalcSource || null;
    const selectedAdvisorId = advisorCalcAdvisorId || null;

    const filteredDeliveredOrders = deliveredOrders.filter((order) => {
      if (selectedSource && order.source !== selectedSource) return false;
      if (selectedAdvisorId && order.attributedAdvisorUserId !== selectedAdvisorId) return false;
      if (selectedSource === 'advisor' && !order.attributedAdvisorUserId) return false;

      const deliveryTime = new Date(order.deliveryAtISO).getTime();
      if (start && deliveryTime < start.getTime()) return false;
      if (end && deliveryTime > end.getTime()) return false;
      return true;
    });

    const facturacion = filteredDeliveredOrders.reduce((sum, order) => sum + order.totalUsd, 0);
    const cierres = filteredDeliveredOrders.length;
    const cierrePromedio = cierres > 0 ? facturacion / cierres : 0;

    const pendingOrders = filteredDeliveredOrders
      .filter((order) => order.balanceUsd > 0.01)
      .sort((a, b) => new Date(a.deliveryAtISO).getTime() - new Date(b.deliveryAtISO).getTime());

    let pagoPuntual = 0;
    let pagoImpuntual = 0;

    for (const order of filteredDeliveredOrders) {
      if (order.balanceUsd > 0.01) continue;

      const movements = deliveredOrderMovementsByOrderId.get(order.id) ?? [];
      let accumulated = 0;
      let fullyPaidAt: string | null = null;

      for (const movement of movements) {
        accumulated += Number(movement.amountUsdEquivalent || 0);
        if (accumulated + 0.000001 >= order.totalUsd) {
          fullyPaidAt = movement.confirmedAt || movement.createdAt;
          break;
        }
      }

      if (!fullyPaidAt) continue;

      const deliveredAt = new Date(order.deliveryAtISO);
      const endOfDeliveryDay = new Date(deliveredAt);
      endOfDeliveryDay.setHours(23, 59, 59, 999);

      if (new Date(fullyPaidAt).getTime() <= endOfDeliveryDay.getTime()) {
        pagoPuntual += 1;
      } else {
        pagoImpuntual += 1;
      }
    }

    const newClientOrders = filteredDeliveredOrders.filter((order) => {
      if (!order.clientId) return false;
      const firstOrder = firstDeliveredOrderByClientId.get(order.clientId);
      return firstOrder?.id === order.id;
    });

    const clientesNuevos = newClientOrders.length;
    let nuevosPropios = 0;
    let nuevosAsignados = 0;

    for (const order of newClientOrders) {
      if (!order.clientId) continue;
      const client = clientById.get(order.clientId);
      const type = String(client?.clientType || '').trim().toLowerCase();
      if (type === 'own' || type === 'propio') nuevosPropios += 1;
      else if (type === 'assigned' || type === 'asignado') nuevosAsignados += 1;
    }

    const sourceCounts = filteredDeliveredOrders.reduce(
      (acc, order) => {
        if (order.source === 'advisor') acc.advisor += 1;
        else if (order.source === 'master') acc.master += 1;
        else if (order.source === 'walk_in') acc.walkIn += 1;
        return acc;
      },
      { advisor: 0, master: 0, walkIn: 0 }
    );

    return {
      filteredDeliveredOrders,
      facturacion,
      cierres,
      cierrePromedio,
      pagoPuntual,
      pagoImpuntual,
      pendingOrders,
      pendientesPorCobrarTotal: pendingOrders.reduce((sum, order) => sum + order.balanceUsd, 0),
      clientesNuevos,
      nuevosPropios,
      nuevosAsignados,
      newClientOrders,
      sourceCounts,
    };
  }, [
    advisorCalcSource,
    advisorCalcAdvisorId,
    advisorCalcRange,
    clientById,
    deliveredOrderMovementsByOrderId,
    deliveredOrders,
    firstDeliveredOrderByClientId,
  ]);

const createOrderCanSave =
  createOrderHasValidAdvisor &&
  createOrderHasClient &&
  createOrderHasItems &&
  createOrderHasDeliveryAddress;

useEffect(() => {
  if (!createOrderConfigOpen) return;

  setTimeout(() => {
    createOrderConfigAliasRef.current?.focus();
    createOrderConfigAliasRef.current?.select();
  }, 0);
}, [createOrderConfigOpen]);

useEffect(() => {
  if (createOrderSelectedProductIsEditable && createOrderQty !== 1) {
    setCreateOrderQty(1);
  }
}, [createOrderSelectedProductIsEditable, createOrderQty]);

const resetCreateOrderForm = () => {
  setCreateOrderSource('master');
  setCreateOrderAdvisorUserId('');
  setCreateOrderFulfillment('pickup');

  setCreateOrderClientSearch('');
  setCreateOrderClientResults([]);
  setCreateOrderSelectedClientId(null);
  setCreateOrderSelectedClientName('');
  setCreateOrderSelectedClientPhone('');
  setCreateOrderSelectedClientType(null);
  setCreateOrderClientSearchLoading(false);
  setCreateOrderNewClientMode(false);
  setCreateOrderNewClientName('');
  setCreateOrderNewClientPhone('');
  setCreateOrderNewClientType('assigned');

  setCreateOrderProductSearch('');
  setCreateOrderProductActiveIndex(-1);
  setCreateOrderSelectedProductId('');
  setCreateOrderQty(1);
  setCreateOrderDraftItems([]);
  setCreateOrderDiscountEnabled(false);
  setCreateOrderDiscountPct('0');
  setCreateOrderInvoiceTaxPct('16');
  setCreateOrderFxRate(activeExchangeRate ? String(activeExchangeRate.rateBsPerUsd) : '0');

  const now = new Date();
  const rounded = new Date(now);
  rounded.setSeconds(0, 0);

  const mins = rounded.getMinutes();

  if (mins === 0 || mins === 30) {
    // queda igual
  } else if (mins < 30) {
    rounded.setMinutes(30);
  } else {
    rounded.setHours(rounded.getHours() + 1);
    rounded.setMinutes(0);
  }

  const year = rounded.getFullYear();
  const month = String(rounded.getMonth() + 1).padStart(2, '0');
  const day = String(rounded.getDate()).padStart(2, '0');

  let hour24 = rounded.getHours();
  const minute = String(rounded.getMinutes()).padStart(2, '0');
  const ampm: 'AM' | 'PM' = hour24 >= 12 ? 'PM' : 'AM';
  let hour12 = hour24 % 12;
  if (hour12 === 0) hour12 = 12;

  setCreateOrderDeliveryDate(`${year}-${month}-${day}`);
  setCreateOrderDeliveryHour12(String(hour12));
  setCreateOrderDeliveryMinute(minute);
  setCreateOrderDeliveryAmPm(ampm);

  setCreateOrderReceiverIsDifferent(false);
  setCreateOrderReceiverName('');
  setCreateOrderReceiverPhone('');
  setCreateOrderDeliveryAddress('');
  setCreateOrderDeliveryGpsUrl('');
  setCreateOrderNote('');

  setCreateOrderPaymentMethod('payment_mobile');
  setCreateOrderPaymentCurrency('VES');
  setCreateOrderPaymentRequiresChange(false);
  setCreateOrderPaymentChangeFor('');
  setCreateOrderPaymentChangeCurrency('USD');
  setCreateOrderPaymentNote('');

  setCreateOrderHasDeliveryNote(false);
  setCreateOrderHasInvoice(false);
  setCreateOrderInvoiceDataNote('');
  setCreateOrderInvoiceCompanyName('');
  setCreateOrderInvoiceTaxId('');
  setCreateOrderInvoiceAddress('');
  setCreateOrderInvoicePhone('');
  setCreateOrderInvoiceTaxPct('16');
  setCreateOrderDeliveryNoteName('');
  setCreateOrderDeliveryNoteDocumentId('');
  setCreateOrderDeliveryNoteAddress('');
  setCreateOrderDeliveryNotePhone('');
};

useEffect(() => {
  if (!toast) return;

  const timer = window.setTimeout(() => {
    setToast(null);
  }, 2600);

  return () => window.clearTimeout(timer);
}, [toast]);

useEffect(() => {
  if (!isMounted) return;

  const interval = window.setInterval(() => {
    const hasBlockingOverlay =
      createOrderOpen ||
      accountCreateOpen ||
      accountEditOpen ||
      clientCreateOpen ||
      clientEditOpen ||
      createCatalogOpen ||
      quickCatalogOpen ||
      catalogEditMode ||
      paymentReportBoxOpen ||
      kitchenTakeBoxOpen ||
      deliveryEtaBoxOpen ||
      reviewActionMode !== null ||
      returnToQueueBoxOpen ||
      cancelOrderBoxOpen;

    if (document.hidden || hasBlockingOverlay) return;

    router.refresh();
  }, 20000);

  return () => window.clearInterval(interval);
}, [
  isMounted,
  router,
  createOrderOpen,
  accountCreateOpen,
  accountEditOpen,
  clientCreateOpen,
  clientEditOpen,
  createCatalogOpen,
  quickCatalogOpen,
  catalogEditMode,
  paymentReportBoxOpen,
  kitchenTakeBoxOpen,
  deliveryEtaBoxOpen,
  reviewActionMode,
  returnToQueueBoxOpen,
  cancelOrderBoxOpen,
]);

useEffect(() => {
  if (!isMounted) return;

  const handleVisibilityChange = () => {
    if (document.hidden) return;

    const hasBlockingOverlay =
      createOrderOpen ||
      accountCreateOpen ||
      accountEditOpen ||
      clientCreateOpen ||
      clientEditOpen ||
      createCatalogOpen ||
      quickCatalogOpen ||
      catalogEditMode ||
      paymentReportBoxOpen ||
      kitchenTakeBoxOpen ||
      deliveryEtaBoxOpen ||
      reviewActionMode !== null ||
      returnToQueueBoxOpen ||
      cancelOrderBoxOpen;

    if (hasBlockingOverlay) return;

    router.refresh();
  };

  document.addEventListener('visibilitychange', handleVisibilityChange);

  return () => {
    document.removeEventListener('visibilitychange', handleVisibilityChange);
  };
}, [
  isMounted,
  router,
  createOrderOpen,
  accountCreateOpen,
  accountEditOpen,
  clientCreateOpen,
  clientEditOpen,
  createCatalogOpen,
  quickCatalogOpen,
  catalogEditMode,
  paymentReportBoxOpen,
  kitchenTakeBoxOpen,
  deliveryEtaBoxOpen,
  reviewActionMode,
  returnToQueueBoxOpen,
  cancelOrderBoxOpen,
]);

useEffect(() => {
  if (!createOrderOpen) return;
  if (orderEditorMode !== 'create') return;

  resetCreateOrderForm();
}, [createOrderOpen, orderEditorMode, activeExchangeRate]);

  useEffect(() => {
    if (!selectedDay) return;

    const dateValue = toDateInputValue(selectedDay);
    setAdvisorCalcDateFrom((prev) => (prev ? prev : dateValue));
    setAdvisorCalcDateTo((prev) => (prev ? prev : dateValue));
  }, [selectedDay]);

  useEffect(() => {
    if (advisorCalcSource === 'advisor') return;
    if (!advisorCalcAdvisorId) return;
    setAdvisorCalcAdvisorId('');
  }, [advisorCalcSource, advisorCalcAdvisorId]);

useEffect(() => {
  if (!createOrderOpen) return;
  if (!selectedCreateOrderClient) return;

  if (
    createOrderHasInvoice &&
    !createOrderInvoiceCompanyName &&
    !createOrderInvoiceTaxId &&
    !createOrderInvoiceAddress &&
    !createOrderInvoicePhone
  ) {
    setCreateOrderInvoiceCompanyName(selectedCreateOrderClient.billingCompanyName || '');
    setCreateOrderInvoiceTaxId(selectedCreateOrderClient.billingTaxId || '');
    setCreateOrderInvoiceAddress(selectedCreateOrderClient.billingAddress || '');
    setCreateOrderInvoicePhone(selectedCreateOrderClient.billingPhone || '');
  }

  if (
    createOrderHasDeliveryNote &&
    !createOrderDeliveryNoteName &&
    !createOrderDeliveryNoteDocumentId &&
    !createOrderDeliveryNoteAddress &&
    !createOrderDeliveryNotePhone
  ) {
    setCreateOrderDeliveryNoteName(selectedCreateOrderClient.deliveryNoteName || '');
    setCreateOrderDeliveryNoteDocumentId(selectedCreateOrderClient.deliveryNoteDocumentId || '');
    setCreateOrderDeliveryNoteAddress(selectedCreateOrderClient.deliveryNoteAddress || '');
    setCreateOrderDeliveryNotePhone(
      selectedCreateOrderClient.deliveryNotePhone || selectedCreateOrderClient.phone || ''
    );
  }
}, [
  createOrderOpen,
  selectedCreateOrderClient,
  createOrderHasInvoice,
  createOrderHasDeliveryNote,
  createOrderInvoiceCompanyName,
  createOrderInvoiceTaxId,
  createOrderInvoiceAddress,
  createOrderInvoicePhone,
  createOrderDeliveryNoteName,
  createOrderDeliveryNoteDocumentId,
  createOrderDeliveryNoteAddress,
  createOrderDeliveryNotePhone,
]);


  return (
    <div className="min-h-screen bg-[#0B0B0D] text-[#F5F5F7]">
      <div className="sticky top-0 z-50 border-b border-[#242433] bg-[#0B0B0D]/95 backdrop-blur">
        <div className="mx-auto max-w-[1400px] px-5 py-4">
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-4">
             <div className="flex items-center gap-4">
  <h1 className="text-xl font-semibold">Master Dashboard</h1>

  <div className="relative">
    <input
      ref={dateInputRef}
      type="date"
      value={selectedDay ? toDateInputValue(selectedDay) : ''}
      onChange={(e) => {
        const value = e.target.value;
        if (!value) return;
        const next = new Date(`${value}T00:00:00`);
        next.setHours(0, 0, 0, 0);
        setSelectedDay(next);
      }}
      className="pointer-events-none absolute inset-0 opacity-0"
    />

    <button
      className="rounded-2xl border border-[#242433] bg-[#121218] px-4 py-2 text-left"
      onClick={() => dateInputRef.current?.showPicker?.() ?? dateInputRef.current?.click()}
      title="Seleccionar día"
      type="button"
    >
      <div className="text-sm font-medium">
        {isMounted && selectedDay ? fmtDeliveryTextES(selectedDay.toISOString()) : 'Cargando fecha...'}
      </div>
      <div className="text-xs text-[#B7B7C2]">
        {isMounted && selectedDay ? fmtWeekRangeES(selectedDay) : '—'}
      </div>
    </button>
  </div>

  <div
    className="rounded-2xl border border-[#242433] bg-[#121218] px-3 py-2"
    title={
  activeExchangeRate
    ? `Vigente desde: ${fmtDateTimeES(activeExchangeRate.effectiveAt)}`
    : 'Sin tasa activa'
}
suppressHydrationWarning
  >
    <div className="text-xs text-[#B7B7C2]">Tasa</div>
    <div className="text-sm font-medium text-[#F5F5F7]">
      {activeExchangeRate ? fmtRateBs(activeExchangeRate.rateBsPerUsd) : '—'}
    </div>
  </div>
</div>


<div className="flex items-center gap-3">
  <div className="flex items-center gap-2">
    <button
      className={[
        'rounded-2xl border px-4 py-2 text-sm',
        viewMode === 'operations'
          ? 'border-[#FEEF00] bg-[#121218] text-[#F5F5F7]'
          : 'border-[#242433] bg-[#121218] text-[#B7B7C2]',
      ].join(' ')}
      onClick={() => setViewMode('operations')}
    >
      Operación
    </button>

    <button
      className={[
        'rounded-2xl border px-4 py-2 text-sm',
        viewMode === 'settings'
          ? 'border-[#FEEF00] bg-[#121218] text-[#F5F5F7]'
          : 'border-[#242433] bg-[#121218] text-[#B7B7C2]',
      ].join(' ')}
      onClick={() => setViewMode('settings')}
    >
      Configuración
    </button>

    {isAdmin ? (
      <button
        className={[
          'rounded-2xl border px-4 py-2 text-sm',
          viewMode === 'calculations'
            ? 'border-[#FEEF00] bg-[#121218] text-[#F5F5F7]'
            : 'border-[#242433] bg-[#121218] text-[#B7B7C2]',
        ].join(' ')}
        onClick={() => setViewMode('calculations')}
      >
        Cálculos
      </button>
    ) : null}

    <button
      className="rounded-2xl border border-[#242433] bg-[#121218] px-4 py-2 text-sm text-[#F5F5F7]"
      onClick={() => setNotifOpen(true)}
      title="Notificaciones"
    >
      🔔 Notificaciones ({notifications.length})
    </button>
  </div>

<div className="w-[220px] rounded-2xl border border-[#242433] bg-[#121218] px-4 py-2">
  <div className="flex items-start justify-between gap-0">
    <div className="min-w-0">
      <div className="truncate text-sm font-semibold text-[#F5F5F7]">
        {currentUser.fullName || 'Usuario'}
      </div>

      <div className="mt-0.5 text-xs text-[#B7B7C2]">
        {roles.length > 0
          ? ` ${roles.map((r) => r.toUpperCase()).join(' · ')}`
          : 'Sin roles'}
      </div>
    </div>

    <button
      className="shrink-0 rounded-xl border border-red-500/40 bg-[#0B0B0D] px-2 py-2.5 text-xs text-red-400"
      onClick={handleLogout}
      type="button"
      title="Cerrar sesión"
    >
      Salir
    </button>
  </div>
</div>
</div>
            </div>

            
          </div>
        </div>
      </div>

{viewMode === 'settings' ? (
  <div className="border-b border-[#242433] bg-[#0B0B0D]">
    <div className="mx-auto max-w-[1400px] px-5 py-2">
      <div className="flex gap-2 overflow-x-auto">
        <Chip active={settingsTab === 'catalog'} onClick={() => setSettingsTab('catalog')}>
          Catálogo
        </Chip>
        <Chip active={settingsTab === 'exchange_rate'} onClick={() => setSettingsTab('exchange_rate')}>
          Tasa
        </Chip>
        <Chip active={settingsTab === 'accounts'} onClick={() => setSettingsTab('accounts')}>
          Cuentas
        </Chip>
        <Chip active={settingsTab === 'clients'} onClick={() => setSettingsTab('clients')}>
          Clientes
        </Chip>
      </div>
    </div>
  </div>
) : null}

{viewMode === 'calculations' && isAdmin ? (
  <div className="border-b border-[#242433] bg-[#0B0B0D]">
    <div className="mx-auto max-w-[1400px] px-5 py-2">
      <div className="flex gap-2 overflow-x-auto">
        <Chip active={calculationsTab === 'advisors'} onClick={() => setCalculationsTab('advisors')}>
          Asesores
        </Chip>
      </div>
    </div>
  </div>
) : null}


      {viewMode === 'operations' ? (
        <div className="mx-auto max-w-[1400px] px-5 py-5">
          <div className="grid grid-cols-12 gap-4">
            <Card title="Estado del día" className="col-span-12 md:col-span-6 xl:col-span-3">
              <StatRow label="Cierres" value={dayStats.cierres} />
              <StatRow label="Facturación" value={fmtUSD(dayStats.fact)} />
              <StatRow label="Abonado (conf.)" value={fmtUSD(dayStats.abonadoConfirmado)} />
              <StatRow label="Pendiente" value={fmtUSD(dayStats.pendiente)} highlight />
            </Card>

            <Card title="Estado de la semana" className="col-span-12 md:col-span-6 xl:col-span-3">
              <StatRow label="Cierres" value={weekStats.cierres} />
              <StatRow label="Facturación" value={fmtUSD(weekStats.fact)} />
              <StatRow label="Abonado (conf.)" value={fmtUSD(weekStats.abonadoConfirmado)} />
              <StatRow label="Pendiente" value={fmtUSD(weekStats.pendiente)} highlight />
            </Card>

            <Card title="Pagos (semana)" className="col-span-12 md:col-span-6 xl:col-span-2">
              <StatRow label="Por confirmar" value={paymentsStats.porConfirmar} highlightTone="warn" />
              <StatRow label="Confirmados" value={paymentsStats.confirmados} />
              <StatRow label="Rechazados" value={paymentsStats.rechazados} />
            </Card>

            <Card title="Aprobaciones (semana)" className="col-span-12 md:col-span-6 xl:col-span-2">
              <StatRow label="Por aprobar" value={approvalsStats.porAprobar} highlightTone="brand" />
              <StatRow label="Re-aprobar" value={approvalsStats.reaprobar} highlightTone="warn" />
              <StatRow label="Listas para cocina" value={approvalsStats.listasCocina} />
            </Card>

            <Card title="Productos comprometidos (und)" className="col-span-12 xl:col-span-2">
              <div className="space-y-2">
                {top3.length === 0 ? (
                  <div className="text-xs text-[#B7B7C2]">Sin datos</div>
                ) : (
                  top3.map((p) => (
                    <div key={p.name} className="text-xs">
                      <div className="flex items-center justify-between gap-2">
                        <div className="truncate text-[#F5F5F7]">{p.name}</div>
                        <div className="shrink-0 text-[#B7B7C2]">{p.und} und</div>
                      </div>
                      <div className="mt-1 h-1 w-full rounded-full bg-[#191926]">
                        <div
                          className="h-1 rounded-full bg-[#FEEF00]"
                          style={{ width: `${Math.max(8, Math.round((p.und / maxUnd) * 100))}%` }}
                        />
                      </div>
                    </div>
                  ))
                )}

                <div className="flex justify-end">
                  <button
                    className="text-xs text-[#B7B7C2] hover:text-[#F5F5F7]"
                    onClick={() => setProductsExpanded(true)}
                  >
                    Ver más ▾
                  </button>
                </div>
              </div>
            </Card>
          </div>

          <div className="mt-5 flex flex-col gap-3 rounded-2xl border border-[#242433] bg-[#121218] p-4 md:flex-row md:items-center md:justify-between">
            <div className="relative w-full md:max-w-md">
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Buscar por #orden o cliente…"
                className="w-full rounded-2xl border border-[#242433] bg-[#0B0B0D] px-4 py-2 text-sm text-[#F5F5F7] placeholder:text-[#8A8A96]"
              />
              {searchResults.length > 0 ? (
                <div className="absolute z-20 mt-2 w-full overflow-hidden rounded-2xl border border-[#242433] bg-[#0B0B0D]">
                  {searchResults.map((r) => (
                    <button
                      key={r.id}
                      className="w-full px-4 py-3 text-left hover:bg-[#121218]"
                      onClick={() => {
                        setSearch('');
                        openOrderPanel(r.id, 'detalle');
                      }}
                    >
                      <div className="text-sm font-medium text-[#F5F5F7]">{r.label}</div>
                      <div className="text-xs text-[#B7B7C2]">{r.sub}</div>
                    </button>
                  ))}
                </div>
              ) : null}
            </div>

<div className="flex flex-wrap gap-2">
  <Btn onClick={openCreateOrderDrawer}>Nuevo pedido</Btn>
  <Btn onClick={() => showToast('error', 'Editar pedido por número aún está en demo.')}>
    Editar pedido
  </Btn>
  <Btn onClick={() => showToast('error', 'Registrar pago por número aún está en demo.')}>
    Registrar pago
  </Btn>
  <Btn onClick={() => showToast('error', 'Confirmar pagos desde bandeja aún está en demo.')}>
    Confirmar pagos
  </Btn>
  <Btn onClick={() => setMovementOpen(true)}>Movimiento</Btn>
</div>
          </div>

          <div className="mt-4 flex gap-2 overflow-x-auto pb-1">
            <Chip active={tray === 'all'} onClick={() => setTray('all')}>Todos</Chip>
            <Chip active={tray === 'pending_created'} onClick={() => setTray('pending_created')}>Pendientes</Chip>
            <Chip active={tray === 'reapproval'} onClick={() => setTray('reapproval')}>Re-aprobación</Chip>
            <Chip active={tray === 'queued'} onClick={() => setTray('queued')}>En cola</Chip>
            <Chip active={tray === 'kitchen'} onClick={() => setTray('kitchen')}>Cocina</Chip>
            <Chip active={tray === 'delivery'} onClick={() => setTray('delivery')}>Delivery</Chip>
            <Chip active={tray === 'finalized'} onClick={() => setTray('finalized')}>Finalizadas</Chip>
          </div>

          <div className="mt-4 overflow-hidden rounded-2xl border border-[#242433] bg-[#121218]">
            <div className="overflow-x-auto">
              <table className="w-full text-[12px]">
                <thead className="sticky top-0 z-10 border-b border-[#242433] bg-[#0B0B0D] text-[#B7B7C2]">
                  <tr>
                    <th className="px-2 py-2 text-left font-medium">Hora</th>
                    <th className="px-2 py-2 text-left font-medium">Orden</th>
                    <th className="px-2 py-2 text-left font-medium">Asesor</th>
                    <th className="px-2 py-2 text-left font-medium">Cliente</th>
                    <th className="px-2 py-2 text-left font-medium">Tipo</th>
                    <th className="px-2 py-2 text-left font-medium">Total</th>
                    <th className="px-2 py-2 text-left font-medium">Pendiente</th>
                    <th className="px-2 py-2 text-left font-medium">Pago</th>
                    <th className="px-2 py-2 text-left font-medium">Proceso</th>
                    <th className="px-2 py-2 text-left font-medium">Rider</th>
                    <th className="px-2 py-2 text-left font-medium">Entrega</th>
                    <th className="px-2 py-2 text-left font-medium">Dir</th>
                    <th className="px-2 py-2 text-left font-medium">Nota</th>
                    <th className="px-2 py-2 text-left font-medium">Acciones</th>
                  </tr>
                </thead>

                <tbody>
                  {tableOrders.length === 0 ? (
                    <tr>
                      <td className="px-2 py-6 text-center text-[#B7B7C2]" colSpan={14}>
                        Sin pedidos para este día/filtro.
                      </td>
                    </tr>
                  ) : (
                    tableOrders.map((o, idx) => {
                      const zebra = idx % 2 === 0 ? 'bg-[#121218]' : 'bg-[#151522]';
                      const flag = processFlag(o);
                      const statusLabel = ORDER_STATUS_LABEL[o.status];

                      const deliveryLabel =
                        o.status === 'out_for_delivery'
                          ? 'En camino'
                          : o.status === 'delivered'
                            ? 'Entregado'
                            : o.status === 'cancelled'
                              ? 'Cancelado'
                              : 'Pendiente';

                      const aName = splitTwoWordsCompact(o.advisorName);
                      const cName = splitTwoWordsCompact(o.clientName);
                      const rName = splitTwoWordsCompact(o.riderName || o.externalPartner || '—');

                      return (
                        <tr
                          key={o.id}
                          className={`${zebra} cursor-pointer border-b border-[#242433] hover:bg-[#191926]`}
                          onClick={() => onRowClick(o.id)}
                        >
                          <td className="px-2 py-2">{fmtTimeAMPM(o.deliveryAtISO)}</td>
                          <td className="px-2 py-2 font-medium">{o.id}</td>
                          <td className="px-2 py-2 leading-4">
                            <div>{aName.line1}</div>
                            <div className="text-[#B7B7C2]">{aName.line2}</div>
                          </td>
                          <td className="px-2 py-2 leading-4">
                            <div>{cName.line1}</div>
                            <div className="text-[#B7B7C2]">{cName.line2}</div>
                          </td>
                          <td className="px-2 py-2">
                            <span className="rounded-full border border-[#242433] bg-[#0B0B0D] px-2 py-0.5 text-[11px]">
                              {pillLabel(o.fulfillment)}
                            </span>
                          </td>
                          <td className="px-2 py-2">{fmtUSD(o.totalUsd)}</td>
                          <td className={['px-2 py-2 font-medium', paymentToneClass(o.balanceUsd)].join(' ')}>
                            {fmtUSD(o.balanceUsd)}
                          </td>
                          <td className="px-2 py-2" title={payIconTooltip(o.paymentVerify)}>
                            {payIcon(o.paymentVerify)}
                          </td>
                          <td className="px-2 py-2 leading-4">
                            <div className="text-[#F5F5F7]">{statusLabel}</div>
                            {flag ? (
                              <div className="mt-1">
                                <span
                                  className={[
                                    'inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold',
                                    flag === 'APROBAR' ? 'bg-[#FEEF00] text-[#0B0B0D]' : 'bg-orange-500 text-[#0B0B0D]',
                                  ].join(' ')}
                                >
                                  {flag}
                                </span>
                              </div>
                            ) : (
                              <div className="mt-1 text-[#8A8A96]">—</div>
                            )}
                          </td>
                          <td className="px-2 py-2 leading-4">
                            <div>{rName.line1}</div>
                            <div className="text-[#B7B7C2]">{rName.line2}</div>
                          </td>
                          <td className="px-2 py-2">{deliveryLabel}</td>
                          <td className="px-2 py-2" title={o.fulfillment === 'delivery' ? (o.address || '') : ''}>
                            {o.fulfillment === 'delivery' && (o.address?.trim() ? '📍' : '—')}
                          </td>
                          <td className="px-2 py-2" title={o.notes?.trim() ? o.notes : ''}>
                            {o.notes?.trim() ? '📝' : '—'}
                          </td>
                          <td className="px-2 py-2">
                            <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                              <button
                                className={[
                                  'rounded-lg border px-2 py-1 text-[11px]',
                                  canSendToKitchen(o)
                                    ? 'border-[#FEEF00] bg-[#0B0B0D] text-[#F5F5F7]'
                                    : 'border-[#242433] bg-[#0B0B0D] text-[#8A8A96]',
                                ].join(' ')}
                                title={kitchenTooltip(o)}
                                disabled={!canSendToKitchen(o)}
                                onClick={() => handleSendToKitchen(o.id)}
                              >
                                Cocina
                              </button>

                              <button
                                className={[
                                  'rounded-lg border px-2 py-1 text-[11px]',
                                  riderEnabled(o)
                                    ? 'border-[#242433] bg-[#0B0B0D] text-[#F5F5F7]'
                                    : 'border-[#242433] bg-[#0B0B0D] text-[#8A8A96]',
                                ].join(' ')}
                                title={riderTooltip(o)}
                                disabled={!riderEnabled(o)}
                                onClick={() => openOrderPanel(o.id, 'entrega')}
                              >
                                Rider
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      ) : viewMode === 'calculations' && isAdmin ? (
        <div className="mx-auto max-w-[1400px] px-5 py-5">
          {calculationsTab === 'advisors' ? (
            <div className="space-y-5">
              <div className="rounded-2xl border border-[#242433] bg-[#121218] p-4">
                <div className="flex flex-col gap-3">
                  <div>
                    <div className="text-sm font-semibold text-[#F5F5F7]">Análisis de asesores</div>
                    <div className="mt-1 text-sm text-[#B7B7C2]">
                      Revisa cierres, facturación, puntualidad de pago, clientes nuevos y pendientes por cobrar por asesor.
                    </div>
                  </div>

                  <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-[150px_150px_180px_220px]">
                    <FieldInput
                      label="Desde"
                      value={advisorCalcDateFrom}
                      onChange={setAdvisorCalcDateFrom}
                      type="date"
                    />
                    <FieldInput
                      label="Hasta"
                      value={advisorCalcDateTo}
                      onChange={setAdvisorCalcDateTo}
                      type="date"
                    />
                    <FieldSelect
                      label="Origen"
                      value={advisorCalcSource}
                      onChange={(value) => setAdvisorCalcSource(value as CalculationsSource)}
                      options={[
                        { value: '', label: 'Todos' },
                        { value: 'advisor', label: 'Advisor' },
                        { value: 'master', label: 'Master' },
                        { value: 'walk_in', label: 'Walk-in' },
                      ]}
                    />
                    <FieldSelect
                      label="Asesor"
                      value={advisorCalcAdvisorId}
                      onChange={setAdvisorCalcAdvisorId}
                      disabled={advisorCalcSource !== '' && advisorCalcSource !== 'advisor'}
                      options={[
                        { value: '', label: 'Todos los asesores' },
                        ...advisors.map((advisor) => ({
                          value: advisor.userId,
                          label: advisor.fullName,
                        })),
                      ]}
                    />
                  </div>

                </div>
              </div>

              <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-6">
                <Card title="Resumen General" className="p-3">
                  <StatRow label="Facturación" value={fmtUSD(advisorCalculatedData.facturacion)} />
                  <StatRow label="Cierres" value={advisorCalculatedData.cierres} />
                  <StatRow label="Cierre promedio" value={fmtUSD(advisorCalculatedData.cierrePromedio)} />
                  <StatRow label="Órdenes" value={advisorCalculatedData.filteredDeliveredOrders.length} />
                </Card>

                <Card title="Pagos" className="p-3">
                  <StatRow label="Pago puntual" value={advisorCalculatedData.pagoPuntual} />
                  <StatRow label="Pago impuntual" value={advisorCalculatedData.pagoImpuntual} />
                  <StatRow label="Pendientes" value={advisorCalculatedData.pendingOrders.length} highlightTone="warn" />
                </Card>

                <Card title="Clientes Nuevos" className="p-3">
                  <StatRow label="Propios" value={advisorCalculatedData.nuevosPropios} />
                  <StatRow label="Asignados" value={advisorCalculatedData.nuevosAsignados} />
                  <StatRow label="Total" value={advisorCalculatedData.nuevosPropios + advisorCalculatedData.nuevosAsignados} />
                </Card>

                <Card title="Pagos Pendientes" className="p-3">
                  <StatRow label="Total" value={fmtUSD(advisorCalculatedData.pendientesPorCobrarTotal)} highlightTone="warn" />
                  <StatRow label="Órdenes" value={advisorCalculatedData.pendingOrders.length} highlightTone="warn" />
                </Card>

                <Card title="Período" className="p-3">
                  <StatRow label="Desde" value={advisorCalcDateFrom || '—'} />
                  <StatRow label="Hasta" value={advisorCalcDateTo || '—'} />
                  <StatRow
                    label="Asesor"
                    value={
                      advisorCalcAdvisorId
                        ? advisorNameById.get(advisorCalcAdvisorId) ?? 'Asesor'
                        : 'Todos'
                    }
                  />
                  <StatRow
                    label="Origen"
                    value={
                      advisorCalcSource === 'advisor'
                        ? 'Advisor'
                        : advisorCalcSource === 'master'
                          ? 'Master'
                          : advisorCalcSource === 'walk_in'
                            ? 'Walk-in'
                            : 'Todos'
                    }
                  />
                </Card>

                <Card title="Origen de Ventas" className="p-3">
                  <StatRow label="Advisor" value={advisorCalculatedData.sourceCounts.advisor} />
                  <StatRow label="Master" value={advisorCalculatedData.sourceCounts.master} />
                  <StatRow label="Walk-in" value={advisorCalculatedData.sourceCounts.walkIn} />
                </Card>
              </div>

              <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
                <div className="rounded-2xl border border-[#242433] bg-[#121218]">
                  <div className="flex items-center justify-between border-b border-[#242433] px-4 py-3">
                    <div className="text-sm font-semibold text-[#F5F5F7]">Facturación</div>
                    <div className="text-sm font-semibold text-emerald-400">{fmtUSD(advisorCalculatedData.facturacion)}</div>
                  </div>
                  <div className="max-h-[360px] overflow-auto">
                    <table className="w-full text-[11px]">
                      <thead className="sticky top-0 z-10 bg-[#0B0B0D] text-[#B7B7C2]">
                        <tr>
                          <th className="px-3 py-2 text-left font-medium">Nro# Control</th>
                          <th className="px-3 py-2 text-left font-medium">Cliente</th>
                          <th className="px-3 py-2 text-left font-medium">Origen</th>
                          <th className="px-3 py-2 text-right font-medium">Facturado</th>
                        </tr>
                      </thead>
                      <tbody>
                        {advisorCalculatedData.filteredDeliveredOrders.length === 0 ? (
                          <tr>
                            <td className="px-3 py-6 text-center text-[#B7B7C2]" colSpan={4}>
                              Sin cierres entregados en el período.
                            </td>
                          </tr>
                        ) : (
                          advisorCalculatedData.filteredDeliveredOrders.map((order, idx) => (
                            <tr
                              key={order.id}
                              className={`${idx % 2 === 0 ? 'bg-[#121218]' : 'bg-[#151522]'} border-b border-[#242433]`}
                            >
                              <td className="px-3 py-2">{fmtShortOrderLabel(order.id)}</td>
                              <td className="px-3 py-2">{order.clientName}</td>
                              <td className="px-3 py-2">
                                {order.source === 'advisor'
                                  ? 'Advisor'
                                  : order.source === 'master'
                                    ? 'Master'
                                    : 'Walk-in'}
                              </td>
                              <td className="px-3 py-2 text-right">{fmtUSD(order.totalUsd)}</td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>

                <div className="rounded-2xl border border-[#242433] bg-[#121218]">
                  <div className="flex items-center justify-between border-b border-[#242433] px-4 py-3">
                    <div className="text-sm font-semibold text-[#F5F5F7]">Pendientes por Cobrar</div>
                    <div className="text-sm font-semibold text-orange-400">{fmtUSD(advisorCalculatedData.pendientesPorCobrarTotal)}</div>
                  </div>
                  <div className="max-h-[360px] overflow-auto">
                    <table className="w-full text-[11px]">
                      <thead className="sticky top-0 z-10 bg-[#0B0B0D] text-[#B7B7C2]">
                        <tr>
                          <th className="px-3 py-2 text-left font-medium">Nro# Control</th>
                          <th className="px-3 py-2 text-left font-medium">Cliente</th>
                          <th className="px-3 py-2 text-right font-medium">Pendiente</th>
                        </tr>
                      </thead>
                      <tbody>
                        {advisorCalculatedData.pendingOrders.length === 0 ? (
                          <tr>
                            <td className="px-3 py-6 text-center text-[#B7B7C2]" colSpan={4}>
                              Sin pendientes por cobrar.
                            </td>
                          </tr>
                        ) : (
                          advisorCalculatedData.pendingOrders.map((order, idx) => (
                            <tr
                              key={order.id}
                              className={`${idx % 2 === 0 ? 'bg-[#121218]' : 'bg-[#151522]'} border-b border-[#242433]`}
                            >
                              <td className="px-3 py-2">{fmtShortOrderLabel(order.id)}</td>
                              <td className="px-3 py-2">{order.clientName}</td>
                              <td className="px-3 py-2 text-right">{fmtUSD(order.balanceUsd)}</td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-1 gap-4 xl:grid-cols-1">
                <div className="hidden rounded-2xl border border-[#242433] bg-[#121218] p-4">
                  <div className="text-sm font-semibold text-[#F5F5F7]">Estado Pagos</div>
                  <div className="mt-4 space-y-3 text-sm">
                    <div className="flex items-center justify-between rounded-xl border border-[#242433] bg-[#0B0B0D] px-4 py-3">
                      <span className="text-[#F5F5F7]">Puntual</span>
                      <span className="text-lg font-semibold text-emerald-400">{advisorCalculatedData.pagoPuntual}</span>
                    </div>
                    <div className="flex items-center justify-between rounded-xl border border-[#242433] bg-[#0B0B0D] px-4 py-3">
                      <span className="text-[#F5F5F7]">Impuntual</span>
                      <span className="text-lg font-semibold text-orange-400">{advisorCalculatedData.pagoImpuntual}</span>
                    </div>
                  </div>
                </div>

                <div className="rounded-2xl border border-[#242433] bg-[#121218]">
                  <div className="flex items-center justify-between border-b border-[#242433] px-4 py-3">
                    <div className="text-sm font-semibold text-[#F5F5F7]">Clientes Nuevos</div>
                    <div className="text-sm font-semibold text-emerald-400">{advisorCalculatedData.clientesNuevos}</div>
                  </div>
                  <div className="max-h-[320px] overflow-auto">
                    <table className="w-full text-[11px]">
                      <thead className="sticky top-0 z-10 bg-[#0B0B0D] text-[#B7B7C2]">
                        <tr>
                          <th className="px-3 py-2 text-left font-medium">Tipo</th>
                          <th className="px-3 py-2 text-left font-medium">Cliente</th>
                          <th className="px-3 py-2 text-left font-medium">Nro# Control</th>
                          <th className="px-3 py-2 text-right font-medium">Cant.</th>
                        </tr>
                      </thead>
                      <tbody>
                        {advisorCalculatedData.newClientOrders.length === 0 ? (
                          <tr>
                            <td className="px-3 py-6 text-center text-[#B7B7C2]" colSpan={4}>
                              Sin clientes nuevos en el período.
                            </td>
                          </tr>
                        ) : (
                          advisorCalculatedData.newClientOrders.map((order, idx) => {
                            const client = order.clientId ? clientById.get(order.clientId) : null;
                            const typeRaw = String(client?.clientType || '').trim().toLowerCase();
                            const typeLabel =
                              typeRaw === 'own' || typeRaw === 'propio'
                                ? 'Propio'
                                : typeRaw === 'assigned' || typeRaw === 'asignado'
                                  ? 'Asignado'
                                  : 'Otro';

                            return (
                              <tr
                                key={order.id}
                                className={`${idx % 2 === 0 ? 'bg-[#121218]' : 'bg-[#151522]'} border-b border-[#242433]`}
                              >
                                <td className="px-3 py-2">{typeLabel}</td>
                                <td className="px-3 py-2">{order.clientName}</td>
                                <td className="px-3 py-2">{fmtShortOrderLabel(order.id)}</td>
                                <td className="px-3 py-2 text-right">1</td>
                              </tr>
                            );
                          })
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            </div>
          ) : null}
        </div>
      ) : (
        <div className="mx-auto max-w-[1400px] px-5 py-5">
          {settingsTab === 'catalog' ? (
            <div className="space-y-5">
             

              <div className="flex flex-col gap-3 rounded-2xl border border-[#242433] bg-[#121218] p-3 md:flex-row md:items-center md:justify-between">
  <div className="flex w-full flex-col gap-2 md:flex-row md:items-center">
    <input
      value={catalogSearch}
      onChange={(e) => setCatalogSearch(e.target.value)}
      placeholder="Buscar nombre o SKU…"
      className="w-full rounded-xl border border-[#242433] bg-[#0B0B0D] px-3 py-2 text-sm text-[#F5F5F7] placeholder:text-[#8A8A96] md:max-w-[280px]"
    />

    <select
      value={catalogTypeFilter}
      onChange={(e) => setCatalogTypeFilter(e.target.value as 'all' | CatalogItem['type'])}
      className="rounded-xl border border-[#242433] bg-[#0B0B0D] px-3 py-2 text-sm text-[#F5F5F7] md:w-[180px]"
    >
      <option value="all">Todos los tipos</option>
      <option value="product">Product</option>
      <option value="combo">Combo</option>
      <option value="service">Service</option>
      <option value="promo">Promo</option>
      <option value="gambit">Gambit</option>
    </select>
  </div>

  <div className="flex flex-wrap gap-2">
    <Btn onClick={() => setCreateCatalogOpen(true)}>
      Nuevo ítem
    </Btn>
  </div>
</div>

              <div className="mb-3 flex flex-wrap gap-2">
                <Btn onClick={openQuickCatalog}>
                  Actualizar precios
                </Btn>
              </div>

              <div className="overflow-hidden rounded-2xl border border-[#242433] bg-[#121218]">
                <div className="max-h-[70vh] overflow-y-auto overflow-x-hidden">
                  <table className="w-full table-fixed text-[12px]">
                    <thead className="sticky top-0 z-10 border-b border-[#242433] bg-[#0B0B0D] text-[#B7B7C2]">
                      <tr>
                        <th className="w-[54px] px-2 py-3 text-left text-[11px] font-medium">SKU</th>
                        <th className="w-[220px] px-2 py-3 text-left text-[11px] font-medium">Nombre</th>
                        <th className="w-[78px] px-2 py-3 text-left text-[11px] font-medium">Tipo</th>
                        <th className="w-[56px] px-2 py-3 text-left text-[11px] font-medium">Activo</th>
                        <th className="w-[72px] px-2 py-3 text-left text-[11px] font-medium">Moneda</th>
                        <th className="w-[104px] px-2 py-3 text-left text-[11px] font-medium">Monto fuente</th>
                        <th className="w-[104px] px-2 py-3 text-left text-[11px] font-medium">Precio Bs</th>
                        <th className="w-[86px] px-2 py-3 text-left text-[11px] font-medium">Precio $</th>
                        <th className="w-[70px] px-2 py-3 text-left text-[11px] font-medium">Und/serv.</th>
                        <th className="w-[58px] px-2 py-3 text-left text-[11px] font-medium">Detalle</th>
                        <th className="w-[56px] px-2 py-3 text-left text-[11px] font-medium">Límite</th>
                        <th className="w-[74px] px-2 py-3 text-left text-[11px] font-medium">Comp. combo</th>
                      </tr>
                    </thead>

                    <tbody>
                      {filteredCatalogItems.length === 0 ? (
                        <tr>
                          <td className="px-3 py-6 text-center text-[#B7B7C2]" colSpan={12}>
                            Sin datos de catálogo cargados aún.
                          </td>
                        </tr>
                      ) : (
                        filteredCatalogItems.map((item, idx) => {
                          const zebra = idx % 2 === 0 ? 'bg-[#121218]' : 'bg-[#151522]';

                          return (
                            <tr
                              key={item.id}
                              className={`${zebra} cursor-pointer border-b border-[#242433] align-top hover:bg-[#191926]`}
                              onClick={() => openCatalogDetail(item.id)}
                            >
                              <td className="px-2 py-3">
                                <div className="truncate text-[10px] text-[#8A8A96]" title={item.sku}>
                                  {item.sku}
                                </div>
                              </td>

                              <td className="px-2 py-3">
                                <div className="text-[12px] font-semibold leading-5 text-[#F5F5F7]">
                                  {item.name}
                                </div>
                              </td>

                              <td className="px-2 py-3 whitespace-nowrap">
                                <SmallBadge label={item.type} tone="muted" />
                              </td>

                              <td className="px-2 py-3 whitespace-nowrap">
                                {item.isActive ? (
                                  <span className="text-emerald-400">Sí</span>
                                ) : (
                                  <span className="text-[#8A8A96]">No</span>
                                )}
                              </td>

                              <td className="px-2 py-3 whitespace-nowrap text-[#F5F5F7]">
                                {item.sourcePriceCurrency}
                              </td>

                              <td className="px-2 py-3 whitespace-nowrap">
                                <div className="text-[11px] font-medium text-[#F5F5F7]">
                                  {item.sourcePriceCurrency === 'VES'
                                    ? fmtBs(item.sourcePriceAmount)
                                    : fmtUSD(item.sourcePriceAmount)}
                                </div>
                              </td>

                              <td className="px-2 py-3 whitespace-nowrap">
                                <div className="text-[11px] font-medium text-[#F5F5F7]">
                                  {fmtBs(item.basePriceBs)}
                                </div>
                              </td>

                              <td className="px-2 py-3 whitespace-nowrap">
                                <div className="text-[11px] font-medium text-[#F5F5F7]">
                                  {fmtUSD(item.basePriceUsd)}
                                </div>
                              </td>

                              <td className="px-2 py-3 whitespace-nowrap text-[#F5F5F7]">
                                {item.unitsPerService}
                              </td>

                              <td className="px-2 py-3 whitespace-nowrap">
                                {item.isDetailEditable ? (
                                  <span className="text-[#FEEF00]">Sí</span>
                                ) : (
                                  <span className="text-[#8A8A96]">No</span>
                                )}
                              </td>

                              <td className="px-2 py-3 whitespace-nowrap text-[#F5F5F7]">
                                {item.detailUnitsLimit}
                              </td>

                              <td className="px-2 py-3 whitespace-nowrap">
                                {item.isComboComponentSelectable ? (
                                  <span className="text-emerald-400">Sí</span>
                                ) : (
                                  <span className="text-[#8A8A96]">No</span>
                                )}
                              </td>
                            </tr>
                          );
                        })
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          ) : null}

          {settingsTab === 'exchange_rate' ? (
  <div className="max-w-[760px] space-y-4">
  <div className="rounded-2xl border border-[#242433] bg-[#121218] p-4 md:col-span-2">
    <div className="text-sm font-semibold text-[#F5F5F7]">Tasa activa</div>

    <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
      <InfoCell
        label="VES por USD"
        value={activeExchangeRate ? fmtRateBs(activeExchangeRate.rateBsPerUsd) : '—'}
      />
      <InfoCell
        label="Vigente desde"
        value={activeExchangeRate ? fmtDateTimeES(activeExchangeRate.effectiveAt) : '—'}
      />
    </div>
  </div>

  <div className="rounded-2xl border border-[#242433] bg-[#121218] p-4">
    <div className="text-sm font-semibold text-[#F5F5F7]">Actualizar tasa</div>

    <div className="mt-2 text-sm text-[#B7B7C2]">
      Esta tasa recalcula precios base en el catálogo según la lógica actual.
    </div>

    <div className="mt-4 max-w-sm">
      <FieldInput
        label="Nueva tasa (VES por USD)"
        value={exchangeRateInput}
        onChange={setExchangeRateInput}
        type="text"
      />
    </div>

    <div className="mt-4 flex gap-2">
      <button
        className="rounded-xl bg-[#FEEF00] px-4 py-2 text-sm font-semibold text-[#0B0B0D]"
        onClick={handleUpdateExchangeRate}
        disabled={exchangeRateSaving}
      >
        {exchangeRateSaving ? 'Guardando...' : 'Guardar tasa'}
      </button>
    </div>
  </div>
</div>
) : null}

          {settingsTab === 'accounts' ? (
  <div className="space-y-5">
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
      {(['USD', 'VES'] as const).map((currency) => (
        <div key={currency} className="rounded-2xl border border-[#242433] bg-[#121218] p-4">
          <div className="text-sm font-semibold text-[#F5F5F7]">Resumen {currency}</div>
          <div className="mt-4 grid grid-cols-2 gap-3">
            <InfoCell label="Cuentas activas" value={String(accountSummary[currency].activeCount)} />
            <InfoCell
              label={`Balance actual (${currency})`}
              value={fmtMoneyByCurrency(accountSummary[currency].balanceNative, currency)}
            />
            <InfoCell
              label={`Ingresos perÃ­odo (${currency})`}
              value={fmtMoneyByCurrency(accountSummary[currency].inflowNative, currency)}
            />
            <InfoCell
              label={`Egresos perÃ­odo (${currency})`}
              value={fmtMoneyByCurrency(accountSummary[currency].outflowNative, currency)}
            />
            <InfoCell
              label={currency === 'VES' ? 'Referencia $' : 'Referencia Bs'}
              value={
                currency === 'VES'
                  ? fmtUSD(accountSummary[currency].balanceUsdRef)
                  : fmtBs(accountSummary[currency].balanceNative * (activeExchangeRate?.rateBsPerUsd ?? 0))
              }
            />
          </div>
        </div>
      ))}
    </div>

    <div className="flex flex-col gap-3 rounded-2xl border border-[#242433] bg-[#121218] p-3 md:flex-row md:items-end md:justify-between">
      <div className="grid flex-1 grid-cols-1 gap-3 md:grid-cols-[minmax(0,1fr)_180px_180px]">
        <FieldInput label="Buscar cuenta" value={accountSearch} onChange={setAccountSearch} />
        <FieldInput label="Desde" value={accountDateFrom} onChange={setAccountDateFrom} type="date" />
        <FieldInput label="Hasta" value={accountDateTo} onChange={setAccountDateTo} type="date" />
      </div>

      <div className="flex gap-2">
        <Btn onClick={openCreateAccount}>Nueva cuenta</Btn>
      </div>
    </div>

    <div className="overflow-hidden rounded-2xl border border-[#242433] bg-[#121218]">
      <div className="max-h-[70vh] overflow-y-auto overflow-x-auto">
        <table className="w-full text-[12px]">
          <thead className="sticky top-0 z-10 border-b border-[#242433] bg-[#0B0B0D] text-[#B7B7C2]">
            <tr>
              <th className="px-3 py-3 text-left font-medium">Cuenta</th>
              <th className="px-3 py-3 text-left font-medium">Moneda</th>
              <th className="px-3 py-3 text-left font-medium">Tipo</th>
              <th className="px-3 py-3 text-left font-medium">InstituciÃ³n</th>
              <th className="px-3 py-3 text-left font-medium">Titular</th>
              <th className="px-3 py-3 text-left font-medium">Estado</th>
              <th className="px-3 py-3 text-left font-medium">Balance actual</th>
              <th className="px-3 py-3 text-left font-medium">Ingresos perÃ­odo</th>
              <th className="px-3 py-3 text-left font-medium">Egresos perÃ­odo</th>
              <th className="px-3 py-3 text-left font-medium">Detalle</th>
            </tr>
          </thead>
          <tbody>
            {filteredAccounts.length === 0 ? (
              <tr>
                <td className="px-3 py-6 text-center text-[#B7B7C2]" colSpan={10}>
                  No hay cuentas que coincidan con el filtro.
                </td>
              </tr>
            ) : (
              filteredAccounts.map((account, idx) => {
                const zebra = idx % 2 === 0 ? 'bg-[#121218]' : 'bg-[#151522]';
                const stats = accountStatsById.get(account.id) ?? {
                  balanceNative: 0,
                  periodInflowNative: 0,
                  periodOutflowNative: 0,
                  balanceUsdRef: 0,
                  periodInflowUsdRef: 0,
                  periodOutflowUsdRef: 0,
                };

                return (
                  <tr
                    key={account.id}
                    className={`${zebra} cursor-pointer border-b border-[#242433] align-top transition-colors hover:bg-[#1A1A28]`}
                    onClick={() => {
                      setSelectedAccountId(account.id);
                      setAccountDetailOpen(true);
                    }}
                  >
                    <td className="px-3 py-3">
                      <div className="font-semibold text-[#F5F5F7]">{account.name}</div>
                      {account.notes ? (
                        <div className="mt-1 text-[11px] text-[#8A8A96]">{account.notes}</div>
                      ) : null}
                    </td>
                    <td className="px-3 py-3">{account.currencyCode}</td>
                    <td className="px-3 py-3">{MONEY_ACCOUNT_KIND_LABEL[account.accountKind]}</td>
                    <td className="px-3 py-3">{account.institutionName || '—'}</td>
                    <td className="px-3 py-3">{account.ownerName || '—'}</td>
                    <td className="px-3 py-3">
                      {account.isActive ? (
                        <span className="text-emerald-400">Activa</span>
                      ) : (
                        <span className="text-[#8A8A96]">Inactiva</span>
                      )}
                    </td>
                    <td className="px-3 py-3">
                      <div>{fmtMoneyByCurrency(stats.balanceNative, account.currencyCode)}</div>
                      <div className="mt-1 text-[11px] text-[#8A8A96]">
                        {account.currencyCode === 'VES'
                          ? fmtUSD(stats.balanceUsdRef)
                          : fmtBs(stats.balanceNative * (activeExchangeRate?.rateBsPerUsd ?? 0))}
                      </div>
                    </td>
                    <td className="px-3 py-3 text-emerald-400">
                      <div>{fmtMoneyByCurrency(stats.periodInflowNative, account.currencyCode)}</div>
                      <div className="mt-1 text-[11px] text-[#8A8A96]">
                        {account.currencyCode === 'VES'
                          ? fmtUSD(stats.periodInflowUsdRef)
                          : fmtBs(stats.periodInflowNative * (activeExchangeRate?.rateBsPerUsd ?? 0))}
                      </div>
                    </td>
                    <td className="px-3 py-3 text-red-400">
                      <div>{fmtMoneyByCurrency(stats.periodOutflowNative, account.currencyCode)}</div>
                      <div className="mt-1 text-[11px] text-[#8A8A96]">
                        {account.currencyCode === 'VES'
                          ? fmtUSD(stats.periodOutflowUsdRef)
                          : fmtBs(stats.periodOutflowNative * (activeExchangeRate?.rateBsPerUsd ?? 0))}
                      </div>
                    </td>
                    <td className="px-3 py-3 text-[#B7B7C2]">Abrir ficha</td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  </div>
) : null}

          {settingsTab === 'clients' ? (
  <div className="space-y-5">
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
      <div className="rounded-2xl border border-[#242433] bg-[#121218] p-4">
        <div className="text-sm font-semibold text-[#F5F5F7]">Resumen clientes</div>
        <div className="mt-4 grid grid-cols-2 gap-3">
          <InfoCell label="Total" value={String(clientStats.total)} />
          <InfoCell label="Activos" value={String(clientStats.active)} />
          <InfoCell label="Con facturación" value={String(clientStats.withBilling)} />
          <InfoCell label="Con nota de entrega" value={String(clientStats.withDeliveryNote)} />
          <InfoCell label="Con direcciones" value={String(clientStats.withAddresses)} />
        </div>
      </div>

      <div className="rounded-2xl border border-[#242433] bg-[#121218] p-4">
        <div className="text-sm font-semibold text-[#F5F5F7]">Cómo usarlo</div>
        <div className="mt-4 space-y-2 text-sm text-[#B7B7C2]">
          <div>Guarda aquí la ficha base del cliente, sus etiquetas CRM y los datos para factura o nota de entrega.</div>
          <div>Las etiquetas se cargan libres, separadas por coma, para que ustedes mismos creen las categorías que usan en la operación.</div>
          <div>Las dos direcciones recientes guardan solo texto + GPS, como me pediste, para no complicar el flujo.</div>
        </div>
      </div>
    </div>

    <div className="flex flex-col gap-3 rounded-2xl border border-[#242433] bg-[#121218] p-3 md:flex-row md:items-end md:justify-between">
      <div className="flex-1">
        <FieldInput label="Buscar cliente" value={clientSearch} onChange={setClientSearch} />
      </div>

      <div className="flex gap-2">
        <Btn onClick={openCreateClient}>Nuevo cliente</Btn>
      </div>
    </div>

    <div className="overflow-hidden rounded-2xl border border-[#242433] bg-[#121218]">
      <div className="max-h-[70vh] overflow-y-auto overflow-x-auto">
        <table className="w-full text-[12px]">
          <thead className="sticky top-0 z-10 border-b border-[#242433] bg-[#0B0B0D] text-[#B7B7C2]">
            <tr>
              <th className="px-3 py-3 text-left font-medium">Cliente</th>
              <th className="px-3 py-3 text-left font-medium">Teléfono</th>
              <th className="px-3 py-3 text-left font-medium">Tipo</th>
              <th className="px-3 py-3 text-left font-medium">Asesor principal</th>
              <th className="px-3 py-3 text-left font-medium">Etiquetas</th>
              <th className="px-3 py-3 text-left font-medium">Factura</th>
              <th className="px-3 py-3 text-left font-medium">Nota de entrega</th>
              <th className="px-3 py-3 text-left font-medium">Estado</th>
              <th className="px-3 py-3 text-left font-medium">Detalle</th>
            </tr>
          </thead>
          <tbody>
            {filteredClients.length === 0 ? (
              <tr>
                <td className="px-3 py-6 text-center text-[#B7B7C2]" colSpan={9}>
                  No hay clientes que coincidan con el filtro.
                </td>
              </tr>
            ) : (
              filteredClients.map((client, idx) => {
                const zebra = idx % 2 === 0 ? 'bg-[#121218]' : 'bg-[#151522]';
                const tags = normalizeClientTags(client.crmTags);
                const hasBilling = Boolean(
                  client.billingCompanyName ||
                    client.billingTaxId ||
                    client.billingAddress ||
                    client.billingPhone
                );
                const hasDeliveryNote = Boolean(
                  client.deliveryNoteName ||
                    client.deliveryNoteDocumentId ||
                    client.deliveryNoteAddress ||
                    client.deliveryNotePhone
                );

                return (
                  <tr
                    key={client.id}
                    className={`${zebra} cursor-pointer border-b border-[#242433] align-top transition-colors hover:bg-[#1A1A28]`}
                    onClick={() => {
                      setSelectedClientId(client.id);
                      setClientDetailOpen(true);
                    }}
                  >
                    <td className="px-3 py-3">
                      <div className="font-semibold text-[#F5F5F7]">{client.fullName}</div>
                      {client.notes ? (
                        <div className="mt-1 text-[11px] text-[#8A8A96]">{client.notes}</div>
                      ) : null}
                    </td>
                    <td className="px-3 py-3">{client.phone || '—'}</td>
                    <td className="px-3 py-3">{client.clientType || '—'}</td>
                    <td className="px-3 py-3">
                      {client.primaryAdvisorId
                        ? advisorNameById.get(client.primaryAdvisorId) || 'Asesor'
                        : '—'}
                    </td>
                    <td className="px-3 py-3">
                      {tags.length > 0 ? (
                        <div className="flex max-w-[220px] flex-wrap gap-1">
                          {tags.slice(0, 4).map((tag) => (
                            <SmallBadge key={tag} label={tag} tone="muted" />
                          ))}
                          {tags.length > 4 ? (
                            <span className="text-[11px] text-[#8A8A96]">+{tags.length - 4}</span>
                          ) : null}
                        </div>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="px-3 py-3">{hasBilling ? 'Cargado' : 'Pendiente'}</td>
                    <td className="px-3 py-3">{hasDeliveryNote ? 'Cargado' : 'Pendiente'}</td>
                    <td className="px-3 py-3">
                      {client.isActive ? (
                        <span className="text-emerald-400">Activo</span>
                      ) : (
                        <span className="text-[#8A8A96]">Inactivo</span>
                      )}
                    </td>
                    <td className="px-3 py-3 text-[#B7B7C2]">Abrir ficha</td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  </div>
) : null}
        </div>
      )}

      <Drawer open={notifOpen} title={`Notificaciones (${notifications.length})`} onClose={() => setNotifOpen(false)} widthClass="w-[420px]">
        {notifications.length === 0 ? (
          <div className="text-sm text-[#B7B7C2]">Sin notificaciones.</div>
        ) : (
          <div className="space-y-3">
            {notifications.map((n) => (
              <div key={n.id} className="rounded-2xl border border-[#242433] bg-[#121218] p-3">
                <div className="flex items-center justify-between gap-2">
                  <SmallBadge label={n.type} tone={n.type === 'APROBAR' ? 'brand' : 'warn'} />
                  <div className="text-xs text-[#B7B7C2]">{n.deliveryText}</div>
                </div>
                <div className="mt-2 text-sm font-semibold">{n.label}</div>
                <div className="mt-1 text-xs text-[#B7B7C2]">Asesor: {n.advisorName}</div>

                <button
                  className="mt-3 w-full rounded-xl border border-[#242433] bg-[#0B0B0D] px-3 py-2 text-sm"
                  onClick={() => {
                    setNotifOpen(false);
                    openOrderPanel(n.orderId, n.type === 'CONFIRMAR PAGO' ? 'pagos' : 'detalle');
                  }}
                >
                  Abrir
                </button>
              </div>
            ))}
          </div>
        )}
      </Drawer>

      <Drawer open={productsExpanded} title="Productos comprometidos (und)" onClose={() => setProductsExpanded(false)} widthClass="w-[520px]">
        {committedList.length === 0 ? (
          <div className="text-sm text-[#B7B7C2]">Sin datos.</div>
        ) : (
          <div className="space-y-3">
            {committedList.map((p) => (
              <div key={p.name} className="rounded-2xl border border-[#242433] bg-[#121218] p-3">
                <div className="flex items-center justify-between">
                  <div className="text-sm font-semibold">{p.name}</div>
                  <div className="text-sm text-[#B7B7C2]">{p.und} und</div>
                </div>
                <div className="mt-2 h-1.5 w-full rounded-full bg-[#191926]">
                  <div
                    className="h-1.5 rounded-full bg-[#FEEF00]"
                    style={{ width: `${Math.max(4, Math.round((p.und / (committedList[0]?.und ?? 1)) * 100))}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </Drawer>

      <Drawer
        open={catalogDetailOpen}
        title={selectedCatalogItem ? selectedCatalogItem.name : 'Detalle de producto'}
        onClose={closeCatalogDetail}
        widthClass="w-[760px]"
      >
        {!selectedCatalogItem ? (
          <div className="text-sm text-[#B7B7C2]">Sin producto seleccionado.</div>
        ) : (
          <div className="space-y-4">
            {!catalogEditMode ? (
              <>
                <div className="rounded-2xl border border-[#242433] bg-[#121218] p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-lg font-semibold text-[#F5F5F7]">{selectedCatalogItem.name}</div>
                      <div className="mt-1 text-xs text-[#8A8A96]" title={selectedCatalogItem.sku}>
                        SKU: {selectedCatalogItem.sku || '—'}
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      <SmallBadge
                        label={productCompositionKind(
                          selectedCatalogItem,
                          selectedCatalogItem.sku,
                          selectedCatalogComponents
                        )}
                        tone="brand"
                      />
                      <SmallBadge label={selectedCatalogItem.type} tone="muted" />
                      <SmallBadge label={selectedCatalogItem.isActive ? 'Activo' : 'Inactivo'} tone={selectedCatalogItem.isActive ? 'brand' : 'muted'} />
                    </div>
                  </div>

                    <div className="mt-4 rounded-2xl border border-[#242433] bg-[#0B0B0D] p-4">
                        <div className="flex flex-wrap items-center gap-2">
                            <SmallBadge label={selectedOperationalModel.label} tone="brand" />
                            <SmallBadge label={selectedCatalogItem.type} tone="muted" />
                        </div>

                        <div className="mt-3 text-sm text-[#B7B7C2]">
                            {selectedOperationalModel.summary}
                        </div>

                        <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
                            <InfoCell label="Comp. fijos" value={String(editFixedComponents.length)} />
                            <InfoCell label="Comp. seleccionables" value={String(editSelectableComponents.length)} />
                            <InfoCell label="Und fijas (cuentan)" value={String(editFixedUnitsCount)} />
                            <InfoCell label="Und seleccionables (cuentan)" value={String(editSelectableUnitsCount)} />
                        </div>

                        {editIsDetailEditable ? (
                            <div className="mt-3 rounded-xl border border-[#242433] bg-[#121218] px-3 py-3 text-sm text-[#B7B7C2]">
                            <span className="text-[#F5F5F7]">Límite actual:</span>{' '}
                            {editDetailUnitsLimit || '0'} piezas seleccionables
                            </div>
                        ) : null}
                        </div>

                  <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
                    <InfoCell label="Moneda fuente" value={selectedCatalogItem.sourcePriceCurrency} />
                    <InfoCell
                      label="Monto fuente"
                      value={
                        selectedCatalogItem.sourcePriceCurrency === 'VES'
                          ? fmtBs(selectedCatalogItem.sourcePriceAmount)
                          : fmtUSD(selectedCatalogItem.sourcePriceAmount)
                      }
                    />
                    <InfoCell label="Precio Bs" value={fmtBs(selectedCatalogItem.basePriceBs)} />
                    <InfoCell label="Precio $" value={fmtUSD(selectedCatalogItem.basePriceUsd)} />
                    <InfoCell label="Und/servicio" value={String(selectedCatalogItem.unitsPerService)} />
                    <InfoCell label="Detalle editable" value={selectedCatalogItem.isDetailEditable ? 'Sí' : 'No'} />
                    <InfoCell label="Límite detalle" value={String(selectedCatalogItem.detailUnitsLimit)} />
                    <InfoCell
                      label="Puede ser comp. combo"
                      value={selectedCatalogItem.isComboComponentSelectable ? 'Sí' : 'No'}
                    />
                  </div>
                </div>

                <div className="rounded-2xl border border-[#242433] bg-[#121218] p-4">
  <div className="flex items-center justify-between gap-3">
    <div className="text-sm font-semibold text-[#F5F5F7]">Regla operativa</div>

    <div className="flex flex-wrap gap-2">
      <button
        className="rounded-xl border border-[#242433] bg-[#0B0B0D] px-3 py-2 text-sm"
        onClick={() => setCatalogEditMode(true)}
      >
        Editar
      </button>

      <button
        className="rounded-xl border border-[#242433] bg-[#0B0B0D] px-3 py-2 text-sm"
        onClick={handleToggleCatalogItemActive}
      >
        {selectedCatalogItem.isActive ? 'Desactivar' : 'Activar'}
      </button>

      <button
        className="rounded-xl border border-red-500 bg-[#0B0B0D] px-3 py-2 text-sm text-red-400"
        onClick={handleDeleteCatalogItem}
      >
        Eliminar
      </button>
    </div>
  </div>

  <div className="mt-3 space-y-2 text-sm text-[#B7B7C2]">
    {selectedCatalogItem.isDetailEditable ? (
      <>
        <div>
          Este ítem funciona como un <span className="text-[#F5F5F7]">plato configurable</span>.
        </div>
        <div>
          El asesor puede cargar piezas seleccionables sin superar el límite máximo de{' '}
          <span className="text-[#F5F5F7]">{selectedCatalogItem.detailUnitsLimit}</span>.
        </div>
        {selectedFixedComponents.length > 0 ? (
          <div>
            Además, este plato tiene <span className="text-[#F5F5F7]">componentes fijos u opcionales</span>.
          </div>
        ) : null}
      </>
    ) : selectedCatalogItem.sku.startsWith('MIX_') ? (
      <div>
        Este ítem funciona como un <span className="text-[#F5F5F7]">mixto fijo</span> con cantidades cerradas.
      </div>
    ) : selectedCatalogComponents.length > 0 ? (
      <div>
        Este ítem funciona como un <span className="text-[#F5F5F7]">combo fijo</span>.
        Su receta debe descontar exactamente los componentes definidos abajo.
      </div>
    ) : (
      <div>
        Este ítem no tiene composición cargada todavía.
      </div>
    )}
  </div>
</div>

                <div className="rounded-2xl border border-[#242433] bg-[#121218] p-4">
                  <div className="text-sm font-semibold text-[#F5F5F7]">Componentes fijos / opcionales</div>

                  {selectedFixedComponents.length === 0 ? (
                    <div className="mt-3 text-sm text-[#B7B7C2]">Sin componentes fijos.</div>
                  ) : (
                    <div className="mt-3 space-y-2">
{selectedFixedComponents.map((pc) => (
  <ComponentCard key={pc.id} pc={pc} catalogItems={catalogItems} />
))}
                    </div>
                  )}
                </div>

                <div className="rounded-2xl border border-[#242433] bg-[#121218] p-4">
                  <div className="text-sm font-semibold text-[#F5F5F7]">Componentes seleccionables</div>

                  {selectedSelectableComponents.length === 0 ? (
                    <div className="mt-3 text-sm text-[#B7B7C2]">Sin componentes seleccionables.</div>
                  ) : (
                    <div className="mt-3 space-y-2">
{selectedSelectableComponents.map((pc) => (
  <ComponentCard key={pc.id} pc={pc} catalogItems={catalogItems} />
))}
                    </div>
                  )}
                </div>
              </>
            ) : (
              <>
                <div className="rounded-2xl border border-[#242433] bg-[#121218] p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-sm font-semibold text-[#F5F5F7]">Editar catálogo</div>
                    <div className="flex gap-2">
                      <button
                        className="rounded-xl border border-[#242433] bg-[#0B0B0D] px-3 py-2 text-sm"
                        onClick={() => setCatalogEditMode(false)}
                        disabled={catalogSaving}
                      >
                        Cancelar
                      </button>
                      <button
                        className="rounded-xl bg-[#FEEF00] px-3 py-2 text-sm font-semibold text-[#0B0B0D]"
                        onClick={handleSaveCatalog}
                        disabled={catalogSaving}
                      >
                        {catalogSaving ? 'Guardando...' : 'Guardar'}
                      </button>
                    </div>
                  </div>

                  <div className="mt-4 grid grid-cols-2 gap-3">
                    <FieldCheckbox
                      label="Activo"
                      checked={editIsActive}
                      onChange={setEditIsActive}
                    />
                    <FieldCheckbox
                      label="Inventariable"
                      checked={editIsInventoryItem}
                      onChange={setEditIsInventoryItem}
                    />
                    <FieldCheckbox
                      label="Detalle editable"
                      checked={editIsDetailEditable}
                      onChange={setEditIsDetailEditable}
                    />
                    <FieldCheckbox
                      label="Temporal"
                      checked={editIsTemporary}
                      onChange={setEditIsTemporary}
                    />
                    <FieldCheckbox
                      label="Puede ser comp. combo"
                      checked={editIsComboComponentSelectable}
                      onChange={setEditIsComboComponentSelectable}
                    />

                    <FieldSelect
                      label="Moneda fuente"
                      value={editSourcePriceCurrency}
                      onChange={(v) => setEditSourcePriceCurrency(v as 'VES' | 'USD')}
                      options={[
                        { value: 'VES', label: 'VES' },
                        { value: 'USD', label: 'USD' },
                      ]}
                    />

                    <FieldInput
                      label="Monto fuente"
                      value={editSourcePriceAmount}
                      onChange={setEditSourcePriceAmount}
                      type="text"
                    />
                    <FieldInput
                      label="Und/servicio"
                      value={editUnitsPerService}
                      onChange={setEditUnitsPerService}
                      type="number"
                    />
                    <FieldInput
                      label="Límite detalle"
                      value={editDetailUnitsLimit}
                      onChange={setEditDetailUnitsLimit}
                      type="number"
                    />
                  </div>
                </div>

                <div className="rounded-2xl border border-[#242433] bg-[#121218] p-4">
                  <div className="text-sm font-semibold text-[#F5F5F7]">Comisión</div>
                  <div className="mt-4 grid grid-cols-2 gap-3">
                    <FieldSelect
                      label="Regla comisión"
                      value={editCommissionMode}
                      onChange={(v) => setEditCommissionMode(v as 'default' | 'fixed_item' | 'fixed_order')}
                      options={[
                        { value: 'default', label: 'Default' },
                        { value: 'fixed_item', label: 'Fija por ítem' },
                        { value: 'fixed_order', label: 'Fija por orden' },
                      ]}
                    />
                    <FieldInput
                      label="Valor comisión"
                      value={editCommissionValue}
                      onChange={setEditCommissionValue}
                      type="text"
                    />
                  </div>
                  <div className="mt-3">
                    <FieldInput
                      label="Notas comisión"
                      value={editCommissionNotes}
                      onChange={setEditCommissionNotes}
                    />
                  </div>
                </div>

                <div className="rounded-2xl border border-[#242433] bg-[#121218] p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-sm font-semibold text-[#F5F5F7]">Composición</div>
                    <button
                      className="rounded-xl border border-[#242433] bg-[#0B0B0D] px-3 py-2 text-sm"
                      onClick={addEditComponent}
                    >
                      Agregar componente
                    </button>
                  </div>

                  <div className="mt-4 space-y-5">
  <div>
    <div className="mb-2 text-sm font-semibold text-[#F5F5F7]">
      Componentes fijos / opcionales
    </div>

    {editFixedComponents.length === 0 ? (
      <div className="rounded-xl border border-[#242433] bg-[#0B0B0D] px-3 py-3 text-sm text-[#B7B7C2]">
        Sin componentes fijos.
      </div>
    ) : (
      <div className="space-y-3">
        {editFixedComponents
          .slice()
          .sort((a, b) => a.sortOrder - b.sortOrder)
          .map((row, idx) => (
            <div key={row.localId} className="rounded-xl border border-[#242433] bg-[#0B0B0D] p-3">
              <div className="mb-3 flex items-center justify-between gap-3">
                <div className="text-sm font-medium text-[#F5F5F7]">
                  Fijo #{idx + 1}
                </div>
                <button
                  className="rounded-lg border border-red-500 bg-[#0B0B0D] px-2 py-1 text-xs text-red-400"
                  onClick={() => removeEditComponent(row.localId)}
                >
                  Quitar
                </button>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <FieldSelect
                  label="Producto"
                  value={String(row.componentProductId)}
                  onChange={(v) =>
                    updateEditComponent(row.localId, {
                      componentProductId: Number(v),
                    })
                  }
                  options={selectableComponentOptions.map((item) => ({
                    value: String(item.id),
                    label: item.label,
                  }))}
                />

                <FieldSelect
                  label="Modo"
                  value={row.componentMode}
                  onChange={(v) =>
                    updateEditComponent(row.localId, {
                      componentMode: v as 'fixed' | 'selectable',
                    })
                  }
                  options={[
                    { value: 'fixed', label: 'fixed' },
                    { value: 'selectable', label: 'selectable' },
                  ]}
                />
<div>
  <label className="mb-1 block text-xs text-[#8A8A96]">Cantidad</label>

  <input
  value={String(row.quantity)}
  onChange={(e) =>
    updateEditComponent(row.localId, {
      quantity: Number(e.target.value || 0),
    })
  }
  type="number"
  min={1}
  className="w-full rounded-xl border border-[#242433] bg-[#0B0B0D] px-3 py-2 text-sm text-[#F5F5F7]"
/>

</div>

                
                <FieldCheckbox
                  label="Cuenta para límite"
                  checked={row.countsTowardDetailLimit}
                  onChange={(v) =>
                    updateEditComponent(row.localId, {
                      countsTowardDetailLimit: v,
                    })
                  }
                />

                <FieldCheckbox
                  label="Requerido"
                  checked={row.isRequired}
                  onChange={(v) =>
                    updateEditComponent(row.localId, {
                      isRequired: v,
                    })
                  }
                />
              </div>

              <div className="mt-3">
                <label className="mb-1 block text-xs text-[#8A8A96]">Notas</label>
                <input
                  value={row.notes}
                  onChange={(e) =>
                    updateEditComponent(row.localId, {
                      notes: e.target.value,
                    })
                  }
                  className="w-full rounded-xl border border-[#242433] bg-[#121218] px-3 py-2 text-sm text-[#F5F5F7]"
                  placeholder="Opcional"
                />
              </div>
            </div>
          ))}
      </div>
    )}
  </div>

  <div>
    <div className="mb-2 text-sm font-semibold text-[#F5F5F7]">
      Componentes seleccionables
    </div>

    {editSelectableComponents.length === 0 ? (
      <div className="rounded-xl border border-[#242433] bg-[#0B0B0D] px-3 py-3 text-sm text-[#B7B7C2]">
        Sin componentes seleccionables.
      </div>
    ) : (
      <div className="space-y-3">
        {editSelectableComponents
          .slice()
          .sort((a, b) => a.sortOrder - b.sortOrder)
          .map((row, idx) => (
            <div key={row.localId} className="rounded-xl border border-[#242433] bg-[#0B0B0D] p-3">
              <div className="mb-3 flex items-center justify-between gap-3">
                <div className="text-sm font-medium text-[#F5F5F7]">
                  Seleccionable #{idx + 1}
                </div>
                <button
                  className="rounded-lg border border-red-500 bg-[#0B0B0D] px-2 py-1 text-xs text-red-400"
                  onClick={() => removeEditComponent(row.localId)}
                >
                  Quitar
                </button>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <FieldSelect
                  label="Producto"
                  value={String(row.componentProductId)}
                  onChange={(v) =>
                    updateEditComponent(row.localId, {
                      componentProductId: Number(v),
                    })
                  }
                  options={selectableComponentOptions.map((item) => ({
                    value: String(item.id),
                    label: item.label,
                  }))}
                />

                <FieldSelect
                  label="Modo"
                  value={row.componentMode}
                  onChange={(v) =>
                    updateEditComponent(row.localId, {
                      componentMode: v as 'fixed' | 'selectable',
                    })
                  }
                  options={[
                    { value: 'fixed', label: 'fixed' },
                    { value: 'selectable', label: 'selectable' },
                  ]}
                />
              </div>

              <div className="mt-3">
                <label className="mb-1 block text-xs text-[#8A8A96]">Notas</label>
                <input
                  value={row.notes}
                  onChange={(e) =>
                    updateEditComponent(row.localId, {
                      notes: e.target.value,
                    })
                  }
                  className="w-full rounded-xl border border-[#242433] bg-[#121218] px-3 py-2 text-sm text-[#F5F5F7]"
                  placeholder="Opcional"
                />
              </div>
            </div>
          ))}
      </div>
    )}
  </div>
</div>
                </div>
              </>
            )}
          </div>
        )}
      </Drawer>

      <Drawer
        open={detailOpen}
        title={selectedOrder ? `${selectedOrder.id} · ${selectedOrder.clientName}` : 'Detalle'}
onClose={() => {
  setDetailOpen(false);
  resetDeliveryAssignBox();
  resetPaymentReportBox();
  resetReviewActionBox();
  resetKitchenTakeBox();
  resetDeliveryEtaBox();
  resetCancelOrderBox();
  resetReturnToQueueBox();
}}
        widthClass="w-[720px]"
      >
        {!selectedOrder ? (
          <div className="text-sm text-[#B7B7C2]">Sin pedido seleccionado.</div>
        ) : (
          <div className="space-y-4">
<div className="rounded-xl border border-[#1D1D28] bg-[#101014] px-2.5 py-1.5">
  <div className="flex items-start justify-between gap-3">
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-1.5 text-[13px] font-semibold text-[#F5F5F7]">
        <span>Orden #{selectedOrder.id} · {selectedOrder.clientName}</span>
        <span className="text-[#8A8A96]">·</span>
        <span>{fmtUSD(selectedOrder.totalUsd)}</span>
        <span className={paymentToneClass(selectedOrder.balanceUsd)}>
          {paymentLabel(selectedOrder.balanceUsd)}
        </span>
      </div>

      <div className="mt-0.5 flex flex-wrap items-center gap-1 text-[10px] text-[#8A8A96]">
        <span>{selectedOrder.advisorName}</span>
        <span>·</span>
        <span>{fmtDeliveryTextES(selectedOrder.deliveryAtISO)}</span>
        <SmallBadge label={ORDER_STATUS_LABEL[selectedOrder.status]} tone="muted" />
        <SmallBadge label={selectedOrder.fulfillment === 'delivery' ? 'Delivery' : 'Pickup'} tone="muted" />
        {processFlag(selectedOrder) === 'APROBAR' ? <SmallBadge label="APROBAR" tone="brand" /> : null}
        {processFlag(selectedOrder) === 'RE-APROBAR' ? <SmallBadge label="RE-APROBAR" tone="warn" /> : null}
        {selectedOrder.paymentVerify === 'pending' ? <SmallBadge label="PAGO: POR CONFIRMAR" tone="warn" /> : null}
      </div>
    </div>

    <button
      className="shrink-0 rounded-md border border-[#2A2A38] bg-[#0D0D11] px-2 py-1 text-[11px] text-[#F5F5F7]"
      onClick={() => handleCopyOrderWhatsApp(selectedOrder)}
      type="button"
    >
      Copiar WS
    </button>
  </div>
</div>

<ProcessTimeline order={selectedOrder} />

<NextActionCard
  order={selectedOrder}
  onSendToKitchen={() => handleSendToKitchen(selectedOrder.id)}
  onPrepareKitchenTake={() => {
    setKitchenTakeBoxOpen(true);
    setKitchenEtaMinutes('15');
  }}
  onMarkReady={() => handleMarkReady(selectedOrder)}
  onOutForDelivery={() => openDeliveryEtaBox(selectedOrder)}
  onMarkDelivered={() => handleMarkDelivered(selectedOrder)}
/>
            <div className="flex gap-1 items-center overflow-x-auto">
              <Chip active={detailTab === 'detalle'} onClick={() => setDetailTab('detalle')}>Pedido</Chip>
              <Chip active={detailTab === 'entrega'} onClick={() => setDetailTab('entrega')}>Entrega</Chip>
              <Chip active={detailTab === 'pagos'} onClick={() => setDetailTab('pagos')}>Pagos</Chip>
              <Chip active={detailTab === 'notas'} onClick={() => setDetailTab('notas')}>Notas</Chip>
            </div>

<div className="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1fr)_190px] lg:items-start">
  <div className="min-w-0">
    {detailTab === 'detalle' ? (
      <div className="rounded-xl border border-[#1D1D28] bg-[#101014] p-3">
        <div className="text-sm font-semibold text-[#F5F5F7]">Pedido</div>

        <div className="mt-2 space-y-2 text-sm">
          {orderMainLinesForPreview(selectedOrder.lines).length === 0 ? (
            <div className="text-[#B7B7C2]">Sin ítems cargados.</div>
          ) : (
            orderMainLinesForPreview(selectedOrder.lines).map((line, idx) => (
              <div key={idx} className="leading-5">
                <div className="text-[#F5F5F7]">{lineTextWhatsAppStyle(line)}</div>
                {line.editableDetailLines && line.editableDetailLines.length > 0 ? (
                  <div className="mt-1 space-y-1 pl-4 text-xs text-[#B7B7C2]">
                    {line.editableDetailLines.slice(0, 10).map((t, i) => (
                      <div key={i}>• {t}</div>
                    ))}
                  </div>
                ) : null}
              </div>
            ))
          )}
        </div>

        {(() => {
          const pricing = selectedOrder?.editMeta;
          const discountEnabled = !!pricing?.discountEnabled;
          const discountPct = Number(pricing?.discountPct || 0);
          const subtotalUsd = pricing?.subtotalUsd ?? selectedOrder.totalUsd;
          const subtotalBs = pricing?.subtotalBs ?? selectedOrder.totalBs;
          const subtotalAfterDiscountUsd =
            pricing?.subtotalAfterDiscountUsd ?? selectedOrder.totalUsd;
          const subtotalAfterDiscountBs =
            pricing?.subtotalAfterDiscountBs ?? selectedOrder.totalBs;
          const discountUsd = Math.max(0, subtotalUsd - subtotalAfterDiscountUsd);
          const discountBs = Math.max(0, subtotalBs - subtotalAfterDiscountBs);
          const invoiceTaxPct = Number(pricing?.invoiceTaxPct || 0);
          const invoiceTaxUsd = Number(pricing?.invoiceTaxAmountUsd || 0);
          const invoiceTaxBs = Number(pricing?.invoiceTaxAmountBs || 0);
          const showNetSubtotal =
            (discountEnabled && discountPct > 0) ||
            (pricing?.hasInvoice && invoiceTaxPct > 0);

          return (
            <div className="mt-3 space-y-1 border-t border-[#1D1D28] pt-3 text-xs">
              <div className="flex items-center justify-between text-[#B7B7C2]">
                <span>Subtotal</span>
                <span>{fmtBs(subtotalBs)} / {fmtUSD(subtotalUsd)}</span>
              </div>

              {discountEnabled && discountPct > 0 ? (
                <div className="flex items-center justify-between text-orange-400">
                  <span>Descuento ({discountPct}%)</span>
                  <span>-{fmtBs(discountBs)} / -{fmtUSD(discountUsd)}</span>
                </div>
              ) : null}

              {showNetSubtotal ? (
                <div className="flex items-center justify-between text-[#B7B7C2]">
                  <span>Subtotal con descuento</span>
                  <span>{fmtBs(subtotalAfterDiscountBs)} / {fmtUSD(subtotalAfterDiscountUsd)}</span>
                </div>
              ) : null}

              {pricing?.hasInvoice && invoiceTaxPct > 0 ? (
                <div className="flex items-center justify-between text-sky-300">
                  <span>IVA ({invoiceTaxPct}%)</span>
                  <span>+{fmtBs(invoiceTaxBs)} / +{fmtUSD(invoiceTaxUsd)}</span>
                </div>
              ) : null}

              <div className="flex items-center justify-between text-sm font-semibold text-[#F5F5F7]">
                <span>Total</span>
                <span>{fmtBs(selectedOrder.totalBs)} / {fmtUSD(selectedOrder.totalUsd)}</span>
              </div>
            </div>
          );
        })()}
        {selectedOrder.notes?.trim() ? (
          <div className="mt-3 rounded-lg border border-[#242433] bg-[#0B0B0D] px-3 py-3 text-sm text-[#B7B7C2]">
            <span className="text-[#F5F5F7]">Nota del pedido:</span> {selectedOrder.notes.trim()}
          </div>
        ) : null}
      </div>
    ) : null}

{detailTab === 'entrega' ? (
  <div className="rounded-xl border border-[#1D1D28] bg-[#101014] p-3">
    <div className="flex items-center justify-between gap-2">
      <div className="text-sm font-semibold text-[#F5F5F7]">Entrega</div>

      <SmallBadge
        label={
          selectedOrder.fulfillment === 'delivery'
            ? selectedOrder.riderName
              ? 'Asignado interno'
              : selectedOrder.externalPartner
                ? 'Asignado externo'
                : 'Sin asignar'
            : 'Pickup'
        }
        tone={
          selectedOrder.fulfillment === 'pickup'
            ? 'muted'
            : selectedOrder.riderName || selectedOrder.externalPartner
              ? 'brand'
              : 'warn'
        }
      />
    </div>

    <div className="mt-3 grid grid-cols-1 gap-2">
      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-lg border border-[#242433] bg-[#0B0B0D] px-3 py-2">
          <div className="text-[10px] text-[#8A8A96]">Tipo</div>
          <div className="mt-1 text-sm text-[#F5F5F7]">
            {selectedOrder.fulfillment === 'delivery' ? 'Delivery' : 'Pickup'}
          </div>
        </div>

        <div className="rounded-lg border border-[#242433] bg-[#0B0B0D] px-3 py-2">
          <div className="text-[10px] text-[#8A8A96]">Hora</div>
          <div className="mt-1 text-sm text-[#F5F5F7]">
            {fmtDeliveryTextES(selectedOrder.deliveryAtISO)}
          </div>
        </div>
      </div>

      {selectedOrder.fulfillment === 'delivery' && selectedOrder.editMeta?.deliveryEtaMinutes ? (
        <div className="rounded-lg border border-[#242433] bg-[#0B0B0D] px-3 py-2">
          <div className="text-[10px] text-[#8A8A96]">Tiempo estimado</div>
          <div className="mt-1 text-sm text-[#F5F5F7]">
            {selectedOrder.editMeta.deliveryEtaMinutes} min
          </div>
        </div>
      ) : null}

      {selectedOrder.fulfillment === 'delivery' ? (
        <>
          <div className="rounded-lg border border-[#242433] bg-[#0B0B0D] px-3 py-2">
            <div className="text-[10px] text-[#8A8A96]">Dirección</div>
            <div className="mt-1 text-sm text-[#F5F5F7]">
              {selectedOrder.address || '—'}
            </div>
          </div>

          <div className="rounded-lg border border-[#242433] bg-[#0B0B0D] px-3 py-2">
            <div className="text-[10px] text-[#8A8A96]">Asignación actual</div>
            <div className="mt-1 text-sm text-[#F5F5F7]">
              {selectedOrder.riderName
                ? `Interno: ${selectedOrder.riderName}`
                : selectedOrder.externalPartner
                  ? `Externo: ${selectedOrder.externalPartner}`
                  : 'Sin asignación'}
            </div>
          </div>
        </>
      ) : (
        <div className="rounded-lg border border-[#242433] bg-[#0B0B0D] px-3 py-2">
          <div className="text-[10px] text-[#8A8A96]">Estado</div>
          <div className="mt-1 text-sm text-[#F5F5F7]">Retiro en tienda</div>
        </div>
      )}

      {(selectedOrder.editMeta?.hasInvoice || selectedOrder.editMeta?.hasDeliveryNote) ? (
        <div className="space-y-2">
          {selectedOrder.editMeta?.hasInvoice ? (
            <div className="rounded-lg border border-[#242433] bg-[#0B0B0D] px-3 py-2">
              <div className="text-[10px] text-[#8A8A96]">Factura</div>
              <div className="mt-1 text-sm text-[#F5F5F7]">
                {[
                  selectedOrder.editMeta?.invoiceSnapshot?.companyName,
                  selectedOrder.editMeta?.invoiceSnapshot?.taxId,
                  selectedOrder.editMeta?.invoiceSnapshot?.address,
                  selectedOrder.editMeta?.invoiceSnapshot?.phone,
                ]
                  .filter(Boolean)
                  .join(' | ') || selectedOrder.editMeta?.invoiceDataNote || 'Solicitada sin datos guardados'}
              </div>
              {selectedOrder.editMeta?.invoiceTaxPct ? (
                <div className="mt-2 text-xs text-sky-300">
                  IVA: {selectedOrder.editMeta.invoiceTaxPct}% ({fmtBs(selectedOrder.editMeta.invoiceTaxAmountBs ?? 0)} / {fmtUSD(selectedOrder.editMeta.invoiceTaxAmountUsd ?? 0)})
                </div>
              ) : null}
            </div>
          ) : null}

          {selectedOrder.editMeta?.hasDeliveryNote ? (
            <div className="rounded-lg border border-[#242433] bg-[#0B0B0D] px-3 py-2">
              <div className="text-[10px] text-[#8A8A96]">Nota de entrega</div>
              <div className="mt-1 text-sm text-[#F5F5F7]">
                {[
                  selectedOrder.editMeta?.deliveryNoteSnapshot?.name,
                  selectedOrder.editMeta?.deliveryNoteSnapshot?.documentId,
                  selectedOrder.editMeta?.deliveryNoteSnapshot?.address,
                  selectedOrder.editMeta?.deliveryNoteSnapshot?.phone,
                ]
                  .filter(Boolean)
                  .join(' | ') || 'Solicitada sin datos guardados'}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  </div>
) : null}

{detailTab === 'pagos' ? (
  <div className="rounded-xl border border-[#1D1D28] bg-[#101014] p-3">
    <div className="flex items-center justify-between gap-2">
      <div className="text-sm font-semibold text-[#F5F5F7]">Pagos</div>
      <SmallBadge
        label={
          selectedOrder.paymentVerify === 'pending'
            ? 'Por confirmar'
            : selectedOrder.paymentVerify === 'confirmed'
              ? 'Confirmado'
              : selectedOrder.paymentVerify === 'rejected'
                ? 'Rechazado'
                : 'Sin reporte'
        }
        tone={
          selectedOrder.paymentVerify === 'pending'
            ? 'warn'
            : selectedOrder.paymentVerify === 'confirmed'
              ? 'brand'
              : 'muted'
        }
      />
    </div>

    <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
      <div className="rounded-lg border border-[#242433] bg-[#0B0B0D] px-3 py-2">
        <div className="text-[10px] text-[#8A8A96]">Total</div>
        <div className="mt-1 text-sm font-medium text-[#F5F5F7]">
          {fmtUSD(selectedOrder.totalUsd)}
        </div>
      </div>

      <div className="rounded-lg border border-[#242433] bg-[#0B0B0D] px-3 py-2">
        <div className="text-[10px] text-[#8A8A96]">Confirmado</div>
        <div className="mt-1 text-sm font-medium text-emerald-400">
          {fmtUSD(selectedOrder.confirmedPaidUsd)}
        </div>
      </div>

      <div className="rounded-lg border border-[#242433] bg-[#0B0B0D] px-3 py-2">
        <div className="text-[10px] text-[#8A8A96]">Pendiente</div>
        <div className="mt-1 text-sm font-medium text-orange-500">
          {fmtUSD(selectedOrder.balanceUsd)}
        </div>
      </div>
    </div>

    {(selectedOrder.pendingReportedUsd > 0 || selectedOrder.rejectedReportedUsd > 0) ? (
      <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
        {selectedOrder.pendingReportedUsd > 0 ? (
          <div className="rounded-lg border border-[#242433] bg-[#0B0B0D] px-3 py-2">
            <div className="text-[10px] text-[#8A8A96]">Reportado por confirmar</div>
            <div className="mt-1 text-sm font-medium text-[#F5F5F7]">
              {fmtUSD(selectedOrder.pendingReportedUsd)}
            </div>
          </div>
        ) : null}

        {selectedOrder.rejectedReportedUsd > 0 ? (
          <div className="rounded-lg border border-red-500/40 bg-[#0B0B0D] px-3 py-2">
            <div className="text-[10px] text-[#8A8A96]">Rechazado</div>
            <div className="mt-1 text-sm font-medium text-red-400">
              {fmtUSD(selectedOrder.rejectedReportedUsd)}
            </div>
          </div>
        ) : null}
      </div>
    ) : null}

    <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
      <div className="rounded-lg border border-[#242433] bg-[#0B0B0D] px-3 py-2">
        <div className="text-[10px] text-[#8A8A96]">Forma de pago</div>
        <div className="mt-1 text-sm font-medium text-[#F5F5F7]">
          {getPaymentMethodLabel(selectedOrder.editMeta?.paymentMethod || '')}
        </div>
      </div>

      <div className="rounded-lg border border-[#242433] bg-[#0B0B0D] px-3 py-2">
        <div className="text-[10px] text-[#8A8A96]">Cambio</div>
        <div className="mt-1 text-sm font-medium text-[#F5F5F7]">
          {selectedOrder.editMeta?.paymentRequiresChange
            ? selectedOrder.editMeta?.paymentChangeFor
              ? `Para ${selectedOrder.editMeta.paymentChangeFor} ${selectedOrder.editMeta.paymentChangeCurrency || ''}`
              : 'Sí'
            : 'No'}
        </div>
      </div>
    </div>

    {selectedOrder.editMeta?.paymentNote ? (
      <div className="mt-2 rounded-lg border border-[#242433] bg-[#0B0B0D] px-3 py-3 text-sm text-[#B7B7C2]">
        <span className="text-[#F5F5F7]">Nota de pago:</span> {selectedOrder.editMeta.paymentNote}
      </div>
    ) : null}

    <div className="mt-3">
      <div className="mb-2 text-sm font-semibold text-[#F5F5F7]">Reportes</div>

      {selectedOrder.paymentReports.length === 0 ? (
        <div className="rounded-lg border border-[#242433] bg-[#0B0B0D] px-3 py-3 text-sm text-[#B7B7C2]">
          Sin reportes de pago.
        </div>
      ) : (
        <div className="space-y-2">
          {selectedOrder.paymentReports.map((rp) => (
            <div key={rp.id} className="rounded-lg border border-[#242433] bg-[#0B0B0D] px-3 py-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-[#F5F5F7]">
                    {rp.currencyCode} {rp.amount.toFixed(2)} · {fmtUSD(rp.usdEquivalent)}
                  </div>
                  <div className="mt-1 text-[11px] text-[#8A8A96]">
                    {rp.moneyAccountName} · {fmtDateTimeES(rp.createdAt)}
                  </div>
                </div>

                <div
                  className={[
                    'rounded-full px-2 py-0.5 text-[10px] font-semibold',
                    rp.status === 'pending'
                      ? 'bg-orange-500 text-[#0B0B0D]'
                      : rp.status === 'confirmed'
                        ? 'bg-emerald-500 text-[#0B0B0D]'
                        : 'bg-red-500 text-[#0B0B0D]',
                  ].join(' ')}
                >
                  {rp.status === 'pending'
                    ? 'PENDIENTE'
                    : rp.status === 'confirmed'
                      ? 'CONFIRMADO'
                      : 'RECHAZADO'}
                </div>
              </div>

              <div className="mt-2 grid grid-cols-1 gap-1 text-[11px] text-[#B7B7C2] sm:grid-cols-2">
                <div>
                  <span className="text-[#8A8A96]">Reportado por:</span>{' '}
                  <span className="text-[#F5F5F7]">{rp.reporterName}</span>
                </div>

                <div>
                  <span className="text-[#8A8A96]">Referencia:</span>{' '}
                  <span className="text-[#F5F5F7]">{rp.referenceCode || '—'}</span>
                </div>

                <div>
                  <span className="text-[#8A8A96]">Pagador:</span>{' '}
                  <span className="text-[#F5F5F7]">{rp.payerName || '—'}</span>
                </div>

                <div>
                  <span className="text-[#8A8A96]">Tasa:</span>{' '}
                  <span className="text-[#F5F5F7]">{rp.exchangeRate != null ? rp.exchangeRate : '—'}</span>
                </div>
              </div>

              {rp.notes ? (
                <div className="mt-2 text-[11px] text-[#B7B7C2]">
                  <span className="text-[#8A8A96]">Notas:</span>{' '}
                  <span className="text-[#F5F5F7]">{rp.notes}</span>
                </div>
              ) : null}

              {rp.status === 'pending' ? (
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    className="rounded-md border border-[#2A2A38] bg-[#0D0D11] px-2 py-1 text-[10px] text-[#F5F5F7]"
                    onClick={() => handleConfirmPayment(selectedOrder, rp)}
                  >
                    Confirmar
                  </button>
                  <button
                    className="rounded-md border border-red-500/50 bg-[#0D0D11] px-2 py-1 text-[10px] text-red-400"
                    onClick={() => handleRejectPayment(rp)}
                  >
                    Rechazar
                  </button>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  </div>
) : null}

{detailTab === 'notas' ? (
  <div className="rounded-xl border border-[#1D1D28] bg-[#101014] p-3">
    <div className="text-sm font-semibold text-[#F5F5F7]">Notas</div>
    <div className="mt-3 rounded-lg border border-[#242433] bg-[#0B0B0D] px-3 py-3 text-sm text-[#B7B7C2]">
      {selectedOrder.notes?.trim() ? selectedOrder.notes : '—'}
    </div>
  </div>
) : null}
  </div>

  <div className="lg:sticky lg:top-0">
    <div className="rounded-xl border border-[#1D1D28] bg-[#101014] p-3">
      <div className="text-[11px] font-medium text-[#B7B7C2]">Acciones</div>

      <div className="mt-2 flex flex-col gap-1.5">
        {processFlag(selectedOrder) === 'APROBAR' ? (
          <>
            <button
              className="rounded-md border border-[#2A2A38] bg-[#0D0D11] px-2 py-1 text-[10px] text-[#F5F5F7]"
              onClick={() => handleApprove(selectedOrder)}
            >
              Aprobar
            </button>
            <button
              className="rounded-md border border-[#2A2A38] bg-[#0D0D11] px-2 py-1 text-[10px] text-[#F5F5F7]"
              onClick={() => {
  setReviewActionMode('return');
  setReviewActionNotes('');
}}
            >
              Devolver
            </button>
          </>
        ) : null}

        {processFlag(selectedOrder) === 'RE-APROBAR' ? (
          <>
            <button
              className="rounded-md border border-orange-500/50 bg-[#0D0D11] px-2.5 py-1.5 text-[11px] text-orange-400"
              onClick={() => {
  setReviewActionMode('reapprove');
  setReviewActionNotes('');
}}
            >
              Re-aprobar
            </button>
            <button
              className="rounded-md border border-[#2A2A38] bg-[#0D0D11] px-2 py-1 text-[10px] text-[#F5F5F7]"
onClick={() => {
  setReviewActionMode('return');
  setReviewActionNotes('');
}}
            >
              Devolver
            </button>
          </>
        ) : null}

        {canReviewQueuedChanges(selectedOrder) ? (
          <>
            <button
              className="rounded-md border border-orange-500/50 bg-[#0D0D11] px-2.5 py-1.5 text-[11px] text-orange-400"
onClick={() => {
  setReviewActionMode('approve_changes');
  setReviewActionNotes('');
}}
            >
              Aprobar cambios
            </button>
            <button
              className="rounded-md border border-[#2A2A38] bg-[#0D0D11] px-2 py-1 text-[10px] text-[#F5F5F7]"
onClick={() => {
  setReviewActionMode('reject_changes');
  setReviewActionNotes('');
}}
            >
              Rechazar cambios
            </button>
          </>
        ) : null}

        {['created', 'queued'].includes(selectedOrder.status) ? (
          <button
            className="rounded-md border border-[#2A2A38] bg-[#0D0D11] px-2 py-1 text-[10px] text-[#F5F5F7]"
            onClick={() => openEditOrderDrawer(selectedOrder)}
          >
            Modificar
          </button>
        ) : null}

{canManageDeliveryAssignment(selectedOrder) ? (
  <>
    <button
      className="rounded-md border border-[#2A2A38] bg-[#0D0D11] px-2 py-1 text-[10px] text-[#F5F5F7]"
      onClick={() => {
        setDeliveryAssignMode('internal');
        setDeliveryAssignPartnerId('');
        setDeliveryAssignReference('');
      }}
    >
      Asignar interno
    </button>

    <button
      className="rounded-md border border-[#2A2A38] bg-[#0D0D11] px-2 py-1 text-[10px] text-[#F5F5F7]"
      onClick={() => {
        setDeliveryAssignMode('external');
        setDeliveryAssignDriverId('');
      }}
    >
      Asignar externo
    </button>
    {hasDeliveryAssignment(selectedOrder) ? (
      <button
        className="rounded-md border border-red-500/50 bg-[#0D0D11] px-2 py-1 text-[10px] text-red-400"
        onClick={() => handleClearDeliveryAssignment(selectedOrder)}
      >
        Quitar asignación
      </button>
    ) : null}
  </>
) : null}

{detailTab === 'pagos' && selectedOrder.balanceUsd > 0.01 ? (
  <button
    className="rounded-md border border-[#2A2A38] bg-[#0D0D11] px-2 py-1 text-[10px] text-[#F5F5F7]"
    onClick={() => {
      setPaymentReportBoxOpen(true);
      setPaymentReportAmount(
        selectedOrder.balanceUsd > 0 ? String(Number(selectedOrder.balanceUsd.toFixed(2))) : ''
      );
    }}
  >
    Reportar pago
  </button>
) : null}

{detailTab === 'pagos' && paymentReportBoxOpen ? (
  <div className="rounded-lg border border-[#242433] bg-[#0B0B0D] p-2">
    <div className="text-[10px] font-medium text-[#B7B7C2]">Registrar reporte de pago</div>

    <div className="mt-2 space-y-2">
      <select
        value={paymentReportMoneyAccountId}
        onChange={(e) => {
          const nextId = e.target.value;
          setPaymentReportMoneyAccountId(nextId);

          const nextAccount = moneyAccounts.find((a) => a.id === Number(nextId));
          if (nextAccount?.currencyCode !== 'VES') {
            setPaymentReportExchangeRate('');
          }
        }}
        className="w-full rounded-md border border-[#242433] bg-[#121218] px-2 py-1.5 text-[11px] text-[#F5F5F7]"
      >
        <option value="">— cuenta —</option>
        {moneyAccounts.filter((a) => a.isActive).map((a) => (
            <option key={a.id} value={a.id}>
              {a.name} ({a.currencyCode})
            </option>
        ))}
      </select>

      <input
        value={paymentReportAmount}
        onChange={(e) => setPaymentReportAmount(e.target.value)}
        placeholder="Monto reportado"
        type="number"
        className="w-full rounded-md border border-[#242433] bg-[#121218] px-2 py-1.5 text-[11px] text-[#F5F5F7] placeholder:text-[#8A8A96]"
      />

      {selectedPaymentReportAccount?.currencyCode === 'VES' ? (
        <input
          value={paymentReportExchangeRate}
          onChange={(e) => setPaymentReportExchangeRate(e.target.value)}
          placeholder="Tasa VES por USD"
          type="number"
          className="w-full rounded-md border border-[#242433] bg-[#121218] px-2 py-1.5 text-[11px] text-[#F5F5F7] placeholder:text-[#8A8A96]"
        />
      ) : null}

      <input
        value={paymentReportReferenceCode}
        onChange={(e) => setPaymentReportReferenceCode(e.target.value)}
        placeholder="Referencia (opcional)"
        className="w-full rounded-md border border-[#242433] bg-[#121218] px-2 py-1.5 text-[11px] text-[#F5F5F7] placeholder:text-[#8A8A96]"
      />

      <input
        value={paymentReportPayerName}
        onChange={(e) => setPaymentReportPayerName(e.target.value)}
        placeholder="Pagador (opcional)"
        className="w-full rounded-md border border-[#242433] bg-[#121218] px-2 py-1.5 text-[11px] text-[#F5F5F7] placeholder:text-[#8A8A96]"
      />

      <textarea
        value={paymentReportNotes}
        onChange={(e) => setPaymentReportNotes(e.target.value)}
        placeholder="Notas (opcional)"
        rows={2}
        className="w-full rounded-md border border-[#242433] bg-[#121218] px-2 py-1.5 text-[11px] text-[#F5F5F7] placeholder:text-[#8A8A96]"
      />

      <div className="flex flex-col gap-1.5">
        <button
          className="rounded-md border border-[#FEEF00] bg-[#FEEF00] px-2 py-1 text-[10px] font-semibold text-[#0B0B0D]"
          onClick={() => handleCreatePaymentReport(selectedOrder)}
        >
          Guardar reporte
        </button>

        <button
          className="rounded-md border border-[#2A2A38] bg-[#0D0D11] px-2 py-1 text-[10px] text-[#F5F5F7]"
          onClick={resetPaymentReportBox}
        >
          Cancelar
        </button>
      </div>
    </div>
  </div>
) : null}

{canManageDeliveryAssignment(selectedOrder) &&
deliveryAssignMode === 'internal' ? (
  <div className="rounded-lg border border-[#242433] bg-[#0B0B0D] p-2">
    <div className="text-[10px] font-medium text-[#B7B7C2]">Asignar driver interno</div>

    <div className="mt-2">
      <select
        value={deliveryAssignDriverId}
        onChange={(e) => setDeliveryAssignDriverId(e.target.value)}
        className="w-full rounded-md border border-[#242433] bg-[#121218] px-2 py-1.5 text-[11px] text-[#F5F5F7]"
      >
        <option value="">— seleccionar —</option>
        {drivers.map((d) => (
          <option key={d.id} value={d.id}>
            {d.fullName}
          </option>
        ))}
      </select>
    </div>

    <div className="mt-2 flex flex-col gap-1.5">
      <button
        className="rounded-md border border-[#FEEF00] bg-[#FEEF00] px-2 py-1 text-[10px] font-semibold text-[#0B0B0D]"
        onClick={() => handleAssignInternal(selectedOrder)}
      >
        Guardar interno
      </button>

      <button
        className="rounded-md border border-[#2A2A38] bg-[#0D0D11] px-2 py-1 text-[10px] text-[#F5F5F7]"
        onClick={resetDeliveryAssignBox}
      >
        Cancelar
      </button>
    </div>
  </div>
) : null}

{canManageDeliveryAssignment(selectedOrder) &&
deliveryAssignMode === 'external' ? (
  <div className="rounded-lg border border-[#242433] bg-[#0B0B0D] p-2">
    <div className="text-[10px] font-medium text-[#B7B7C2]">Asignar partner externo</div>

    <div className="mt-2">
      <select
        value={deliveryAssignPartnerId}
        onChange={(e) => setDeliveryAssignPartnerId(e.target.value)}
        className="w-full rounded-md border border-[#242433] bg-[#121218] px-2 py-1.5 text-[11px] text-[#F5F5F7]"
      >
        <option value="">— seleccionar —</option>
        {deliveryPartners.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
    </div>

    <div className="mt-2">
      <input
        value={deliveryAssignReference}
        onChange={(e) => setDeliveryAssignReference(e.target.value)}
        placeholder="Referencia externa (opcional)"
        className="w-full rounded-md border border-[#242433] bg-[#121218] px-2 py-1.5 text-[11px] text-[#F5F5F7] placeholder:text-[#8A8A96]"
      />
    </div>

    <div className="mt-2 flex flex-col gap-1.5">
      <button
        className="rounded-md border border-[#FEEF00] bg-[#FEEF00] px-2 py-1 text-[10px] font-semibold text-[#0B0B0D]"
        onClick={() => handleAssignExternal(selectedOrder)}
      >
        Guardar externo
      </button>

      <button
        className="rounded-md border border-[#2A2A38] bg-[#0D0D11] px-2 py-1 text-[10px] text-[#F5F5F7]"
        onClick={resetDeliveryAssignBox}
      >
        Cancelar
      </button>
    </div>
  </div>
) : null}

{reviewActionMode ? (
  <div className="rounded-lg border border-[#242433] bg-[#0B0B0D] p-2">
    <div className="text-[10px] font-medium text-[#B7B7C2]">
      {reviewActionMode === 'approve' && 'Aprobar pedido'}
      {reviewActionMode === 'reapprove' && 'Re-aprobar pedido'}
      {reviewActionMode === 'return' && 'Devolver pedido'}
      {reviewActionMode === 'approve_changes' && 'Aprobar cambios'}
      {reviewActionMode === 'reject_changes' && 'Rechazar cambios'}
    </div>

    <div className="mt-2">
      <textarea
        value={reviewActionNotes}
        onChange={(e) => setReviewActionNotes(e.target.value)}
        rows={3}
        placeholder={
          reviewActionMode === 'return' || reviewActionMode === 'reject_changes'
            ? 'Motivo / notas (obligatorio)'
            : 'Notas (opcional)'
        }
        className="w-full rounded-md border border-[#242433] bg-[#121218] px-2 py-1.5 text-[11px] text-[#F5F5F7] placeholder:text-[#8A8A96]"
      />
    </div>

    <div className="mt-2 flex flex-col gap-1.5">
      {reviewActionMode === 'approve' ? (
        <button
          className="rounded-md border border-[#FEEF00] bg-[#FEEF00] px-2 py-1 text-[10px] font-semibold text-[#0B0B0D]"
          onClick={() => handleApprove(selectedOrder)}
        >
          Confirmar aprobación
        </button>
      ) : null}

      {reviewActionMode === 'reapprove' ? (
        <button
          className="rounded-md border border-orange-500 bg-orange-500 px-2 py-1 text-[10px] font-semibold text-[#0B0B0D]"
          onClick={() => handleApprove(selectedOrder)}
        >
          Confirmar re-aprobación
        </button>
      ) : null}

      {reviewActionMode === 'return' ? (
        <button
          className="rounded-md border border-[#FEEF00] bg-[#FEEF00] px-2 py-1 text-[10px] font-semibold text-[#0B0B0D]"
          onClick={() => handleReturn(selectedOrder)}
        >
          Enviar devolución
        </button>
      ) : null}

      {reviewActionMode === 'approve_changes' ? (
        <button
          className="rounded-md border border-orange-500 bg-orange-500 px-2 py-1 text-[10px] font-semibold text-[#0B0B0D]"
          onClick={() => handleReviewChanges(selectedOrder, true)}
        >
          Confirmar aprobación
        </button>
      ) : null}

      {reviewActionMode === 'reject_changes' ? (
        <button
          className="rounded-md border border-red-500/50 bg-[#0D0D11] px-2 py-1 text-[10px] text-red-400"
          onClick={() => handleReviewChanges(selectedOrder, false)}
        >
          Confirmar rechazo
        </button>
      ) : null}

      <button
        className="rounded-md border border-[#2A2A38] bg-[#0D0D11] px-2 py-1 text-[10px] text-[#F5F5F7]"
        onClick={resetReviewActionBox}
      >
        Cancelar
      </button>
    </div>
  </div>
) : null}

{canKitchenTake(selectedOrder) ? (
  <button
    className="rounded-md border border-[#2A2A38] bg-[#0D0D11] px-2 py-1 text-[10px] text-[#F5F5F7]"
    onClick={() => {
      setKitchenTakeBoxOpen(true);
      setKitchenEtaMinutes('15');
    }}
  >
    Tomar en cocina
  </button>
) : null}

{kitchenTakeBoxOpen ? (
  <div className="rounded-lg border border-[#242433] bg-[#0B0B0D] p-2">
    <div className="text-[10px] font-medium text-[#B7B7C2]">Tomar en cocina</div>

    <div className="mt-2 space-y-2">
      <div>
        <label className="mb-1 block text-[10px] text-[#8A8A96]">ETA (minutos)</label>
        <input
          value={kitchenEtaMinutes}
          onChange={(e) => setKitchenEtaMinutes(e.target.value)}
          type="number"
          min={1}
          className="w-full rounded-md border border-[#242433] bg-[#121218] px-2 py-1.5 text-[11px] text-[#F5F5F7]"
        />
      </div>

      <div className="grid grid-cols-3 gap-1">
        {[10, 15, 20].map((m) => (
          <button
            key={m}
            className="rounded-md border border-[#2A2A38] bg-[#121218] px-2 py-1 text-[10px] text-[#F5F5F7]"
            onClick={() => setKitchenEtaMinutes(String(m))}
          >
            {m} min
          </button>
        ))}
      </div>

      <div className="flex flex-col gap-1.5">
        <button
          className="rounded-md border border-[#FEEF00] bg-[#FEEF00] px-2 py-1 text-[10px] font-semibold text-[#0B0B0D]"
          onClick={() => handleKitchenTake(selectedOrder)}
        >
          Confirmar cocina
        </button>

        <button
          className="rounded-md border border-[#2A2A38] bg-[#0D0D11] px-2 py-1 text-[10px] text-[#F5F5F7]"
          onClick={resetKitchenTakeBox}
        >
          Cancelar
        </button>
      </div>
    </div>
  </div>
) : null}

{deliveryEtaBoxOpen && selectedOrder.fulfillment === 'delivery' ? (
  <div className="rounded-lg border border-[#242433] bg-[#0B0B0D] p-2">
    <div className="text-[10px] font-medium text-[#B7B7C2]">Marcar en camino</div>
    <div className="mt-1 text-[10px] text-[#8A8A96]">
      {selectedOrder.riderName
        ? `Interno: ${selectedOrder.riderName}`
        : selectedOrder.externalPartner
          ? `Externo: ${selectedOrder.externalPartner}`
          : 'Sin asignación visible'}
    </div>

    <div className="mt-2 space-y-2">
      <div>
        <label className="mb-1 block text-[10px] text-[#8A8A96]">
          Tiempo aproximado de entrega (minutos)
        </label>
        <input
          value={deliveryEtaMinutes}
          onChange={(e) => setDeliveryEtaMinutes(e.target.value)}
          type="number"
          min={1}
          className="w-full rounded-md border border-[#242433] bg-[#121218] px-2 py-1.5 text-[11px] text-[#F5F5F7]"
        />
      </div>

      <div className="grid grid-cols-3 gap-1">
        {[20, 25, 35].map((m) => (
          <button
            key={m}
            className="rounded-md border border-[#2A2A38] bg-[#121218] px-2 py-1 text-[10px] text-[#F5F5F7]"
            onClick={() => setDeliveryEtaMinutes(String(m))}
          >
            {m} min
          </button>
        ))}
      </div>

      <div className="flex flex-col gap-1.5">
        <button
          className="rounded-md border border-[#FEEF00] bg-[#FEEF00] px-2 py-1 text-[10px] font-semibold text-[#0B0B0D]"
          onClick={() => handleOutForDelivery(selectedOrder)}
        >
          Confirmar salida
        </button>

        <button
          className="rounded-md border border-[#2A2A38] bg-[#0D0D11] px-2 py-1 text-[10px] text-[#F5F5F7]"
          onClick={resetDeliveryEtaBox}
        >
          Cancelar
        </button>
      </div>
    </div>
  </div>
) : null}

{canReturnFromKitchenToQueue(selectedOrder) ? (
  <button
    className="rounded-md border border-orange-500/50 bg-[#0D0D11] px-2.5 py-1.5 text-[11px] text-orange-400"
    onClick={() => {
      setReturnToQueueBoxOpen(true);
      setReturnToQueueReason('');
    }}
  >
    Regresar a cola
  </button>
) : null}

{returnToQueueBoxOpen ? (
  <div className="rounded-lg border border-orange-500/30 bg-[#0B0B0D] p-2">
    <div className="text-[10px] font-medium text-[#B7B7C2]">Regresar a cola</div>

    <div className="mt-2">
      <textarea
        value={returnToQueueReason}
        onChange={(e) => setReturnToQueueReason(e.target.value)}
        rows={3}
        placeholder="Motivo para regresar a cola (obligatorio)"
        className="w-full rounded-md border border-[#242433] bg-[#121218] px-2 py-1.5 text-[11px] text-[#F5F5F7] placeholder:text-[#8A8A96]"
      />
    </div>

    <div className="mt-2 flex flex-col gap-1.5">
      <button
        className="rounded-md border border-orange-500/50 bg-[#0D0D11] px-2 py-1 text-[10px] text-orange-400"
        onClick={() => handleReturnFromKitchenToQueue(selectedOrder)}
      >
        Confirmar regreso
      </button>

      <button
        className="rounded-md border border-[#2A2A38] bg-[#0D0D11] px-2 py-1 text-[10px] text-[#F5F5F7]"
        onClick={resetReturnToQueueBox}
      >
        Cancelar
      </button>
    </div>
  </div>
) : null}

{selectedOrder.status !== 'cancelled' ? (
  <button
    className="rounded-md border border-red-500/50 bg-[#0D0D11] px-2.5 py-1.5 text-[11px] text-red-400"
    onClick={() => {
      setCancelOrderBoxOpen(true);
      setCancelOrderReason('');
    }}
  >
    Cancelar
  </button>
) : null}

{cancelOrderBoxOpen ? (
  <div className="rounded-lg border border-red-500/30 bg-[#0B0B0D] p-2">
    <div className="text-[10px] font-medium text-[#B7B7C2]">Cancelar pedido</div>

    <div className="mt-2">
      <textarea
        value={cancelOrderReason}
        onChange={(e) => setCancelOrderReason(e.target.value)}
        rows={3}
        placeholder="Motivo de cancelación (obligatorio)"
        className="w-full rounded-md border border-[#242433] bg-[#121218] px-2 py-1.5 text-[11px] text-[#F5F5F7] placeholder:text-[#8A8A96]"
      />
    </div>

    <div className="mt-2 flex flex-col gap-1.5">
      <button
        className="rounded-md border border-red-500/50 bg-[#0D0D11] px-2 py-1 text-[10px] text-red-400"
        onClick={() => handleCancelOrder(selectedOrder)}
      >
        Confirmar cancelación
      </button>

      <button
        className="rounded-md border border-[#2A2A38] bg-[#0D0D11] px-2 py-1 text-[10px] text-[#F5F5F7]"
        onClick={resetCancelOrderBox}
      >
        Cancelar cierre
      </button>
    </div>
  </div>
) : null}

      </div>

    </div>
  </div>
</div>
          </div>
        )}
      </Drawer>

        <Drawer
  open={quickCatalogOpen}
  title="Actualización rápida de catálogo"
  onClose={() => setQuickCatalogOpen(false)}
  widthClass="w-[820px]"
>
  <div className="space-y-4">
    <div className="rounded-2xl border border-[#242433] bg-[#121218] p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-[#F5F5F7]">
            Montos fuente por bloque
          </div>
          <div className="mt-1 text-sm text-[#B7B7C2]">
            Edita solo el monto en la moneda de origen. Puedes usar tabulador para pasar rápido de un ítem al siguiente.
          </div>
        </div>

        <SmallBadge label={`${quickCatalogRows.length} ítems`} tone="muted" />
      </div>

      <div className="mt-4 overflow-hidden rounded-2xl border border-[#242433] bg-[#0B0B0D]">
        <div className="max-h-[62vh] overflow-y-auto">
          <table className="w-full table-fixed text-[12px]">
            <thead className="sticky top-0 z-10 border-b border-[#242433] bg-[#121218] text-[#B7B7C2]">
              <tr>
                <th className="w-[84px] px-3 py-3 text-left font-medium">SKU</th>
                <th className="px-3 py-3 text-left font-medium">Ítem</th>
                <th className="w-[78px] px-3 py-3 text-left font-medium">Moneda</th>
                <th className="w-[170px] px-3 py-3 text-left font-medium">Monto fuente</th>
              </tr>
            </thead>
            <tbody>
              {quickCatalogRows.map((row, idx) => (
                <tr
                  key={row.productId}
                  className={`${idx % 2 === 0 ? 'bg-[#0F0F14]' : 'bg-[#13131A]'} border-b border-[#242433]`}
                >
                  <td className="px-3 py-2 text-[#8A8A96]">{row.sku || '—'}</td>
                  <td className="px-3 py-2 text-[#F5F5F7]">{row.name}</td>
                  <td className="px-3 py-2 text-[#F5F5F7]">{row.sourcePriceCurrency}</td>
                  <td className="px-3 py-2">
                    <input
                      value={row.nextAmount}
                      onChange={(e) => handleQuickCatalogRowChange(row.productId, e.target.value)}
                      inputMode="decimal"
                      className="w-full rounded-xl border border-[#242433] bg-[#121218] px-3 py-2 text-sm text-[#F5F5F7]"
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="mt-4 flex items-center justify-between gap-3">
        <div className="text-xs text-[#8A8A96]">
          Se respetan la moneda de origen y la tasa activa al guardar.
        </div>

        <div className="flex gap-2">
          <button
            className="rounded-xl border border-[#242433] bg-[#0B0B0D] px-4 py-2 text-sm"
            onClick={() => setQuickCatalogOpen(false)}
            disabled={quickCatalogSaving}
          >
            Cancelar
          </button>
          <button
            className="rounded-xl bg-[#FEEF00] px-4 py-2 text-sm font-semibold text-[#0B0B0D]"
            onClick={handleSaveQuickCatalog}
            disabled={quickCatalogSaving}
          >
            {quickCatalogSaving ? 'Guardando...' : 'Guardar bloque'}
          </button>
        </div>
      </div>
    </div>
  </div>
        </Drawer>

        <Drawer
  open={createCatalogOpen}
  title="Nuevo ítem de catálogo"
  onClose={() => setCreateCatalogOpen(false)}
  widthClass="w-[720px]"
>
  <div className="space-y-4">
    <div className="rounded-2xl border border-[#242433] bg-[#121218] p-4">
      <div className="grid grid-cols-2 gap-3">
        <FieldInput label="SKU" value={newSku} onChange={setNewSku} />
        <FieldInput label="Nombre" value={newName} onChange={setNewName} />



        <FieldSelect
          label="Moneda fuente"
          value={newSourcePriceCurrency}
          onChange={(v) => setNewSourcePriceCurrency(v as 'VES' | 'USD')}
          options={[
            { value: 'VES', label: 'VES' },
            { value: 'USD', label: 'USD' },
          ]}
        />

        <FieldInput
          label="Monto fuente"
          value={newSourcePriceAmount}
          onChange={setNewSourcePriceAmount}
          type="text"
        />

        <FieldInput
          label="Und/servicio"
          value={newUnitsPerService}
          onChange={setNewUnitsPerService}
          type="number"
        />

        <FieldInput
          label="Límite detalle"
          value={newDetailUnitsLimit}
          onChange={setNewDetailUnitsLimit}
          type="number"
        />
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3">
        <FieldSelect
          label="Regla comisión"
          value={newCommissionMode}
          onChange={(v) => setNewCommissionMode(v as 'default' | 'fixed_item' | 'fixed_order')}
          options={[
            { value: 'default', label: 'Default' },
            { value: 'fixed_item', label: 'Fija por ítem' },
            { value: 'fixed_order', label: 'Fija por orden' },
          ]}
        />

        <FieldInput
          label="Valor comisión"
          value={newCommissionValue}
          onChange={setNewCommissionValue}
          type="text"
        />
      </div>

      <div className="mt-3">
        <FieldInput label="Notas comisión" value={newCommissionNotes} onChange={setNewCommissionNotes} />
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3">
        <FieldCheckbox label="Activo" checked={newIsActive} onChange={setNewIsActive} />
        <FieldCheckbox label="Inventariable" checked={newIsInventoryItem} onChange={setNewIsInventoryItem} />
        <FieldCheckbox label="Detalle editable" checked={newIsDetailEditable} onChange={setNewIsDetailEditable} />
        <FieldCheckbox label="Temporal" checked={newIsTemporary} onChange={setNewIsTemporary} />
        <FieldCheckbox
          label="Puede ser comp. combo"
          checked={newIsComboComponentSelectable}
          onChange={setNewIsComboComponentSelectable}
        />
      </div>
    </div>

    <div className="flex justify-end gap-2">
      <button
        className="rounded-xl border border-[#242433] bg-[#0B0B0D] px-4 py-2 text-sm"
        onClick={() => setCreateCatalogOpen(false)}
        disabled={createCatalogSaving}
      >
        Cancelar
      </button>
      <button
        className="rounded-xl bg-[#FEEF00] px-4 py-2 text-sm font-semibold text-[#0B0B0D]"
        onClick={handleCreateCatalogItem}
        disabled={createCatalogSaving}
      >
        {createCatalogSaving ? 'Creando...' : 'Crear ítem'}
      </button>
    </div>
  </div>
        </Drawer>

      <Drawer open={movementOpen} title="Movimiento" onClose={() => setMovementOpen(false)} widthClass="w-[420px]">
        <div className="space-y-4">
          <div className="text-sm text-[#B7B7C2]">Registrar ingreso/egreso/transferencia (demo UI).</div>

          <div className="space-y-2">
            <div className="text-xs text-[#B7B7C2]">Tipo</div>
            <div className="flex gap-2">
              {(['Ingreso', 'Egreso', 'Transferencia'] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setMovementType(t)}
                  className={[
                    'rounded-full border bg-[#121218] px-3 py-1.5 text-sm',
                    movementType === t ? 'border-[#FEEF00] text-[#F5F5F7]' : 'border-[#242433] text-[#B7B7C2]',
                  ].join(' ')}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-2 rounded-2xl border border-[#242433] bg-[#121218] p-3">
            <div className="text-sm font-semibold">{movementType}</div>
            <div className="text-sm text-[#B7B7C2]">(Demo) Aquí irían: cuenta(s), moneda, monto, fecha, referencia.</div>
            <button
  className="w-full rounded-xl bg-[#FEEF00] px-3 py-2 text-sm font-semibold text-[#0B0B0D]"
  onClick={() => showToast('success', 'Guardar movimiento (demo).')}
>
              Guardar
            </button>
          </div>
        </div>
      </Drawer>

      <Drawer
        open={accountDetailOpen}
        title={selectedAccount ? `Cuenta: ${selectedAccount.name}` : 'Cuenta'}
        onClose={() => setAccountDetailOpen(false)}
        widthClass="w-[760px]"
      >
        {!selectedAccount ? (
          <div className="text-sm text-[#B7B7C2]">Sin cuenta seleccionada.</div>
        ) : (
          <div className="space-y-4">
            <div className="rounded-2xl border border-[#242433] bg-[#121218] p-4">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <div className="text-lg font-semibold text-[#F5F5F7]">{selectedAccount.name}</div>
                  <div className="mt-1 text-xs text-[#8A8A96]">
                    Fecha: {accountDateTo || accountDateFrom || new Date().toISOString().slice(0, 10)}
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <div className="text-right">
                    <div className="text-xs text-[#8A8A96]">Acumulado</div>
                    <div className="text-lg font-semibold text-[#F5F5F7]">
                      {fmtMoneyByCurrency(
                        accountStatsById.get(selectedAccount.id)?.balanceNative ?? 0,
                        selectedAccount.currencyCode
                      )}
                    </div>
                    <div className="mt-1 text-xs text-[#8A8A96]">
                      {selectedAccount.currencyCode === 'VES'
                        ? fmtUSD(accountStatsById.get(selectedAccount.id)?.balanceUsdRef ?? 0)
                        : fmtBs(
                            (accountStatsById.get(selectedAccount.id)?.balanceNative ?? 0) *
                              (activeExchangeRate?.rateBsPerUsd ?? 0)
                          )}
                    </div>
                  </div>
                  <div className="flex flex-wrap justify-end gap-2">
                    <button
                      type="button"
                      className="rounded-xl border border-[#242433] bg-[#0B0B0D] px-3 py-2 text-sm"
                      onClick={() => openEditAccount(selectedAccount)}
                    >
                      Editar
                    </button>
                    <button
                      type="button"
                      className="rounded-xl border border-[#242433] bg-[#0B0B0D] px-3 py-2 text-sm"
                      onClick={() => handleToggleMoneyAccountActive(selectedAccount)}
                    >
                      {selectedAccount.isActive ? 'Desactivar' : 'Activar'}
                    </button>
                  </div>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <InfoCell label="Moneda" value={selectedAccount.currencyCode} />
              <InfoCell label="Tipo" value={MONEY_ACCOUNT_KIND_LABEL[selectedAccount.accountKind]} />
              <InfoCell label="InstituciÃ³n" value={selectedAccount.institutionName || '—'} />
              <InfoCell label="Titular" value={selectedAccount.ownerName || '—'} />
            </div>

            <div className="rounded-2xl border border-[#242433] bg-[#121218] p-4">
              <div className="text-sm font-semibold text-[#F5F5F7]">Movimientos filtrados</div>
              <div className="mt-3 overflow-x-auto">
                {selectedAccountMovements.length === 0 ? (
                  <div className="text-sm text-[#B7B7C2]">No hay movimientos para ese filtro.</div>
                ) : (
                  <table className="w-full text-[12px]">
                    <thead className="border-b border-[#242433] text-[#B7B7C2]">
                      <tr>
                        <th className="px-2 py-2 text-left font-medium">Tipo</th>
                        <th className="px-2 py-2 text-left font-medium">Monto</th>
                        <th className="px-2 py-2 text-left font-medium">Cliente</th>
                        <th className="px-2 py-2 text-left font-medium">N° Orden</th>
                        <th className="px-2 py-2 text-left font-medium">Nombre/Titular</th>
                        <th className="px-2 py-2 text-left font-medium">N° Control</th>
                      </tr>
                    </thead>
                    <tbody>
                      {selectedAccountMovements.map((movement, idx) => {
                        const linkedOrder = movement.orderId ? orderLookupById.get(movement.orderId) ?? null : null;
                        const zebra = idx % 2 === 0 ? 'bg-[#121218]' : 'bg-[#151522]';
                        const primaryAmount = fmtMoneyByCurrency(movement.amount, selectedAccount.currencyCode);
                        const secondaryAmount =
                          selectedAccount.currencyCode === 'VES'
                            ? fmtUSD(movement.amountUsdEquivalent)
                            : fmtBs(movement.amount * (activeExchangeRate?.rateBsPerUsd ?? 0));

                        return (
                          <tr key={movement.id} className={`${zebra} border-b border-[#242433] align-top`}>
                            <td className="px-2 py-2">
                              {movement.direction === 'inflow' ? 'Ingreso' : 'Retiro'}
                              <div className="mt-1 text-[11px] text-[#8A8A96]">
                                {MOVEMENT_TYPE_LABEL[movement.movementType]}
                              </div>
                            </td>
                            <td className="px-2 py-2">
                              <div className={movement.direction === 'inflow' ? 'text-emerald-400' : 'text-red-400'}>
                                {movement.direction === 'inflow' ? '' : '-'}
                                {primaryAmount}
                              </div>
                              <div className="mt-1 text-[11px] text-[#8A8A96]">{secondaryAmount}</div>
                            </td>
                            <td className="px-2 py-2">{linkedOrder?.clientName || '—'}</td>
                            <td className="px-2 py-2">{movement.orderId ?? '—'}</td>
                            <td className="px-2 py-2">
                              {movement.counterpartyName || linkedOrder?.clientName || selectedAccount.ownerName || '—'}
                            </td>
                            <td className="px-2 py-2">
                              {movement.referenceCode || movement.paymentReportId || movement.id}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          </div>
        )}
      </Drawer>

      <Drawer
        open={accountCreateOpen}
        title="Nueva cuenta"
        onClose={() => setAccountCreateOpen(false)}
        widthClass="w-[720px]"
      >
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <FieldInput label="Nombre" value={accountFormName} onChange={setAccountFormName} />
            <FieldSelect
              label="Moneda"
              value={accountFormCurrencyCode}
              onChange={(value) => setAccountFormCurrencyCode(value as 'USD' | 'VES')}
              options={[
                { value: 'VES', label: 'VES' },
                { value: 'USD', label: 'USD' },
              ]}
            />
            <FieldSelect
              label="Tipo"
              value={accountFormKind}
              onChange={(value) => setAccountFormKind(value as MoneyAccountOption['accountKind'])}
              options={[
                { value: 'bank', label: 'Banco' },
                { value: 'cash', label: 'Caja' },
                { value: 'fund', label: 'Fondo' },
                { value: 'other', label: 'Otro' },
                { value: 'pos', label: 'Punto' },
                { value: 'wallet', label: 'Wallet' },
              ]}
            />
            <FieldInput label="InstituciÃ³n" value={accountFormInstitutionName} onChange={setAccountFormInstitutionName} />
            <FieldInput label="Titular" value={accountFormOwnerName} onChange={setAccountFormOwnerName} />
          </div>

          <div>
            <label className="mb-1 block text-xs text-[#8A8A96]">Notas</label>
            <textarea
              value={accountFormNotes}
              onChange={(e) => setAccountFormNotes(e.target.value)}
              rows={4}
              className="w-full rounded-xl border border-[#242433] bg-[#0B0B0D] px-3 py-2 text-sm text-[#F5F5F7]"
            />
          </div>

          <label className="flex items-center gap-2 text-sm text-[#F5F5F7]">
            <input
              type="checkbox"
              checked={accountFormIsActive}
              onChange={(e) => setAccountFormIsActive(e.target.checked)}
            />
            Activa
          </label>

          <div className="flex gap-2">
            <button
              className="rounded-xl border border-[#242433] bg-[#0B0B0D] px-4 py-2 text-sm"
              onClick={() => setAccountCreateOpen(false)}
              disabled={accountSaving}
            >
              Cancelar
            </button>
            <button
              className="rounded-xl bg-[#FEEF00] px-4 py-2 text-sm font-semibold text-[#0B0B0D]"
              onClick={handleCreateMoneyAccount}
              disabled={accountSaving}
            >
              {accountSaving ? 'Guardando...' : 'Crear cuenta'}
            </button>
          </div>
        </div>
      </Drawer>

      <Drawer
        open={accountEditOpen}
        title={selectedAccount ? `Editar: ${selectedAccount.name}` : 'Editar cuenta'}
        onClose={() => setAccountEditOpen(false)}
        widthClass="w-[720px]"
      >
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <FieldInput label="Nombre" value={accountFormName} onChange={setAccountFormName} />
            <FieldSelect
              label="Moneda"
              value={accountFormCurrencyCode}
              onChange={(value) => setAccountFormCurrencyCode(value as 'USD' | 'VES')}
              options={[
                { value: 'VES', label: 'VES' },
                { value: 'USD', label: 'USD' },
              ]}
            />
            <FieldSelect
              label="Tipo"
              value={accountFormKind}
              onChange={(value) => setAccountFormKind(value as MoneyAccountOption['accountKind'])}
              options={[
                { value: 'bank', label: 'Banco' },
                { value: 'cash', label: 'Caja' },
                { value: 'fund', label: 'Fondo' },
                { value: 'other', label: 'Otro' },
                { value: 'pos', label: 'Punto' },
                { value: 'wallet', label: 'Wallet' },
              ]}
            />
            <FieldInput label="InstituciÃ³n" value={accountFormInstitutionName} onChange={setAccountFormInstitutionName} />
            <FieldInput label="Titular" value={accountFormOwnerName} onChange={setAccountFormOwnerName} />
          </div>

          <div>
            <label className="mb-1 block text-xs text-[#8A8A96]">Notas</label>
            <textarea
              value={accountFormNotes}
              onChange={(e) => setAccountFormNotes(e.target.value)}
              rows={4}
              className="w-full rounded-xl border border-[#242433] bg-[#0B0B0D] px-3 py-2 text-sm text-[#F5F5F7]"
            />
          </div>

          <label className="flex items-center gap-2 text-sm text-[#F5F5F7]">
            <input
              type="checkbox"
              checked={accountFormIsActive}
              onChange={(e) => setAccountFormIsActive(e.target.checked)}
            />
            Activa
          </label>

          <div className="flex gap-2">
            <button
              className="rounded-xl border border-[#242433] bg-[#0B0B0D] px-4 py-2 text-sm"
              onClick={() => setAccountEditOpen(false)}
              disabled={accountSaving}
            >
              Cancelar
            </button>
            <button
              className="rounded-xl bg-[#FEEF00] px-4 py-2 text-sm font-semibold text-[#0B0B0D]"
              onClick={handleUpdateMoneyAccount}
              disabled={accountSaving}
            >
              {accountSaving ? 'Guardando...' : 'Guardar cuenta'}
            </button>
          </div>
        </div>
      </Drawer>
      <Drawer
        open={clientDetailOpen}
        title={selectedClient ? `Cliente: ${selectedClient.fullName}` : 'Cliente'}
        onClose={() => setClientDetailOpen(false)}
        widthClass="w-[820px]"
      >
        {!selectedClient ? (
          <div className="text-sm text-[#B7B7C2]">Sin cliente seleccionado.</div>
        ) : (
          <div className="space-y-4">
            <div className="rounded-2xl border border-[#242433] bg-[#121218] p-4">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <div className="text-lg font-semibold text-[#F5F5F7]">{selectedClient.fullName}</div>
                  <div className="mt-1 text-xs text-[#8A8A96]">
                    Actualizado: {fmtDateTimeES(selectedClient.updatedAt)}
                  </div>
                </div>
                <div className="flex flex-wrap items-start justify-end gap-2">
                  <SmallBadge
                    label={selectedClient.isActive ? 'Activo' : 'Inactivo'}
                    tone={selectedClient.isActive ? 'brand' : 'muted'}
                  />
                  {selectedClient.clientType ? (
                    <SmallBadge label={selectedClient.clientType} tone="muted" />
                  ) : null}
                  <button
                    type="button"
                    className="rounded-xl border border-[#242433] bg-[#0B0B0D] px-3 py-2 text-sm"
                    onClick={() => openEditClient(selectedClient)}
                  >
                    Editar
                  </button>
                  <button
                    type="button"
                    className="rounded-xl border border-[#242433] bg-[#0B0B0D] px-3 py-2 text-sm"
                    onClick={() => handleToggleClientActive(selectedClient)}
                  >
                    {selectedClient.isActive ? 'Desactivar' : 'Activar'}
                  </button>
                </div>
              </div>

              <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
                <InfoCell label="Teléfono" value={selectedClient.phone || '—'} />
                <InfoCell
                  label="Asesor principal"
                  value={
                    selectedClient.primaryAdvisorId
                      ? advisorNameById.get(selectedClient.primaryAdvisorId) || 'Asesor'
                      : '—'
                  }
                />
                <InfoCell label="Cumpleaños" value={selectedClient.birthDate || '—'} />
                <InfoCell label="Fecha importante" value={selectedClient.importantDate || '—'} />
              </div>

              {normalizeClientTags(selectedClient.crmTags).length > 0 ? (
                <div className="mt-4">
                  <div className="mb-2 text-xs text-[#8A8A96]">Etiquetas</div>
                  <div className="flex flex-wrap gap-2">
                    {normalizeClientTags(selectedClient.crmTags).map((tag) => (
                      <SmallBadge key={tag} label={tag} tone="muted" />
                    ))}
                  </div>
                </div>
              ) : null}

              {selectedClient.notes ? (
                <div className="mt-4 rounded-xl border border-[#242433] bg-[#0B0B0D] p-3 text-sm text-[#B7B7C2]">
                  {selectedClient.notes}
                </div>
              ) : null}
            </div>

            <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
              <div className="rounded-2xl border border-[#242433] bg-[#121218] p-4">
                <div className="text-sm font-semibold text-[#F5F5F7]">Factura</div>
                <div className="mt-4 grid grid-cols-1 gap-3">
                  <InfoCell label="Razón social" value={selectedClient.billingCompanyName || '—'} />
                  <InfoCell label="RIF / documento" value={selectedClient.billingTaxId || '—'} />
                  <InfoCell label="Teléfono" value={selectedClient.billingPhone || '—'} />
                  <InfoCell label="Dirección fiscal" value={selectedClient.billingAddress || '—'} />
                </div>
              </div>

              <div className="rounded-2xl border border-[#242433] bg-[#121218] p-4">
                <div className="text-sm font-semibold text-[#F5F5F7]">Nota de entrega</div>
                <div className="mt-4 grid grid-cols-1 gap-3">
                  <InfoCell label="Nombre" value={selectedClient.deliveryNoteName || '—'} />
                  <InfoCell
                    label="Documento"
                    value={selectedClient.deliveryNoteDocumentId || '—'}
                  />
                  <InfoCell label="Teléfono" value={selectedClient.deliveryNotePhone || '—'} />
                  <InfoCell
                    label="Dirección"
                    value={selectedClient.deliveryNoteAddress || '—'}
                  />
                </div>
              </div>
            </div>

            <div className="rounded-2xl border border-[#242433] bg-[#121218] p-4">
              <div className="text-sm font-semibold text-[#F5F5F7]">Direcciones recientes</div>
              <div className="mt-4 grid grid-cols-1 gap-3 xl:grid-cols-2">
                {normalizeClientAddresses(selectedClient.recentAddresses).length === 0 ? (
                  <div className="text-sm text-[#B7B7C2]">No hay direcciones guardadas.</div>
                ) : (
                  normalizeClientAddresses(selectedClient.recentAddresses).map((address, idx) => (
                    <div key={`${selectedClient.id}-${idx}`} className="rounded-xl border border-[#242433] bg-[#0B0B0D] p-3">
                      <div className="text-xs text-[#8A8A96]">Dirección {idx + 1}</div>
                      <div className="mt-2 text-sm text-[#F5F5F7]">{address.addressText || '—'}</div>
                      <div className="mt-3 text-xs text-[#8A8A96]">GPS</div>
                      <div className="mt-1 break-all text-sm text-[#B7B7C2]">{address.gpsUrl || '—'}</div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        )}
      </Drawer>

      <Drawer
        open={clientCreateOpen}
        title="Nuevo cliente"
        onClose={() => setClientCreateOpen(false)}
        widthClass="w-[900px]"
      >
        <div className="space-y-4">
          <div className="rounded-2xl border border-[#242433] bg-[#121218] p-4">
            <div className="text-sm font-semibold text-[#F5F5F7]">Datos básicos</div>
            <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
              <FieldInput label="Nombre completo" value={clientFormFullName} onChange={setClientFormFullName} />
              <FieldInput label="Teléfono" value={clientFormPhone} onChange={setClientFormPhone} />
              <FieldInput label="Tipo de cliente" value={clientFormType} onChange={setClientFormType} />
              <FieldSelect
                label="Asesor principal"
                value={clientFormPrimaryAdvisorId}
                onChange={setClientFormPrimaryAdvisorId}
                options={[
                  { value: '', label: '— sin asesor principal —' },
                  ...advisors.map((advisor) => ({
                    value: advisor.userId,
                    label: advisor.fullName,
                  })),
                ]}
              />
            </div>
            <div className="mt-3">
              <label className="mb-1 block text-xs text-[#8A8A96]">Notas</label>
              <textarea
                value={clientFormNotes}
                onChange={(e) => setClientFormNotes(e.target.value)}
                rows={3}
                className="w-full rounded-xl border border-[#242433] bg-[#0B0B0D] px-3 py-2 text-sm text-[#F5F5F7]"
              />
            </div>
            <label className="mt-3 flex items-center gap-2 text-sm text-[#F5F5F7]">
              <input
                type="checkbox"
                checked={clientFormIsActive}
                onChange={(e) => setClientFormIsActive(e.target.checked)}
              />
              Activo
            </label>
          </div>

          <div className="rounded-2xl border border-[#242433] bg-[#121218] p-4">
            <div className="text-sm font-semibold text-[#F5F5F7]">CRM</div>
            <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
              <FieldInput label="Cumpleaños" value={clientFormBirthDate} onChange={setClientFormBirthDate} type="date" />
              <FieldInput
                label="Fecha importante"
                value={clientFormImportantDate}
                onChange={setClientFormImportantDate}
                type="date"
              />
            </div>
            <div className="mt-3">
              <FieldInput
                label="Etiquetas (separadas por coma)"
                value={clientFormTagsInput}
                onChange={setClientFormTagsInput}
              />
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <div className="rounded-2xl border border-[#242433] bg-[#121218] p-4">
              <div className="text-sm font-semibold text-[#F5F5F7]">Factura</div>
              <div className="mt-4 grid grid-cols-1 gap-3">
                <FieldInput
                  label="Razón social"
                  value={clientFormBillingCompanyName}
                  onChange={setClientFormBillingCompanyName}
                />
                <FieldInput label="RIF / documento" value={clientFormBillingTaxId} onChange={setClientFormBillingTaxId} />
                <FieldInput label="Teléfono" value={clientFormBillingPhone} onChange={setClientFormBillingPhone} />
                <div>
                  <label className="mb-1 block text-xs text-[#8A8A96]">Dirección fiscal</label>
                  <textarea
                    value={clientFormBillingAddress}
                    onChange={(e) => setClientFormBillingAddress(e.target.value)}
                    rows={3}
                    className="w-full rounded-xl border border-[#242433] bg-[#0B0B0D] px-3 py-2 text-sm text-[#F5F5F7]"
                  />
                </div>
              </div>
            </div>

            <div className="rounded-2xl border border-[#242433] bg-[#121218] p-4">
              <div className="text-sm font-semibold text-[#F5F5F7]">Nota de entrega</div>
              <div className="mt-4 grid grid-cols-1 gap-3">
                <FieldInput label="Nombre" value={clientFormDeliveryNoteName} onChange={setClientFormDeliveryNoteName} />
                <FieldInput
                  label="Documento"
                  value={clientFormDeliveryNoteDocumentId}
                  onChange={setClientFormDeliveryNoteDocumentId}
                />
                <FieldInput
                  label="Teléfono"
                  value={clientFormDeliveryNotePhone}
                  onChange={setClientFormDeliveryNotePhone}
                />
                <div>
                  <label className="mb-1 block text-xs text-[#8A8A96]">Dirección</label>
                  <textarea
                    value={clientFormDeliveryNoteAddress}
                    onChange={(e) => setClientFormDeliveryNoteAddress(e.target.value)}
                    rows={3}
                    className="w-full rounded-xl border border-[#242433] bg-[#0B0B0D] px-3 py-2 text-sm text-[#F5F5F7]"
                  />
                </div>
              </div>
            </div>
          </div>

          <div className="rounded-2xl border border-[#242433] bg-[#121218] p-4">
            <div className="text-sm font-semibold text-[#F5F5F7]">Direcciones recientes</div>
            <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-2">
              <div className="space-y-3">
                <div>
                  <label className="mb-1 block text-xs text-[#8A8A96]">Dirección 1</label>
                  <textarea
                    value={clientFormAddress1Text}
                    onChange={(e) => setClientFormAddress1Text(e.target.value)}
                    rows={4}
                    className="w-full rounded-xl border border-[#242433] bg-[#0B0B0D] px-3 py-2 text-sm text-[#F5F5F7]"
                  />
                </div>
                <FieldInput label="GPS 1" value={clientFormAddress1Gps} onChange={setClientFormAddress1Gps} />
              </div>

              <div className="space-y-3">
                <div>
                  <label className="mb-1 block text-xs text-[#8A8A96]">Dirección 2</label>
                  <textarea
                    value={clientFormAddress2Text}
                    onChange={(e) => setClientFormAddress2Text(e.target.value)}
                    rows={4}
                    className="w-full rounded-xl border border-[#242433] bg-[#0B0B0D] px-3 py-2 text-sm text-[#F5F5F7]"
                  />
                </div>
                <FieldInput label="GPS 2" value={clientFormAddress2Gps} onChange={setClientFormAddress2Gps} />
              </div>
            </div>
          </div>

          <div className="flex gap-2">
            <button
              className="rounded-xl border border-[#242433] bg-[#0B0B0D] px-4 py-2 text-sm"
              onClick={() => setClientCreateOpen(false)}
              disabled={clientSaving}
            >
              Cancelar
            </button>
            <button
              className="rounded-xl bg-[#FEEF00] px-4 py-2 text-sm font-semibold text-[#0B0B0D]"
              onClick={handleCreateClient}
              disabled={clientSaving}
            >
              {clientSaving ? 'Guardando...' : 'Crear cliente'}
            </button>
          </div>
        </div>
      </Drawer>

      <Drawer
        open={clientEditOpen}
        title={selectedClient ? `Editar: ${selectedClient.fullName}` : 'Editar cliente'}
        onClose={() => setClientEditOpen(false)}
        widthClass="w-[900px]"
      >
        <div className="space-y-4">
          <div className="rounded-2xl border border-[#242433] bg-[#121218] p-4">
            <div className="text-sm font-semibold text-[#F5F5F7]">Datos básicos</div>
            <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
              <FieldInput label="Nombre completo" value={clientFormFullName} onChange={setClientFormFullName} />
              <FieldInput label="Teléfono" value={clientFormPhone} onChange={setClientFormPhone} />
              <FieldInput label="Tipo de cliente" value={clientFormType} onChange={setClientFormType} />
              <FieldSelect
                label="Asesor principal"
                value={clientFormPrimaryAdvisorId}
                onChange={setClientFormPrimaryAdvisorId}
                options={[
                  { value: '', label: '— sin asesor principal —' },
                  ...advisors.map((advisor) => ({
                    value: advisor.userId,
                    label: advisor.fullName,
                  })),
                ]}
              />
            </div>
            <div className="mt-3">
              <label className="mb-1 block text-xs text-[#8A8A96]">Notas</label>
              <textarea
                value={clientFormNotes}
                onChange={(e) => setClientFormNotes(e.target.value)}
                rows={3}
                className="w-full rounded-xl border border-[#242433] bg-[#0B0B0D] px-3 py-2 text-sm text-[#F5F5F7]"
              />
            </div>
            <label className="mt-3 flex items-center gap-2 text-sm text-[#F5F5F7]">
              <input
                type="checkbox"
                checked={clientFormIsActive}
                onChange={(e) => setClientFormIsActive(e.target.checked)}
              />
              Activo
            </label>
          </div>

          <div className="rounded-2xl border border-[#242433] bg-[#121218] p-4">
            <div className="text-sm font-semibold text-[#F5F5F7]">CRM</div>
            <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
              <FieldInput label="Cumpleaños" value={clientFormBirthDate} onChange={setClientFormBirthDate} type="date" />
              <FieldInput
                label="Fecha importante"
                value={clientFormImportantDate}
                onChange={setClientFormImportantDate}
                type="date"
              />
            </div>
            <div className="mt-3">
              <FieldInput
                label="Etiquetas (separadas por coma)"
                value={clientFormTagsInput}
                onChange={setClientFormTagsInput}
              />
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <div className="rounded-2xl border border-[#242433] bg-[#121218] p-4">
              <div className="text-sm font-semibold text-[#F5F5F7]">Factura</div>
              <div className="mt-4 grid grid-cols-1 gap-3">
                <FieldInput
                  label="Razón social"
                  value={clientFormBillingCompanyName}
                  onChange={setClientFormBillingCompanyName}
                />
                <FieldInput label="RIF / documento" value={clientFormBillingTaxId} onChange={setClientFormBillingTaxId} />
                <FieldInput label="Teléfono" value={clientFormBillingPhone} onChange={setClientFormBillingPhone} />
                <div>
                  <label className="mb-1 block text-xs text-[#8A8A96]">Dirección fiscal</label>
                  <textarea
                    value={clientFormBillingAddress}
                    onChange={(e) => setClientFormBillingAddress(e.target.value)}
                    rows={3}
                    className="w-full rounded-xl border border-[#242433] bg-[#0B0B0D] px-3 py-2 text-sm text-[#F5F5F7]"
                  />
                </div>
              </div>
            </div>

            <div className="rounded-2xl border border-[#242433] bg-[#121218] p-4">
              <div className="text-sm font-semibold text-[#F5F5F7]">Nota de entrega</div>
              <div className="mt-4 grid grid-cols-1 gap-3">
                <FieldInput label="Nombre" value={clientFormDeliveryNoteName} onChange={setClientFormDeliveryNoteName} />
                <FieldInput
                  label="Documento"
                  value={clientFormDeliveryNoteDocumentId}
                  onChange={setClientFormDeliveryNoteDocumentId}
                />
                <FieldInput
                  label="Teléfono"
                  value={clientFormDeliveryNotePhone}
                  onChange={setClientFormDeliveryNotePhone}
                />
                <div>
                  <label className="mb-1 block text-xs text-[#8A8A96]">Dirección</label>
                  <textarea
                    value={clientFormDeliveryNoteAddress}
                    onChange={(e) => setClientFormDeliveryNoteAddress(e.target.value)}
                    rows={3}
                    className="w-full rounded-xl border border-[#242433] bg-[#0B0B0D] px-3 py-2 text-sm text-[#F5F5F7]"
                  />
                </div>
              </div>
            </div>
          </div>

          <div className="rounded-2xl border border-[#242433] bg-[#121218] p-4">
            <div className="text-sm font-semibold text-[#F5F5F7]">Direcciones recientes</div>
            <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-2">
              <div className="space-y-3">
                <div>
                  <label className="mb-1 block text-xs text-[#8A8A96]">Dirección 1</label>
                  <textarea
                    value={clientFormAddress1Text}
                    onChange={(e) => setClientFormAddress1Text(e.target.value)}
                    rows={4}
                    className="w-full rounded-xl border border-[#242433] bg-[#0B0B0D] px-3 py-2 text-sm text-[#F5F5F7]"
                  />
                </div>
                <FieldInput label="GPS 1" value={clientFormAddress1Gps} onChange={setClientFormAddress1Gps} />
              </div>

              <div className="space-y-3">
                <div>
                  <label className="mb-1 block text-xs text-[#8A8A96]">Dirección 2</label>
                  <textarea
                    value={clientFormAddress2Text}
                    onChange={(e) => setClientFormAddress2Text(e.target.value)}
                    rows={4}
                    className="w-full rounded-xl border border-[#242433] bg-[#0B0B0D] px-3 py-2 text-sm text-[#F5F5F7]"
                  />
                </div>
                <FieldInput label="GPS 2" value={clientFormAddress2Gps} onChange={setClientFormAddress2Gps} />
              </div>
            </div>
          </div>

          <div className="flex gap-2">
            <button
              className="rounded-xl border border-[#242433] bg-[#0B0B0D] px-4 py-2 text-sm"
              onClick={() => setClientEditOpen(false)}
              disabled={clientSaving}
            >
              Cancelar
            </button>
            <button
              className="rounded-xl bg-[#FEEF00] px-4 py-2 text-sm font-semibold text-[#0B0B0D]"
              onClick={handleUpdateClient}
              disabled={clientSaving}
            >
              {clientSaving ? 'Guardando...' : 'Guardar cliente'}
            </button>
          </div>
        </div>
      </Drawer>
<Drawer
    open={createOrderOpen}
  title={orderEditorMode === 'edit' ? `Editar orden #${editingOrderId ?? ''}` : 'Nueva orden'}
  onClose={() => setCreateOrderOpen(false)}
  widthClass="w-[900px]"
>
  <div className="space-y-4">
    <div className="flex items-center justify-between rounded-2xl border border-[#242433] bg-[#121218] px-4 py-3">
      <div className="text-sm text-[#B7B7C2]">
        {orderEditorMode === 'edit'
          ? 'Estás modificando una orden existente.'
          : 'Estás creando una orden nueva.'}
      </div>

      <span
        className={[
          'rounded-full px-3 py-1 text-xs font-semibold',
          orderEditorMode === 'edit'
            ? 'bg-orange-500 text-[#0B0B0D]'
            : 'bg-[#FEEF00] text-[#0B0B0D]',
        ].join(' ')}
      >
        {orderEditorMode === 'edit' ? 'MODO EDIT' : 'MODO CREATE'}
      </span>
    </div>
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
<div className="rounded-2xl border border-[#242433] bg-[#121218] p-4">
  <div className="text-sm font-semibold text-[#F5F5F7]">A. Venta</div>

  <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
    <FieldSelect
      label="Source"
      value={createOrderSource}
      onChange={(value) =>
        setCreateOrderSource(value as 'advisor' | 'master' | 'walk_in')
      }
      options={[
        { value: 'master', label: 'master' },
        { value: 'advisor', label: 'advisor' },
        { value: 'walk_in', label: 'walk_in' },
      ]}
    />

{createOrderSource === 'advisor' ? (
  <div>
    <FieldSelect
      label="Asesor atribuido"
      value={createOrderAdvisorUserId}
      onChange={setCreateOrderAdvisorUserId}
      options={[
        { value: '', label: '— seleccionar —' },
        ...advisors.map((advisor) => ({
          value: advisor.userId,
          label: advisor.isActive
            ? advisor.fullName
            : `${advisor.fullName} (inactivo)`,
        })),
      ]}
    />

    <div className="mt-2 text-xs text-[#8A8A96]">
      Asesores cargados: {advisors.map((a) => a.fullName).join(', ') || 'ninguno'}
    </div>
  </div>
) : (
  <div>
    <label className="mb-1 block text-xs text-[#8A8A96]">Asesor atribuido</label>
    <div className="w-full rounded-xl border border-[#242433] bg-[#0B0B0D] px-3 py-2 text-sm text-[#F5F5F7]">
      {currentOperatorLabel}
    </div>
  </div>
)}
  </div>
</div>


      <div className="rounded-2xl border border-[#242433] bg-[#121218] p-4">
        <div className="text-sm font-semibold text-[#F5F5F7]">B. Cliente</div>

        <div className="mt-4 space-y-3">
<form
  className="flex gap-2"
  onSubmit={(e) => {
    e.preventDefault();
    handleSearchCreateOrderClients();
  }}
>
  <input
    value={createOrderClientSearch}
    onChange={(e) => setCreateOrderClientSearch(e.target.value)}
    placeholder="Buscar por nombre o teléfono…"
    className="w-full rounded-xl border border-[#242433] bg-[#0B0B0D] px-3 py-2 text-sm text-[#F5F5F7] placeholder:text-[#8A8A96]"
  />

  <button
    className="rounded-xl border border-[#242433] bg-[#0B0B0D] px-3 py-2 text-sm"
    type="submit"
  >
    {createOrderClientSearchLoading ? 'Buscando...' : 'Buscar'}
  </button>

  <button
    className="rounded-xl border border-[#242433] bg-[#0B0B0D] px-3 py-2 text-sm"
    onClick={handleActivateCreateOrderNewClient}
    type="button"
  >
    Nuevo
  </button>
</form>


          {createOrderSelectedClientId ? (
            <div className="rounded-xl border border-emerald-500/40 bg-[#0B0B0D] px-3 py-2
 text-sm">
              <div className="font-medium text-emerald-400">
                {createOrderSelectedClientName}
              </div>
              <div className="mt-1 text-[#B7B7C2]">
                Tel: {createOrderSelectedClientPhone || '—'}
              </div>
              <div className="mt-1 text-[#B7B7C2]">
                Tipo: {createOrderSelectedClientType || '—'}
              </div>
            </div>
          ) : null}

          {createOrderSelectedClientId && selectedCreateOrderClient ? (
            <div className="mt-2 rounded-xl border border-[#242433] bg-[#0B0B0D] p-3 text-sm text-[#B7B7C2]">
              {normalizeClientTags(selectedCreateOrderClient.crmTags).length > 0 ? (
                <div className="flex flex-wrap gap-1">
                  {normalizeClientTags(selectedCreateOrderClient.crmTags).slice(0, 5).map((tag) => (
                    <SmallBadge key={tag} label={tag} tone="muted" />
                  ))}
                </div>
              ) : null}
              {normalizeClientAddresses(selectedCreateOrderClient.recentAddresses).length > 0 ? (
                <div className="mt-2 flex flex-wrap gap-2">
                  {normalizeClientAddresses(selectedCreateOrderClient.recentAddresses).map((address, idx) => (
                    <button
                      key={`${selectedCreateOrderClient.id}-${idx}`}
                      type="button"
                      onClick={() => handleApplyClientAddress(address)}
                      className="rounded-xl border border-[#242433] bg-[#121218] px-3 py-2 text-xs text-[#F5F5F7]"
                    >
                      Usar dirección {idx + 1}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}

          {createOrderClientResults.length > 0 ? (
            <div className="max-h-[220px] space-y-2 overflow-y-auto">
              {createOrderClientResults.map((client) => (
                <button
                  key={client.id}
                  type="button"
                  onClick={() => handleSelectCreateOrderClient(client)}
                  className="w-full rounded-xl border border-[#242433] bg-[#0B0B0D] px-3 py-3 text-left"
                >
                  <div className="text-sm font-medium text-[#F5F5F7]">
                    {client.fullName}
                  </div>
                  <div className="mt-1 text-xs text-[#B7B7C2]">
                    Tel: {client.phone || '—'} · Tipo: {client.clientType || '—'}
                  </div>
                </button>
              ))}
            </div>
          ) : null}

{createOrderNewClientMode ? (
  <div className="grid grid-cols-1 gap-3 rounded-xl border border-[#242433] bg-[#0B0B0D] p-3">
    <FieldInput
      label="Nombre"
      value={createOrderNewClientName}
      onChange={setCreateOrderNewClientName}
    />

    <FieldInput
      label="Teléfono"
      value={createOrderNewClientPhone}
      onChange={setCreateOrderNewClientPhone}
    />

    <FieldSelect
      label="Tipo cliente"
      value={createOrderNewClientType}
      onChange={(value) =>
        setCreateOrderNewClientType(
          value as 'assigned' | 'own' | 'legacy'
        )
      }
      options={[
        { value: 'assigned', label: 'Asignado' },
        { value: 'own', label: 'Propio' },
        { value: 'legacy', label: 'Antiguo' },
      ]}
    />

    <div className="flex justify-end">
      <button
        type="button"
        onClick={handleCreateOrderClientNow}
        className="rounded-xl bg-[#FEEF00] px-4 py-2 text-sm font-semibold text-[#0B0B0D]"
      >
        Crear cliente
      </button>
    </div>
  </div>
) : null}

        </div>
      </div>

      <div className="rounded-2xl border border-[#242433] bg-[#121218] p-4 md:col-span-2">
        <div className="text-sm font-semibold text-[#F5F5F7]">C. Pedido</div>

<div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-[1fr_110px_auto]">
  <div className="relative">
    <label className="mb-1 block text-xs text-[#8A8A96]">Producto</label>
    <input
  ref={createOrderProductSearchRef}
  value={createOrderProductSearch}
  onChange={(e) => {
    const value = e.target.value;
    setCreateOrderProductSearch(value);
    setCreateOrderProductActiveIndex(-1);

    const firstMatch = catalogItems
      .filter((item) => item.isActive)
      .find((item) => {
        const q = value.trim().toLowerCase();
        if (!q) return false;
        return (
          item.name.toLowerCase().includes(q) ||
          (item.sku || '').toLowerCase().includes(q)
        );
      });

    setCreateOrderSelectedProductId(firstMatch ? firstMatch.id : '');
  }}
  onKeyDown={(e) => {
    if (!createOrderProductSearch.trim() || createOrderFilteredProducts.length === 0) {
      return;
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCreateOrderProductActiveIndex((prev) => {
        const next = prev < createOrderFilteredProducts.length - 1 ? prev + 1 : 0;
        setCreateOrderSelectedProductId(createOrderFilteredProducts[next]?.id ?? '');
        return next;
      });
      return;
    }

    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCreateOrderProductActiveIndex((prev) => {
        const next = prev > 0 ? prev - 1 : createOrderFilteredProducts.length - 1;
        setCreateOrderSelectedProductId(createOrderFilteredProducts[next]?.id ?? '');
        return next;
      });
      return;
    }

    if (e.key === 'Enter') {
      if (createOrderProductActiveIndex >= 0 && createOrderFilteredProducts[createOrderProductActiveIndex]) {
        e.preventDefault();
        const selected = createOrderFilteredProducts[createOrderProductActiveIndex];
        setCreateOrderSelectedProductId(selected.id);
        setCreateOrderProductSearch(selected.name);

        setTimeout(() => {
          createOrderQtyRef.current?.focus();
          createOrderQtyRef.current?.select();
        }, 0);
      }
    }
  }}
  placeholder="Escribe producto..."
  className="w-full rounded-xl border border-[#242433] bg-[#0B0B0D] px-3 py-2 text-sm text-[#F5F5F7] placeholder:text-[#8A8A96]"
/>


    {createOrderProductSearch.trim() ? (
      <div className="absolute z-20 mt-2 max-h-[260px] w-full overflow-y-auto rounded-xl border border-[#242433] bg-[#0B0B0D]">
        {createOrderFilteredProducts.length === 0 ? (
          <div className="px-3 py-3 text-sm text-[#8A8A96]">
            Sin resultados
          </div>
        ) : (
          createOrderFilteredProducts.map((item) => (
<button
  key={item.id}
  type="button"
  onClick={() => {
    setCreateOrderSelectedProductId(item.id);
    setCreateOrderProductSearch(item.name);
    setCreateOrderProductActiveIndex(
      createOrderFilteredProducts.findIndex((p) => p.id === item.id)
    );

    setTimeout(() => {
      createOrderQtyRef.current?.focus();
      createOrderQtyRef.current?.select();
    }, 0);
  }}
  className={[
    'w-full border-b border-[#191926] px-3 py-2 text-left last:border-b-0',
    createOrderFilteredProducts[createOrderProductActiveIndex]?.id === item.id
      ? 'bg-[#121218]'
      : 'hover:bg-[#121218]',
  ].join(' ')}
>

              <div className="text-sm font-medium text-[#F5F5F7]">
                {item.name}
              </div>
<div className="mt-1 text-xs text-[#8A8A96]">
  {item.unitsPerService > 0 ? `${item.unitsPerService} und/serv` : '—'} ·{' '}
  {item.sourcePriceCurrency === 'VES'
    ? fmtBs(item.basePriceBs)
    : fmtUSD(item.basePriceUsd)}
  {item.sku ? ` · ${item.sku}` : ''}
</div>
            </button>
          ))
        )}
      </div>
    ) : null}
  </div>

  <div>
    <label className="mb-1 block text-xs text-[#8A8A96]">Cantidad</label>
    <input
      ref={createOrderQtyRef}
      value={String(createOrderQty)}
      onChange={(e) => setCreateOrderQty(Number(e.target.value || 0))}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          handleAddCreateOrderItem();
        }
      }}
      type="number"
      className="w-full rounded-xl border border-[#242433] bg-[#0B0B0D] px-3 py-2 text-sm text-[#F5F5F7]"
    />
  </div>

  <div className="flex items-end">
    <button
      type="button"
      onClick={handleAddCreateOrderItem}
      className="w-full rounded-xl border border-[#242433] bg-[#0B0B0D] px-3 py-2 text-sm"
    >
      Agregar
    </button>
  </div>
</div>

        {createOrderDraftItems.length === 0 ? (
          <div className="mt-4 rounded-xl border border-[#242433] bg-[#0B0B0D] px-3 py-3 text-sm text-[#B7B7C2]">
            Sin ítems cargados.
          </div>
        ) : (
          <div className="mt-4 space-y-2">
            {createOrderDraftItems.map((item, idx) => (
              <div
                key={item.localId}
                className="grid grid-cols-1 gap-3 rounded-xl border border-[#242433] bg-[#0B0B0D] p-3 md:grid-cols-[40px_1fr_90px_110px_110px_auto]"
              >
                <div className="text-sm text-[#B7B7C2]">{idx + 1}</div>

<div>
  <div className="text-sm font-medium text-[#F5F5F7]">{item.productNameSnapshot}</div>
  <div className="mt-1 text-xs text-[#8A8A96]">{item.skuSnapshot || '—'}</div>

  {item.editableDetailLines.length > 0 ? (
    <div className="mt-2 space-y-1 text-xs text-[#B7B7C2]">
      {item.editableDetailLines.map((detail, detailIdx) => (
        <div key={detailIdx}>• {detail}</div>
      ))}
    </div>
  ) : null}
</div>

<FieldInput
  label="Qty"
  value={String(item.qty)}
  onChange={(value) =>
    handleUpdateCreateOrderItemQty(
      item.localId,
      Number(value || 0)
    )
  }
  type="number"
/>

<div>
  <label className="mb-1 block text-xs text-[#8A8A96]">P/U</label>
  <div className="rounded-xl border border-[#242433] bg-[#121218] px-3 py-2 text-sm text-[#F5F5F7]">
    {item.sourcePriceCurrency === 'VES'
      ? fmtBs(item.sourcePriceAmount)
      : fmtUSD(item.sourcePriceAmount)}
  </div>
</div>

<div>
  <label className="mb-1 block text-xs text-[#8A8A96]">Total</label>
  <div className="rounded-xl border border-[#242433] bg-[#121218] px-3 py-2 text-sm text-[#F5F5F7]">
    {item.sourcePriceCurrency === 'VES'
      ? fmtBs(item.sourcePriceAmount * item.qty)
      : fmtUSD(item.sourcePriceAmount * item.qty)}
  </div>
</div>

<div className="flex items-end">
  <div className="flex w-full gap-2">
    {item.editableDetailLines.length > 0 ? (
      <button
        type="button"
        onClick={() => openEditCreateOrderConfig(item)}
        className="w-full rounded-xl border border-[#242433] bg-[#121218] px-3 py-2 text-sm text-[#F5F5F7]"
      >
        Editar
      </button>
    ) : null}

    <button
      type="button"
      onClick={() => handleRemoveCreateOrderItem(item.localId)}
      className="w-full rounded-xl border border-red-500 bg-[#0B0B0D] px-3 py-2 text-sm text-red-400"
    >
      Quitar
    </button>
  </div>
</div>
              </div>
            ))}

<div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-[1fr_auto] md:items-end">
  <div className="flex flex-wrap items-center gap-3">
    <div className="w-[100px]">
  <FieldInput
    label="Tasa usada (Bs.)"
    value={createOrderFxRate}
    onChange={setCreateOrderFxRate}
    type="number"
  />
</div>
<div>
  <label className="mb-1 block text-xs text-[#8A8A96]">Descuento</label>
  <label className="flex h-[39px] items-center gap-2 rounded-xl border border-[#242433] bg-[#0B0B0D] px-3 text-sm text-[#F5F5F7]">
    <input
      type="checkbox"
      checked={createOrderDiscountEnabled}
      onChange={(e) => {
        setCreateOrderDiscountEnabled(e.target.checked);
        if (!e.target.checked) setCreateOrderDiscountPct('0');
      }}
    />
    Aplicar %
  </label>
</div>


    {createOrderDiscountEnabled ? (
      <div className="w-[80px]">
        <FieldInput
          label="% Desc."
          value={createOrderDiscountPct}
          onChange={setCreateOrderDiscountPct}
          type="number"
        />
      </div>
    ) : null}
  </div>

<div className="rounded-xl border border-[#242433] bg-[#0B0B0D] px-4 py-2 text-sm text-[#F5F5F7]">
  <div>Subtotal: {fmtBs(createOrderDraftSubtotalBs)}</div>
  {createOrderDiscountEnabled ? (
    <div className="mt-1 text-orange-400">
      Descuento: -{fmtBs(createOrderDiscountAmountBs)}
    </div>
  ) : null}
  {createOrderHasInvoice && createOrderInvoiceTaxPctNumber > 0 ? (
    <div className="mt-1 text-sky-300">
      IVA ({createOrderInvoiceTaxPctNumber}%): +{fmtBs(createOrderInvoiceTaxAmountBs)}
    </div>
  ) : null}
  <div className="mt-1 font-semibold">
    Total: {fmtBs(createOrderDraftTotalBs)} / {fmtUSD(createOrderDraftTotalUsd)}
  </div>
</div>
</div>
          </div>
        )}
      </div>
<div className="rounded-2xl border border-[#242433] bg-[#121218] p-4 md:col-span-2">
  <div className="text-sm font-semibold text-[#F5F5F7]">D. Entrega</div>

  <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-[minmax(0,560px)_minmax(320px,1fr)]">
    <div className="grid grid-cols-1 gap-3">
      <div className="grid grid-cols-[100px_130px_240px] gap-2">
        <FieldSelect
          label="Tipo"
          value={createOrderFulfillment}
          onChange={(value) =>
            setCreateOrderFulfillment(value as 'pickup' | 'delivery')
          }
          options={[
            { value: 'pickup', label: 'pickup' },
            { value: 'delivery', label: 'delivery' },
          ]}
        />

        <FieldInput
          label="Fecha"
          value={createOrderDeliveryDate}
          onChange={setCreateOrderDeliveryDate}
          type="date"
        />

        <div>
          <label className="mb-1 block text-xs text-[#8A8A96]">Hora</label>
          <div className="grid grid-cols-[68px_68px_84px] gap-2">
            <input
              value={createOrderDeliveryHour12}
              onChange={(e) => setCreateOrderDeliveryHour12(e.target.value)}
              type="number"
              className="w-full rounded-xl border border-[#242433] bg-[#0B0B0D] px-3 py-2 text-sm text-[#F5F5F7]"
            />
            <input
              value={createOrderDeliveryMinute}
              onChange={(e) => setCreateOrderDeliveryMinute(e.target.value)}
              type="number"
              className="w-full rounded-xl border border-[#242433] bg-[#0B0B0D] px-3 py-2 text-sm text-[#F5F5F7]"
            />
            <select
              value={createOrderDeliveryAmPm}
              onChange={(e) => setCreateOrderDeliveryAmPm(e.target.value as 'AM' | 'PM')}
              className="w-full rounded-xl border border-[#242433] bg-[#0B0B0D] px-3 py-2 text-sm text-[#F5F5F7]"
            >
              <option value="AM">AM</option>
              <option value="PM">PM</option>
            </select>
          </div>
        </div>
      </div>

      <div>
        <label className="flex items-center gap-2 rounded-xl border border-[#242433] bg-[#0B0B0D] px-3 py-2 text-sm text-[#F5F5F7]">
          <input
            type="checkbox"
            checked={createOrderReceiverIsDifferent}
            onChange={(e) => {
              setCreateOrderReceiverIsDifferent(e.target.checked);
              if (!e.target.checked) {
                setCreateOrderReceiverName('');
                setCreateOrderReceiverPhone('');
              }
            }}
          />
          Recibe otra persona
        </label>
      </div>

      {createOrderReceiverIsDifferent ? (
        <div className="grid grid-cols-2 gap-3">
          <FieldInput
            label="Quién recibe"
            value={createOrderReceiverName}
            onChange={setCreateOrderReceiverName}
          />

          <FieldInput
            label="Teléfono recibe"
            value={createOrderReceiverPhone}
            onChange={setCreateOrderReceiverPhone}
          />
        </div>
      ) : null}
    </div>

    <div className="grid grid-cols-1 gap-3 min-w-0">
      {createOrderFulfillment === 'delivery' ? (
        <div className="min-w-0">
          <label className="mb-1 block text-xs text-[#8A8A96]">Dirección</label>
          <textarea
            value={createOrderDeliveryAddress}
            onChange={(e) => setCreateOrderDeliveryAddress(e.target.value)}
            rows={3}
            className="w-full rounded-xl border border-[#242433] bg-[#0B0B0D] px-3 py-2 text-sm text-[#F5F5F7]"
          />
          <div className="mt-3">
            <FieldInput
              label="GPS URL"
              value={createOrderDeliveryGpsUrl}
              onChange={setCreateOrderDeliveryGpsUrl}
            />
          </div>
        </div>
      ) : null}

      <div className="min-w-0">
        <label className="mb-1 block text-xs text-[#8A8A96]">Nota general</label>
        <textarea
          value={createOrderNote}
          onChange={(e) => setCreateOrderNote(e.target.value)}
          rows={createOrderFulfillment === 'delivery' ? 3 : 4}
          className="w-full rounded-xl border border-[#242433] bg-[#0B0B0D] px-3 py-2 text-sm text-[#F5F5F7]"
        />
      </div>
    </div>
  </div>
</div>

<div className="rounded-2xl border border-[#242433] bg-[#121218] p-4 md:col-span-2">
  <div className="text-sm font-semibold text-[#F5F5F7]">E. Condición de pago</div>

  <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">

<FieldSelect
  label="Forma de pago"
  value={createOrderPaymentMethod}
  onChange={setCreateOrderPaymentMethod}
  options={[
{ value: 'pending', label: 'Pendiente' },
{ value: 'payment_mobile', label: 'Pago móvil' },
{ value: 'transfer', label: 'Transferencia' },
{ value: 'cash_usd', label: 'Efectivo USD' },
{ value: 'cash_ves', label: 'Efectivo Bs' },
{ value: 'zelle', label: 'Zelle' },
{ value: 'mixed', label: 'Mixto' },
  ]}
/>

{createOrderPaymentMethod === 'mixed' ? (
  <FieldSelect
    label="Moneda principal"
    value={createOrderPaymentCurrency}
    onChange={(value) => setCreateOrderPaymentCurrency(value as 'USD' | 'VES')}
    options={[
      { value: 'USD', label: 'USD' },
      { value: 'VES', label: 'Bs' },
    ]}
  />
) : (
  <div>
    <label className="mb-1 block text-xs text-[#8A8A96]">Moneda principal</label>
    <div className="w-full rounded-xl border border-[#242433] bg-[#0B0B0D] px-3 py-2 text-sm text-[#F5F5F7]">
      {createOrderPaymentCurrency === 'USD' ? 'USD' : 'Bs'}
    </div>
  </div>
)}

    <FieldCheckbox
      label="Requiere cambio"
      checked={createOrderPaymentRequiresChange}
      onChange={(value) => {
        setCreateOrderPaymentRequiresChange(value);
        if (!value) {
          setCreateOrderPaymentChangeFor('');
        }
      }}
    />

    <FieldCheckbox
      label="Lleva nota de entrega"
      checked={createOrderHasDeliveryNote}
      onChange={(value) => {
        setCreateOrderHasDeliveryNote(value);
        if (!value) {
          setCreateOrderDeliveryNoteName('');
          setCreateOrderDeliveryNoteDocumentId('');
          setCreateOrderDeliveryNoteAddress('');
          setCreateOrderDeliveryNotePhone('');
        }
      }}
    />

    <FieldCheckbox
      label="Lleva factura"
      checked={createOrderHasInvoice}
      onChange={(value) => {
        setCreateOrderHasInvoice(value);
        if (value && !String(createOrderInvoiceTaxPct || '').trim()) {
          setCreateOrderInvoiceTaxPct('16');
        }
        if (!value) {
          setCreateOrderInvoiceDataNote('');
          setCreateOrderInvoiceCompanyName('');
          setCreateOrderInvoiceTaxId('');
          setCreateOrderInvoiceAddress('');
          setCreateOrderInvoicePhone('');
          setCreateOrderInvoiceTaxPct('16');
        }
      }}
    />
  </div>

  {createOrderPaymentRequiresChange ? (
    <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
      <FieldInput
        label="Cambio para"
        value={createOrderPaymentChangeFor}
        onChange={setCreateOrderPaymentChangeFor}
        type="number"
      />

      <FieldSelect
        label="Moneda del cambio"
        value={createOrderPaymentChangeCurrency}
        onChange={(value) => setCreateOrderPaymentChangeCurrency(value as 'USD' | 'VES')}
        options={[
          { value: 'USD', label: 'USD' },
          { value: 'VES', label: 'Bs' },
        ]}
      />
    </div>
  ) : null}

  {createOrderHasInvoice ? (
    <div className="mt-3 grid grid-cols-1 gap-3 rounded-xl border border-[#242433] bg-[#0B0B0D] p-3 md:grid-cols-2">
      <FieldInput
        label="Nombre / razón social"
        value={createOrderInvoiceCompanyName}
        onChange={setCreateOrderInvoiceCompanyName}
      />
      <FieldInput
        label="RIF / documento"
        value={createOrderInvoiceTaxId}
        onChange={setCreateOrderInvoiceTaxId}
      />
      <FieldInput
        label="Teléfono"
        value={createOrderInvoicePhone}
        onChange={setCreateOrderInvoicePhone}
      />
      <FieldInput
        label="% IVA"
        value={createOrderInvoiceTaxPct}
        onChange={setCreateOrderInvoiceTaxPct}
        type="text"
      />
      <div className="md:col-span-2">
        <label className="mb-1 block text-xs text-[#8A8A96]">Dirección fiscal</label>
        <textarea
          value={createOrderInvoiceAddress}
          onChange={(e) => setCreateOrderInvoiceAddress(e.target.value)}
          rows={2}
          className="w-full rounded-xl border border-[#242433] bg-[#121218] px-3 py-2 text-sm text-[#F5F5F7]"
        />
      </div>
    </div>
  ) : null}

  {createOrderHasDeliveryNote ? (
    <div className="mt-3 grid grid-cols-1 gap-3 rounded-xl border border-[#242433] bg-[#0B0B0D] p-3 md:grid-cols-2">
      <FieldInput
        label="Nombre"
        value={createOrderDeliveryNoteName}
        onChange={setCreateOrderDeliveryNoteName}
      />
      <FieldInput
        label="Documento"
        value={createOrderDeliveryNoteDocumentId}
        onChange={setCreateOrderDeliveryNoteDocumentId}
      />
      <FieldInput
        label="Teléfono"
        value={createOrderDeliveryNotePhone}
        onChange={setCreateOrderDeliveryNotePhone}
      />
      <div className="md:col-span-2">
        <label className="mb-1 block text-xs text-[#8A8A96]">Dirección</label>
        <textarea
          value={createOrderDeliveryNoteAddress}
          onChange={(e) => setCreateOrderDeliveryNoteAddress(e.target.value)}
          rows={2}
          className="w-full rounded-xl border border-[#242433] bg-[#121218] px-3 py-2 text-sm text-[#F5F5F7]"
        />
      </div>
    </div>
  ) : null}

  {selectedCreateOrderClient && (createOrderHasInvoice || createOrderHasDeliveryNote) ? (
    <div className="mt-3 rounded-xl border border-[#242433] bg-[#0B0B0D] p-3 text-sm text-[#B7B7C2]">
      {createOrderHasInvoice ? (
        <div>
          <span className="text-[#F5F5F7]">Factura:</span>{' '}
          {[
            createOrderInvoiceCompanyName,
            createOrderInvoiceTaxId,
            createOrderInvoiceAddress,
            createOrderInvoicePhone,
          ]
            .filter(Boolean)
            .join(' | ') || 'Sin datos guardados'}
        </div>
      ) : null}

      {createOrderHasDeliveryNote ? (
        <div className={createOrderHasInvoice ? 'mt-2' : ''}>
          <span className="text-[#F5F5F7]">Nota de entrega:</span>{' '}
          {[
            createOrderDeliveryNoteName,
            createOrderDeliveryNoteDocumentId,
            createOrderDeliveryNoteAddress,
            createOrderDeliveryNotePhone,
          ]
            .filter(Boolean)
            .join(' | ') || 'Sin datos guardados'}
        </div>
      ) : null}
    </div>
  ) : null}

  <div className="mt-3">
    <label className="mb-1 block text-xs text-[#8A8A96]">Observación de pago</label>
    <textarea
      value={createOrderPaymentNote}
      onChange={(e) => setCreateOrderPaymentNote(e.target.value)}
      rows={2}
      className="w-full rounded-xl border border-[#242433] bg-[#0B0B0D] px-3 py-2 text-sm text-[#F5F5F7]"
    />
  </div>
</div>

<div className="rounded-2xl border border-[#242433] bg-[#121218] p-4 md:col-span-2">
  <div className="text-sm font-semibold text-[#F5F5F7]">F. Resumen</div>

  <div className="mt-4 grid grid-cols-1 gap-3">
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
      <InfoCell
        label="Cliente"
        value={createOrderSelectedClientName || createOrderNewClientName || '—'}
      />

      <InfoCell label="Tipo" value={createOrderFulfillment} />

      <InfoCell label="Source" value={createOrderSource} />

      <InfoCell
        label="Asesor"
        value={
          createOrderSource === 'advisor'
            ? advisors.find((advisor) => advisor.userId === createOrderAdvisorUserId)?.fullName || '—'
            : currentOperatorLabel
        }
      />

      <InfoCell label="Ítems" value={String(createOrderDraftItems.length)} />

      <InfoCell
        label="Tasa"
        value={createOrderFxRateNumber > 0 ? fmtRateBs(createOrderFxRateNumber) : '—'}
      />

      <InfoCell
        label="Subtotal"
        value={fmtBs(createOrderDraftSubtotalBs)}
      />

      <InfoCell
        label="Total"
        value={`${fmtBs(createOrderDraftTotalBs)} / ${fmtUSD(createOrderDraftTotalUsd)}`}
      />

      <InfoCell
        label="Pago"
        value={getPaymentMethodLabel(createOrderPaymentMethod)}
      />

      {createOrderPaymentMethod === 'mixed' ? (
        <InfoCell
          label="Moneda"
          value={createOrderPaymentCurrency === 'USD' ? 'USD' : 'Bs'}
        />
      ) : null}

      {createOrderPaymentRequiresChange ? (
        <InfoCell
          label="Cambio"
          value={
            createOrderPaymentChangeFor
              ? `Para ${createOrderPaymentChangeFor} ${createOrderPaymentChangeCurrency === 'USD' ? 'USD' : 'Bs'}`
              : 'Sí'
          }
        />
      ) : null}

      {createOrderHasDeliveryNote ? (
        <InfoCell
          label="Nota de entrega"
          value="Sí"
        />
      ) : null}

      {createOrderHasInvoice ? (
        <InfoCell
          label="Factura"
          value="Sí"
        />
      ) : null}

      {createOrderDiscountEnabled && createOrderDiscountPctNumber > 0 ? (
        <InfoCell
          label="Descuento"
          value={`${createOrderDiscountPctNumber}% · -${fmtBs(createOrderDiscountAmountBs)}`}
        />
      ) : null}

      {createOrderHasInvoice && createOrderInvoiceTaxPctNumber > 0 ? (
        <InfoCell
          label="IVA"
          value={`${createOrderInvoiceTaxPctNumber}% · +${fmtBs(createOrderInvoiceTaxAmountBs)}`}
        />
      ) : null}
    </div>

    {createOrderPaymentNote.trim() ||
    (createOrderHasInvoice &&
      [createOrderInvoiceCompanyName, createOrderInvoiceTaxId, createOrderInvoiceAddress, createOrderInvoicePhone]
        .filter(Boolean)
        .length > 0) ||
    (createOrderHasDeliveryNote &&
      [
        createOrderDeliveryNoteName,
        createOrderDeliveryNoteDocumentId,
        createOrderDeliveryNoteAddress,
        createOrderDeliveryNotePhone,
      ]
        .filter(Boolean)
        .length > 0) ? (
      <div className="rounded-xl border border-[#242433] bg-[#0B0B0D] p-3 text-sm text-[#B7B7C2]">
        {createOrderPaymentNote.trim() ? (
          <div>
            <span className="text-[#F5F5F7]">Obs. pago:</span> {createOrderPaymentNote.trim()}
          </div>
        ) : null}

        {createOrderHasInvoice ? (
          <div className={createOrderPaymentNote.trim() ? 'mt-2' : ''}>
            <span className="text-[#F5F5F7]">Datos factura:</span>{' '}
            {[createOrderInvoiceCompanyName, createOrderInvoiceTaxId, createOrderInvoiceAddress, createOrderInvoicePhone]
              .filter(Boolean)
              .join(' | ') || '—'}
          </div>
        ) : null}

        {createOrderHasDeliveryNote ? (
          <div className={createOrderPaymentNote.trim() || createOrderHasInvoice ? 'mt-2' : ''}>
            <span className="text-[#F5F5F7]">Datos nota de entrega:</span>{' '}
            {[
              createOrderDeliveryNoteName,
              createOrderDeliveryNoteDocumentId,
              createOrderDeliveryNoteAddress,
              createOrderDeliveryNotePhone,
            ]
              .filter(Boolean)
              .join(' | ') || '—'}
          </div>
        ) : null}
      </div>
    ) : null}

    <div className="space-y-2 rounded-xl border border-[#242433] bg-[#0B0B0D] p-3 text-sm">
      <div className={createOrderHasClient ? 'text-emerald-400' : 'text-red-400'}>
        {createOrderHasClient ? '✅ Cliente listo' : '❌ Falta cliente'}
      </div>

      <div className={createOrderHasItems ? 'text-emerald-400' : 'text-red-400'}>
        {createOrderHasItems ? '✅ Pedido con ítems' : '❌ Falta agregar ítems'}
      </div>

      <div className={createOrderHasValidAdvisor ? 'text-emerald-400' : 'text-red-400'}>
        {createOrderHasValidAdvisor ? '✅ Asesor válido' : '❌ Debes seleccionar asesor'}
      </div>

      <div className={createOrderHasDeliveryAddress ? 'text-emerald-400' : 'text-red-400'}>
        {createOrderHasDeliveryAddress ? '✅ Entrega válida' : '❌ Falta dirección de delivery'}
      </div>
    </div>

{orderEditorMode === 'edit' && selectedOrder?.status === 'queued' ? (
  <div className="rounded-xl border border-orange-500/40 bg-[#0B0B0D] p-3 text-sm text-orange-400">
    Esta edición marcará la orden para <span className="font-semibold">re-aprobación</span>.
  </div>
) : null}

    <div className="flex justify-end gap-2">
      <button
        className="rounded-xl border border-[#242433] bg-[#0B0B0D] px-4 py-2 text-sm"
        onClick={() => setCreateOrderOpen(false)}
        type="button"
      >
        Cancelar
      </button>

<button
  className={[
    'rounded-xl px-4 py-2 text-sm font-semibold',
    createOrderCanSave
      ? 'bg-[#FEEF00] text-[#0B0B0D]'
      : 'bg-[#191926] text-[#8A8A96]',
  ].join(' ')}
  type="button"
  disabled={!createOrderCanSave}
  onClick={orderEditorMode === 'edit' ? handleUpdateOrder : handleCreateOrder}
>
  {orderEditorMode === 'edit' ? 'Guardar cambios de la orden' : 'Crear orden'}
</button>
    </div>
  </div>
</div>
    </div>
  </div>
</Drawer>

<Drawer
  open={createOrderConfigOpen}
  title={createOrderConfigProductName || 'Configurar producto'}
  onClose={closeCreateOrderConfig}
  widthClass="w-[560px]"
>
  <div className="space-y-4">
    <div className="rounded-2xl border border-[#242433] bg-[#121218] p-4">
      <div className="grid grid-cols-3 gap-3">
        <InfoCell label="Producto" value={createOrderConfigProductName || '—'} />
        <InfoCell label="Cant." value={String(createOrderConfigQty)} />
        <InfoCell label="Límite" value={String(createOrderConfigLimit || 0)} />
      </div>

      <div className="mt-3 grid grid-cols-[1fr_120px] gap-3">
<div>
  <label className="mb-1 block text-xs text-[#8A8A96]">Para</label>
  <input
    ref={createOrderConfigAliasRef}
    value={createOrderConfigAlias}
    onChange={(e) => setCreateOrderConfigAlias(e.target.value)}
    onKeyDown={(e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        createOrderConfigQtyRefs.current[0]?.focus();
        createOrderConfigQtyRefs.current[0]?.select();
      }
    }}
    className="w-full rounded-xl border border-[#242433] bg-[#0B0B0D] px-3 py-2 text-sm text-[#F5F5F7]"
  />
</div>

        <div>
          <label className="mb-1 block text-xs text-[#8A8A96]">Total piezas</label>
          <div className="rounded-xl border border-[#242433] bg-[#0B0B0D] px-3 py-2 text-sm text-[#F5F5F7]">
            {createOrderConfigSelectedUnits} / {createOrderConfigLimit}
          </div>
        </div>
      </div>
    </div>

    <div className="rounded-2xl border border-[#242433] bg-[#121218] p-4">
      <div className="text-sm font-semibold text-[#F5F5F7]">Composición</div>

      {createOrderConfigSelectableOptions.length === 0 ? (
        <div className="mt-3 rounded-xl border border-[#242433] bg-[#0B0B0D] px-3 py-3 text-sm text-[#B7B7C2]">
          Este producto no tiene opciones configuradas.
        </div>
      ) : (
        <div className="mt-3 space-y-2">
          {createOrderConfigSelectableOptions.map((option, idx) => {
            const currentQty =
              createOrderConfigSelections.find((x) => x.componentProductId === option.id)?.qty || 0;

return (
  <div
    key={option.id}
    className="grid grid-cols-[1fr_110px] items-center gap-3 rounded-xl border border-[#242433] bg-[#0B0B0D] px-3 py-2"
  >
    <div className="min-w-0">
      <div className="truncate text-sm font-medium text-[#F5F5F7]">
        {option.name}
      </div>
      <div className="mt-0.5 truncate text-[11px] text-[#8A8A96]">
        {option.sku || '—'}
      </div>
    </div>

    <div className="flex items-center justify-end gap-2">
      <label className="text-[11px] text-[#8A8A96]">Cant.</label>
      <input
        ref={(el) => {
          createOrderConfigQtyRefs.current[idx] = el;
        }}
        value={String(currentQty)}
        onChange={(e) =>
          handleSetCreateOrderConfigSelectionQty(option.id, option.name, Number(e.target.value || 0))
        }
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();

            const nextRef = createOrderConfigQtyRefs.current[idx + 1];
            if (nextRef) {
              nextRef.focus();
              nextRef.select();
            } else {
              handleConfirmCreateOrderConfig();
            }
          }
        }}
        type="number"
        min={0}
        className="w-[56px] rounded-lg border border-[#242433] bg-[#121218] px-2 py-1.5 text-sm text-[#F5F5F7]"
      />
    </div>
  </div>
);
          })}
        </div>
      )}
    </div>

    <div className="flex justify-end gap-2">
      <button
        type="button"
        className="rounded-xl border border-[#242433] bg-[#0B0B0D] px-4 py-2 text-sm"
        onClick={closeCreateOrderConfig}
      >
        Cancelar
      </button>

<button
  type="button"
  className="rounded-xl bg-[#FEEF00] px-4 py-2 text-sm font-semibold text-[#0B0B0D]"
  onClick={handleConfirmCreateOrderConfig}
>
  {createOrderConfigEditingLocalId ? 'Guardar ítem' : 'Confirmar'}
</button>
    </div>
  </div>
</Drawer>

{toast ? (
  <div className="pointer-events-none fixed right-4 top-4 z-[200]">
    <div
      className={[
        'min-w-[260px] max-w-[360px] rounded-xl border px-4 py-3 shadow-2xl backdrop-blur',
        toast.type === 'success'
          ? 'border-emerald-500/40 bg-[#07140D] text-emerald-300'
          : 'border-red-500/40 bg-[#17090A] text-red-300',
      ].join(' ')}
    >
      <div className="text-xs font-semibold uppercase tracking-wide opacity-80">
        {toast.type === 'success' ? 'Listo' : 'Error'}
      </div>
      <div className="mt-1 text-sm">{toast.message}</div>
    </div>
  </div>
) : null}
    </div>
  );
}
