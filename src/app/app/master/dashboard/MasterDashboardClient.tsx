'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { createSupabaseBrowser } from '@/lib/supabase/browser';
import {
  approveOrderAction,
  applyClientFundPaymentAction,
  assignExternalPartnerAction,
  assignInternalDriverAction,
  closeOrderRoundingBalanceAction,
  confirmPaymentReportAction,
  createPaymentReportAction,
  deliverClientFundChangeAction,
  createInventoryProductionAction,
  rejectPaymentReportAction,
  reapproveQueuedOrderAction,
  returnToCreatedAction,
  sendToKitchenAction,
  kitchenTakeAction,
  markReadyAction,
  outForDeliveryAction,
  markDeliveredAction,
  clearDeliveryAssignmentAction,
  returnFromKitchenToQueueAction,
  cancelOrderAction,
  createInventoryItemAction,
  updateInventoryItemAction,
  toggleInventoryItemActiveAction,
  updateCatalogItemAction,
  updateCatalogPricesQuickAction,
  createInventoryMovementAction,
  createExtraMoneyMovementAction,
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
  productType?: CatalogItem['type'];
  inventoryGroup?: CatalogItem['inventoryGroup'];
  inventoryUnitName?: string;
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
  adminPriceOverrideUsd: number | null;
  adminPriceOverrideReason: string | null;
  adminPriceOverrideByUserId?: string | null;
  adminPriceOverrideAt?: string | null;
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
  fundBalanceUsd: number;
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
  isActive?: boolean;
  rates: DeliveryPartnerRate[];
};

type DeliveryPartnerRate = {
  id: number;
  partnerId: number;
  kmFrom: number;
  kmTo: number | null;
  priceUsd: number;
  isActive: boolean;
  createdAt: string;
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
  isAsap: boolean;
  receiverName: string | null;
  receiverPhone: string | null;
  deliveryGpsUrl: string | null;
  deliveryEtaMinutes: number | null;
  deliveryEtaRecordedAtISO: string | null;
  deliveryCompletedAtISO: string | null;
  deliveryDistanceKm: number | null;
  deliveryCostUsd: number | null;
  deliveryCostSource: string | null;
  paymentMethod: string | null;
  paymentCurrency: 'USD' | 'VES' | null;
  paymentRequiresChange: boolean;
  paymentChangeFor: string | null;
  paymentChangeCurrency: 'USD' | 'VES' | null;
  paymentNote: string | null;
  clientFundUsedUsd: number | null;
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
  sentToKitchenAtISO?: string | null;
  kitchenStartedAtISO?: string | null;
  readyAtISO?: string | null;
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
  events: Array<{
    id: string;
    eventType: string;
    eventGroup: string;
    title: string;
    message: string | null;
    severity: 'info' | 'warning' | 'critical';
    actorUserId: string | null;
    actorName: string;
    payload: Record<string, unknown>;
    createdAt: string;
  }>;
  paymentReports: PaymentReportItem[];
  adminAdjustments: Array<{
    id: number;
    orderItemId: number | null;
    adjustmentType: string;
    reason: string;
    notes: string | null;
    payload: Record<string, unknown>;
    createdAt: string;
    createdByUserId: string;
    createdByName: string;
  }>;
  internalDriverUserId?: string | null;
  externalPartnerId?: number | null;
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

const ORDER_ROUNDING_CLOSE_MAX_USD = 1;
type ToastState = {
  type: 'success' | 'error';
  message: string;
} | null;
type SettingsTab = 'catalog' | 'inventory' | 'exchange_rate' | 'accounts' | 'clients' | 'adjustments';
type CalculationsTab = 'general' | 'commissions' | 'deliveries';
type DeliveriesTab = 'overview' | 'internal' | 'external' | 'partners';
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
  internalRiderPayUsd: number | null;
  inventoryEnabled: boolean;
  inventoryKind: 'raw_material' | 'prepared_base' | 'finished_good';
  inventoryDeductionMode: 'self' | 'composition';
  inventoryUnitName: string;
  packagingName: string | null;
  packagingSize: number | null;
  currentStockUnits: number;
  lowStockThreshold: number | null;
  inventoryGroup: 'raw' | 'fried' | 'prefried' | 'sauces' | 'packaging' | 'other';
};

type InventoryItem = {
  id: number;
  sku?: string;
  name: string;
  inventoryKind: 'raw_material' | 'prepared_base' | 'finished_stock' | 'packaging';
  inventoryGroup: 'raw' | 'fried' | 'prefried' | 'sauces' | 'packaging' | 'other';
  unitName: string;
  packagingName: string | null;
  packagingSize: number | null;
  currentStockUnits: number;
  lowStockThreshold: number | null;
  isActive: boolean;
  notes: string | null;
  createdAt: string;
};

type InventoryMovementItem = {
  id: number;
  inventoryItemId: number;
  movementType:
    | 'inbound'
    | 'sale_out'
    | 'damage'
    | 'waste'
    | 'manual_adjustment'
    | 'stock_count'
    | 'production_out'
    | 'production_in'
    | 'pack_out'
    | 'pack_in';
  quantityUnits: number;
  reasonCode: string | null;
  notes: string | null;
  orderId: number | null;
  createdAt: string;
  createdByUserId: string;
};

type InventoryRecipeItem = {
  id: number;
  outputInventoryItemId: number;
  recipeKind: 'production' | 'packaging';
  outputQuantityUnits: number;
  notes: string | null;
  isActive: boolean;
  createdAt: string;
};

type InventoryRecipeComponentItem = {
  id: number;
  recipeId: number;
  inputInventoryItemId: number;
  quantityUnits: number;
  sortOrder: number;
};

type ProductInventoryLink = {
  id: number;
  productId: number;
  inventoryItemId: number;
  deductionMode: 'self_link' | 'recipe';
  quantityUnits: number;
  sortOrder: number;
  notes: string | null;
  isActive: boolean;
  createdAt: string;
};

type EditableInventoryRecipeRow = {
  localId: string;
  inputInventoryItemId: number;
  quantityUnits: string;
  sortOrder: number;
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
  fee_charge: 'Comisiï¿½n',
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

type EditableInventoryLinkRow = {
  localId: string;
  inventoryItemId: number;
  quantityUnits: string;
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

function normalizeLooseText(value: string) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

function repairDisplayText(value: string | null | undefined) {
  return String(value ?? '')
    .replace(/Â/g, '')
    .replace(/Â·/g, '·')
    .replace(/â€¦/g, '…')
    .replace(/â€”/g, '—')
    .replace(/â€“/g, '–')
    .replace(/Ã¼/g, 'ü')
    .replace(/Ãœ/g, 'Ü')
    .replace(/Ã¡/g, 'á')
    .replace(/Ã©/g, 'é')
    .replace(/Ã­/g, 'í')
    .replace(/Ã³/g, 'ó')
    .replace(/Ãº/g, 'ú')
    .replace(/Ã±/g, 'ñ')
    .replace(/Ã/g, 'Á')
    .replace(/Ã‰/g, 'É')
    .replace(/Ã/g, 'Í')
    .replace(/Ã“/g, 'Ó')
    .replace(/Ãš/g, 'Ú')
    .replace(/Ã‘/g, 'Ñ')
    .replace(/SÃ­/g, 'Sí')
    .replace(/CatÃ¡logo/g, 'Catálogo')
    .replace(/ComposiciÃ³n/g, 'Composición')
    .replace(/LÃ­mite/g, 'Límite')
    .replace(/MÃ­nimo/g, 'Mínimo')
    .replace(/Ã­tem/g, 'ítem')
    .replace(/Ã“rdenes/g, 'Órdenes')
    .replace(/CÃ³mo/g, 'Cómo')
    .replace(/DirecciÃ³n/g, 'Dirección')
    .replace(/AsignaciÃ³n/g, 'Asignación')
    .replace(/ComisiÃ³n/g, 'Comisión')
    .replace(/TamaÃ±o/g, 'Tamaño')
    .replace(/AnÃ¡lisis/g, 'Análisis')
    .replace(/PerÃ­odo/g, 'Período')
    .replace(/FacturaciÃ³n/g, 'Facturación')
    .replace(/liquidaciÃ³n/g, 'liquidación')
    .replace(/LiquidaciÃ³n/g, 'Liquidación')
    .replace(/AuditorÃ­a/g, 'Auditoría')
    .replace(/InstituciÃ³n/g, 'Institución')
    .replace(/TelÃ©fono/g, 'Teléfono')
    .replace(/descripciÃ³n/g, 'descripción')
    .replace(/DescripciÃ³n/g, 'Descripción')
    .replace(/mÃ¡ximo/g, 'máximo')
    .replace(/invÃ¡lido/g, 'inválido')
    .replace(/cargados aÃºn/g, 'cargados aún')
    .replace(/todavÃ­a/g, 'todavía')
    .replace(/A sÃ­ mismo/g, 'A sí mismo')
    .replace(/composiciÃ³n/g, 'composición')
    .trim();
}

function fmtClientTypeLabel(value: string | null | undefined) {
  const normalized = normalizeLooseText(String(value ?? ''));
  if (!normalized) return '—';
  if (normalized === 'legacy' || normalized === 'antiguo') return 'Antiguo';
  if (normalized === 'own' || normalized === 'propio') return 'Propio';
  if (normalized === 'assigned' || normalized === 'asignado') return 'Asignado';
  return repairDisplayText(String(value));
}

function truncateDisplayText(value: string, maxChars: number) {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
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
  return `${cap} ${dd}/${mm} - ${time}`;
};

const fmtDayLabelES = (iso: string) => {
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

  const cap = dow.charAt(0).toUpperCase() + dow.slice(1);
  return `${cap} ${dd}/${mm}`;
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

  return `${day}/${month}/${yy} - ${hour}:${minute} ${ampm}`;
}

function toDateInputValue(d: Date) {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

const CALENDAR_WEEKDAY_LABELS = ['Lu', 'Ma', 'Mi', 'Ju', 'Vi', 'Sa', 'Do'] as const;

function fmtCalendarMonthES(d: Date) {
  const month = d.toLocaleDateString('es-VE', {
    month: 'long',
    timeZone: 'America/Caracas',
  });
  const label = month.charAt(0).toUpperCase() + month.slice(1);
  return `${label} ${d.getFullYear()}`;
}

function startOfMonthGrid(d: Date) {
  const first = new Date(d.getFullYear(), d.getMonth(), 1);
  return startOfWeekMon(first);
}

function addDays(base: Date, days: number) {
  const next = new Date(base);
  next.setDate(base.getDate() + days);
  return next;
}

function isSameDay(a: Date | null, b: Date | null) {
  if (!a || !b) return false;
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function buildCalendarDays(viewMonth: Date) {
  const start = startOfMonthGrid(viewMonth);
  return Array.from({ length: 42 }, (_, idx) => {
    const day = addDays(start, idx);
    return {
      date: day,
      inMonth: day.getMonth() === viewMonth.getMonth(),
    };
  });
}

function buildCommittedProductsRows(
  committedSource: Array<{ name: string; und: number; bucket: CommittedBucket }>,
  inventoryItems: InventoryItem[]
) {
  const inventoryByName = new Map<string, InventoryItem>();
  for (const item of inventoryItems) {
    inventoryByName.set(normalizeLooseText(item.name), item);
  }

  return committedSource.map((product) => {
    const linkedInventory = inventoryByName.get(normalizeLooseText(product.name)) ?? null;
    const currentUnits = linkedInventory ? Number(linkedInventory.currentStockUnits || 0) : null;
    const minimumUnits =
      linkedInventory && linkedInventory.lowStockThreshold != null
        ? Number(linkedInventory.lowStockThreshold || 0)
        : null;
    const remainingUnits = linkedInventory && currentUnits != null ? currentUnits - product.und : null;

    let statusLabel: string | null = null;
    let statusTone: 'warn' | 'brand' | null = null;

    if (linkedInventory && minimumUnits != null) {
      if (currentUnits != null && currentUnits <= minimumUnits) {
        statusLabel = 'Ya está en mínimo';
        statusTone = 'warn';
      } else if (remainingUnits != null && remainingUnits <= minimumUnits) {
        statusLabel = 'Queda justo';
        statusTone = 'brand';
      }
    }

    return {
      ...product,
      linkedInventory,
      currentUnits,
      remainingUnits,
      statusLabel,
      statusTone,
    };
  });
}

function fmtShortOrderLabel(orderId: number) {
  return String(orderId).padStart(2, '0');
}

function fmtInventoryUnits(
  units: number,
  packagingName: string | null,
  packagingSize: number | null,
  unitName: string
) {
  const total = Math.max(0, Number(units || 0));
  const baseUnitName = unitName || 'pieza';

  if (!packagingName || !packagingSize || packagingSize <= 0) {
    return `${total} ${baseUnitName}${total === 1 ? '' : 's'}`;
  }

  const packs = Math.floor(total / packagingSize);
  const loose = total - packs * packagingSize;
  const parts: string[] = [];

  if (packs > 0) {
    parts.push(`${packs} ${packagingName}${packs === 1 ? '' : 's'}`);
  }

  if (loose > 0 || parts.length === 0) {
    parts.push(`${loose} ${baseUnitName}${loose === 1 ? '' : 's'}`);
  }

  return parts.join(' + ');
}

function fmtUnitsValue(units: number | null | undefined) {
  const value = Number(units ?? 0);
  if (!Number.isFinite(value)) return '0';
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.?0+$/, '');
}

function mapAdjustmentFieldLabel(field: string) {
  const labels: Record<string, string> = {
    source: 'Origen',
    fulfillment: 'Tipo de entrega',
    client_id: 'Cliente',
    attributed_advisor_id: 'Asesor',
    delivery_address: 'DirecciÃ³n',
    receiver_name: 'Recibe',
    receiver_phone: 'TelÃ©fono receptor',
    notes: 'Notas',
    total_usd: 'Total USD',
    total_bs_snapshot: 'Total Bs',
    extra_fields: 'Snapshots',
  };

  return labels[field] || field;
}

function getAdjustmentChangedFields(payload: Record<string, unknown>) {
  const explicit = Array.isArray(payload.changed_fields)
    ? payload.changed_fields.map((value) => String(value)).filter(Boolean)
    : [];

  if (explicit.length > 0) return explicit;

  const before =
    payload.before && typeof payload.before === 'object' && !Array.isArray(payload.before)
      ? (payload.before as Record<string, unknown>)
      : null;
  const after =
    payload.after && typeof payload.after === 'object' && !Array.isArray(payload.after)
      ? (payload.after as Record<string, unknown>)
      : null;

  if (!before || !after) return [];

  return Object.keys(after).filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
}

function getOrderCommissionableSubtotalUsd(order: Order) {
  if (order.editMeta.subtotalAfterDiscountUsd != null) {
    return Math.max(0, Number(order.editMeta.subtotalAfterDiscountUsd || 0));
  }

  if (order.editMeta.subtotalUsd != null) {
    const discountPct = order.editMeta.discountEnabled ? Number(order.editMeta.discountPct || 0) : 0;
    return Math.max(0, Number(order.editMeta.subtotalUsd || 0) * (1 - discountPct / 100));
  }

  const invoiceTaxUsd = Number(order.editMeta.invoiceTaxAmountUsd || 0);
  return Math.max(0, Number(order.totalUsd || 0) - invoiceTaxUsd);
}

function getOrderDiscountFactor(order: Order) {
  const subtotalUsd = Number(order.editMeta.subtotalUsd || 0);
  const subtotalAfterDiscountUsd = Number(order.editMeta.subtotalAfterDiscountUsd || 0);

  if (subtotalUsd > 0 && subtotalAfterDiscountUsd >= 0) {
    return Math.max(0, Math.min(1, subtotalAfterDiscountUsd / subtotalUsd));
  }

  const discountPct = order.editMeta.discountEnabled ? Number(order.editMeta.discountPct || 0) : 0;
  return Math.max(0, Math.min(1, 1 - discountPct / 100));
}

function getInternalDeliveryPayUsd(order: Order, catalogItemById: Map<number, CatalogItem>) {
  return (order.draftItems ?? []).reduce((sum, item) => {
    const product = catalogItemById.get(item.productId);
    const payUsd = Number(product?.internalRiderPayUsd || 0);
    return payUsd > 0 ? sum + payUsd * Number(item.qty || 0) : sum;
  }, 0);
}

function isDeliveryCatalogItem(item: Pick<CatalogItem, 'name' | 'internalRiderPayUsd'> | null | undefined) {
  if (!item) return false;
  return Number(item.internalRiderPayUsd || 0) > 0 || String(item.name || '').trim().toLowerCase().includes('delivery');
}

function shouldShowRiderPayField(params: {
  type?: string | null;
  name?: string | null;
  currentValue?: string | number | null;
}) {
  const { type, name, currentValue } = params;
  if (type === 'combo') return true;
  if (String(name || '').trim().toLowerCase().includes('delivery')) return true;
  return Number(currentValue || 0) > 0;
}

function getOrderDeliveryItems(order: Order, catalogItemById: Map<number, CatalogItem>) {
  return (order.draftItems ?? []).filter((item) => {
    const product = catalogItemById.get(item.productId);
    if (isDeliveryCatalogItem(product)) return true;
    return String(item.productNameSnapshot || '').trim().toLowerCase().includes('delivery');
  });
}

function getOrderDeliveryChargeLabel(order: Order, catalogItemById: Map<number, CatalogItem>) {
  const deliveryItems = getOrderDeliveryItems(order, catalogItemById);
  if (deliveryItems.length === 0) return 'Sin ítem delivery';

  return deliveryItems
    .map((item) => `${item.productNameSnapshot}${Number(item.qty || 0) > 1 ? ` x${Number(item.qty || 0)}` : ''}`)
    .join(' + ');
}

function findDeliveryPartnerRate(
  partner: DeliveryPartnerOption | null | undefined,
  distanceKm: number
) {
  if (!partner || !Number.isFinite(distanceKm) || distanceKm <= 0) return null;

  const activeRates = (partner.rates ?? [])
    .filter((rate) => rate.isActive)
    .sort((a, b) => a.kmFrom - b.kmFrom);

  return (
    activeRates.find(
      (rate) =>
        distanceKm >= rate.kmFrom &&
        (rate.kmTo == null || distanceKm <= rate.kmTo)
    ) ?? null
  );
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
const paymentLabel = (balanceUsd: number) => (balanceUsd <= 0 ? 'Pagado' : `Pendiente: ${fmtUSD(balanceUsd)}`);
const paymentToneClass = (balanceUsd: number) => (balanceUsd <= 0 ? 'text-emerald-400' : 'text-orange-500');

function splitTwoWordsCompact(full: string) {
  const parts = repairDisplayText(full).split(/\s+/).filter(Boolean);
  const first = parts[0] ?? '—';
  const rest = parts.slice(1).join(' ');
  const line2 = rest ? truncateDisplayText(rest, 20) : '';
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
  if (line.unitsPerService > 0) {
    const units = line.qty * line.unitsPerService;
    return units > 0 ? Math.floor(units) : units;
  }
  const m = line.name.match(/\((\d+)\s*und\)/i);
  if (m) {
    const base = Number(m[1]);
    if (!Number.isNaN(base) && base > 0) {
      const units = line.qty * base;
      return units > 0 ? Math.floor(units) : units;
    }
  }
  return null;
}

type CommittedBucket = 'products' | 'sauces' | 'beverages';

function getCommittedBucket(line: OrderLine): CommittedBucket {
  const name = normalizeLooseText(line.name);
  if (line.inventoryGroup === 'sauces') return 'sauces';
  if (
    name.includes('refresco') ||
    name.includes('gaseosa') ||
    name.includes('bebida') ||
    name.includes('malta') ||
    name.includes('agua') ||
    name.includes('jugo') ||
    name.includes('te ') ||
    name.includes('té ') ||
    name.includes('coca') ||
    name.includes('pepsi')
  ) {
    return 'beverages';
  }
  return 'products';
}



function lineTextWhatsAppStyle(line: OrderLine) {
  const units = calcUnits(line);
  const bs = fmtBs(line.qty * line.priceBs);
  const isDelivery = !!line.isDelivery || line.name.toLowerCase().startsWith('delivery');

  if (isDelivery) return `• ${line.qty} ${line.name}: ${bs}`;

  if (units !== null) {
    const cleanName = line.name.replace(/\s*\(\d+\s*und\)\s*/i, ' ').trim();
    if (line.productType === 'service') {
      return `• ${line.qty} Serv. ${cleanName} (${units} und): ${bs}`;
    }
    return `• ${line.qty} ${cleanName} (${units} und): ${bs}`;
  }

  return `• ${line.qty} ${line.name}: ${bs}`;
}

const EDITABLE_DETAIL_SELECTION_PREFIX = '@sel|';

function isEditableDetailMetadataLine(line: string) {
  return String(line || '').trim().startsWith(EDITABLE_DETAIL_SELECTION_PREFIX);
}

function getVisibleEditableDetailLines(lines: string[]) {
  return (lines ?? []).filter((line) => !isEditableDetailMetadataLine(line));
}

function buildComponentDetailLines(
  components: ProductComponent[],
  options?: {
    totalMultiplier?: number;
    selectedByProductId?: Map<number, number>;
    includeMetadata?: boolean;
  }
) {
  const totalMultiplier = Math.max(1, Number(options?.totalMultiplier || 1));
  const selectedByProductId = options?.selectedByProductId ?? new Map<number, number>();
  const detailLines: string[] = [];

  const orderedComponents = [...components].sort(
    (a, b) => a.sortOrder - b.sortOrder || a.componentName.localeCompare(b.componentName)
  );

  for (const component of orderedComponents) {
    let componentQty = 0;

    if (component.componentMode === 'fixed' && component.isRequired) {
      componentQty = component.quantity;
    } else if (component.componentMode === 'fixed') {
      componentQty = selectedByProductId.get(component.componentProductId) ?? 0;
    } else {
      componentQty = selectedByProductId.get(component.componentProductId) ?? 0;
    }

    componentQty = Math.max(0, Number(componentQty || 0));
    if (componentQty <= 0) continue;

    const totalQty = componentQty * totalMultiplier;
    detailLines.push(`${totalQty} ${component.componentName}`);

    if (options?.includeMetadata) {
      detailLines.push(`${EDITABLE_DETAIL_SELECTION_PREFIX}${component.componentProductId}|${totalQty}`);
    }
  }

  return detailLines;
}

function buildWhatsAppOrderSummary(order: Order) {
  const lines = orderMainLinesForPreview(order.lines);

  const parts: string[] = [];

  parts.push(`*Resumen de Pedido*`);
  parts.push('');
  parts.push(`*Orden:* ${order.id}`);
  parts.push(`*Asesor:* ${order.advisorName}`);
  parts.push(`*Cliente:* ${order.clientName}`);

  parts.push('');
  parts.push(`*Pedido:*`);
  parts.push('');

  if (lines.length === 0) {
    parts.push(`- Sin ítems cargados`);
  } else {
    for (const line of lines) {
      parts.push(lineTextWhatsAppStyle(line));

      if (line.editableDetailLines && line.editableDetailLines.length > 0) {
        for (const detail of getVisibleEditableDetailLines(line.editableDetailLines)) {
          parts.push(`- ${detail}`);
        }
      }
    }
  }

  parts.push('');
  parts.push(`*TOTAL:* ${fmtBs(order.totalBs)} / ${fmtUSD(order.totalUsd)}`);

  parts.push('');
  parts.push(`*Entrega:* ${order.fulfillment === 'delivery' ? 'Delivery' : 'Pickup'}`);
  parts.push(`*Día de entrega:* ${fmtDeliveryTextES(order.deliveryAtISO)}`);

  if (order.fulfillment === 'delivery' && order.address?.trim()) {
    parts.push(`*Dirección:* ${order.address.trim()}`);
  }

  if (order.notes?.trim()) {
    parts.push('');
    parts.push(`*Nota:* ${order.notes.trim()}`);
  }

  return parts.join('\n');
}

function isCommittedStatus(s: OrderStatus) {
  return ['created', 'queued', 'confirmed', 'in_kitchen', 'ready', 'out_for_delivery'].includes(s);
}

function computeCommittedUndByProduct(orders: Order[]) {
  const map = new Map<string, { und: number; bucket: CommittedBucket }>();
  for (const o of orders) {
    if (!isCommittedStatus(o.status)) continue;
    for (const line of o.lines) {
      const isDeliveryLine = !!line.isDelivery || line.name.toLowerCase().startsWith('delivery');
      if (isDeliveryLine) continue;
      const units = calcUnits(line) ?? line.qty;
      if (units <= 0) continue;
      const prev = map.get(line.name);
      map.set(line.name, {
        und: (prev?.und ?? 0) + units,
        bucket: prev?.bucket ?? getCommittedBucket(line),
      });
    }
  }
  return Array.from(map.entries())
    .map(([name, value]) => ({ name, und: value.und, bucket: value.bucket }))
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
  return `Semana: Lun ${dd1}/${mm1} - Dom ${dd2}/${mm2}`;
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
  if (p === 'pending') return 'Pend.';
  if (p === 'confirmed') return 'OK';
  if (p === 'rejected') return 'No';
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

type ProcessAlertLevel = 'normal' | 'warning' | 'danger';

function parseIsoMs(iso?: string | null) {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function getCurrentProcessAlertLevel(order: Order, currentKey: string, nowMs: number): ProcessAlertLevel {
  if (order.status === 'cancelled' || order.status === 'delivered') return 'normal';

  const deliveryDueMs = parseIsoMs(order.deliveryAtISO);
  const minutesUntilDelivery =
    deliveryDueMs != null ? (deliveryDueMs - nowMs) / 60000 : null;

  if (currentKey === 'created' && minutesUntilDelivery != null) {
    if (minutesUntilDelivery <= 60) return 'danger';
  }

  if (currentKey === 'queued' && minutesUntilDelivery != null) {
    if (minutesUntilDelivery <= 0) return 'danger';
    if (minutesUntilDelivery <= 30) return 'danger';
  }

  if (currentKey === 'confirmed') {
    if (order.status === 'confirmed') {
      const sentToKitchenMs = parseIsoMs(order.sentToKitchenAtISO);
      if (sentToKitchenMs != null && nowMs - sentToKitchenMs >= 5 * 60 * 1000) {
        return 'danger';
      }
    }

    if (order.status === 'in_kitchen') {
      const kitchenStartedMs = parseIsoMs(order.kitchenStartedAtISO);
      const kitchenEtaMinutes = Number(order.editMeta.deliveryEtaMinutes || 0);
      if (
        kitchenStartedMs != null &&
        Number.isFinite(kitchenEtaMinutes) &&
        kitchenEtaMinutes > 0 &&
        nowMs - kitchenStartedMs >= kitchenEtaMinutes * 60 * 1000
      ) {
        return 'danger';
      }
    }
  }

  if (currentKey === 'out_for_delivery' && order.status === 'out_for_delivery') {
    const deliveryStartedMs =
      parseIsoMs(order.editMeta.deliveryEtaRecordedAtISO) ?? parseIsoMs(order.readyAtISO);
    const deliveryEtaMinutes = Number(order.editMeta.deliveryEtaMinutes || 0);
    if (
      deliveryStartedMs != null &&
      Number.isFinite(deliveryEtaMinutes) &&
      deliveryEtaMinutes > 0 &&
      nowMs - deliveryStartedMs >= deliveryEtaMinutes * 60 * 1000
    ) {
      return 'danger';
    }
  }

  return 'normal';
}

function getCurrentProcessAlertReason(order: Order, currentKey: string, nowMs: number) {
  if (order.status === 'cancelled' || order.status === 'delivered') return null;

  const deliveryDueMs = parseIsoMs(order.deliveryAtISO);
  const minutesUntilDelivery =
    deliveryDueMs != null ? (deliveryDueMs - nowMs) / 60000 : null;

  if (currentKey === 'created' && minutesUntilDelivery != null && minutesUntilDelivery <= 60) {
    return 'Pendiente de aprobación';
  }

  if (currentKey === 'queued' && minutesUntilDelivery != null && minutesUntilDelivery <= 30) {
    return 'Pendiente de enviar a cocina';
  }

  if (currentKey === 'confirmed') {
    if (order.status === 'confirmed') {
      const sentToKitchenMs = parseIsoMs(order.sentToKitchenAtISO);
      if (sentToKitchenMs != null && nowMs - sentToKitchenMs >= 5 * 60 * 1000) {
        return 'Cocina aún no la toma';
      }
    }

    if (order.status === 'in_kitchen') {
      const kitchenStartedMs = parseIsoMs(order.kitchenStartedAtISO);
      const kitchenEtaMinutes = Number(order.editMeta.deliveryEtaMinutes || 0);
      if (
        kitchenStartedMs != null &&
        Number.isFinite(kitchenEtaMinutes) &&
        kitchenEtaMinutes > 0 &&
        nowMs - kitchenStartedMs >= kitchenEtaMinutes * 60 * 1000
      ) {
        return 'Se excedió el tiempo de preparación';
      }
    }
  }

  if (currentKey === 'ready' && order.fulfillment === 'delivery' && order.status === 'ready') {
    const readyMs = parseIsoMs(order.readyAtISO);
    if (readyMs != null && nowMs - readyMs >= 5 * 60 * 1000) {
      return 'Falta salir en camino';
    }
  }

  if (currentKey === 'out_for_delivery' && order.status === 'out_for_delivery') {
    const deliveryStartedMs =
      parseIsoMs(order.editMeta.deliveryEtaRecordedAtISO) ?? parseIsoMs(order.readyAtISO);
    const deliveryEtaMinutes = Number(order.editMeta.deliveryEtaMinutes || 0);
    if (
      deliveryStartedMs != null &&
      Number.isFinite(deliveryEtaMinutes) &&
      deliveryEtaMinutes > 0 &&
      nowMs - deliveryStartedMs >= deliveryEtaMinutes * 60 * 1000
    ) {
      return 'Se excedió el tiempo de entrega';
    }
  }

  return null;
}

function getDeliveryTimingSummary(order: Order, nowMs: number) {
  const deliveryDueMs = parseIsoMs(order.deliveryAtISO);
  const isLate = deliveryDueMs != null ? nowMs >= deliveryDueMs : false;

  if (order.status === 'in_kitchen') {
    const etaMinutes = Number(order.editMeta.deliveryEtaMinutes || 0);
    if (Number.isFinite(etaMinutes) && etaMinutes > 0) {
      return {
        label: 'Tiempo estimado de preparación',
        value: `${etaMinutes} min`,
        tone: 'muted' as const,
      };
    }
  }

  if (order.status === 'out_for_delivery') {
    const etaMinutes = Number(order.editMeta.deliveryEtaMinutes || 0);
    if (Number.isFinite(etaMinutes) && etaMinutes > 0) {
      return {
        label: 'Tiempo estimado en camino',
        value: `${etaMinutes} min`,
        tone: 'muted' as const,
      };
    }
  }

  return {
    label: 'Estado de tiempo',
    value: isLate ? 'Retrasado' : 'Va a tiempo',
    tone: isLate ? ('danger' as const) : ('ok' as const),
  };
}

function getDeliveryCompletionSummary(order: Order) {
  const deliveryDueMs = parseIsoMs(order.deliveryAtISO);
  const readyMs = parseIsoMs(order.readyAtISO);
  const completedMs = parseIsoMs(order.editMeta.deliveryCompletedAtISO);

  const pickupOnTime =
    order.fulfillment === 'pickup' &&
    readyMs != null &&
    deliveryDueMs != null &&
    readyMs <= deliveryDueMs;

  const deliveryOnTime =
    order.fulfillment === 'delivery' &&
    completedMs != null &&
    deliveryDueMs != null &&
    completedMs <= deliveryDueMs;

  return {
    readyLabel: order.fulfillment === 'pickup' ? 'Lista a las' : 'Preparada a las',
    readyValue: readyMs != null ? fmtDateTimeES(new Date(readyMs).toISOString()) : '—',
    completedLabel: order.fulfillment === 'pickup' ? 'Retirada a las' : 'Entregada a las',
    completedValue: completedMs != null ? fmtDateTimeES(new Date(completedMs).toISOString()) : '—',
    punctuality:
      order.fulfillment === 'pickup'
        ? readyMs == null || deliveryDueMs == null
          ? null
          : pickupOnTime
            ? 'Lista a tiempo'
            : 'Lista con retraso'
        : completedMs == null || deliveryDueMs == null
          ? null
          : deliveryOnTime
            ? 'Entregada a tiempo'
            : 'Entregada con retraso',
    punctualityTone:
      order.fulfillment === 'pickup'
        ? readyMs == null || deliveryDueMs == null
          ? 'muted'
          : pickupOnTime
            ? 'ok'
            : 'danger'
        : completedMs == null || deliveryDueMs == null
          ? 'muted'
          : deliveryOnTime
            ? 'ok'
            : 'danger',
  };
}

function getProcessVisualClasses(tone: string, alertLevel: ProcessAlertLevel) {
  if (alertLevel === 'danger') {
    return {
      dotClass: 'bg-red-500 border-red-500',
      textClass: 'text-red-400',
      lineClass: 'bg-red-500/50',
    };
  }

  if (alertLevel === 'warning') {
    return {
      dotClass: 'bg-orange-400 border-orange-400',
      textClass: 'text-orange-300',
      lineClass: 'bg-orange-400/40',
    };
  }

  return {
    dotClass:
      tone === 'done'
        ? 'bg-emerald-500 border-emerald-500'
        : tone === 'current'
          ? 'bg-[#FEEF00] border-[#FEEF00]'
          : tone === 'current-cancelled'
            ? 'bg-red-500 border-red-500'
            : 'bg-[#191926] border-[#2A2A38]',
    textClass:
      tone === 'done'
        ? 'text-emerald-400'
        : tone === 'current'
          ? 'text-[#FEEF00]'
          : tone === 'current-cancelled'
            ? 'text-red-400'
            : 'text-[#6F6F7C]',
    lineClass: tone === 'done' ? 'bg-emerald-500/60' : 'bg-[#242433]',
  };
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

function ProcessTimeline({ order, nowMs }: { order: Order; nowMs: number }) {
  const steps = getProcessSteps(order);
  const currentKey = getProcessCurrentKey(order);
  const orderedKeys = steps.map((s) => s.key);
  const cancelled = order.status === 'cancelled';
  const alertLevel = getCurrentProcessAlertLevel(order, currentKey, nowMs);
  const alertReason = getCurrentProcessAlertReason(order, currentKey, nowMs);

  return (
    <div className="rounded-lg border border-[#1D1D28] bg-[#101014] px-2.5 py-2">
      <div className="flex items-center gap-1.5">
        {steps.map((step, idx) => {
          const tone = getProcessStepTone(step.key, currentKey, cancelled, orderedKeys);
          const visual = getProcessVisualClasses(
            tone,
            !cancelled && step.key === currentKey ? alertLevel : 'normal'
          );

          return (
            <div key={step.key} className="flex min-w-0 flex-1 items-center">
              <div className="flex min-w-0 items-center gap-1">
                <div className={`h-2 w-2 shrink-0 rounded-full border ${visual.dotClass}`} />
                <div className={`truncate text-[10px] leading-none ${visual.textClass}`}>
                  {step.label}
                </div>
              </div>

              {idx < steps.length - 1 ? (
                <div className={`mx-1 h-[1px] flex-1 rounded-full ${visual.lineClass}`} />
              ) : null}
            </div>
          );
        })}
      </div>
      {alertLevel === 'danger' && alertReason ? (
        <div className="mt-1 text-[10px] font-medium text-red-400">{alertReason}</div>
      ) : null}
    </div>
  );
}

function RowProcessTimeline({ order, nowMs }: { order: Order; nowMs: number }) {
  const steps = getProcessSteps(order);
  const currentKey = getProcessCurrentKey(order);
  const orderedKeys = steps.map((s) => s.key);
  const cancelled = order.status === 'cancelled';
  const alertLevel = getCurrentProcessAlertLevel(order, currentKey, nowMs);
  const alertReason = getCurrentProcessAlertReason(order, currentKey, nowMs);
  const hasDriverAssigned = Boolean(order.riderName?.trim() || order.externalPartner?.trim());
  const needsDriverUrgent =
    order.fulfillment === 'delivery' &&
    !hasDriverAssigned &&
    ['confirmed', 'in_kitchen', 'ready', 'out_for_delivery'].includes(order.status);
  const assignmentLabel =
    order.fulfillment !== 'delivery'
      ? 'Pickup'
      : order.riderName
        ? `Interno: ${order.riderName}`
        : order.externalPartner
          ? `Externo: ${order.externalPartner}`
          : 'Sin driver';
  const isAsap = Boolean(order.editMeta.isAsap);

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1">
        {steps.map((step, idx) => {
          const tone = getProcessStepTone(step.key, currentKey, cancelled, orderedKeys);
          const visual = getProcessVisualClasses(
            tone,
            !cancelled && step.key === currentKey ? alertLevel : 'normal'
          );

          return (
            <div key={step.key} className="flex min-w-0 flex-1 items-center">
              <div className="flex min-w-0 items-center gap-1">
                <div className={`h-1.5 w-1.5 shrink-0 rounded-full border ${visual.dotClass}`} />
                <div className={`truncate text-[10px] leading-none ${visual.textClass}`}>{step.label}</div>
              </div>
              {idx < steps.length - 1 ? <div className={`mx-1 h-[1px] flex-1 rounded-full ${visual.lineClass}`} /> : null}
            </div>
          );
        })}
      </div>
      <div className="flex items-start justify-between gap-2 text-[10px]">
        <div className={`flex items-center gap-1.5 ${needsDriverUrgent ? 'font-semibold text-red-400' : 'text-[#8A8A96]'}`}>
          {isAsap ? (
            <span className="inline-flex items-center rounded-full border border-red-500/40 bg-red-500/10 px-1.5 py-[1px] text-[9px] font-semibold uppercase tracking-wide text-red-300">
              Urgente
            </span>
          ) : null}
          <span>{order.fulfillment === 'delivery' ? assignmentLabel : 'Retiro en local'}</span>
        </div>
        <div className={alertLevel === 'danger' && alertReason ? 'text-right font-medium text-red-400' : 'invisible text-right'}>
          {alertLevel === 'danger' && alertReason ? alertReason : 'Sin alerta'}
        </div>
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
  headerActions,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  widthClass?: string;
  headerActions?: React.ReactNode;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[100]">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className={`absolute right-0 top-0 h-full ${widthClass} border-l border-[#242433] bg-[#0B0B0D]`}>
        <div className="flex items-center justify-between border-b border-[#242433] px-4 py-3">
          <div className="min-w-0 text-base font-semibold text-[#F5F5F7]">{title}</div>
          <div className="flex items-center gap-2">
            {headerActions}
            <button
              className="rounded-lg border border-[#242433] bg-[#121218] px-2 py-1 text-sm text-[#B7B7C2]"
              onClick={onClose}
            >
              ×
            </button>
          </div>
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
    <div className={['rounded-2xl border border-[#242433] bg-[#121218] p-2.5', className || ''].join(' ')}>
      <div className="text-[13px] font-semibold leading-none text-[#F5F5F7]">{title}</div>
      <div className="mt-1.5 space-y-1.5">{children}</div>
    </div>
  );
}

function TopNavButton({
  label,
  icon,
  active,
  onClick,
  count,
}: {
  label: string;
  icon: React.ReactNode;
  active: boolean;
  onClick: () => void;
  count?: number;
}) {
  return (
    <button
      className={[
        'group flex items-center gap-2 rounded-2xl border px-2.5 py-1.5 text-left transition',
        active
          ? 'border-[#FEEF00] bg-[#121218] text-[#F5F5F7]'
          : 'border-[#242433] bg-[#121218] text-[#B7B7C2] hover:text-[#F5F5F7]',
      ].join(' ')}
      onClick={onClick}
      type="button"
    >
      <span
        className={[
          'flex h-5 w-5 items-center justify-center rounded-lg',
          active ? 'bg-[#FEEF00] text-[#0B0B0D]' : 'bg-[#191926] text-[#B7B7C2]',
        ].join(' ')}
      >
        {icon}
      </span>
      <span className="text-xs font-medium leading-none">{label}</span>
      {typeof count === 'number' ? (
        <span className="rounded-full bg-[#191926] px-1.5 py-0.5 text-[10px] leading-none text-[#F5F5F7]">
          {count}
        </span>
      ) : null}
    </button>
  );
}

function TopNavIcon({ kind }: { kind: 'operations' | 'settings' | 'calculations' | 'alerts' }) {
  if (kind === 'operations') {
    return (
      <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.6">
        <path d="M3 4.5h10M3 8h10M3 11.5h6" strokeLinecap="round" />
      </svg>
    );
  }

  if (kind === 'settings') {
    return (
      <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.5">
        <circle cx="8" cy="8" r="2.2" />
        <path d="M8 2.3v1.4M8 12.3v1.4M13.7 8h-1.4M3.7 8H2.3M11.9 4.1l-1 1M5.1 10.9l-1 1M11.9 11.9l-1-1M5.1 5.1l-1-1" strokeLinecap="round" />
      </svg>
    );
  }

  if (kind === 'calculations') {
    return (
      <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.6">
        <rect x="3" y="2.5" width="10" height="11" rx="1.8" />
        <path d="M5.4 5.2h5.2M5.4 8h1.3M7.9 8h1.3M10.4 8h.2M5.4 10.8h1.3M7.9 10.8h1.3M10.4 10.8h.2" strokeLinecap="round" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.6">
      <path d="M8 3.1a3.8 3.8 0 0 1 3.8 3.8c0 2.7-2.2 3.6-3.2 4.8-.2.3-.4.6-.4 1" strokeLinecap="round" />
      <circle cx="8" cy="12.8" r=".7" fill="currentColor" stroke="none" />
    </svg>
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
    {pc.componentSku ? `${pc.componentSku} Â· ` : ''}
    {catalogItems.find((p) => p.id === pc.componentProductId)?.unitsPerService
      ? `${catalogItems.find((p) => p.id === pc.componentProductId)?.unitsPerService} und/serv`
      : 'â€”'}
  </div>

  {/* bloque legado movido fuera de contexto
    <div className="mt-4 hidden rounded-xl border border-emerald-500/20 bg-[#0B0B0D] p-3">
      <div className="text-sm font-semibold text-[#F5F5F7]">AplicaciÃ³n de fondo</div>
      <div className="mt-1 text-xs text-[#8A8A96]">
        Disponible: {fmtUSD(createOrderClientFundAvailableUsd)}. Este saldo ya entrÃ³ antes; aquÃ­ solo se aplica a la orden.
      </div>
      <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
        <FieldCheckbox
          label="Usar fondo del cliente"
          checked={createOrderUseClientFund}
          onChange={(value) => {
            setCreateOrderUseClientFund(value);
            if (value) {
              const suggested = Math.max(
                0,
                Math.min(
                  Number(createOrderDraftTotalUsd.toFixed(2)),
                  Number(createOrderClientFundAvailableUsd.toFixed(2))
                )
              );
              setCreateOrderClientFundAmountUsd(
                suggested > 0.005 ? String(Number(suggested.toFixed(2))) : ''
              );
            } else {
              setCreateOrderClientFundAmountUsd('');
            }
          }}
        />
        <FieldInput
          label="Monto a aplicar (USD)"
          value={createOrderClientFundAmountUsd}
          onChange={setCreateOrderClientFundAmountUsd}
          type="text"
          hint="MÃ¡ximo: saldo del cliente o total de la orden."
        />
      </div>
      {createOrderUseClientFund ? (
        <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
          <InfoCell label="Fondo aplicado" value={fmtUSD(createOrderAppliedFundUsd)} />
          <InfoCell label="Resta por cobrar" value={fmtUSD(createOrderRemainingAfterFundUsd)} />
        </div>
      ) : null}
    </div>
  */}
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
  hint,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  hint?: string;
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
      {hint ? <div className="mt-1 text-[11px] text-[#6F6F7C]">{hint}</div> : null}
    </div>
  );
}

function FieldSelect({
  label,
  value,
  onChange,
  options,
  disabled = false,
  hint,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
  disabled?: boolean;
  hint?: string;
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
      {hint ? <div className="mt-1 text-[11px] text-[#6F6F7C]">{hint}</div> : null}
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
  const selections: Array<{
    componentName: string;
    qty: number;
    componentProductId: number | null;
  }> = [];
  const selectionsByComponentId = new Map<number, number>();

  for (const rawLine of lines) {
    const line = String(rawLine || '').trim();
    if (!line) continue;

    if (isEditableDetailMetadataLine(line)) {
      const [, componentIdRaw, qtyRaw] = line.split('|');
      const componentProductId = Number(componentIdRaw || 0);
      const qty = Number(qtyRaw || 0);

      if (Number.isFinite(componentProductId) && componentProductId > 0 && Number.isFinite(qty) && qty > 0) {
        selectionsByComponentId.set(componentProductId, qty);
      }
      continue;
    }

    if (/^para\s*:/i.test(line)) {
      alias = line.replace(/^para\s*:/i, '').trim();
      continue;
    }

    const match = line.match(/^(\d+)\s+(.+)$/i);
    if (match) {
      const qty = Number(match[1]);
      const componentName = match[2].trim();

      if (Number.isFinite(qty) && qty > 0 && componentName) {
        selections.push({ componentName, qty, componentProductId: null });
      }
    }
  }

  if (selectionsByComponentId.size > 0) {
    return {
      alias,
      selections: Array.from(selectionsByComponentId.entries()).map(([componentProductId, qty]) => ({
        componentProductId,
        qty,
        componentName: '',
      })),
    };
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
      summary: 'Sin informaciÃ³n',
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
    return 'Producto invÃ¡lido.';
  }

  const normalized = editComponents.map((row) => ({
    ...row,
    componentProductId: Number(row.componentProductId || 0),
    quantity: Number(row.quantity || 0),
    sortOrder: Number(row.sortOrder || 0),
  }));

  if (normalized.some((row) => row.componentProductId <= 0)) {
    return 'Todos los componentes deben tener un producto vÃ¡lido.';
  }

  if (normalized.some((row) => row.componentMode === 'fixed' && row.quantity <= 0)) {
  return 'Todos los componentes fijos deben tener cantidad mayor a 0.';
}

  const seen = new Set<string>();
  for (const row of normalized) {
    const key = `${row.componentProductId}::${row.componentMode}`;
    if (seen.has(key)) {
      return 'No repitas el mismo componente con el mismo modo. EdÃ­talo en una sola fila.';
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
      return 'El lÃ­mite de detalle debe ser mayor a 0 para un plato editable.';
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
    inventoryItems = [],
    inventoryMovements = [],
    inventoryRecipes = [],
    inventoryRecipeComponents = [],
  productInventoryLinks = [],
  clients = [],
  clientTotalCount,
  clientActiveCount,
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
    inventoryItems?: InventoryItem[];
    inventoryMovements?: InventoryMovementItem[];
    inventoryRecipes?: InventoryRecipeItem[];
    inventoryRecipeComponents?: InventoryRecipeComponentItem[];
    productInventoryLinks?: ProductInventoryLink[];
    clients?: ClientItem[];
    clientTotalCount?: number;
    clientActiveCount?: number;
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
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [calendarViewMonth, setCalendarViewMonth] = useState(() => {
    const base = new Date();
    return new Date(base.getFullYear(), base.getMonth(), 1);
  });
  const [viewMode, setViewMode] = useState<ViewMode>('operations');
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('catalog');
  const [inventorySearch, setInventorySearch] = useState('');
  const [inventoryGroupFilter, setInventoryGroupFilter] = useState<
    '' | 'raw' | 'fried' | 'prefried' | 'sauces' | 'packaging' | 'other'
  >('');
  const [selectedInventoryProductId, setSelectedInventoryProductId] = useState<number | null>(null);
  const [inventoryItemCreateOpen, setInventoryItemCreateOpen] = useState(false);
  const [inventoryItemEditOpen, setInventoryItemEditOpen] = useState(false);
  const [inventoryDrawerMode, setInventoryDrawerMode] = useState<'movement' | 'edit' | 'recipe'>('movement');
  const [inventoryItemSaving, setInventoryItemSaving] = useState(false);
  const [inventoryItemFormName, setInventoryItemFormName] = useState('');
  const [inventoryItemFormKind, setInventoryItemFormKind] = useState<InventoryItem['inventoryKind']>('raw_material');
  const [inventoryItemFormGroup, setInventoryItemFormGroup] = useState<
    InventoryItem['inventoryGroup']
  >('other');
  const [inventoryItemFormUnitName, setInventoryItemFormUnitName] = useState('pieza');
  const [inventoryItemFormPackagingName, setInventoryItemFormPackagingName] = useState('');
  const [inventoryItemFormPackagingSize, setInventoryItemFormPackagingSize] = useState('');
  const [inventoryItemFormCurrentStock, setInventoryItemFormCurrentStock] = useState('0');
  const [inventoryItemFormLowStock, setInventoryItemFormLowStock] = useState('');
  const [inventoryItemFormIsActive, setInventoryItemFormIsActive] = useState(true);
  const [inventoryItemFormNotes, setInventoryItemFormNotes] = useState('');
  const [inventoryMovementOpen, setInventoryMovementOpen] = useState(false);
  const [inventoryMovementSaving, setInventoryMovementSaving] = useState(false);
  const [inventoryMovementType, setInventoryMovementType] = useState<'inbound' | 'damage' | 'waste' | 'manual_adjustment' | 'stock_count'>('inbound');
  const [inventoryMovementPackagingQty, setInventoryMovementPackagingQty] = useState('0');
  const [inventoryMovementUnitQty, setInventoryMovementUnitQty] = useState('0');
  const [inventoryMovementReasonCode, setInventoryMovementReasonCode] = useState('');
  const [inventoryMovementNotes, setInventoryMovementNotes] = useState('');
  const [inventoryProductionOpen, setInventoryProductionOpen] = useState(false);
  const [inventoryProductionSaving, setInventoryProductionSaving] = useState(false);
  const [selectedInventoryRecipeId, setSelectedInventoryRecipeId] = useState<number | null>(null);
  const [inventoryRecipeFormKind, setInventoryRecipeFormKind] = useState<'production' | 'packaging'>('production');
  const [inventoryRecipeFormOutputUnits, setInventoryRecipeFormOutputUnits] = useState('1');
  const [inventoryRecipeFormNotes, setInventoryRecipeFormNotes] = useState('');
  const [inventoryRecipeRows, setInventoryRecipeRows] = useState<EditableInventoryRecipeRow[]>([]);
  const [inventoryRecipeSaving, setInventoryRecipeSaving] = useState(false);
  const [inventoryProductionBatches, setInventoryProductionBatches] = useState('1');
  const [inventoryProductionNotes, setInventoryProductionNotes] = useState('');
  const [calculationsTab, setCalculationsTab] = useState<CalculationsTab>('general');
  const [deliveriesTab, setDeliveriesTab] = useState<DeliveriesTab>('overview');
  const [advisorCalcDateFrom, setAdvisorCalcDateFrom] = useState('');
  const [advisorCalcDateTo, setAdvisorCalcDateTo] = useState('');
  const [advisorCalcSource, setAdvisorCalcSource] = useState<CalculationsSource>('');
  const [advisorCalcAdvisorId, setAdvisorCalcAdvisorId] = useState('');
  const [advisorCalcBasePct, setAdvisorCalcBasePct] = useState('8');
  const [deliveryInternalDriverFilter, setDeliveryInternalDriverFilter] = useState('');
  const [deliveryExternalPartnerFilter, setDeliveryExternalPartnerFilter] = useState('');
  const [selectedDeliveryPartnerId, setSelectedDeliveryPartnerId] = useState<number | null>(null);
  const [deliveryPartnerDetailOpen, setDeliveryPartnerDetailOpen] = useState(false);
  const [deliveryPartnerEditOpen, setDeliveryPartnerEditOpen] = useState(false);
  const [deliveryPartnerCreateOpen, setDeliveryPartnerCreateOpen] = useState(false);
  const [deliveryPartnerSaving, setDeliveryPartnerSaving] = useState(false);
  const [deliveryPartnerFormName, setDeliveryPartnerFormName] = useState('');
  const [deliveryPartnerFormType, setDeliveryPartnerFormType] = useState<'company_dispatch' | 'direct_driver'>('company_dispatch');
  const [deliveryPartnerFormWhatsapp, setDeliveryPartnerFormWhatsapp] = useState('');
  const [deliveryPartnerFormIsActive, setDeliveryPartnerFormIsActive] = useState(true);
  const [selectedDeliveryPartnerRateId, setSelectedDeliveryPartnerRateId] = useState<number | null>(null);
  const [deliveryPartnerRateEditOpen, setDeliveryPartnerRateEditOpen] = useState(false);
  const [deliveryPartnerRateCreateOpen, setDeliveryPartnerRateCreateOpen] = useState(false);
  const [deliveryPartnerRateSaving, setDeliveryPartnerRateSaving] = useState(false);
  const [deliveryPartnerRateKmFrom, setDeliveryPartnerRateKmFrom] = useState('');
  const [deliveryPartnerRateKmTo, setDeliveryPartnerRateKmTo] = useState('');
  const [deliveryPartnerRatePriceUsd, setDeliveryPartnerRatePriceUsd] = useState('');
  const [deliveryPartnerRateIsActive, setDeliveryPartnerRateIsActive] = useState(true);
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
  const [movementSaving, setMovementSaving] = useState(false);
  const [movementMoneyAccountId, setMovementMoneyAccountId] = useState('');
  const [movementAmount, setMovementAmount] = useState('');
  const [movementExchangeRate, setMovementExchangeRate] = useState('');
  const [movementDate, setMovementDate] = useState(new Date().toISOString().slice(0, 10));
  const [movementReferenceCode, setMovementReferenceCode] = useState('');
  const [movementCounterpartyName, setMovementCounterpartyName] = useState('');
  const [movementDescription, setMovementDescription] = useState('');
  const [movementNotes, setMovementNotes] = useState('');
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
  const [adjustmentsDateFrom, setAdjustmentsDateFrom] = useState('');
  const [adjustmentsDateTo, setAdjustmentsDateTo] = useState('');
  const [adjustmentsAdminFilter, setAdjustmentsAdminFilter] = useState('');
  const [adjustmentsTypeFilter, setAdjustmentsTypeFilter] = useState('');
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
const [newInternalRiderPayUsd, setNewInternalRiderPayUsd] = useState('');
const [newInventoryEnabled, setNewInventoryEnabled] = useState(false);
const [newInventoryKind, setNewInventoryKind] = useState<'raw_material' | 'prepared_base' | 'finished_good'>('finished_good');
const [newInventoryGroup, setNewInventoryGroup] = useState<
  'raw' | 'fried' | 'prefried' | 'sauces' | 'packaging' | 'other'
>('other');
const [newInventoryDeductionMode, setNewInventoryDeductionMode] = useState<'self' | 'composition'>('self');
  const [newInventoryUnitName, setNewInventoryUnitName] = useState('pieza');
  const [newPackagingName, setNewPackagingName] = useState('');
  const [newPackagingSize, setNewPackagingSize] = useState('');
  const [newCurrentStockUnits, setNewCurrentStockUnits] = useState('0');
  const [newLowStockThreshold, setNewLowStockThreshold] = useState('');
  const [newInventoryLinks, setNewInventoryLinks] = useState<EditableInventoryLinkRow[]>([]);

const [editIsActive, setEditIsActive] = useState(true);
  const [editType, setEditType] = useState<'product' | 'combo' | 'service' | 'promo' | 'gambit'>('product');
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
  const [editInternalRiderPayUsd, setEditInternalRiderPayUsd] = useState('');
  const [editInventoryEnabled, setEditInventoryEnabled] = useState(false);
  const [editInventoryKind, setEditInventoryKind] = useState<'raw_material' | 'prepared_base' | 'finished_good'>('finished_good');
  const [editInventoryGroup, setEditInventoryGroup] = useState<
    'raw' | 'fried' | 'prefried' | 'sauces' | 'packaging' | 'other'
  >('other');
  const [editInventoryDeductionMode, setEditInventoryDeductionMode] = useState<'self' | 'composition'>('self');
  const [editInventoryUnitName, setEditInventoryUnitName] = useState('pieza');
  const [editPackagingName, setEditPackagingName] = useState('');
  const [editPackagingSize, setEditPackagingSize] = useState('');
  const [editCurrentStockUnits, setEditCurrentStockUnits] = useState('0');
  const [editLowStockThreshold, setEditLowStockThreshold] = useState('');
  const [editInventoryLinks, setEditInventoryLinks] = useState<EditableInventoryLinkRow[]>([]);
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

  const [currentTimeMs, setCurrentTimeMs] = useState(() => Date.now());

  useEffect(() => {
    const tick = () => setCurrentTimeMs(Date.now());
    tick();
    const intervalId = window.setInterval(tick, 60 * 1000);
    return () => window.clearInterval(intervalId);
  }, []);

  const createOrderProductSearchRef = useRef<HTMLInputElement | null>(null);
  const createOrderQtyRef = useRef<HTMLInputElement | null>(null);

  const createOrderConfigAliasRef = useRef<HTMLInputElement | null>(null);
  const createOrderConfigQtyRefs = useRef<Array<HTMLInputElement | null>>([]);

  const [tray, setTray] = useState<MasterTray>('all');
  const [search, setSearch] = useState('');
  const [selectedOrderId, setSelectedOrderId] = useState<number | null>(null);

  const [detailOpen, setDetailOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const [detailTab, setDetailTab] = useState<'detalle' | 'entrega' | 'pagos' | 'notas' | 'ajustes'>('detalle');

  const [returnMode, setReturnMode] = useState(false);
  const [returnReason, setReturnReason] = useState('');

const [deliveryAssignMode, setDeliveryAssignMode] = useState<null | 'internal' | 'external'>(null);
const [deliveryAssignDriverId, setDeliveryAssignDriverId] = useState('');
const [deliveryAssignPartnerId, setDeliveryAssignPartnerId] = useState('');
const [deliveryAssignReference, setDeliveryAssignReference] = useState('');
const [deliveryAssignDistanceKm, setDeliveryAssignDistanceKm] = useState('');
const [deliveryAssignCostUsd, setDeliveryAssignCostUsd] = useState('');
const [deliveryAssignCostManuallyEdited, setDeliveryAssignCostManuallyEdited] = useState(false);

const [paymentReportBoxOpen, setPaymentReportBoxOpen] = useState(false);
const [paymentReportMoneyAccountId, setPaymentReportMoneyAccountId] = useState('');
const [paymentReportAmount, setPaymentReportAmount] = useState('');
const [paymentReportExchangeRate, setPaymentReportExchangeRate] = useState('');
const [paymentReportReferenceCode, setPaymentReportReferenceCode] = useState('');
const [paymentReportPayerName, setPaymentReportPayerName] = useState('');
const [paymentReportNotes, setPaymentReportNotes] = useState('');
const [paymentApplyFundAmountUsd, setPaymentApplyFundAmountUsd] = useState('');
const [paymentApplyFundNotes, setPaymentApplyFundNotes] = useState('');
const [paymentGiveChangeBoxOpen, setPaymentGiveChangeBoxOpen] = useState(false);
const [paymentGiveChangeMoneyAccountId, setPaymentGiveChangeMoneyAccountId] = useState('');
const [paymentGiveChangeAmount, setPaymentGiveChangeAmount] = useState('');
const [paymentGiveChangeExchangeRate, setPaymentGiveChangeExchangeRate] = useState('');
const [paymentGiveChangeNotes, setPaymentGiveChangeNotes] = useState('');
const [paymentConfirmBoxOpen, setPaymentConfirmBoxOpen] = useState(false);
const [paymentConfirmReportId, setPaymentConfirmReportId] = useState<number | null>(null);
const [paymentConfirmReviewNotes, setPaymentConfirmReviewNotes] = useState('');
const [paymentConfirmOverpaymentHandling, setPaymentConfirmOverpaymentHandling] = useState<
  '' | 'change_given' | 'store_fund' | 'close_difference'
>('');
const [paymentConfirmOverpaymentNotes, setPaymentConfirmOverpaymentNotes] = useState('');
const [paymentConfirmChangeMoneyAccountId, setPaymentConfirmChangeMoneyAccountId] = useState('');
const [paymentConfirmChangeAmount, setPaymentConfirmChangeAmount] = useState('');
const [paymentConfirmChangeExchangeRate, setPaymentConfirmChangeExchangeRate] = useState('');
const [paymentConfirmSaving, setPaymentConfirmSaving] = useState(false);

  const [movementOpen, setMovementOpen] = useState(false);
  const [movementType, setMovementType] = useState<'Ingreso' | 'Egreso'>('Ingreso');

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
const [createOrderIsAsap, setCreateOrderIsAsap] = useState(false);

const [createOrderReceiverIsDifferent, setCreateOrderReceiverIsDifferent] = useState(false);
const [createOrderReceiverName, setCreateOrderReceiverName] = useState('');
const [createOrderReceiverPhone, setCreateOrderReceiverPhone] = useState('');
const [createOrderDeliveryAddress, setCreateOrderDeliveryAddress] = useState('');
const [createOrderDeliveryGpsUrl, setCreateOrderDeliveryGpsUrl] = useState('');
const [createOrderSelectedAddressIndex, setCreateOrderSelectedAddressIndex] = useState<number | null>(null);
const [createOrderNote, setCreateOrderNote] = useState('');

const [createOrderPaymentMethod, setCreateOrderPaymentMethod] = useState('payment_mobile');
const [createOrderPaymentCurrency, setCreateOrderPaymentCurrency] = useState<'USD' | 'VES'>('VES');
const [createOrderPaymentRequiresChange, setCreateOrderPaymentRequiresChange] = useState(false);
const [createOrderPaymentChangeFor, setCreateOrderPaymentChangeFor] = useState('');
const [createOrderPaymentChangeCurrency, setCreateOrderPaymentChangeCurrency] = useState<'USD' | 'VES'>('USD');
const [createOrderPaymentNote, setCreateOrderPaymentNote] = useState('');
const [createOrderUseClientFund, setCreateOrderUseClientFund] = useState(false);
const [createOrderClientFundAmountUsd, setCreateOrderClientFundAmountUsd] = useState('');

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
const [priceAdjustOpen, setPriceAdjustOpen] = useState(false);
const [priceAdjustItemLocalId, setPriceAdjustItemLocalId] = useState<string | null>(null);
const [priceAdjustValue, setPriceAdjustValue] = useState('');
const [priceAdjustReason, setPriceAdjustReason] = useState('');
const [adminEditReason, setAdminEditReason] = useState('');

const [kitchenTakeBoxOpen, setKitchenTakeBoxOpen] = useState(false);
const [kitchenEtaMinutes, setKitchenEtaMinutes] = useState('15');
const [deliveryEtaBoxOpen, setDeliveryEtaBoxOpen] = useState(false);
const [deliveryEtaMinutes, setDeliveryEtaMinutes] = useState('25');

const [returnToQueueBoxOpen, setReturnToQueueBoxOpen] = useState(false);
const [returnToQueueReason, setReturnToQueueReason] = useState('');

const [reviewActionMode, setReviewActionMode] = useState<null | 'approve' | 'reapprove' | 'return'>(
  null,
);
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
        label: `${o.id} Â· ${o.clientName}`,
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

  const deliveryStats = useMemo(() => {
    const activeDeliveryOrders = dayOrders.filter(
      (order) => order.fulfillment === 'delivery' && !['delivered', 'cancelled'].includes(order.status)
    );
    const internos = activeDeliveryOrders.filter((order) => Boolean(order.riderName?.trim())).length;
    const externos = activeDeliveryOrders.filter((order) => Boolean(order.externalPartner?.trim())).length;
    return { internos, externos };
  }, [dayOrders]);

  const kitchenStats = useMemo(() => {
    const pendientesToma = dayOrders.filter((order) => order.status === 'confirmed').length;
    const enPreparacion = dayOrders.filter((order) => order.status === 'in_kitchen').length;
    const preparados = dayOrders.filter((order) => order.status === 'ready').length;
    const totalEnCocina = pendientesToma + enPreparacion + preparados;
    return { totalEnCocina, pendientesToma, enPreparacion, preparados };
  }, [dayOrders]);

  const deliveryBuckets = useMemo(() => {
    const byDeliveryTime = (a: Order, b: Order) =>
      new Date(a.deliveryAtISO).getTime() - new Date(b.deliveryAtISO).getTime();
    const activeDeliveryOrders = dayOrders.filter(
      (order) => order.fulfillment === 'delivery' && !['delivered', 'cancelled'].includes(order.status)
    );

    return {
      internal: activeDeliveryOrders.filter((order) => Boolean(order.riderName?.trim())).sort(byDeliveryTime),
      external: activeDeliveryOrders.filter((order) => Boolean(order.externalPartner?.trim())).sort(byDeliveryTime),
    };
  }, [dayOrders]);

  const kitchenBuckets = useMemo(() => {
    const byDeliveryTime = (a: Order, b: Order) =>
      new Date(a.deliveryAtISO).getTime() - new Date(b.deliveryAtISO).getTime();

    return {
      total: dayOrders.filter((order) => ['confirmed', 'in_kitchen', 'ready'].includes(order.status)).sort(byDeliveryTime),
      pending_take: dayOrders.filter((order) => order.status === 'confirmed').sort(byDeliveryTime),
      preparing: dayOrders.filter((order) => order.status === 'in_kitchen').sort(byDeliveryTime),
      ready: dayOrders.filter((order) => order.status === 'ready').sort(byDeliveryTime),
    };
  }, [dayOrders]);

  const paymentBuckets = useMemo(() => {
    const byDeliveryTime = (a: Order, b: Order) =>
      new Date(a.deliveryAtISO).getTime() - new Date(b.deliveryAtISO).getTime();

    return {
      pending: weekOrders.filter((order) => order.paymentVerify === 'pending').sort(byDeliveryTime),
      confirmed: weekOrders.filter((order) => order.paymentVerify === 'confirmed').sort(byDeliveryTime),
      rejected: weekOrders.filter((order) => order.paymentVerify === 'rejected').sort(byDeliveryTime),
    };
  }, [weekOrders]);

  const committedListDay = useMemo(() => computeCommittedUndByProduct(dayOrders), [dayOrders]);
  const committedListWeek = useMemo(() => computeCommittedUndByProduct(weekOrders), [weekOrders]);
  const committedProductsRowsDay = useMemo(
    () => buildCommittedProductsRows(committedListDay, inventoryItems),
    [committedListDay, inventoryItems]
  );
  const committedProductsRowsWeek = useMemo(
    () => buildCommittedProductsRows(committedListWeek, inventoryItems),
    [committedListWeek, inventoryItems]
  );

  const urgentTaskBuckets = useMemo(() => {
    const byDeliveryTime = (a: Order, b: Order) =>
      new Date(a.deliveryAtISO).getTime() - new Date(b.deliveryAtISO).getTime();

    return {
      approve: dayOrders.filter((order) => order.status === 'created').sort(byDeliveryTime),
      reapprove: dayOrders
        .filter((order) => order.status === 'queued' && order.queuedNeedsReapproval)
        .sort(byDeliveryTime),
      kitchen: dayOrders
        .filter((order) => order.status === 'queued' && !order.queuedNeedsReapproval)
        .sort(byDeliveryTime),
      driver: dayOrders
        .filter(
          (order) =>
            order.fulfillment === 'delivery' &&
            ['queued', 'ready', 'out_for_delivery'].includes(order.status) &&
            !order.riderName &&
            !order.externalPartner
        )
        .sort(byDeliveryTime),
    };
  }, [dayOrders]);

  const lowStockAlertsCount = useMemo(
    () =>
      inventoryItems.filter((item) => {
        if (item.lowStockThreshold == null) return false;
        return Number(item.currentStockUnits || 0) <= Number(item.lowStockThreshold || 0);
      }).length,
    [inventoryItems]
  );

  const [productsExpanded, setProductsExpanded] = useState(false);
  const [committedProductsScope, setCommittedProductsScope] = useState<'day' | 'week'>('day');
  const [committedProductsBucket, setCommittedProductsBucket] = useState<CommittedBucket>('products');
  const [paymentsPanelOpen, setPaymentsPanelOpen] = useState(false);
  const [paymentsPanelKind, setPaymentsPanelKind] = useState<'pending' | 'confirmed' | 'rejected'>('pending');
  const [deliveryPanelOpen, setDeliveryPanelOpen] = useState(false);
  const [deliveryPanelKind, setDeliveryPanelKind] = useState<'internal' | 'external'>('internal');
  const [kitchenPanelOpen, setKitchenPanelOpen] = useState(false);
  const [kitchenPanelKind, setKitchenPanelKind] = useState<'total' | 'pending_take' | 'preparing' | 'ready'>('total');
  const [taskPanelOpen, setTaskPanelOpen] = useState(false);
  const [taskPanelKind, setTaskPanelKind] = useState<'approve' | 'reapprove' | 'kitchen' | 'driver'>('approve');

  const notifications: MasterNotification[] = useMemo(() => {
    const out: MasterNotification[] = [];
    for (const o of orders) {
      const delText = fmtDeliveryTextES(o.deliveryAtISO);
      if (o.status === 'created') {
        out.push({
          id: `n-ap-${o.id}`,
          type: 'APROBAR',
          orderId: o.id,
          label: `${o.id} · ${repairDisplayText(o.clientName)}`,
          deliveryText: `Entrega: ${delText}`,
          advisorName: o.advisorName,
        });
      }
      if (o.status === 'queued' && o.queuedNeedsReapproval) {
        out.push({
          id: `n-re-${o.id}`,
          type: 'RE-APROBAR',
          orderId: o.id,
          label: `${o.id} · ${repairDisplayText(o.clientName)}`,
          deliveryText: `Entrega: ${delText}`,
          advisorName: o.advisorName,
        });
      }
      if (o.paymentVerify === 'pending') {
        out.push({
          id: `n-pay-${o.id}`,
          type: 'CONFIRMAR PAGO',
          orderId: o.id,
          label: `${o.id} · ${repairDisplayText(o.clientName)}`,
          deliveryText: `Entrega: ${delText}`,
          advisorName: o.advisorName,
        });
      }
    }
    const pr = (t: NotificationType) => (t === 'RE-APROBAR' ? 0 : t === 'CONFIRMAR PAGO' ? 1 : 2);
    return out.sort((a, b) => pr(a.type) - pr(b.type));
  }, [orders]);

  const committedProductsRows =
    committedProductsScope === 'day' ? committedProductsRowsDay : committedProductsRowsWeek;
  const committedProductsDetailRows = committedProductsRows.filter(
    (row) => row.bucket === committedProductsBucket
  );
  const committedProductsTotalUnits = committedProductsRows.reduce((sum, row) => sum + row.und, 0);
  const committedProductsDayTotalUnits = committedProductsRowsDay.reduce((sum, row) => sum + row.und, 0);
  const committedProductsPreviewRows = committedProductsRowsDay.slice(0, 4);

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

const createOrderConfigOptionalFixedOptions = useMemo(() => {
  if (!createOrderConfigProductId) return [];

  return productComponents
    .filter(
      (pc) =>
        pc.parentProductId === createOrderConfigProductId &&
        pc.componentMode === 'fixed' &&
        !pc.isRequired
    )
    .sort((a, b) => a.sortOrder - b.sortOrder || a.componentName.localeCompare(b.componentName));
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

  const productInventoryLinksByProductId = useMemo(() => {
    const map = new Map<number, ProductInventoryLink[]>();
    for (const link of productInventoryLinks) {
      if (!link.isActive) continue;
      const list = map.get(link.productId) ?? [];
      list.push(link);
      map.set(link.productId, list);
    }
    return map;
  }, [productInventoryLinks]);

  const selectedCatalogInventoryLinks = useMemo(
    () => (selectedCatalogItem ? productInventoryLinksByProductId.get(selectedCatalogItem.id) ?? [] : []),
    [selectedCatalogItem, productInventoryLinksByProductId]
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
    setEditType(selectedCatalogItem.type);
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
    setEditInternalRiderPayUsd(
      selectedCatalogItem.internalRiderPayUsd == null ? '' : String(selectedCatalogItem.internalRiderPayUsd)
    );
      setEditInventoryEnabled(selectedCatalogItem.inventoryEnabled);
      setEditInventoryKind(selectedCatalogItem.inventoryKind);
      setEditInventoryGroup(selectedCatalogItem.inventoryGroup || 'other');
      setEditInventoryDeductionMode(selectedCatalogItem.inventoryDeductionMode);
    setEditInventoryUnitName(selectedCatalogItem.inventoryUnitName || 'pieza');
    setEditPackagingName(selectedCatalogItem.packagingName || '');
    setEditPackagingSize(selectedCatalogItem.packagingSize == null ? '' : String(selectedCatalogItem.packagingSize));
    setEditCurrentStockUnits(String(selectedCatalogItem.currentStockUnits ?? 0));
    setEditLowStockThreshold(
      selectedCatalogItem.lowStockThreshold == null ? '' : String(selectedCatalogItem.lowStockThreshold)
    );

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
    setEditInventoryLinks(
      selectedCatalogInventoryLinks.map((link, idx) => ({
        localId: `${link.id}-${idx}`,
        inventoryItemId: link.inventoryItemId,
        quantityUnits: String(link.quantityUnits),
        sortOrder: link.sortOrder || idx + 1,
        notes: link.notes ?? '',
      }))
    );
  }, [selectedCatalogItem, selectedCatalogComponents, selectedCatalogInventoryLinks]);

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

  const inventoryItemOptions = useMemo(
    () =>
      inventoryItems
        .filter((item) => item.isActive)
        .map((item) => ({
          value: String(item.id),
          label: item.name,
        })),
    [inventoryItems]
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
  setAdminEditReason('');
  setCreateOrderOpen(true);
};

const INVENTORY_MOVEMENT_LABEL: Record<InventoryMovementItem['movementType'], string> = {
  inbound: 'Entrada',
  sale_out: 'Salida por venta',
  damage: 'AverÃ­a',
  waste: 'Merma',
  manual_adjustment: 'Ajuste manual',
  stock_count: 'Conteo fÃ­sico',
  production_out: 'Salida por producciÃ³n',
  production_in: 'Entrada por producciÃ³n',
  pack_out: 'Salida por empaque',
  pack_in: 'Entrada por empaque',
};

const INVENTORY_GROUP_OPTIONS = [
  { value: 'other', label: 'Otros' },
  { value: 'raw', label: 'Crudos' },
  { value: 'fried', label: 'Fritos' },
  { value: 'prefried', label: 'Prefritos' },
  { value: 'sauces', label: 'Salsas' },
  { value: 'packaging', label: 'Envases' },
] as const;

const INVENTORY_GROUP_LABEL: Record<
  'raw' | 'fried' | 'prefried' | 'sauces' | 'packaging' | 'other',
  string
> = {
  raw: 'Crudos',
  fried: 'Fritos',
  prefried: 'Prefritos',
  sauces: 'Salsas',
  packaging: 'Envases',
  other: 'Otros',
};

const INVENTORY_KIND_LABEL: Record<
  'raw_material' | 'prepared_base' | 'finished_stock' | 'packaging',
  string
> = {
  raw_material: 'Materia prima',
  prepared_base: 'Base preparada',
  finished_stock: 'Stock final',
  packaging: 'Empaque',
};

const makeLocalId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

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
  resetPriceAdjustBox();

  setCreateOrderDeliveryDate(deliveryFields.date);
  setCreateOrderDeliveryHour12(deliveryFields.hour12);
  setCreateOrderDeliveryMinute(deliveryFields.minute);
  setCreateOrderDeliveryAmPm(deliveryFields.ampm);
  setCreateOrderIsAsap(Boolean(selectedOrder?.editMeta?.isAsap));

  const receiverName = order.editMeta?.receiverName?.trim() ?? '';
  const receiverPhone = order.editMeta?.receiverPhone?.trim() ?? '';
  const hasDifferentReceiver = !!receiverName || !!receiverPhone;

  setCreateOrderReceiverIsDifferent(hasDifferentReceiver);
  setCreateOrderReceiverName(receiverName);
  setCreateOrderReceiverPhone(receiverPhone);

  setCreateOrderDeliveryAddress(order.address ?? '');
  setCreateOrderDeliveryGpsUrl(order.editMeta?.deliveryGpsUrl ?? '');
  setCreateOrderSelectedAddressIndex(null);
  setCreateOrderNote(order.notes ?? '');

  setCreateOrderPaymentMethod(order.editMeta?.paymentMethod ?? 'payment_mobile');
  setCreateOrderPaymentCurrency(order.editMeta?.paymentCurrency ?? 'VES');
  setCreateOrderPaymentRequiresChange(Boolean(order.editMeta?.paymentRequiresChange));
  setCreateOrderPaymentChangeFor(order.editMeta?.paymentChangeFor ?? '');
  setCreateOrderPaymentChangeCurrency(order.editMeta?.paymentChangeCurrency ?? 'USD');
  setCreateOrderPaymentNote(order.editMeta?.paymentNote ?? '');
  setCreateOrderUseClientFund((order.editMeta?.clientFundUsedUsd ?? 0) > 0.005);
  setCreateOrderClientFundAmountUsd(
    order.editMeta?.clientFundUsedUsd != null && order.editMeta.clientFundUsedUsd > 0
      ? String(order.editMeta.clientFundUsedUsd)
      : ''
  );

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
  setAdminEditReason('');
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
    const message = err instanceof Error ? err.message : 'Error cerrando sesiÃ³n.';
    showToast('error', message);
  }
};

const resetDeliveryAssignBox = () => {
  setDeliveryAssignMode(null);
  setDeliveryAssignDriverId('');
  setDeliveryAssignPartnerId('');
  setDeliveryAssignReference('');
  setDeliveryAssignDistanceKm('');
  setDeliveryAssignCostUsd('');
  setDeliveryAssignCostManuallyEdited(false);
};

const resetPriceAdjustBox = () => {
  setPriceAdjustOpen(false);
  setPriceAdjustItemLocalId(null);
  setPriceAdjustValue('');
  setPriceAdjustReason('');
};

const resetPaymentReportBox = () => {
  setPaymentReportBoxOpen(false);
  setPaymentReportMoneyAccountId('');
  setPaymentReportAmount('');
  setPaymentReportExchangeRate('');
  setPaymentReportReferenceCode('');
  setPaymentReportPayerName('');
  setPaymentReportNotes('');
  setPaymentApplyFundAmountUsd('');
  setPaymentApplyFundNotes('');
  setPaymentGiveChangeBoxOpen(false);
  setPaymentGiveChangeMoneyAccountId('');
  setPaymentGiveChangeAmount('');
  setPaymentGiveChangeExchangeRate('');
  setPaymentGiveChangeNotes('');
};

const resetPaymentConfirmBox = () => {
  setPaymentConfirmBoxOpen(false);
  setPaymentConfirmReportId(null);
  setPaymentConfirmReviewNotes('');
  setPaymentConfirmOverpaymentHandling('');
  setPaymentConfirmOverpaymentNotes('');
  setPaymentConfirmChangeMoneyAccountId('');
  setPaymentConfirmChangeAmount('');
  setPaymentConfirmChangeExchangeRate('');
  setPaymentConfirmSaving(false);
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
  if (!createOrderConfigProductId) {
    return createOrderConfigSelections.reduce((sum, item) => sum + Number(item.qty || 0), 0);
  }

  const componentById = new Map(
    productComponents
      .filter((pc) => pc.parentProductId === createOrderConfigProductId)
      .map((pc) => [pc.componentProductId, pc] as const)
  );

  return createOrderConfigSelections.reduce((sum, item) => {
    const component = componentById.get(item.componentProductId);
    if (component && !component.countsTowardDetailLimit) {
      return sum;
    }
    return sum + Number(item.qty || 0);
  }, 0);
}, [createOrderConfigProductId, createOrderConfigSelections, productComponents]);

const handleAssignInternal = async (o: Order) => {
  try {
    if (!deliveryAssignDriverId) {
      showToast('error', 'Debes seleccionar un driver interno.');
      return;
    }

    const inferredCostUsd = getInternalDeliveryPayUsd(o, catalogItemById);

    await assignInternalDriverAction({
      orderId: o.id,
      driverUserId: deliveryAssignDriverId,
      costUsd: inferredCostUsd > 0 ? inferredCostUsd : null,
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

    const distanceKm = Number(String(deliveryAssignDistanceKm || '').replace(',', '.'));
    const costUsd = Number(String(deliveryAssignCostUsd || '').replace(',', '.'));

    if (!Number.isFinite(distanceKm) || distanceKm <= 0) {
      showToast('error', 'Debes indicar la distancia en km.');
      return;
    }

    if (!Number.isFinite(costUsd) || costUsd < 0) {
      showToast('error', 'Debes indicar el costo del delivery.');
      return;
    }

    await assignExternalPartnerAction({
      orderId: o.id,
      partnerId: Number(deliveryAssignPartnerId),
      reference: deliveryAssignReference.trim() || null,
      distanceKm,
      costUsd,
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

    showToast('error', 'Esta orden no requiere aprobaciÃ³n.');
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

    showToast('success', 'Pedido devuelto a revisiÃ³n.');
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
      showToast('error', 'Cuenta invÃ¡lida.');
      return;
    }

    const reportedAmount = Number(paymentReportAmount || 0);
    if (!Number.isFinite(reportedAmount) || reportedAmount <= 0) {
      showToast('error', 'Monto invÃ¡lido.');
      return;
    }

    let exchangeRate: number | null = null;

    if (selectedAccount.currencyCode === 'VES') {
      exchangeRate = Number(paymentReportExchangeRate || 0);
      if (!Number.isFinite(exchangeRate) || exchangeRate <= 0) {
        showToast('error', 'Debes indicar una tasa vÃ¡lida para pagos en VES.');
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

const handleApplyClientFundPayment = async (o: Order) => {
  try {
    if ((o.clientId ?? null) == null) {
      showToast('error', 'La orden no tiene cliente asociado.');
      return;
    }

    const amountUsd = Number(String(paymentApplyFundAmountUsd || '').replace(',', '.'));
    if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
      showToast('error', 'El monto del fondo no es vÃ¡lido.');
      return;
    }

    await applyClientFundPaymentAction({
      orderId: o.id,
      amountUsd,
      notes: paymentApplyFundNotes.trim() || null,
    });

    showToast('success', 'Fondo aplicado a la orden.');
    resetPaymentReportBox();
    router.refresh();
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Error aplicando el fondo.';
    showToast('error', message);
  }
};

const handleDeliverClientChange = async (o: Order) => {
  try {
    const moneyAccountId = Number(paymentGiveChangeMoneyAccountId || 0);
    if (!Number.isFinite(moneyAccountId) || moneyAccountId <= 0) {
      showToast('error', 'Debes seleccionar la cuenta desde la cual entregarÃ¡s el cambio.');
      return;
    }

    const selectedAccount = moneyAccounts.find((account) => account.id === moneyAccountId);
    if (!selectedAccount) {
      showToast('error', 'Cuenta invÃ¡lida.');
      return;
    }

    const amount = Number(String(paymentGiveChangeAmount || '').replace(',', '.'));
    if (!Number.isFinite(amount) || amount <= 0) {
      showToast('error', 'Debes indicar el monto del cambio.');
      return;
    }

    let exchangeRate: number | null = null;
    if (selectedAccount.currencyCode === 'VES') {
      exchangeRate = Number(String(paymentGiveChangeExchangeRate || '').replace(',', '.'));
      if (!Number.isFinite(exchangeRate) || exchangeRate <= 0) {
        showToast('error', 'Debes indicar una tasa vÃ¡lida para el cambio en Bs.');
        return;
      }
    }

    const result = await deliverClientFundChangeAction({
      orderId: o.id,
      moneyAccountId,
      currencyCode: selectedAccount.currencyCode,
      amount,
      exchangeRateVesPerUsd: exchangeRate,
      notes: paymentGiveChangeNotes.trim() || null,
    });

    if (!result.ok) {
      showToast('error', result.message);
      return;
    }

    showToast('success', 'Cambio entregado y registrado.');
    resetPaymentReportBox();
    router.refresh();
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Error entregando el cambio.';
    showToast('error', message);
  }
};

const handleCloseRoundingBalance = async (o: Order) => {
  try {
    if (!isAdmin) {
      showToast('error', 'Solo admin puede cerrar diferencias.');
      return;
    }

    if (o.balanceUsd <= 0.005) {
      showToast('error', 'Esta orden ya no tiene diferencia pendiente.');
      return;
    }

    if (o.balanceUsd > ORDER_ROUNDING_CLOSE_MAX_USD) {
      showToast(
        'error',
        `Solo puedes cerrar diferencias de hasta ${fmtUSD(ORDER_ROUNDING_CLOSE_MAX_USD)}.`
      );
      return;
    }

    const notes =
      window.prompt('Nota del cierre por redondeo (opcional):', 'Ajuste por redondeo') ?? '';

    await closeOrderRoundingBalanceAction({
      orderId: o.id,
      notes: notes.trim() || null,
    });

    showToast('success', 'Diferencia cerrada.');
    router.refresh();
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Error cerrando la diferencia.';
    showToast('error', message);
  }
};

const handleConfirmPayment = async (o: Order, rp: PaymentReportItem) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const predictedExcessUsd = Number(
      Math.max(0, o.confirmedPaidUsd + rp.usdEquivalent - o.totalUsd).toFixed(2)
    );
    const reviewNotes = paymentConfirmReviewNotes.trim();
    let overpaymentHandling: 'change_given' | 'store_fund' | 'close_difference' | null =
      predictedExcessUsd > 0.005 ? 'store_fund' : null;
    let overpaymentNotes: string | null = null;

    if (predictedExcessUsd > 0.005) {
      if (false && !paymentConfirmOverpaymentHandling) {
        showToast('error', 'Debes elegir quÃ© hacer con el excedente.');
        return;
      }

      if (
        paymentConfirmOverpaymentHandling === 'close_difference' &&
        (!isAdmin || predictedExcessUsd > ORDER_ROUNDING_CLOSE_MAX_USD)
      ) {
        showToast('error', 'Ese excedente no puede cerrarse por redondeo.');
        return;
      }

      if (paymentConfirmOverpaymentHandling === 'change_given') {
        const selectedChangeAccount = moneyAccounts.find(
          (account) => account.id === Number(paymentConfirmChangeMoneyAccountId || 0)
        );

        if (!selectedChangeAccount) {
          showToast('error', 'Debes seleccionar la cuenta desde la cual se darÃ¡ el cambio.');
          return;
        }

        const changeAmount = Number(String(paymentConfirmChangeAmount || '').replace(',', '.'));
        if (!Number.isFinite(changeAmount) || changeAmount <= 0) {
          showToast('error', 'Debes indicar el monto real del cambio.');
          return;
        }

        if (selectedChangeAccount.currencyCode === 'VES') {
          const changeRate = Number(String(paymentConfirmChangeExchangeRate || '').replace(',', '.'));
          if (!Number.isFinite(changeRate) || changeRate <= 0) {
            showToast('error', 'Debes indicar una tasa vÃ¡lida para el cambio en Bs.');
            return;
          }
        }
      }

      overpaymentHandling =
        paymentConfirmOverpaymentHandling === 'close_difference'
          ? 'close_difference'
          : 'store_fund';
      overpaymentNotes = paymentConfirmOverpaymentNotes.trim() || null;
    }

    setPaymentConfirmSaving(true);

    await confirmPaymentReportAction({
      reportId: rp.id,
      orderId: o.id,
      clientId: o.clientId,
      confirmedMoneyAccountId: rp.moneyAccountId,
      confirmedCurrency: rp.currencyCode,
      confirmedAmount: rp.amount,
      movementDate: today,
      confirmedExchangeRateVesPerUsd: rp.exchangeRate ?? null,
      reviewNotes,
      referenceCode: rp.referenceCode ?? null,
      counterpartyName: rp.payerName ?? null,
      description: `Pago confirmado desde Master Dashboard · orden ${o.id} · reporte ${rp.id}`,
      overpaymentHandling,
      overpaymentNotes,
      changeMoneyAccountId: null,
      changeCurrency: null,
      changeAmount: null,
      changeExchangeRateVesPerUsd: null,
    });

    showToast('success', 'Pago confirmado.');
    resetPaymentConfirmBox();
    router.refresh();
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Error confirmando el pago.';
    showToast('error', message);
  } finally {
    setPaymentConfirmSaving(false);
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

const openConfirmPaymentBox = (o: Order, rp: PaymentReportItem) => {
  const predictedExcessUsd = Number(
    Math.max(0, o.confirmedPaidUsd + rp.usdEquivalent - o.totalUsd).toFixed(2)
  );

  setPaymentConfirmReportId(rp.id);
  setPaymentConfirmReviewNotes('');
  setPaymentConfirmOverpaymentNotes('');
  setPaymentConfirmChangeMoneyAccountId(String(rp.moneyAccountId || ''));
  setPaymentConfirmChangeExchangeRate(
    rp.exchangeRate != null && rp.exchangeRate > 0 ? String(rp.exchangeRate) : ''
  );
  setPaymentConfirmChangeAmount(
    predictedExcessUsd > 0.005 ? String(Number(predictedExcessUsd.toFixed(2))) : ''
  );
  setPaymentConfirmOverpaymentHandling(
    predictedExcessUsd > 0.005
      ? predictedExcessUsd <= ORDER_ROUNDING_CLOSE_MAX_USD && isAdmin
        ? 'close_difference'
        : 'store_fund'
      : ''
  );
  setPaymentConfirmBoxOpen(true);
};

const handleKitchenTake = async (o: Order) => {
  try {
    const etaMinutes = Number(kitchenEtaMinutes || 0);

    if (!Number.isFinite(etaMinutes) || etaMinutes <= 0) {
      showToast('error', 'ETA invÃ¡lido.');
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
      showToast('error', 'Tiempo estimado invÃ¡lido.');
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
      window.prompt('Motivo para quitar la asignaciÃ³n (opcional):', '') ?? '';

    await clearDeliveryAssignmentAction({
      orderId: o.id,
      notes,
    });

    showToast('success', 'AsignaciÃ³n de delivery quitada.');
    router.refresh();
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Error quitando la asignaciÃ³n.';
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
      showToast('error', 'El monto fuente no es vÃ¡lido.');
      return;
    }

    await updateCatalogItemAction({
      productId: selectedCatalogItem.id,
      type: editType,
      sourcePriceAmount: normalizedSourcePriceAmount,
      sourcePriceCurrency: editSourcePriceCurrency,
      isActive: editIsActive,
      unitsPerService: Number(editUnitsPerService || 0),
      isDetailEditable: editIsDetailEditable,
      detailUnitsLimit: Number(editDetailUnitsLimit || 0),
      isInventoryItem: editInventoryEnabled,
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
      internalRiderPayUsd: editInternalRiderPayUsd.trim()
        ? Number(String(editInternalRiderPayUsd).trim().replace(',', '.'))
        : null,
      inventoryEnabled: editInventoryEnabled,
      inventoryKind: editInventoryKind,
      inventoryGroup: editInventoryGroup,
      inventoryDeductionMode: editInventoryDeductionMode,
      inventoryUnitName: editInventoryUnitName.trim() || 'pieza',
      packagingName: editPackagingName.trim() || null,
      packagingSize: editPackagingSize.trim()
        ? Number(String(editPackagingSize).trim().replace(',', '.'))
        : null,
      currentStockUnits: editCurrentStockUnits.trim()
        ? Number(String(editCurrentStockUnits).trim().replace(',', '.'))
        : 0,
      lowStockThreshold: editLowStockThreshold.trim()
        ? Number(String(editLowStockThreshold).trim().replace(',', '.'))
        : null,
      inventoryLinks: editInventoryLinks.map((row, idx) => ({
        inventoryItemId: Number(row.inventoryItemId || 0),
        quantityUnits: Number(String(row.quantityUnits || 0).trim().replace(',', '.')),
        notes: row.notes?.trim() || null,
        sortOrder: Number(row.sortOrder || idx + 1),
      })),
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

    showToast('success', 'CatÃ¡logo actualizado.');
    setCatalogEditMode(false);
    router.refresh();
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Error guardando catÃ¡logo.';
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
    showToast('success', `CatÃ¡logo actualizado por bloque (${changedItems.length}).`);
    setQuickCatalogOpen(false);
    router.refresh();
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Error actualizando precios rÃ¡pidos.';
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

  const resetMoneyMovementForm = () => {
    setMovementType('Ingreso');
    setMovementMoneyAccountId('');
    setMovementAmount('');
    setMovementExchangeRate(String(activeExchangeRate?.rateBsPerUsd ?? ''));
    setMovementDate(new Date().toISOString().slice(0, 10));
    setMovementReferenceCode('');
    setMovementCounterpartyName('');
    setMovementDescription('');
    setMovementNotes('');
  };

  const openCreateAccount = () => {
    resetAccountForm();
    setAccountCreateOpen(true);
  };

  const openMoneyMovementDrawer = (accountId?: number | null) => {
    resetMoneyMovementForm();
    setAccountDetailOpen(false);
    if (accountId && Number.isFinite(accountId) && accountId > 0) {
      setMovementMoneyAccountId(String(accountId));
    }
    setMovementOpen(true);
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

  const handleCreateMoneyMovement = async () => {
    try {
      const moneyAccountId = Number(movementMoneyAccountId || 0);
      if (!Number.isFinite(moneyAccountId) || moneyAccountId <= 0) {
        showToast('error', 'Debes seleccionar una cuenta.');
        return;
      }

      const amount = Number(String(movementAmount || '').replace(',', '.'));
      if (!Number.isFinite(amount) || amount <= 0) {
        showToast('error', 'El monto debe ser mayor a 0.');
        return;
      }

      const exchangeRate =
        selectedMovementAccount?.currencyCode === 'VES'
          ? Number(String(movementExchangeRate || '').replace(',', '.'))
          : null;

      if (
        selectedMovementAccount?.currencyCode === 'VES' &&
        (!Number.isFinite(exchangeRate) || Number(exchangeRate) <= 0)
      ) {
        showToast('error', 'Debes indicar una tasa vÃ¡lida para movimientos en Bs.');
        return;
      }

      if (!movementDate) {
        showToast('error', 'Debes indicar la fecha del movimiento.');
        return;
      }

      if (!movementDescription.trim()) {
        showToast('error', 'Debes indicar el motivo o descripciÃ³n.');
        return;
      }

      setMovementSaving(true);
      await createExtraMoneyMovementAction({
        direction: movementType === 'Ingreso' ? 'inflow' : 'outflow',
        moneyAccountId,
        amount,
        movementDate,
        exchangeRateVesPerUsd: exchangeRate,
        referenceCode: movementReferenceCode,
        counterpartyName: movementCounterpartyName,
        description: movementDescription,
        notes: movementNotes,
      });

      showToast('success', `${movementType} extraordinario registrado.`);
      setMovementOpen(false);
      resetMoneyMovementForm();
      router.refresh();
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'No se pudo guardar el movimiento.');
    } finally {
      setMovementSaving(false);
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

  const resetDeliveryPartnerForm = () => {
    setDeliveryPartnerFormName('');
    setDeliveryPartnerFormType('company_dispatch');
    setDeliveryPartnerFormWhatsapp('');
    setDeliveryPartnerFormIsActive(true);
  };

  const resetDeliveryPartnerRateForm = () => {
    setSelectedDeliveryPartnerRateId(null);
    setDeliveryPartnerRateKmFrom('');
    setDeliveryPartnerRateKmTo('');
    setDeliveryPartnerRatePriceUsd('');
    setDeliveryPartnerRateIsActive(true);
  };

  const normalizeDeliveryPartnerPhone = (raw: string) =>
    String(raw || '').replace(/[^\d+]/g, '');

  const handleDeliveryAssignPartnerChange = (value: string) => {
    setDeliveryAssignPartnerId(value);
    setDeliveryAssignCostManuallyEdited(false);
  };

  const handleDeliveryAssignDistanceChange = (value: string) => {
    setDeliveryAssignDistanceKm(value);
    setDeliveryAssignCostManuallyEdited(false);
  };

  const handleDeliveryAssignCostChange = (value: string) => {
    setDeliveryAssignCostUsd(value);
    setDeliveryAssignCostManuallyEdited(true);
  };

  const handleCreateDeliveryPartner = async () => {
    try {
      setDeliveryPartnerSaving(true);
      const supabase = createSupabaseBrowser();
      const { data, error } = await supabase
        .from('delivery_partners')
        .insert({
          name: String(deliveryPartnerFormName || '').trim(),
          partner_type:
            deliveryPartnerFormType === 'direct_driver'
              ? 'direct_driver'
              : 'company_dispatch',
          whatsapp_phone:
            normalizeDeliveryPartnerPhone(deliveryPartnerFormWhatsapp) || null,
          is_active: !!deliveryPartnerFormIsActive,
        })
        .select('id')
        .single();

      if (error) {
        throw new Error(error.message);
      }
      if (!data?.id) {
        throw new Error('No se pudo crear el partner externo.');
      }

      showToast('success', 'Partner externo creado.');
      setDeliveryPartnerCreateOpen(false);
      resetDeliveryPartnerForm();
      router.refresh();
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'No se pudo crear el partner.');
    } finally {
      setDeliveryPartnerSaving(false);
    }
  };

  const handleUpdateDeliveryPartner = async () => {
    if (!selectedDeliveryPartner) return;

    try {
      setDeliveryPartnerSaving(true);
      const supabase = createSupabaseBrowser();
      const { data, error } = await supabase
        .from('delivery_partners')
        .update({
          name: String(deliveryPartnerFormName || '').trim(),
          partner_type:
            deliveryPartnerFormType === 'direct_driver'
              ? 'direct_driver'
              : 'company_dispatch',
          whatsapp_phone:
            normalizeDeliveryPartnerPhone(deliveryPartnerFormWhatsapp) || null,
          is_active: !!deliveryPartnerFormIsActive,
        })
        .eq('id', selectedDeliveryPartner.id)
        .select('id')
        .single();

      if (error) {
        throw new Error(error.message);
      }
      if (!data?.id) {
        throw new Error('No se pudo actualizar el partner externo.');
      }

      showToast('success', 'Partner externo actualizado.');
      setDeliveryPartnerEditOpen(false);
      router.refresh();
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'No se pudo actualizar el partner.');
    } finally {
      setDeliveryPartnerSaving(false);
    }
  };

  const handleToggleDeliveryPartnerActive = async (partner: DeliveryPartnerOption) => {
    try {
      const supabase = createSupabaseBrowser();
      const { data, error } = await supabase
        .from('delivery_partners')
        .update({ is_active: !partner.isActive })
        .eq('id', partner.id)
        .select('id')
        .single();

      if (error) {
        throw new Error(error.message);
      }
      if (!data?.id) {
        throw new Error('No se pudo cambiar el estado del partner externo.');
      }

      showToast('success', partner.isActive ? 'Partner desactivado.' : 'Partner activado.');
      router.refresh();
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'No se pudo cambiar el estado del partner.');
    }
  };

  const handleCreateDeliveryPartnerRate = async () => {
    if (!selectedDeliveryPartner) return;

    try {
      setDeliveryPartnerRateSaving(true);

      const kmFrom = Number(String(deliveryPartnerRateKmFrom || '').replace(',', '.'));
      const kmToRaw = String(deliveryPartnerRateKmTo || '').trim();
      const kmTo = kmToRaw ? Number(kmToRaw.replace(',', '.')) : null;
      const priceUsd = Number(String(deliveryPartnerRatePriceUsd || '').replace(',', '.'));

      if (!Number.isFinite(kmFrom) || kmFrom < 0) {
        throw new Error('Km desde invÃ¡lido.');
      }
      if (kmTo != null && (!Number.isFinite(kmTo) || kmTo < kmFrom)) {
        throw new Error('Km hasta invÃ¡lido.');
      }
      if (!Number.isFinite(priceUsd) || priceUsd < 0) {
        throw new Error('Tarifa invÃ¡lida.');
      }

      const supabase = createSupabaseBrowser();
      const { data, error } = await supabase
        .from('delivery_partner_rates')
        .insert({
          partner_id: selectedDeliveryPartner.id,
          km_from: kmFrom,
          km_to: kmTo,
          price_usd: priceUsd,
          is_active: !!deliveryPartnerRateIsActive,
        })
        .select('id')
        .single();

      if (error) throw new Error(error.message);
      if (!data?.id) throw new Error('No se pudo crear la tarifa.');

      showToast('success', 'Tarifa creada.');
      setDeliveryPartnerRateCreateOpen(false);
      resetDeliveryPartnerRateForm();
      router.refresh();
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'No se pudo crear la tarifa.');
    } finally {
      setDeliveryPartnerRateSaving(false);
    }
  };

  const handleUpdateDeliveryPartnerRate = async () => {
    if (!selectedDeliveryPartnerRate) return;

    try {
      setDeliveryPartnerRateSaving(true);

      const kmFrom = Number(String(deliveryPartnerRateKmFrom || '').replace(',', '.'));
      const kmToRaw = String(deliveryPartnerRateKmTo || '').trim();
      const kmTo = kmToRaw ? Number(kmToRaw.replace(',', '.')) : null;
      const priceUsd = Number(String(deliveryPartnerRatePriceUsd || '').replace(',', '.'));

      if (!Number.isFinite(kmFrom) || kmFrom < 0) {
        throw new Error('Km desde invÃ¡lido.');
      }
      if (kmTo != null && (!Number.isFinite(kmTo) || kmTo < kmFrom)) {
        throw new Error('Km hasta invÃ¡lido.');
      }
      if (!Number.isFinite(priceUsd) || priceUsd < 0) {
        throw new Error('Tarifa invÃ¡lida.');
      }

      const supabase = createSupabaseBrowser();
      const { data, error } = await supabase
        .from('delivery_partner_rates')
        .update({
          km_from: kmFrom,
          km_to: kmTo,
          price_usd: priceUsd,
          is_active: !!deliveryPartnerRateIsActive,
        })
        .eq('id', selectedDeliveryPartnerRate.id)
        .select('id')
        .single();

      if (error) throw new Error(error.message);
      if (!data?.id) throw new Error('No se pudo actualizar la tarifa.');

      showToast('success', 'Tarifa actualizada.');
      setDeliveryPartnerRateEditOpen(false);
      resetDeliveryPartnerRateForm();
      router.refresh();
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'No se pudo actualizar la tarifa.');
    } finally {
      setDeliveryPartnerRateSaving(false);
    }
  };

  const handleToggleDeliveryPartnerRateActive = async (rate: DeliveryPartnerRate) => {
    try {
      const supabase = createSupabaseBrowser();
      const { data, error } = await supabase
        .from('delivery_partner_rates')
        .update({ is_active: !rate.isActive })
        .eq('id', rate.id)
        .select('id')
        .single();

      if (error) throw new Error(error.message);
      if (!data?.id) throw new Error('No se pudo cambiar el estado de la tarifa.');

      showToast('success', rate.isActive ? 'Tarifa desactivada.' : 'Tarifa activada.');
      router.refresh();
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'No se pudo cambiar el estado de la tarifa.');
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
  setNewInternalRiderPayUsd('');
  setNewInventoryEnabled(false);
  setNewInventoryKind('finished_good');
  setNewInventoryGroup('other');
  setNewInventoryDeductionMode('self');
  setNewInventoryUnitName('pieza');
  setNewPackagingName('');
  setNewPackagingSize('');
  setNewCurrentStockUnits('0');
  setNewLowStockThreshold('');
  setNewInventoryLinks([]);
};

const resetInventoryMovementForm = () => {
  setSelectedInventoryProductId(null);
  setInventoryMovementType('inbound');
  setInventoryMovementPackagingQty('0');
  setInventoryMovementUnitQty('0');
  setInventoryMovementReasonCode('');
  setInventoryMovementNotes('');
};

const resetInventoryItemForm = () => {
  setInventoryItemFormName('');
  setInventoryItemFormKind('raw_material');
  setInventoryItemFormGroup('other');
  setInventoryItemFormUnitName('pieza');
  setInventoryItemFormPackagingName('');
  setInventoryItemFormPackagingSize('');
  setInventoryItemFormCurrentStock('0');
  setInventoryItemFormLowStock('');
  setInventoryItemFormIsActive(true);
  setInventoryItemFormNotes('');
};

const openInventoryItemCreateDrawer = () => {
  setSelectedInventoryProductId(null);
  resetInventoryItemForm();
  setInventoryItemCreateOpen(true);
};

const openInventoryItemEditDrawer = (inventoryItemId: number) => {
  const item = inventoryItemById.get(inventoryItemId);
  if (!item) return;

  setInventoryProductionOpen(false);
  setSelectedInventoryProductId(inventoryItemId);
  setInventoryItemFormName(item.name);
  setInventoryItemFormKind(item.inventoryKind);
  setInventoryItemFormGroup(item.inventoryGroup || 'other');
  setInventoryItemFormUnitName(item.unitName || 'pieza');
  setInventoryItemFormPackagingName(item.packagingName || '');
  setInventoryItemFormPackagingSize(item.packagingSize != null ? String(item.packagingSize) : '');
  setInventoryItemFormCurrentStock(String(item.currentStockUnits ?? 0));
  setInventoryItemFormLowStock(item.lowStockThreshold != null ? String(item.lowStockThreshold) : '');
  setInventoryItemFormIsActive(!!item.isActive);
  setInventoryItemFormNotes(item.notes || '');
  setInventoryItemEditOpen(false);
  setInventoryDrawerMode('edit');
  setInventoryMovementOpen(true);
};

const resetInventoryProductionForm = () => {
  setSelectedInventoryRecipeId(null);
  setInventoryProductionBatches('1');
  setInventoryProductionNotes('');
};

const resetInventoryRecipeForm = () => {
  setInventoryRecipeFormKind('production');
  setInventoryRecipeFormOutputUnits('1');
  setInventoryRecipeFormNotes('');
  setInventoryRecipeRows([]);
};

const openInventoryRecipeEditor = (inventoryItemId: number) => {
  const item = inventoryItemById.get(inventoryItemId);
  if (!item) return;

  const recipe = (inventoryRecipesByOutputItemId.get(inventoryItemId) ?? []).find((row) => row.isActive) ?? null;
  const recipeComponents = recipe ? inventoryRecipeComponentsByRecipeId.get(recipe.id) ?? [] : [];

  setSelectedInventoryProductId(inventoryItemId);
  setSelectedInventoryRecipeId(recipe?.id ?? null);
  setInventoryRecipeFormKind(recipe?.recipeKind ?? 'production');
  setInventoryRecipeFormOutputUnits(String(recipe?.outputQuantityUnits ?? 1));
  setInventoryRecipeFormNotes(recipe?.notes ?? '');
  setInventoryRecipeRows(
    recipeComponents.map((component, index) => ({
      localId: makeLocalId(),
      inputInventoryItemId: component.inputInventoryItemId,
      quantityUnits: String(component.quantityUnits),
      sortOrder: component.sortOrder || index + 1,
    }))
  );
  setInventoryDrawerMode('recipe');
  setInventoryMovementOpen(true);
};

const addInventoryRecipeRow = () => {
  setInventoryRecipeRows((current) => [
    ...current,
    {
      localId: makeLocalId(),
      inputInventoryItemId: 0,
      quantityUnits: '',
      sortOrder: current.length + 1,
    },
  ]);
};

const updateInventoryRecipeRow = (localId: string, patch: Partial<EditableInventoryRecipeRow>) => {
  setInventoryRecipeRows((current) =>
    current.map((row) => (row.localId === localId ? { ...row, ...patch } : row))
  );
};

const removeInventoryRecipeRow = (localId: string) => {
  setInventoryRecipeRows((current) =>
    current
      .filter((row) => row.localId !== localId)
      .map((row, index) => ({ ...row, sortOrder: index + 1 }))
  );
};

const openInventoryMovementDrawer = (productId: number) => {
  setInventoryMovementType('inbound');
  setInventoryMovementPackagingQty('0');
  setInventoryMovementUnitQty('0');
  setInventoryMovementReasonCode('');
  setInventoryMovementNotes('');
  setSelectedInventoryProductId(productId);
  setInventoryItemEditOpen(false);
  setInventoryDrawerMode('movement');
  setInventoryMovementOpen(true);
};

const openInventoryProductionDrawer = (productId: number) => {
  setInventoryMovementOpen(false);
  setInventoryItemEditOpen(false);
  setSelectedInventoryProductId(productId);
  const recipes = (inventoryRecipesByOutputItemId.get(productId) ?? []).filter((recipe) => recipe.isActive);
  setSelectedInventoryRecipeId(recipes[0]?.id ?? null);
  setInventoryProductionBatches('1');
  setInventoryProductionNotes('');
  setInventoryProductionOpen(true);
};

const handleSaveInventoryRecipe = async () => {
  if (!selectedInventoryProduct) return;

  try {
    setInventoryRecipeSaving(true);

    const outputQuantityUnits = Number(String(inventoryRecipeFormOutputUnits || '').trim().replace(',', '.'));
    if (!Number.isFinite(outputQuantityUnits) || outputQuantityUnits <= 0) {
      throw new Error('La salida de la receta debe ser mayor a 0.');
    }

    const normalizedRows = inventoryRecipeRows
      .map((row, index) => ({
        inputInventoryItemId: Number(row.inputInventoryItemId || 0),
        quantityUnits: Number(String(row.quantityUnits || 0).replace(',', '.')),
        sortOrder: index + 1,
      }))
      .filter((row) => row.inputInventoryItemId > 0 && Number.isFinite(row.quantityUnits) && row.quantityUnits > 0);

    if (normalizedRows.length === 0) {
      throw new Error('Agrega al menos un insumo a la receta.');
    }

    const supabase = createSupabaseBrowser();
    let recipeId = selectedInventoryRecipeId;

    if (recipeId) {
      const { data, error } = await supabase
        .from('inventory_recipes')
        .update({
          recipe_kind: inventoryRecipeFormKind,
          output_quantity_units: outputQuantityUnits,
          notes: inventoryRecipeFormNotes.trim() || null,
          is_active: true,
        })
        .eq('id', recipeId)
        .select('id')
        .single();

      if (error) throw new Error(error.message);
      recipeId = Number(data.id);

      const { error: deleteError } = await supabase
        .from('inventory_recipe_components')
        .delete()
        .eq('recipe_id', recipeId);

      if (deleteError) throw new Error(deleteError.message);
    } else {
      const { data, error } = await supabase
        .from('inventory_recipes')
        .insert({
          output_inventory_item_id: selectedInventoryProduct.id,
          recipe_kind: inventoryRecipeFormKind,
          output_quantity_units: outputQuantityUnits,
          notes: inventoryRecipeFormNotes.trim() || null,
          is_active: true,
        })
        .select('id')
        .single();

      if (error) throw new Error(error.message);
      recipeId = Number(data.id);
    }

    const { error: insertComponentsError } = await supabase
      .from('inventory_recipe_components')
      .insert(
        normalizedRows.map((row) => ({
          recipe_id: recipeId,
          input_inventory_item_id: row.inputInventoryItemId,
          quantity_units: row.quantityUnits,
          sort_order: row.sortOrder,
        }))
      );

    if (insertComponentsError) throw new Error(insertComponentsError.message);

    showToast('success', 'Receta guardada.');
    setSelectedInventoryRecipeId(recipeId ?? null);
    setInventoryDrawerMode('movement');
    router.refresh();
  } catch (err) {
    showToast('error', err instanceof Error ? err.message : 'No se pudo guardar la receta.');
  } finally {
    setInventoryRecipeSaving(false);
  }
};

const handleCreateInventoryItem = async () => {
  try {
    setInventoryItemSaving(true);
    await createInventoryItemAction({
      name: inventoryItemFormName,
      inventoryKind: inventoryItemFormKind,
      inventoryGroup: inventoryItemFormGroup,
      unitName: inventoryItemFormUnitName,
      packagingName: inventoryItemFormPackagingName.trim() || null,
      packagingSize: inventoryItemFormPackagingSize.trim() ? Number(inventoryItemFormPackagingSize.replace(',', '.')) : null,
      currentStockUnits: Number(inventoryItemFormCurrentStock.replace(',', '.')),
      lowStockThreshold: inventoryItemFormLowStock.trim() ? Number(inventoryItemFormLowStock.replace(',', '.')) : null,
      isActive: inventoryItemFormIsActive,
      notes: inventoryItemFormNotes.trim() || null,
    });
    showToast('success', 'Item de inventario creado.');
    setInventoryItemCreateOpen(false);
    resetInventoryItemForm();
    router.refresh();
  } catch (err) {
    showToast('error', err instanceof Error ? err.message : 'No se pudo crear el item.');
  } finally {
    setInventoryItemSaving(false);
  }
};

const handleUpdateInventoryItem = async () => {
  if (!selectedInventoryProductId) return;

  try {
    setInventoryItemSaving(true);
    await updateInventoryItemAction({
      inventoryItemId: selectedInventoryProductId,
      name: inventoryItemFormName,
      inventoryKind: inventoryItemFormKind,
      inventoryGroup: inventoryItemFormGroup,
      unitName: inventoryItemFormUnitName,
      packagingName: inventoryItemFormPackagingName.trim() || null,
      packagingSize: inventoryItemFormPackagingSize.trim() ? Number(inventoryItemFormPackagingSize.replace(',', '.')) : null,
      currentStockUnits: Number(inventoryItemFormCurrentStock.replace(',', '.')),
      lowStockThreshold: inventoryItemFormLowStock.trim() ? Number(inventoryItemFormLowStock.replace(',', '.')) : null,
      isActive: inventoryItemFormIsActive,
      notes: inventoryItemFormNotes.trim() || null,
    });
    showToast('success', 'Item de inventario actualizado.');
    setInventoryItemEditOpen(false);
    setInventoryDrawerMode('movement');
    resetInventoryItemForm();
    router.refresh();
  } catch (err) {
    showToast('error', err instanceof Error ? err.message : 'No se pudo actualizar el item.');
  } finally {
    setInventoryItemSaving(false);
  }
};

const handleToggleInventoryItemActive = async (item: InventoryItem) => {
  try {
    await toggleInventoryItemActiveAction({
      inventoryItemId: item.id,
      nextIsActive: !item.isActive,
    });
    showToast('success', item.isActive ? 'Item desactivado.' : 'Item activado.');
    router.refresh();
  } catch (err) {
    showToast('error', err instanceof Error ? err.message : 'No se pudo cambiar el estado.');
  }
};

const handleCreateInventoryMovement = async () => {
  if (!selectedInventoryProduct) return;

  try {
    setInventoryMovementSaving(true);

    const packagingQty = Number(String(inventoryMovementPackagingQty || '').trim().replace(',', '.'));
    const unitQty = Number(String(inventoryMovementUnitQty || '').trim().replace(',', '.'));
    const safePackagingQty = Number.isFinite(packagingQty) ? Math.max(0, packagingQty) : 0;
    const safeUnitQty = Number.isFinite(unitQty) ? Math.max(0, unitQty) : 0;
    const quantityUnits =
      safePackagingQty * Number(selectedInventoryProduct.packagingSize || 0) + safeUnitQty;

    if (!Number.isFinite(quantityUnits) || quantityUnits < 0) {
      throw new Error('Cantidad invÃ¡lida.');
    }

    await createInventoryMovementAction({
      inventoryItemId: selectedInventoryProduct.id,
      movementType: inventoryMovementType,
      quantityUnits,
      reasonCode: inventoryMovementReasonCode.trim() || null,
      notes: inventoryMovementNotes.trim() || null,
    });

    showToast('success', 'Movimiento de inventario guardado.');
    setInventoryMovementOpen(false);
    resetInventoryMovementForm();
    router.refresh();
  } catch (err) {
    showToast('error', err instanceof Error ? err.message : 'No se pudo guardar el movimiento.');
  } finally {
    setInventoryMovementSaving(false);
  }
};

const handleCreateInventoryProduction = async () => {
  if (!selectedInventoryRecipe) return;

  try {
    setInventoryProductionSaving(true);

    const batchMultiplier = Number(String(inventoryProductionBatches || '').trim().replace(',', '.'));
    if (!Number.isFinite(batchMultiplier) || batchMultiplier <= 0) {
      throw new Error('La cantidad a producir es invÃ¡lida.');
    }

    await createInventoryProductionAction({
      recipeId: selectedInventoryRecipe.id,
      batchMultiplier,
      notes: inventoryProductionNotes.trim() || null,
    });

    showToast('success', 'ProducciÃ³n registrada.');
    setInventoryProductionOpen(false);
    resetInventoryProductionForm();
    router.refresh();
  } catch (err) {
    showToast('error', err instanceof Error ? err.message : 'No se pudo registrar la producciÃ³n.');
  } finally {
    setInventoryProductionSaving(false);
  }
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
      isInventoryItem: newInventoryEnabled,
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
      internalRiderPayUsd: newInternalRiderPayUsd.trim()
        ? Number(String(newInternalRiderPayUsd).trim().replace(',', '.'))
        : null,
      inventoryEnabled: newInventoryEnabled,
      inventoryKind: newInventoryKind,
      inventoryGroup: newInventoryGroup,
      inventoryDeductionMode: newInventoryDeductionMode,
      inventoryUnitName: newInventoryUnitName.trim() || 'pieza',
      packagingName: newPackagingName.trim() || null,
      packagingSize: newPackagingSize.trim()
        ? Number(String(newPackagingSize).trim().replace(',', '.'))
        : null,
      currentStockUnits: newCurrentStockUnits.trim()
        ? Number(String(newCurrentStockUnits).trim().replace(',', '.'))
        : 0,
      lowStockThreshold: newLowStockThreshold.trim()
        ? Number(String(newLowStockThreshold).trim().replace(',', '.'))
        : null,
      inventoryLinks: newInventoryLinks.map((row, idx) => ({
        inventoryItemId: Number(row.inventoryItemId || 0),
        quantityUnits: Number(String(row.quantityUnits || 0).trim().replace(',', '.')),
        notes: row.notes?.trim() || null,
        sortOrder: Number(row.sortOrder || idx + 1),
      })),
    });

    showToast('success', 'Ã­tem creado.');
    setCreateCatalogOpen(false);
    resetCreateCatalogForm();
    router.refresh();

    if (result?.id) {
      setSelectedCatalogItemId(result.id);
      setCatalogDetailOpen(true);
      setCatalogEditMode(true);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Error creando Ã­tem.';
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

    showToast('success', nextIsActive ? 'Ã­tem activado.' : 'Ã­tem desactivado.');
    router.refresh();
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Error cambiando estado del Ã­tem.';
    showToast('error', message);
  }
};

const handleDeleteCatalogItem = async () => {
  if (!selectedCatalogItem) return;

  const confirmed = window.confirm(
    `Â¿Seguro que deseas eliminar "${selectedCatalogItem.name}"?\n\nEsto solo funcionarÃ¡ si no tiene uso ni dependencias.`
  );

  if (!confirmed) return;

  try {
    await deleteCatalogItemAction({
      productId: selectedCatalogItem.id,
    });

    showToast('success', 'Ã­tem eliminado.');
    setCatalogDetailOpen(false);
    setSelectedCatalogItemId(null);
    router.refresh();
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Error eliminando Ã­tem.';
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

  const addNewInventoryLink = () => {
    setNewInventoryLinks((prev) => [
      ...prev,
        {
          localId: `new-link-${Date.now()}-${Math.random()}`,
          inventoryItemId: inventoryItems.find((item) => item.isActive)?.id ?? 0,
          quantityUnits: '1',
          sortOrder: prev.length + 1,
          notes: '',
        },
    ]);
  };

  const updateNewInventoryLink = (localId: string, patch: Partial<EditableInventoryLinkRow>) => {
    setNewInventoryLinks((prev) => prev.map((row) => (row.localId === localId ? { ...row, ...patch } : row)));
  };

  const removeNewInventoryLink = (localId: string) => {
    setNewInventoryLinks((prev) =>
      prev
        .filter((row) => row.localId !== localId)
        .map((row, idx) => ({ ...row, sortOrder: idx + 1 }))
    );
  };

  const addEditInventoryLink = () => {
    setEditInventoryLinks((prev) => [
      ...prev,
        {
          localId: `edit-link-${Date.now()}-${Math.random()}`,
          inventoryItemId: inventoryItems.find((item) => item.isActive)?.id ?? 0,
          quantityUnits: '1',
          sortOrder: prev.length + 1,
          notes: '',
        },
    ]);
  };

  const updateEditInventoryLink = (localId: string, patch: Partial<EditableInventoryLinkRow>) => {
    setEditInventoryLinks((prev) => prev.map((row) => (row.localId === localId ? { ...row, ...patch } : row)));
  };

  const removeEditInventoryLink = (localId: string) => {
    setEditInventoryLinks((prev) =>
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

const handleApplyClientAddress = (address: ClientAddress, index?: number | null) => {
  setCreateOrderDeliveryAddress(address.addressText);
  setCreateOrderDeliveryGpsUrl(address.gpsUrl);
  setCreateOrderSelectedAddressIndex(index ?? null);
};

const applyCreateOrderAsap = () => {
  const target = new Date(Date.now() + 15 * 60 * 1000);
  target.setSeconds(0, 0);

  const year = target.getFullYear();
  const month = String(target.getMonth() + 1).padStart(2, '0');
  const day = String(target.getDate()).padStart(2, '0');
  let hour24 = target.getHours();
  const minute = String(target.getMinutes()).padStart(2, '0');
  const ampm: 'AM' | 'PM' = hour24 >= 12 ? 'PM' : 'AM';
  let hour12 = hour24 % 12;
  if (hour12 === 0) hour12 = 12;

  setCreateOrderDeliveryDate(`${year}-${month}-${day}`);
  setCreateOrderDeliveryHour12(String(hour12));
  setCreateOrderDeliveryMinute(minute);
  setCreateOrderDeliveryAmPm(ampm);
  setCreateOrderIsAsap(true);
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
      showToast('error', 'Debes colocar el telÃ©fono del cliente.');
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
      fundBalanceUsd: 0,
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
        ? 'Ese cliente ya existÃ­a y fue seleccionado.'
        : 'Cliente creado.'
    );
    return;

  } catch (err) {
    const message = err instanceof Error ? err.message : 'Error creando cliente.';
    showToast('error', message);
  }
};

const openCreateOrderConfig = (product: CatalogItem, qty: number) => {
  const productConfigComponents = productComponents.filter((pc) => pc.parentProductId === product.id);
  const optionalFixedSelections = productConfigComponents
    .filter((pc) => pc.componentMode === 'fixed' && !pc.isRequired && Number(pc.quantity || 0) > 0)
    .map((pc) => ({
      localId: `fixed-${pc.componentProductId}`,
      componentProductId: pc.componentProductId,
      componentName: pc.componentName,
      qty: Number(pc.quantity || 0),
    }));

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
  setCreateOrderConfigSelections(optionalFixedSelections);
  setCreateOrderConfigAlias('');
  setCreateOrderConfigOpen(true);
};

const openEditCreateOrderConfig = (draftItem: DraftItem) => {
  const product = catalogItems.find((item) => item.id === draftItem.productId);

  if (!product) {
    showToast('error', 'No se pudo encontrar el producto base para reconfigurar este Ã­tem.');
    return;
  }

  const editableOptions = productComponents.filter(
    (pc) =>
      pc.parentProductId === product.id &&
      (pc.componentMode === 'selectable' || (pc.componentMode === 'fixed' && !pc.isRequired))
  );

  const parsed = parseEditableDetailLines(draftItem.editableDetailLines);

  const nextSelections: DraftEditableSelection[] = parsed.selections
    .map((parsedRow) => {
      const matchingOption =
        (parsedRow.componentProductId != null
          ? editableOptions.find((option) => option.componentProductId === parsedRow.componentProductId)
          : null) ??
        editableOptions.find(
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

  const productConfigComponents = componentsByParentId.get(product.id) ?? [];

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
    editableDetailLines: buildComponentDetailLines(productConfigComponents, {
      totalMultiplier: createOrderQty,
    }),
    adminPriceOverrideUsd: null,
    adminPriceOverrideReason: null,
    adminPriceOverrideByUserId: null,
    adminPriceOverrideAt: null,
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
  const productConfigComponents = componentsByParentId.get(createOrderConfigProductId) ?? [];
  const selectedByProductId = new Map(
    createOrderConfigSelections
      .filter((x) => x.qty > 0)
      .map((x) => [x.componentProductId, x.qty] as const)
  );

  if (createOrderConfigAlias.trim()) {
    detailLines.push(`Para: ${createOrderConfigAlias.trim()}`);
  }

  detailLines.push(
    ...buildComponentDetailLines(productConfigComponents, {
      selectedByProductId,
      includeMetadata: true,
    })
  );

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
  adminPriceOverrideUsd: null,
  adminPriceOverrideReason: null,
  adminPriceOverrideByUserId: null,
  adminPriceOverrideAt: null,
};

  const existingEditingItem = createOrderConfigEditingLocalId
    ? createOrderDraftItems.find((item) => item.localId === createOrderConfigEditingLocalId) ?? null
    : null;

  if (existingEditingItem) {
    nextItem.adminPriceOverrideUsd = existingEditingItem.adminPriceOverrideUsd;
    nextItem.adminPriceOverrideReason = existingEditingItem.adminPriceOverrideReason;
    nextItem.adminPriceOverrideByUserId = existingEditingItem.adminPriceOverrideByUserId ?? null;
    nextItem.adminPriceOverrideAt = existingEditingItem.adminPriceOverrideAt ?? null;
    nextItem.lineTotalUsd =
      (existingEditingItem.adminPriceOverrideUsd != null
        ? existingEditingItem.adminPriceOverrideUsd
        : createOrderConfigUnitPriceUsd) * createOrderConfigQty;
  }

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

    if (createOrderUseClientFund && createOrderAppliedFundUsd <= 0.005) {
      showToast('error', 'El monto a aplicar del fondo no es vÃ¡lido.');
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
      isAsap: createOrderIsAsap,
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
      useClientFund: createOrderUseClientFund,
      clientFundAmountUsd: createOrderUseClientFund ? String(createOrderAppliedFundUsd) : '',
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
  adminPriceOverrideUsd: item.adminPriceOverrideUsd,
  adminPriceOverrideReason: item.adminPriceOverrideReason,
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

    if (createOrderUseClientFund && createOrderAppliedFundUsd <= 0.005) {
      showToast('error', 'El monto a aplicar del fondo no es vÃ¡lido.');
      return;
    }

    const isAdvancedAdminEdit =
      isAdmin &&
      !!selectedOrder &&
      !['created', 'queued'].includes(selectedOrder.status);

    if (isAdvancedAdminEdit && !adminEditReason.trim()) {
      showToast('error', 'Debes indicar el motivo de la modificaciÃ³n administrativa.');
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
      isAsap: createOrderIsAsap,
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
      useClientFund: createOrderUseClientFund,
      clientFundAmountUsd: createOrderUseClientFund ? String(createOrderAppliedFundUsd) : '',
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
  adminPriceOverrideUsd: item.adminPriceOverrideUsd,
  adminPriceOverrideReason: item.adminPriceOverrideReason,
})),
      adminEditReason: isAdvancedAdminEdit ? adminEditReason.trim() : null,
    });

    showToast('success', `Orden actualizada #${editingOrderId}.`);
    setCreateOrderOpen(false);
    setEditingOrderId(null);
    setOrderEditorMode('create');
    setAdminEditReason('');
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
            lineTotalUsd:
              (item.adminPriceOverrideUsd != null
                ? item.adminPriceOverrideUsd
                : item.unitPriceUsdSnapshot) * nextQty,
          }
        : item
    )
  );
};

const openAdjustCreateOrderItemPrice = (item: DraftItem) => {
  if (!isAdmin) return;

  setPriceAdjustItemLocalId(item.localId);
  setPriceAdjustValue(
    item.adminPriceOverrideUsd != null
      ? String(item.adminPriceOverrideUsd)
      : String(item.unitPriceUsdSnapshot)
  );
  setPriceAdjustReason(item.adminPriceOverrideReason || '');
  setPriceAdjustOpen(true);
};

const handleSaveAdjustedCreateOrderItemPrice = () => {
  if (!isAdmin || !priceAdjustItemLocalId) return;

  const nextUnitUsd = Number(String(priceAdjustValue || '').replace(',', '.'));
  if (!Number.isFinite(nextUnitUsd) || nextUnitUsd < 0) {
    showToast('error', 'El precio ajustado es invÃ¡lido.');
    return;
  }

  if (!priceAdjustReason.trim()) {
    showToast('error', 'Debes indicar el motivo del ajuste.');
    return;
  }

  setCreateOrderDraftItems((prev) =>
    prev.map((item) =>
      item.localId === priceAdjustItemLocalId
        ? {
            ...item,
            adminPriceOverrideUsd: nextUnitUsd,
            adminPriceOverrideReason: priceAdjustReason.trim(),
            adminPriceOverrideByUserId: currentUser.id,
            adminPriceOverrideAt: new Date().toISOString(),
            lineTotalUsd: nextUnitUsd * Number(item.qty || 0),
          }
        : item
    )
  );

  resetPriceAdjustBox();
};

const handleClearAdjustedCreateOrderItemPrice = (localId: string) => {
  if (!isAdmin) return;

  setCreateOrderDraftItems((prev) =>
    prev.map((item) =>
      item.localId === localId
        ? {
            ...item,
            adminPriceOverrideUsd: null,
            adminPriceOverrideReason: null,
            adminPriceOverrideByUserId: null,
            adminPriceOverrideAt: null,
            lineTotalUsd: item.unitPriceUsdSnapshot * Number(item.qty || 0),
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
  const lineTotalUsd = Number(item.lineTotalUsd || 0);

  return sum + lineTotalUsd;
}, 0);

const createOrderDraftSubtotalBs = createOrderDraftItems.reduce((sum, item) => {
  const lineTotalBs =
    item.adminPriceOverrideUsd != null
      ? Number(item.lineTotalUsd || 0) * createOrderFxRateNumber
      : item.sourcePriceCurrency === 'VES'
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

const createOrderHasDeliveryChargeItem =
  createOrderFulfillment === 'pickup' ||
  createOrderDraftItems.some((item) => {
    const product = catalogItems.find((catalogItem) => catalogItem.id === item.productId);
    return isDeliveryCatalogItem(product) || String(item.productNameSnapshot || '').trim().toLowerCase().includes('delivery');
  });

const selectedPaymentReportAccount =
  moneyAccounts.filter((a) => a.isActive).find((a) => a.id === Number(paymentReportMoneyAccountId)) ?? null;

const selectedConfirmPaymentReport =
  selectedOrder?.paymentReports.find((report) => report.id === paymentConfirmReportId) ?? null;

const selectedConfirmPaymentExcessUsd =
  selectedOrder && selectedConfirmPaymentReport
    ? Number(
        Math.max(
          0,
          selectedOrder.confirmedPaidUsd + selectedConfirmPaymentReport.usdEquivalent - selectedOrder.totalUsd
        ).toFixed(2)
      )
    : 0;

const selectedConfirmChangeAccount =
  moneyAccounts.find((account) => account.id === Number(paymentConfirmChangeMoneyAccountId || 0)) ?? null;

const selectedGiveChangeAccount =
  moneyAccounts.find((account) => account.id === Number(paymentGiveChangeMoneyAccountId || 0)) ?? null;

const selectedMovementAccount =
  moneyAccounts.find((account) => account.id === Number(movementMoneyAccountId || 0)) ?? null;

const activeBsRate = Number(activeExchangeRate?.rateBsPerUsd ?? 0);

const getSuggestedAccountAmount = (usdAmount: number, currencyCode: string | null | undefined) => {
  if (!Number.isFinite(usdAmount) || usdAmount <= 0) return '';

  if (currencyCode === 'VES' && activeBsRate > 0) {
    return String(Number((usdAmount * activeBsRate).toFixed(2)));
  }

  return String(Number(usdAmount.toFixed(2)));
};

const selectedOrderClient =
  selectedOrder && selectedOrder.clientId != null
    ? clients.find((client) => client.id === selectedOrder.clientId) ?? null
    : null;

const selectedOrderClientFundAvailableUsd = Math.max(
  0,
  Number(selectedOrderClient?.fundBalanceUsd ?? 0)
);

const selectedOrderChangeMovements = useMemo(() => {
  if (!selectedOrder) return [];

  return moneyMovements
    .filter(
      (movement) =>
        movement.orderId === selectedOrder.id &&
        movement.direction === 'outflow' &&
        movement.movementType === 'change_given'
    )
    .sort((a, b) => {
      const aDate = new Date(a.confirmedAt || a.createdAt).getTime();
      const bDate = new Date(b.confirmedAt || b.createdAt).getTime();
      return bDate - aDate;
    });
}, [moneyMovements, selectedOrder]);

  const selectedAccount = useMemo(
    () => moneyAccounts.find((account) => account.id === selectedAccountId) ?? null,
    [moneyAccounts, selectedAccountId]
  );

  const selectedDeliveryPartner = useMemo(
    () => deliveryPartners.find((partner) => partner.id === selectedDeliveryPartnerId) ?? null,
    [deliveryPartners, selectedDeliveryPartnerId]
  );

  const selectedDeliveryPartnerRate = useMemo(
    () =>
      selectedDeliveryPartner?.rates.find((rate) => rate.id === selectedDeliveryPartnerRateId) ??
      null,
    [selectedDeliveryPartner, selectedDeliveryPartnerRateId]
  );

  const selectedAssignDeliveryPartner = useMemo(
    () =>
      deliveryPartners.find((partner) => partner.id === Number(deliveryAssignPartnerId || 0)) ??
      null,
    [deliveryAssignPartnerId, deliveryPartners]
  );

  const deliveryAssignSuggestedRate = useMemo(() => {
    const distanceKm = Number(String(deliveryAssignDistanceKm || '').replace(',', '.'));
    return findDeliveryPartnerRate(selectedAssignDeliveryPartner, distanceKm);
  }, [deliveryAssignDistanceKm, selectedAssignDeliveryPartner]);

  useEffect(() => {
    if (deliveryAssignMode !== 'external') return;
    if (deliveryAssignCostManuallyEdited) return;

    if (deliveryAssignSuggestedRate) {
      setDeliveryAssignCostUsd(String(deliveryAssignSuggestedRate.priceUsd));
      return;
    }

    setDeliveryAssignCostUsd('');
  }, [deliveryAssignCostManuallyEdited, deliveryAssignMode, deliveryAssignSuggestedRate]);

  const selectedClient = useMemo(
    () => clients.find((client) => client.id === selectedClientId) ?? null,
    [clients, selectedClientId]
  );

const selectedCreateOrderClient = useMemo(
  () => clients.find((client) => client.id === createOrderSelectedClientId) ?? null,
  [clients, createOrderSelectedClientId]
);

const selectedCreateOrderClientAddresses = useMemo(
  () => normalizeClientAddresses(selectedCreateOrderClient?.recentAddresses ?? []),
  [selectedCreateOrderClient]
);

  const createOrderExistingAppliedFundUsd =
    orderEditorMode === 'edit' &&
    selectedOrder &&
    selectedCreateOrderClient &&
    selectedOrder.clientId === selectedCreateOrderClient.id
      ? Number(selectedOrder.editMeta?.clientFundUsedUsd ?? 0)
      : 0;

  const createOrderClientFundAvailableUsd = Math.max(
    0,
    Number(selectedCreateOrderClient?.fundBalanceUsd ?? 0) + createOrderExistingAppliedFundUsd
  );

  const createOrderClientFundRequestedUsd = Number(
    String(createOrderClientFundAmountUsd || '').replace(',', '.')
  ) || 0;

  const createOrderAppliedFundUsd = createOrderUseClientFund
    ? Math.max(
        0,
        Math.min(
          Number(createOrderDraftTotalUsd.toFixed(2)),
          Number(createOrderClientFundAvailableUsd.toFixed(2)),
          Number(createOrderClientFundRequestedUsd.toFixed(2))
        )
      )
    : 0;

  const createOrderRemainingAfterFundUsd = Math.max(
    0,
    Number((createOrderDraftTotalUsd - createOrderAppliedFundUsd).toFixed(2))
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
    const hasClientSearch = clientSearch.trim().length > 0;
    const base = {
      total: hasClientSearch ? filteredClients.length : Math.max(0, Number(clientTotalCount ?? filteredClients.length)),
      active: hasClientSearch ? 0 : Math.max(0, Number(clientActiveCount ?? 0)),
      withBilling: 0,
      withDeliveryNote: 0,
      withAddresses: 0,
    };

    for (const client of filteredClients) {
      if (hasClientSearch && client.isActive) base.active += 1;
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
  }, [clientActiveCount, clientSearch, clientTotalCount, filteredClients]);

  const advisorNameById = useMemo(() => {
    return new Map(advisors.map((advisor) => [advisor.userId, advisor.fullName]));
  }, [advisors]);

  const driverNameById = useMemo(() => {
    return new Map(drivers.map((driver) => [driver.id, driver.fullName]));
  }, [drivers]);

  const deliveryPartnerNameById = useMemo(() => {
    return new Map(deliveryPartners.map((partner) => [partner.id, partner.name]));
  }, [deliveryPartners]);

  const clientById = useMemo(() => {
    return new Map(clients.map((client) => [client.id, client]));
  }, [clients]);

  const catalogItemById = useMemo(() => {
    return new Map(catalogItems.map((item) => [item.id, item]));
  }, [catalogItems]);

  const filteredInventoryItems = useMemo(() => {
    const term = inventorySearch.trim().toLowerCase();
    return inventoryItems.filter((item) => {
      const matchesGroup = !inventoryGroupFilter || item.inventoryGroup === inventoryGroupFilter;
      const matchesTerm =
        !term ||
        item.name.toLowerCase().includes(term) ||
        item.inventoryKind.toLowerCase().includes(term) ||
        INVENTORY_GROUP_LABEL[item.inventoryGroup].toLowerCase().includes(term);
      return matchesGroup && matchesTerm;
    });
  }, [inventoryItems, inventorySearch, inventoryGroupFilter]);

  const selectedInventoryProduct = useMemo(
    () => inventoryItems.find((item) => item.id === selectedInventoryProductId) ?? null,
    [inventoryItems, selectedInventoryProductId]
  );

  const inventoryItemById = useMemo(() => {
    return new Map(inventoryItems.map((item) => [item.id, item]));
  }, [inventoryItems]);

  const inventoryItemByName = useMemo(() => {
    return new Map(inventoryItems.map((item) => [item.name.trim().toLowerCase(), item]));
  }, [inventoryItems]);

  const inventoryRecipesByOutputItemId = useMemo(() => {
    const map = new Map<number, InventoryRecipeItem[]>();
    for (const recipe of inventoryRecipes) {
      const list = map.get(recipe.outputInventoryItemId) ?? [];
      list.push(recipe);
      map.set(recipe.outputInventoryItemId, list);
    }
    return map;
  }, [inventoryRecipes]);

  const inventoryRecipeComponentsByRecipeId = useMemo(() => {
    const map = new Map<number, InventoryRecipeComponentItem[]>();
    for (const component of inventoryRecipeComponents) {
      const list = map.get(component.recipeId) ?? [];
      list.push(component);
      map.set(component.recipeId, list);
    }
    for (const list of map.values()) {
      list.sort((a, b) => a.sortOrder - b.sortOrder);
    }
    return map;
  }, [inventoryRecipeComponents]);

  const selectedInventoryRecipes = useMemo(
    () =>
      selectedInventoryProduct
        ? (inventoryRecipesByOutputItemId.get(selectedInventoryProduct.id) ?? []).filter((recipe) => recipe.isActive)
        : [],
    [selectedInventoryProduct, inventoryRecipesByOutputItemId]
  );

  const selectedInventoryRecipe = useMemo(
    () =>
      selectedInventoryRecipes.find((recipe) => recipe.id === selectedInventoryRecipeId) ??
      selectedInventoryRecipes[0] ??
      null,
    [selectedInventoryRecipes, selectedInventoryRecipeId]
  );

  const selectedInventoryRecipeComponents = useMemo(
    () =>
      selectedInventoryRecipe
        ? inventoryRecipeComponentsByRecipeId.get(selectedInventoryRecipe.id) ?? []
        : [],
    [selectedInventoryRecipe, inventoryRecipeComponentsByRecipeId]
  );

  const inventoryAvailabilityByItemId = useMemo(() => {
    const cache = new Map<number, { readyUnits: number; potentialUnits: number; totalUnits: number }>();

    const compute = (itemId: number, stack = new Set<number>()) => {
      if (cache.has(itemId)) return cache.get(itemId)!;

      const item = inventoryItemById.get(itemId);
      if (!item) {
        const fallback = { readyUnits: 0, potentialUnits: 0, totalUnits: 0 };
        cache.set(itemId, fallback);
        return fallback;
      }

      if (stack.has(itemId)) {
        const cycleFallback = {
          readyUnits: item.currentStockUnits,
          potentialUnits: 0,
          totalUnits: item.currentStockUnits,
        };
        cache.set(itemId, cycleFallback);
        return cycleFallback;
      }

      const activeRecipe = (inventoryRecipesByOutputItemId.get(itemId) ?? []).find((recipe) => recipe.isActive) ?? null;
      if (!activeRecipe) {
        const direct = {
          readyUnits: item.currentStockUnits,
          potentialUnits: 0,
          totalUnits: item.currentStockUnits,
        };
        cache.set(itemId, direct);
        return direct;
      }

      const components = inventoryRecipeComponentsByRecipeId.get(activeRecipe.id) ?? [];
      if (components.length === 0 || activeRecipe.outputQuantityUnits <= 0) {
        const direct = {
          readyUnits: item.currentStockUnits,
          potentialUnits: 0,
          totalUnits: item.currentStockUnits,
        };
        cache.set(itemId, direct);
        return direct;
      }

      const nextStack = new Set(stack);
      nextStack.add(itemId);

      let maxBatches = Number.POSITIVE_INFINITY;
      for (const component of components) {
        if (component.quantityUnits <= 0) continue;
        const availableInput = compute(component.inputInventoryItemId, nextStack).totalUnits;
        maxBatches = Math.min(maxBatches, availableInput / component.quantityUnits);
      }

      const safeBatches = Number.isFinite(maxBatches) && maxBatches > 0 ? maxBatches : 0;
      const potentialUnits = safeBatches * activeRecipe.outputQuantityUnits;
      const result = {
        readyUnits: item.currentStockUnits,
        potentialUnits,
        totalUnits: item.currentStockUnits + potentialUnits,
      };
      cache.set(itemId, result);
      return result;
    };

    for (const item of inventoryItems) {
      compute(item.id);
    }

    return cache;
  }, [inventoryItemById, inventoryItems, inventoryRecipeComponentsByRecipeId, inventoryRecipesByOutputItemId]);

  const inventoryMovementsByItemId = useMemo(() => {
    const map = new Map<number, InventoryMovementItem[]>();
    for (const movement of inventoryMovements) {
      const list = map.get(movement.inventoryItemId) ?? [];
      list.push(movement);
      map.set(movement.inventoryItemId, list);
    }
    return map;
  }, [inventoryMovements]);

  const inventorySummary = useMemo(() => {
    return {
      totalItems: inventoryItems.length,
      lowStock: inventoryItems.filter(
        (item) =>
          item.lowStockThreshold != null &&
          (inventoryAvailabilityByItemId.get(item.id)?.totalUnits ?? item.currentStockUnits) <= item.lowStockThreshold
      ).length,
      raw: inventoryItems.filter((item) => item.inventoryKind === 'raw_material').length,
      bases: inventoryItems.filter((item) => item.inventoryKind === 'prepared_base').length,
    };
  }, [inventoryAvailabilityByItemId, inventoryItems]);

  const productAvailabilityById = useMemo(() => {
    const map = new Map<number, { readyUnits: number; potentialUnits: number; totalUnits: number }>();

    for (const product of catalogItems) {
      if (!product.inventoryEnabled) continue;

      if (product.inventoryDeductionMode === 'composition') {
        const links = productInventoryLinksByProductId.get(product.id) ?? [];
        if (links.length === 0) continue;

        let readyUnits = Number.POSITIVE_INFINITY;
        let totalUnits = Number.POSITIVE_INFINITY;

        for (const link of links) {
          if (link.inventoryItemId <= 0 || link.quantityUnits <= 0) continue;
          const availability = inventoryAvailabilityByItemId.get(link.inventoryItemId);
          if (!availability) continue;
          readyUnits = Math.min(readyUnits, availability.readyUnits / link.quantityUnits);
          totalUnits = Math.min(totalUnits, availability.totalUnits / link.quantityUnits);
        }

        const safeReady = Number.isFinite(readyUnits) && readyUnits > 0 ? readyUnits : 0;
        const safeTotal = Number.isFinite(totalUnits) && totalUnits > 0 ? totalUnits : 0;
        map.set(product.id, {
          readyUnits: safeReady,
          potentialUnits: Math.max(0, safeTotal - safeReady),
          totalUnits: safeTotal,
        });
        continue;
      }

      const selfItem = inventoryItemByName.get(product.name.trim().toLowerCase());
      if (!selfItem) continue;
      const availability = inventoryAvailabilityByItemId.get(selfItem.id) ?? {
        readyUnits: selfItem.currentStockUnits,
        potentialUnits: 0,
        totalUnits: selfItem.currentStockUnits,
      };
      map.set(product.id, availability);
    }

    return map;
  }, [
    catalogItems,
    inventoryAvailabilityByItemId,
    inventoryItemByName,
    productInventoryLinksByProductId,
  ]);

  const orderLookupById = useMemo(() => {
    return new Map(orders.map((order) => [order.id, order]));
  }, [orders]);

  const deliveredOrders = useMemo(
    () => orders.filter((order) => order.status === 'delivered'),
    [orders]
  );

  const settingsAdjustmentsRows = useMemo(() => {
    return orders
      .flatMap((order) =>
        (order.adminAdjustments ?? []).map((adjustment) => {
          const payload = adjustment.payload ?? {};
          const deltaUsd = Number(payload.delta_usd ?? 0);
          const originalUnitUsd = Number(payload.original_unit_price_usd ?? 0);
          const overrideUnitUsd = Number(payload.override_unit_price_usd ?? 0);
          const qty = Number(payload.qty ?? 0);
          const productName =
            typeof payload.product_name === 'string' && payload.product_name.trim()
              ? payload.product_name
              : 'Ã­tem';
          const changedFields = getAdjustmentChangedFields(payload);
          const changedFieldLabels = changedFields.map(mapAdjustmentFieldLabel);

          return {
            id: adjustment.id,
            orderId: order.id,
            orderNumber: fmtShortOrderLabel(order.id),
            clientName: order.clientName,
            createdAt: adjustment.createdAt,
            createdByUserId: adjustment.createdByUserId,
            createdByName: adjustment.createdByName,
            adjustmentType: adjustment.adjustmentType,
            reason: adjustment.reason,
            notes: adjustment.notes,
            deltaUsd,
            originalUnitUsd,
            overrideUnitUsd,
            qty,
            productName,
            changedFields,
            changedFieldLabels,
            adjustmentKind: typeof payload.kind === 'string' ? payload.kind : '',
          };
        })
      )
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }, [orders]);

  const adjustmentAdminOptions = useMemo(() => {
    return Array.from(
      new Map(
        settingsAdjustmentsRows.map((row) => [
          row.createdByUserId,
          row.createdByName || row.createdByUserId,
        ])
      ).entries()
    ).map(([value, label]) => ({ value, label }));
  }, [settingsAdjustmentsRows]);

  const adjustmentTypeOptions = useMemo(() => {
    return Array.from(new Set(settingsAdjustmentsRows.map((row) => row.adjustmentType)))
      .filter(Boolean)
      .sort();
  }, [settingsAdjustmentsRows]);

  const filteredSettingsAdjustments = useMemo(() => {
    return settingsAdjustmentsRows.filter((row) => {
      const day = String(row.createdAt || '').slice(0, 10);

      if (adjustmentsDateFrom && day < adjustmentsDateFrom) return false;
      if (adjustmentsDateTo && day > adjustmentsDateTo) return false;
      if (adjustmentsAdminFilter && row.createdByUserId !== adjustmentsAdminFilter) return false;
      if (adjustmentsTypeFilter && row.adjustmentType !== adjustmentsTypeFilter) return false;

      return true;
    });
  }, [
    settingsAdjustmentsRows,
    adjustmentsDateFrom,
    adjustmentsDateTo,
    adjustmentsAdminFilter,
    adjustmentsTypeFilter,
  ]);

  const adjustmentsSummary = useMemo(() => {
    const summary = {
      total: filteredSettingsAdjustments.length,
      netUsd: 0,
      negativeUsd: 0,
      positiveUsd: 0,
      priceOverrides: 0,
    };

    for (const row of filteredSettingsAdjustments) {
      summary.netUsd += row.deltaUsd;
      if (row.deltaUsd < 0) summary.negativeUsd += Math.abs(row.deltaUsd);
      if (row.deltaUsd > 0) summary.positiveUsd += row.deltaUsd;
      if (row.adjustmentType === 'item_price_override') summary.priceOverrides += 1;
    }

    return summary;
  }, [filteredSettingsAdjustments]);

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
    const baseCommissionPct = Math.max(0, Number(String(advisorCalcBasePct || '0').replace(',', '.')) || 0);

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

    const commissionOrders = filteredDeliveredOrders.map((order) => {
      const items = order.draftItems ?? [];
      const commissionableSubtotalUsd = getOrderCommissionableSubtotalUsd(order);
      const discountFactor = getOrderDiscountFactor(order);
      const fixedOrderItems = items
        .map((item) => ({
          item,
          product: catalogItemById.get(item.productId),
        }))
        .filter((row) => row.product?.commissionMode === 'fixed_order' && row.product.commissionValue != null);

      if (fixedOrderItems.length > 0) {
        const selectedRule = fixedOrderItems.reduce((best, current) =>
          (Number(current.product?.commissionValue || 0) > Number(best.product?.commissionValue || 0) ? current : best)
        );
        const pct = Number(selectedRule.product?.commissionValue || 0);
        return {
          orderId: order.id,
          commissionableSubtotalUsd,
          commissionUsd: commissionableSubtotalUsd * (pct / 100),
          fixedItemBaseUsd: 0,
          fixedOrderBaseUsd: commissionableSubtotalUsd,
          defaultBaseUsd: 0,
          mode: 'fixed_order' as const,
          appliedPct: pct,
        };
      }

      let fixedItemCommissionUsd = 0;
      let fixedItemBaseUsd = 0;
      let defaultBaseUsd = 0;

      for (const item of items) {
        const product = catalogItemById.get(item.productId);
        const itemBaseUsd = Math.max(0, Number(item.lineTotalUsd || 0) * discountFactor);
        if (product?.commissionMode === 'fixed_item' && product.commissionValue != null) {
          fixedItemBaseUsd += itemBaseUsd;
          fixedItemCommissionUsd += itemBaseUsd * (Number(product.commissionValue) / 100);
        } else {
          defaultBaseUsd += itemBaseUsd;
        }
      }

      if (items.length === 0) {
        defaultBaseUsd = commissionableSubtotalUsd;
      }

      return {
        orderId: order.id,
        commissionableSubtotalUsd,
        commissionUsd: fixedItemCommissionUsd + defaultBaseUsd * (baseCommissionPct / 100),
        fixedItemBaseUsd,
        fixedOrderBaseUsd: 0,
        defaultBaseUsd,
        mode: fixedItemCommissionUsd > 0 ? ('mixed' as const) : ('default' as const),
        appliedPct: baseCommissionPct,
      };
    });

    const commissionByOrderId = new Map(commissionOrders.map((row) => [row.orderId, row]));
    const commissionTotalUsd = commissionOrders.reduce((sum, row) => sum + row.commissionUsd, 0);

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
      commissionBasePct: baseCommissionPct,
      commissionOrders,
      commissionByOrderId,
      commissionTotalUsd,
    };
  }, [
    advisorCalcBasePct,
    advisorCalcSource,
    advisorCalcAdvisorId,
    advisorCalcRange,
    catalogItemById,
    clientById,
    deliveredOrderMovementsByOrderId,
    deliveredOrders,
    firstDeliveredOrderByClientId,
  ]);

  const commissionCalculatedData = useMemo(() => {
    const { start, end } = advisorCalcRange;
    const selectedAdvisorId = advisorCalcAdvisorId || null;
    const baseCommissionPct = Math.max(0, Number(String(advisorCalcBasePct || '0').replace(',', '.')) || 0);

    const filteredAdvisorOrders = deliveredOrders.filter((order) => {
      if (order.source !== 'advisor') return false;
      if (!order.attributedAdvisorUserId) return false;
      if (selectedAdvisorId && order.attributedAdvisorUserId !== selectedAdvisorId) return false;

      const deliveryTime = new Date(order.deliveryAtISO).getTime();
      if (start && deliveryTime < start.getTime()) return false;
      if (end && deliveryTime > end.getTime()) return false;
      return true;
    });

    const rows = filteredAdvisorOrders.map((order) => {
      const items = order.draftItems ?? [];
      const commissionableSubtotalUsd = getOrderCommissionableSubtotalUsd(order);
      const discountFactor = getOrderDiscountFactor(order);
      const fixedOrderItems = items
        .map((item) => ({
          item,
          product: catalogItemById.get(item.productId),
        }))
        .filter((row) => row.product?.commissionMode === 'fixed_order' && row.product.commissionValue != null);

      if (fixedOrderItems.length > 0) {
        const selectedRule = fixedOrderItems.reduce((best, current) =>
          (Number(current.product?.commissionValue || 0) > Number(best.product?.commissionValue || 0) ? current : best)
        );
        const pct = Number(selectedRule.product?.commissionValue || 0);

        return {
          order,
          commissionableSubtotalUsd,
          regularBaseUsd: 0,
          fixedItemBaseUsd: 0,
          fixedOrderBaseUsd: commissionableSubtotalUsd,
          fixedItemCommissionUsd: 0,
          fixedOrderCommissionUsd: commissionableSubtotalUsd * (pct / 100),
          baseCommissionUsd: 0,
          totalCommissionUsd: commissionableSubtotalUsd * (pct / 100),
          fixedOrderPct: pct,
          mode: 'fixed_order' as const,
        };
      }

      let fixedItemBaseUsd = 0;
      let fixedItemCommissionUsd = 0;
      let regularBaseUsd = 0;

      for (const item of items) {
        const product = catalogItemById.get(item.productId);
        const itemBaseUsd = Math.max(0, Number(item.lineTotalUsd || 0) * discountFactor);
        if (product?.commissionMode === 'fixed_item' && product.commissionValue != null) {
          fixedItemBaseUsd += itemBaseUsd;
          fixedItemCommissionUsd += itemBaseUsd * (Number(product.commissionValue) / 100);
        } else {
          regularBaseUsd += itemBaseUsd;
        }
      }

      if (items.length === 0) {
        regularBaseUsd = commissionableSubtotalUsd;
      }

      const baseCommissionUsd = regularBaseUsd * (baseCommissionPct / 100);

      return {
        order,
        commissionableSubtotalUsd,
        regularBaseUsd,
        fixedItemBaseUsd,
        fixedOrderBaseUsd: 0,
        fixedItemCommissionUsd,
        fixedOrderCommissionUsd: 0,
        baseCommissionUsd,
        totalCommissionUsd: baseCommissionUsd + fixedItemCommissionUsd,
        fixedOrderPct: null,
        mode: fixedItemBaseUsd > 0 ? ('mixed' as const) : ('default' as const),
      };
    });

    const facturadoTotalUsd = rows.reduce((sum, row) => sum + row.commissionableSubtotalUsd, 0);
    const facturadoItemEspecialUsd = rows.reduce((sum, row) => sum + row.fixedItemBaseUsd, 0);
    const facturadoOrdenEspecialUsd = rows.reduce((sum, row) => sum + row.fixedOrderBaseUsd, 0);
    const facturadoBaseUsd = Math.max(0, facturadoTotalUsd - facturadoItemEspecialUsd - facturadoOrdenEspecialUsd);
    const commissionTotalUsd = rows.reduce((sum, row) => sum + row.totalCommissionUsd, 0);
    const defaultOrdersCount = rows.filter((row) => row.mode === 'default').length;
    const mixedOrdersCount = rows.filter((row) => row.mode === 'mixed').length;
    const fixedOrdersCount = rows.filter((row) => row.mode === 'fixed_order').length;

    return {
      rows,
      facturadoTotalUsd,
      facturadoBaseUsd,
      facturadoItemEspecialUsd,
      facturadoOrdenEspecialUsd,
      commissionTotalUsd,
      baseCommissionPct,
      defaultOrdersCount,
      mixedOrdersCount,
      fixedOrdersCount,
    };
  }, [
    advisorCalcAdvisorId,
    advisorCalcBasePct,
    advisorCalcRange,
    catalogItemById,
    deliveredOrders,
  ]);

  const deliveryCalculatedData = useMemo(() => {
    const { start, end } = advisorCalcRange;

    const filteredDeliveryOrders = deliveredOrders.filter((order) => {
      if (order.fulfillment !== 'delivery') return false;
      const deliveryTime = new Date(order.deliveryAtISO).getTime();
      if (start && deliveryTime < start.getTime()) return false;
      if (end && deliveryTime > end.getTime()) return false;
      return true;
    });

    const rows = filteredDeliveryOrders.map((order) => {
      const mode =
        order.externalPartnerId != null || !!order.externalPartner
          ? ('external' as const)
          : order.internalDriverUserId || order.riderName
            ? ('internal' as const)
            : ('unassigned' as const);

      const internalPayFallback =
        mode === 'internal' ? getInternalDeliveryPayUsd(order, catalogItemById) : 0;
      const costUsd =
        order.editMeta?.deliveryCostUsd != null
          ? Number(order.editMeta.deliveryCostUsd || 0)
          : internalPayFallback;

      const distanceKm =
        order.editMeta?.deliveryDistanceKm != null
          ? Number(order.editMeta.deliveryDistanceKm || 0)
          : null;

      const internalDriverName =
        (order.internalDriverUserId ? driverNameById.get(order.internalDriverUserId) : null) ||
        order.riderName ||
        'Sin asignar';

      const externalPartnerName =
        (order.externalPartnerId != null
          ? deliveryPartnerNameById.get(order.externalPartnerId)
          : null) ||
        order.externalPartner ||
        'Partner externo';

      return {
        order,
        mode,
        costUsd: Math.max(0, Number(costUsd || 0)),
        distanceKm,
        deliveryChargeLabel: getOrderDeliveryChargeLabel(order, catalogItemById),
        internalDriverName,
        externalPartnerName,
        costSource: order.editMeta?.deliveryCostSource || null,
      };
    });

    const totalCostUsd = rows.reduce((sum, row) => sum + row.costUsd, 0);
    const internalRows = rows.filter((row) => row.mode === 'internal');
    const externalRows = rows.filter((row) => row.mode === 'external');

    const internalSummary = Array.from(
      internalRows.reduce((map, row) => {
        const key = row.order.internalDriverUserId || row.internalDriverName;
        const current = map.get(key) ?? {
          key,
          driverName: row.internalDriverName,
          deliveries: 0,
          totalCostUsd: 0,
          orders: [] as typeof internalRows,
        };
        current.deliveries += 1;
        current.totalCostUsd += row.costUsd;
        current.orders.push(row);
        map.set(key, current);
        return map;
      }, new Map<string, {
        key: string;
        driverName: string;
        deliveries: number;
        totalCostUsd: number;
        orders: typeof internalRows;
      }>())
    )
      .map(([, value]) => value)
      .sort((a, b) => b.totalCostUsd - a.totalCostUsd);

    const externalSummary = Array.from(
      externalRows.reduce((map, row) => {
        const key = String(row.order.externalPartnerId ?? row.externalPartnerName);
        const current = map.get(key) ?? {
          key,
          partnerName: row.externalPartnerName,
          deliveries: 0,
          totalCostUsd: 0,
          totalDistanceKm: 0,
          orders: [] as typeof externalRows,
        };
        current.deliveries += 1;
        current.totalCostUsd += row.costUsd;
        current.totalDistanceKm += Number(row.distanceKm || 0);
        current.orders.push(row);
        map.set(key, current);
        return map;
      }, new Map<string, {
        key: string;
        partnerName: string;
        deliveries: number;
        totalCostUsd: number;
        totalDistanceKm: number;
        orders: typeof externalRows;
      }>())
    )
      .map(([, value]) => value)
      .sort((a, b) => b.totalCostUsd - a.totalCostUsd);

    return {
      rows,
      totalDeliveries: rows.length,
      totalCostUsd,
      internalCount: internalRows.length,
      internalCostUsd: internalRows.reduce((sum, row) => sum + row.costUsd, 0),
      externalCount: externalRows.length,
      externalCostUsd: externalRows.reduce((sum, row) => sum + row.costUsd, 0),
      unassignedCount: rows.filter((row) => row.mode === 'unassigned').length,
      internalSummary,
      externalSummary,
    };
  }, [
    advisorCalcRange,
    catalogItemById,
    deliveredOrders,
    deliveryPartnerNameById,
    driverNameById,
  ]);

  const filteredInternalDeliverySummary = useMemo(() => {
    return deliveryCalculatedData.internalSummary.filter((row) => {
      if (!deliveryInternalDriverFilter) return true;
      return row.key === deliveryInternalDriverFilter;
    });
  }, [deliveryCalculatedData.internalSummary, deliveryInternalDriverFilter]);

  const filteredExternalDeliverySummary = useMemo(() => {
    return deliveryCalculatedData.externalSummary.filter((row) => {
      if (!deliveryExternalPartnerFilter) return true;
      return row.key === deliveryExternalPartnerFilter;
    });
  }, [deliveryCalculatedData.externalSummary, deliveryExternalPartnerFilter]);

  const filteredDeliveryRows = useMemo(() => {
    return deliveryCalculatedData.rows.filter((row) => {
      if (deliveriesTab === 'internal' && row.mode !== 'internal') return false;
      if (deliveriesTab === 'external' && row.mode !== 'external') return false;
      if (deliveryInternalDriverFilter && row.mode === 'internal') {
        return (row.order.internalDriverUserId || row.internalDriverName) === deliveryInternalDriverFilter;
      }
      if (deliveryExternalPartnerFilter && row.mode === 'external') {
        return String(row.order.externalPartnerId ?? row.externalPartnerName) === deliveryExternalPartnerFilter;
      }
      return true;
    });
  }, [
    deliveredOrders,
    deliveriesTab,
    deliveryCalculatedData.rows,
    deliveryExternalPartnerFilter,
    deliveryInternalDriverFilter,
  ]);

const createOrderCanSave =
  createOrderHasValidAdvisor &&
  createOrderHasClient &&
  createOrderHasItems &&
  createOrderHasDeliveryAddress &&
  createOrderHasDeliveryChargeItem;

useEffect(() => {
  if (!createOrderUseClientFund) return;

  const maxAllowed = Math.max(
    0,
    Math.min(
      Number(createOrderDraftTotalUsd.toFixed(2)),
      Number(createOrderClientFundAvailableUsd.toFixed(2))
    )
  );

  if (maxAllowed <= 0.005) {
    setCreateOrderUseClientFund(false);
    setCreateOrderClientFundAmountUsd('');
    return;
  }

  const requested = Number(String(createOrderClientFundAmountUsd || '').replace(',', '.')) || 0;
  if (requested <= 0) {
    setCreateOrderClientFundAmountUsd(String(maxAllowed));
    return;
  }

  if (requested > maxAllowed + 0.0001) {
    setCreateOrderClientFundAmountUsd(String(Number(maxAllowed.toFixed(2))));
  }
}, [
  createOrderUseClientFund,
  createOrderClientFundAmountUsd,
  createOrderDraftTotalUsd,
  createOrderClientFundAvailableUsd,
]);

useEffect(() => {
  if (!createOrderConfigOpen) return;

  setTimeout(() => {
    createOrderConfigAliasRef.current?.focus();
    createOrderConfigAliasRef.current?.select();
  }, 0);
}, [createOrderConfigOpen]);

useEffect(() => {
  if (createOrderFulfillment !== 'delivery') {
    setCreateOrderSelectedAddressIndex(null);
    return;
  }

  if (!selectedCreateOrderClientAddresses.length) return;

  if (
    createOrderSelectedAddressIndex != null &&
    selectedCreateOrderClientAddresses[createOrderSelectedAddressIndex]
  ) {
    return;
  }

  if (!createOrderDeliveryAddress.trim()) {
    handleApplyClientAddress(selectedCreateOrderClientAddresses[0], 0);
  }
}, [
  createOrderFulfillment,
  createOrderDeliveryAddress,
  createOrderSelectedAddressIndex,
  selectedCreateOrderClientAddresses,
]);

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
  resetPriceAdjustBox();
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
  setCreateOrderIsAsap(false);

  setCreateOrderReceiverIsDifferent(false);
  setCreateOrderReceiverName('');
  setCreateOrderReceiverPhone('');
  setCreateOrderDeliveryAddress('');
  setCreateOrderDeliveryGpsUrl('');
  setCreateOrderSelectedAddressIndex(null);
  setCreateOrderNote('');

  setCreateOrderPaymentMethod('payment_mobile');
  setCreateOrderPaymentCurrency('VES');
  setCreateOrderPaymentRequiresChange(false);
  setCreateOrderPaymentChangeFor('');
  setCreateOrderPaymentChangeCurrency('USD');
  setCreateOrderPaymentNote('');
  setCreateOrderUseClientFund(false);
  setCreateOrderClientFundAmountUsd('');

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
  setAdminEditReason('');
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
    setCalendarViewMonth(new Date(selectedDay.getFullYear(), selectedDay.getMonth(), 1));
  }, [selectedDay]);

  useEffect(() => {
    if (advisorCalcSource === '' || advisorCalcSource === 'advisor') return;
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

const calendarDays = useMemo(() => buildCalendarDays(calendarViewMonth), [calendarViewMonth]);


  return (
    <div className="min-h-screen bg-[#0B0B0D] text-[#F5F5F7]">
      <div className="sticky top-0 z-50 border-b border-[#242433] bg-[#0B0B0D]/95 backdrop-blur">
        <div className="mx-auto max-w-[1400px] px-5 py-2.5">
  <div className="flex flex-col gap-2.5">
    <div className="flex items-center justify-between gap-2.5">
      <div className="flex items-center gap-2.5">
        <h1 className="text-base font-semibold leading-none">B. Master 3.0</h1>

        <div className="relative">
          <button
            className="rounded-2xl border border-[#242433] bg-[#121218] px-2.5 py-1.5 text-left"
            onClick={() => setCalendarOpen((prev) => !prev)}
            title="Seleccionar día"
            type="button"
          >
            <div className="grid min-w-[190px] grid-cols-2 gap-1.5">
              <div>
                <div className="text-[9px] uppercase tracking-[0.14em] text-[#8A8A96]">Hoy</div>
                <div className="mt-0.5 text-[12px] font-medium leading-none">
                  {isMounted && selectedDay ? fmtDayLabelES(selectedDay.toISOString()) : 'Cargando fecha...'}
                </div>
              </div>
              <div>
                <div className="text-[9px] uppercase tracking-[0.14em] text-[#8A8A96]">Semana</div>
                <div className="mt-0.5 text-[10px] leading-tight text-[#B7B7C2]">
                  {isMounted && selectedDay ? fmtWeekRangeES(selectedDay).replace('Semana: ', '') : '—'}
                </div>
              </div>
            </div>
          </button>

          {calendarOpen ? (
            <div className="absolute left-0 top-[calc(100%+8px)] z-[90] w-[252px] rounded-2xl border border-[#242433] bg-[#121218] p-2 shadow-2xl">
              <div className="mb-2 flex items-center justify-between gap-2">
                <button
                  className="flex h-7 w-7 items-center justify-center rounded-xl border border-[#242433] bg-[#0B0B0D] text-sm text-[#B7B7C2] hover:text-[#F5F5F7]"
                  onClick={() =>
                    setCalendarViewMonth(
                      new Date(calendarViewMonth.getFullYear(), calendarViewMonth.getMonth() - 1, 1)
                    )
                  }
                  type="button"
                >
                  ‹
                </button>
                <div className="text-[12px] font-medium text-[#F5F5F7]">{fmtCalendarMonthES(calendarViewMonth)}</div>
                <button
                  className="flex h-7 w-7 items-center justify-center rounded-xl border border-[#242433] bg-[#0B0B0D] text-sm text-[#B7B7C2] hover:text-[#F5F5F7]"
                  onClick={() =>
                    setCalendarViewMonth(
                      new Date(calendarViewMonth.getFullYear(), calendarViewMonth.getMonth() + 1, 1)
                    )
                  }
                  type="button"
                >
                  ›
                </button>
              </div>

              <div className="grid grid-cols-7 gap-1">
                {CALENDAR_WEEKDAY_LABELS.map((label) => (
                  <div key={label} className="pb-1 text-center text-[10px] uppercase tracking-[0.12em] text-[#6F6F7C]">
                    {label}
                  </div>
                ))}
                {calendarDays.map(({ date, inMonth }) => {
                  const isSelected = isSameDay(selectedDay, date);
                  const isToday = isSameDay(new Date(), date);

                  return (
                    <button
                      key={date.toISOString()}
                      className={[
                        'h-8 rounded-xl text-[12px] transition',
                        isSelected
                          ? 'bg-[#FEEF00] font-semibold text-[#0B0B0D]'
                          : inMonth
                            ? 'bg-[#0B0B0D] text-[#F5F5F7] hover:border-[#FEEF00]/40'
                            : 'bg-[#0B0B0D] text-[#5D5D68]',
                        isToday && !isSelected ? 'border border-[#FEEF00]/50' : 'border border-transparent',
                      ].join(' ')}
                      onClick={() => {
                        const next = new Date(date);
                        next.setHours(0, 0, 0, 0);
                        setSelectedDay(next);
                        setCalendarOpen(false);
                      }}
                      type="button"
                    >
                      {date.getDate()}
                    </button>
                  );
                })}
              </div>

              <div className="mt-2 flex items-center justify-between gap-2">
                <button
                  className="rounded-xl border border-[#242433] bg-[#0B0B0D] px-2.5 py-1 text-[11px] text-[#B7B7C2] hover:text-[#F5F5F7]"
                  onClick={() => {
                    const today = new Date();
                    today.setHours(0, 0, 0, 0);
                    setSelectedDay(today);
                    setCalendarViewMonth(new Date(today.getFullYear(), today.getMonth(), 1));
                    setCalendarOpen(false);
                  }}
                  type="button"
                >
                  Hoy
                </button>
                <button
                  className="rounded-xl border border-[#242433] bg-[#0B0B0D] px-2.5 py-1 text-[11px] text-[#B7B7C2] hover:text-[#F5F5F7]"
                  onClick={() => setCalendarOpen(false)}
                  type="button"
                >
                  Cerrar
                </button>
              </div>
            </div>
          ) : null}
        </div>

        <button
          className="rounded-2xl border border-[#242433] bg-[#121218] px-2.5 py-1.5 text-left transition hover:border-[#FEEF00]/60"
          onClick={() => {
            setViewMode('settings');
            setSettingsTab('exchange_rate');
          }}
          title={activeExchangeRate ? `Vigente desde: ${fmtDateTimeES(activeExchangeRate.effectiveAt)}` : 'Sin tasa activa'}
          suppressHydrationWarning
        >
          <div className="text-[9px] uppercase tracking-[0.14em] text-[#8A8A96]">Tasa</div>
          <div className="mt-0.5 text-[13px] font-medium leading-none text-[#F5F5F7]">
            {activeExchangeRate ? fmtRateBs(activeExchangeRate.rateBsPerUsd) : '—'}
          </div>
        </button>
      </div>

      <div className="flex items-center gap-2.5">
        <div className="flex items-center gap-1.5 rounded-2xl border border-[#242433] bg-[#0F0F14] p-1">
          <TopNavButton label="Operación" icon={<TopNavIcon kind="operations" />} active={viewMode === 'operations'} onClick={() => setViewMode('operations')} />
          <TopNavButton label="Config." icon={<TopNavIcon kind="settings" />} active={viewMode === 'settings'} onClick={() => setViewMode('settings')} />
          {isAdmin ? (
            <TopNavButton label="Cálculos" icon={<TopNavIcon kind="calculations" />} active={viewMode === 'calculations'} onClick={() => setViewMode('calculations')} />
          ) : null}
          <TopNavButton label="Alertas" icon={<TopNavIcon kind="alerts" />} active={notifOpen} onClick={() => setNotifOpen(true)} count={notifications.length} />
        </div>

        <div className="w-[200px] rounded-2xl border border-[#242433] bg-[#121218] px-3 py-1.5">
          <div className="flex items-start justify-between gap-0">
            <div className="min-w-0">
              <div className="truncate text-[13px] font-semibold leading-none text-[#F5F5F7]">
                {currentUser.fullName || 'Usuario'}
              </div>

              <div className="mt-0.5 truncate text-[10px] text-[#B7B7C2]">
                {roles.length > 0 ? ` ${roles.map((r) => r.toUpperCase()).join(' · ')}` : 'Sin roles'}
              </div>
            </div>

            <button
              className="shrink-0 rounded-xl border border-red-500/40 bg-[#0B0B0D] px-2 py-2 text-[11px] text-red-400"
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
        <Chip active={settingsTab === 'inventory'} onClick={() => setSettingsTab('inventory')}>
          Inventario
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
        {isAdmin ? (
          <Chip active={settingsTab === 'adjustments'} onClick={() => setSettingsTab('adjustments')}>
            Ajustes
          </Chip>
        ) : null}
      </div>
    </div>
  </div>
) : null}

{viewMode === 'calculations' && isAdmin ? (
  <div className="border-b border-[#242433] bg-[#0B0B0D]">
    <div className="mx-auto max-w-[1400px] px-5 py-2">
      <div className="flex gap-2 overflow-x-auto">
        <Chip active={calculationsTab === 'general'} onClick={() => setCalculationsTab('general')}>
          General
        </Chip>
        <Chip active={calculationsTab === 'commissions'} onClick={() => setCalculationsTab('commissions')}>
          Comisiones
        </Chip>
        <Chip active={calculationsTab === 'deliveries'} onClick={() => setCalculationsTab('deliveries')}>
          Deliveries
        </Chip>
      </div>
    </div>
  </div>
) : null}


      {viewMode === 'operations' ? (
        <div className="mx-auto max-w-[1400px] px-5 py-4">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-[1.35fr_0.9fr_0.9fr_0.9fr_0.9fr_1.35fr]">
            <Card title="Estado">
              <div className="hidden">
              <StatRow label="Cierres" value={dayStats.cierres} />
              <StatRow label="FacturaciÃ³n" value={fmtUSD(dayStats.fact)} />
              <StatRow label="Abonado (conf.)" value={fmtUSD(dayStats.abonadoConfirmado)} />
              <StatRow label="Pendiente" value={fmtUSD(dayStats.pendiente)} highlight />
              <div className="mt-3 border-t border-[#242433] pt-3">
                <div className="mb-2 text-[11px] uppercase tracking-[0.18em] text-[#8A8A96]">Semana</div>
                <StatRow label="Cierres" value={weekStats.cierres} />
                <StatRow label="Facturacion" value={fmtUSD(weekStats.fact)} />
                <StatRow label="Abonado" value={fmtUSD(weekStats.abonadoConfirmado)} />
                <StatRow label="Pendiente" value={fmtUSD(weekStats.pendiente)} highlight />
              </div>
              </div>
              <div className="grid grid-cols-[1fr_0.55fr_0.55fr] gap-x-2 gap-y-1 text-[11px]">
                <div />
                <div className="text-center text-[9px] uppercase tracking-[0.14em] text-[#8A8A96]">Hoy</div>
                <div className="text-center text-[9px] uppercase tracking-[0.14em] text-[#8A8A96]">Semana</div>

                <div className="text-[#B7B7C2]">Cierres</div>
                <div className="text-center font-semibold text-[#F5F5F7]">{dayStats.cierres}</div>
                <div className="text-center font-semibold text-[#F5F5F7]">{weekStats.cierres}</div>

                <div className="text-[#B7B7C2]">Fact.</div>
                <div className="text-center font-semibold text-[#F5F5F7]">{fmtUSD(dayStats.fact)}</div>
                <div className="text-center font-semibold text-[#F5F5F7]">{fmtUSD(weekStats.fact)}</div>

                <div className="text-[#B7B7C2]">Abonado</div>
                <div className="text-center font-semibold text-[#F5F5F7]">{fmtUSD(dayStats.abonadoConfirmado)}</div>
                <div className="text-center font-semibold text-[#F5F5F7]">{fmtUSD(weekStats.abonadoConfirmado)}</div>

                <div className="text-[#B7B7C2]">Pendiente</div>
                <div className="text-center font-semibold text-[#FEEF00]">{fmtUSD(dayStats.pendiente)}</div>
                <div className="text-center font-semibold text-[#FEEF00]">{fmtUSD(weekStats.pendiente)}</div>
              </div>
            </Card>

            <Card title="Semana" className="hidden">
              <StatRow label="Cierres" value={weekStats.cierres} />
              <StatRow label="FacturaciÃ³n" value={fmtUSD(weekStats.fact)} />
              <StatRow label="Abonado (conf.)" value={fmtUSD(weekStats.abonadoConfirmado)} />
              <StatRow label="Pendiente" value={fmtUSD(weekStats.pendiente)} highlight />
            </Card>

            <Card title="Pagos por revisar">
              <div className="space-y-1 text-[11px]">
                <button
                  className="flex w-full items-center justify-between rounded-lg border border-[#242433] bg-[#0B0B0D] px-2.5 py-1 text-left hover:border-[#FEEF00]/40"
                  onClick={() => {
                    setPaymentsPanelKind('pending');
                    setPaymentsPanelOpen(true);
                  }}
                  type="button"
                >
                  <span className="text-[#B7B7C2]">Por confirmar</span>
                  <span className="font-semibold text-orange-400">{paymentsStats.porConfirmar}</span>
                </button>
                <button
                  className="flex w-full items-center justify-between rounded-lg border border-[#242433] bg-[#0B0B0D] px-2.5 py-1 text-left hover:border-[#FEEF00]/40"
                  onClick={() => {
                    setPaymentsPanelKind('confirmed');
                    setPaymentsPanelOpen(true);
                  }}
                  type="button"
                >
                  <span className="text-[#B7B7C2]">Confirmados</span>
                  <span className="font-semibold text-[#7FE7C4]">{paymentsStats.confirmados}</span>
                </button>
                <button
                  className="flex w-full items-center justify-between rounded-lg border border-[#242433] bg-[#0B0B0D] px-2.5 py-1 text-left hover:border-[#FEEF00]/40"
                  onClick={() => {
                    setPaymentsPanelKind('rejected');
                    setPaymentsPanelOpen(true);
                  }}
                  type="button"
                >
                  <span className="text-[#B7B7C2]">Rechazados</span>
                  <span className="font-semibold text-[#F5F5F7]">{paymentsStats.rechazados}</span>
                </button>
              </div>
            </Card>

            <Card title="Deliveries">
              <div className="space-y-1 text-[11px]">
                <button
                  className="flex w-full items-center justify-between rounded-lg border border-[#242433] bg-[#0B0B0D] px-2.5 py-1 text-left hover:border-[#FEEF00]/40"
                  onClick={() => {
                    setDeliveryPanelKind('internal');
                    setDeliveryPanelOpen(true);
                  }}
                  type="button"
                >
                  <span className="text-[#B7B7C2]">Internos</span>
                  <span className="font-semibold text-[#7FE7C4]">{deliveryStats.internos}</span>
                </button>
                <button
                  className="flex w-full items-center justify-between rounded-lg border border-[#242433] bg-[#0B0B0D] px-2.5 py-1 text-left hover:border-[#FEEF00]/40"
                  onClick={() => {
                    setDeliveryPanelKind('external');
                    setDeliveryPanelOpen(true);
                  }}
                  type="button"
                >
                  <span className="text-[#B7B7C2]">Externos</span>
                  <span className="font-semibold text-[#F5F5F7]">{deliveryStats.externos}</span>
                </button>
              </div>
            </Card>

            <Card title="Cocina">
              <div className="space-y-1 text-[11px]">
                <button
                  className="flex w-full items-center justify-between rounded-lg border border-[#242433] bg-[#0B0B0D] px-2.5 py-1 text-left hover:border-[#FEEF00]/40"
                  onClick={() => {
                    setKitchenPanelKind('total');
                    setKitchenPanelOpen(true);
                  }}
                  type="button"
                >
                  <span className="text-[#B7B7C2]">En cocina</span>
                  <span className="font-semibold text-[#F5F5F7]">{kitchenStats.totalEnCocina}</span>
                </button>
                <button
                  className="flex w-full items-center justify-between rounded-lg border border-[#242433] bg-[#0B0B0D] px-2.5 py-1 text-left hover:border-[#FEEF00]/40"
                  onClick={() => {
                    setKitchenPanelKind('pending_take');
                    setKitchenPanelOpen(true);
                  }}
                  type="button"
                >
                  <span className="text-[#B7B7C2]">Por tomar</span>
                  <span className="font-semibold text-orange-400">{kitchenStats.pendientesToma}</span>
                </button>
                <button
                  className="flex w-full items-center justify-between rounded-lg border border-[#242433] bg-[#0B0B0D] px-2.5 py-1 text-left hover:border-[#FEEF00]/40"
                  onClick={() => {
                    setKitchenPanelKind('preparing');
                    setKitchenPanelOpen(true);
                  }}
                  type="button"
                >
                  <span className="text-[#B7B7C2]">Preparando</span>
                  <span className="font-semibold text-[#7FE7C4]">{kitchenStats.enPreparacion}</span>
                </button>
                <button
                  className="flex w-full items-center justify-between rounded-lg border border-[#242433] bg-[#0B0B0D] px-2.5 py-1 text-left hover:border-[#FEEF00]/40"
                  onClick={() => {
                    setKitchenPanelKind('ready');
                    setKitchenPanelOpen(true);
                  }}
                  type="button"
                >
                  <span className="text-[#B7B7C2]">Preparados</span>
                  <span className="font-semibold text-[#FEEF00]">{kitchenStats.preparados}</span>
                </button>
              </div>
            </Card>

            <Card title="Tareas urgentes">
              <div className="hidden">
              <StatRow label="Aprobar" value={approvalsStats.porAprobar} highlightTone="brand" />
              <StatRow label="Reaprobar" value={approvalsStats.reaprobar} highlightTone="warn" />
              <StatRow label="Enviar a cocina" value={approvalsStats.listasCocina} />
              <div className="space-y-2">
                {true ? (
                  <div className="rounded-xl border border-[#242433] bg-[#0B0B0D] px-3 py-2 text-xs text-[#8A8A96]">
                    Sin tareas urgentes por ahora.
                  </div>
                ) : (
                  ([] as Array<{ id: number; clientName: string; deliveryAtISO: string; actionLabel: string; tone: 'warn' | 'brand' | null }>).map((task) => (
                    <button
                      key={task.id}
                      className="w-full rounded-xl border border-[#242433] bg-[#0B0B0D] px-3 py-2 text-left hover:border-[#FEEF00]/40"
                      onClick={() => openOrderPanel(task.id, 'detalle')}
                      type="button"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="truncate text-sm text-[#F5F5F7]">#{task.id} · {task.clientName}</div>
                        <div
                          className={[
                            'shrink-0 text-xs font-semibold',
                            task.tone === 'warn'
                              ? 'text-orange-400'
                              : task.tone === 'brand'
                                ? 'text-[#FEEF00]'
                                : 'text-[#7FE7C4]',
                          ].join(' ')}
                        >
                          {task.actionLabel}
                        </div>
                      </div>
                      <div className="mt-1 text-xs text-[#8A8A96]">{fmtDeliveryTextES(task.deliveryAtISO)}</div>
                    </button>
                  ))
                )}
              </div>
              </div>
              <div className="space-y-1 text-[11px]">
                <button
                  className="flex w-full items-center justify-between rounded-lg border border-[#242433] bg-[#0B0B0D] px-2.5 py-1 text-left hover:border-[#FEEF00]/40"
                  onClick={() => {
                    setTaskPanelKind('approve');
                    setTaskPanelOpen(true);
                  }}
                  type="button"
                >
                  <span className="text-[#B7B7C2]">Por aprobar</span>
                  <span className="font-semibold text-[#FEEF00]">{urgentTaskBuckets.approve.length}</span>
                </button>
                <button
                  className="flex w-full items-center justify-between rounded-lg border border-[#242433] bg-[#0B0B0D] px-2.5 py-1 text-left hover:border-[#FEEF00]/40"
                  onClick={() => {
                    setTaskPanelKind('reapprove');
                    setTaskPanelOpen(true);
                  }}
                  type="button"
                >
                  <span className="text-[#B7B7C2]">Reaprobar</span>
                  <span className="font-semibold text-orange-400">{urgentTaskBuckets.reapprove.length}</span>
                </button>
                <button
                  className="flex w-full items-center justify-between rounded-lg border border-[#242433] bg-[#0B0B0D] px-2.5 py-1 text-left hover:border-[#FEEF00]/40"
                  onClick={() => {
                    setTaskPanelKind('kitchen');
                    setTaskPanelOpen(true);
                  }}
                  type="button"
                >
                  <span className="text-[#B7B7C2]">Enviar a cocina</span>
                  <span className="font-semibold text-[#7FE7C4]">{urgentTaskBuckets.kitchen.length}</span>
                </button>
                <button
                  className="flex w-full items-center justify-between rounded-lg border border-[#242433] bg-[#0B0B0D] px-2.5 py-1 text-left hover:border-[#FEEF00]/40"
                  onClick={() => {
                    setTaskPanelKind('driver');
                    setTaskPanelOpen(true);
                  }}
                  type="button"
                >
                  <span className="text-[#B7B7C2]">Asignar driver</span>
                  <span className="font-semibold text-[#F5F5F7]">{urgentTaskBuckets.driver.length}</span>
                </button>
              </div>
            </Card>

            <Card title="Productos comprometidos">
              <div className="space-y-1">
                {committedProductsRowsDay.length === 0 ? (
                  <div className="text-xs text-[#B7B7C2]">Sin datos</div>
                ) : (
                  <div className="space-y-1">
                    {committedProductsPreviewRows.map((product) => (
                      <div
                        key={product.name}
                        className="rounded-lg border border-[#242433] bg-[#0B0B0D] px-2.5 py-1 text-[11px]"
                      >
                        <div className="flex items-center gap-2">
                          <div className="min-w-0 flex-1 truncate font-medium text-[#F5F5F7]">
                            {product.name}
                          </div>
                          <div className="shrink-0 text-[#FEEF00]">
                            {fmtUnitsValue(product.und)}
                          </div>
                          <div className="shrink-0 text-[#8A8A96]">
                            / {product.currentUnits != null ? fmtUnitsValue(product.currentUnits) : '—'}
                          </div>
                          <div
                            className={[
                              'shrink-0',
                              product.remainingUnits != null && product.remainingUnits <= 0
                                ? 'text-orange-400'
                                : 'text-[#B7B7C2]',
                            ].join(' ')}
                          >
                            ({product.remainingUnits != null ? fmtUnitsValue(product.remainingUnits) : '—'})
                          </div>
                          {product.statusLabel ? (
                            <div
                              className={[
                                'shrink-0 text-[10px] font-semibold',
                                product.statusTone === 'warn' ? 'text-orange-400' : 'text-[#FEEF00]',
                              ].join(' ')}
                            >
                              {product.statusLabel}
                            </div>
                          ) : null}
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                <div className="flex justify-end pt-0.5">
                  {committedProductsRowsDay.length > committedProductsPreviewRows.length ? (
                    <button
                      className="text-xs text-[#B7B7C2] hover:text-[#F5F5F7]"
                      onClick={() => setProductsExpanded(true)}
                    >
                      Ver detalle
                    </button>
                  ) : committedProductsRowsDay.length > 0 ? (
                    <button
                      className="text-xs text-[#B7B7C2] hover:text-[#F5F5F7]"
                      onClick={() => setProductsExpanded(true)}
                    >
                      Ver detalle
                    </button>
                  ) : null}
                </div>
              </div>
            </Card>
          </div>

          <div className="mt-3 flex flex-col gap-2 rounded-2xl border border-[#242433] bg-[#121218] p-2.5 md:flex-row md:items-center md:justify-between">
            <div className="relative w-full md:max-w-md">
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Buscar orden o cliente"
                className="w-full rounded-xl border border-[#242433] bg-[#0B0B0D] px-3.5 py-1.5 text-[13px] text-[#F5F5F7] placeholder:text-[#8A8A96]"
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
              <button
                className="rounded-xl border border-[#242433] bg-[#0B0B0D] px-3.5 py-1.5 text-[13px] font-semibold text-[#F5F5F7] transition hover:border-[#FEEF00]/40"
                onClick={openCreateOrderDrawer}
                type="button"
              >
                Nuevo pedido
              </button>
              <button
                className="rounded-xl border border-[#242433] bg-[#0B0B0D] px-3.5 py-1.5 text-[13px] font-semibold text-[#F5F5F7] transition hover:border-[#FEEF00]/40"
                onClick={() => setMovementOpen(true)}
                type="button"
              >
                Ingreso / Egreso
              </button>
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
                    <th className="px-2 py-2 text-left font-medium">Ruta</th>
                  </tr>
                </thead>

                <tbody>
                  {tableOrders.length === 0 ? (
                    <tr>
                      <td className="px-2 py-6 text-center text-[#B7B7C2]" colSpan={8}>
                        Sin pedidos para este filtro.
                      </td>
                    </tr>
                  ) : (
                    tableOrders.map((o, idx) => {
                      const zebra = idx % 2 === 0 ? 'bg-[#121218]' : 'bg-[#151522]';
                      const aName = splitTwoWordsCompact(o.advisorName);
                      const cName = splitTwoWordsCompact(o.clientName);

                      return (
                        <tr
                          key={o.id}
                          className={`${zebra} cursor-pointer border-b border-[#242433] hover:bg-[#191926]`}
                          onClick={() => onRowClick(o.id)}
                        >
                          <td className="px-2 py-2">{fmtTimeAMPM(o.deliveryAtISO)}</td>
                          <td className="px-2 py-2 font-medium">{o.id}</td>
                          <td className="min-w-[122px] px-2 py-2 leading-4">
                            <div>{aName.line1}</div>
                            <div className="text-[#B7B7C2]">{aName.line2}</div>
                          </td>
                          <td className="min-w-[122px] px-2 py-2 leading-4">
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
                          <td className="px-2 py-2 min-w-[400px]">
                            <RowProcessTimeline order={o} nowMs={currentTimeMs} />
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
          {calculationsTab === 'general' ? (
            <div className="space-y-5">
              <div className="rounded-2xl border border-[#242433] bg-[#121218] p-4">
                <div className="flex flex-col gap-3">
                  <div>
                    <div className="text-sm font-semibold text-[#F5F5F7]">AnÃ¡lisis de asesores</div>
                    <div className="mt-1 text-sm text-[#B7B7C2]">
                      Revisa cierres, facturaciÃ³n, puntualidad de pago, clientes nuevos y pendientes por cobrar por asesor.
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
                  <StatRow label="FacturaciÃ³n" value={fmtUSD(advisorCalculatedData.facturacion)} />
                  <StatRow label="Cierres" value={advisorCalculatedData.cierres} />
                  <StatRow label="Cierre promedio" value={fmtUSD(advisorCalculatedData.cierrePromedio)} />
                  <StatRow label="ComisiÃ³n estimada" value={fmtUSD(advisorCalculatedData.commissionTotalUsd)} />
                  <StatRow label="Ã“rdenes" value={advisorCalculatedData.filteredDeliveredOrders.length} />
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
                  <StatRow label="Ã“rdenes" value={advisorCalculatedData.pendingOrders.length} highlightTone="warn" />
                </Card>

                <Card title="PerÃ­odo" className="p-3">
                  <StatRow label="Desde" value={advisorCalcDateFrom || 'â€”'} />
                  <StatRow label="Hasta" value={advisorCalcDateTo || 'â€”'} />
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
                    <div className="text-sm font-semibold text-[#F5F5F7]">FacturaciÃ³n</div>
                    <div className="text-sm font-semibold text-emerald-400">{fmtUSD(advisorCalculatedData.facturacion)}</div>
                  </div>
                  <div className="max-h-[360px] overflow-auto">
                    <table className="w-full text-[11px]">
                      <thead className="sticky top-0 z-10 bg-[#0B0B0D] text-[#B7B7C2]">
                        <tr>
                          <th className="px-3 py-2 text-left font-medium">Nro# Control</th>
                          <th className="px-3 py-2 text-left font-medium">Cliente</th>
                          <th className="px-3 py-2 text-left font-medium">Origen</th>
                          <th className="px-3 py-2 text-right font-medium">ComisiÃ³n</th>
                          <th className="px-3 py-2 text-right font-medium">Facturado</th>
                        </tr>
                      </thead>
                      <tbody>
                        {advisorCalculatedData.filteredDeliveredOrders.length === 0 ? (
                          <tr>
                            <td className="px-3 py-6 text-center text-[#B7B7C2]" colSpan={5}>
                              Sin cierres entregados en el perÃ­odo.
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
                              <td className="px-3 py-2 text-right">
                                {fmtUSD(advisorCalculatedData.commissionByOrderId.get(order.id)?.commissionUsd ?? 0)}
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
                              Sin clientes nuevos en el perÃ­odo.
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
          ) : calculationsTab === 'commissions' ? (
            <div className="space-y-5">
              <div className="rounded-2xl border border-[#242433] bg-[#121218] p-4">
                <div className="flex flex-col gap-3">
                  <div>
                    <div className="text-sm font-semibold text-[#F5F5F7]">Calculo de comisiones</div>
                    <div className="mt-1 text-sm text-[#B7B7C2]">
                      Base comisionable: total despues del descuento y antes del IVA.
                    </div>
                  </div>

                  <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-[150px_150px_220px_120px]">
                    <FieldInput label="Desde" value={advisorCalcDateFrom} onChange={setAdvisorCalcDateFrom} type="date" />
                    <FieldInput label="Hasta" value={advisorCalcDateTo} onChange={setAdvisorCalcDateTo} type="date" />
                    <FieldSelect
                      label="Asesor"
                      value={advisorCalcAdvisorId}
                      onChange={setAdvisorCalcAdvisorId}
                      options={[
                        { value: '', label: 'Todos los asesores' },
                        ...advisors.map((advisor) => ({
                          value: advisor.userId,
                          label: advisor.fullName,
                        })),
                      ]}
                    />
                    <FieldInput label="% base" value={advisorCalcBasePct} onChange={setAdvisorCalcBasePct} type="text" />
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-5">
                <Card title="Facturado Total" className="p-3">
                  <StatRow label="Total" value={fmtUSD(commissionCalculatedData.facturadoTotalUsd)} />
                  <StatRow label="Base" value={`${commissionCalculatedData.baseCommissionPct.toFixed(2)}%`} />
                </Card>

                <Card title="Ordenes Default" className="p-3">
                  <StatRow label="Ordenes" value={commissionCalculatedData.defaultOrdersCount} />
                  <StatRow label="Facturado" value={fmtUSD(commissionCalculatedData.facturadoBaseUsd)} />
                </Card>

                <Card title="Con Item Especial" className="p-3">
                  <StatRow label="Ordenes" value={commissionCalculatedData.mixedOrdersCount} />
                  <StatRow label="Facturado" value={fmtUSD(commissionCalculatedData.facturadoItemEspecialUsd)} />
                  <StatRow label="Regla" value="% por item" />
                </Card>

                <Card title="Con Orden Fija" className="p-3">
                  <StatRow label="Ordenes" value={commissionCalculatedData.fixedOrdersCount} />
                  <StatRow label="Facturado" value={fmtUSD(commissionCalculatedData.facturadoOrdenEspecialUsd)} />
                  <StatRow label="Regla" value="% fijo por orden" />
                </Card>

                <Card title="Comision Estimada" className="p-3">
                  <StatRow label="Base normal" value={fmtUSD(commissionCalculatedData.facturadoBaseUsd)} />
                  <StatRow label="Comision" value={fmtUSD(commissionCalculatedData.commissionTotalUsd)} highlightTone="brand" />
                </Card>
              </div>

              <div className="rounded-2xl border border-[#242433] bg-[#121218]">
                <div className="flex items-center justify-between border-b border-[#242433] px-4 py-3">
                  <div className="text-sm font-semibold text-[#F5F5F7]">Detalle de comisiones</div>
                  <div className="text-sm font-semibold text-[#FEEF00]">{fmtUSD(commissionCalculatedData.commissionTotalUsd)}</div>
                </div>
                <div className="grid grid-cols-1 gap-2 border-b border-[#242433] bg-[#0F0F14] px-4 py-3 text-[11px] text-[#B7B7C2] md:grid-cols-3">
                  <div>
                    <span className="inline-flex rounded-full bg-[#191926] px-2 py-0.5 font-semibold text-[#B7B7C2]">Default</span>
                    <span className="ml-2">usa el % base sobre la parte normal</span>
                  </div>
                  <div>
                    <span className="inline-flex rounded-full bg-[#FEEF00] px-2 py-0.5 font-semibold text-[#0B0B0D]">Item especial</span>
                    <span className="ml-2">solo cambia los items marcados</span>
                  </div>
                  <div>
                    <span className="inline-flex rounded-full bg-orange-500 px-2 py-0.5 font-semibold text-[#0B0B0D]">Orden fija</span>
                    <span className="ml-2">toda la orden usa ese % fijo</span>
                  </div>
                </div>
                <div className="max-h-[420px] overflow-auto">
                  <table className="w-full text-[11px]">
                    <thead className="sticky top-0 z-10 bg-[#0B0B0D] text-[#B7B7C2]">
                      <tr>
                        <th className="px-3 py-2 text-left font-medium">Nro# Orden</th>
                        <th className="px-3 py-2 text-left font-medium">Cliente</th>
                        <th className="px-3 py-2 text-left font-medium">Detalle</th>
                        <th className="px-3 py-2 text-right font-medium">Comision</th>
                      </tr>
                    </thead>
                    <tbody>
                      {commissionCalculatedData.rows.length === 0 ? (
                        <tr>
                          <td className="px-3 py-6 text-center text-[#B7B7C2]" colSpan={4}>
                            Sin cierres de advisor para este periodo.
                          </td>
                        </tr>
                      ) : (
                        commissionCalculatedData.rows.map((row, idx) => (
                          <tr
                            key={row.order.id}
                            className={`${idx % 2 === 0 ? 'bg-[#121218]' : 'bg-[#151522]'} border-b border-[#242433]`}
                          >
                            <td className="px-3 py-2">{fmtShortOrderLabel(row.order.id)}</td>
                            <td className="px-3 py-2">{row.order.clientName}</td>
                            <td className="px-3 py-2 leading-5">
                              <div className="text-[#F5F5F7]">
                                Total orden {fmtUSD(row.commissionableSubtotalUsd)}
                              </div>
                              {row.mode === 'fixed_order' ? (
                                <div className="text-orange-400">
                                  Orden fija {fmtUSD(row.fixedOrderBaseUsd)} {row.fixedOrderPct?.toFixed(2) ?? '0.00'}%
                                </div>
                              ) : (
                                <>
                                  <div className="text-[#B7B7C2]">
                                    Default {fmtUSD(row.regularBaseUsd)} {commissionCalculatedData.baseCommissionPct.toFixed(2)}%
                                  </div>
                                  {row.fixedItemBaseUsd > 0 ? (
                                    <div className="text-[#FEEF00]">
                                      Fixed item {fmtUSD(row.fixedItemBaseUsd)}{' '}
                                      {row.fixedItemBaseUsd > 0
                                        ? ((row.fixedItemCommissionUsd / row.fixedItemBaseUsd) * 100).toFixed(2)
                                        : '0.00'}
                                      %
                                    </div>
                                  ) : null}
                                </>
                              )}
                            </td>
                            <td className="px-3 py-2 text-right">{fmtUSD(row.totalCommissionUsd)}</td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          ) : calculationsTab === 'deliveries' ? (
            <div className="space-y-5">
              <div className="rounded-2xl border border-[#242433] bg-[#121218] p-4">
                <div className="flex flex-col gap-3">
                  <div>
                    <div className="text-sm font-semibold text-[#F5F5F7]">Control de deliveries</div>
                    <div className="mt-1 text-sm text-[#B7B7C2]">
                      Revisa cantidad de deliveries, costo total, liquidaciÃ³n de internos y auditorÃ­a de externos.
                    </div>
                  </div>

                  <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-[150px_150px_180px_180px]">
                    <FieldInput label="Desde" value={advisorCalcDateFrom} onChange={setAdvisorCalcDateFrom} type="date" />
                    <FieldInput label="Hasta" value={advisorCalcDateTo} onChange={setAdvisorCalcDateTo} type="date" />
                    <div className="rounded-xl border border-[#242433] bg-[#0B0B0D] px-3 py-2">
                      <div className="text-[10px] uppercase tracking-[0.18em] text-[#8A8A96]">Internos</div>
                      <div className="mt-1 text-sm font-semibold text-[#F5F5F7]">{deliveryCalculatedData.internalCount}</div>
                    </div>
                    <div className="rounded-xl border border-[#242433] bg-[#0B0B0D] px-3 py-2">
                      <div className="text-[10px] uppercase tracking-[0.18em] text-[#8A8A96]">Externos</div>
                      <div className="mt-1 text-sm font-semibold text-[#F5F5F7]">{deliveryCalculatedData.externalCount}</div>
                    </div>
                  </div>

                  <div className="flex gap-2 overflow-x-auto">
                    <Chip active={deliveriesTab === 'overview'} onClick={() => setDeliveriesTab('overview')}>
                      Resumen
                    </Chip>
                    <Chip active={deliveriesTab === 'internal'} onClick={() => setDeliveriesTab('internal')}>
                      Internos
                    </Chip>
                    <Chip active={deliveriesTab === 'external'} onClick={() => setDeliveriesTab('external')}>
                      Externos
                    </Chip>
                    <Chip active={deliveriesTab === 'partners'} onClick={() => setDeliveriesTab('partners')}>
                      Partners
                    </Chip>
                  </div>
                </div>
              </div>

              {deliveriesTab === 'overview' ? (
                <>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-5">
                <Card title="Total Deliveries" className="p-3">
                  <StatRow label="Total" value={deliveryCalculatedData.totalDeliveries} />
                  <StatRow label="Costo" value={fmtUSD(deliveryCalculatedData.totalCostUsd)} highlightTone="brand" />
                </Card>

                <Card title="Internos" className="p-3">
                  <StatRow label="Deliveries" value={deliveryCalculatedData.internalCount} />
                  <StatRow label="Pago" value={fmtUSD(deliveryCalculatedData.internalCostUsd)} />
                </Card>

                <Card title="Externos" className="p-3">
                  <StatRow label="Deliveries" value={deliveryCalculatedData.externalCount} />
                  <StatRow label="Costo" value={fmtUSD(deliveryCalculatedData.externalCostUsd)} />
                </Card>

                <Card title="Sin snapshot" className="p-3">
                  <StatRow
                    label="Ã“rdenes"
                    value={deliveryCalculatedData.rows.filter((row) => row.costUsd <= 0).length}
                    highlightTone="warn"
                  />
                  <StatRow label="Sin asignar" value={deliveryCalculatedData.unassignedCount} highlightTone="warn" />
                </Card>

                <Card title="PerÃ­odo" className="p-3">
                  <StatRow label="Desde" value={advisorCalcDateFrom || 'â€”'} />
                  <StatRow label="Hasta" value={advisorCalcDateTo || 'â€”'} />
                </Card>
              </div>

              <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
                <div className="rounded-2xl border border-[#242433] bg-[#121218]">
                  <div className="flex items-center justify-between border-b border-[#242433] px-4 py-3">
                    <div className="text-sm font-semibold text-[#F5F5F7]">LiquidaciÃ³n Internos</div>
                    <div className="text-sm font-semibold text-[#FEEF00]">{fmtUSD(deliveryCalculatedData.internalCostUsd)}</div>
                  </div>
                  <div className="max-h-[320px] overflow-auto">
                    <table className="w-full text-[11px]">
                      <thead className="sticky top-0 z-10 bg-[#0B0B0D] text-[#B7B7C2]">
                        <tr>
                          <th className="px-3 py-2 text-left font-medium">Motorizado</th>
                          <th className="px-3 py-2 text-right font-medium">Deliveries</th>
                          <th className="px-3 py-2 text-right font-medium">Pago</th>
                        </tr>
                      </thead>
                      <tbody>
                        {deliveryCalculatedData.internalSummary.length === 0 ? (
                          <tr>
                            <td className="px-3 py-6 text-center text-[#B7B7C2]" colSpan={3}>
                              Sin deliveries internos en el perÃ­odo.
                            </td>
                          </tr>
                        ) : (
                          deliveryCalculatedData.internalSummary.map((row, idx) => (
                            <tr
                              key={row.key}
                              className={`${idx % 2 === 0 ? 'bg-[#121218]' : 'bg-[#151522]'} border-b border-[#242433]`}
                            >
                              <td className="px-3 py-2">{row.driverName}</td>
                              <td className="px-3 py-2 text-right">{row.deliveries}</td>
                              <td className="px-3 py-2 text-right">{fmtUSD(row.totalCostUsd)}</td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>

                <div className="rounded-2xl border border-[#242433] bg-[#121218]">
                  <div className="flex items-center justify-between border-b border-[#242433] px-4 py-3">
                    <div className="text-sm font-semibold text-[#F5F5F7]">AuditorÃ­a Externos</div>
                    <div className="text-sm font-semibold text-[#FEEF00]">{fmtUSD(deliveryCalculatedData.externalCostUsd)}</div>
                  </div>
                  <div className="max-h-[320px] overflow-auto">
                    <table className="w-full text-[11px]">
                      <thead className="sticky top-0 z-10 bg-[#0B0B0D] text-[#B7B7C2]">
                        <tr>
                          <th className="px-3 py-2 text-left font-medium">Empresa</th>
                          <th className="px-3 py-2 text-right font-medium">Deliveries</th>
                          <th className="px-3 py-2 text-right font-medium">Km</th>
                          <th className="px-3 py-2 text-right font-medium">Costo</th>
                        </tr>
                      </thead>
                      <tbody>
                        {deliveryCalculatedData.externalSummary.length === 0 ? (
                          <tr>
                            <td className="px-3 py-6 text-center text-[#B7B7C2]" colSpan={4}>
                              Sin deliveries externos en el perÃ­odo.
                            </td>
                          </tr>
                        ) : (
                          deliveryCalculatedData.externalSummary.map((row, idx) => (
                            <tr
                              key={row.key}
                              className={`${idx % 2 === 0 ? 'bg-[#121218]' : 'bg-[#151522]'} border-b border-[#242433]`}
                            >
                              <td className="px-3 py-2">{row.partnerName}</td>
                              <td className="px-3 py-2 text-right">{row.deliveries}</td>
                              <td className="px-3 py-2 text-right">{row.totalDistanceKm.toFixed(1)}</td>
                              <td className="px-3 py-2 text-right">{fmtUSD(row.totalCostUsd)}</td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>

              <div className="rounded-2xl border border-[#242433] bg-[#121218]">
                <div className="flex items-center justify-between border-b border-[#242433] px-4 py-3">
                  <div className="text-sm font-semibold text-[#F5F5F7]">Detalle de deliveries</div>
                  <div className="text-sm font-semibold text-[#FEEF00]">{deliveryCalculatedData.totalDeliveries}</div>
                </div>
                <div className="max-h-[420px] overflow-auto">
                  <table className="w-full text-[11px]">
                    <thead className="sticky top-0 z-10 bg-[#0B0B0D] text-[#B7B7C2]">
                      <tr>
                        <th className="px-3 py-2 text-left font-medium">Nro# Orden</th>
                        <th className="px-3 py-2 text-left font-medium">Cliente</th>
                        <th className="px-3 py-2 text-left font-medium">Ã­tem delivery</th>
                        <th className="px-3 py-2 text-left font-medium">Tipo</th>
                        <th className="px-3 py-2 text-left font-medium">AsignaciÃ³n</th>
                        <th className="px-3 py-2 text-right font-medium">Km</th>
                        <th className="px-3 py-2 text-right font-medium">Costo</th>
                      </tr>
                    </thead>
                    <tbody>
                      {deliveryCalculatedData.rows.length === 0 ? (
                        <tr>
                          <td className="px-3 py-6 text-center text-[#B7B7C2]" colSpan={7}>
                            Sin deliveries entregados en el perÃ­odo.
                          </td>
                        </tr>
                      ) : (
                        deliveryCalculatedData.rows.map((row, idx) => (
                          <tr
                            key={row.order.id}
                            className={`${idx % 2 === 0 ? 'bg-[#121218]' : 'bg-[#151522]'} border-b border-[#242433]`}
                              >
                                <td className="px-3 py-2">{fmtShortOrderLabel(row.order.id)}</td>
                                <td className="px-3 py-2">{row.order.clientName}</td>
                                <td className="px-3 py-2">{row.deliveryChargeLabel}</td>
                                <td className="px-3 py-2">
                                  {row.mode === 'internal'
                                    ? 'Interno'
                                : row.mode === 'external'
                                  ? 'Externo'
                                  : 'Sin asignar'}
                            </td>
                            <td className="px-3 py-2 leading-4">
                              <div className="text-[#F5F5F7]">
                                {row.mode === 'external' ? row.externalPartnerName : row.internalDriverName}
                              </div>
                              {row.costSource ? (
                                <div className="text-[#8A8A96]">{row.costSource}</div>
                              ) : null}
                            </td>
                            <td className="px-3 py-2 text-right">
                              {row.distanceKm != null ? row.distanceKm.toFixed(1) : '?'}
                            </td>
                            <td className="px-3 py-2 text-right">{fmtUSD(row.costUsd)}</td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
                </>
              ) : null}

              {deliveriesTab === 'internal' ? (
                <div className="space-y-4">
                  <div className="rounded-2xl border border-[#242433] bg-[#121218] p-4">
                    <div className="grid grid-cols-1 gap-3 md:grid-cols-[260px_180px_180px]">
                      <FieldSelect
                        label="Motorizado interno"
                        value={deliveryInternalDriverFilter}
                        onChange={setDeliveryInternalDriverFilter}
                        options={[
                          { value: '', label: 'Todos los motorizados' },
                          ...deliveryCalculatedData.internalSummary.map((row) => ({
                            value: row.key,
                            label: row.driverName,
                          })),
                        ]}
                      />
                      <div className="rounded-xl border border-[#242433] bg-[#0B0B0D] px-3 py-2">
                        <div className="text-[10px] uppercase tracking-[0.18em] text-[#8A8A96]">Deliveries</div>
                        <div className="mt-1 text-sm font-semibold text-[#F5F5F7]">
                          {filteredInternalDeliverySummary.reduce((sum, row) => sum + row.deliveries, 0)}
                        </div>
                      </div>
                      <div className="rounded-xl border border-[#242433] bg-[#0B0B0D] px-3 py-2">
                        <div className="text-[10px] uppercase tracking-[0.18em] text-[#8A8A96]">Total a pagar</div>
                        <div className="mt-1 text-sm font-semibold text-[#F5F5F7]">
                          {fmtUSD(filteredInternalDeliverySummary.reduce((sum, row) => sum + row.totalCostUsd, 0))}
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
                    <div className="rounded-2xl border border-[#242433] bg-[#121218]">
                      <div className="flex items-center justify-between border-b border-[#242433] px-4 py-3">
                        <div className="text-sm font-semibold text-[#F5F5F7]">LiquidaciÃ³n por motorizado</div>
                        <div className="text-sm font-semibold text-[#FEEF00]">
                          {fmtUSD(filteredInternalDeliverySummary.reduce((sum, row) => sum + row.totalCostUsd, 0))}
                        </div>
                      </div>
                      <div className="max-h-[320px] overflow-auto">
                        <table className="w-full text-[11px]">
                          <thead className="sticky top-0 z-10 bg-[#0B0B0D] text-[#B7B7C2]">
                            <tr>
                              <th className="px-3 py-2 text-left font-medium">Motorizado</th>
                              <th className="px-3 py-2 text-right font-medium">Deliveries</th>
                              <th className="px-3 py-2 text-right font-medium">Pago</th>
                            </tr>
                          </thead>
                          <tbody>
                            {filteredInternalDeliverySummary.length === 0 ? (
                              <tr>
                                <td className="px-3 py-6 text-center text-[#B7B7C2]" colSpan={3}>
                                  Sin resultados para ese motorizado.
                                </td>
                              </tr>
                            ) : (
                              filteredInternalDeliverySummary.map((row, idx) => (
                                <tr key={row.key} className={`${idx % 2 === 0 ? 'bg-[#121218]' : 'bg-[#151522]'} border-b border-[#242433]`}>
                                  <td className="px-3 py-2">{row.driverName}</td>
                                  <td className="px-3 py-2 text-right">{row.deliveries}</td>
                                  <td className="px-3 py-2 text-right">{fmtUSD(row.totalCostUsd)}</td>
                                </tr>
                              ))
                            )}
                          </tbody>
                        </table>
                      </div>
                    </div>

                    <div className="rounded-2xl border border-[#242433] bg-[#121218]">
                      <div className="flex items-center justify-between border-b border-[#242433] px-4 py-3">
                        <div className="text-sm font-semibold text-[#F5F5F7]">Detalle interno</div>
                        <div className="text-sm font-semibold text-[#FEEF00]">
                          {filteredDeliveryRows.filter((row) => row.mode === 'internal').length}
                        </div>
                      </div>
                      <div className="max-h-[320px] overflow-auto">
                        <table className="w-full text-[11px]">
                          <thead className="sticky top-0 z-10 bg-[#0B0B0D] text-[#B7B7C2]">
                            <tr>
                              <th className="px-3 py-2 text-left font-medium">Nro# Orden</th>
                              <th className="px-3 py-2 text-left font-medium">Cliente</th>
                              <th className="px-3 py-2 text-left font-medium">Ã­tem delivery</th>
                              <th className="px-3 py-2 text-right font-medium">Pago</th>
                            </tr>
                          </thead>
                          <tbody>
                            {filteredDeliveryRows.filter((row) => row.mode === 'internal').length === 0 ? (
                              <tr>
                                <td className="px-3 py-6 text-center text-[#B7B7C2]" colSpan={4}>
                                  Sin deliveries internos en el perÃ­odo.
                                </td>
                              </tr>
                            ) : (
                              filteredDeliveryRows.filter((row) => row.mode === 'internal').map((row, idx) => (
                                <tr key={row.order.id} className={`${idx % 2 === 0 ? 'bg-[#121218]' : 'bg-[#151522]'} border-b border-[#242433]`}>
                                  <td className="px-3 py-2">{fmtShortOrderLabel(row.order.id)}</td>
                                  <td className="px-3 py-2">{row.order.clientName}</td>
                                  <td className="px-3 py-2">{row.deliveryChargeLabel}</td>
                                  <td className="px-3 py-2 text-right">{fmtUSD(row.costUsd)}</td>
                                </tr>
                              ))
                            )}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </div>
                </div>
              ) : null}

              {deliveriesTab === 'external' ? (
                <div className="space-y-4">
                  <div className="rounded-2xl border border-[#242433] bg-[#121218] p-4">
                    <div className="grid grid-cols-1 gap-3 md:grid-cols-[260px_180px_180px]">
                      <FieldSelect
                        label="Empresa externa"
                        value={deliveryExternalPartnerFilter}
                        onChange={setDeliveryExternalPartnerFilter}
                        options={[
                          { value: '', label: 'Todas las empresas' },
                          ...deliveryCalculatedData.externalSummary.map((row) => ({
                            value: row.key,
                            label: row.partnerName,
                          })),
                        ]}
                      />
                      <div className="rounded-xl border border-[#242433] bg-[#0B0B0D] px-3 py-2">
                        <div className="text-[10px] uppercase tracking-[0.18em] text-[#8A8A96]">Deliveries</div>
                        <div className="mt-1 text-sm font-semibold text-[#F5F5F7]">
                          {filteredExternalDeliverySummary.reduce((sum, row) => sum + row.deliveries, 0)}
                        </div>
                      </div>
                      <div className="rounded-xl border border-[#242433] bg-[#0B0B0D] px-3 py-2">
                        <div className="text-[10px] uppercase tracking-[0.18em] text-[#8A8A96]">Total a pagar</div>
                        <div className="mt-1 text-sm font-semibold text-[#F5F5F7]">
                          {fmtUSD(filteredExternalDeliverySummary.reduce((sum, row) => sum + row.totalCostUsd, 0))}
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
                    <div className="rounded-2xl border border-[#242433] bg-[#121218]">
                      <div className="flex items-center justify-between border-b border-[#242433] px-4 py-3">
                        <div className="text-sm font-semibold text-[#F5F5F7]">AuditorÃ­a por empresa</div>
                        <div className="text-sm font-semibold text-[#FEEF00]">
                          {fmtUSD(filteredExternalDeliverySummary.reduce((sum, row) => sum + row.totalCostUsd, 0))}
                        </div>
                      </div>
                      <div className="max-h-[320px] overflow-auto">
                        <table className="w-full text-[11px]">
                          <thead className="sticky top-0 z-10 bg-[#0B0B0D] text-[#B7B7C2]">
                            <tr>
                              <th className="px-3 py-2 text-left font-medium">Empresa</th>
                              <th className="px-3 py-2 text-right font-medium">Deliveries</th>
                              <th className="px-3 py-2 text-right font-medium">Km</th>
                              <th className="px-3 py-2 text-right font-medium">Costo</th>
                            </tr>
                          </thead>
                          <tbody>
                            {filteredExternalDeliverySummary.length === 0 ? (
                              <tr>
                                <td className="px-3 py-6 text-center text-[#B7B7C2]" colSpan={4}>
                                  Sin resultados para esa empresa.
                                </td>
                              </tr>
                            ) : (
                              filteredExternalDeliverySummary.map((row, idx) => (
                                <tr key={row.key} className={`${idx % 2 === 0 ? 'bg-[#121218]' : 'bg-[#151522]'} border-b border-[#242433]`}>
                                  <td className="px-3 py-2">{row.partnerName}</td>
                                  <td className="px-3 py-2 text-right">{row.deliveries}</td>
                                  <td className="px-3 py-2 text-right">{row.totalDistanceKm.toFixed(1)}</td>
                                  <td className="px-3 py-2 text-right">{fmtUSD(row.totalCostUsd)}</td>
                                </tr>
                              ))
                            )}
                          </tbody>
                        </table>
                      </div>
                    </div>

                    <div className="rounded-2xl border border-[#242433] bg-[#121218]">
                      <div className="flex items-center justify-between border-b border-[#242433] px-4 py-3">
                        <div className="text-sm font-semibold text-[#F5F5F7]">Detalle externo</div>
                        <div className="text-sm font-semibold text-[#FEEF00]">
                          {filteredDeliveryRows.filter((row) => row.mode === 'external').length}
                        </div>
                      </div>
                      <div className="max-h-[320px] overflow-auto">
                        <table className="w-full text-[11px]">
                          <thead className="sticky top-0 z-10 bg-[#0B0B0D] text-[#B7B7C2]">
                            <tr>
                              <th className="px-3 py-2 text-left font-medium">Nro# Orden</th>
                              <th className="px-3 py-2 text-left font-medium">Cliente</th>
                              <th className="px-3 py-2 text-left font-medium">Ã­tem delivery</th>
                              <th className="px-3 py-2 text-right font-medium">Km</th>
                              <th className="px-3 py-2 text-right font-medium">Costo</th>
                            </tr>
                          </thead>
                          <tbody>
                            {filteredDeliveryRows.filter((row) => row.mode === 'external').length === 0 ? (
                              <tr>
                                <td className="px-3 py-6 text-center text-[#B7B7C2]" colSpan={5}>
                                  Sin deliveries externos en el perÃ­odo.
                                </td>
                              </tr>
                            ) : (
                              filteredDeliveryRows.filter((row) => row.mode === 'external').map((row, idx) => (
                                <tr key={row.order.id} className={`${idx % 2 === 0 ? 'bg-[#121218]' : 'bg-[#151522]'} border-b border-[#242433]`}>
                                  <td className="px-3 py-2">{fmtShortOrderLabel(row.order.id)}</td>
                                  <td className="px-3 py-2">{row.order.clientName}</td>
                                  <td className="px-3 py-2">{row.deliveryChargeLabel}</td>
                                  <td className="px-3 py-2 text-right">{row.distanceKm != null ? row.distanceKm.toFixed(1) : '?'}</td>
                                  <td className="px-3 py-2 text-right">{fmtUSD(row.costUsd)}</td>
                                </tr>
                              ))
                            )}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </div>
                </div>
              ) : null}

              {deliveriesTab === 'partners' ? (
                <div className="space-y-4">
                  <div className="flex justify-end">
                    <Btn
                      onClick={() => {
                        resetDeliveryPartnerForm();
                        setDeliveryPartnerCreateOpen(true);
                      }}
                    >
                      Nuevo partner externo
                    </Btn>
                  </div>

                  <div className="rounded-2xl border border-[#242433] bg-[#121218]">
                    <div className="flex items-center justify-between border-b border-[#242433] px-4 py-3">
                      <div className="text-sm font-semibold text-[#F5F5F7]">Partners externos</div>
                      <div className="text-sm font-semibold text-[#FEEF00]">{deliveryPartners.length}</div>
                    </div>
                    <div className="max-h-[420px] overflow-auto">
                      <table className="w-full text-[11px]">
                        <thead className="sticky top-0 z-10 bg-[#0B0B0D] text-[#B7B7C2]">
                          <tr>
                            <th className="px-3 py-2 text-left font-medium">Nombre</th>
                            <th className="px-3 py-2 text-left font-medium">Tipo</th>
                            <th className="px-3 py-2 text-left font-medium">WhatsApp</th>
                            <th className="px-3 py-2 text-left font-medium">Tarifas</th>
                            <th className="px-3 py-2 text-left font-medium">Estado</th>
                          </tr>
                        </thead>
                        <tbody>
                          {deliveryPartners.length === 0 ? (
                            <tr>
                              <td className="px-3 py-6 text-center text-[#B7B7C2]" colSpan={5}>
                                Sin partners externos cargados.
                              </td>
                            </tr>
                          ) : (
                            deliveryPartners.map((partner, idx) => (
                              <tr
                                key={partner.id}
                                className={`${idx % 2 === 0 ? 'bg-[#121218]' : 'bg-[#151522]'} cursor-pointer border-b border-[#242433] hover:bg-[#191926]`}
                                onClick={() => {
                                  setSelectedDeliveryPartnerId(partner.id);
                                  setDeliveryPartnerDetailOpen(true);
                                }}
                              >
                                <td className="px-3 py-2">{partner.name}</td>
                                <td className="px-3 py-2">{partner.partnerType || 'company_dispatch'}</td>
                                <td className="px-3 py-2">{partner.whatsappPhone || 'â€”'}</td>
                                <td className="px-3 py-2">
                                  {(partner.rates ?? []).filter((rate) => rate.isActive).length}
                                </td>
                                <td className="px-3 py-2">{partner.isActive ? 'Activo' : 'Inactivo'}</td>
                              </tr>
                            ))
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              ) : null}
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
      placeholder="Buscar nombre o SKU"
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

          {settingsTab === 'inventory' ? (
  <div className="space-y-5">
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-4">
      <div className="rounded-2xl border border-[#242433] bg-[#121218] p-4">
        <div className="text-sm font-semibold text-[#F5F5F7]">Items inventariables</div>
        <div className="mt-3 text-2xl font-semibold text-[#F5F5F7]">{inventorySummary.totalItems}</div>
        <div className="mt-1 text-xs text-[#8A8A96]">Productos con inventario activo</div>
      </div>

      <div className="rounded-2xl border border-[#242433] bg-[#121218] p-4">
        <div className="text-sm font-semibold text-[#F5F5F7]">Bajo stock</div>
        <div className="mt-3 text-2xl font-semibold text-[#FEEF00]">{inventorySummary.lowStock}</div>
        <div className="mt-1 text-xs text-[#8A8A96]">Por debajo del mÃ­nimo configurado</div>
      </div>

      <div className="rounded-2xl border border-[#242433] bg-[#121218] p-4">
        <div className="text-sm font-semibold text-[#F5F5F7]">Materias primas</div>
        <div className="mt-3 text-2xl font-semibold text-[#F5F5F7]">{inventorySummary.raw}</div>
        <div className="mt-1 text-xs text-[#8A8A96]">Tipo `raw_material`</div>
      </div>

      <div className="rounded-2xl border border-[#242433] bg-[#121218] p-4">
        <div className="text-sm font-semibold text-[#F5F5F7]">Bases preparadas</div>
        <div className="mt-3 text-2xl font-semibold text-[#F5F5F7]">{inventorySummary.bases}</div>
        <div className="mt-1 text-xs text-[#8A8A96]">Tipo `prepared_base`</div>
      </div>
    </div>

    <div className="flex flex-col gap-3 rounded-2xl border border-[#242433] bg-[#121218] p-3 md:flex-row md:items-end md:justify-between">
      <div className="grid flex-1 grid-cols-1 gap-3 md:grid-cols-[minmax(0,1fr)_220px]">
        <FieldInput
          label="Buscar item de inventario"
          value={inventorySearch}
          onChange={setInventorySearch}
          hint="Busca por nombre o por grupo."
        />
        <FieldSelect
          label="Grupo"
          value={inventoryGroupFilter}
          onChange={(value) =>
            setInventoryGroupFilter(
              (value || '') as '' | 'raw' | 'fried' | 'prefried' | 'sauces' | 'packaging' | 'other'
            )
          }
          options={[
            { value: '', label: 'Todos' },
            ...INVENTORY_GROUP_OPTIONS.map((option) => ({
              value: option.value,
              label: option.label,
            })),
          ]}
          hint="Filtra el inventario por familia."
        />
      </div>

      <div className="text-xs text-[#8A8A96] md:max-w-[280px]">
        El stock se guarda en unidades base y se muestra usando el empaque configurado del producto.
      </div>
      <button
        className="rounded-xl bg-[#FEEF00] px-4 py-2 text-sm font-semibold text-[#0B0B0D]"
        onClick={openInventoryItemCreateDrawer}
      >
        Nuevo item
      </button>
    </div>

    <div className="overflow-hidden rounded-2xl border border-[#242433] bg-[#121218]">
      <div className="max-h-[70vh] overflow-y-auto overflow-x-auto">
        <table className="w-full text-[12px]">
          <thead className="sticky top-0 z-10 border-b border-[#242433] bg-[#0B0B0D] text-[#B7B7C2]">
            <tr>
              <th className="px-3 py-3 text-left font-medium">ID</th>
              <th className="px-3 py-3 text-left font-medium">Item</th>
              <th className="px-3 py-3 text-left font-medium">Grupo</th>
              <th className="px-3 py-3 text-left font-medium">Tipo</th>
              <th className="px-3 py-3 text-left font-medium">Empaque</th>
              <th className="px-3 py-3 text-left font-medium">Stock actual</th>
              <th className="px-3 py-3 text-left font-medium">MÃ­nimo</th>
              <th className="px-3 py-3 text-left font-medium">Ãšltimo movimiento</th>
            </tr>
          </thead>
          <tbody>
            {filteredInventoryItems.length === 0 ? (
              <tr>
                <td className="px-3 py-6 text-center text-[#B7B7C2]" colSpan={8}>
                  No hay items de inventario que coincidan con el filtro.
                </td>
              </tr>
            ) : (
              filteredInventoryItems.map((item, idx) => {
                const zebra = idx % 2 === 0 ? 'bg-[#121218]' : 'bg-[#151522]';
                const latestMovement = (inventoryMovementsByItemId.get(item.id) ?? [])[0] ?? null;
                const availability = inventoryAvailabilityByItemId.get(item.id) ?? {
                  readyUnits: item.currentStockUnits,
                  potentialUnits: 0,
                  totalUnits: item.currentStockUnits,
                };
                const isLow =
                  item.lowStockThreshold != null &&
                  availability.totalUnits <= item.lowStockThreshold;

                return (
                  <tr
                    key={item.id}
                    className={`${zebra} cursor-pointer border-b border-[#242433] align-top transition-colors hover:bg-[#1A1A24]`}
                    onClick={() => openInventoryMovementDrawer(item.id)}
                  >
                    <td className="px-3 py-3 text-[#8A8A96]">{item.id}</td>
                    <td className="px-3 py-3">
                      <div className="font-semibold text-[#F5F5F7]">{item.name}</div>
                      <div className="mt-1 text-[11px] text-[#8A8A96]">{item.unitName}</div>
                    </td>
                    <td className="px-3 py-3">
                      <SmallBadge label={INVENTORY_GROUP_LABEL[item.inventoryGroup]} tone="brand" />
                    </td>
                    <td className="px-3 py-3">
                      <SmallBadge label={INVENTORY_KIND_LABEL[item.inventoryKind]} tone="muted" />
                    </td>
                    <td className="px-3 py-3 text-[#B7B7C2]">
                      {item.packagingName && item.packagingSize
                        ? `${item.packagingName} x ${item.packagingSize}`
                        : 'Sin empaque'}
                    </td>
                    <td className="px-3 py-3">
                      <div className={`font-medium ${isLow ? 'text-[#FEEF00]' : 'text-[#F5F5F7]'}`}>
                        {fmtInventoryUnits(
                          availability.readyUnits,
                          item.packagingName,
                          item.packagingSize,
                          item.unitName
                        )}
                      </div>
                      <div className="mt-1 text-[11px] text-[#8A8A96]">
                        Listo: {availability.readyUnits} {item.unitName}{availability.readyUnits === 1 ? '' : 's'}
                      </div>
                      {availability.potentialUnits > 0 ? (
                        <div className="mt-1 text-[11px] text-emerald-400">
                          Puede reponerse: {Number(availability.potentialUnits.toFixed(3))} {item.unitName}
                          {availability.potentialUnits === 1 ? '' : 's'}
                        </div>
                      ) : null}
                      <div className="mt-1 text-[11px] text-[#8A8A96]">
                        Total posible: {Number(availability.totalUnits.toFixed(3))} {item.unitName}
                        {availability.totalUnits === 1 ? '' : 's'}
                      </div>
                    </td>
                    <td className="px-3 py-3 text-[#B7B7C2]">
                      {item.lowStockThreshold != null
                        ? (
                          <>
                            <div className="text-[#F5F5F7]">
                              {fmtInventoryUnits(
                                item.lowStockThreshold,
                                item.packagingName,
                                item.packagingSize,
                                item.unitName
                              )}
                            </div>
                            <div className="mt-1 text-[11px] text-[#8A8A96]">
                              Total: {item.lowStockThreshold} {item.unitName}{item.lowStockThreshold === 1 ? '' : 's'}
                            </div>
                          </>
                        )
                        : 'â€”'}
                    </td>
                    <td className="px-3 py-3 text-[#B7B7C2]">
                      {latestMovement ? (
                        <div>
                          <div className="text-[#F5F5F7]">{INVENTORY_MOVEMENT_LABEL[latestMovement.movementType] || latestMovement.movementType}</div>
                          <div className="mt-1 text-[11px] text-[#8A8A96]">
                            {fmtDateTimeES(latestMovement.createdAt)}
                          </div>
                        </div>
                      ) : (
                        'Sin movimientos'
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
        value={activeExchangeRate ? fmtRateBs(activeExchangeRate.rateBsPerUsd) : '?'}
      />
      <InfoCell
        label="Vigente desde"
        value={activeExchangeRate ? fmtDateTimeES(activeExchangeRate.effectiveAt) : '?'}
      />
    </div>
  </div>

  <div className="rounded-2xl border border-[#242433] bg-[#121218] p-4">
    <div className="text-sm font-semibold text-[#F5F5F7]">Actualizar tasa</div>

    <div className="mt-2 text-sm text-[#B7B7C2]">
      Esta tasa recalcula precios base en el catÃ¡logo segÃºn la lÃ³gica actual.
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
        <Btn onClick={() => openMoneyMovementDrawer()}>Movimiento</Btn>
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
                    <td className="px-3 py-3">{account.institutionName || 'â€”'}</td>
                    <td className="px-3 py-3">{account.ownerName || 'â€”'}</td>
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
          <InfoCell label="Con facturaciÃ³n" value={String(clientStats.withBilling)} />
          <InfoCell label="Con nota de entrega" value={String(clientStats.withDeliveryNote)} />
          <InfoCell label="Con direcciones" value={String(clientStats.withAddresses)} />
        </div>
      </div>

      <div className="rounded-2xl border border-[#242433] bg-[#121218] p-4">
        <div className="text-sm font-semibold text-[#F5F5F7]">CÃ³mo usarlo</div>
        <div className="mt-4 space-y-2 text-sm text-[#B7B7C2]">
          <div>Guarda aquÃ­ la ficha base del cliente, sus etiquetas CRM y los datos para factura o nota de entrega.</div>
          <div>Las etiquetas se cargan libres, separadas por coma, para que ustedes mismos creen las categorÃ­as que usan en la operaciÃ³n.</div>
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
              <th className="px-3 py-3 text-left font-medium">TelÃ©fono</th>
              <th className="px-3 py-3 text-left font-medium">Tipo</th>
              <th className="px-3 py-3 text-left font-medium">Asesor principal</th>
              <th className="px-3 py-3 text-left font-medium">Fondo USD</th>
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
                <td className="px-3 py-6 text-center text-[#B7B7C2]" colSpan={10}>
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
                    <td className="px-3 py-3">{fmtClientTypeLabel(client.clientType)}</td>
                    <td className="px-3 py-3">
                      {client.primaryAdvisorId
                        ? advisorNameById.get(client.primaryAdvisorId) || 'Asesor'
                        : '—'}
                    </td>
                    <td className="px-3 py-3">
                      {client.fundBalanceUsd > 0.005 ? fmtUSD(client.fundBalanceUsd) : '—'}
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

          {settingsTab === 'adjustments' && isAdmin ? (
  <div className="space-y-5">
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-2 2xl:grid-cols-4">
      <div className="rounded-2xl border border-[#242433] bg-[#121218] p-4">
        <div className="text-sm font-semibold text-[#F5F5F7]">Resumen ajustes</div>
        <div className="mt-4 grid grid-cols-2 gap-3">
          <InfoCell label="Eventos" value={String(adjustmentsSummary.total)} />
          <InfoCell label="Overrides" value={String(adjustmentsSummary.priceOverrides)} />
          <InfoCell label="Impacto neto" value={fmtUSD(adjustmentsSummary.netUsd)} />
          <InfoCell label="Costo asumido" value={fmtUSD(adjustmentsSummary.negativeUsd)} />
        </div>
      </div>

      <div className="rounded-2xl border border-[#242433] bg-[#121218] p-4">
        <div className="text-sm font-semibold text-[#F5F5F7]">CÃ³mo leerlo</div>
        <div className="mt-4 space-y-2 text-sm text-[#B7B7C2]">
          <div>AquÃ­ ves todos los ajustes administrativos registrados en las Ã“rdenes cargadas en el dashboard.</div>
          <div>Un impacto negativo significa que la empresa asumiÃ³ un descuento o cortesÃ­a.</div>
          <div>Un impacto positivo significa un recargo o aumento sobre el valor original.</div>
        </div>
      </div>
    </div>

    <div className="rounded-2xl border border-[#242433] bg-[#121218] p-3">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
        <FieldInput label="Desde" value={adjustmentsDateFrom} onChange={setAdjustmentsDateFrom} type="date" />
        <FieldInput label="Hasta" value={adjustmentsDateTo} onChange={setAdjustmentsDateTo} type="date" />
        <FieldSelect
          label="Admin"
          value={adjustmentsAdminFilter}
          onChange={setAdjustmentsAdminFilter}
          options={[
            { value: '', label: 'Todos' },
            ...adjustmentAdminOptions,
          ]}
        />
        <FieldSelect
          label="Tipo"
          value={adjustmentsTypeFilter}
          onChange={setAdjustmentsTypeFilter}
          options={[
            { value: '', label: 'Todos' },
            ...adjustmentTypeOptions.map((value) => ({
              value,
              label: value === 'item_price_override' ? 'Ajuste de precio por Ã­tem' : value,
            })),
          ]}
        />
      </div>
    </div>

    <div className="overflow-hidden rounded-2xl border border-[#242433] bg-[#121218]">
      <div className="max-h-[70vh] overflow-y-auto overflow-x-auto">
        <table className="w-full text-[12px]">
          <thead className="sticky top-0 z-10 border-b border-[#242433] bg-[#0B0B0D] text-[#B7B7C2]">
            <tr>
              <th className="px-3 py-3 text-left font-medium">Fecha</th>
              <th className="px-3 py-3 text-left font-medium">Admin</th>
              <th className="px-3 py-3 text-left font-medium">Nro# Orden</th>
              <th className="px-3 py-3 text-left font-medium">Cliente</th>
              <th className="px-3 py-3 text-left font-medium">Tipo</th>
              <th className="px-3 py-3 text-left font-medium">Detalle</th>
              <th className="px-3 py-3 text-left font-medium">Motivo</th>
              <th className="px-3 py-3 text-left font-medium">Impacto</th>
            </tr>
          </thead>
          <tbody>
            {filteredSettingsAdjustments.length === 0 ? (
              <tr>
                <td className="px-3 py-6 text-center text-[#B7B7C2]" colSpan={8}>
                  No hay ajustes que coincidan con el filtro.
                </td>
              </tr>
            ) : (
              filteredSettingsAdjustments.map((row, idx) => {
                const zebra = idx % 2 === 0 ? 'bg-[#121218]' : 'bg-[#151522]';

                return (
                  <tr
                    key={row.id}
                    className={`${zebra} cursor-pointer border-b border-[#242433] align-top transition-colors hover:bg-[#1A1A28]`}
                    onClick={() => openOrderPanel(row.orderId, 'ajustes')}
                  >
                    <td className="px-3 py-3">{fmtDateTimeES(row.createdAt)}</td>
                    <td className="px-3 py-3">{row.createdByName}</td>
                    <td className="px-3 py-3">{row.orderNumber}</td>
                    <td className="px-3 py-3">{row.clientName}</td>
                    <td className="px-3 py-3">
                      {row.adjustmentKind === 'admin_full_edit'
                        ? 'ModificaciÃ³n admin'
                        : row.adjustmentKind === 'rounding_writeoff' || row.adjustmentKind === 'rounding_gain_close'
                          ? 'Cierre por redondeo'
                          : row.adjustmentType === 'item_price_override'
                          ? 'Ajuste de precio'
                          : row.adjustmentType}
                    </td>
                    <td className="px-3 py-3">
                      <div className="text-[#F5F5F7]">
                        {row.adjustmentKind === 'admin_full_edit'
                          ? row.changedFieldLabels.length > 0
                            ? row.changedFieldLabels.join(', ')
                            : 'ModificaciÃ³n auditada'
                          : row.adjustmentKind === 'rounding_writeoff' || row.adjustmentKind === 'rounding_gain_close'
                            ? 'Total ajustado al monto confirmado'
                            : row.productName}
                      </div>
                      {row.adjustmentKind === 'admin_full_edit' ? null : (
                        <div className="mt-1 text-[11px] text-[#8A8A96]">
                          {fmtUSD(row.originalUnitUsd)} ? {fmtUSD(row.overrideUnitUsd)}
                          {row.qty > 0 ? ` ? x${row.qty}` : ''}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-3">
                      <div className="max-w-[280px] text-[#F5F5F7]">{row.reason || 'â€”'}</div>
                      {row.notes ? (
                        <div className="mt-1 text-[11px] text-[#8A8A96]">{row.notes}</div>
                      ) : null}
                    </td>
                    <td className="px-3 py-3">
                      <span className={row.deltaUsd < 0 ? 'text-orange-400' : row.deltaUsd > 0 ? 'text-emerald-400' : 'text-[#B7B7C2]'}>
                        {row.deltaUsd > 0 ? '+' : ''}{fmtUSD(row.deltaUsd)}
                      </span>
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
                  <div className="mt-1 text-xs text-[#B7B7C2]">Asesor: {repairDisplayText(n.advisorName)}</div>

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

      <Drawer
        open={productsExpanded}
        title={`Productos comprometidos · ${committedProductsScope === 'day' ? 'Día' : 'Semana'}`}
        onClose={() => setProductsExpanded(false)}
        widthClass="w-[460px]"
      >
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1">
              <button
                className={[
                  'rounded-full border px-2 py-0.5 text-[10px]',
                  committedProductsScope === 'day'
                    ? 'border-[#FEEF00] bg-[#191926] text-[#F5F5F7]'
                    : 'border-[#242433] bg-[#0B0B0D] text-[#8A8A96]',
                ].join(' ')}
                onClick={() => setCommittedProductsScope('day')}
                type="button"
              >
                Día
              </button>
              <button
                className={[
                  'rounded-full border px-2 py-0.5 text-[10px]',
                  committedProductsScope === 'week'
                    ? 'border-[#FEEF00] bg-[#191926] text-[#F5F5F7]'
                    : 'border-[#242433] bg-[#0B0B0D] text-[#8A8A96]',
                ].join(' ')}
                onClick={() => setCommittedProductsScope('week')}
                type="button"
              >
                Semana
              </button>
            </div>
          </div>

          <div className="flex items-center gap-1">
            <button
              className={[
                'rounded-full border px-2 py-0.5 text-[10px]',
                committedProductsBucket === 'products'
                  ? 'border-[#FEEF00] bg-[#191926] text-[#F5F5F7]'
                  : 'border-[#242433] bg-[#0B0B0D] text-[#8A8A96]',
              ].join(' ')}
              onClick={() => setCommittedProductsBucket('products')}
              type="button"
            >
              Productos
            </button>
            <button
              className={[
                'rounded-full border px-2 py-0.5 text-[10px]',
                committedProductsBucket === 'sauces'
                  ? 'border-[#FEEF00] bg-[#191926] text-[#F5F5F7]'
                  : 'border-[#242433] bg-[#0B0B0D] text-[#8A8A96]',
              ].join(' ')}
              onClick={() => setCommittedProductsBucket('sauces')}
              type="button"
            >
              Salsas
            </button>
            <button
              className={[
                'rounded-full border px-2 py-0.5 text-[10px]',
                committedProductsBucket === 'beverages'
                  ? 'border-[#FEEF00] bg-[#191926] text-[#F5F5F7]'
                  : 'border-[#242433] bg-[#0B0B0D] text-[#8A8A96]',
              ].join(' ')}
              onClick={() => setCommittedProductsBucket('beverages')}
              type="button"
            >
              Bebidas
            </button>
          </div>

          {committedProductsDetailRows.length === 0 ? (
            <div className="text-xs text-[#B7B7C2]">Sin datos para este período.</div>
          ) : (
            <div className="space-y-1.5">
              {committedProductsDetailRows.map((product) => {
                return (
                  <div
                    key={product.name}
                    className="rounded-lg border border-[#242433] bg-[#121218] px-2.5 py-1.5 text-[11px]"
                  >
                    <div className="flex items-center gap-2">
                      <div className="min-w-0 flex-1 truncate font-medium text-[#F5F5F7]">{product.name}</div>
                      <div className="shrink-0 text-[#FEEF00]">{fmtUnitsValue(product.und)}</div>
                      <div className="shrink-0 text-[#8A8A96]">
                        / {product.currentUnits != null ? fmtUnitsValue(product.currentUnits) : '—'}
                      </div>
                      <div
                        className={[
                          'shrink-0',
                          product.remainingUnits != null && product.remainingUnits <= 0
                            ? 'text-orange-400'
                            : 'text-[#B7B7C2]',
                        ].join(' ')}
                      >
                        ({product.remainingUnits != null ? fmtUnitsValue(product.remainingUnits) : '—'})
                      </div>
                      {product.statusLabel ? (
                        <div
                          className={[
                            'shrink-0 text-[10px] font-semibold',
                            product.statusTone === 'warn' ? 'text-orange-400' : 'text-[#FEEF00]',
                          ].join(' ')}
                        >
                          {product.statusLabel}
                        </div>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </Drawer>

      <Drawer
        open={taskPanelOpen}
        title={
          taskPanelKind === 'approve'
            ? 'Pedidos por aprobar'
            : taskPanelKind === 'reapprove'
              ? 'Pedidos para reaprobar'
              : taskPanelKind === 'kitchen'
                ? 'Pedidos para enviar a cocina'
                : 'Pedidos para asignar driver'
        }
        onClose={() => setTaskPanelOpen(false)}
        widthClass="w-[520px]"
      >
        {(
          taskPanelKind === 'approve'
            ? urgentTaskBuckets.approve
            : taskPanelKind === 'reapprove'
              ? urgentTaskBuckets.reapprove
              : taskPanelKind === 'kitchen'
                ? urgentTaskBuckets.kitchen
                : urgentTaskBuckets.driver
        ).length === 0 ? (
          <div className="text-sm text-[#B7B7C2]">Sin pedidos en esta tarea.</div>
        ) : (
          <div className="space-y-3">
            {(
              taskPanelKind === 'approve'
                ? urgentTaskBuckets.approve
                : taskPanelKind === 'reapprove'
                  ? urgentTaskBuckets.reapprove
                  : taskPanelKind === 'kitchen'
                    ? urgentTaskBuckets.kitchen
                    : urgentTaskBuckets.driver
            ).map((order) => (
              <button
                key={order.id}
                className="w-full rounded-2xl border border-[#242433] bg-[#121218] p-3 text-left hover:border-[#FEEF00]/40"
                onClick={() => {
                  setTaskPanelOpen(false);
                  openOrderPanel(order.id, order.fulfillment === 'delivery' ? 'entrega' : 'detalle');
                }}
                type="button"
              >
                <div className="flex items-center justify-between gap-2">
          <div className="font-semibold text-[#F5F5F7]">#{order.id} · {order.clientName}</div>
                  <div className="text-xs text-[#8A8A96]">{fmtDeliveryTextES(order.deliveryAtISO)}</div>
                </div>
                <div className="mt-1 text-xs text-[#B7B7C2]">
                  {repairDisplayText(order.advisorName)} · {ORDER_STATUS_LABEL[order.status]}
                </div>
              </button>
            ))}
          </div>
        )}
      </Drawer>

      <Drawer
        open={paymentsPanelOpen}
        title={
          paymentsPanelKind === 'pending'
            ? 'Pagos por confirmar'
            : paymentsPanelKind === 'confirmed'
              ? 'Pagos confirmados'
              : 'Pagos rechazados'
        }
        onClose={() => setPaymentsPanelOpen(false)}
        widthClass="w-[520px]"
      >
        {(
          paymentsPanelKind === 'pending'
            ? paymentBuckets.pending
            : paymentsPanelKind === 'confirmed'
              ? paymentBuckets.confirmed
              : paymentBuckets.rejected
        ).length === 0 ? (
          <div className="text-sm text-[#B7B7C2]">Sin pedidos en este estado.</div>
        ) : (
          <div className="space-y-3">
            {(
              paymentsPanelKind === 'pending'
                ? paymentBuckets.pending
                : paymentsPanelKind === 'confirmed'
                  ? paymentBuckets.confirmed
                  : paymentBuckets.rejected
            ).map((order) => (
              <button
                key={order.id}
                className="w-full rounded-2xl border border-[#242433] bg-[#121218] p-3 text-left hover:border-[#FEEF00]/40"
                onClick={() => {
                  setPaymentsPanelOpen(false);
                  openOrderPanel(order.id, 'pagos');
                }}
                type="button"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="font-semibold text-[#F5F5F7]">#{order.id} · {order.clientName}</div>
                  <div className="text-xs text-[#8A8A96]">{fmtDeliveryTextES(order.deliveryAtISO)}</div>
                </div>
                <div className="mt-1 text-xs text-[#B7B7C2]">
                  {repairDisplayText(order.advisorName)} · Pago · {order.paymentVerify === 'pending'
                    ? 'Por confirmar'
                    : order.paymentVerify === 'confirmed'
                      ? 'Confirmado'
                      : 'Rechazado'}
                </div>
              </button>
            ))}
          </div>
        )}
      </Drawer>

      <Drawer
        open={deliveryPanelOpen}
        title={deliveryPanelKind === 'internal' ? 'Deliveries internos' : 'Deliveries externos'}
        onClose={() => setDeliveryPanelOpen(false)}
        widthClass="w-[520px]"
      >
        {(deliveryPanelKind === 'internal' ? deliveryBuckets.internal : deliveryBuckets.external).length === 0 ? (
          <div className="text-sm text-[#B7B7C2]">Sin pedidos en este estado.</div>
        ) : (
          <div className="space-y-3">
            {(deliveryPanelKind === 'internal' ? deliveryBuckets.internal : deliveryBuckets.external).map((order) => (
              <button
                key={order.id}
                className="w-full rounded-2xl border border-[#242433] bg-[#121218] p-3 text-left hover:border-[#FEEF00]/40"
                onClick={() => {
                  setDeliveryPanelOpen(false);
                  openOrderPanel(order.id, 'entrega');
                }}
                type="button"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="font-semibold text-[#F5F5F7]">#{order.id} · {order.clientName}</div>
                  <div className="text-xs text-[#8A8A96]">{fmtDeliveryTextES(order.deliveryAtISO)}</div>
                </div>
                <div className="mt-1 text-xs text-[#B7B7C2]">
                  {repairDisplayText(order.advisorName)} · {deliveryPanelKind === 'internal'
                    ? `Interno: ${order.riderName || 'Asignado'}`
                    : `Externo: ${order.externalPartner || 'Asignado'}`}
                </div>
              </button>
            ))}
          </div>
        )}
      </Drawer>

      <Drawer
        open={kitchenPanelOpen}
        title={
          kitchenPanelKind === 'total'
            ? 'Pedidos en cocina'
            : kitchenPanelKind === 'pending_take'
              ? 'Pedidos por tomar'
              : kitchenPanelKind === 'preparing'
                ? 'Pedidos en preparación'
                : 'Pedidos preparados'
        }
        onClose={() => setKitchenPanelOpen(false)}
        widthClass="w-[520px]"
      >
        {(
          kitchenPanelKind === 'total'
            ? kitchenBuckets.total
            : kitchenPanelKind === 'pending_take'
              ? kitchenBuckets.pending_take
              : kitchenPanelKind === 'preparing'
                ? kitchenBuckets.preparing
                : kitchenBuckets.ready
        ).length === 0 ? (
          <div className="text-sm text-[#B7B7C2]">Sin pedidos en este estado.</div>
        ) : (
          <div className="space-y-3">
            {(
              kitchenPanelKind === 'total'
                ? kitchenBuckets.total
                : kitchenPanelKind === 'pending_take'
                  ? kitchenBuckets.pending_take
                  : kitchenPanelKind === 'preparing'
                    ? kitchenBuckets.preparing
                    : kitchenBuckets.ready
            ).map((order) => (
              <button
                key={order.id}
                className="w-full rounded-2xl border border-[#242433] bg-[#121218] p-3 text-left hover:border-[#FEEF00]/40"
                onClick={() => {
                  setKitchenPanelOpen(false);
                  openOrderPanel(order.id, 'detalle');
                }}
                type="button"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="font-semibold text-[#F5F5F7]">#{order.id} · {order.clientName}</div>
                  <div className="text-xs text-[#8A8A96]">{fmtDeliveryTextES(order.deliveryAtISO)}</div>
                </div>
                <div className="mt-1 text-xs text-[#B7B7C2]">
                  {repairDisplayText(order.advisorName)} · {ORDER_STATUS_LABEL[order.status]}
                </div>
              </button>
            ))}
          </div>
        )}
      </Drawer>

      <Drawer
        open={catalogDetailOpen}
        title={selectedCatalogItem ? selectedCatalogItem.name : 'Detalle de producto'}
        onClose={closeCatalogDetail}
        widthClass="w-[860px]"
        headerActions={
          selectedCatalogItem ? (
            catalogEditMode ? (
              <>
                <button
                  className="rounded-xl border border-[#242433] bg-[#121218] px-3 py-1.5 text-sm text-[#F5F5F7]"
                  onClick={() => setCatalogEditMode(false)}
                  disabled={catalogSaving}
                  type="button"
                >
                  Cancelar
                </button>
                <button
                  className="rounded-xl bg-[#FEEF00] px-3 py-1.5 text-sm font-semibold text-[#0B0B0D]"
                  onClick={handleSaveCatalog}
                  disabled={catalogSaving}
                  type="button"
                >
                  {catalogSaving ? 'Guardando...' : 'Guardar'}
                </button>
              </>
            ) : (
              <>
                <button
                  className="rounded-xl border border-[#242433] bg-[#121218] px-3 py-1.5 text-sm text-[#F5F5F7]"
                  onClick={() => setCatalogEditMode(true)}
                  type="button"
                >
                  Editar
                </button>
                <button
                  className="rounded-xl border border-[#242433] bg-[#121218] px-3 py-1.5 text-sm text-[#F5F5F7]"
                  onClick={handleToggleCatalogItemActive}
                  type="button"
                >
                  {selectedCatalogItem.isActive ? 'Desactivar' : 'Activar'}
                </button>
                <button
                  className="rounded-xl border border-red-500 bg-[#121218] px-3 py-1.5 text-sm text-red-400"
                  onClick={handleDeleteCatalogItem}
                  type="button"
                >
                  Eliminar
                </button>
              </>
            )
          ) : null
        }
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
                    </div>

                    <div className="mt-3 text-sm text-[#B7B7C2]">
                      {selectedOperationalModel.summary}
                    </div>

                    <div className="mt-4 grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
                      <InfoCell label="Comp. fijos" value={String(editFixedComponents.length)} />
                      <InfoCell label="Comp. seleccionables" value={String(editSelectableComponents.length)} />
                      <InfoCell label="Und fijas" value={String(editFixedUnitsCount)} />
                      <InfoCell label="Und seleccionables" value={String(editSelectableUnitsCount)} />
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
                      <InfoCell
                        label="Descuento inventario"
                        value={
                          selectedCatalogItem.inventoryDeductionMode === 'composition'
                            ? 'Por composición'
                            : 'A sí mismo'
                        }
                      />
                      <InfoCell label="Detalle editable" value={selectedCatalogItem.isDetailEditable ? 'Sí' : 'No'} />
                      <InfoCell label="Límite detalle" value={String(selectedCatalogItem.detailUnitsLimit)} />
                      <InfoCell
                        label="Comp. combo"
                        value={selectedCatalogItem.isComboComponentSelectable ? 'Sí' : 'No'}
                      />
                      <InfoCell
                        label="Inventario"
                        value={selectedCatalogItem.inventoryEnabled ? 'Activo' : 'No aplica'}
                      />
                    </div>

                    <div className="mt-3 rounded-xl border border-[#242433] bg-[#121218] px-3 py-2.5 text-sm text-[#B7B7C2]">
                      {selectedCatalogItem.inventoryDeductionMode === 'composition'
                        ? 'Descuenta por composición y baja el inventario interno configurado en su receta.'
                        : 'Descuenta a sí mismo y baja el inventario de este mismo producto.'}
                    </div>

                    {editIsDetailEditable ? (
                      <div className="mt-3 rounded-xl border border-[#242433] bg-[#121218] px-3 py-2.5 text-sm text-[#B7B7C2]">
                        <span className="text-[#F5F5F7]">Límite actual:</span>{' '}
                        {editDetailUnitsLimit || '0'} piezas seleccionables
                      </div>
                    ) : null}
                  </div>
                </div>

                <div className="rounded-2xl border border-[#242433] bg-[#121218] p-4">
  <div className="flex items-center justify-between gap-3">
    <div className="text-sm font-semibold text-[#F5F5F7]">Regla operativa</div>
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
                  <div className="text-sm font-semibold text-[#F5F5F7]">Inventario</div>
                    <div className="mt-4 space-y-4">
                      <label className="flex items-center gap-2 text-sm text-[#F5F5F7]">
                        <input
                          type="checkbox"
                          checked={editInventoryEnabled}
                        onChange={(e) => setEditInventoryEnabled(e.target.checked)}
                      />
                      Inventario activo
                    </label>

                    <div className="grid grid-cols-2 gap-3">
                      <FieldSelect
                        label="Tipo inventario"
                        value={editInventoryKind}
                        onChange={(v) =>
                          setEditInventoryKind(v as 'raw_material' | 'prepared_base' | 'finished_good')
                        }
                        options={[
                          { value: 'finished_good', label: 'Producto final' },
                          { value: 'prepared_base', label: 'Base preparada' },
                          { value: 'raw_material', label: 'Materia prima' },
                        ]}
                      />
                      <FieldSelect
                        label="Modo de descuento"
                        value={editInventoryDeductionMode}
                        onChange={(v) => setEditInventoryDeductionMode(v as 'self' | 'composition')}
                        hint={
                          editInventoryDeductionMode === 'composition'
                            ? 'Este producto baja stock de un item interno distinto.'
                            : 'La venta bajará stock de este mismo producto.'
                        }
                        options={[
                          { value: 'self', label: 'A sí mismo' },
                          { value: 'composition', label: 'Por composición' },
                        ]}
                      />
                      <FieldInput
                        label="Unidad base"
                        value={editInventoryUnitName}
                        onChange={setEditInventoryUnitName}
                        hint="Ejemplo: pieza, kg, bandeja o vasito."
                      />
                    </div>
                    {editInventoryEnabled && editInventoryDeductionMode === 'composition' ? (
                      <div className="rounded-2xl border border-[#242433] bg-[#0B0B0D] p-3">
                        <div className="flex items-center justify-between gap-3">
                            <div>
                              <div className="text-sm font-semibold text-[#F5F5F7]">Descuenta de inventario interno</div>
                              <div className="mt-1 text-xs text-[#8A8A96]">
                              Si este producto ya descuenta por su composición comercial, puedes dejar esta sección vacía. Úsala solo cuando necesites una receta fija interna.
                              </div>
                            </div>
                          <button
                            type="button"
                            className="rounded-xl border border-[#242433] bg-[#121218] px-3 py-2 text-sm"
                            onClick={addEditInventoryLink}
                          >
                            Agregar item
                          </button>
                        </div>
                        <div className="mt-3 space-y-3">
                          {editInventoryLinks.length === 0 ? (
                            <div className="rounded-xl border border-dashed border-[#242433] px-3 py-3 text-sm text-[#8A8A96]">
                              Déjala vacía si el producto baja inventario desde sus componentes. Si no, agrega aquí el item real y su cantidad fija.
                            </div>
                          ) : (
                            editInventoryLinks.map((row) => (
                              <div key={row.localId} className="rounded-xl border border-[#242433] bg-[#121218] p-3">
                                <div className="grid grid-cols-1 gap-3 md:grid-cols-[minmax(0,1.4fr)_140px_auto]">
                                  <FieldSelect
                                    label="Item interno"
                                    value={String(row.inventoryItemId || '')}
                                    onChange={(v) =>
                                      updateEditInventoryLink(row.localId, {
                                        inventoryItemId: Number(v || 0),
                                      })
                                    }
                                    options={inventoryItemOptions}
                                    hint="Aquí eliges el stock real que va a bajar."
                                  />
                                  <FieldInput
                                    label="Cantidad"
                                    value={String(row.quantityUnits ?? '')}
                                    onChange={(value) =>
                                      updateEditInventoryLink(row.localId, {
                                        quantityUnits: value,
                                      })
                                    }
                                    type="text"
                                    hint="Acepta decimales. Si un servicio trae 25 piezas, va 25. Si una salsa de 5 oz consume 1/8 de una base, va 0.125."
                                  />
                                  <div className="flex items-end">
                                    <button
                                      type="button"
                                      className="w-full rounded-xl border border-[#5A2626] bg-[#120B0B] px-3 py-2 text-sm text-[#F5B7B7]"
                                      onClick={() => removeEditInventoryLink(row.localId)}
                                    >
                                      Quitar
                                    </button>
                                  </div>
                                </div>
                              </div>
                            ))
                          )}
                        </div>
                      </div>
                    ) : null}
                  </div>
                </div>

                <div className="rounded-2xl border border-[#242433] bg-[#121218] p-4">
                  <div className="text-sm font-semibold text-[#F5F5F7]">Operación</div>

                  <div className="mt-4 grid grid-cols-2 gap-3">
                    <FieldCheckbox
                      label="Activo"
                      checked={editIsActive}
                      onChange={setEditIsActive}
                    />
                    <FieldSelect
                      label="Tipo"
                      value={editType}
                      onChange={(v) => setEditType(v as 'product' | 'combo' | 'service' | 'promo' | 'gambit')}
                      options={[
                        { value: 'product', label: 'Producto' },
                        { value: 'combo', label: 'Combo' },
                        { value: 'service', label: 'Servicio' },
                        { value: 'promo', label: 'Promo' },
                        { value: 'gambit', label: 'Gambit' },
                      ]}
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
                      hint="Cuántas unidades reales representa un servicio. Ejemplo: un pack de 25 lleva 25. Si se vende medio servicio, el sistema redondea hacia abajo: 25 / 2 = 12."
                    />
                    {shouldShowRiderPayField({
                      type: editType,
                      name: selectedCatalogItem?.name,
                      currentValue: editInternalRiderPayUsd,
                    }) ? (
                      <FieldInput
                        label="Pago rider interno ($)"
                        value={editInternalRiderPayUsd}
                        onChange={setEditInternalRiderPayUsd}
                        type="text"
                        hint="Solo aplica si este ítem representa un delivery o combo con delivery."
                      />
                    ) : null}
                    {editIsDetailEditable ? (
                      <FieldInput
                        label="Límite detalle"
                        value={editDetailUnitsLimit}
                        onChange={setEditDetailUnitsLimit}
                        type="number"
                        hint="Máximo de piezas seleccionables que permite este plato."
                      />
                    ) : null}
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
                      className="rounded-xl border border-[#242433] bg-[#0B0B0D] px-3 py-1.5 text-sm"
                      onClick={addEditComponent}
                      type="button"
                    >
                      Agregar componente
                    </button>
                  </div>

                  <div className="mt-4 space-y-4">
  <div>
    <div className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-[#8A8A96]">
      Componentes fijos / opcionales
    </div>

    {editFixedComponents.length === 0 ? (
      <div className="rounded-xl border border-[#242433] bg-[#0B0B0D] px-3 py-2 text-sm text-[#B7B7C2]">
        Sin componentes fijos.
      </div>
    ) : (
      <div className="space-y-2">
        {editFixedComponents
          .slice()
          .sort((a, b) => a.sortOrder - b.sortOrder)
          .map((row, idx) => (
            <div key={row.localId} className="rounded-xl border border-[#242433] bg-[#0B0B0D] p-2.5">
              <div className="mb-2 flex items-center justify-between gap-3">
                <div className="text-xs font-medium uppercase tracking-[0.14em] text-[#8A8A96]">
                  Fijo #{idx + 1}
                </div>
                <button
                  className="rounded-lg border border-red-500 bg-[#0B0B0D] px-2 py-1 text-xs text-red-400"
                  onClick={() => removeEditComponent(row.localId)}
                  type="button"
                >
                  Quitar
                </button>
              </div>

              <div className="grid grid-cols-1 gap-2 md:grid-cols-[minmax(0,1.7fr)_100px_130px]">
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
                    { value: 'fixed', label: 'Fijo' },
                    { value: 'selectable', label: 'Seleccionable' },
                  ]}
                />
                <FieldInput
                  label="Cantidad"
                  value={String(row.quantity)}
                  onChange={(value) =>
                    updateEditComponent(row.localId, {
                      quantity: Number(value || 0),
                    })
                  }
                  type="number"
                />
              </div>

              <div className="mt-2 grid grid-cols-1 gap-2 md:grid-cols-[auto_auto_minmax(0,1fr)] md:items-end">
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

                <FieldInput
                  label="Notas"
                  value={row.notes}
                  onChange={(value) =>
                    updateEditComponent(row.localId, {
                      notes: value,
                    })
                  }
                />
              </div>
            </div>
          ))}
      </div>
    )}
  </div>

  <div>
    <div className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-[#8A8A96]">
      Componentes seleccionables
    </div>

    {editSelectableComponents.length === 0 ? (
      <div className="rounded-xl border border-[#242433] bg-[#0B0B0D] px-3 py-2 text-sm text-[#B7B7C2]">
        Sin componentes seleccionables.
      </div>
    ) : (
      <div className="space-y-2">
        {editSelectableComponents
          .slice()
          .sort((a, b) => a.sortOrder - b.sortOrder)
          .map((row, idx) => (
            <div key={row.localId} className="rounded-xl border border-[#242433] bg-[#0B0B0D] p-2.5">
              <div className="mb-2 flex items-center justify-between gap-3">
                <div className="text-xs font-medium uppercase tracking-[0.14em] text-[#8A8A96]">
                  Seleccionable #{idx + 1}
                </div>
                <button
                  className="rounded-lg border border-red-500 bg-[#0B0B0D] px-2 py-1 text-xs text-red-400"
                  onClick={() => removeEditComponent(row.localId)}
                  type="button"
                >
                  Quitar
                </button>
              </div>

              <div className="grid grid-cols-1 gap-2 md:grid-cols-[minmax(0,1.7fr)_100px_130px]">
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
                    { value: 'fixed', label: 'Fijo' },
                    { value: 'selectable', label: 'Seleccionable' },
                  ]}
                />
                <FieldInput
                  label="Cantidad"
                  value={String(row.quantity)}
                  onChange={(value) =>
                    updateEditComponent(row.localId, {
                      quantity: Number(value || 0),
                    })
                  }
                  type="number"
                />
              </div>

              <div className="mt-2 grid grid-cols-1 gap-2 md:grid-cols-[auto_auto_minmax(0,1fr)] md:items-end">
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

                <FieldInput
                  label="Notas"
                  value={row.notes}
                  onChange={(value) =>
                    updateEditComponent(row.localId, {
                      notes: value,
                    })
                  }
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
        widthClass="w-[860px]"
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
        <span>{repairDisplayText(selectedOrder.advisorName)}</span>
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

<ProcessTimeline order={selectedOrder} nowMs={currentTimeMs} />
            <div className="flex gap-1 items-center overflow-x-auto">
              <Chip active={detailTab === 'detalle'} onClick={() => setDetailTab('detalle')}>Pedido</Chip>
              <Chip active={detailTab === 'entrega'} onClick={() => setDetailTab('entrega')}>Entrega</Chip>
              <Chip active={detailTab === 'pagos'} onClick={() => setDetailTab('pagos')}>Pagos</Chip>
              <Chip active={detailTab === 'notas'} onClick={() => setDetailTab('notas')}>Notas</Chip>
              {isAdmin ? (
                <Chip active={detailTab === 'ajustes'} onClick={() => setDetailTab('ajustes')}>Ajustes</Chip>
              ) : null}
            </div>

<div className="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1fr)_260px] lg:items-start">
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
                {line.editableDetailLines && getVisibleEditableDetailLines(line.editableDetailLines).length > 0 ? (
                  <div className="mt-1 space-y-1 pl-4 text-xs text-[#B7B7C2]">
                    {getVisibleEditableDetailLines(line.editableDetailLines).slice(0, 10).map((t, i) => (
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

      <div className="flex flex-wrap items-center gap-2">
        {selectedOrder.editMeta?.isAsap ? <SmallBadge label="Lo antes posible" tone="warn" /> : null}
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

      <div
        className={[
          'rounded-lg border bg-[#0B0B0D] px-3 py-2',
          getDeliveryTimingSummary(selectedOrder, currentTimeMs).tone === 'danger'
            ? 'border-red-500/40'
            : getDeliveryTimingSummary(selectedOrder, currentTimeMs).tone === 'ok'
              ? 'border-emerald-500/30'
              : 'border-[#242433]',
        ].join(' ')}
      >
        <div className="text-[10px] text-[#8A8A96]">
          {getDeliveryTimingSummary(selectedOrder, currentTimeMs).label}
        </div>
        <div
          className={[
            'mt-1 text-sm',
            getDeliveryTimingSummary(selectedOrder, currentTimeMs).tone === 'danger'
              ? 'text-red-400'
              : getDeliveryTimingSummary(selectedOrder, currentTimeMs).tone === 'ok'
                ? 'text-emerald-300'
                : 'text-[#F5F5F7]',
          ].join(' ')}
        >
          {getDeliveryTimingSummary(selectedOrder, currentTimeMs).value}
        </div>
      </div>

      {selectedOrder.fulfillment === 'delivery' &&
      (selectedOrder.editMeta?.deliveryDistanceKm != null || selectedOrder.editMeta?.deliveryCostUsd != null) ? (
        <div className="grid grid-cols-2 gap-2">
          <div className="rounded-lg border border-[#242433] bg-[#0B0B0D] px-3 py-2">
            <div className="text-[10px] text-[#8A8A96]">Distancia</div>
              <div className="mt-1 text-sm text-[#F5F5F7]">
              {selectedOrder.editMeta?.deliveryDistanceKm != null
                ? `${selectedOrder.editMeta.deliveryDistanceKm} km`
                : '—'}
            </div>
          </div>

          <div className="rounded-lg border border-[#242433] bg-[#0B0B0D] px-3 py-2">
            <div className="text-[10px] text-[#8A8A96]">Costo delivery</div>
              <div className="mt-1 text-sm text-[#F5F5F7]">
              {selectedOrder.editMeta?.deliveryCostUsd != null
                ? fmtUSD(selectedOrder.editMeta.deliveryCostUsd)
                : '—'}
            </div>
            {selectedOrder.editMeta?.deliveryCostSource ? (
              <div className="mt-1 text-[10px] text-[#8A8A96]">{selectedOrder.editMeta.deliveryCostSource}</div>
            ) : null}
          </div>
        </div>
      ) : null}

      {(selectedOrder.readyAtISO || selectedOrder.editMeta.deliveryCompletedAtISO || selectedOrder.status === 'delivered') ? (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <div className="rounded-lg border border-[#242433] bg-[#0B0B0D] px-3 py-2">
            <div className="text-[10px] text-[#8A8A96]">{getDeliveryCompletionSummary(selectedOrder).readyLabel}</div>
            <div className="mt-1 text-sm text-[#F5F5F7]">
              {getDeliveryCompletionSummary(selectedOrder).readyValue}
            </div>
          </div>

          <div className="rounded-lg border border-[#242433] bg-[#0B0B0D] px-3 py-2">
            <div className="text-[10px] text-[#8A8A96]">{getDeliveryCompletionSummary(selectedOrder).completedLabel}</div>
            <div className="mt-1 text-sm text-[#F5F5F7]">
              {getDeliveryCompletionSummary(selectedOrder).completedValue}
            </div>
          </div>

          <div
            className={[
              'rounded-lg border bg-[#0B0B0D] px-3 py-2',
              getDeliveryCompletionSummary(selectedOrder).punctualityTone === 'danger'
                ? 'border-red-500/40'
                : getDeliveryCompletionSummary(selectedOrder).punctualityTone === 'ok'
                  ? 'border-emerald-500/30'
                  : 'border-[#242433]',
            ].join(' ')}
          >
            <div className="text-[10px] text-[#8A8A96]">Resultado</div>
            <div
              className={[
                'mt-1 text-sm',
                getDeliveryCompletionSummary(selectedOrder).punctualityTone === 'danger'
                  ? 'text-red-400'
                  : getDeliveryCompletionSummary(selectedOrder).punctualityTone === 'ok'
                    ? 'text-emerald-300'
                    : 'text-[#F5F5F7]',
              ].join(' ')}
            >
              {getDeliveryCompletionSummary(selectedOrder).punctuality || 'Sin cierre todavía'}
            </div>
          </div>
        </div>
      ) : null}

      {selectedOrder.fulfillment === 'delivery' ? (
        <>
          <div className="rounded-lg border border-[#242433] bg-[#0B0B0D] px-3 py-2">
            <div className="text-[10px] text-[#8A8A96]">Dirección</div>
            <div className="mt-1 text-sm text-[#F5F5F7]">
              {repairDisplayText(selectedOrder.address) || '—'}
            </div>
            {selectedOrder.editMeta?.deliveryGpsUrl ? (
              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                <span className="text-[#8A8A96]">GPS:</span>
                <a
                  href={selectedOrder.editMeta.deliveryGpsUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="break-all text-sky-300 hover:text-sky-200 hover:underline"
                >
                  {repairDisplayText(selectedOrder.editMeta.deliveryGpsUrl)}
                </a>
              </div>
            ) : null}
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
              : 'SÃ­'
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

      {selectedOrder.paymentReports.length === 0 && selectedOrderChangeMovements.length === 0 ? (
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
                    {repairDisplayText(rp.moneyAccountName)} · {fmtDateTimeES(rp.createdAt)}
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
                  <span className="text-[#F5F5F7]">{repairDisplayText(rp.referenceCode) || '—'}</span>
                </div>

                <div>
                  <span className="text-[#8A8A96]">Pagador:</span>{' '}
                  <span className="text-[#F5F5F7]">{repairDisplayText(rp.payerName) || '—'}</span>
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
                    onClick={() => openConfirmPaymentBox(selectedOrder, rp)}
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

          {selectedOrderChangeMovements.map((movement) => {
            const movementAccount =
              moneyAccounts.find((account) => account.id === movement.moneyAccountId) ?? null;

            return (
              <div
                key={`change-movement-${movement.id}`}
                className="rounded-lg border border-sky-500/30 bg-[#0B0B0D] px-3 py-3"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-[#F5F5F7]">
                      Cambio entregado · {movement.currencyCode} {movement.amount.toFixed(2)} · {fmtUSD(movement.amountUsdEquivalent)}
                    </div>
                    <div className="mt-1 text-[11px] text-[#8A8A96]">
                      {`${repairDisplayText(movementAccount?.name || 'Cuenta')} · ${fmtDateTimeES(movement.confirmedAt || movement.createdAt)}`}
                    </div>
                  </div>

                  <div className="rounded-full bg-sky-500 px-2 py-0.5 text-[10px] font-semibold text-[#0B0B0D]">
                    CAMBIO
                  </div>
                </div>

                <div className="mt-2 grid grid-cols-1 gap-1 text-[11px] text-[#B7B7C2] sm:grid-cols-2">
                  <div>
                    <span className="text-[#8A8A96]">Cuenta:</span>{' '}
                    <span className="text-[#F5F5F7]">{repairDisplayText(movementAccount?.name) || '—'}</span>
                  </div>

                  <div>
                    <span className="text-[#8A8A96]">Moneda:</span>{' '}
                    <span className="text-[#F5F5F7]">{movement.currencyCode}</span>
                  </div>

                  <div>
                    <span className="text-[#8A8A96]">Tasa:</span>{' '}
                    <span className="text-[#F5F5F7]">
                      {movement.exchangeRateVesPerUsd != null ? movement.exchangeRateVesPerUsd : '—'}
                    </span>
                  </div>

                  <div>
                    <span className="text-[#8A8A96]">Descripción:</span>{' '}
                    <span className="text-[#F5F5F7]">{repairDisplayText(movement.description) || 'Cambio entregado'}</span>
                  </div>
                </div>

                {movement.notes ? (
                  <div className="mt-2 text-[11px] text-[#B7B7C2]">
                    <span className="text-[#8A8A96]">Notas:</span>{' '}
                    <span className="text-[#F5F5F7]">{movement.notes}</span>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  </div>
) : null}

{detailTab === 'notas' ? (
  <div className="space-y-3">
    {(() => {
      const orderEvents = selectedOrder.events ?? [];
      return (
        <>
    <div className="rounded-xl border border-[#1D1D28] bg-[#101014] p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="text-sm font-semibold text-[#F5F5F7]">Historial</div>
        <SmallBadge
          label={`${orderEvents.length} evento${orderEvents.length === 1 ? '' : 's'}`}
          tone={orderEvents.length > 0 ? 'brand' : 'muted'}
        />
      </div>
      {orderEvents.length === 0 ? (
        <div className="mt-3 rounded-lg border border-[#242433] bg-[#0B0B0D] px-3 py-3 text-sm text-[#B7B7C2]">
          Sin historial registrado.
        </div>
      ) : (
        <div className="mt-3 space-y-2">
          {orderEvents.map((event) => (
            <div
              key={event.id}
              className="rounded-lg border border-[#242433] bg-[#0B0B0D] px-3 py-3"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-[#F5F5F7]">{repairDisplayText(event.title)}</div>
                  <div className="mt-1 text-[11px] text-[#8A8A96]">
                    {repairDisplayText(event.actorName)} · {fmtDateTimeES(event.createdAt)}
                  </div>
                </div>
                <SmallBadge
                  label={event.severity === 'critical' ? 'Critica' : event.severity === 'warning' ? 'Atencion' : 'Info'}
                  tone={event.severity === 'warning' || event.severity === 'critical' ? 'warn' : 'brand'}
                />
              </div>
              {event.message ? (
                <div className="mt-2 text-[12px] text-[#B7B7C2]">{repairDisplayText(event.message)}</div>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>

    <div className="rounded-xl border border-[#1D1D28] bg-[#101014] p-3">
      <div className="text-sm font-semibold text-[#F5F5F7]">Notas</div>
      <div className="mt-3 rounded-lg border border-[#242433] bg-[#0B0B0D] px-3 py-3 text-sm text-[#B7B7C2]">
        {selectedOrder.notes?.trim() ? repairDisplayText(selectedOrder.notes) : '—'}
      </div>
    </div>
        </>
      );
    })()}
  </div>
) : null}

{detailTab === 'ajustes' && isAdmin ? (
  <div className="rounded-xl border border-[#1D1D28] bg-[#101014] p-3">
    <div className="flex items-center justify-between gap-2">
      <div className="text-sm font-semibold text-[#F5F5F7]">Ajustes</div>
      <SmallBadge
        label={`${selectedOrder.adminAdjustments.length} evento${selectedOrder.adminAdjustments.length === 1 ? '' : 's'}`}
        tone={selectedOrder.adminAdjustments.length > 0 ? 'warn' : 'muted'}
      />
    </div>

    {selectedOrder.adminAdjustments.length === 0 ? (
      <div className="mt-3 rounded-lg border border-[#242433] bg-[#0B0B0D] px-3 py-3 text-sm text-[#B7B7C2]">
        Sin ajustes administrativos registrados.
      </div>
    ) : (
      <div className="mt-3 space-y-2">
        {selectedOrder.adminAdjustments.map((adjustment) => {
          const payload = adjustment.payload ?? {};
          const originalUnit = Number(payload.original_unit_price_usd ?? 0);
          const overrideUnit = Number(payload.override_unit_price_usd ?? 0);
          const deltaUsd = Number(payload.delta_usd ?? 0);
          const productName =
            typeof payload.product_name === 'string' && payload.product_name.trim()
              ? payload.product_name
              : 'Ã­tem';
          const qty = Number(payload.qty ?? 0);
          const changedFieldLabels = getAdjustmentChangedFields(payload).map(mapAdjustmentFieldLabel);
          const isAdminFullEdit = payload.kind === 'admin_full_edit';

          return (
            <div
              key={adjustment.id}
              className="rounded-lg border border-[#242433] bg-[#0B0B0D] px-3 py-3"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-[#F5F5F7]">
                    {isAdminFullEdit
                      ? 'ModificaciÃ³n administrativa'
                      : payload.kind === 'rounding_writeoff' || payload.kind === 'rounding_gain_close'
                      ? 'Cierre por redondeo'
                      : adjustment.adjustmentType === 'item_price_override'
                      ? 'Ajuste de precio por Ã­tem'
                      : adjustment.adjustmentType}
                  </div>
                  <div className="mt-1 text-[11px] text-[#8A8A96]">
                    {fmtDateTimeES(adjustment.createdAt)} Â· {adjustment.createdByUserId}
                  </div>
                </div>

                <SmallBadge
                  label={deltaUsd !== 0 ? `${deltaUsd > 0 ? '+' : ''}${fmtUSD(deltaUsd)}` : 'Sin delta'}
                  tone={deltaUsd < 0 ? 'brand' : deltaUsd > 0 ? 'warn' : 'muted'}
                />
              </div>

              <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
                <div className="rounded-lg border border-[#242433] bg-[#121218] px-3 py-2">
                  <div className="text-[10px] text-[#8A8A96]">Motivo</div>
                  <div className="mt-1 text-sm text-[#F5F5F7]">{adjustment.reason || 'â€”'}</div>
                </div>

                <div className="rounded-lg border border-[#242433] bg-[#121218] px-3 py-2">
                  <div className="text-[10px] text-[#8A8A96]">{isAdminFullEdit ? 'Cambios detectados' : 'Ã­tem'}</div>
                  <div className="mt-1 text-sm text-[#F5F5F7]">
                    {isAdminFullEdit
                      ? changedFieldLabels.length > 0
                        ? changedFieldLabels.join(', ')
                        : 'ModificaciÃ³n auditada'
                      : payload.kind === 'rounding_writeoff' || payload.kind === 'rounding_gain_close'
                        ? 'Total ajustado al monto confirmado'
                        : productName}
                    {!isAdminFullEdit && qty > 0 ? ` Â· x${qty}` : ''}
                  </div>
                </div>
              </div>

              {isAdminFullEdit ? null : (
                <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
                  <div className="rounded-lg border border-[#242433] bg-[#121218] px-3 py-2">
                    <div className="text-[10px] text-[#8A8A96]">Precio original</div>
                    <div className="mt-1 text-sm text-[#F5F5F7]">{fmtUSD(originalUnit)}</div>
                  </div>

                  <div className="rounded-lg border border-[#242433] bg-[#121218] px-3 py-2">
                    <div className="text-[10px] text-[#8A8A96]">Precio ajustado</div>
                    <div className="mt-1 text-sm text-[#F5F5F7]">{fmtUSD(overrideUnit)}</div>
                  </div>

                  <div className="rounded-lg border border-[#242433] bg-[#121218] px-3 py-2">
                    <div className="text-[10px] text-[#8A8A96]">Impacto</div>
                    <div className="mt-1 text-sm text-[#F5F5F7]">
                      {deltaUsd > 0 ? '+' : ''}{fmtUSD(deltaUsd)}
                    </div>
                  </div>
                </div>
              )}

              {adjustment.notes ? (
                <div className="mt-2 text-[11px] text-[#B7B7C2]">
                  <span className="text-[#8A8A96]">Notas:</span> {adjustment.notes}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    )}
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

        {['created', 'queued'].includes(selectedOrder.status) || isAdmin ? (
          <button
            className="rounded-md border border-[#2A2A38] bg-[#0D0D11] px-2 py-1 text-[10px] text-[#F5F5F7]"
            onClick={() => openEditOrderDrawer(selectedOrder)}
          >
            {['created', 'queued'].includes(selectedOrder.status) ? 'Modificar' : 'Modificar admin'}
          </button>
        ) : null}

        {canSendToKitchen(selectedOrder) ? (
          <button
            className="rounded-md border border-[#FEEF00]/60 bg-[#15120A] px-2.5 py-1.5 text-[11px] font-medium text-[#FEEF00]"
            onClick={() => handleSendToKitchen(selectedOrder.id)}
          >
            Enviar a cocina
          </button>
        ) : null}

        {canKitchenTake(selectedOrder) ? (
          <button
            className="rounded-md border border-[#2A2A38] bg-[#0D0D11] px-2.5 py-1.5 text-[11px] text-[#F5F5F7]"
            onClick={() => {
              setKitchenTakeBoxOpen(true);
              setKitchenEtaMinutes('15');
            }}
          >
            Tomar en cocina
          </button>
        ) : null}

        {canMarkReady(selectedOrder) ? (
          <button
            className="rounded-md border border-emerald-500/50 bg-[#0D1511] px-2.5 py-1.5 text-[11px] text-emerald-300"
            onClick={() => handleMarkReady(selectedOrder)}
          >
            Marcar preparada
          </button>
        ) : null}

        {canOutForDelivery(selectedOrder) ? (
          <button
            className="rounded-md border border-sky-500/50 bg-[#0D141D] px-2.5 py-1.5 text-[11px] text-sky-300"
            onClick={() => openDeliveryEtaBox(selectedOrder)}
          >
            {selectedOrder.fulfillment === 'pickup' ? 'Lista para retiro' : 'En camino'}
          </button>
        ) : null}

        {canMarkDelivered(selectedOrder) ? (
          <button
            className="rounded-md border border-emerald-500/50 bg-[#0D1511] px-2.5 py-1.5 text-[11px] text-emerald-300"
            onClick={() => handleMarkDelivered(selectedOrder)}
          >
            {selectedOrder.fulfillment === 'pickup' ? 'Marcar retirado' : 'Marcar entregado'}
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
        setDeliveryAssignDistanceKm('');
        setDeliveryAssignCostUsd(String(getInternalDeliveryPayUsd(selectedOrder, catalogItemById) || ''));
      }}
    >
      Asignar interno
    </button>

    <button
      className="rounded-md border border-[#2A2A38] bg-[#0D0D11] px-2 py-1 text-[10px] text-[#F5F5F7]"
      onClick={() => {
        setDeliveryAssignMode('external');
        setDeliveryAssignDriverId('');
        setDeliveryAssignDistanceKm(
          selectedOrder.editMeta?.deliveryDistanceKm != null ? String(selectedOrder.editMeta.deliveryDistanceKm) : ''
        );
        setDeliveryAssignCostUsd(
          selectedOrder.editMeta?.deliveryCostUsd != null ? String(selectedOrder.editMeta.deliveryCostUsd) : ''
        );
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

{detailTab === 'pagos' &&
isAdmin &&
selectedOrder.balanceUsd > 0.01 &&
selectedOrder.balanceUsd <= ORDER_ROUNDING_CLOSE_MAX_USD ? (
  <button
    className="rounded-md border border-orange-500/50 bg-[#0D0D11] px-2 py-1 text-[10px] text-orange-400"
    onClick={() => handleCloseRoundingBalance(selectedOrder)}
  >
    Cerrar diferencia
  </button>
) : null}

{detailTab === 'pagos' && selectedOrder.balanceUsd > 0.01 ? (
  <button
    className="rounded-md border border-[#2A2A38] bg-[#0D0D11] px-2 py-1 text-[10px] text-[#F5F5F7]"
    onClick={() => {
      setPaymentReportBoxOpen(true);
      setPaymentReportAmount(
        selectedOrder.balanceUsd > 0 ? String(Number(selectedOrder.balanceUsd.toFixed(2))) : ''
      );
      const suggestedFund = Math.max(
        0,
        Math.min(
          Number(selectedOrder.balanceUsd.toFixed(2)),
          Number(selectedOrderClientFundAvailableUsd.toFixed(2))
        )
      );
      setPaymentApplyFundAmountUsd(
        suggestedFund > 0.005 ? String(Number(suggestedFund.toFixed(2))) : ''
      );
      setPaymentApplyFundNotes('');
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
          if (nextAccount?.currencyCode === 'VES') {
            setPaymentReportAmount(
              getSuggestedAccountAmount(selectedOrder.balanceUsd, nextAccount.currencyCode)
            );
            setPaymentReportExchangeRate(
              activeBsRate > 0 ? String(Number(activeBsRate.toFixed(2))) : ''
            );
          } else {
            setPaymentReportAmount(getSuggestedAccountAmount(selectedOrder.balanceUsd, nextAccount?.currencyCode));
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

      {selectedOrderClientFundAvailableUsd > 0.005 ? (
        <div className="rounded-lg border border-emerald-500/20 bg-[#0F1512] p-3">
          <div className="text-[11px] font-medium text-[#F5F5F7]">Aplicar fondo del cliente</div>
          <div className="mt-1 text-[11px] text-[#8A8A96]">
            Disponible: {fmtUSD(selectedOrderClientFundAvailableUsd)}. Esto baja el pendiente sin meter dinero nuevo a caja.
          </div>

          <div className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-2">
            <input
              value={paymentApplyFundAmountUsd}
              onChange={(e) => setPaymentApplyFundAmountUsd(e.target.value)}
              placeholder="Monto a aplicar (USD)"
              type="text"
              className="w-full rounded-md border border-[#242433] bg-[#121218] px-2 py-1.5 text-[11px] text-[#F5F5F7] placeholder:text-[#8A8A96]"
            />

            <input
              value={paymentApplyFundNotes}
              onChange={(e) => setPaymentApplyFundNotes(e.target.value)}
              placeholder="Nota (opcional)"
              className="w-full rounded-md border border-[#242433] bg-[#121218] px-2 py-1.5 text-[11px] text-[#F5F5F7] placeholder:text-[#8A8A96]"
            />
          </div>

          <div className="mt-3 flex flex-col gap-2">
            <button
              className="rounded-md border border-emerald-500/50 bg-[#0D1611] px-2 py-1 text-[10px] font-semibold text-emerald-300"
              onClick={() => handleApplyClientFundPayment(selectedOrder)}
            >
              Aplicar fondo
            </button>
          </div>
        </div>
      ) : null}

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

{detailTab === 'pagos' && selectedOrderClientFundAvailableUsd > 0.005 ? (
  <div className="mt-2 rounded-lg border border-sky-500/20 bg-[#0B1016] p-3">
    <div className="flex items-start justify-between gap-3">
      <div>
        <div className="text-[11px] font-medium text-[#F5F5F7]">Dar cambio desde fondo</div>
        <div className="mt-1 text-[11px] text-[#8A8A96]">
          Disponible para este cliente: {fmtUSD(selectedOrderClientFundAvailableUsd)}.
        </div>
      </div>
      <button
        type="button"
        className="rounded-md border border-sky-500/40 bg-[#0D141D] px-2 py-1 text-[10px] font-semibold text-sky-300"
        onClick={() => {
          const suggested = Number(selectedOrderClientFundAvailableUsd.toFixed(2));
          setPaymentGiveChangeBoxOpen((prev) => !prev);
          setPaymentGiveChangeMoneyAccountId('');
          setPaymentGiveChangeAmount(suggested > 0.005 ? String(suggested) : '');
          setPaymentGiveChangeExchangeRate('');
          setPaymentGiveChangeNotes('');
        }}
      >
        {paymentGiveChangeBoxOpen ? 'Ocultar' : 'Dar cambio'}
      </button>
    </div>

    {paymentGiveChangeBoxOpen ? (
      <div className="mt-3 space-y-2.5">
        <div>
          <label className="mb-1 block text-[11px] text-[#8A8A96]">Cuenta del cambio</label>
          <select
            value={paymentGiveChangeMoneyAccountId}
            onChange={(e) => {
              const nextId = e.target.value;
              setPaymentGiveChangeMoneyAccountId(nextId);

              const nextAccount = moneyAccounts.find((account) => account.id === Number(nextId));
              if (nextAccount?.currencyCode === 'VES') {
                setPaymentGiveChangeAmount(
                  getSuggestedAccountAmount(selectedOrderClientFundAvailableUsd, nextAccount.currencyCode)
                );
                setPaymentGiveChangeExchangeRate(
                  activeBsRate > 0 ? String(Number(activeBsRate.toFixed(2))) : ''
                );
              } else {
                setPaymentGiveChangeAmount(
                  getSuggestedAccountAmount(selectedOrderClientFundAvailableUsd, nextAccount?.currencyCode)
                );
                setPaymentGiveChangeExchangeRate('');
              }
            }}
            className="w-full rounded-md border border-[#242433] bg-[#121218] px-3 py-2 text-[12px] text-[#F5F5F7]"
          >
            <option value="">Selecciona una cuenta</option>
            {moneyAccounts.filter((account) => account.isActive).map((account) => (
              <option key={account.id} value={account.id}>
                {account.name} ({account.currencyCode})
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="mb-1 block text-[11px] text-[#8A8A96]">Monto del cambio</label>
          <input
            value={paymentGiveChangeAmount}
            onChange={(e) => setPaymentGiveChangeAmount(e.target.value)}
            placeholder="Ej. 7.97"
            type="text"
            className="w-full rounded-md border border-[#242433] bg-[#121218] px-3 py-2 text-[12px] text-[#F5F5F7] placeholder:text-[#8A8A96]"
          />
        </div>

        {selectedGiveChangeAccount?.currencyCode === 'VES' ? (
          <div>
            <label className="mb-1 block text-[11px] text-[#8A8A96]">Tasa Bs por USD</label>
            <input
              value={paymentGiveChangeExchangeRate}
              onChange={(e) => setPaymentGiveChangeExchangeRate(e.target.value)}
              placeholder="Ej. 474.06"
              type="text"
              className="w-full rounded-md border border-[#242433] bg-[#121218] px-3 py-2 text-[12px] text-[#F5F5F7] placeholder:text-[#8A8A96]"
            />
          </div>
        ) : (
          <div className="rounded-md border border-[#242433] bg-[#121218] px-3 py-2 text-[11px] text-[#8A8A96]">
            {selectedGiveChangeAccount ? `El cambio saldrá en ${selectedGiveChangeAccount.currencyCode}.` : 'Selecciona una cuenta para continuar.'}
          </div>
        )}

        <div>
          <label className="mb-1 block text-[11px] text-[#8A8A96]">Nota</label>
          <input
            value={paymentGiveChangeNotes}
            onChange={(e) => setPaymentGiveChangeNotes(e.target.value)}
            placeholder="Opcional"
            className="w-full rounded-md border border-[#242433] bg-[#121218] px-3 py-2 text-[12px] text-[#F5F5F7] placeholder:text-[#8A8A96]"
          />
        </div>

        <div className="flex justify-end">
          <button
            type="button"
            className="rounded-md border border-sky-500/40 bg-[#0D141D] px-3 py-2 text-[11px] font-semibold text-sky-300"
            onClick={() => handleDeliverClientChange(selectedOrder)}
          >
            Confirmar cambio
          </button>
        </div>
      </div>
    ) : null}
  </div>
) : null}

{detailTab === 'pagos' && paymentConfirmBoxOpen && selectedConfirmPaymentReport ? (
  <div className="mt-2 rounded-lg border border-[#3A2F12] bg-[#120F08] p-3">
    <div className="flex items-start justify-between gap-3">
      <div>
        <div className="text-[11px] font-semibold text-[#F5F5F7]">Confirmar pago</div>
        <div className="mt-1 text-[11px] text-[#B7B7C2]">
          Reporte #{selectedConfirmPaymentReport.id} Â· {fmtUSD(selectedConfirmPaymentReport.usdEquivalent)}
        </div>
      </div>
      <SmallBadge
        label={
          selectedConfirmPaymentExcessUsd > 0.005
            ? `Excedente ${fmtUSD(selectedConfirmPaymentExcessUsd)}`
            : 'Pago exacto'
        }
        tone={selectedConfirmPaymentExcessUsd > 0.005 ? 'warn' : 'brand'}
      />
    </div>

    <div className="mt-3 space-y-3">
      <div>
        <label className="mb-1 block text-[11px] text-[#8A8A96]">Notas de confirmaciÃ³n</label>
        <textarea
          value={paymentConfirmReviewNotes}
          onChange={(e) => setPaymentConfirmReviewNotes(e.target.value)}
          rows={2}
          placeholder="Opcional"
          className="w-full rounded-md border border-[#242433] bg-[#121218] px-2 py-1.5 text-[11px] text-[#F5F5F7] placeholder:text-[#8A8A96]"
        />
      </div>

      {selectedConfirmPaymentExcessUsd > 0.005 ? (
        <div className="rounded-lg border border-[#242433] bg-[#0B0B0D] p-3">
          <div className="text-[11px] font-medium text-[#F5F5F7]">QuÃ© hacer con el excedente</div>
          <div className="mt-1 text-[11px] text-[#8A8A96]">
            El cliente estÃ¡ pagando {fmtUSD(selectedConfirmPaymentExcessUsd)} de mÃ¡s.
          </div>

          <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
            <button
              type="button"
              className={[
                'rounded-xl border px-3 py-2 text-left',
                paymentConfirmOverpaymentHandling === 'store_fund'
                  ? 'border-[#FEEF00] bg-[#19150A] text-[#F5F5F7]'
                  : 'border-[#242433] bg-[#121218] text-[#B7B7C2]',
              ].join(' ')}
              onClick={() => setPaymentConfirmOverpaymentHandling('store_fund')}
            >
              <div className="text-sm font-semibold">Fondo automÃ¡tico</div>
              <div className="mt-1 text-[11px]">El excedente quedarÃ¡ como saldo a favor y luego podrÃ¡s dar cambio desde la orden.</div>
            </button>

            {isAdmin && selectedConfirmPaymentExcessUsd <= ORDER_ROUNDING_CLOSE_MAX_USD ? (
              <button
                type="button"
                className={[
                  'rounded-xl border px-3 py-2 text-left',
                  paymentConfirmOverpaymentHandling === 'close_difference'
                    ? 'border-orange-400 bg-[#1A1208] text-[#F5F5F7]'
                    : 'border-[#242433] bg-[#121218] text-[#B7B7C2]',
                ].join(' ')}
                onClick={() => setPaymentConfirmOverpaymentHandling('close_difference')}
              >
                <div className="text-sm font-semibold">Cerrar diferencia</div>
                <div className="mt-1 text-[11px]">Se absorbe a favor de la empresa y queda auditado.</div>
              </button>
            ) : null}
          </div>

          <div className="mt-3">
            <label className="mb-1 block text-[11px] text-[#8A8A96]">Nota del excedente</label>
            <textarea
              value={paymentConfirmOverpaymentNotes}
              onChange={(e) => setPaymentConfirmOverpaymentNotes(e.target.value)}
              rows={2}
              placeholder="Opcional"
              className="w-full rounded-md border border-[#242433] bg-[#121218] px-2 py-1.5 text-[11px] text-[#F5F5F7] placeholder:text-[#8A8A96]"
            />
          </div>
        </div>
      ) : null}

      <div className="flex flex-col gap-1.5 sm:flex-row sm:justify-end">
        <button
          type="button"
          className="rounded-md border border-[#2A2A38] bg-[#0D0D11] px-3 py-2 text-[11px] text-[#F5F5F7]"
          onClick={resetPaymentConfirmBox}
          disabled={paymentConfirmSaving}
        >
          Cancelar
        </button>
        <button
          type="button"
          className="rounded-md border border-[#FEEF00] bg-[#FEEF00] px-3 py-2 text-[11px] font-semibold text-[#0B0B0D]"
          onClick={() => handleConfirmPayment(selectedOrder, selectedConfirmPaymentReport)}
          disabled={paymentConfirmSaving}
        >
          {paymentConfirmSaving ? 'Confirmando...' : 'Confirmar pago'}
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

    <div className="mt-2 rounded-md border border-[#242433] bg-[#121218] px-2 py-1.5 text-[11px] text-[#B7B7C2]">
      Pago interno aplicado: <span className="font-semibold text-[#F5F5F7]">{fmtUSD(getInternalDeliveryPayUsd(selectedOrder, catalogItemById))}</span>
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
        onChange={(e) => handleDeliveryAssignPartnerChange(e.target.value)}
        className="w-full rounded-md border border-[#242433] bg-[#121218] px-2 py-1.5 text-[11px] text-[#F5F5F7]"
      >
        <option value="">â€” seleccionar â€”</option>
        {deliveryPartners.filter((p) => p.isActive).map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
    </div>

    <div className="mt-2">
      <input
        value={deliveryAssignDistanceKm}
        onChange={(e) => handleDeliveryAssignDistanceChange(e.target.value)}
        placeholder="Distancia en km"
        className="w-full rounded-md border border-[#242433] bg-[#121218] px-2 py-1.5 text-[11px] text-[#F5F5F7] placeholder:text-[#8A8A96]"
      />
    </div>

    <div className="mt-2 rounded-md border border-[#242433] bg-[#121218] px-2 py-1.5 text-[11px] text-[#B7B7C2]">
      {deliveryAssignSuggestedRate ? (
        <>
          Tarifa sugerida: <span className="font-semibold text-[#F5F5F7]">{fmtUSD(deliveryAssignSuggestedRate.priceUsd)}</span>
          <span className="ml-1 text-[#8A8A96]">
            ({deliveryAssignSuggestedRate.kmFrom}
            {deliveryAssignSuggestedRate.kmTo != null ? ` a ${deliveryAssignSuggestedRate.kmTo}` : '+'} km)
          </span>
        </>
      ) : (
        'Sin tarifa automÃ¡tica para esa distancia.'
      )}
    </div>

    <div className="mt-2">
      <input
        value={deliveryAssignCostUsd}
        onChange={(e) => handleDeliveryAssignCostChange(e.target.value)}
        placeholder="Costo del delivery en USD"
        className="w-full rounded-md border border-[#242433] bg-[#121218] px-2 py-1.5 text-[11px] text-[#F5F5F7] placeholder:text-[#8A8A96]"
      />
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
    </div>

    <div className="mt-2">
      <textarea
        value={reviewActionNotes}
        onChange={(e) => setReviewActionNotes(e.target.value)}
        rows={3}
        placeholder={
          reviewActionMode === 'return'
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
          Confirmar aprobaciÃ³n
        </button>
      ) : null}

      {reviewActionMode === 'reapprove' ? (
        <button
          className="rounded-md border border-orange-500 bg-orange-500 px-2 py-1 text-[10px] font-semibold text-[#0B0B0D]"
          onClick={() => handleApprove(selectedOrder)}
        >
          Confirmar re-aprobaciÃ³n
        </button>
      ) : null}

      {reviewActionMode === 'return' ? (
        <button
          className="rounded-md border border-[#FEEF00] bg-[#FEEF00] px-2 py-1 text-[10px] font-semibold text-[#0B0B0D]"
          onClick={() => handleReturn(selectedOrder)}
        >
          Enviar devoluciÃ³n
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

{kitchenTakeBoxOpen ? (
  <div className="rounded-lg border border-[#242433] bg-[#0B0B0D] p-2">
    <div className="text-[10px] font-medium text-[#B7B7C2]">Tomar en cocina</div>

    <div className="mt-2 space-y-2">
      <div>
        <label className="mb-1 block text-[10px] text-[#8A8A96]">Tiempo estimado de preparación (minutos)</label>
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
          : 'Sin asignaciÃ³n visible'}
    </div>

    <div className="mt-2 space-y-2">
      <div>
        <label className="mb-1 block text-[10px] text-[#8A8A96]">
          Tiempo estimado en camino (minutos)
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
        placeholder="Motivo de cancelaciÃ³n (obligatorio)"
        className="w-full rounded-md border border-[#242433] bg-[#121218] px-2 py-1.5 text-[11px] text-[#F5F5F7] placeholder:text-[#8A8A96]"
      />
    </div>

    <div className="mt-2 flex flex-col gap-1.5">
      <button
        className="rounded-md border border-red-500/50 bg-[#0D0D11] px-2 py-1 text-[10px] text-red-400"
        onClick={() => handleCancelOrder(selectedOrder)}
      >
        Confirmar cancelaciÃ³n
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
  title="ActualizaciÃ³n rÃ¡pida de catÃ¡logo"
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
            Edita solo el monto en la moneda de origen. Puedes usar tabulador para pasar rÃ¡pido de un Ã­tem al siguiente.
          </div>
        </div>

        <SmallBadge label={`${quickCatalogRows.length} Ã­tems`} tone="muted" />
      </div>

      <div className="mt-4 overflow-hidden rounded-2xl border border-[#242433] bg-[#0B0B0D]">
        <div className="max-h-[62vh] overflow-y-auto">
          <table className="w-full table-fixed text-[12px]">
            <thead className="sticky top-0 z-10 border-b border-[#242433] bg-[#121218] text-[#B7B7C2]">
              <tr>
                <th className="w-[84px] px-3 py-3 text-left font-medium">SKU</th>
                <th className="px-3 py-3 text-left font-medium">Ãtem</th>
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
                  <td className="px-3 py-2 text-[#8A8A96]">{row.sku || 'â€”'}</td>
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
          label="Tipo"
          value={newType}
          onChange={(v) => setNewType(v as 'product' | 'combo' | 'service' | 'promo' | 'gambit')}
          options={[
            { value: 'product', label: 'Producto' },
            { value: 'combo', label: 'Combo' },
            { value: 'service', label: 'Servicio' },
            { value: 'promo', label: 'Promo' },
            { value: 'gambit', label: 'Gambit' },
          ]}
        />



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
          hint="Cuántas unidades reales representa un servicio. Ejemplo: un pack de 25 lleva 25. Si se vende medio servicio, el sistema redondea hacia abajo: 25 / 2 = 12."
        />

        {shouldShowRiderPayField({
          type: newType,
          name: newName,
          currentValue: newInternalRiderPayUsd,
        }) ? (
          <FieldInput
            label="Pago rider interno ($)"
            value={newInternalRiderPayUsd}
            onChange={setNewInternalRiderPayUsd}
            type="text"
            hint="Solo aplica si este ítem representa un delivery o combo con delivery."
          />
        ) : null}

        {newIsDetailEditable ? (
          <FieldInput
            label="Límite detalle"
            value={newDetailUnitsLimit}
            onChange={setNewDetailUnitsLimit}
            type="number"
            hint="Máximo de piezas seleccionables que permite este plato."
          />
        ) : null}
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

      <div className="mt-4 rounded-2xl border border-[#242433] bg-[#0B0B0D] p-3">
        <div className="text-sm font-semibold text-[#F5F5F7]">Inventario</div>
        <div className="mt-3 grid grid-cols-2 gap-3">
          <FieldCheckbox label="Inventario activo" checked={newInventoryEnabled} onChange={setNewInventoryEnabled} />
          <FieldSelect
            label="Tipo inventario"
            value={newInventoryKind}
            onChange={(v) => setNewInventoryKind(v as 'raw_material' | 'prepared_base' | 'finished_good')}
            options={[
              { value: 'finished_good', label: 'Producto final' },
              { value: 'prepared_base', label: 'Base preparada' },
              { value: 'raw_material', label: 'Materia prima' },
            ]}
          />
          <FieldSelect
            label="Modo de descuento"
            value={newInventoryDeductionMode}
            onChange={(v) => setNewInventoryDeductionMode(v as 'self' | 'composition')}
            hint={
              newInventoryDeductionMode === 'composition'
                ? 'Este producto baja stock de un item interno distinto.'
                : 'La venta bajará stock de este mismo producto.'
            }
            options={[
              { value: 'self', label: 'A sí mismo' },
              { value: 'composition', label: 'Por composición' },
            ]}
          />
          <FieldInput
            label="Unidad base"
            value={newInventoryUnitName}
            onChange={setNewInventoryUnitName}
            hint="Ejemplo: pieza, kg, bandeja o vasito."
          />
        </div>
        {newInventoryEnabled && newInventoryDeductionMode === 'composition' ? (
          <div className="mt-4 rounded-2xl border border-[#242433] bg-[#0B0B0D] p-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-semibold text-[#F5F5F7]">Descuenta de inventario interno</div>
                <div className="mt-1 text-xs text-[#8A8A96]">
                  Si este producto ya descuenta por su composición comercial, puedes dejar esta sección vacía. Úsala solo cuando necesites una receta fija interna.
                </div>
              </div>
              <button
                type="button"
                className="rounded-xl border border-[#242433] bg-[#121218] px-3 py-2 text-sm"
                onClick={addNewInventoryLink}
              >
                Agregar item
              </button>
            </div>

            <div className="mt-3 space-y-3">
              {newInventoryLinks.length === 0 ? (
                <div className="rounded-xl border border-dashed border-[#242433] px-3 py-3 text-sm text-[#8A8A96]">
                  Déjala vacía si el producto baja inventario desde sus componentes. Si no, agrega aquí el item real y su cantidad fija.
                </div>
              ) : (
                newInventoryLinks.map((row) => (
                  <div key={row.localId} className="rounded-xl border border-[#242433] bg-[#121218] p-3">
                    <div className="grid grid-cols-1 gap-3 md:grid-cols-[minmax(0,1.4fr)_140px_auto]">
                      <FieldSelect
                        label="Item interno"
                        value={String(row.inventoryItemId || '')}
                        onChange={(v) =>
                          updateNewInventoryLink(row.localId, {
                            inventoryItemId: Number(v || 0),
                          })
                        }
                        options={inventoryItemOptions}
                        hint="Aquí eliges el stock real que va a bajar."
                      />
                      <FieldInput
                        label="Cantidad"
                        value={String(row.quantityUnits ?? '')}
                        onChange={(value) =>
                          updateNewInventoryLink(row.localId, {
                            quantityUnits: value,
                          })
                        }
                        type="text"
                        hint="Acepta decimales. Si un servicio trae 25 piezas, va 25. Si una salsa de 5 oz consume 1/8 de una base, va 0.125."
                      />
                      <div className="flex items-end">
                        <button
                          type="button"
                          className="w-full rounded-xl border border-[#5A2626] bg-[#120B0B] px-3 py-2 text-sm text-[#F5B7B7]"
                          onClick={() => removeNewInventoryLink(row.localId)}
                        >
                          Quitar
                        </button>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        ) : null}
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3">
        <FieldCheckbox label="Activo" checked={newIsActive} onChange={setNewIsActive} />
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
        {createCatalogSaving ? 'Creando...' : 'Crear Ã­tem'}
      </button>
    </div>
  </div>
        </Drawer>

      <Drawer
        open={movementOpen}
        title={movementType === 'Ingreso' ? 'Ingreso extraordinario' : 'Egreso extraordinario'}
        onClose={() => {
          setMovementOpen(false);
          resetMoneyMovementForm();
        }}
        widthClass="w-[620px]"
      >
        <div className="space-y-4">
          <div className="text-sm text-[#B7B7C2]">
            Registra movimientos extraordinarios que no nacen desde una orden.
          </div>

          <div className="space-y-2">
            <div className="text-xs text-[#B7B7C2]">Tipo</div>
            <div className="flex gap-2">
              {(['Ingreso', 'Egreso'] as const).map((t) => (
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

          <div className="rounded-2xl border border-[#242433] bg-[#121218] p-4">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <FieldSelect
                label="Cuenta"
                value={movementMoneyAccountId}
                onChange={setMovementMoneyAccountId}
                options={[
                  { value: '', label: 'â€” seleccionar cuenta â€”' },
                  ...moneyAccounts
                    .filter((account) => account.isActive)
                    .map((account) => ({
                      value: String(account.id),
                      label: `${account.name} Â· ${account.currencyCode}`,
                    })),
                ]}
              />
              <FieldInput
                label="Fecha"
                value={movementDate}
                onChange={setMovementDate}
                type="date"
              />
              <FieldInput
                label="Monto"
                value={movementAmount}
                onChange={setMovementAmount}
                hint="Monto real del ingreso o egreso."
              />
              <FieldInput
                label="Referencia / control"
                value={movementReferenceCode}
                onChange={setMovementReferenceCode}
                hint="Opcional."
              />
              <FieldInput
                label="Nombre / contraparte"
                value={movementCounterpartyName}
                onChange={setMovementCounterpartyName}
                hint="Opcional."
              />
              <FieldInput
                label="Motivo"
                value={movementDescription}
                onChange={setMovementDescription}
                hint={movementType === 'Ingreso' ? 'Ej. ingreso extraordinario.' : 'Ej. gasto operativo.'}
              />
              {selectedMovementAccount?.currencyCode === 'VES' ? (
                <FieldInput
                  label="Tasa Bs por USD"
                  value={movementExchangeRate}
                  onChange={setMovementExchangeRate}
                  hint="Obligatoria si la cuenta estÃ¡ en Bs."
                />
              ) : (
                <InfoCell
                  label="Moneda"
                  value={selectedMovementAccount?.currencyCode || 'â€”'}
                />
              )}
            </div>

            <div className="mt-3">
              <label className="mb-1 block text-xs text-[#8A8A96]">Notas</label>
              <textarea
                value={movementNotes}
                onChange={(e) => setMovementNotes(e.target.value)}
                rows={3}
                className="w-full rounded-xl border border-[#242433] bg-[#0B0B0D] px-3 py-2 text-sm text-[#F5F5F7]"
              />
            </div>

            <div className="mt-3 rounded-xl border border-[#242433] bg-[#0B0B0D] p-3 text-sm text-[#B7B7C2]">
              <div>
                Cuenta seleccionada:{' '}
                <span className="font-medium text-[#F5F5F7]">
                  {selectedMovementAccount?.name || 'â€”'}
                </span>
              </div>
              <div className="mt-1">
                Impacto: <span className={movementType === 'Ingreso' ? 'text-emerald-400' : 'text-red-400'}>
                  {movementType === 'Ingreso' ? 'Ingreso' : 'Egreso'}
                </span>
              </div>
            </div>
          </div>

          <div className="flex gap-2">
            <button
              className="rounded-xl border border-[#242433] bg-[#0B0B0D] px-4 py-2 text-sm"
              onClick={() => {
                setMovementOpen(false);
                resetMoneyMovementForm();
              }}
              disabled={movementSaving}
            >
              Cancelar
            </button>
            <button
              className="rounded-xl bg-[#FEEF00] px-4 py-2 text-sm font-semibold text-[#0B0B0D]"
              onClick={handleCreateMoneyMovement}
              disabled={movementSaving}
            >
              {movementSaving ? 'Guardando...' : 'Guardar movimiento'}
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
                      onClick={() => openMoneyMovementDrawer(selectedAccount.id)}
                    >
                      Movimiento
                    </button>
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
              <InfoCell label="InstituciÃ³n" value={selectedAccount.institutionName || 'â€”'} />
              <InfoCell label="Titular" value={selectedAccount.ownerName || 'â€”'} />
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
                        <th className="px-2 py-2 text-left font-medium">NÂ° Orden</th>
                        <th className="px-2 py-2 text-left font-medium">Nombre/Titular</th>
                        <th className="px-2 py-2 text-left font-medium">NÂ° Control</th>
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
                            <td className="px-2 py-2">{linkedOrder?.clientName || '?'}</td>
                            <td className="px-2 py-2">{movement.orderId ?? '?'}</td>
                            <td className="px-2 py-2">
                              {movement.counterpartyName || linkedOrder?.clientName || selectedAccount.ownerName || '?'}
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
        open={deliveryPartnerDetailOpen}
        title={selectedDeliveryPartner ? `Partner: ${selectedDeliveryPartner.name}` : 'Partner externo'}
        onClose={() => setDeliveryPartnerDetailOpen(false)}
        widthClass="w-[720px]"
      >
        {!selectedDeliveryPartner ? (
          <div className="text-sm text-[#B7B7C2]">Sin partner seleccionado.</div>
        ) : (
          <div className="space-y-4">
            <div className="rounded-2xl border border-[#242433] bg-[#121218] p-4">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <div className="text-lg font-semibold text-[#F5F5F7]">{selectedDeliveryPartner.name}</div>
                  <div className="mt-1 text-xs text-[#8A8A96]">
                    Tipo: {selectedDeliveryPartner.partnerType || 'company_dispatch'}
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <SmallBadge
                    label={selectedDeliveryPartner.isActive ? 'Activo' : 'Inactivo'}
                    tone={selectedDeliveryPartner.isActive ? 'brand' : 'muted'}
                  />
                  <button
                    type="button"
                    className="rounded-xl border border-[#242433] bg-[#0B0B0D] px-3 py-2 text-sm"
                    onClick={() => {
                      setSelectedDeliveryPartnerId(selectedDeliveryPartner.id);
                      setDeliveryPartnerFormName(selectedDeliveryPartner.name);
                      setDeliveryPartnerFormType(
                        selectedDeliveryPartner.partnerType === 'direct_driver' ? 'direct_driver' : 'company_dispatch'
                      );
                      setDeliveryPartnerFormWhatsapp(selectedDeliveryPartner.whatsappPhone || '');
                      setDeliveryPartnerFormIsActive(Boolean(selectedDeliveryPartner.isActive));
                      setDeliveryPartnerEditOpen(true);
                    }}
                  >
                    Editar
                  </button>
                  <button
                    type="button"
                    className="rounded-xl border border-[#242433] bg-[#0B0B0D] px-3 py-2 text-sm"
                    onClick={() => handleToggleDeliveryPartnerActive(selectedDeliveryPartner)}
                  >
                    {selectedDeliveryPartner.isActive ? 'Desactivar' : 'Activar'}
                  </button>
                </div>
              </div>

              <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
                <InfoCell label="WhatsApp" value={selectedDeliveryPartner.whatsappPhone || 'â€”'} />
                <InfoCell label="Estado" value={selectedDeliveryPartner.isActive ? 'Activo' : 'Inactivo'} />
                <InfoCell
                  label="Tarifas activas"
                  value={String((selectedDeliveryPartner.rates ?? []).filter((rate) => rate.isActive).length)}
                />
                <InfoCell
                  label="Tarifas totales"
                  value={String((selectedDeliveryPartner.rates ?? []).length)}
                />
              </div>

              <div className="mt-4 rounded-xl border border-[#242433] bg-[#0B0B0D] p-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-sm font-semibold text-[#F5F5F7]">Tarifas por km</div>
                  <button
                    type="button"
                    className="rounded-xl border border-[#242433] bg-[#121218] px-3 py-2 text-sm"
                    onClick={() => {
                      resetDeliveryPartnerRateForm();
                      setDeliveryPartnerRateCreateOpen(true);
                    }}
                  >
                    Nueva tarifa
                  </button>
                </div>

                <div className="mt-3 overflow-x-auto">
                  {(selectedDeliveryPartner.rates ?? []).length === 0 ? (
                    <div className="text-sm text-[#B7B7C2]">Sin tarifas cargadas.</div>
                  ) : (
                    <table className="w-full text-[12px]">
                      <thead className="border-b border-[#242433] text-[#B7B7C2]">
                        <tr>
                          <th className="px-2 py-2 text-left font-medium">Desde km</th>
                          <th className="px-2 py-2 text-left font-medium">Hasta km</th>
                          <th className="px-2 py-2 text-left font-medium">Tarifa</th>
                          <th className="px-2 py-2 text-left font-medium">Estado</th>
                          <th className="px-2 py-2 text-right font-medium">Acciones</th>
                        </tr>
                      </thead>
                      <tbody>
                        {selectedDeliveryPartner.rates.map((rate, idx) => (
                          <tr
                            key={rate.id}
                            className={`${idx % 2 === 0 ? 'bg-[#121218]' : 'bg-[#151522]'} border-b border-[#242433]`}
                          >
                            <td className="px-2 py-2">{rate.kmFrom}</td>
                            <td className="px-2 py-2">{rate.kmTo != null ? rate.kmTo : 'Abierto'}</td>
                            <td className="px-2 py-2">{fmtUSD(rate.priceUsd)}</td>
                            <td className="px-2 py-2">{rate.isActive ? 'Activa' : 'Inactiva'}</td>
                            <td className="px-2 py-2">
                              <div className="flex justify-end gap-2">
                                <button
                                  type="button"
                                  className="rounded-lg border border-[#242433] bg-[#121218] px-2 py-1 text-[11px]"
                                  onClick={() => {
                                    setSelectedDeliveryPartnerRateId(rate.id);
                                    setDeliveryPartnerRateKmFrom(String(rate.kmFrom));
                                    setDeliveryPartnerRateKmTo(rate.kmTo != null ? String(rate.kmTo) : '');
                                    setDeliveryPartnerRatePriceUsd(String(rate.priceUsd));
                                    setDeliveryPartnerRateIsActive(Boolean(rate.isActive));
                                    setDeliveryPartnerRateEditOpen(true);
                                  }}
                                >
                                  Editar
                                </button>
                                <button
                                  type="button"
                                  className="rounded-lg border border-[#242433] bg-[#121218] px-2 py-1 text-[11px]"
                                  onClick={() => handleToggleDeliveryPartnerRateActive(rate)}
                                >
                                  {rate.isActive ? 'Desactivar' : 'Activar'}
                                </button>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
      </Drawer>

      <Drawer
        open={deliveryPartnerCreateOpen}
        title="Nuevo partner externo"
        onClose={() => setDeliveryPartnerCreateOpen(false)}
        widthClass="w-[720px]"
      >
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <FieldInput label="Nombre" value={deliveryPartnerFormName} onChange={setDeliveryPartnerFormName} />
            <FieldSelect
              label="Tipo"
              value={deliveryPartnerFormType}
              onChange={(value) => setDeliveryPartnerFormType(value as 'company_dispatch' | 'direct_driver')}
              options={[
                { value: 'company_dispatch', label: 'company_dispatch' },
                { value: 'direct_driver', label: 'direct_driver' },
              ]}
            />
            <FieldInput label="WhatsApp" value={deliveryPartnerFormWhatsapp} onChange={setDeliveryPartnerFormWhatsapp} />
          </div>
          <label className="flex items-center gap-2 text-sm text-[#F5F5F7]">
            <input
              type="checkbox"
              checked={deliveryPartnerFormIsActive}
              onChange={(e) => setDeliveryPartnerFormIsActive(e.target.checked)}
            />
            Activo
          </label>
          <div className="flex gap-2">
            <button
              className="rounded-xl border border-[#242433] bg-[#0B0B0D] px-4 py-2 text-sm"
              onClick={() => setDeliveryPartnerCreateOpen(false)}
              disabled={deliveryPartnerSaving}
            >
              Cancelar
            </button>
            <button
              className="rounded-xl bg-[#FEEF00] px-4 py-2 text-sm font-semibold text-[#0B0B0D]"
              onClick={handleCreateDeliveryPartner}
              disabled={deliveryPartnerSaving}
            >
              {deliveryPartnerSaving ? 'Guardando...' : 'Crear partner'}
            </button>
          </div>
        </div>
      </Drawer>

      <Drawer
        open={deliveryPartnerEditOpen}
        title={selectedDeliveryPartner ? `Editar: ${selectedDeliveryPartner.name}` : 'Editar partner externo'}
        onClose={() => setDeliveryPartnerEditOpen(false)}
        widthClass="w-[720px]"
      >
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <FieldInput label="Nombre" value={deliveryPartnerFormName} onChange={setDeliveryPartnerFormName} />
            <FieldSelect
              label="Tipo"
              value={deliveryPartnerFormType}
              onChange={(value) => setDeliveryPartnerFormType(value as 'company_dispatch' | 'direct_driver')}
              options={[
                { value: 'company_dispatch', label: 'company_dispatch' },
                { value: 'direct_driver', label: 'direct_driver' },
              ]}
            />
            <FieldInput label="WhatsApp" value={deliveryPartnerFormWhatsapp} onChange={setDeliveryPartnerFormWhatsapp} />
          </div>
          <label className="flex items-center gap-2 text-sm text-[#F5F5F7]">
            <input
              type="checkbox"
              checked={deliveryPartnerFormIsActive}
              onChange={(e) => setDeliveryPartnerFormIsActive(e.target.checked)}
            />
            Activo
          </label>
          <div className="flex gap-2">
            <button
              className="rounded-xl border border-[#242433] bg-[#0B0B0D] px-4 py-2 text-sm"
              onClick={() => setDeliveryPartnerEditOpen(false)}
              disabled={deliveryPartnerSaving}
            >
              Cancelar
            </button>
            <button
              className="rounded-xl bg-[#FEEF00] px-4 py-2 text-sm font-semibold text-[#0B0B0D]"
              onClick={handleUpdateDeliveryPartner}
              disabled={deliveryPartnerSaving}
            >
              {deliveryPartnerSaving ? 'Guardando...' : 'Guardar partner'}
            </button>
          </div>
        </div>
      </Drawer>
      <Drawer
        open={deliveryPartnerRateCreateOpen}
        title={selectedDeliveryPartner ? `Nueva tarifa: ${selectedDeliveryPartner.name}` : 'Nueva tarifa'}
        onClose={() => setDeliveryPartnerRateCreateOpen(false)}
        widthClass="w-[620px]"
      >
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <FieldInput label="Km desde" value={deliveryPartnerRateKmFrom} onChange={setDeliveryPartnerRateKmFrom} type="text" />
            <FieldInput label="Km hasta" value={deliveryPartnerRateKmTo} onChange={setDeliveryPartnerRateKmTo} type="text" />
            <FieldInput label="Tarifa USD" value={deliveryPartnerRatePriceUsd} onChange={setDeliveryPartnerRatePriceUsd} type="text" />
          </div>
          <label className="flex items-center gap-2 text-sm text-[#F5F5F7]">
            <input
              type="checkbox"
              checked={deliveryPartnerRateIsActive}
              onChange={(e) => setDeliveryPartnerRateIsActive(e.target.checked)}
            />
            Activa
          </label>
          <div className="flex gap-2">
            <button
              className="rounded-xl border border-[#242433] bg-[#0B0B0D] px-4 py-2 text-sm"
              onClick={() => setDeliveryPartnerRateCreateOpen(false)}
              disabled={deliveryPartnerRateSaving}
            >
              Cancelar
            </button>
            <button
              className="rounded-xl bg-[#FEEF00] px-4 py-2 text-sm font-semibold text-[#0B0B0D]"
              onClick={handleCreateDeliveryPartnerRate}
              disabled={deliveryPartnerRateSaving}
            >
              {deliveryPartnerRateSaving ? 'Guardando...' : 'Crear tarifa'}
            </button>
          </div>
        </div>
      </Drawer>
      <Drawer
        open={deliveryPartnerRateEditOpen}
        title="Editar tarifa"
        onClose={() => setDeliveryPartnerRateEditOpen(false)}
        widthClass="w-[620px]"
      >
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <FieldInput label="Km desde" value={deliveryPartnerRateKmFrom} onChange={setDeliveryPartnerRateKmFrom} type="text" />
            <FieldInput label="Km hasta" value={deliveryPartnerRateKmTo} onChange={setDeliveryPartnerRateKmTo} type="text" />
            <FieldInput label="Tarifa USD" value={deliveryPartnerRatePriceUsd} onChange={setDeliveryPartnerRatePriceUsd} type="text" />
          </div>
          <label className="flex items-center gap-2 text-sm text-[#F5F5F7]">
            <input
              type="checkbox"
              checked={deliveryPartnerRateIsActive}
              onChange={(e) => setDeliveryPartnerRateIsActive(e.target.checked)}
            />
            Activa
          </label>
          <div className="flex gap-2">
            <button
              className="rounded-xl border border-[#242433] bg-[#0B0B0D] px-4 py-2 text-sm"
              onClick={() => setDeliveryPartnerRateEditOpen(false)}
              disabled={deliveryPartnerRateSaving}
            >
              Cancelar
            </button>
            <button
              className="rounded-xl bg-[#FEEF00] px-4 py-2 text-sm font-semibold text-[#0B0B0D]"
              onClick={handleUpdateDeliveryPartnerRate}
              disabled={deliveryPartnerRateSaving}
            >
              {deliveryPartnerRateSaving ? 'Guardando...' : 'Guardar tarifa'}
            </button>
          </div>
        </div>
      </Drawer>
      <Drawer
        open={inventoryItemCreateOpen}
        title="Nuevo item de inventario"
        onClose={() => {
          setInventoryItemCreateOpen(false);
          resetInventoryItemForm();
        }}
        widthClass="w-[760px]"
      >
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <FieldInput label="Nombre" value={inventoryItemFormName} onChange={setInventoryItemFormName} />
            <FieldSelect
              label="Tipo"
              value={inventoryItemFormKind}
              onChange={(value) => setInventoryItemFormKind(value as InventoryItem['inventoryKind'])}
              options={[
                { value: 'raw_material', label: 'Materia prima' },
                { value: 'prepared_base', label: 'Base preparada' },
                { value: 'finished_stock', label: 'Stock final' },
                { value: 'packaging', label: 'Empaque' },
              ]}
            />
            <FieldSelect
              label="Grupo"
              value={inventoryItemFormGroup}
              onChange={(value) => setInventoryItemFormGroup(value as InventoryItem['inventoryGroup'])}
              options={INVENTORY_GROUP_OPTIONS.map((option) => ({
                value: option.value,
                label: option.label,
              }))}
              hint="Ãšsalo para agrupar por crudos, fritos, prefritos, salsas o envases."
            />
            <FieldInput label="Unidad base" value={inventoryItemFormUnitName} onChange={setInventoryItemFormUnitName} />
            <FieldInput label="Nombre empaque" value={inventoryItemFormPackagingName} onChange={setInventoryItemFormPackagingName} />
            <FieldInput label="Tam. empaque" value={inventoryItemFormPackagingSize} onChange={setInventoryItemFormPackagingSize} type="text" />
            <FieldInput label="Stock actual" value={inventoryItemFormCurrentStock} onChange={setInventoryItemFormCurrentStock} type="text" />
            <FieldInput label="Stock mÃ­nimo" value={inventoryItemFormLowStock} onChange={setInventoryItemFormLowStock} type="text" />
            <label className="flex items-center gap-2 text-sm text-[#F5F5F7]">
              <input
                type="checkbox"
                checked={inventoryItemFormIsActive}
                onChange={(e) => setInventoryItemFormIsActive(e.target.checked)}
              />
              Activo
            </label>
          </div>
          <FieldInput label="Notas" value={inventoryItemFormNotes} onChange={setInventoryItemFormNotes} />
          <div className="flex gap-2">
            <button
              className="rounded-xl border border-[#242433] bg-[#0B0B0D] px-4 py-2 text-sm"
              onClick={() => {
                setInventoryItemCreateOpen(false);
                resetInventoryItemForm();
              }}
              disabled={inventoryItemSaving}
            >
              Cancelar
            </button>
            <button
              className="rounded-xl bg-[#FEEF00] px-4 py-2 text-sm font-semibold text-[#0B0B0D]"
              onClick={handleCreateInventoryItem}
              disabled={inventoryItemSaving}
            >
              {inventoryItemSaving ? 'Guardando...' : 'Crear item'}
            </button>
          </div>
        </div>
      </Drawer>
      <Drawer
        open={inventoryItemEditOpen}
        title={selectedInventoryProduct ? `Editar: ${selectedInventoryProduct.name}` : 'Editar item de inventario'}
        onClose={() => {
          setInventoryItemEditOpen(false);
          resetInventoryItemForm();
        }}
        widthClass="w-[760px]"
      >
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <FieldInput label="Nombre" value={inventoryItemFormName} onChange={setInventoryItemFormName} />
            <FieldSelect
              label="Tipo"
              value={inventoryItemFormKind}
              onChange={(value) => setInventoryItemFormKind(value as InventoryItem['inventoryKind'])}
              options={[
                { value: 'raw_material', label: 'Materia prima' },
                { value: 'prepared_base', label: 'Base preparada' },
                { value: 'finished_stock', label: 'Stock final' },
                { value: 'packaging', label: 'Empaque' },
              ]}
            />
            <FieldSelect
              label="Grupo"
              value={inventoryItemFormGroup}
              onChange={(value) => setInventoryItemFormGroup(value as InventoryItem['inventoryGroup'])}
              options={INVENTORY_GROUP_OPTIONS.map((option) => ({
                value: option.value,
                label: option.label,
              }))}
              hint="Ãšsalo para agrupar por crudos, fritos, prefritos, salsas o envases."
            />
            <FieldInput label="Unidad base" value={inventoryItemFormUnitName} onChange={setInventoryItemFormUnitName} />
            <FieldInput label="Nombre empaque" value={inventoryItemFormPackagingName} onChange={setInventoryItemFormPackagingName} />
            <FieldInput label="Tam. empaque" value={inventoryItemFormPackagingSize} onChange={setInventoryItemFormPackagingSize} type="text" />
            <FieldInput label="Stock actual" value={inventoryItemFormCurrentStock} onChange={setInventoryItemFormCurrentStock} type="text" />
            <FieldInput label="Stock mÃ­nimo" value={inventoryItemFormLowStock} onChange={setInventoryItemFormLowStock} type="text" />
            <label className="flex items-center gap-2 text-sm text-[#F5F5F7]">
              <input
                type="checkbox"
                checked={inventoryItemFormIsActive}
                onChange={(e) => setInventoryItemFormIsActive(e.target.checked)}
              />
              Activo
            </label>
          </div>
          <FieldInput label="Notas" value={inventoryItemFormNotes} onChange={setInventoryItemFormNotes} />
          <div className="flex gap-2">
            <button
              className="rounded-xl border border-[#242433] bg-[#0B0B0D] px-4 py-2 text-sm"
              onClick={() => {
                setInventoryItemEditOpen(false);
                resetInventoryItemForm();
              }}
              disabled={inventoryItemSaving}
            >
              Cancelar
            </button>
            <button
              className="rounded-xl bg-[#FEEF00] px-4 py-2 text-sm font-semibold text-[#0B0B0D]"
              onClick={handleUpdateInventoryItem}
              disabled={inventoryItemSaving}
            >
              {inventoryItemSaving ? 'Guardando...' : 'Guardar item'}
            </button>
          </div>
        </div>
      </Drawer>
      <Drawer
        open={inventoryMovementOpen}
        title={selectedInventoryProduct ? `Inventario: ${selectedInventoryProduct.name}` : 'Movimiento de inventario'}
        onClose={() => {
          setInventoryMovementOpen(false);
          setInventoryDrawerMode('movement');
          resetInventoryMovementForm();
          resetInventoryRecipeForm();
        }}
        widthClass="w-[620px]"
      >
        {!selectedInventoryProduct ? (
          <div className="text-sm text-[#B7B7C2]">Sin producto seleccionado.</div>
        ) : (
          <div className="space-y-4">
            {(() => {
              const availability = inventoryAvailabilityByItemId.get(selectedInventoryProduct.id) ?? {
                readyUnits: selectedInventoryProduct.currentStockUnits,
                potentialUnits: 0,
                totalUnits: selectedInventoryProduct.currentStockUnits,
              };

              return (
                <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                  <div className="rounded-2xl border border-[#242433] bg-[#121218] p-4">
                    <div className="text-xs text-[#8A8A96]">Stock listo</div>
                    <div className="mt-2 text-lg font-semibold text-[#F5F5F7]">
                      {Number(availability.readyUnits.toFixed(3))}
                    </div>
                    <div className="mt-1 text-xs text-[#8A8A96]">{selectedInventoryProduct.unitName}</div>
                  </div>
                  <div className="rounded-2xl border border-[#242433] bg-[#121218] p-4">
                    <div className="text-xs text-[#8A8A96]">Puede reponerse</div>
                    <div className="mt-2 text-lg font-semibold text-emerald-400">
                      {Number(availability.potentialUnits.toFixed(3))}
                    </div>
                    <div className="mt-1 text-xs text-[#8A8A96]">segÃºn receta activa</div>
                  </div>
                  <div className="rounded-2xl border border-[#242433] bg-[#121218] p-4">
                    <div className="text-xs text-[#8A8A96]">Total posible</div>
                    <div className="mt-2 text-lg font-semibold text-[#F5F5F7]">
                      {Number(availability.totalUnits.toFixed(3))}
                    </div>
                    <div className="mt-1 text-xs text-[#8A8A96]">
                      listo + capacidad de producciÃ³n
                    </div>
                  </div>
                </div>
              );
            })()}
            <div className="rounded-2xl border border-[#242433] bg-[#121218] p-4">
              <div className="mb-4 flex flex-wrap gap-2">
                <button
                  className={[
                    'rounded-xl border px-3 py-2 text-sm',
                    inventoryDrawerMode === 'movement'
                      ? 'border-[#FEEF00] bg-[#FEEF00] font-semibold text-[#0B0B0D]'
                      : 'border-[#242433] bg-[#0B0B0D] text-[#F5F5F7]',
                  ].join(' ')}
                  onClick={() => setInventoryDrawerMode('movement')}
                >
                  Movimientos
                </button>
                <button
                  className={[
                    'rounded-xl border px-3 py-2 text-sm',
                    inventoryDrawerMode === 'edit'
                      ? 'border-[#FEEF00] bg-[#FEEF00] font-semibold text-[#0B0B0D]'
                      : 'border-[#242433] bg-[#0B0B0D] text-[#F5F5F7]',
                  ].join(' ')}
                  onClick={() => openInventoryItemEditDrawer(selectedInventoryProduct.id)}
                >
                  Editar
                </button>
                <button
                  className={[
                    'rounded-xl border px-3 py-2 text-sm',
                    inventoryDrawerMode === 'recipe'
                      ? 'border-[#FEEF00] bg-[#FEEF00] font-semibold text-[#0B0B0D]'
                      : 'border-[#242433] bg-[#0B0B0D] text-[#F5F5F7]',
                  ].join(' ')}
                  onClick={() => openInventoryRecipeEditor(selectedInventoryProduct.id)}
                >
                  Receta
                </button>
                {(inventoryRecipesByOutputItemId.get(selectedInventoryProduct.id) ?? []).some((recipe) => recipe.isActive) ? (
                  <button
                    className="rounded-xl border border-[#242433] bg-[#121218] px-3 py-2 text-sm text-[#FEEF00]"
                    onClick={() => openInventoryProductionDrawer(selectedInventoryProduct.id)}
                  >
                    Producir
                  </button>
                ) : null}
                <button
                  className="rounded-xl border border-[#242433] bg-[#0B0B0D] px-3 py-2 text-sm text-[#F5F5F7]"
                  onClick={() => handleToggleInventoryItemActive(selectedInventoryProduct)}
                >
                  {selectedInventoryProduct.isActive ? 'Desactivar' : 'Activar'}
                </button>
              </div>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <InfoCell label="ID" value={String(selectedInventoryProduct.id)} />
                <InfoCell
                  label="Stock actual"
                  value={fmtInventoryUnits(
                    selectedInventoryProduct.currentStockUnits,
                    selectedInventoryProduct.packagingName,
                    selectedInventoryProduct.packagingSize,
                    selectedInventoryProduct.unitName
                  )}
                />
                <InfoCell
                  label="Total unidades"
                  value={`${selectedInventoryProduct.currentStockUnits} ${selectedInventoryProduct.unitName}${selectedInventoryProduct.currentStockUnits === 1 ? '' : 's'}`}
                />
                <InfoCell label="Tipo" value={INVENTORY_KIND_LABEL[selectedInventoryProduct.inventoryKind]} />
                <InfoCell label="Grupo" value={INVENTORY_GROUP_LABEL[selectedInventoryProduct.inventoryGroup]} />
              </div>
            </div>

            {inventoryDrawerMode === 'recipe' ? (
              <div className="space-y-4">
                <div className="rounded-2xl border border-[#242433] bg-[#121218] p-4">
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                    <FieldSelect
                      label="Tipo de receta"
                      value={inventoryRecipeFormKind}
                      onChange={(value) => setInventoryRecipeFormKind(value as 'production' | 'packaging')}
                      options={[
                        { value: 'production', label: 'ProducciÃ³n' },
                        { value: 'packaging', label: 'Empaque' },
                      ]}
                    />
                    <FieldInput
                      label="Salida por lote"
                      value={inventoryRecipeFormOutputUnits}
                      onChange={setInventoryRecipeFormOutputUnits}
                      type="text"
                      hint="CuÃ¡ntas unidades de este item produce un lote."
                    />
                  </div>
                  <div className="mt-3">
                    <FieldInput
                      label="Notas"
                      value={inventoryRecipeFormNotes}
                      onChange={setInventoryRecipeFormNotes}
                    />
                  </div>
                </div>

                <div className="rounded-2xl border border-[#242433] bg-[#121218] p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-sm font-semibold text-[#F5F5F7]">Insumos de la receta</div>
                      <div className="mt-1 text-xs text-[#8A8A96]">
                        AquÃ­ conectas este item con otros items internos, por ejemplo mayonesa y lechuga.
                      </div>
                    </div>
                    <button
                      type="button"
                      className="rounded-xl border border-[#242433] bg-[#0B0B0D] px-3 py-2 text-sm text-[#F5F5F7]"
                      onClick={addInventoryRecipeRow}
                    >
                      Agregar insumo
                    </button>
                  </div>

                  <div className="mt-3 space-y-3">
                    {inventoryRecipeRows.length === 0 ? (
                      <div className="rounded-xl border border-dashed border-[#242433] px-3 py-3 text-sm text-[#8A8A96]">
                        Agrega al menos un insumo. Ejemplo: Mayonesa x 0.5 y Lechuga x 0.2 para producir una salsa base.
                      </div>
                    ) : (
                      inventoryRecipeRows.map((row) => (
                        <div key={row.localId} className="rounded-xl border border-[#242433] bg-[#0B0B0D] p-3">
                          <div className="grid grid-cols-1 gap-3 md:grid-cols-[minmax(0,1.5fr)_150px_auto]">
                            <FieldSelect
                              label="Item interno"
                              value={String(row.inputInventoryItemId || '')}
                              onChange={(value) =>
                                updateInventoryRecipeRow(row.localId, {
                                  inputInventoryItemId: Number(value || 0),
                                })
                              }
                              options={[
                                { value: '', label: 'â€” seleccionar â€”' },
                                ...inventoryItemOptions.filter((option) => Number(option.value) !== selectedInventoryProduct.id),
                              ]}
                              hint="El insumo real que se consumirÃ¡."
                            />
                            <FieldInput
                              label="Cantidad"
                              value={String(row.quantityUnits ?? '')}
                              onChange={(value) =>
                                updateInventoryRecipeRow(row.localId, {
                                  quantityUnits: value,
                                })
                              }
                              type="text"
                              hint="Acepta decimales. Ejemplo: 0.125, 0.5 o 8."
                            />
                            <div className="flex items-end">
                              <button
                                type="button"
                                className="w-full rounded-xl border border-[#5A2626] bg-[#120B0B] px-3 py-2 text-sm text-[#F5B7B7]"
                                onClick={() => removeInventoryRecipeRow(row.localId)}
                              >
                                Quitar
                              </button>
                            </div>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>

                <div className="flex gap-2">
                  <button
                    className="rounded-xl border border-[#242433] bg-[#0B0B0D] px-4 py-2 text-sm"
                    onClick={() => setInventoryDrawerMode('movement')}
                    disabled={inventoryRecipeSaving}
                  >
                    Volver
                  </button>
                  <button
                    className="rounded-xl bg-[#FEEF00] px-4 py-2 text-sm font-semibold text-[#0B0B0D]"
                    onClick={handleSaveInventoryRecipe}
                    disabled={inventoryRecipeSaving}
                  >
                    {inventoryRecipeSaving ? 'Guardando...' : 'Guardar receta'}
                  </button>
                </div>
              </div>
            ) : inventoryDrawerMode === 'edit' ? (
              <div className="rounded-2xl border border-[#242433] bg-[#121218] p-4">
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                  <FieldInput label="Nombre" value={inventoryItemFormName} onChange={setInventoryItemFormName} />
                  <FieldSelect
                    label="Tipo"
                    value={inventoryItemFormKind}
                    onChange={(value) => setInventoryItemFormKind(value as InventoryItem['inventoryKind'])}
                    options={[
                      { value: 'raw_material', label: 'Materia prima' },
                      { value: 'prepared_base', label: 'Base preparada' },
                      { value: 'finished_stock', label: 'Stock final' },
                      { value: 'packaging', label: 'Empaque' },
                    ]}
                  />
                  <FieldSelect
                    label="Grupo"
                    value={inventoryItemFormGroup}
                    onChange={(value) => setInventoryItemFormGroup(value as InventoryItem['inventoryGroup'])}
                    options={INVENTORY_GROUP_OPTIONS.map((option) => ({
                      value: option.value,
                      label: option.label,
                    }))}
                    hint="Ãšsalo para agrupar por crudos, fritos, prefritos, salsas o envases."
                  />
                  <FieldInput label="Unidad base" value={inventoryItemFormUnitName} onChange={setInventoryItemFormUnitName} />
                  <FieldInput label="Nombre empaque" value={inventoryItemFormPackagingName} onChange={setInventoryItemFormPackagingName} />
                  <FieldInput label="Tam. empaque" value={inventoryItemFormPackagingSize} onChange={setInventoryItemFormPackagingSize} type="text" />
                  <FieldInput label="Stock actual" value={inventoryItemFormCurrentStock} onChange={setInventoryItemFormCurrentStock} type="text" />
                  <FieldInput label="Stock mÃ­nimo" value={inventoryItemFormLowStock} onChange={setInventoryItemFormLowStock} type="text" />
                  <label className="flex items-center gap-2 text-sm text-[#F5F5F7]">
                    <input
                      type="checkbox"
                      checked={inventoryItemFormIsActive}
                      onChange={(e) => setInventoryItemFormIsActive(e.target.checked)}
                    />
                    Activo
                  </label>
                </div>
                <div className="mt-3">
                  <FieldInput label="Notas" value={inventoryItemFormNotes} onChange={setInventoryItemFormNotes} />
                </div>
                <div className="mt-4 flex gap-2">
                  <button
                    className="rounded-xl border border-[#242433] bg-[#0B0B0D] px-4 py-2 text-sm"
                    onClick={() => setInventoryDrawerMode('movement')}
                    disabled={inventoryItemSaving}
                  >
                    Volver
                  </button>
                  <button
                    className="rounded-xl bg-[#FEEF00] px-4 py-2 text-sm font-semibold text-[#0B0B0D]"
                    onClick={handleUpdateInventoryItem}
                    disabled={inventoryItemSaving}
                  >
                    {inventoryItemSaving ? 'Guardando...' : 'Guardar item'}
                  </button>
                </div>
              </div>
            ) : (
              <>
                <div className="rounded-2xl border border-[#242433] bg-[#121218] p-4">
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                    <FieldSelect
                      label="Tipo de movimiento"
                      value={inventoryMovementType}
                      onChange={(value) =>
                        setInventoryMovementType(
                          value as 'inbound' | 'damage' | 'waste' | 'manual_adjustment' | 'stock_count'
                        )
                      }
                      options={[
                        { value: 'inbound', label: 'Entrada' },
                        { value: 'damage', label: 'AverÃ­a' },
                        { value: 'waste', label: 'Merma' },
                        { value: 'manual_adjustment', label: 'Ajuste manual' },
                        { value: 'stock_count', label: 'Conteo fÃ­sico' },
                      ]}
                    />
                    <FieldInput
                      label="Motivo"
                      value={inventoryMovementReasonCode}
                      onChange={setInventoryMovementReasonCode}
                    />
                    <FieldInput
                      label={selectedInventoryProduct.packagingName ? selectedInventoryProduct.packagingName : 'Empaques'}
                      value={inventoryMovementPackagingQty}
                      onChange={setInventoryMovementPackagingQty}
                      type="text"
                    />
                    <FieldInput
                      label={selectedInventoryProduct.unitName || 'Unidades'}
                      value={inventoryMovementUnitQty}
                      onChange={setInventoryMovementUnitQty}
                      type="text"
                    />
                  </div>

                  <div className="mt-3">
                    <FieldInput
                      label="Notas"
                      value={inventoryMovementNotes}
                      onChange={setInventoryMovementNotes}
                    />
                  </div>

                  <div className="mt-4 rounded-xl border border-[#242433] bg-[#0B0B0D] p-3 text-sm text-[#B7B7C2]">
                    Total del movimiento:{' '}
                    <span className="font-semibold text-[#F5F5F7]">
                      {fmtInventoryUnits(
                        (Number(String(inventoryMovementPackagingQty || '0').replace(',', '.')) || 0) *
                          Number(selectedInventoryProduct.packagingSize || 0) +
                          (Number(String(inventoryMovementUnitQty || '0').replace(',', '.')) || 0),
                        selectedInventoryProduct.packagingName,
                        selectedInventoryProduct.packagingSize,
                        selectedInventoryProduct.unitName
                      )}
                    </span>
                  </div>

                  <div className="mt-4 flex gap-2">
                    <button
                      className="rounded-xl border border-[#242433] bg-[#0B0B0D] px-4 py-2 text-sm"
                      onClick={() => {
                        setInventoryMovementOpen(false);
                        resetInventoryMovementForm();
                      }}
                      disabled={inventoryMovementSaving}
                    >
                      Cancelar
                    </button>
                    <button
                      className="rounded-xl bg-[#FEEF00] px-4 py-2 text-sm font-semibold text-[#0B0B0D]"
                      onClick={handleCreateInventoryMovement}
                      disabled={inventoryMovementSaving}
                    >
                      {inventoryMovementSaving ? 'Guardando...' : 'Guardar movimiento'}
                    </button>
                  </div>
                </div>

                <div className="rounded-2xl border border-[#242433] bg-[#121218] p-4">
                  <div className="text-sm font-semibold text-[#F5F5F7]">Ãšltimos movimientos</div>
                  <div className="mt-3 space-y-2">
                    {(inventoryMovementsByItemId.get(selectedInventoryProduct.id) ?? [])
                      .slice(0, 8)
                      .map((movement) => {
                        const linkedOrder = movement.orderId ? orderLookupById.get(movement.orderId) : null;
                        return (
                          <div
                            key={movement.id}
                            className="rounded-xl border border-[#242433] bg-[#0B0B0D] px-3 py-2 text-sm"
                          >
                            <div className="flex items-center justify-between gap-3">
                              <div className="font-medium text-[#F5F5F7]">
                                {INVENTORY_MOVEMENT_LABEL[movement.movementType] || movement.movementType}
                              </div>
                              <div className="text-xs text-[#8A8A96]">{fmtDateTimeES(movement.createdAt)}</div>
                            </div>
                            <div className="mt-1 text-xs text-[#B7B7C2]">
                              {fmtInventoryUnits(
                                movement.quantityUnits,
                                selectedInventoryProduct.packagingName,
                                selectedInventoryProduct.packagingSize,
                                selectedInventoryProduct.unitName
                              )}
                              {movement.reasonCode ? ` Â· ${movement.reasonCode}` : ""}
                            </div>
                            {linkedOrder ? (
                              <div className="mt-1 text-xs text-[#8A8A96]">
                                Orden {linkedOrder.orderNumber} Â· {linkedOrder.clientName}
                              </div>
                            ) : null}
                            {movement.notes ? (
                              <div className="mt-1 text-xs text-[#6F6F7C]">{movement.notes}</div>
                            ) : null}
                          </div>
                        );
                      })}
                    {(inventoryMovementsByItemId.get(selectedInventoryProduct.id) ?? []).length === 0 ? (
                      <div className="text-sm text-[#B7B7C2]">Sin movimientos registrados.</div>
                    ) : null}
                  </div>
                </div>
              </>
            )}
          </div>
        )}
      </Drawer>
      <Drawer
        open={inventoryProductionOpen}
        title={selectedInventoryProduct ? `ProducciÃ³n: ${selectedInventoryProduct.name}` : 'ProducciÃ³n'}
        onClose={() => {
          setInventoryProductionOpen(false);
          resetInventoryProductionForm();
        }}
        widthClass="w-[720px]"
      >
        {!selectedInventoryProduct ? (
          <div className="text-sm text-[#B7B7C2]">Sin producto seleccionado.</div>
        ) : selectedInventoryRecipes.length === 0 ? (
          <div className="text-sm text-[#B7B7C2]">Este producto todavÃ­a no tiene una receta activa.</div>
        ) : (
          <div className="space-y-4">
            <div className="rounded-2xl border border-[#242433] bg-[#121218] p-4">
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <FieldSelect
                  label="Receta"
                  value={String(selectedInventoryRecipe?.id ?? '')}
                  onChange={(value) => setSelectedInventoryRecipeId(Number(value))}
                  options={selectedInventoryRecipes.map((recipe) => ({
                      value: String(recipe.id),
                      label:
                        recipe.recipeKind === 'packaging'
                        ? `Empaque Â· ${recipe.outputQuantityUnits} und`
                        : `ProducciÃ³n Â· ${recipe.outputQuantityUnits} und`,
                    }))}
                />
                <FieldInput
                  label="Lotes"
                  value={inventoryProductionBatches}
                  onChange={setInventoryProductionBatches}
                  type="text"
                />
              </div>

              <div className="mt-3">
                <FieldInput
                  label="Notas"
                  value={inventoryProductionNotes}
                  onChange={setInventoryProductionNotes}
                />
              </div>
            </div>

            <div className="rounded-2xl border border-[#242433] bg-[#121218] p-4">
              <div className="text-sm font-semibold text-[#F5F5F7]">Consumo de receta</div>
              <div className="mt-3 space-y-2">
                {selectedInventoryRecipeComponents.map((component) => {
                  const product = inventoryItemById.get(component.inputInventoryItemId);
                  const multiplier = Number(String(inventoryProductionBatches || '0').replace(',', '.')) || 0;
                  const quantityUnits = component.quantityUnits * Math.max(0, multiplier);
                  return (
                    <div
                      key={component.id}
                      className="rounded-xl border border-[#242433] bg-[#0B0B0D] px-3 py-2"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div className="font-medium text-[#F5F5F7]">{product?.name || 'Insumo'}</div>
                        <div className="text-sm text-[#B7B7C2]">
                          {fmtInventoryUnits(
                            quantityUnits,
                            product?.packagingName ?? null,
                            product?.packagingSize ?? null,
                            product?.unitName ?? 'pieza'
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="rounded-2xl border border-[#242433] bg-[#121218] p-4">
              <div className="text-sm font-semibold text-[#F5F5F7]">Resultado</div>
              <div className="mt-3 text-sm text-[#B7B7C2]">
                Se sumarÃ¡n{' '}
                <span className="font-semibold text-[#F5F5F7]">
                  {fmtInventoryUnits(
                    (selectedInventoryRecipe?.outputQuantityUnits ?? 0) *
                      (Number(String(inventoryProductionBatches || '0').replace(',', '.')) || 0),
                    selectedInventoryProduct.packagingName,
                    selectedInventoryProduct.packagingSize,
                    selectedInventoryProduct.unitName
                  )}
                </span>{' '}
                a {selectedInventoryProduct.name}.
              </div>
            </div>

            <div className="flex gap-2">
              <button
                className="rounded-xl border border-[#242433] bg-[#0B0B0D] px-4 py-2 text-sm"
                onClick={() => {
                  setInventoryProductionOpen(false);
                  resetInventoryProductionForm();
                }}
                disabled={inventoryProductionSaving}
              >
                Cancelar
              </button>
              <button
                className="rounded-xl bg-[#FEEF00] px-4 py-2 text-sm font-semibold text-[#0B0B0D]"
                onClick={handleCreateInventoryProduction}
                disabled={inventoryProductionSaving}
              >
                {inventoryProductionSaving ? 'Guardando...' : 'Registrar producciÃ³n'}
              </button>
            </div>
          </div>
        )}
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
                    <SmallBadge label={fmtClientTypeLabel(selectedClient.clientType)} tone="muted" />
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
                      ? repairDisplayText(advisorNameById.get(selectedClient.primaryAdvisorId) || 'Asesor')
                      : '—'
                  }
                />
                <InfoCell
                  label="Fondo disponible"
                  value={
                    selectedClient.fundBalanceUsd > 0.005
                      ? fmtUSD(selectedClient.fundBalanceUsd)
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
                  <InfoCell label="RazÃ³n social" value={selectedClient.billingCompanyName || 'â€”'} />
                  <InfoCell label="RIF / documento" value={selectedClient.billingTaxId || 'â€”'} />
                  <InfoCell label="TelÃ©fono" value={selectedClient.billingPhone || 'â€”'} />
                  <InfoCell label="DirecciÃ³n fiscal" value={selectedClient.billingAddress || 'â€”'} />
                </div>
              </div>

              <div className="rounded-2xl border border-[#242433] bg-[#121218] p-4">
                <div className="text-sm font-semibold text-[#F5F5F7]">Nota de entrega</div>
                <div className="mt-4 grid grid-cols-1 gap-3">
                  <InfoCell label="Nombre" value={selectedClient.deliveryNoteName || 'â€”'} />
                  <InfoCell
                    label="Documento"
                    value={selectedClient.deliveryNoteDocumentId || 'â€”'}
                  />
                  <InfoCell label="TelÃ©fono" value={selectedClient.deliveryNotePhone || 'â€”'} />
                  <InfoCell
                    label="DirecciÃ³n"
                    value={selectedClient.deliveryNoteAddress || 'â€”'}
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
                      <div className="text-xs text-[#8A8A96]">DirecciÃ³n {idx + 1}</div>
                      <div className="mt-2 text-sm text-[#F5F5F7]">{address.addressText || 'â€”'}</div>
                      <div className="mt-3 text-xs text-[#8A8A96]">GPS</div>
                      <div className="mt-1 break-all text-sm text-[#B7B7C2]">{address.gpsUrl || 'â€”'}</div>
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
            <div className="text-sm font-semibold text-[#F5F5F7]">Datos bÃ¡sicos</div>
            <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
              <FieldInput label="Nombre completo" value={clientFormFullName} onChange={setClientFormFullName} />
              <FieldInput label="TelÃ©fono" value={clientFormPhone} onChange={setClientFormPhone} />
              <FieldInput label="Tipo de cliente" value={clientFormType} onChange={setClientFormType} />
              <FieldSelect
                label="Asesor principal"
                value={clientFormPrimaryAdvisorId}
                onChange={setClientFormPrimaryAdvisorId}
                options={[
                  { value: '', label: 'â€” sin asesor principal â€”' },
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
              <FieldInput label="CumpleaÃ±os" value={clientFormBirthDate} onChange={setClientFormBirthDate} type="date" />
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
                  label="RazÃ³n social"
                  value={clientFormBillingCompanyName}
                  onChange={setClientFormBillingCompanyName}
                />
                <FieldInput label="RIF / documento" value={clientFormBillingTaxId} onChange={setClientFormBillingTaxId} />
                <FieldInput label="TelÃ©fono" value={clientFormBillingPhone} onChange={setClientFormBillingPhone} />
                <div>
                  <label className="mb-1 block text-xs text-[#8A8A96]">DirecciÃ³n fiscal</label>
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
                  label="TelÃ©fono"
                  value={clientFormDeliveryNotePhone}
                  onChange={setClientFormDeliveryNotePhone}
                />
                <div>
                  <label className="mb-1 block text-xs text-[#8A8A96]">DirecciÃ³n</label>
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
                  <label className="mb-1 block text-xs text-[#8A8A96]">DirecciÃ³n 1</label>
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
                  <label className="mb-1 block text-xs text-[#8A8A96]">DirecciÃ³n 2</label>
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
            <div className="text-sm font-semibold text-[#F5F5F7]">Datos bÃ¡sicos</div>
            <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
              <FieldInput label="Nombre completo" value={clientFormFullName} onChange={setClientFormFullName} />
              <FieldInput label="TelÃ©fono" value={clientFormPhone} onChange={setClientFormPhone} />
              <FieldInput label="Tipo de cliente" value={clientFormType} onChange={setClientFormType} />
              <FieldSelect
                label="Asesor principal"
                value={clientFormPrimaryAdvisorId}
                onChange={setClientFormPrimaryAdvisorId}
                options={[
                  { value: '', label: 'â€” sin asesor principal â€”' },
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
              <FieldInput label="CumpleaÃ±os" value={clientFormBirthDate} onChange={setClientFormBirthDate} type="date" />
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
                  label="RazÃ³n social"
                  value={clientFormBillingCompanyName}
                  onChange={setClientFormBillingCompanyName}
                />
                <FieldInput label="RIF / documento" value={clientFormBillingTaxId} onChange={setClientFormBillingTaxId} />
                <FieldInput label="TelÃ©fono" value={clientFormBillingPhone} onChange={setClientFormBillingPhone} />
                <div>
                  <label className="mb-1 block text-xs text-[#8A8A96]">DirecciÃ³n fiscal</label>
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
                  label="TelÃ©fono"
                  value={clientFormDeliveryNotePhone}
                  onChange={setClientFormDeliveryNotePhone}
                />
                <div>
                  <label className="mb-1 block text-xs text-[#8A8A96]">DirecciÃ³n</label>
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
                  <label className="mb-1 block text-xs text-[#8A8A96]">DirecciÃ³n 1</label>
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
                  <label className="mb-1 block text-xs text-[#8A8A96]">DirecciÃ³n 2</label>
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
    <div className="flex items-center justify-between rounded-2xl border border-[#242433] bg-[#121218] px-4 py-2.5">
      <div className="text-[13px] text-[#B7B7C2]">
        {orderEditorMode === 'edit'
          ? 'Revisa venta, cliente y pedido.'
          : 'Completa venta, cliente y pedido.'}
      </div>

      <span
        className={[
          'rounded-full px-3 py-1 text-[11px] font-semibold',
          orderEditorMode === 'edit'
            ? 'bg-orange-500 text-[#0B0B0D]'
            : 'bg-[#FEEF00] text-[#0B0B0D]',
        ].join(' ')}
      >
          {orderEditorMode === 'edit' ? 'Editar' : 'Crear'}
      </span>
    </div>
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
<div className="rounded-2xl border border-[#242433] bg-[#121218] p-4">
  <div className="text-sm font-semibold text-[#F5F5F7]">Venta</div>

  <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
    <FieldSelect
      label="Origen"
      value={createOrderSource}
      onChange={(value) =>
        setCreateOrderSource(value as 'advisor' | 'master' | 'walk_in')
      }
      options={[
        { value: 'master', label: 'Master' },
        { value: 'advisor', label: 'Asesor' },
        { value: 'walk_in', label: 'Walk-in' },
      ]}
    />

{createOrderSource === 'advisor' ? (
  <div>
    <FieldSelect
      label="Asesor"
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
      {advisors.filter((a) => a.isActive).length} asesores activos
    </div>
  </div>
) : (
  <div>
    <label className="mb-1 block text-xs text-[#8A8A96]">Asesor</label>
    <div className="w-full rounded-xl border border-[#242433] bg-[#0B0B0D] px-3 py-2 text-sm text-[#F5F5F7]">
      {currentOperatorLabel}
    </div>
  </div>
)}
  </div>
</div>


      <div className="rounded-2xl border border-[#242433] bg-[#121218] p-4">
        <div className="text-sm font-semibold text-[#F5F5F7]">Cliente</div>

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
    placeholder="Buscar por nombre o teléfono"
    className="w-full rounded-xl border border-[#242433] bg-[#0B0B0D] px-3 py-2 text-[13px] text-[#F5F5F7] placeholder:text-[#8A8A96]"
  />

  <button
    className="rounded-xl border border-[#242433] bg-[#0B0B0D] px-3 py-2 text-[13px]"
    type="submit"
  >
    {createOrderClientSearchLoading ? 'Buscando...' : 'Buscar'}
  </button>

  <button
    className="rounded-xl border border-[#242433] bg-[#0B0B0D] px-3 py-2 text-[13px]"
    onClick={handleActivateCreateOrderNewClient}
    type="button"
  >
    Nuevo
  </button>
</form>


          {createOrderSelectedClientId ? (
            <div className="rounded-xl border border-emerald-500/40 bg-[#0B0B0D] px-3 py-2 text-sm">
              <div className="grid grid-cols-2 gap-3">
                <div className="min-w-0">
                  <div className="truncate font-medium text-emerald-400">
                    {createOrderSelectedClientName}
                  </div>
                  <div className="mt-1 text-[#B7B7C2]">
                    Tel: {createOrderSelectedClientPhone || '—'}
                  </div>
                </div>
                <div className="min-w-0 text-[#B7B7C2]">
                  <div className="truncate">Tipo: {fmtClientTypeLabel(createOrderSelectedClientType)}</div>
                  <div className="mt-1">
                    Fondo:{' '}
                    <span className="text-[#F5F5F7]">
                      {createOrderClientFundAvailableUsd > 0.005
                        ? fmtUSD(createOrderClientFundAvailableUsd)
                        : '—'}
                    </span>
                  </div>
                </div>
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
                    {repairDisplayText(client.fullName)}
                  </div>
                  <div className="mt-1 text-xs text-[#B7B7C2]">
                    Tel: {client.phone || '—'} · Tipo: {fmtClientTypeLabel(client.clientType)}
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
        <div className="text-sm font-semibold text-[#F5F5F7]">Pedido</div>

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
  placeholder="Buscar producto..."
  className="w-full rounded-xl border border-[#242433] bg-[#0B0B0D] px-3 py-2 text-[13px] text-[#F5F5F7] placeholder:text-[#8A8A96]"
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
{(() => {
  const availability = productAvailabilityById.get(item.id) ?? null;
  const readyUnits = availability ? Number(availability.readyUnits.toFixed(3)) : null;
  const potentialUnits = availability ? Number(availability.potentialUnits.toFixed(3)) : null;
  const totalUnits = availability ? Number(availability.totalUnits.toFixed(3)) : null;

  return (
    <>

              <div className="text-sm font-medium text-[#F5F5F7]">
                {repairDisplayText(item.name)}
              </div>
<div className="mt-1 text-xs text-[#8A8A96]">
  {item.unitsPerService > 0 ? `${item.unitsPerService} und/serv` : '—'} ·{' '}
  {item.sourcePriceCurrency === 'VES'
    ? fmtBs(item.basePriceBs)
    : fmtUSD(item.basePriceUsd)}
</div>
              {availability ? (
                <div className="mt-2 text-[11px]">
                  <div className="text-[#8A8A96]">
                    Listo: <span className="text-[#F5F5F7]">{readyUnits}</span>
                    {potentialUnits && potentialUnits > 0 ? (
                      <>
                        {' '}· Puede producirse:{' '}
                        <span className="text-emerald-400">{potentialUnits}</span>
                        {' '}· Total posible:{' '}
                        <span className="text-[#F5F5F7]">{totalUnits}</span>
                      </>
                    ) : null}
                  </div>
                </div>
              ) : null}
    </>
  );
})()}
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
                className="grid grid-cols-1 gap-2 rounded-xl border border-[#242433] bg-[#0B0B0D] p-2.5 md:grid-cols-[28px_1fr_78px_96px_96px_auto]"
              >
                <div className="text-[12px] text-[#8A8A96]">{idx + 1}</div>

<div>
  <div className="text-[13px] font-medium text-[#F5F5F7]">{repairDisplayText(item.productNameSnapshot)}</div>

  {getVisibleEditableDetailLines(item.editableDetailLines).length > 0 ? (
    <div className="mt-1.5 space-y-0.5 text-[11px] text-[#B7B7C2]">
      {getVisibleEditableDetailLines(item.editableDetailLines).map((detail, detailIdx) => (
        <div key={detailIdx}>• {repairDisplayText(detail)}</div>
      ))}
    </div>
  ) : null}
</div>

<FieldInput
  label="Cantidad"
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
  <label className="mb-1 block text-[11px] text-[#8A8A96]">P/U</label>
  <div className="rounded-xl border border-[#242433] bg-[#121218] px-2.5 py-1.5 text-[13px] text-[#F5F5F7]">
    {item.adminPriceOverrideUsd != null ? (
      <div>
        <div>{fmtUSD(item.adminPriceOverrideUsd)}</div>
        <div className="mt-1 text-[11px] text-orange-400">
          Orig: {item.sourcePriceCurrency === 'VES' ? fmtBs(item.sourcePriceAmount) : fmtUSD(item.sourcePriceAmount)}
        </div>
      </div>
    ) : item.sourcePriceCurrency === 'VES'
      ? fmtBs(item.sourcePriceAmount)
      : fmtUSD(item.sourcePriceAmount)}
  </div>
</div>

<div>
  <label className="mb-1 block text-[11px] text-[#8A8A96]">Total</label>
  <div className="rounded-xl border border-[#242433] bg-[#121218] px-2.5 py-1.5 text-[13px] text-[#F5F5F7]">
    {fmtUSD(item.lineTotalUsd)}
  </div>
</div>

<div className="flex items-end">
  <div className="flex w-full flex-wrap gap-1.5">
    {getVisibleEditableDetailLines(item.editableDetailLines).length > 0 ? (
      <button
        type="button"
        onClick={() => openEditCreateOrderConfig(item)}
        className="rounded-lg border border-[#242433] bg-[#121218] px-2 py-1 text-[11px] text-[#F5F5F7]"
        title="Editar"
      >
        Editar
      </button>
    ) : null}

    {isAdmin ? (
      <button
        type="button"
        onClick={() => openAdjustCreateOrderItemPrice(item)}
        className="rounded-lg border border-[#242433] bg-[#121218] px-2 py-1 text-[11px] text-[#F5F5F7]"
        title={item.adminPriceOverrideUsd != null ? 'Ajuste admin' : 'Ajustar precio'}
      >
        {item.adminPriceOverrideUsd != null ? 'Ajuste' : 'Precio'}
      </button>
    ) : null}

    {isAdmin && item.adminPriceOverrideUsd != null ? (
      <button
        type="button"
        onClick={() => handleClearAdjustedCreateOrderItemPrice(item.localId)}
        className="rounded-lg border border-orange-500 bg-[#0B0B0D] px-2 py-1 text-[11px] text-orange-400"
        title="Limpiar ajuste"
      >
        Limpiar
      </button>
    ) : null}

    <button
      type="button"
      onClick={() => handleRemoveCreateOrderItem(item.localId)}
      className="rounded-lg border border-red-500 bg-[#0B0B0D] px-2 py-1 text-[11px] text-red-400"
      title="Quitar"
    >
      Quitar
    </button>
  </div>
</div>
{item.adminPriceOverrideUsd != null && item.adminPriceOverrideReason ? (
  <div className="md:col-span-full rounded-xl border border-orange-500/30 bg-[#121218] px-3 py-2 text-xs text-orange-300">
    Ajuste admin: {item.adminPriceOverrideReason}
  </div>
) : null}
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

  <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,560px)_minmax(320px,1fr)]">
    <div className="grid grid-cols-1 gap-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_auto]">
        <FieldSelect
          label="Tipo"
          value={createOrderFulfillment}
          onChange={(value) => {
            const next = value as 'pickup' | 'delivery';
            setCreateOrderFulfillment(next);
            if (next === 'delivery' && selectedCreateOrderClientAddresses[0]) {
              handleApplyClientAddress(selectedCreateOrderClientAddresses[0], 0);
            }
          }}
          options={[
            { value: 'pickup', label: 'Pickup' },
            { value: 'delivery', label: 'Delivery' },
          ]}
        />

        <div>
          <label className="mb-1 block text-xs text-[#8A8A96]">Hora</label>
          <div className="grid grid-cols-[72px_72px_92px] gap-2">
            <input
              value={createOrderDeliveryHour12}
              onChange={(e) => {
                setCreateOrderDeliveryHour12(e.target.value);
                setCreateOrderIsAsap(false);
              }}
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              className="w-full rounded-xl border border-[#242433] bg-[#0B0B0D] px-3 py-2 text-center text-sm text-[#F5F5F7]"
            />
            <input
              value={createOrderDeliveryMinute}
              onChange={(e) => {
                setCreateOrderDeliveryMinute(e.target.value);
                setCreateOrderIsAsap(false);
              }}
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              className="w-full rounded-xl border border-[#242433] bg-[#0B0B0D] px-3 py-2 text-center text-sm text-[#F5F5F7]"
            />
            <select
              value={createOrderDeliveryAmPm}
              onChange={(e) => {
                setCreateOrderDeliveryAmPm(e.target.value as 'AM' | 'PM');
                setCreateOrderIsAsap(false);
              }}
              className="w-full rounded-xl border border-[#242433] bg-[#0B0B0D] px-3 py-2 text-center text-sm text-[#F5F5F7]"
            >
              <option value="AM">AM</option>
              <option value="PM">PM</option>
            </select>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_auto] sm:items-start">
        <FieldInput
          label="Fecha"
          value={createOrderDeliveryDate}
          onChange={(value) => {
            setCreateOrderDeliveryDate(value);
            setCreateOrderIsAsap(false);
          }}
          type="date"
        />

        <div className="flex flex-wrap gap-2 sm:pt-[21px]">
          <button
            type="button"
            onClick={() => {
              if (createOrderIsAsap) {
                setCreateOrderIsAsap(false);
              } else {
                applyCreateOrderAsap();
              }
            }}
            className={[
              'rounded-xl border px-3 py-2 text-sm transition',
              createOrderIsAsap
                ? 'border-[#FEEF00] bg-[#FEEF00]/10 text-[#FEEF00]'
                : 'border-[#242433] bg-[#0B0B0D] text-[#B7B7C2]',
            ].join(' ')}
          >
            Lo antes posible
          </button>

          {createOrderFulfillment === 'delivery' &&
          selectedCreateOrderClientAddresses.length > 0
            ? selectedCreateOrderClientAddresses.map((address, idx) => (
                <button
                  key={`${address.addressText}-${idx}`}
                  type="button"
                  onClick={() => handleApplyClientAddress(address, idx)}
                  className={[
                    'rounded-xl border px-3 py-2 text-sm transition',
                    createOrderSelectedAddressIndex === idx
                      ? 'border-[#FEEF00] bg-[#FEEF00]/10 text-[#FEEF00]'
                      : 'border-[#242433] bg-[#0B0B0D] text-[#B7B7C2]',
                  ].join(' ')}
                >
                  Dirección {idx + 1}
                </button>
              ))
            : null}
        </div>
      </div>

      <FieldCheckbox
        label="Recibe otra persona"
        checked={createOrderReceiverIsDifferent}
        onChange={(value) => {
          setCreateOrderReceiverIsDifferent(value);
          if (!value) {
            setCreateOrderReceiverName('');
            setCreateOrderReceiverPhone('');
          }
        }}
      />

      {createOrderReceiverIsDifferent ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
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
        <>
          <div className="min-w-0">
            <label className="mb-1 block text-xs text-[#8A8A96]">Dirección</label>
            <textarea
              value={createOrderDeliveryAddress}
              onChange={(e) => {
                setCreateOrderDeliveryAddress(e.target.value);
                setCreateOrderSelectedAddressIndex(null);
              }}
              rows={3}
              className="w-full rounded-xl border border-[#242433] bg-[#0B0B0D] px-3 py-2 text-sm text-[#F5F5F7]"
            />
          </div>

          <FieldInput
            label="GPS URL"
            value={createOrderDeliveryGpsUrl}
            onChange={setCreateOrderDeliveryGpsUrl}
          />
        </>
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

  {false && selectedCreateOrderClient && createOrderClientFundAvailableUsd > 0.005 ? (
    <div className="mt-3 rounded-xl border border-emerald-500/20 bg-[#0B0B0D] p-3">
      <div className="text-sm font-semibold text-[#F5F5F7]">Uso de fondo del cliente</div>
      <div className="mt-1 text-xs text-[#8A8A96]">
        Disponible: {fmtUSD(createOrderClientFundAvailableUsd)}. Puedes usarlo como abono sin mover caja.
      </div>
      <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
        <FieldCheckbox
          label="Usar fondo del cliente"
          checked={createOrderUseClientFund}
          onChange={(value) => {
            setCreateOrderUseClientFund(value);
            if (value) {
              const suggested = Math.max(
                0,
                Math.min(
                  Number(createOrderDraftTotalUsd.toFixed(2)),
                  Number(createOrderClientFundAvailableUsd.toFixed(2))
                )
              );
              setCreateOrderClientFundAmountUsd(
                suggested > 0.005 ? String(Number(suggested.toFixed(2))) : ''
              );
            } else {
              setCreateOrderClientFundAmountUsd('');
            }
          }}
        />
        <FieldInput
          label="Monto a aplicar (USD)"
          value={createOrderClientFundAmountUsd}
          onChange={setCreateOrderClientFundAmountUsd}
          type="text"
          hint="MÃ¡ximo: saldo del cliente o total de la orden."
        />
      </div>
      {createOrderUseClientFund ? (
        <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
          <InfoCell label="Fondo aplicado" value={fmtUSD(createOrderAppliedFundUsd)} />
          <InfoCell label="Resta por cobrar" value={fmtUSD(createOrderRemainingAfterFundUsd)} />
        </div>
      ) : null}
    </div>
  ) : null}

  {createOrderHasInvoice ? (
    <div className="mt-3 grid grid-cols-1 gap-3 rounded-xl border border-[#242433] bg-[#0B0B0D] p-3 md:grid-cols-2">
      <FieldInput
        label="Nombre / razÃ³n social"
        value={createOrderInvoiceCompanyName}
        onChange={setCreateOrderInvoiceCompanyName}
      />
      <FieldInput
        label="RIF / documento"
        value={createOrderInvoiceTaxId}
        onChange={setCreateOrderInvoiceTaxId}
      />
      <FieldInput
        label="TelÃ©fono"
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
        <label className="mb-1 block text-xs text-[#8A8A96]">DirecciÃ³n fiscal</label>
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
        label="TelÃ©fono"
        value={createOrderDeliveryNotePhone}
        onChange={setCreateOrderDeliveryNotePhone}
      />
      <div className="md:col-span-2">
        <label className="mb-1 block text-xs text-[#8A8A96]">DirecciÃ³n</label>
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
    <label className="mb-1 block text-xs text-[#8A8A96]">ObservaciÃ³n de pago</label>
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
        value={createOrderSelectedClientName || createOrderNewClientName || 'â€”'}
      />

      <InfoCell
        label="Fondo cliente"
        value={
          selectedCreateOrderClient && createOrderClientFundAvailableUsd > 0.005
            ? fmtUSD(createOrderClientFundAvailableUsd)
            : 'â€”'
        }
      />

      <InfoCell label="Tipo" value={createOrderFulfillment} />

      <InfoCell label="Source" value={createOrderSource} />

      <InfoCell
        label="Asesor"
        value={
          createOrderSource === 'advisor'
            ? advisors.find((advisor) => advisor.userId === createOrderAdvisorUserId)?.fullName || '?'
            : currentOperatorLabel
        }
      />

      <InfoCell label="Ítems" value={String(createOrderDraftItems.length)} />

      <InfoCell
        label="Tasa"
        value={createOrderFxRateNumber > 0 ? fmtRateBs(createOrderFxRateNumber) : 'â€”'}
      />

      <InfoCell
        label="Subtotal"
        value={fmtBs(createOrderDraftSubtotalBs)}
      />

      <InfoCell
        label="Total"
        value={`${fmtBs(createOrderDraftTotalBs)} / ${fmtUSD(createOrderDraftTotalUsd)}`}
      />

      {createOrderUseClientFund ? (
        <InfoCell
          label="Fondo aplicado"
          value={fmtUSD(createOrderAppliedFundUsd)}
        />
      ) : null}

      {createOrderUseClientFund ? (
        <InfoCell
          label="Pendiente tras fondo"
          value={fmtUSD(createOrderRemainingAfterFundUsd)}
        />
      ) : null}

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
              : 'SÃ­'
          }
        />
      ) : null}

      {createOrderHasDeliveryNote ? (
        <InfoCell
          label="Nota de entrega"
          value="SÃ­"
        />
      ) : null}

      {createOrderHasInvoice ? (
        <InfoCell
          label="Factura"
          value="SÃ­"
        />
      ) : null}

      {createOrderDiscountEnabled && createOrderDiscountPctNumber > 0 ? (
        <InfoCell
          label="Descuento"
          value={`${createOrderDiscountPctNumber}% Â· -${fmtBs(createOrderDiscountAmountBs)}`}
        />
      ) : null}

      {createOrderHasInvoice && createOrderInvoiceTaxPctNumber > 0 ? (
        <InfoCell
          label="IVA"
          value={`${createOrderInvoiceTaxPctNumber}% Â· +${fmtBs(createOrderInvoiceTaxAmountBs)}`}
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
              .join(' | ') || 'â€”'}
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
              .join(' | ') || 'â€”'}
          </div>
        ) : null}
      </div>
    ) : null}

    <div className="space-y-2 rounded-xl border border-[#242433] bg-[#0B0B0D] p-3 text-sm">
      <div className={createOrderHasClient ? 'text-emerald-400' : 'text-red-400'}>
        {createOrderHasClient ? 'Cliente listo' : 'Falta cliente'}
      </div>

      <div className={createOrderHasItems ? 'text-emerald-400' : 'text-red-400'}>
        {createOrderHasItems ? 'Pedido con ítems' : 'Falta agregar ítems'}
      </div>

      <div className={createOrderHasValidAdvisor ? 'text-emerald-400' : 'text-red-400'}>
        {createOrderHasValidAdvisor ? 'Asesor válido' : 'Debes seleccionar asesor'}
      </div>

      <div className={createOrderHasDeliveryAddress ? 'text-emerald-400' : 'text-red-400'}>
        {createOrderHasDeliveryAddress ? 'Entrega válida' : 'Falta dirección de delivery'}
      </div>
      <div className={createOrderHasDeliveryChargeItem ? 'text-emerald-400' : 'text-red-400'}>
        {createOrderHasDeliveryChargeItem ? 'Ítem de delivery cargado' : 'Falta producto de delivery'}
      </div>
    </div>

{orderEditorMode === 'edit' && selectedOrder?.status === 'queued' ? (
  <div className="rounded-xl border border-orange-500/40 bg-[#0B0B0D] p-3 text-sm text-orange-400">
    Esta edición marcará la orden para <span className="font-semibold">re-aprobación</span>.
  </div>
) : null}

{orderEditorMode === 'edit' && isAdmin && selectedOrder && !['created', 'queued'].includes(selectedOrder.status) ? (
  <div className="rounded-xl border border-sky-500/30 bg-[#0B0B0D] p-3 text-sm text-sky-200">
    <div className="font-semibold text-sky-300">Modificación administrativa</div>
    <div className="mt-1">
      Estás editando una orden avanzada o cerrada. El cambio quedará auditado y requiere motivo obligatorio.
    </div>
    <div className="mt-3">
      <label className="mb-1 block text-xs text-[#8A8A96]">Motivo de la modificación</label>
      <textarea
        value={adminEditReason}
        onChange={(e) => setAdminEditReason(e.target.value)}
        rows={3}
        className="w-full rounded-xl border border-[#242433] bg-[#121218] px-3 py-2 text-sm text-[#F5F5F7]"
      />
    </div>
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
  open={priceAdjustOpen}
  title="Ajuste administrativo de precio"
  onClose={resetPriceAdjustBox}
  widthClass="w-[440px]"
>
  <div className="space-y-3">
    <FieldInput
      label="Precio unitario ajustado (USD)"
      value={priceAdjustValue}
      onChange={setPriceAdjustValue}
      type="text"
    />
    <div>
      <label className="mb-1 block text-xs text-[#8A8A96]">Motivo</label>
      <textarea
        value={priceAdjustReason}
        onChange={(e) => setPriceAdjustReason(e.target.value)}
        rows={3}
        className="w-full rounded-xl border border-[#242433] bg-[#0B0B0D] px-3 py-2 text-[13px] text-[#F5F5F7]"
      />
    </div>
    <div className="flex gap-2">
      <button
        className="rounded-xl border border-[#242433] bg-[#0B0B0D] px-4 py-2 text-sm"
        onClick={resetPriceAdjustBox}
        type="button"
      >
        Cancelar
      </button>
      <button
        className="rounded-xl bg-[#FEEF00] px-4 py-2 text-sm font-semibold text-[#0B0B0D]"
        onClick={handleSaveAdjustedCreateOrderItemPrice}
        type="button"
      >
        Guardar ajuste
      </button>
    </div>
  </div>
</Drawer>

<Drawer
  open={createOrderConfigOpen}
  title={createOrderConfigProductName || 'Configurar producto'}
  onClose={closeCreateOrderConfig}
  widthClass="w-[620px]"
>
  <div className="space-y-3">
    <div className="rounded-2xl border border-[#242433] bg-[#121218] p-3">
      <div className="grid grid-cols-3 gap-2.5">
        <InfoCell label="Producto" value={repairDisplayText(createOrderConfigProductName || '—')} />
        <InfoCell label="Cantidad" value={String(createOrderConfigQty)} />
        <InfoCell label="Límite" value={String(createOrderConfigLimit || 0)} />
      </div>

      <div className="mt-2.5 grid grid-cols-[1fr_120px] gap-2.5">
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
    className="w-full rounded-xl border border-[#242433] bg-[#0B0B0D] px-3 py-2 text-[13px] text-[#F5F5F7]"
  />
</div>

        <div>
          <label className="mb-1 block text-xs text-[#8A8A96]">Total piezas</label>
          <div className="rounded-xl border border-[#242433] bg-[#0B0B0D] px-3 py-2 text-[13px] text-[#F5F5F7]">
            {createOrderConfigSelectedUnits} / {createOrderConfigLimit}
          </div>
        </div>
      </div>
    </div>

    <div className="rounded-2xl border border-[#242433] bg-[#121218] p-3">
      <div className="text-sm font-semibold text-[#F5F5F7]">Composición</div>

      {createOrderConfigSelectableOptions.length === 0 && createOrderConfigOptionalFixedOptions.length === 0 ? (
        <div className="mt-2.5 rounded-xl border border-[#242433] bg-[#0B0B0D] px-3 py-3 text-[13px] text-[#B7B7C2]">
          Este producto no tiene opciones configuradas.
        </div>
      ) : (
        <div className="mt-2.5 space-y-3">
          {createOrderConfigOptionalFixedOptions.length > 0 ? (
            <div className="space-y-1.5">
              <div className="text-xs font-semibold uppercase tracking-[0.18em] text-[#8A8A96]">
                Opcionales
              </div>
              {createOrderConfigOptionalFixedOptions.map((option) => {
                const currentQty =
                  createOrderConfigSelections.find((x) => x.componentProductId === option.componentProductId)?.qty || 0;
                const isSelected = currentQty > 0;
                const availability = productAvailabilityById.get(option.componentProductId) ?? null;

                return (
                  <div
                    key={`fixed-${option.componentProductId}`}
                    className="grid grid-cols-[minmax(0,1fr)_96px] items-center gap-2 rounded-xl border border-[#242433] bg-[#0B0B0D] px-3 py-2"
                  >
                    <div className="min-w-0">
                      <div className="truncate text-[13px] font-medium text-[#F5F5F7]">
                        {repairDisplayText(option.componentName)}
                      </div>
                      <div className="mt-0.5 truncate text-[11px] text-[#8A8A96]">
                        {availability ? `Listo: ${Number(availability.readyUnits.toFixed(3))}` : 'Sin disponibilidad calculada'}
                      </div>
                    </div>

                    <button
                      type="button"
                      className={[
                        'rounded-lg border px-2 py-1.5 text-[12px] font-medium transition',
                        isSelected
                          ? 'border-[#FEEF00] bg-[#262400] text-[#FEEF00]'
                          : 'border-[#242433] bg-[#121218] text-[#B7B7C2]',
                      ].join(' ')}
                      onClick={() =>
                        handleSetCreateOrderConfigSelectionQty(
                          option.componentProductId,
                          option.componentName,
                          isSelected ? 0 : Number(option.quantity || 1)
                        )
                      }
                    >
                      {isSelected ? 'Quitar' : 'Incluir'}
                    </button>
                  </div>
                );
              })}
            </div>
          ) : null}

          {createOrderConfigSelectableOptions.length > 0 ? (
            <div className="space-y-1.5">
              <div className="text-xs font-semibold uppercase tracking-[0.18em] text-[#8A8A96]">
                Seleccionables
              </div>
          {createOrderConfigSelectableOptions.map((option, idx) => {
            const currentQty =
              createOrderConfigSelections.find((x) => x.componentProductId === option.id)?.qty || 0;
            const availability = productAvailabilityById.get(option.id) ?? null;
 
return (
  <div
    key={option.id}
    className="grid grid-cols-[minmax(0,1fr)_108px] items-center gap-2 rounded-xl border border-[#242433] bg-[#0B0B0D] px-3 py-2"
  >
    <div className="min-w-0">
      <div className="truncate text-[13px] font-medium text-[#F5F5F7]">
        {repairDisplayText(option.name)}
      </div>
      <div className="mt-0.5 truncate text-[11px] text-[#8A8A96]">
        {availability ? (
          <>
            Listo: {Number(availability.readyUnits.toFixed(3))}
            {availability.potentialUnits > 0 ? (
              <> · Puede producirse: <span className="text-emerald-400">{Number(availability.potentialUnits.toFixed(3))}</span></>
            ) : null}
          </>
        ) : (
          'Sin disponibilidad calculada'
        )}
      </div>
    </div>

    <div className="flex items-center justify-end gap-2">
      <label className="text-[11px] text-[#8A8A96]">Cantidad</label>
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
        className="w-[58px] rounded-lg border border-[#242433] bg-[#121218] px-2 py-1.5 text-[13px] text-[#F5F5F7]"
      />
    </div>
  </div>
);
          })}
            </div>
          ) : null}
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


