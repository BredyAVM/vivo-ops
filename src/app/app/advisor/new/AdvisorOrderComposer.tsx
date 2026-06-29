'use client';

import { type FormEvent, type ReactNode, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { getPaymentMethodLabel as getSharedPaymentMethodLabel } from '@/lib/orders/order-labels';
import { getOrderMoneySnapshot } from '@/lib/orders/order-money';
import { getPhoneSearchTerms, normalizePhone } from '@/lib/phone/normalize-phone';
import { normalizeRemoteSearchValue, normalizeSearchValue, splitSearchTokens } from '@/lib/search/normalize-search';
import { createSupabaseBrowser } from '@/lib/supabase/browser';
import { calculateOrderLineSnapshot, calculateOrderTotalsSnapshot } from '@/lib/pricing/order-snapshots';
import {
  buildWhatsAppOrderSummaryText,
  cleanWhatsAppUnitsFromName,
  formatWhatsAppBs,
  formatWhatsAppDateVE,
  formatWhatsAppQuantity,
  formatWhatsAppTimeAmPm,
  getWhatsAppLineUnits,
} from '@/lib/orders/whatsapp-summary';
import {
  ensureAdvisorOrderCreatedEventAction,
  markAdvisorOrderDraftConvertedAction,
  replaceAdvisorOrderItemsAction,
  saveAdvisorOrderDraftAction,
  updateAdvisorOrderHeaderAction,
} from './actions';

type ClientType = 'assigned' | 'own' | 'legacy';
type FulfillmentType = 'pickup' | 'delivery';
type PaymentMethod =
  | 'pending'
  | 'payment_mobile'
  | 'transfer'
  | 'cash_usd'
  | 'cash_ves'
  | 'pos'
  | 'zelle'
  | 'wallet_usd'
  | 'mixed';
type CurrencyCode = 'USD' | 'VES';

type ClientRow = {
  id: number;
  full_name: string;
  phone: string | null;
  client_type: string | null;
  fund_balance_usd?: number | string | null;
  recent_addresses?: unknown;
  billing_company_name?: string | null;
  billing_tax_id?: string | null;
  billing_address?: string | null;
  billing_phone?: string | null;
  delivery_note_name?: string | null;
  delivery_note_document_id?: string | null;
  delivery_note_address?: string | null;
  delivery_note_phone?: string | null;
};

type ProductRow = {
  id: number;
  sku: string | null;
  name: string;
  type: 'product' | 'combo' | 'service' | 'promo' | 'gambit' | null;
  base_price_usd: number | string | null;
  source_price_currency: CurrencyCode | null;
  source_price_amount: number | string | null;
  units_per_service: number | null;
  is_detail_editable: boolean | null;
  detail_units_limit: number | null;
};

type ProductComponentRow = {
  parent_product_id: number;
  component_product_id: number;
  component_mode: 'fixed' | 'selectable';
  quantity: number | null;
  counts_toward_detail_limit: boolean | null;
  is_required: boolean | null;
  sort_order: number | null;
};

type ConfigSelection = {
  componentProductId: number;
  name: string;
  qty: number;
};

type ConfigOption = ProductRow & {
  componentMode: ProductComponentRow['component_mode'];
  componentQuantity: number;
  isRequired: boolean;
  countsTowardDetailLimit: boolean;
  sortOrder: number;
};

type DraftItem = {
  localId: string;
  product_id: number;
  product_type: ProductRow['type'];
  sku_snapshot: string | null;
  product_name_snapshot: string;
  units_per_service: number;
  qty: number;
  source_price_currency: CurrencyCode;
  source_price_amount: number;
  unit_price_usd_snapshot: number;
  line_total_usd: number;
  editable_detail_lines: string[];
};

type ClientAddress = {
  addressText: string;
  gpsUrl: string;
};

type RecentClientChip = {
  id: number;
  full_name: string;
  phone: string | null;
  client_type: string | null;
  fund_balance_usd?: number | string | null;
  recent_addresses?: unknown;
  billing_company_name?: string | null;
  billing_tax_id?: string | null;
  billing_address?: string | null;
  billing_phone?: string | null;
  delivery_note_name?: string | null;
  delivery_note_document_id?: string | null;
  delivery_note_address?: string | null;
  delivery_note_phone?: string | null;
};

type ExistingOrderRow = {
  id: number;
  order_number?: string | null;
  total_usd?: number | string | null;
  status: string | null;
  last_modified_at?: string | null;
  last_modified_by?: string | null;
  fulfillment: FulfillmentType;
  delivery_address: string | null;
  receiver_name: string | null;
  receiver_phone: string | null;
  notes: string | null;
  extra_fields: {
    schedule?: {
      date?: string | null;
      time_12?: string | null;
      asap?: boolean | null;
    } | null;
    delivery?: {
      gps_url?: string | null;
    } | null;
    payment?: {
      method?: PaymentMethod | null;
      currency?: CurrencyCode | null;
      requires_change?: boolean | null;
      change_for?: string | number | null;
      change_currency?: CurrencyCode | null;
      notes?: string | null;
    } | null;
    pricing?: {
      discount_enabled?: boolean | null;
      discount_pct?: number | string | null;
      fx_rate?: number | string | null;
      recalculation_required?: boolean | null;
      recalculation_fx_rate?: number | string | null;
      recalculation_requested_at?: string | null;
      invoice_tax_pct?: number | string | null;
      invoice_tax_amount_usd?: number | string | null;
      invoice_tax_amount_bs?: number | string | null;
      total_bs?: number | string | null;
    } | null;
    documents?: {
      has_delivery_note?: boolean | null;
      has_invoice?: boolean | null;
      invoice_data_note?: string | null;
      invoice_snapshot?: {
        company_name?: string | null;
        tax_id?: string | null;
        address?: string | null;
        phone?: string | null;
      } | null;
      delivery_note_snapshot?: {
        name?: string | null;
        document_id?: string | null;
        address?: string | null;
        phone?: string | null;
      } | null;
    } | null;
    note?: string | null;
  } | null;
  client:
    | ClientRow[]
    | ClientRow
    | null;
};

type ExistingOrderItemRow = {
  id: number;
  product_id: number;
  qty: number | string;
  pricing_origin_currency: CurrencyCode | null;
  pricing_origin_amount: number | string | null;
  unit_price_usd_snapshot: number | string | null;
  line_total_usd: number | string | null;
  sku_snapshot: string | null;
  product_name_snapshot: string | null;
  notes: string | null;
  product:
    | {
        type: ProductRow['type'];
        units_per_service: number | null;
      }[]
    | {
        type: ProductRow['type'];
        units_per_service: number | null;
      }
    | null;
};

type OrderEditSnapshot = {
  clientId: number | null;
  fulfillment: FulfillmentType;
  deliveryDate: string;
  deliveryTime12: string;
  isAsap: boolean;
  receiverName: string;
  receiverPhone: string;
  deliveryAddress: string;
  deliveryGpsUrl: string;
  orderNote: string;
  paymentMethod: PaymentMethod;
  paymentCurrency: CurrencyCode;
  paymentRequiresChange: boolean;
  paymentChangeFor: string;
  paymentChangeCurrency: CurrencyCode;
  paymentNote: string;
  fxRate: string;
  discountEnabled: boolean;
  discountPct: string;
  hasInvoice: boolean;
  invoiceTaxPct: string;
  hasDeliveryNote: boolean;
  invoiceCompanyName: string;
  invoiceTaxId: string;
  invoiceAddress: string;
  invoicePhone: string;
  deliveryNoteName: string;
  deliveryNoteDocumentId: string;
  deliveryNoteAddress: string;
  deliveryNotePhone: string;
  totalUsd: number;
  totalBs: number;
  items: Array<{
    productId: number;
    productName: string;
    qty: number;
    lineTotalUsd: number;
    detailLines: string[];
  }>;
};

type AdvisorOrderDraftStatus = 'draft' | 'quoted' | 'converted' | 'archived';

type AdvisorOrderDraftPayload = {
  version?: number;
  clientId?: number | null;
  fulfillment?: FulfillmentType;
  deliveryDate?: string;
  deliveryHour12?: string;
  deliveryMinute?: string;
  deliveryAmPm?: 'AM' | 'PM';
  isAsap?: boolean;
  receiverName?: string;
  receiverPhone?: string;
  deliveryAddress?: string;
  deliveryGpsUrl?: string;
  orderNote?: string;
  paymentMethod?: PaymentMethod;
  paymentCurrency?: CurrencyCode;
  paymentRequiresChange?: boolean;
  paymentChangeFor?: string;
  paymentChangeCurrency?: CurrencyCode;
  paymentNote?: string;
  fxRate?: string;
  discountEnabled?: boolean;
  discountPct?: string;
  invoiceTaxPct?: string;
  hasDeliveryNote?: boolean;
  hasInvoice?: boolean;
  invoiceCompanyName?: string;
  invoiceTaxId?: string;
  invoiceAddress?: string;
  invoicePhone?: string;
  deliveryNoteName?: string;
  deliveryNoteDocumentId?: string;
  deliveryNoteAddress?: string;
  deliveryNotePhone?: string;
  newClient?: {
    fullName?: string;
    phone?: string;
    type?: ClientType;
  };
  items?: DraftItem[];
};

type AdvisorOrderDraftInitial = {
  id: number;
  status: AdvisorOrderDraftStatus | string | null;
  title: string | null;
  client_id: number | string | null;
  client_snapshot: Partial<ClientRow> | null;
  new_client_snapshot: Record<string, unknown> | null;
  payload: AdvisorOrderDraftPayload | null;
  quote_text: string | null;
  total_usd: number | string | null;
  total_bs: number | string | null;
  fx_rate: number | string | null;
  quoted_at: string | null;
  updated_at: string | null;
};

const STORAGE_KEYS = {
  recentClients: 'advisor_recent_clients_v1',
  recentProducts: 'advisor_recent_products_v1',
  favoriteProducts: 'advisor_favorite_products_v1',
  recentAddresses: 'advisor_recent_addresses_v1',
  clientUsage: 'advisor_client_usage_v1',
  productUsage: 'advisor_product_usage_v1',
  displayName: 'advisor_display_name_v1',
  catalogCache: 'advisor_catalog_cache_v1',
} as const;

const ADVISOR_CATALOG_CACHE_TTL_MS = 5 * 60 * 1000;

type AdvisorCatalogCache = {
  cachedAt: number;
  products: ProductRow[];
  productComponents: ProductComponentRow[];
  activeRate: number;
};

function pad2(n: number) {
  return String(n).padStart(2, '0');
}

function pad4(n: number) {
  return String(n).padStart(4, '0');
}

function todayKey() {
  const now = new Date();
  return `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}`;
}

function getTodayInputValue() {
  const now = new Date();
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

function getCaracasCurrentMinuteKey() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Caracas',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date());
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value || '';

  return `${value('year')}-${value('month')}-${value('day')}T${value('hour')}:${value('minute')}`;
}

function isPastAdvisorSchedule(date: string, time24: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time24)) return false;
  return `${date}T${time24}` < getCaracasCurrentMinuteKey();
}

function getRoundedTime() {
  const date = new Date();
  date.setSeconds(0, 0);
  const mins = date.getMinutes();

  if (mins > 0 && mins < 30) date.setMinutes(30);
  else if (mins > 30) {
    date.setHours(date.getHours() + 1);
    date.setMinutes(0);
  }

  return date;
}

function to12h(date: Date) {
  const hour24 = date.getHours();
  const minute = date.getMinutes();
  const ampm: 'AM' | 'PM' = hour24 >= 12 ? 'PM' : 'AM';
  let hour12 = hour24 % 12;
  if (hour12 === 0) hour12 = 12;
  return { hour12: String(hour12), minute: pad2(minute), ampm };
}

function from12hTo24h(hour12: string, minute: string, ampm: 'AM' | 'PM') {
  let hour = Number(hour12);
  const mins = Number(minute);

  if (!Number.isFinite(hour) || hour < 1 || hour > 12) throw new Error('Hora invalida.');
  if (!Number.isFinite(mins) || mins < 0 || mins > 59) throw new Error('Minutos invalidos.');

  if (ampm === 'AM') {
    if (hour === 12) hour = 0;
  } else if (hour !== 12) {
    hour += 12;
  }

  return `${pad2(hour)}:${pad2(mins)}`;
}

function parseStoredTime12(value: string | null | undefined, fallback: { hour12: string; minute: string; ampm: 'AM' | 'PM' }) {
  const match = String(value || '')
    .trim()
    .match(/^(\d{1,2})[:.](\d{2})\s*(AM|PM)$/i);

  if (!match) return fallback;

  return {
    hour12: String(Number(match[1] || fallback.hour12)),
    minute: pad2(Number(match[2] || fallback.minute)),
    ampm: String(match[3] || fallback.ampm).toUpperCase() === 'PM' ? 'PM' : 'AM',
  } as const;
}

function sanitizeQuantityInput(value: string | number | null | undefined) {
  const raw = String(value ?? '').trim().replace(',', '.');
  const cleaned = raw.replace(/[^\d.]/g, '');
  const firstDot = cleaned.indexOf('.');

  if (firstDot === -1) return cleaned;

  return `${cleaned.slice(0, firstDot + 1)}${cleaned.slice(firstDot + 1).replace(/\./g, '')}`;
}

function parseQuantityValue(value: string | number | null | undefined) {
  const normalized = sanitizeQuantityInput(value);
  if (!normalized || normalized === '.') return Number.NaN;

  const amount = Number(normalized);
  return Number.isFinite(amount) ? amount : Number.NaN;
}

function formatUsd(value: number) {
  return `$${value.toFixed(2)}`;
}

function formatBs(value: number) {
  return `Bs ${value.toFixed(2)}`;
}

function formatBsWhatsApp(value: number) {
  return formatWhatsAppBs(value);
}

const HIDDEN_DETAIL_PREFIX = '@sel|';
const WHATSAPP_PRIMARY_BULLET = '\u2022';

function formatQuantityValue(value: number) {
  return formatWhatsAppQuantity(value);
}

function getPaymentMethodLabel(method: PaymentMethod) {
  return getSharedPaymentMethodLabel(method, { lowercase: true });
}

function getVisibleDetailLines(lines: string[]) {
  return lines
    .map((line) => normalizeSnapshotText(line))
    .filter((line) => line && !line.startsWith(HIDDEN_DETAIL_PREFIX));
}

function isHiddenDetailLine(line: string) {
  return String(line || '').trim().startsWith(HIDDEN_DETAIL_PREFIX);
}

function formatDraftItemWhatsAppLine(item: DraftItem, fxRateNumber: number) {
  const lineBs =
    item.source_price_currency === 'VES'
      ? Number(item.source_price_amount || 0) * Number(item.qty || 0)
      : Number(item.line_total_usd || 0) * fxRateNumber;
  const normalizedName = normalizeSnapshotText(item.product_name_snapshot) || 'Item';
  const isDelivery = isDeliveryCatalogItemName(normalizedName);

  if (isDelivery) {
    return `${WHATSAPP_PRIMARY_BULLET} ${formatWhatsAppQuantity(item.qty)} ${normalizedName}: ${formatBsWhatsApp(lineBs)}`;
  }

  const units = getWhatsAppLineUnits({
    qty: item.qty,
    name: normalizedName,
    unitsPerService: item.units_per_service,
  });
  if (units !== null) {
    const cleanName = cleanWhatsAppUnitsFromName(normalizedName);
    const servicePrefix = item.product_type === 'service' ? 'Serv. ' : '';
    return `${WHATSAPP_PRIMARY_BULLET} ${formatWhatsAppQuantity(item.qty)} ${servicePrefix}${cleanName} (${formatWhatsAppQuantity(units)} und): ${formatBsWhatsApp(lineBs)}`;
  }

  return `${WHATSAPP_PRIMARY_BULLET} ${formatWhatsAppQuantity(item.qty)} ${normalizedName}: ${formatBsWhatsApp(lineBs)}`;
}

function toSafeNumber(value: unknown, fallback = 0) {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : fallback;
}

function getProductSourcePricing(product: ProductRow) {
  const sourceCurrency = (product.source_price_currency || 'USD') as CurrencyCode;
  const sourceAmount =
    Number(
      product.source_price_amount ??
        (sourceCurrency === 'USD' ? product.base_price_usd : 0) ??
        0
    ) || 0;

  return { sourceCurrency, sourceAmount };
}

function calculateCatalogSnapshotForDraftItem(item: DraftItem, product: ProductRow, fxRateNumber: number) {
  const { sourceCurrency, sourceAmount } = getProductSourcePricing(product);
  const snapshot = calculateOrderLineSnapshot({
    sourceCurrency,
    sourceAmount,
    quantity: Number(item.qty || 0),
    fxRate: fxRateNumber,
    fallbackUnitUsd: Number(product.base_price_usd ?? item.unit_price_usd_snapshot ?? 0),
  });

  return { sourceCurrency, sourceAmount, snapshot };
}

function draftItemHasCatalogPriceDrift(item: DraftItem, product: ProductRow, fxRateNumber: number) {
  const current = calculateCatalogSnapshotForDraftItem(item, product, fxRateNumber);
  const epsilon = current.sourceCurrency === 'VES' ? 0.01 : 0.005;

  return (
    item.source_price_currency !== current.sourceCurrency ||
    Math.abs(Number(item.source_price_amount || 0) - current.sourceAmount) > epsilon
  );
}

function buildRepeatedDraftItemFromCatalog(input: {
  item: ExistingOrderItemRow;
  product: ProductRow;
  activeRate: number;
}): DraftItem {
  const qty = Number(input.item.qty || 0);
  const { sourceCurrency, sourceAmount } = getProductSourcePricing(input.product);
  const snapshot = calculateOrderLineSnapshot({
    sourceCurrency,
    sourceAmount,
    quantity: qty,
    fxRate: input.activeRate,
    fallbackUnitUsd: Number(input.product.base_price_usd ?? 0),
  });

  return {
    localId: `repeat-${input.item.id}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    product_id: input.product.id,
    product_type: input.product.type,
    sku_snapshot: input.product.sku,
    product_name_snapshot: input.product.name,
    units_per_service: Number(input.product.units_per_service ?? 0) || 0,
    qty,
    source_price_currency: sourceCurrency,
    source_price_amount: sourceAmount,
    unit_price_usd_snapshot: snapshot.unitUsd,
    line_total_usd: snapshot.lineUsd,
    editable_detail_lines: input.item.notes?.trim()
      ? input.item.notes
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
      : [],
  };
}

function clientTypeLabel(value: string | null | undefined) {
  if (value === 'assigned') return 'Asignado';
  if (value === 'own') return 'Propio';
  if (value === 'legacy') return 'Antiguo';
  return 'Sin clasificar';
}

function normalizeClientAddresses(input: unknown): ClientAddress[] {
  if (!Array.isArray(input)) return [];
  return input
    .map((row) => {
      const data = row && typeof row === 'object' ? (row as Record<string, unknown>) : {};
      const addressText = String(data.address_text ?? data.addressText ?? '').trim();
      const gpsUrl = String(data.gps_url ?? data.gpsUrl ?? '').trim();
      return { addressText, gpsUrl };
    })
    .filter((row) => row.addressText || row.gpsUrl)
    .slice(0, 2);
}

function mergeRecentAddresses(currentValue: unknown, nextAddressText: string, nextGpsUrl: string) {
  const current = normalizeClientAddresses(currentValue).map((row) => ({
    address_text: row.addressText,
    gps_url: row.gpsUrl || null,
  }));
  const normalizedAddressText = String(nextAddressText || '').trim();
  const normalizedGpsUrl = String(nextGpsUrl || '').trim() || null;

  if (!normalizedAddressText && !normalizedGpsUrl) {
    return current.slice(0, 2);
  }

  const nextEntry = {
    address_text: normalizedAddressText,
    gps_url: normalizedGpsUrl,
  };

  return [
    nextEntry,
    ...current.filter(
      (row) =>
        !(
          String(row.address_text || '').trim() === normalizedAddressText &&
          String(row.gps_url || '').trim() === String(normalizedGpsUrl || '').trim()
        ),
    ),
  ].slice(0, 2);
}

function readStoredJson<T>(key: string, fallback: T) {
  if (typeof window === 'undefined') return fallback;

  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function readStoredString(key: string, fallback = '') {
  if (typeof window === 'undefined') return fallback;

  try {
    return window.localStorage.getItem(key)?.trim() || fallback;
  } catch {
    return fallback;
  }
}

function readFreshCatalogCache() {
  const cache = readStoredJson<AdvisorCatalogCache | null>(STORAGE_KEYS.catalogCache, null);
  if (!cache || !Array.isArray(cache.products) || !Array.isArray(cache.productComponents)) return null;
  if (!Number.isFinite(Number(cache.cachedAt))) return null;
  if (Date.now() - Number(cache.cachedAt) > ADVISOR_CATALOG_CACHE_TTL_MS) return null;

  return cache;
}

function writeCatalogCache(input: Omit<AdvisorCatalogCache, 'cachedAt'>) {
  if (typeof window === 'undefined') return;

  try {
    window.localStorage.setItem(
      STORAGE_KEYS.catalogCache,
      JSON.stringify({
        cachedAt: Date.now(),
        products: input.products,
        productComponents: input.productComponents,
        activeRate: input.activeRate,
      } satisfies AdvisorCatalogCache)
    );
  } catch {
    // Cache is optional; storage quota or private mode should not block order capture.
  }
}

function extractInitials(value: string) {
  return normalizeSearchValue(value)
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => token[0] || '')
    .join('');
}

function compactAddressLabel(value: string, maxLength = 46) {
  const text = String(value || '').trim().replace(/\s+/g, ' ');
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength).trimEnd()}...`;
}

function isDeliveryCatalogItemName(value: string | null | undefined) {
  const normalized = normalizeSearchValue(value);
  return normalized.includes('delivery');
}

function buildNormalizedIndexMap(value: string) {
  let normalized = '';
  const indexMap: number[] = [];

  Array.from(value).forEach((char, index) => {
    const partial = char
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();

    if (!partial) return;

    normalized += partial;
    for (let i = 0; i < partial.length; i += 1) {
      indexMap.push(index);
    }
  });

  return { normalized, indexMap };
}

function buildHighlightRanges(value: string, query: string) {
  const { normalized, indexMap } = buildNormalizedIndexMap(value);
  const tokens = splitSearchTokens(query);
  const ranges: Array<{ start: number; end: number }> = [];

  tokens.forEach((token) => {
    let searchFrom = 0;

    while (searchFrom < normalized.length) {
      const matchIndex = normalized.indexOf(token, searchFrom);
      if (matchIndex === -1) break;

      const start = indexMap[matchIndex];
      const end = indexMap[Math.min(indexMap.length - 1, matchIndex + token.length - 1)] + 1;

      if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
        ranges.push({ start, end });
      }

      searchFrom = matchIndex + token.length;
    }
  });

  return ranges.sort((a, b) => a.start - b.start).reduce<Array<{ start: number; end: number }>>((merged, range) => {
    const last = merged[merged.length - 1];
    if (!last || range.start > last.end) {
      merged.push(range);
      return merged;
    }

    last.end = Math.max(last.end, range.end);
    return merged;
  }, []);
}

function renderHighlightedText(value: string, query: string, keyPrefix: string) {
  const text = String(value || '');
  const ranges = buildHighlightRanges(text, query);

  if (ranges.length === 0) return text;

  const nodes: ReactNode[] = [];
  let cursor = 0;

  ranges.forEach((range, index) => {
    if (range.start > cursor) {
      nodes.push(<span key={`${keyPrefix}-plain-${index}`}>{text.slice(cursor, range.start)}</span>);
    }

    nodes.push(
      <span
        key={`${keyPrefix}-hit-${index}`}
        className="rounded-[6px] bg-[#2A2209] px-0.5 text-[#F7DA66]"
      >
        {text.slice(range.start, range.end)}
      </span>,
    );
    cursor = range.end;
  });

  if (cursor < text.length) {
    nodes.push(<span key={`${keyPrefix}-tail`}>{text.slice(cursor)}</span>);
  }

  return nodes;
}

function productSearchScore(params: {
  product: ProductRow;
  query: string;
  favoriteIds: number[];
  recentIds: number[];
  usageById: Record<string, number>;
}) {
  const normalizedQuery = normalizeSearchValue(params.query);
  if (!normalizedQuery) return Number.NEGATIVE_INFINITY;

  const normalizedName = normalizeSearchValue(params.product.name);
  const normalizedSku = normalizeSearchValue(params.product.sku);
  const nameTokens = normalizedName.split(/\s+/).filter(Boolean);
  const queryTokens = splitSearchTokens(params.query);
  const initials = extractInitials(params.product.name);

  let score = 0;

  if (normalizedName === normalizedQuery || normalizedSku === normalizedQuery) score += 220;
  else if (
    queryTokens.length > 1 &&
    queryTokens.every((token) => nameTokens.some((nameToken) => nameToken.startsWith(token)))
  ) {
    score += 190;
  } else if (normalizedName.startsWith(normalizedQuery)) score += 160;
  else if (nameTokens[0]?.startsWith(normalizedQuery)) score += 145;
  else if (nameTokens.some((token) => token.startsWith(normalizedQuery))) score += 120;
  else if (initials.startsWith(normalizedQuery)) score += 118;
  else if (normalizedSku.startsWith(normalizedQuery)) score += 105;
  else if (normalizedName.includes(normalizedQuery)) score += 90;
  else if (normalizedSku.includes(normalizedQuery)) score += 70;
  else return Number.NEGATIVE_INFINITY;

  if (queryTokens.length > 1) {
    score += queryTokens.reduce((sum, token) => {
      if (nameTokens.some((nameToken) => nameToken.startsWith(token))) return sum + 12;
      if (normalizedName.includes(token)) return sum + 6;
      return sum;
    }, 0);
  }

  const favoriteBoost = params.favoriteIds.includes(params.product.id) ? 30 : 0;
  const recentIndex = params.recentIds.indexOf(params.product.id);
  const recentBoost = recentIndex >= 0 ? Math.max(0, 24 - recentIndex * 3) : 0;
  const usageBoost = Math.min(60, Number(params.usageById[String(params.product.id)] || 0) * 6);

  return score + favoriteBoost + recentBoost + usageBoost;
}

function clientSearchScore(params: {
  client: ClientRow;
  query: string;
  recentIds: number[];
  usageById: Record<string, number>;
}) {
  const normalizedQuery = normalizeSearchValue(params.query);
  if (!normalizedQuery) return Number.NEGATIVE_INFINITY;

  const normalizedName = normalizeSearchValue(params.client.full_name);
  const normalizedPhone = normalizeSearchValue(params.client.phone);
  const phoneQueryTerms = getPhoneSearchTerms(params.query).map(normalizeSearchValue);
  const clientPhoneTerms = getPhoneSearchTerms(params.client.phone).map(normalizeSearchValue);
  const nameTokens = normalizedName.split(/\s+/).filter(Boolean);
  const queryTokens = splitSearchTokens(params.query);
  const phoneMatches =
    phoneQueryTerms.length > 0 &&
    phoneQueryTerms.some((queryTerm) =>
      clientPhoneTerms.some(
        (clientTerm) =>
          clientTerm === queryTerm ||
          clientTerm.startsWith(queryTerm) ||
          clientTerm.includes(queryTerm)
      )
    );

  let score = 0;

  if (normalizedPhone === normalizedQuery || normalizedName === normalizedQuery) score += 220;
  else if (phoneMatches) score += 190;
  else if (normalizedPhone.startsWith(normalizedQuery)) score += 170;
  else if (
    queryTokens.length > 1 &&
    queryTokens.every((token) => nameTokens.some((nameToken) => nameToken.startsWith(token)))
  ) {
    score += 165;
  }
  else if (normalizedName.startsWith(normalizedQuery)) score += 150;
  else if (nameTokens[0]?.startsWith(normalizedQuery)) score += 140;
  else if (nameTokens.some((token) => token.startsWith(normalizedQuery))) score += 115;
  else if (normalizedPhone.includes(normalizedQuery)) score += 95;
  else if (normalizedName.includes(normalizedQuery)) score += 85;
  else return Number.NEGATIVE_INFINITY;

  if (queryTokens.length > 1) {
    score += queryTokens.reduce((sum, token) => {
      if (nameTokens.some((nameToken) => nameToken.startsWith(token))) return sum + 10;
      if (normalizedName.includes(token)) return sum + 5;
      return sum;
    }, 0);
  }

  const recentIndex = params.recentIds.indexOf(params.client.id);
  const recentBoost = recentIndex >= 0 ? Math.max(0, 16 - recentIndex * 2) : 0;
  const usageBoost = Math.min(36, Number(params.usageById[String(params.client.id)] || 0) * 4);

  return score + recentBoost + usageBoost;
}

function normalizeSnapshotText(value: string | null | undefined) {
  return String(value || '').trim();
}

function buildDraftItemsSnapshot(items: DraftItem[]) {
  return items.map((item) => ({
    productId: Number(item.product_id || 0),
    productName: normalizeSnapshotText(item.product_name_snapshot),
    qty: Number(item.qty || 0),
    lineTotalUsd: Number(Number(item.line_total_usd || 0).toFixed(2)),
    detailLines: item.editable_detail_lines.map((line) => normalizeSnapshotText(line)).filter(Boolean),
  }));
}

function normalizeDraftItemsPayload(value: unknown): DraftItem[] {
  if (!Array.isArray(value)) return [];

  return value
    .map((item, index) => {
      if (!item || typeof item !== 'object') return null;
      const row = item as Partial<DraftItem>;
      const productId = Number(row.product_id || 0);
      const qty = Number(row.qty || 0);
      const sourceCurrency = row.source_price_currency === 'VES' ? 'VES' : 'USD';

      if (!Number.isFinite(productId) || productId <= 0 || !Number.isFinite(qty) || qty <= 0) {
        return null;
      }

      return {
        localId: String(row.localId || `draft-${productId}-${index}-${Date.now()}`),
        product_id: productId,
        product_type: row.product_type ?? null,
        sku_snapshot: row.sku_snapshot ?? null,
        product_name_snapshot: String(row.product_name_snapshot || 'Item'),
        units_per_service: Number(row.units_per_service || 0) || 0,
        qty,
        source_price_currency: sourceCurrency,
        source_price_amount: Number(row.source_price_amount || 0) || 0,
        unit_price_usd_snapshot: Number(row.unit_price_usd_snapshot || 0) || 0,
        line_total_usd: Number(row.line_total_usd || 0) || 0,
        editable_detail_lines: Array.isArray(row.editable_detail_lines)
          ? row.editable_detail_lines.map((line) => String(line || '').trim()).filter(Boolean)
          : [],
      } satisfies DraftItem;
    })
    .filter((item): item is DraftItem => !!item);
}

function normalizeDraftStatus(value: unknown): AdvisorOrderDraftStatus | null {
  if (value === 'draft' || value === 'quoted' || value === 'converted' || value === 'archived') return value;
  return null;
}

function getDraftStatusLabel(status: AdvisorOrderDraftStatus | null) {
  return status === 'quoted' ? 'Cotizado' : status === 'draft' ? 'Borrador' : '';
}

function exactClientMatch(client: ClientRow, query: string) {
  const normalizedQuery = normalizeSearchValue(query);
  const normalizedName = normalizeSearchValue(client.full_name);
  const normalizedPhone = normalizeSearchValue(client.phone);
  const phoneQueryTerms = getPhoneSearchTerms(query).map(normalizeSearchValue);
  const clientPhoneTerms = getPhoneSearchTerms(client.phone).map(normalizeSearchValue);
  const phoneMatches =
    phoneQueryTerms.length > 0 &&
    phoneQueryTerms.some((queryTerm) => clientPhoneTerms.includes(queryTerm));

  return normalizedQuery.length > 0 && (normalizedName === normalizedQuery || normalizedPhone === normalizedQuery || phoneMatches);
}

function buildOrderEditChangeSummary(before: OrderEditSnapshot, after: OrderEditSnapshot) {
  const sections = new Set<string>();
  const summary: string[] = [];

  if (JSON.stringify(before.items) !== JSON.stringify(after.items)) {
    sections.add('pedido');
    summary.push('Se modificó el pedido.');
  }

  if (before.clientId !== after.clientId) {
    sections.add('cliente');
    summary.push('Se cambió el cliente.');
  }

  if (
    before.fulfillment !== after.fulfillment ||
    before.deliveryDate !== after.deliveryDate ||
    before.deliveryTime12 !== after.deliveryTime12 ||
    before.isAsap !== after.isAsap ||
    before.receiverName !== after.receiverName ||
    before.receiverPhone !== after.receiverPhone
  ) {
    sections.add('entrega');
    summary.push('Se modificaron datos de entrega.');
  }

  if (before.deliveryAddress !== after.deliveryAddress || before.deliveryGpsUrl !== after.deliveryGpsUrl) {
    sections.add('direccion');
    summary.push('Se modificó la dirección.');
  }

  if (
    before.paymentMethod !== after.paymentMethod ||
    before.paymentCurrency !== after.paymentCurrency ||
    before.paymentRequiresChange !== after.paymentRequiresChange ||
    before.paymentChangeFor !== after.paymentChangeFor ||
    before.paymentChangeCurrency !== after.paymentChangeCurrency ||
    before.paymentNote !== after.paymentNote
  ) {
    sections.add('pago');
    summary.push('Se modificaron datos de pago.');
  }

  if (
    before.fxRate !== after.fxRate ||
    before.discountEnabled !== after.discountEnabled ||
    before.discountPct !== after.discountPct ||
    before.hasInvoice !== after.hasInvoice ||
    before.invoiceTaxPct !== after.invoiceTaxPct ||
    before.totalUsd !== after.totalUsd ||
    before.totalBs !== after.totalBs
  ) {
    sections.add('precio');
    summary.push('Se modificó el total de la orden.');
  }

  if (
    before.hasInvoice !== after.hasInvoice ||
    before.invoiceCompanyName !== after.invoiceCompanyName ||
    before.invoiceTaxId !== after.invoiceTaxId ||
    before.invoiceAddress !== after.invoiceAddress ||
    before.invoicePhone !== after.invoicePhone
  ) {
    sections.add('factura');
    summary.push('Se modificaron datos de factura.');
  }

  if (
    before.hasDeliveryNote !== after.hasDeliveryNote ||
    before.deliveryNoteName !== after.deliveryNoteName ||
    before.deliveryNoteDocumentId !== after.deliveryNoteDocumentId ||
    before.deliveryNoteAddress !== after.deliveryNoteAddress ||
    before.deliveryNotePhone !== after.deliveryNotePhone
  ) {
    sections.add('nota_entrega');
    summary.push('Se modificaron datos de nota de entrega.');
  }

  if (before.orderNote !== after.orderNote) {
    sections.add('nota');
    summary.push('Se modificó la nota de la orden.');
  }

  return {
    sections: Array.from(sections),
    summary: Array.from(new Set(summary)),
  };
}

async function resolveAdvisorOrderReviewNotifications(params: {
  supabase: ReturnType<typeof createSupabaseBrowser>;
  orderId: number;
  advisorUserId: string | null;
}) {
  if (!params.advisorUserId || !Number.isFinite(params.orderId) || params.orderId <= 0) return;

  const { data: actionEvents, error: eventsError } = await params.supabase
    .from('order_timeline_events')
    .select('id')
    .eq('order_id', params.orderId)
    .in('event_type', ['order_returned_to_review', 'order_changes_rejected']);

  if (eventsError || !actionEvents?.length) {
    if (eventsError) console.warn('No se pudieron cargar alertas pendientes del asesor.', eventsError.message);
    return;
  }

  const eventIds = actionEvents.map((event) => Number(event.id)).filter((id) => Number.isFinite(id) && id > 0);
  if (eventIds.length === 0) return;

  const { error: recipientsError } = await params.supabase
    .from('order_timeline_event_recipients')
    .update({
      requires_action: false,
      read_at: new Date().toISOString(),
    })
    .in('event_id', eventIds)
    .or(`target_user_id.eq.${params.advisorUserId},target_role.eq.advisor`);

  if (recipientsError) {
    console.warn('No se pudieron cerrar alertas pendientes del asesor.', recipientsError.message);
  }
}

function inputClass(multiline = false) {
  return [
    'min-w-0 w-full rounded-[16px] border border-[#232632] bg-[#0F131B] px-3.5 text-sm text-[#F5F7FB] placeholder:text-[#636C80]',
    multiline ? 'min-h-[92px] py-3' : 'h-11',
  ].join(' ');
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <div className="mb-1.5 text-[12px] font-medium text-[#AAB2C5]">{label}</div>
      {children}
      {hint ? <div className="mt-1 text-[11px] leading-5 text-[#6F7890]">{hint}</div> : null}
    </label>
  );
}

function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-[24px] border border-[#232632] bg-[#12151d] px-4 py-4">
      <h2 className="text-base font-semibold text-[#F5F7FB]">{title}</h2>
      {subtitle ? <p className="mt-1 text-xs leading-5 text-[#8B93A7]">{subtitle}</p> : null}
      <div className="mt-3 space-y-3">{children}</div>
    </section>
  );
}

function parseEditableDetailLines(lines: string[]) {
  let alias = '';
  const selections: Array<{ componentName: string; qty: number; componentProductId: number | null }> = [];
  const selectionByProductId = new Map<number, number>();

  for (const rawLine of lines) {
    const line = String(rawLine || '').trim();
    if (!line) continue;

    if (isHiddenDetailLine(line)) {
      const [, componentProductIdRaw, qtyRaw] = line.split('|');
      const componentProductId = Number(componentProductIdRaw || 0);
      const qty = Number(qtyRaw || 0);
      if (Number.isFinite(componentProductId) && componentProductId > 0 && Number.isFinite(qty) && qty > 0) {
        selectionByProductId.set(componentProductId, qty);
      }
      continue;
    }

    if (/^para\s*:/i.test(line)) {
      alias = line.replace(/^para\s*:/i, '').trim();
      continue;
    }

    const match = line.match(/^(\d+)\s+(.+)$/i);
    if (!match) continue;

    const qty = Number(match[1]);
    const componentName = match[2].trim();

    if (Number.isFinite(qty) && qty > 0 && componentName) {
      selections.push({ componentName, qty, componentProductId: null });
    }
  }

  return {
    alias,
    selections: [
      ...Array.from(selectionByProductId.entries()).map(([componentProductId, qty]) => ({
        componentName: '',
        componentProductId,
        qty,
      })),
      ...selections,
    ],
  };
}

function ConfigSheet(props: {
  open: boolean;
  title: string;
  alias: string;
  setAlias: (value: string) => void;
  totalSelected: number;
  totalLimit: number;
  options: ConfigOption[];
  selections: ConfigSelection[];
  onChangeQty: (product: ConfigOption, qty: number) => void;
  onClose: () => void;
  onConfirm: () => void;
  isEditing: boolean;
}) {
  if (!props.open) return null;

  const remaining = props.totalLimit > 0 ? props.totalLimit - props.totalSelected : 0;
  const canConfirm =
    props.options.length === 0 ||
    (props.totalLimit > 0 ? props.totalSelected === props.totalLimit : true);

  return (
    <div className="advisor-fade-in fixed inset-0 z-40 bg-[#040507]/84 backdrop-blur-sm">
      <div className="advisor-slide-up absolute inset-x-0 bottom-0 max-h-[92dvh] rounded-t-[28px] border border-[#232632] bg-[#0C1017] shadow-[0_-24px_48px_rgba(0,0,0,0.5)]">
        <div className="mx-auto flex max-h-[92dvh] max-w-screen-md flex-col">
          <div className="shrink-0 px-4 pt-4">
            <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-[#8B93A7]">
                Configurar producto
              </div>
              <h3 className="mt-1 text-lg font-semibold text-[#F5F7FB]">{props.title}</h3>
              <div className="mt-1 text-xs text-[#8B93A7]">
                {props.totalLimit > 0
                  ? `Seleccionado ${props.totalSelected} de ${props.totalLimit} piezas`
                  : `${props.selections.length} opciones marcadas`}
              </div>
            </div>
            <button
              type="button"
              onClick={props.onClose}
              className="inline-flex h-10 items-center rounded-[14px] border border-[#232632] px-3 text-sm text-[#F5F7FB]"
            >
              Cerrar
            </button>
            </div>
          </div>

          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
            {props.totalLimit > 0 ? (
              <div className="rounded-[18px] border border-[#232632] bg-[#0F131B] px-3.5 py-3">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-[#AAB2C5]">Piezas por completar</span>
                  <span className={remaining === 0 ? 'font-semibold text-emerald-400' : 'font-semibold text-[#F7DA66]'}>
                    {remaining > 0 ? `${remaining} pendientes` : 'Completo'}
                  </span>
                </div>
              </div>
            ) : null}

            <Field label="Para">
              <input
                value={props.alias}
                onChange={(e) => props.setAlias(e.target.value)}
                className={inputClass()}
                placeholder="Nombre o referencia"
              />
            </Field>

            <div className="space-y-2">
              {props.options.length === 0 ? (
                <div className="rounded-[18px] border border-dashed border-[#2A3040] bg-[#0F131B] px-4 py-4 text-sm text-[#AAB2C5]">
                  Este producto no tiene opciones configuradas.
                </div>
              ) : (
                props.options.map((option) => {
                  const currentQty =
                    props.selections.find((item) => item.componentProductId === option.id)?.qty || 0;
                  const isOptionalFixed = option.componentMode === 'fixed' && !option.isRequired;

                  return (
                    <div
                      key={option.id}
                      className="grid grid-cols-[1fr_136px] items-center gap-3 rounded-[18px] border border-[#232632] bg-[#0F131B] px-3.5 py-3"
                    >
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium text-[#F5F7FB]">{option.name}</div>
                        <div className="mt-1 text-xs text-[#8B93A7]">
                          {isOptionalFixed ? 'Opcional' : option.sku || 'Sin codigo'}
                        </div>
                      </div>
                      {isOptionalFixed ? (
                        <button
                          type="button"
                          onClick={() => props.onChangeQty(option, currentQty > 0 ? 0 : option.componentQuantity || 1)}
                          className={[
                            'h-11 rounded-[14px] border px-3 text-sm font-semibold',
                            currentQty > 0
                              ? 'border-[#F0D000] bg-[#201B08] text-[#F7DA66]'
                              : 'border-[#232632] bg-[#12151d] text-[#F5F7FB]',
                          ].join(' ')}
                        >
                          {currentQty > 0 ? 'Incluida' : 'Incluir'}
                        </button>
                      ) : (
                        <div className="grid grid-cols-[38px_minmax(44px,1fr)_38px] gap-2">
                          <button
                            type="button"
                            onClick={() => props.onChangeQty(option, Math.max(0, currentQty - 1))}
                            className="h-11 rounded-[14px] border border-[#232632] bg-[#12151d] text-base font-semibold text-[#F5F7FB]"
                          >
                            -
                          </button>
                          <input
                            value={String(currentQty)}
                            onChange={(e) => props.onChangeQty(option, Number(e.target.value || 0))}
                            onFocus={(e) => e.currentTarget.select()}
                            className="h-11 min-w-0 w-full rounded-[14px] border border-[#232632] bg-[#12151d] px-0 text-center text-base font-semibold text-[#F5F7FB] placeholder:text-[#636C80]"
                            inputMode="numeric"
                          />
                          <button
                            type="button"
                            onClick={() => props.onChangeQty(option, currentQty + 1)}
                            className="h-11 rounded-[14px] border border-[#232632] bg-[#12151d] text-base font-semibold text-[#F5F7FB]"
                          >
                            +
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </div>

          <div className="shrink-0 border-t border-[#1A1D26] bg-[#0C1017] px-4 pb-[calc(0.75rem+env(safe-area-inset-bottom))] pt-3">
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={props.onClose}
                className="h-11 rounded-[16px] border border-[#232632] text-sm font-semibold text-[#F5F7FB]"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={props.onConfirm}
                disabled={!canConfirm}
                className={[
                  'h-11 rounded-[16px] text-sm font-semibold disabled:cursor-not-allowed',
                  canConfirm ? 'bg-[#F0D000] text-[#17191E]' : 'bg-[#232632] text-[#6F7890]',
                ].join(' ')}
              >
                {props.isEditing ? 'Guardar' : 'Confirmar'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function AdvisorOrderComposer({
  existingOrderId = null,
  templateOrderId = null,
  initialDraft = null,
}: {
  existingOrderId?: number | null;
  templateOrderId?: number | null;
  initialDraft?: AdvisorOrderDraftInitial | null;
}) {
  const router = useRouter();
  const supabase = useMemo(() => createSupabaseBrowser(), []);
  const rounded = useMemo(() => to12h(getRoundedTime()), []);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savingDraft, setSavingDraft] = useState(false);
  const [searchingClient, setSearchingClient] = useState(false);
  const [creatingClient, setCreatingClient] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const [authUserId, setAuthUserId] = useState('');
  const [authUserLabel, setAuthUserLabel] = useState('Asesor');
  const [products, setProducts] = useState<ProductRow[]>([]);
  const [productComponents, setProductComponents] = useState<ProductComponentRow[]>([]);
  const [productSearch, setProductSearch] = useState('');
  const deferredProductSearch = useDeferredValue(productSearch);
  const productSearchIsPending = productSearch.trim() !== deferredProductSearch.trim();
  const [productActiveIndex, setProductActiveIndex] = useState<number>(-1);
  const [selectedProductId, setSelectedProductId] = useState<number | ''>('');
  const [recentProductIds, setRecentProductIds] = useState<number[]>([]);
  const [favoriteProductIds, setFavoriteProductIds] = useState<number[]>([]);
  const [productUsageById, setProductUsageById] = useState<Record<string, number>>({});
  const [qty, setQty] = useState('1');
  const [draftItems, setDraftItems] = useState<DraftItem[]>([]);

  const [searchTerm, setSearchTerm] = useState('');
  const [clientResults, setClientResults] = useState<ClientRow[]>([]);
  const [selectedClient, setSelectedClient] = useState<ClientRow | null>(null);
  const [recentClients, setRecentClients] = useState<RecentClientChip[]>([]);
  const [clientUsageById, setClientUsageById] = useState<Record<string, number>>({});
  const [isNewClientMode, setIsNewClientMode] = useState(false);
  const [newClientName, setNewClientName] = useState('');
  const [newClientPhone, setNewClientPhone] = useState('');
  const [newClientType, setNewClientType] = useState<ClientType>('assigned');

  const [fulfillment, setFulfillment] = useState<FulfillmentType>('pickup');
  const [deliveryDate, setDeliveryDate] = useState('');
  const [deliveryHour12, setDeliveryHour12] = useState('');
  const [deliveryMinute, setDeliveryMinute] = useState('');
  const [deliveryAmPm, setDeliveryAmPm] = useState<'AM' | 'PM'>(rounded.ampm);
  const [isAsap, setIsAsap] = useState(false);
  const [receiverName, setReceiverName] = useState('');
  const [receiverPhone, setReceiverPhone] = useState('');
  const [deliveryAddress, setDeliveryAddress] = useState('');
  const [deliveryGpsUrl, setDeliveryGpsUrl] = useState('');
  const [deliveryAddressTouched, setDeliveryAddressTouched] = useState(false);
  const [recentAddresses, setRecentAddresses] = useState<ClientAddress[]>([]);
  const [orderNote, setOrderNote] = useState('');
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('pending');
  const [paymentCurrency, setPaymentCurrency] = useState<CurrencyCode>('USD');
  const [paymentRequiresChange, setPaymentRequiresChange] = useState(false);
  const [paymentChangeFor, setPaymentChangeFor] = useState('');
  const [paymentChangeCurrency, setPaymentChangeCurrency] = useState<CurrencyCode>('USD');
  const [paymentNote, setPaymentNote] = useState('');
  const [fxRate, setFxRate] = useState('');
  const [discountEnabled, setDiscountEnabled] = useState(false);
  const [discountPct, setDiscountPct] = useState('0');
  const [invoiceTaxPct, setInvoiceTaxPct] = useState('16');
  const [hasDeliveryNote, setHasDeliveryNote] = useState(false);
  const [hasInvoice, setHasInvoice] = useState(false);
  const [invoiceCompanyName, setInvoiceCompanyName] = useState('');
  const [invoiceTaxId, setInvoiceTaxId] = useState('');
  const [invoiceAddress, setInvoiceAddress] = useState('');
  const [invoicePhone, setInvoicePhone] = useState('');
  const [deliveryNoteName, setDeliveryNoteName] = useState('');
  const [deliveryNoteDocumentId, setDeliveryNoteDocumentId] = useState('');
  const [deliveryNoteAddress, setDeliveryNoteAddress] = useState('');
  const [deliveryNotePhone, setDeliveryNotePhone] = useState('');
  const [invoicePanelOpen, setInvoicePanelOpen] = useState(false);
  const [deliveryNotePanelOpen, setDeliveryNotePanelOpen] = useState(false);
  const [copyingQuote, setCopyingQuote] = useState(false);
  const searchingClientRef = useRef(false);
  const creatingClientRef = useRef(false);
  const copyingQuoteRef = useRef(false);
  const savingOrderRef = useRef(false);
  const savingDraftRef = useRef(false);
  const [itemJustAdded, setItemJustAdded] = useState(false);
  const [originalEditSnapshot, setOriginalEditSnapshot] = useState<OrderEditSnapshot | null>(null);
  const [existingOrderNumber, setExistingOrderNumber] = useState('');
  const [existingOrderStatus, setExistingOrderStatus] = useState('');
  const [existingOrderLastModifiedAt, setExistingOrderLastModifiedAt] = useState<string | null>(null);
  const [advisorRecalculationMode, setAdvisorRecalculationMode] = useState(false);
  const [activeDraftId, setActiveDraftId] = useState<number | null>(
    initialDraft?.id ? Number(initialDraft.id) : null
  );
  const [activeDraftStatus, setActiveDraftStatus] = useState<AdvisorOrderDraftStatus | null>(
    normalizeDraftStatus(initialDraft?.status)
  );

  const [configOpen, setConfigOpen] = useState(false);
  const [configEditingLocalId, setConfigEditingLocalId] = useState<string | null>(null);
  const [configProductId, setConfigProductId] = useState<number | null>(null);
  const [configQty, setConfigQty] = useState(1);
  const [configAlias, setConfigAlias] = useState('');
  const [configSelections, setConfigSelections] = useState<ConfigSelection[]>([]);
  const isEditingOrder = Number.isFinite(existingOrderId) && Number(existingOrderId) > 0;
  const fxRateLockedForAdvisorEdit = isEditingOrder && !advisorRecalculationMode;
  const sourceOrderId =
    Number.isFinite(existingOrderId) && Number(existingOrderId) > 0
      ? Number(existingOrderId)
      : Number.isFinite(templateOrderId) && Number(templateOrderId) > 0
        ? Number(templateOrderId)
        : null;
  const isRepeatingOrder = !isEditingOrder && sourceOrderId != null;

  const selectedProduct = useMemo(() => {
    if (selectedProductId === '') return null;
    return products.find((product) => product.id === selectedProductId) ?? null;
  }, [products, selectedProductId]);

  const productById = useMemo(() => new Map(products.map((product) => [product.id, product])), [products]);
  const selectedClientFundUsd = Number(selectedClient?.fund_balance_usd ?? 0) || 0;
  const selectedClientAddresses = useMemo(
    () => normalizeClientAddresses(selectedClient?.recent_addresses),
    [selectedClient]
  );
  const quickAddresses = useMemo(() => {
    if (!selectedClient) return [];

    const seen = new Set<string>();
    return selectedClientAddresses.filter((address) => {
      const key = `${address.addressText.trim()}|${address.gpsUrl.trim()}`;
      if (!address.addressText.trim() && !address.gpsUrl.trim()) return false;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [selectedClient, selectedClientAddresses]);
  const fxRateNumber = Math.max(0, Number(String(fxRate || '0').replace(',', '.')) || 0);
  const draftItemSnapshots = useMemo(
    () =>
      draftItems.map((item) =>
        calculateOrderLineSnapshot({
          sourceCurrency: item.source_price_currency,
          sourceAmount: Number(item.source_price_amount || 0),
          quantity: Number(item.qty || 0),
          fxRate: fxRateNumber,
          fallbackUnitUsd: Number(item.unit_price_usd_snapshot || 0),
        })
      ),
    [draftItems, fxRateNumber]
  );
  const catalogPriceDriftItems = useMemo(() => {
    if (!isEditingOrder || fxRateNumber <= 0) return [];
    if (existingOrderStatus === 'delivered' || existingOrderStatus === 'cancelled') return [];

    return draftItems.filter((item) => {
      const product = productById.get(item.product_id);
      if (!product) return false;
      return draftItemHasCatalogPriceDrift(item, product, fxRateNumber);
    });
  }, [draftItems, existingOrderStatus, fxRateNumber, isEditingOrder, productById]);
  const advisorEditHasCatalogPriceDrift = catalogPriceDriftItems.length > 0;
  const draftTotalUsd = useMemo(
    () => draftItemSnapshots.reduce((sum, snapshot) => sum + snapshot.lineUsd, 0),
    [draftItemSnapshots]
  );
  const discountPctNumber = Math.max(0, Math.min(100, Number(discountPct || 0) || 0));
  const invoiceTaxPctNumber = hasInvoice
    ? Math.max(0, Number(String(invoiceTaxPct || '0').replace(',', '.')) || 0)
    : 0;
  const draftSubtotalBs = useMemo(
    () => draftItemSnapshots.reduce((sum, snapshot) => sum + snapshot.lineBs, 0),
    [draftItemSnapshots]
  );
  const totalsSnapshot = calculateOrderTotalsSnapshot({
    subtotalUsd: draftTotalUsd,
    subtotalBs: draftSubtotalBs,
    discountPct: discountEnabled ? discountPctNumber : 0,
    invoiceTaxPct: invoiceTaxPctNumber,
  });
  const discountAmountUsd = totalsSnapshot.discountAmountUsd;
  const discountAmountBs = totalsSnapshot.discountAmountBs;
  const subtotalAfterDiscountUsd = totalsSnapshot.subtotalAfterDiscountUsd;
  const subtotalAfterDiscountBs = totalsSnapshot.subtotalAfterDiscountBs;
  const invoiceTaxAmountUsd = totalsSnapshot.invoiceTaxAmountUsd;
  const invoiceTaxAmountBs = totalsSnapshot.invoiceTaxAmountBs;
  const finalTotalUsd = totalsSnapshot.totalUsd;
  const finalTotalBs = totalsSnapshot.totalBs;

  const configProduct = useMemo(
    () => (configProductId ? productById.get(configProductId) ?? null : null),
    [configProductId, productById]
  );

  const configOptions = useMemo(() => {
    if (!configProductId) return [];
    return productComponents
      .filter(
        (row) =>
          row.parent_product_id === configProductId &&
          (row.component_mode === 'selectable' || (row.component_mode === 'fixed' && !row.is_required))
      )
      .sort((a, b) => Number(a.sort_order || 0) - Number(b.sort_order || 0))
      .map((row) => {
        const product = productById.get(row.component_product_id);
        if (!product) return null;
        return {
          ...product,
          componentMode: row.component_mode,
          componentQuantity: Number(row.quantity || 0),
          isRequired: Boolean(row.is_required),
          countsTowardDetailLimit: row.counts_toward_detail_limit !== false,
          sortOrder: Number(row.sort_order || 0),
        } satisfies ConfigOption;
      })
      .filter((row): row is ConfigOption => !!row);
  }, [configProductId, productById, productComponents]);

  const configBaseLimit = Number(configProduct?.detail_units_limit || 0);
  const configTotalLimit = configBaseLimit > 0 ? configBaseLimit * Math.max(1, configQty) : 0;
  const configSelectedUnits = useMemo(() => {
    if (!configProductId) return configSelections.reduce((sum, item) => sum + Number(item.qty || 0), 0);
    const componentById = new Map(
      productComponents
        .filter((row) => row.parent_product_id === configProductId)
        .map((row) => [row.component_product_id, row] as const)
    );

    return configSelections.reduce((sum, item) => {
      const component = componentById.get(item.componentProductId);
      if (component && component.counts_toward_detail_limit === false) return sum;
      return sum + Number(item.qty || 0);
    }, 0);
  }, [configProductId, configSelections, productComponents]);
  const hasDeliveryItem = useMemo(
    () => draftItems.some((item) => isDeliveryCatalogItemName(item.product_name_snapshot)),
    [draftItems]
  );
  const scheduleReady =
    isAsap ||
    (deliveryDate.trim().length > 0 &&
      deliveryHour12.trim().length > 0 &&
      deliveryMinute.trim().length > 0);
  const advisorScheduleIsPast = useMemo(() => {
    if (isEditingOrder || isAsap || !scheduleReady) return false;

    try {
      return isPastAdvisorSchedule(
        deliveryDate.trim(),
        from12hTo24h(deliveryHour12.trim(), deliveryMinute.trim(), deliveryAmPm),
      );
    } catch {
      return false;
    }
  }, [deliveryAmPm, deliveryDate, deliveryHour12, deliveryMinute, isAsap, isEditingOrder, scheduleReady]);

  const baseCreateReady =
    draftItems.length > 0 &&
    (!!selectedClient || (isNewClientMode && newClientName.trim() && newClientPhone.trim())) &&
    (fulfillment === 'pickup' || deliveryAddress.trim().length > 0) &&
    (fulfillment !== 'delivery' || hasDeliveryItem) &&
    fxRateNumber > 0;
  const createReady = baseCreateReady && scheduleReady && !advisorScheduleIsPast;
  const createReadyHint = !draftItems.length
    ? 'Agrega al menos un item.'
    : !selectedClient && !(isNewClientMode && newClientName.trim() && newClientPhone.trim())
      ? 'Selecciona o crea el cliente.'
      : !scheduleReady
        ? 'Falta colocar fecha y hora.'
        : advisorScheduleIsPast
          ? 'La fecha y hora no pueden ser anteriores al momento actual.'
        : fulfillment === 'delivery' && !deliveryAddress.trim().length
          ? 'Falta la direccion de entrega.'
          : fulfillment === 'delivery' && !hasDeliveryItem
            ? 'Agrega el item de delivery para cerrar la orden.'
            : !fxRateNumber
              ? 'Falta la tasa del dia.'
              : isEditingOrder
                ? 'Todo listo para guardar los cambios.'
                : 'Todo listo para copiar y crear.';
  const footerSummary = [
    `${draftItems.length} item${draftItems.length === 1 ? '' : 's'}`,
    fulfillment === 'delivery' ? 'Delivery' : 'Retiro',
    getPaymentMethodLabel(paymentMethod),
  ].join(' · ');
  const filteredProducts = useMemo(() => {
    const query = deferredProductSearch.trim().toLowerCase();
    if (!query) return [];
    return products
      .map((product) => ({
        product,
        score: productSearchScore({
          product,
          query,
          favoriteIds: favoriteProductIds,
          recentIds: recentProductIds,
          usageById: productUsageById,
        }),
      }))
      .filter((row) => Number.isFinite(row.score))
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return a.product.name.localeCompare(b.product.name, 'es', { sensitivity: 'base' });
      })
      .slice(0, 40)
      .map((row) => row.product);
  }, [deferredProductSearch, favoriteProductIds, productUsageById, products, recentProductIds]);

  useEffect(() => {
    if (!deferredProductSearch.trim()) {
      setProductActiveIndex(-1);
      return;
    }

    if (filteredProducts.length === 0) {
      setProductActiveIndex(-1);
      return;
    }

    setProductActiveIndex(0);
    setSelectedProductId(filteredProducts[0]?.id ?? '');
  }, [deferredProductSearch, filteredProducts]);

  useEffect(() => {
    setRecentClients(readStoredJson<RecentClientChip[]>(STORAGE_KEYS.recentClients, []));
    setRecentProductIds(readStoredJson<number[]>(STORAGE_KEYS.recentProducts, []));
    setFavoriteProductIds(readStoredJson<number[]>(STORAGE_KEYS.favoriteProducts, []));
    setRecentAddresses(readStoredJson<ClientAddress[]>(STORAGE_KEYS.recentAddresses, []));
    setClientUsageById(readStoredJson<Record<string, number>>(STORAGE_KEYS.clientUsage, {}));
    setProductUsageById(readStoredJson<Record<string, number>>(STORAGE_KEYS.productUsage, {}));
    const storedDisplayName = readStoredString(STORAGE_KEYS.displayName, '');
    if (storedDisplayName) {
      setAuthUserLabel(storedDisplayName);
    }
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(STORAGE_KEYS.recentClients, JSON.stringify(recentClients.slice(0, 6)));
  }, [recentClients]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(STORAGE_KEYS.recentProducts, JSON.stringify(recentProductIds.slice(0, 8)));
  }, [recentProductIds]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(STORAGE_KEYS.favoriteProducts, JSON.stringify(favoriteProductIds.slice(0, 8)));
  }, [favoriteProductIds]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(STORAGE_KEYS.recentAddresses, JSON.stringify(recentAddresses.slice(0, 6)));
  }, [recentAddresses]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(STORAGE_KEYS.clientUsage, JSON.stringify(clientUsageById));
  }, [clientUsageById]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(STORAGE_KEYS.productUsage, JSON.stringify(productUsageById));
  }, [productUsageById]);

  useEffect(() => {
    async function boot() {
      setLoading(true);
      setError(null);

      const { data: authData, error: authError } = await supabase.auth.getUser();
      if (authError) {
        setError(authError.message);
        setLoading(false);
        return;
      }

      const user = authData.user;
      if (!user) {
        router.push('/login');
        return;
      }

      setAuthUserId(user.id);
      setAuthUserLabel(
        readStoredString(STORAGE_KEYS.displayName, '') ||
          String(
            user.user_metadata?.full_name ||
            user.user_metadata?.name ||
            'Asesor'
        ).trim() || 'Asesor'
      );

      const cachedCatalog = readFreshCatalogCache();
      if (cachedCatalog) {
        setProducts(cachedCatalog.products);
        setProductComponents(cachedCatalog.productComponents);
        if (!isEditingOrder && cachedCatalog.activeRate > 0) {
          setFxRate(String(Number(cachedCatalog.activeRate.toFixed(2))));
        }
        if (!sourceOrderId && !initialDraft) {
          setLoading(false);
        }
      }

      const baseRequests = [
        supabase
          .from('products')
          .select(
            'id, sku, name, type, base_price_usd, source_price_currency, source_price_amount, units_per_service, is_detail_editable, detail_units_limit'
          )
          .eq('is_active', true)
          .order('name', { ascending: true }),
        supabase
          .from('product_components')
          .select(
            'parent_product_id, component_product_id, component_mode, quantity, counts_toward_detail_limit, is_required, sort_order'
          )
          .order('parent_product_id', { ascending: true })
          .order('sort_order', { ascending: true }),
        supabase
          .from('exchange_rates')
          .select('rate_bs_per_usd')
          .eq('is_active', true)
          .order('effective_at', { ascending: false })
          .limit(1)
          .maybeSingle(),
      ] as const;

      const editRequests = sourceOrderId
        ? ([
            supabase
              .from('orders')
              .select(
                'id, order_number, total_usd, status, last_modified_at, last_modified_by, fulfillment, delivery_address, receiver_name, receiver_phone, notes, extra_fields, client:clients!orders_client_id_fkey(id, full_name, phone, client_type, fund_balance_usd, recent_addresses, billing_company_name, billing_tax_id, billing_address, billing_phone, delivery_note_name, delivery_note_document_id, delivery_note_address, delivery_note_phone)'
              )
              .eq('id', Number(sourceOrderId))
              .eq('attributed_advisor_id', user.id)
              .maybeSingle(),
            supabase
              .from('order_items')
              .select(
                'id, product_id, qty, pricing_origin_currency, pricing_origin_amount, unit_price_usd_snapshot, line_total_usd, sku_snapshot, product_name_snapshot, notes, product:products(type, units_per_service)'
              )
              .eq('order_id', Number(sourceOrderId))
              .order('id', { ascending: true }),
          ] as const)
        : null;

      const results = editRequests
        ? await Promise.all([...baseRequests, ...editRequests])
        : await Promise.all(baseRequests);

      const [productResult, componentResult, exchangeRateResult, existingOrderResult, existingItemsResult] = results as [
        Awaited<(typeof baseRequests)[0]>,
        Awaited<(typeof baseRequests)[1]>,
        Awaited<(typeof baseRequests)[2]>,
        | Awaited<NonNullable<typeof editRequests>[0]>
        | undefined,
        | Awaited<NonNullable<typeof editRequests>[1]>
        | undefined,
      ];

      const { data: productData, error: productError } = productResult;
      const { data: componentData, error: componentError } = componentResult;
      const activeRate = toSafeNumber(exchangeRateResult.data?.rate_bs_per_usd, 0);
      const nextProducts = (productData ?? []) as ProductRow[];
      const nextProductComponents = (componentData ?? []) as ProductComponentRow[];

      if (productError) {
        if (!cachedCatalog) setError(productError.message);
      } else {
        setProducts(nextProducts);
      }

      if (componentError) {
        if (!cachedCatalog) setError(componentError.message);
      } else {
        setProductComponents(nextProductComponents);
      }

      if (!productError && !componentError) {
        writeCatalogCache({
          products: nextProducts,
          productComponents: nextProductComponents,
          activeRate,
        });
      }

      if (!isEditingOrder && activeRate > 0) {
        setFxRate(String(Number(activeRate.toFixed(2))));
      }

      if (!isEditingOrder) {
        setOriginalEditSnapshot(null);
        setExistingOrderNumber('');
        setExistingOrderStatus('');
        setExistingOrderLastModifiedAt(null);
        setAdvisorRecalculationMode(false);
      }

      if (sourceOrderId) {
        if (existingOrderResult?.error) {
          setError(existingOrderResult.error.message);
        } else if (!existingOrderResult?.data) {
          setError(isEditingOrder ? 'No se pudo cargar la orden para corregir.' : 'No se pudo cargar la orden base.');
        } else {
          const order = existingOrderResult.data as ExistingOrderRow;
          setExistingOrderLastModifiedAt(order.last_modified_at ?? null);
          if (isEditingOrder && !['created', 'queued'].includes(String(order.status || ''))) {
            router.replace(`/app/advisor/orders/${order.id}`);
            return;
          }

          const orderClient = Array.isArray(order.client) ? order.client[0] ?? null : order.client;
          const existingOrderItems = (existingItemsResult?.data ?? []) as ExistingOrderItemRow[];
          const activeProductById = new Map(nextProducts.map((product) => [product.id, product]));
          const skippedRepeatItems: ExistingOrderItemRow[] = [];
          const pricing = order.extra_fields?.pricing;
          const recalculationRequested =
            isEditingOrder &&
            String(order.status || '') === 'created' &&
            Boolean(pricing?.recalculation_required);
          const recalculationRate = activeRate > 0
            ? activeRate
            : toSafeNumber(pricing?.recalculation_fx_rate, 0);
          const editFxRate = isRepeatingOrder
            ? activeRate
            : recalculationRequested
              ? recalculationRate
              : toSafeNumber(pricing?.fx_rate, activeRate);
          const orderItems = existingOrderItems.map((item) => {
            const relatedProduct = Array.isArray(item.product) ? item.product[0] ?? null : item.product;

            if (isRepeatingOrder || recalculationRequested) {
              const currentProduct = activeProductById.get(Number(item.product_id));
              if (!currentProduct) {
                skippedRepeatItems.push(item);
                return null;
              }

              return buildRepeatedDraftItemFromCatalog({
                item,
                product: currentProduct,
                activeRate: editFxRate,
              });
            }

            return {
              localId: `existing-${item.id}`,
              product_id: Number(item.product_id),
              product_type: relatedProduct?.type ?? null,
              sku_snapshot: item.sku_snapshot,
              product_name_snapshot: String(item.product_name_snapshot || 'Item'),
              units_per_service: Number(relatedProduct?.units_per_service ?? 0) || 0,
              qty: Number(item.qty || 0),
              source_price_currency: (item.pricing_origin_currency || 'USD') as CurrencyCode,
              source_price_amount:
                Number(item.pricing_origin_amount ?? item.unit_price_usd_snapshot ?? 0) || 0,
              unit_price_usd_snapshot: Number(item.unit_price_usd_snapshot ?? 0) || 0,
              line_total_usd: Number(item.line_total_usd ?? 0) || 0,
              editable_detail_lines: item.notes?.trim()
                ? item.notes
                    .split('\n')
                    .map((line) => line.trim())
                    .filter(Boolean)
                : [],
            };
          }).filter((item): item is DraftItem => !!item);
          const schedule = order.extra_fields?.schedule;
          const paymentData = order.extra_fields?.payment;
          const documents = order.extra_fields?.documents;
          const orderMoney = getOrderMoneySnapshot(order);
          const blankTime = { hour12: '', minute: '', ampm: rounded.ampm } as const;
          const parsedTime = parseStoredTime12(schedule?.time_12, schedule?.asap ? rounded : blankTime);

          setSelectedClient(orderClient ? (orderClient as ClientRow) : null);
          if (orderClient) rememberClient(orderClient as ClientRow);
          setSearchTerm(orderClient?.phone || orderClient?.full_name || '');
          setClientResults([]);
          setIsNewClientMode(false);
          setDraftItems(orderItems);
          setFulfillment(order.fulfillment || 'pickup');
          setDeliveryDate(isEditingOrder ? schedule?.date || (schedule?.asap ? getTodayInputValue() : '') : '');
          setDeliveryHour12(isEditingOrder ? parsedTime.hour12 : '');
          setDeliveryMinute(isEditingOrder ? parsedTime.minute : '');
          setDeliveryAmPm(isEditingOrder ? parsedTime.ampm : rounded.ampm);
          setIsAsap(isEditingOrder ? Boolean(schedule?.asap) : false);
          setReceiverName(order.receiver_name || '');
          setReceiverPhone(order.receiver_phone || '');
          setDeliveryAddress(order.delivery_address || '');
          setDeliveryGpsUrl(order.extra_fields?.delivery?.gps_url || '');
          setDeliveryAddressTouched(Boolean(order.delivery_address || order.extra_fields?.delivery?.gps_url));
          rememberAddress(order.delivery_address || '', order.extra_fields?.delivery?.gps_url || '');
          setOrderNote(order.notes || order.extra_fields?.note || '');
          setPaymentMethod(isRepeatingOrder ? 'pending' : (paymentData?.method as PaymentMethod) || 'pending');
          setPaymentCurrency(isRepeatingOrder ? 'USD' : (paymentData?.currency as CurrencyCode) || 'USD');
          setPaymentRequiresChange(isRepeatingOrder ? false : Boolean(paymentData?.requires_change));
          setPaymentChangeFor(
            isRepeatingOrder || paymentData?.change_for == null ? '' : String(paymentData.change_for)
          );
          setPaymentChangeCurrency(isRepeatingOrder ? 'USD' : (paymentData?.change_currency as CurrencyCode) || 'USD');
          setPaymentNote(isRepeatingOrder ? '' : paymentData?.notes || '');
          setFxRate(editFxRate > 0 ? String(Number(editFxRate.toFixed(2))) : '');
          setAdvisorRecalculationMode(recalculationRequested);
          setDiscountEnabled(isRepeatingOrder ? false : Boolean(pricing?.discount_enabled));
          setDiscountPct(
            isRepeatingOrder || pricing?.discount_pct == null ? '0' : String(pricing.discount_pct)
          );
          setInvoiceTaxPct(
            isRepeatingOrder || pricing?.invoice_tax_pct == null ? '16' : String(pricing.invoice_tax_pct)
          );
          setHasDeliveryNote(isRepeatingOrder ? false : Boolean(documents?.has_delivery_note));
          setHasInvoice(isRepeatingOrder ? false : Boolean(documents?.has_invoice));
          setDeliveryNotePanelOpen(isRepeatingOrder ? false : Boolean(documents?.has_delivery_note));
          setInvoicePanelOpen(isRepeatingOrder ? false : Boolean(documents?.has_invoice));
          setInvoiceCompanyName(
            documents?.invoice_snapshot?.company_name ||
              orderClient?.billing_company_name ||
              ''
          );
          setInvoiceTaxId(
            documents?.invoice_snapshot?.tax_id || orderClient?.billing_tax_id || ''
          );
          setInvoiceAddress(
            documents?.invoice_snapshot?.address || orderClient?.billing_address || ''
          );
          setInvoicePhone(
            documents?.invoice_snapshot?.phone || orderClient?.billing_phone || ''
          );
          setDeliveryNoteName(
            documents?.delivery_note_snapshot?.name || orderClient?.delivery_note_name || ''
          );
          setDeliveryNoteDocumentId(
            documents?.delivery_note_snapshot?.document_id ||
              orderClient?.delivery_note_document_id ||
              ''
          );
          setDeliveryNoteAddress(
            documents?.delivery_note_snapshot?.address ||
              orderClient?.delivery_note_address ||
              ''
          );
          setDeliveryNotePhone(
            documents?.delivery_note_snapshot?.phone || orderClient?.delivery_note_phone || ''
          );
          setExistingOrderNumber(String(order.order_number || ''));
          setExistingOrderStatus(String(order.status || ''));

          if (isEditingOrder) {
            setOriginalEditSnapshot({
              clientId: orderClient?.id ? Number(orderClient.id) : null,
              fulfillment: (order.fulfillment || 'pickup') as FulfillmentType,
              deliveryDate: normalizeSnapshotText(schedule?.date || (schedule?.asap ? getTodayInputValue() : '')),
              deliveryTime12: normalizeSnapshotText(`${parsedTime.hour12}:${parsedTime.minute} ${parsedTime.ampm}`),
              isAsap: Boolean(schedule?.asap),
              receiverName: normalizeSnapshotText(order.receiver_name),
              receiverPhone: normalizeSnapshotText(order.receiver_phone),
              deliveryAddress: normalizeSnapshotText(order.delivery_address),
              deliveryGpsUrl: normalizeSnapshotText(order.extra_fields?.delivery?.gps_url),
              orderNote: normalizeSnapshotText(order.notes || order.extra_fields?.note),
              paymentMethod: ((paymentData?.method as PaymentMethod) || 'pending'),
              paymentCurrency: ((paymentData?.currency as CurrencyCode) || 'USD'),
              paymentRequiresChange: Boolean(paymentData?.requires_change),
              paymentChangeFor: normalizeSnapshotText(
                paymentData?.change_for == null ? '' : String(paymentData.change_for)
              ),
              paymentChangeCurrency: ((paymentData?.change_currency as CurrencyCode) || 'USD'),
              paymentNote: normalizeSnapshotText(paymentData?.notes),
              fxRate: normalizeSnapshotText(editFxRate > 0 ? String(Number(editFxRate.toFixed(2))) : ''),
              discountEnabled: Boolean(pricing?.discount_enabled),
              discountPct: normalizeSnapshotText(
                pricing?.discount_pct == null ? '0' : String(pricing.discount_pct)
              ),
              hasInvoice: Boolean(documents?.has_invoice),
              invoiceTaxPct: normalizeSnapshotText(
                pricing?.invoice_tax_pct == null ? '16' : String(pricing.invoice_tax_pct)
              ),
              hasDeliveryNote: Boolean(documents?.has_delivery_note),
              invoiceCompanyName: normalizeSnapshotText(
                documents?.invoice_snapshot?.company_name || orderClient?.billing_company_name
              ),
              invoiceTaxId: normalizeSnapshotText(
                documents?.invoice_snapshot?.tax_id || orderClient?.billing_tax_id
              ),
              invoiceAddress: normalizeSnapshotText(
                documents?.invoice_snapshot?.address || orderClient?.billing_address
              ),
              invoicePhone: normalizeSnapshotText(
                documents?.invoice_snapshot?.phone || orderClient?.billing_phone
              ),
              deliveryNoteName: normalizeSnapshotText(
                documents?.delivery_note_snapshot?.name || orderClient?.delivery_note_name
              ),
              deliveryNoteDocumentId: normalizeSnapshotText(
                documents?.delivery_note_snapshot?.document_id ||
                  orderClient?.delivery_note_document_id
              ),
              deliveryNoteAddress: normalizeSnapshotText(
                documents?.delivery_note_snapshot?.address || orderClient?.delivery_note_address
              ),
              deliveryNotePhone: normalizeSnapshotText(
                documents?.delivery_note_snapshot?.phone || orderClient?.delivery_note_phone
              ),
              totalUsd: orderMoney.totalUsd,
              totalBs: orderMoney.totalBs,
              items: orderItems.map((item) => ({
                productId: Number(item.product_id || 0),
                productName: normalizeSnapshotText(item.product_name_snapshot),
                qty: Number(item.qty || 0),
                lineTotalUsd: Number(Number(item.line_total_usd || 0).toFixed(2)),
                detailLines: item.editable_detail_lines
                  .map((line) => normalizeSnapshotText(line))
                  .filter(Boolean),
              })),
            });
            setInfo(
              recalculationRequested
                ? skippedRepeatItems.length > 0
                  ? `Pedido listo para recalcular con tasa vigente. ${skippedRepeatItems.length} item${skippedRepeatItems.length === 1 ? '' : 's'} ya no esta${skippedRepeatItems.length === 1 ? '' : 'n'} activo${skippedRepeatItems.length === 1 ? '' : 's'} y debe revisarlo master/admin.`
                  : 'Pedido listo para recalcular con precios y tasa vigentes.'
                : 'Pedido listo para corregir.'
            );
          } else {
            setOriginalEditSnapshot(null);
            setExistingOrderNumber('');
            setExistingOrderStatus('');
            setInfo(
              skippedRepeatItems.length > 0
                ? `Pedido base listo para repetir con precios vigentes. ${skippedRepeatItems.length} item${skippedRepeatItems.length === 1 ? '' : 's'} ya no esta${skippedRepeatItems.length === 1 ? '' : 'n'} activo${skippedRepeatItems.length === 1 ? '' : 's'} y no se copio${skippedRepeatItems.length === 1 ? '' : 'n'}.`
                : 'Pedido base listo para repetir con precios, tasa y condiciones vigentes.'
            );
          }
        }
      } else if (initialDraft) {
        applyInitialDraft(initialDraft);
      }

      setLoading(false);
    }

    void boot();
  }, [initialDraft, isEditingOrder, rounded, router, sourceOrderId, supabase]);

  useEffect(() => {
    if (
      paymentMethod === 'cash_ves' ||
      paymentMethod === 'transfer' ||
      paymentMethod === 'payment_mobile' ||
      paymentMethod === 'pos'
    ) {
      setPaymentCurrency('VES');
    } else if (paymentMethod === 'cash_usd' || paymentMethod === 'zelle' || paymentMethod === 'wallet_usd' || paymentMethod === 'pending') {
      setPaymentCurrency('USD');
    }
  }, [paymentMethod]);

  useEffect(() => {
    if (
      fulfillment === 'delivery' &&
      !deliveryAddressTouched &&
      !deliveryAddress.trim() &&
      selectedClientAddresses.length > 0
    ) {
      setDeliveryAddress(selectedClientAddresses[0].addressText);
      setDeliveryGpsUrl(selectedClientAddresses[0].gpsUrl);
    }
  }, [deliveryAddress, deliveryAddressTouched, deliveryGpsUrl, fulfillment, selectedClientAddresses]);

  function clearMessages() {
    setError(null);
    setInfo(null);
  }

  function rememberClient(client: ClientRow | RecentClientChip) {
    const nextClient = {
      id: Number(client.id),
      full_name: String(client.full_name || 'Cliente'),
      phone: client.phone || null,
      client_type: client.client_type || null,
      fund_balance_usd: client.fund_balance_usd ?? null,
      recent_addresses: client.recent_addresses,
      billing_company_name: client.billing_company_name ?? null,
      billing_tax_id: client.billing_tax_id ?? null,
      billing_address: client.billing_address ?? null,
      billing_phone: client.billing_phone ?? null,
      delivery_note_name: client.delivery_note_name ?? null,
      delivery_note_document_id: client.delivery_note_document_id ?? null,
      delivery_note_address: client.delivery_note_address ?? null,
      delivery_note_phone: client.delivery_note_phone ?? null,
    } satisfies RecentClientChip;

    setRecentClients((current) => [
      nextClient,
      ...current.filter((row) => row.id !== nextClient.id),
    ].slice(0, 6));
    setClientUsageById((current) => ({
      ...current,
      [String(nextClient.id)]: Number(current[String(nextClient.id)] || 0) + 1,
    }));
  }

  function rememberProduct(productId: number) {
    setRecentProductIds((current) => [productId, ...current.filter((id) => id !== productId)].slice(0, 8));
    setProductUsageById((current) => ({
      ...current,
      [String(productId)]: Number(current[String(productId)] || 0) + 1,
    }));
  }

  function rememberAddress(addressText: string, gpsUrl: string) {
    const normalized = {
      addressText: String(addressText || '').trim(),
      gpsUrl: String(gpsUrl || '').trim(),
    };
    if (!normalized.addressText && !normalized.gpsUrl) return;

    setRecentAddresses((current) => [
      normalized,
      ...current.filter(
        (row) =>
          row.addressText.trim() !== normalized.addressText || row.gpsUrl.trim() !== normalized.gpsUrl
      ),
    ].slice(0, 6));
  }

  function toggleFavoriteProduct(productId: number) {
    setFavoriteProductIds((current) =>
      current.includes(productId) ? current.filter((id) => id !== productId) : [productId, ...current].slice(0, 8)
    );
  }

  function buildCurrentEditSnapshot(clientId: number | null): OrderEditSnapshot {
    return {
      clientId,
      fulfillment,
      deliveryDate: normalizeSnapshotText(deliveryDate),
      deliveryTime12: normalizeSnapshotText(`${deliveryHour12}:${deliveryMinute} ${deliveryAmPm}`),
      isAsap,
      receiverName: normalizeSnapshotText(receiverName),
      receiverPhone: normalizeSnapshotText(receiverPhone),
      deliveryAddress: normalizeSnapshotText(deliveryAddress),
      deliveryGpsUrl: normalizeSnapshotText(deliveryGpsUrl),
      orderNote: normalizeSnapshotText(orderNote),
      paymentMethod,
      paymentCurrency,
      paymentRequiresChange,
      paymentChangeFor: normalizeSnapshotText(paymentChangeFor),
      paymentChangeCurrency,
      paymentNote: normalizeSnapshotText(paymentNote),
      fxRate: normalizeSnapshotText(fxRate),
      discountEnabled,
      discountPct: normalizeSnapshotText(discountPct),
      hasInvoice,
      invoiceTaxPct: normalizeSnapshotText(invoiceTaxPct),
      hasDeliveryNote,
      invoiceCompanyName: normalizeSnapshotText(invoiceCompanyName),
      invoiceTaxId: normalizeSnapshotText(invoiceTaxId),
      invoiceAddress: normalizeSnapshotText(invoiceAddress),
      invoicePhone: normalizeSnapshotText(invoicePhone),
      deliveryNoteName: normalizeSnapshotText(deliveryNoteName),
      deliveryNoteDocumentId: normalizeSnapshotText(deliveryNoteDocumentId),
      deliveryNoteAddress: normalizeSnapshotText(deliveryNoteAddress),
      deliveryNotePhone: normalizeSnapshotText(deliveryNotePhone),
      totalUsd: Number(finalTotalUsd.toFixed(2)),
      totalBs: Number(finalTotalBs.toFixed(2)),
      items: buildDraftItemsSnapshot(draftItems),
    };
  }

  function applyInitialDraft(draft: AdvisorOrderDraftInitial) {
    const payload = draft.payload || {};
    const clientSnapshot = draft.client_snapshot || null;
    const clientId = Number(clientSnapshot?.id || draft.client_id || 0);
    const newClientSnapshot = draft.new_client_snapshot || {};
    const payloadNewClient = payload.newClient || {};
    const nextStatus = normalizeDraftStatus(draft.status) || 'draft';

    setActiveDraftId(Number(draft.id));
    setActiveDraftStatus(nextStatus);
    setOriginalEditSnapshot(null);
    setExistingOrderNumber('');
    setExistingOrderStatus('');
    setAdvisorRecalculationMode(false);

    if (clientId > 0 && clientSnapshot?.full_name) {
      const client = {
        id: clientId,
        full_name: String(clientSnapshot.full_name || 'Cliente'),
        phone: clientSnapshot.phone || null,
        client_type: clientSnapshot.client_type || null,
        fund_balance_usd: clientSnapshot.fund_balance_usd ?? null,
        recent_addresses: clientSnapshot.recent_addresses,
        billing_company_name: clientSnapshot.billing_company_name ?? null,
        billing_tax_id: clientSnapshot.billing_tax_id ?? null,
        billing_address: clientSnapshot.billing_address ?? null,
        billing_phone: clientSnapshot.billing_phone ?? null,
        delivery_note_name: clientSnapshot.delivery_note_name ?? null,
        delivery_note_document_id: clientSnapshot.delivery_note_document_id ?? null,
        delivery_note_address: clientSnapshot.delivery_note_address ?? null,
        delivery_note_phone: clientSnapshot.delivery_note_phone ?? null,
      } satisfies ClientRow;

      setSelectedClient(client);
      rememberClient(client);
      setSearchTerm(client.phone || client.full_name);
      setIsNewClientMode(false);
    } else {
      const fullName =
        String(newClientSnapshot.fullName || newClientSnapshot.full_name || payloadNewClient.fullName || '').trim();
      const phone = String(newClientSnapshot.phone || payloadNewClient.phone || '').trim();
      const typeValue = String(newClientSnapshot.type || payloadNewClient.type || 'assigned');

      setSelectedClient(null);
      setNewClientName(fullName);
      setNewClientPhone(phone);
      setNewClientType(typeValue === 'own' || typeValue === 'legacy' ? typeValue : 'assigned');
      setIsNewClientMode(Boolean(fullName || phone));
      setSearchTerm(phone || fullName);
    }

    const normalizedItems = normalizeDraftItemsPayload(payload.items);
    setClientResults([]);
    setDraftItems(normalizedItems);
    setFulfillment(payload.fulfillment === 'delivery' ? 'delivery' : 'pickup');
    setDeliveryDate(String(payload.deliveryDate || ''));
    setDeliveryHour12(String(payload.deliveryHour12 || ''));
    setDeliveryMinute(String(payload.deliveryMinute || ''));
    setDeliveryAmPm(payload.deliveryAmPm === 'PM' ? 'PM' : 'AM');
    setIsAsap(Boolean(payload.isAsap));
    setReceiverName(String(payload.receiverName || ''));
    setReceiverPhone(String(payload.receiverPhone || ''));
    setDeliveryAddress(String(payload.deliveryAddress || ''));
    setDeliveryGpsUrl(String(payload.deliveryGpsUrl || ''));
    setDeliveryAddressTouched(Boolean(payload.deliveryAddress || payload.deliveryGpsUrl));
    rememberAddress(String(payload.deliveryAddress || ''), String(payload.deliveryGpsUrl || ''));
    setOrderNote(String(payload.orderNote || ''));
    setPaymentMethod((payload.paymentMethod as PaymentMethod) || 'pending');
    setPaymentCurrency((payload.paymentCurrency as CurrencyCode) || 'USD');
    setPaymentRequiresChange(Boolean(payload.paymentRequiresChange));
    setPaymentChangeFor(String(payload.paymentChangeFor || ''));
    setPaymentChangeCurrency((payload.paymentChangeCurrency as CurrencyCode) || 'USD');
    setPaymentNote(String(payload.paymentNote || ''));
    setFxRate(String(payload.fxRate || draft.fx_rate || ''));
    setDiscountEnabled(Boolean(payload.discountEnabled));
    setDiscountPct(String(payload.discountPct ?? '0'));
    setInvoiceTaxPct(String(payload.invoiceTaxPct ?? '16'));
    setHasDeliveryNote(Boolean(payload.hasDeliveryNote));
    setHasInvoice(Boolean(payload.hasInvoice));
    setDeliveryNotePanelOpen(Boolean(payload.hasDeliveryNote));
    setInvoicePanelOpen(Boolean(payload.hasInvoice));
    setInvoiceCompanyName(String(payload.invoiceCompanyName || ''));
    setInvoiceTaxId(String(payload.invoiceTaxId || ''));
    setInvoiceAddress(String(payload.invoiceAddress || ''));
    setInvoicePhone(String(payload.invoicePhone || ''));
    setDeliveryNoteName(String(payload.deliveryNoteName || ''));
    setDeliveryNoteDocumentId(String(payload.deliveryNoteDocumentId || ''));
    setDeliveryNoteAddress(String(payload.deliveryNoteAddress || ''));
    setDeliveryNotePhone(String(payload.deliveryNotePhone || ''));
    setInfo(nextStatus === 'quoted' ? 'Cotizacion cargada. Al crear el pedido se respetan estos precios y tasa.' : 'Borrador cargado.');
  }

  function buildClientSnapshot() {
    if (!selectedClient) return null;

    return {
      id: selectedClient.id,
      full_name: selectedClient.full_name,
      phone: selectedClient.phone,
      client_type: selectedClient.client_type,
      fund_balance_usd: selectedClient.fund_balance_usd ?? null,
      recent_addresses: selectedClient.recent_addresses ?? null,
      billing_company_name: selectedClient.billing_company_name ?? null,
      billing_tax_id: selectedClient.billing_tax_id ?? null,
      billing_address: selectedClient.billing_address ?? null,
      billing_phone: selectedClient.billing_phone ?? null,
      delivery_note_name: selectedClient.delivery_note_name ?? null,
      delivery_note_document_id: selectedClient.delivery_note_document_id ?? null,
      delivery_note_address: selectedClient.delivery_note_address ?? null,
      delivery_note_phone: selectedClient.delivery_note_phone ?? null,
    };
  }

  function buildNewClientSnapshot() {
    if (!isNewClientMode && !newClientName.trim() && !newClientPhone.trim()) return null;

    return {
      fullName: newClientName.trim(),
      phone: normalizePhone(newClientPhone.trim()) || newClientPhone.trim(),
      type: newClientType,
    };
  }

  function buildAdvisorDraftTitle() {
    const clientName = selectedClient?.full_name || newClientName.trim() || 'Cliente pendiente';
    const itemLabel = `${draftItems.length} item${draftItems.length === 1 ? '' : 's'}`;
    return `${clientName} · ${itemLabel}`;
  }

  function buildAdvisorDraftPayload() {
    return {
      version: 1,
      savedAt: new Date().toISOString(),
      clientId: selectedClient?.id ?? null,
      newClient: buildNewClientSnapshot(),
      fulfillment,
      deliveryDate,
      deliveryHour12,
      deliveryMinute,
      deliveryAmPm,
      isAsap,
      receiverName,
      receiverPhone,
      deliveryAddress,
      deliveryGpsUrl,
      orderNote,
      paymentMethod,
      paymentCurrency,
      paymentRequiresChange,
      paymentChangeFor,
      paymentChangeCurrency,
      paymentNote,
      fxRate,
      discountEnabled,
      discountPct,
      invoiceTaxPct,
      hasDeliveryNote,
      hasInvoice,
      invoiceCompanyName,
      invoiceTaxId,
      invoiceAddress,
      invoicePhone,
      deliveryNoteName,
      deliveryNoteDocumentId,
      deliveryNoteAddress,
      deliveryNotePhone,
      totals: {
        subtotalUsd: Number(draftTotalUsd.toFixed(2)),
        subtotalBs: Number(draftSubtotalBs.toFixed(2)),
        totalUsd: Number(finalTotalUsd.toFixed(2)),
        totalBs: Number(finalTotalBs.toFixed(2)),
      },
      items: draftItems,
    };
  }

  function canSaveCurrentDraft() {
    return (
      draftItems.length > 0 ||
      Boolean(selectedClient) ||
      newClientName.trim().length > 0 ||
      newClientPhone.trim().length > 0
    );
  }

  async function saveCurrentDraft(status: AdvisorOrderDraftStatus = 'draft', quoteText?: string | null) {
    if (savingDraftRef.current) return false;

    clearMessages();
    if (!canSaveCurrentDraft()) {
      setError('Agrega un cliente o un item para guardar el borrador.');
      return false;
    }

    savingDraftRef.current = true;
    setSavingDraft(true);

    try {
      const result = await saveAdvisorOrderDraftAction({
        draftId: activeDraftId,
        status: status === 'quoted' ? 'quoted' : 'draft',
        title: buildAdvisorDraftTitle(),
        clientId: selectedClient?.id ?? null,
        clientSnapshot: buildClientSnapshot(),
        newClientSnapshot: buildNewClientSnapshot(),
        payload: buildAdvisorDraftPayload(),
        quoteText: quoteText ?? null,
        totalUsd: Number(finalTotalUsd.toFixed(2)),
        totalBs: Number(finalTotalBs.toFixed(2)),
        fxRate: fxRateNumber > 0 ? fxRateNumber : null,
      });

      setActiveDraftId(result.id);
      setActiveDraftStatus(normalizeDraftStatus(result.status) || status);
      setInfo(status === 'quoted' ? 'Presupuesto copiado y cotizacion guardada.' : 'Borrador guardado.');
      return true;
    } catch (draftError) {
      setError(draftError instanceof Error ? draftError.message : 'No se pudo guardar el borrador.');
      return false;
    } finally {
      savingDraftRef.current = false;
      setSavingDraft(false);
    }
  }

  function applyClientProfile(client: ClientRow) {
    setInvoiceCompanyName(client.billing_company_name || '');
    setInvoiceTaxId(client.billing_tax_id || '');
    setInvoiceAddress(client.billing_address || '');
    setInvoicePhone(client.billing_phone || '');
    setDeliveryNoteName(client.delivery_note_name || '');
    setDeliveryNoteDocumentId(client.delivery_note_document_id || '');
    setDeliveryNoteAddress(client.delivery_note_address || '');
    setDeliveryNotePhone(client.delivery_note_phone || '');
  }

  function selectClient(client: ClientRow, notice?: string) {
    setSelectedClient(client);
    rememberClient(client);
    applyClientProfile(client);
    setDeliveryAddressTouched(false);
    setIsNewClientMode(false);
    setClientResults([]);
    setSearchTerm(client.phone ?? client.full_name);
    setInfo(notice || `Cliente listo: ${client.full_name}`);
  }

  async function handleSearchClients(e?: FormEvent) {
    e?.preventDefault();
    if (searchingClientRef.current) return;

    clearMessages();

    const query = searchTerm.trim();
    const remoteQuery = normalizeRemoteSearchValue(query);
    if (!query) {
      setClientResults([]);
      return;
    }
    if (!remoteQuery) {
      setClientResults([]);
      return;
    }

    searchingClientRef.current = true;
    setSearchingClient(true);

    let clientMatches: ClientRow[] = [];

    try {
      const phoneFilters = getPhoneSearchTerms(remoteQuery || query)
        .map((term) => term.replace(/[,%]/g, ' '))
        .filter(Boolean)
        .slice(0, 5)
        .map((term) => `phone.ilike.%${term}%`);

      const { data: accentSafeData, error: accentSafeError } = await supabase.rpc('search_clients_unaccent', {
        p_query: remoteQuery,
        p_limit: 12,
      });

      const { data, error: searchError } = accentSafeError
        ? await supabase
            .from('clients')
            .select('id, full_name, phone, client_type, fund_balance_usd, recent_addresses, billing_company_name, billing_tax_id, billing_address, billing_phone, delivery_note_name, delivery_note_document_id, delivery_note_address, delivery_note_phone')
            .or([`phone.ilike.%${remoteQuery}%`, ...phoneFilters, `full_name.ilike.%${remoteQuery}%`].join(','))
            .order('id', { ascending: false })
            .limit(12)
        : { data: accentSafeData, error: null };

      if (searchError) {
        setError(searchError.message);
        return;
      }

      clientMatches = (data ?? []) as ClientRow[];
    } catch {
      setError('No se pudo buscar el cliente.');
      return;
    } finally {
      searchingClientRef.current = false;
      setSearchingClient(false);
    }

    const sortedResults = clientMatches
      .map((client) => ({
        client,
        score: clientSearchScore({
          client,
          query,
          recentIds: recentClients.map((row) => row.id),
          usageById: clientUsageById,
        }),
      }))
      .filter((row) => Number.isFinite(row.score))
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return a.client.full_name.localeCompare(b.client.full_name, 'es', { sensitivity: 'base' });
      })
      .map((row) => row.client);

    if (sortedResults.length === 1 && exactClientMatch(sortedResults[0], query)) {
      selectClient(sortedResults[0]);
      return;
    }

    setClientResults(sortedResults);
    setInfo(
      sortedResults.length === 0
        ? `No hubo coincidencias para "${query}".`
        : sortedResults.length === 1
          ? '1 cliente listo para elegir.'
          : `${sortedResults.length} clientes listos para elegir.`
    );
  }

  async function createClientNow() {
    if (creatingClientRef.current) throw new Error('Ya se esta creando el cliente.');

    clearMessages();
    const full_name = newClientName.trim();
    const phone = normalizePhone(newClientPhone.trim());

    if (!full_name) throw new Error('Falta el nombre del cliente.');
    if (!phone) throw new Error('Falta el telefono del cliente.');

    creatingClientRef.current = true;
    setCreatingClient(true);

    try {
      const phoneFilters = getPhoneSearchTerms(phone)
        .map((term) => term.replace(/[,%]/g, ' '))
        .filter(Boolean)
        .slice(0, 5)
        .map((term) => `phone.ilike.%${term}%`);
      const { data: existing, error: existingError } = await supabase
        .from('clients')
        .select('id, full_name, phone, client_type, fund_balance_usd, recent_addresses, billing_company_name, billing_tax_id, billing_address, billing_phone, delivery_note_name, delivery_note_document_id, delivery_note_address, delivery_note_phone')
        .or([`phone.eq.${phone}`, ...phoneFilters].join(','))
        .limit(1);

      if (existingError) throw new Error(existingError.message);

      if (existing && existing.length > 0) {
        const current = existing[0] as ClientRow;
        selectClient(current);
        return current.id;
      }

      const { data: created, error: createError } = await supabase
        .from('clients')
        .insert({ full_name, phone, client_type: newClientType })
        .select('id, full_name, phone, client_type, fund_balance_usd, recent_addresses, billing_company_name, billing_tax_id, billing_address, billing_phone, delivery_note_name, delivery_note_document_id, delivery_note_address, delivery_note_phone')
        .single();

      if (createError) throw new Error(createError.message);

      const client = created as ClientRow;
      selectClient(client, `Cliente creado: ${client.full_name}`);
      return client.id;
    } finally {
      creatingClientRef.current = false;
      setCreatingClient(false);
    }
  }

  async function handleCreateClientClick() {
    try {
      await createClientNow();
    } catch (clientError) {
      setError(clientError instanceof Error ? clientError.message : 'No se pudo crear el cliente.');
    }
  }

  function resetConfig() {
    setConfigOpen(false);
    setConfigEditingLocalId(null);
    setConfigProductId(null);
    setConfigQty(1);
    setConfigAlias('');
    setConfigSelections([]);
  }

  function pulseAddedItemFeedback() {
    setItemJustAdded(true);
    window.setTimeout(() => setItemJustAdded(false), 900);
  }

  function applyClientAddress(address: ClientAddress) {
    setDeliveryAddressTouched(true);
    setDeliveryAddress(address.addressText);
    setDeliveryGpsUrl(address.gpsUrl);
    rememberAddress(address.addressText, address.gpsUrl);
  }

  function chooseProduct(product: ProductRow) {
    setSelectedProductId(product.id);
    setProductSearch(product.name);
    setProductActiveIndex(filteredProducts.findIndex((row) => row.id === product.id));
  }

  function getProductComponents(productId: number) {
    return productComponents
      .filter((row) => row.parent_product_id === productId)
      .sort((a, b) => Number(a.sort_order || 0) - Number(b.sort_order || 0));
  }

  function buildComponentDetailLines(
    productId: number,
    options?: {
      totalMultiplier?: number;
      selectedByProductId?: Map<number, number>;
      includeMetadata?: boolean;
    }
  ) {
    const totalMultiplier = Math.max(1, Number(options?.totalMultiplier || 1));
    const selectedByProductId = options?.selectedByProductId ?? new Map<number, number>();
    const detailLines: string[] = [];

    for (const component of getProductComponents(productId)) {
      let componentQty = 0;

      if (component.component_mode === 'fixed' && component.is_required) {
        componentQty = Number(component.quantity || 0);
      } else {
        componentQty = selectedByProductId.get(component.component_product_id) ?? 0;
      }

      componentQty = Math.max(0, Number(componentQty || 0));
      if (componentQty <= 0) continue;

      const product = productById.get(component.component_product_id);
      const componentName = product?.name || `Componente ${component.component_product_id}`;
      const totalQty = componentQty * totalMultiplier;
      detailLines.push(`${totalQty} ${componentName}`);

      if (options?.includeMetadata) {
        detailLines.push(`${HIDDEN_DETAIL_PREFIX}${component.component_product_id}|${totalQty}`);
      }
    }

    return detailLines;
  }

  function buildDraftItem(product: ProductRow, quantity: number, lines: string[]) {
    const { sourceCurrency, sourceAmount } = getProductSourcePricing(product);
    const snapshot = calculateOrderLineSnapshot({
      sourceCurrency,
      sourceAmount,
      quantity,
      fxRate: fxRateNumber,
      fallbackUnitUsd: Number(product.base_price_usd ?? 0),
    });

    return {
      localId: `${product.id}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      product_id: product.id,
      product_type: product.type,
      sku_snapshot: product.sku,
      product_name_snapshot: product.name,
      units_per_service: Number(product.units_per_service ?? 0) || 0,
      qty: quantity,
      source_price_currency: sourceCurrency,
      source_price_amount: sourceAmount,
      unit_price_usd_snapshot: snapshot.unitUsd,
      line_total_usd: snapshot.lineUsd,
      editable_detail_lines: lines,
    } satisfies DraftItem;
  }

  function handleRecalculateDraftPricesFromCatalog() {
    clearMessages();

    let changedCount = 0;
    const nextItems = draftItems.map((item) => {
      const product = productById.get(item.product_id);
      if (!product) return item;

      const next = calculateCatalogSnapshotForDraftItem(item, product, fxRateNumber);
      if (!draftItemHasCatalogPriceDrift(item, product, fxRateNumber)) return item;

      changedCount += 1;

      return {
        ...item,
        product_type: product.type,
        sku_snapshot: product.sku,
        product_name_snapshot: product.name,
        units_per_service: Number(product.units_per_service ?? 0) || 0,
        source_price_currency: next.sourceCurrency,
        source_price_amount: next.sourceAmount,
        unit_price_usd_snapshot: next.snapshot.unitUsd,
        line_total_usd: next.snapshot.lineUsd,
      };
    });

    setDraftItems(nextItems);

    setInfo(
      changedCount > 0
        ? `Precios recalculados con el catalogo vigente (${changedCount} item${changedCount === 1 ? '' : 's'}).`
        : 'Los items ya estan alineados con el catalogo vigente.'
    );
  }

  function openConfigForProduct(product: ProductRow, quantity: number) {
    const optionalFixedSelections = getProductComponents(product.id)
      .filter((row) => row.component_mode === 'fixed' && !row.is_required && Number(row.quantity || 0) > 0)
      .map((row) => {
        const option = productById.get(row.component_product_id);
        if (!option) return null;
        return {
          componentProductId: option.id,
          name: option.name,
          qty: Number(row.quantity || 0),
        } satisfies ConfigSelection;
      })
      .filter((row): row is ConfigSelection => !!row);

    setConfigEditingLocalId(null);
    setConfigProductId(product.id);
    setConfigQty(quantity);
    setConfigAlias('');
    setConfigSelections(optionalFixedSelections);
    setConfigOpen(true);
  }

  function openEditConfig(item: DraftItem) {
    const parsed = parseEditableDetailLines(item.editable_detail_lines);
    const product = productById.get(item.product_id);
    if (!product) {
      setError('No se pudo cargar la configuracion del item.');
      return;
    }

    const nextOptions = getProductComponents(product.id).filter(
      (row) => row.component_mode === 'selectable' || (row.component_mode === 'fixed' && !row.is_required)
    );

    setConfigEditingLocalId(item.localId);
    setConfigProductId(item.product_id);
    setConfigQty(item.qty);
    setConfigAlias(parsed.alias);
    setConfigSelections(
      parsed.selections
        .map((selection) => {
          const component =
            (selection.componentProductId != null
              ? nextOptions.find((row) => row.component_product_id === selection.componentProductId)
              : null) ??
            nextOptions.find((row) => {
              const product = productById.get(row.component_product_id);
              return product?.name === selection.componentName;
            });
          const option = component ? productById.get(component.component_product_id) : null;
          if (!component || !option) return null;
          return {
            componentProductId: option.id,
            name: option.name,
            qty: selection.qty,
          };
        })
        .filter((row): row is ConfigSelection => !!row)
    );
    setConfigOpen(true);
  }

  function addDraftItem() {
    clearMessages();
    if (!selectedProduct) {
      setError('Selecciona un producto.');
      return;
    }

    const quantity = parseQuantityValue(qty);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      setError('La cantidad debe ser mayor que cero.');
      return;
    }

    const hasConfigurableComponents = productComponents.some(
      (row) =>
        row.parent_product_id === selectedProduct.id &&
        (row.component_mode === 'selectable' || (row.component_mode === 'fixed' && !row.is_required))
    );

    if (selectedProduct.is_detail_editable || hasConfigurableComponents) {
      if (quantity !== 1) {
        setError('Los productos configurables se cargan uno por uno. Debes usar cantidad 1.');
        return;
      }

      openConfigForProduct(selectedProduct, quantity);
      return;
    }

    rememberProduct(selectedProduct.id);
    setDraftItems((current) => [
      ...current,
      buildDraftItem(
        selectedProduct,
        quantity,
        buildComponentDetailLines(selectedProduct.id, { totalMultiplier: quantity })
      ),
    ]);
    pulseAddedItemFeedback();
    setInfo(`Item agregado: ${selectedProduct.name}`);
    setQty('1');
    setSelectedProductId('');
    setProductSearch('');
    setProductActiveIndex(-1);
  }

  function removeDraftItem(localId: string) {
    setDraftItems((current) => current.filter((item) => item.localId !== localId));
  }

  function updateQty(nextValue: number | string) {
    const raw = String(nextValue ?? '').trim();
    const normalized = sanitizeQuantityInput(raw);

    if (!normalized) {
      setQty('');
      return;
    }

    if (normalized === '.') {
      setQty('0.');
      return;
    }

    setQty(normalized);
  }

  function setConfigSelectionQty(product: ProductRow, quantity: number) {
    const nextQty = Number.isFinite(quantity) && quantity > 0 ? Math.floor(quantity) : 0;

    setConfigSelections((current) => {
      const rest = current.filter((item) => item.componentProductId !== product.id);
      if (nextQty <= 0) return rest;
      return [...rest, { componentProductId: product.id, name: product.name, qty: nextQty }];
    });
  }

  function confirmConfig() {
    if (!configProduct) {
      setError('No se encontro el producto a configurar.');
      return;
    }

    if (configTotalLimit > 0 && configSelectedUnits !== configTotalLimit) {
      setError(`Debes completar ${configTotalLimit} piezas para este producto.`);
      return;
    }

    const selectedByProductId = new Map(
      configSelections
        .filter((item) => item.qty > 0)
        .map((item) => [item.componentProductId, item.qty] as const)
    );
    const detailLines = [
      configAlias.trim() ? `Para: ${configAlias.trim()}` : null,
      ...buildComponentDetailLines(configProduct.id, {
        selectedByProductId,
        includeMetadata: true,
      }),
    ].filter((line): line is string => !!line);

    const item = buildDraftItem(configProduct, configQty, detailLines);

    if (configEditingLocalId) {
      setDraftItems((current) =>
        current.map((draft) =>
          draft.localId === configEditingLocalId ? { ...item, localId: draft.localId } : draft
        )
      );
      setInfo(`Composicion actualizada: ${configProduct.name}`);
    } else {
      rememberProduct(configProduct.id);
      setDraftItems((current) => [...current, item]);
      pulseAddedItemFeedback();
      setInfo(`Item agregado: ${configProduct.name}`);
    }

    setQty('1');
    setSelectedProductId('');
    setProductSearch('');
    setProductActiveIndex(-1);
    resetConfig();
  }

  function buildQuoteSummary() {
    const parts: string[] = [];
    const clientName = selectedClient?.full_name || newClientName.trim() || 'Cliente';
    const clientPhone = selectedClient?.phone || newClientPhone.trim();
    const deliveryDayLabel = deliveryDate
      ? new Date(`${deliveryDate}T12:00:00`).toLocaleDateString('es-VE', {
          weekday: 'long',
          day: '2-digit',
          month: '2-digit',
          year: '2-digit',
          timeZone: 'America/Caracas',
        })
      : 'Sin fecha';
    const deliveryHourLabel =
      deliveryHour12.trim() && deliveryMinute.trim()
        ? `${deliveryHour12}:${deliveryMinute}${deliveryAmPm.toLowerCase()}`
        : 'Sin hora';
    parts.push('*Presupuesto*');
    parts.push('');
    parts.push(`✅ Asesor: ${authUserLabel}`);
    parts.push('');
    parts.push(`✅ Cliente: ${clientName}`);

    if (clientPhone) {
      parts.push('');
      parts.push(`✅ Telefono: ${clientPhone}`);
    }

    parts.push('');
    parts.push('✅ Pedido:');
    parts.push('');

    if (draftItems.length === 0) {
      parts.push('- Sin items cargados');
    } else {
      for (const item of draftItems) {
        const lineBs =
          item.source_price_currency === 'VES'
            ? Number(item.source_price_amount || 0) * Number(item.qty || 0)
            : Number(item.line_total_usd || 0) * fxRateNumber;
        parts.push(`▪ ${item.qty} ${item.product_name_snapshot}: ${formatBsWhatsApp(lineBs)}`);
        if (item.editable_detail_lines.length > 0) {
          for (const detail of item.editable_detail_lines) {
            parts.push(`   - ${detail}`);
          }
        }
      }
    }

    parts.push('');
    parts.push(`TOTAL: ${formatBsWhatsApp(finalTotalBs)} / ${finalTotalUsd.toFixed(2)}$`);
    parts.push('');
    parts.push(`✅ Forma de pago: ${getPaymentMethodLabel(paymentMethod)}`);
    parts.push('');
    parts.push('✅ Estatus de pago: Pendiente');
    parts.push('');
    parts.push(
      `✅ Dia de entrega ${isAsap ? 'lo antes posible' : deliveryDayLabel}`
    );

    if (!isAsap) {
      parts.push('');
      parts.push(`✅ Hora: ${deliveryHourLabel}`);
    }

    if (fulfillment === 'delivery' && deliveryAddress.trim()) {
      parts.push('');
      parts.push(`✅ Direccion: ${deliveryAddress.trim()}`);
    }

    if (orderNote.trim()) {
      parts.push('');
      parts.push(`✅ Nota: ${orderNote.trim()}`);
    }

    return parts.join('\n');
  }

  function buildCleanQuoteSummary() {
    const parts: string[] = [];
    const clientName = selectedClient?.full_name || newClientName.trim() || 'Cliente';
    const clientPhone = selectedClient?.phone || newClientPhone.trim();
    const deliveryDayLabel = deliveryDate
      ? new Date(`${deliveryDate}T12:00:00`).toLocaleDateString('es-VE', {
          weekday: 'long',
          day: '2-digit',
          month: '2-digit',
          year: '2-digit',
          timeZone: 'America/Caracas',
        })
      : 'Sin fecha';
    const deliveryHourLabel =
      deliveryHour12.trim() && deliveryMinute.trim()
        ? `${deliveryHour12}:${deliveryMinute}${deliveryAmPm.toLowerCase()}`
        : 'Sin hora';
    parts.push('*Presupuesto*');
    parts.push('');
    parts.push(`✅ Asesor: ${authUserLabel}`);
    parts.push('');
    parts.push(`✅ Cliente: ${clientName}`);

    if (clientPhone) {
      parts.push('');
      parts.push(`✅ Teléfono: ${clientPhone}`);
    }

    parts.push('');
    parts.push('✅ Pedido:');
    parts.push('');

    if (draftItems.length === 0) {
      parts.push('- Sin items cargados');
    } else {
      for (const item of draftItems) {
        const lineBs =
          item.source_price_currency === 'VES'
            ? Number(item.source_price_amount || 0) * Number(item.qty || 0)
            : Number(item.line_total_usd || 0) * fxRateNumber;
        parts.push(`▪ ${item.qty} ${item.product_name_snapshot}: ${formatBsWhatsApp(lineBs)}`);
        for (const detail of item.editable_detail_lines) {
          const normalizedDetail = String(detail || '').trim();
          if (normalizedDetail) parts.push(`   - ${normalizedDetail}`);
        }
      }
    }

    parts.push('');
    parts.push(`TOTAL: ${formatBsWhatsApp(finalTotalBs)} / ${finalTotalUsd.toFixed(2)}$`);
    parts.push('');
    parts.push(`✅ Forma de pago: ${getPaymentMethodLabel(paymentMethod)}`);
    parts.push('');
    parts.push('✅ Estatus de pago: Pendiente');
    parts.push('');
    parts.push(`✅ Día de entrega ${isAsap ? 'lo antes posible' : deliveryDayLabel}`);

    if (!isAsap) {
      parts.push('');
      parts.push(`✅ Hora: ${deliveryHourLabel}`);
    }

    if (fulfillment === 'delivery' && deliveryAddress.trim()) {
      parts.push('');
      parts.push(`✅ Dirección: ${deliveryAddress.trim()}`);
    }

    if (orderNote.trim()) {
      parts.push('');
      parts.push(`✅ Nota: ${orderNote.trim()}`);
    }

    return parts.join('\n');
  }

  function buildMasterStyleQuoteSummary() {
    const clientName = selectedClient?.full_name || newClientName.trim() || 'Cliente';
    const clientPhone = selectedClient?.phone || newClientPhone.trim();
    const deliveryDayLabel = deliveryDate
      ? new Date(`${deliveryDate}T12:00:00`).toLocaleDateString('es-VE', {
          weekday: 'long',
          day: '2-digit',
          month: '2-digit',
          year: '2-digit',
          timeZone: 'America/Caracas',
        })
      : 'Sin fecha';
    const deliveryHourLabel =
      deliveryHour12.trim() && deliveryMinute.trim()
        ? `${deliveryHour12}:${deliveryMinute}${deliveryAmPm.toLowerCase()}`
        : 'Sin hora';
    const paymentChangeText =
      paymentRequiresChange && paymentChangeFor.trim()
        ? `${paymentChangeFor.trim()} ${paymentChangeCurrency}`.trim()
        : null;

    return buildWhatsAppOrderSummaryText({
      title: 'Presupuesto',
      advisorName: authUserLabel,
      clientName,
      clientPhone,
      receiverName,
      receiverPhone,
      lines: draftItems.map((item) => ({
        text: formatDraftItemWhatsAppLine(item, fxRateNumber),
        detailLines: getVisibleDetailLines(item.editable_detail_lines),
      })),
      price: {
        subtotalBs: draftSubtotalBs,
        subtotalUsd: draftTotalUsd,
        discountPct: discountPctNumber,
        discountAmountBs: discountEnabled ? discountAmountBs : 0,
        discountAmountUsd: discountEnabled ? discountAmountUsd : 0,
        invoiceTaxPct: invoiceTaxPctNumber,
        invoiceTaxAmountBs: hasInvoice ? invoiceTaxAmountBs : 0,
        invoiceTaxAmountUsd: hasInvoice ? invoiceTaxAmountUsd : 0,
        totalBs: finalTotalBs,
        totalUsd: finalTotalUsd,
      },
      fulfillment,
      deliveryText: isAsap ? 'Lo antes posible' : `${deliveryDayLabel} - ${deliveryHourLabel}`,
      deliveryDateText: isAsap ? 'Lo antes posible' : formatWhatsAppDateVE(deliveryDate),
      deliveryTimeText:
        isAsap || !deliveryHour12.trim() || !deliveryMinute.trim()
          ? null
          : formatWhatsAppTimeAmPm(`${deliveryHour12}:${deliveryMinute} ${deliveryAmPm}`),
      address: deliveryAddress,
      gpsUrl: deliveryGpsUrl,
      paymentMethodLabel: getPaymentMethodLabel(paymentMethod),
      paymentChangeText,
      paymentNote,
      paymentStatus: 'Pendiente',
      invoice: {
        enabled: hasInvoice,
        companyName: invoiceCompanyName,
        taxId: invoiceTaxId,
        address: invoiceAddress,
        phone: invoicePhone,
      },
      deliveryNote: {
        enabled: hasDeliveryNote,
        name: deliveryNoteName,
        documentId: deliveryNoteDocumentId,
        address: deliveryNoteAddress,
        phone: deliveryNotePhone,
      },
      notes: orderNote,
    });
  }

  async function handleCopyQuote() {
    if (savingOrderRef.current) return;
    if (copyingQuoteRef.current) return;

    clearMessages();
    if (draftItems.length === 0) {
      setError('Agrega al menos un item para copiar el presupuesto.');
      return;
    }
    if (fulfillment === 'delivery' && !hasDeliveryItem) {
      setError('Agrega el item de delivery antes de copiar el presupuesto.');
      return;
    }

    copyingQuoteRef.current = true;
    setCopyingQuote(true);
    try {
      void buildQuoteSummary;
      void buildCleanQuoteSummary;
      const quoteText = buildMasterStyleQuoteSummary();
      await navigator.clipboard.writeText(quoteText);
      const saved = await saveCurrentDraft('quoted', quoteText);
      if (!saved) {
        setError('El resumen se copio, pero no se pudo guardar como cotizado.');
      }
    } catch {
      setError('No se pudo copiar el resumen.');
    } finally {
      copyingQuoteRef.current = false;
      setCopyingQuote(false);
    }
  }

  async function ensureClientId() {
    if (selectedClient) return selectedClient.id;
    if (!isNewClientMode) throw new Error('Selecciona o crea un cliente.');
    return createClientNow();
  }

  async function generateOrderNumber() {
    const randomNumber = Math.floor(Math.random() * 10000);
    return `VO-${todayKey()}-${pad4(randomNumber)}`;
  }

  function buildExtraFields() {
    const normalizedDeliveryDate = deliveryDate.trim() || (isAsap ? getTodayInputValue() : '');
    const normalizedDeliveryHour12 = deliveryHour12.trim() || (isAsap ? rounded.hour12 : '');
    const normalizedDeliveryMinute = deliveryMinute.trim() || (isAsap ? rounded.minute : '');
    const normalizedDeliveryAmPm = isAsap && !deliveryHour12.trim() ? rounded.ampm : deliveryAmPm;
    const deliveryTime24 = from12hTo24h(
      normalizedDeliveryHour12,
      normalizedDeliveryMinute,
      normalizedDeliveryAmPm,
    );
    const invoiceDataNote = [
      invoiceCompanyName.trim(),
      invoiceTaxId.trim(),
      invoiceAddress.trim(),
      invoicePhone.trim(),
    ]
      .filter(Boolean)
      .join(' | ');

    return {
      schedule: {
        date: normalizedDeliveryDate,
        time_12: `${normalizedDeliveryHour12}:${normalizedDeliveryMinute} ${normalizedDeliveryAmPm}`,
        time_24: deliveryTime24,
        asap: isAsap,
      },
      receiver: {
        name: receiverName.trim() || null,
        phone: receiverPhone.trim() ? normalizePhone(receiverPhone.trim()) : null,
      },
      delivery: {
        address: fulfillment === 'delivery' ? deliveryAddress.trim() || null : null,
        gps_url: fulfillment === 'delivery' ? deliveryGpsUrl.trim() || null : null,
      },
      payment: {
        method: paymentMethod,
        currency: paymentCurrency,
        requires_change: paymentRequiresChange,
        change_for: paymentRequiresChange && paymentChangeFor.trim() ? Number(paymentChangeFor) : null,
        change_currency: paymentRequiresChange ? paymentChangeCurrency : null,
        notes: paymentNote.trim() || null,
      },
      pricing: {
        fx_rate: fxRateNumber > 0 ? fxRateNumber : null,
        discount_enabled: discountEnabled,
        discount_pct: discountEnabled ? discountPctNumber : 0,
        discount_amount_usd: discountEnabled ? discountAmountUsd : 0,
        discount_amount_bs: discountEnabled ? Number(discountAmountBs.toFixed(2)) : 0,
        subtotal_usd: draftTotalUsd,
        subtotal_bs: Number(draftSubtotalBs.toFixed(2)),
        subtotal_after_discount_usd: subtotalAfterDiscountUsd,
        subtotal_after_discount_bs: Number(subtotalAfterDiscountBs.toFixed(2)),
        invoice_tax_pct: hasInvoice ? invoiceTaxPctNumber : 0,
        invoice_tax_amount_usd: hasInvoice ? invoiceTaxAmountUsd : 0,
        invoice_tax_amount_bs: hasInvoice ? Number(invoiceTaxAmountBs.toFixed(2)) : 0,
        total_usd: finalTotalUsd,
        total_bs: Number(finalTotalBs.toFixed(2)),
      },
      documents: {
        has_delivery_note: hasDeliveryNote,
        has_invoice: hasInvoice,
        invoice_data_note: hasInvoice ? invoiceDataNote || null : null,
        invoice_snapshot: hasInvoice
          ? {
              company_name: invoiceCompanyName.trim() || null,
              tax_id: invoiceTaxId.trim() || null,
              address: invoiceAddress.trim() || null,
              phone: normalizePhone(invoicePhone.trim()) || null,
            }
          : null,
        delivery_note_snapshot: hasDeliveryNote
          ? {
              name: deliveryNoteName.trim() || null,
              document_id: deliveryNoteDocumentId.trim() || null,
              address: deliveryNoteAddress.trim() || null,
              phone: normalizePhone(deliveryNotePhone.trim()) || null,
            }
          : null,
      },
      note: orderNote.trim() || null,
      ui: {
        quote_only: false,
        surface: 'advisor_mobile',
      },
    };
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (savingOrderRef.current) return;

    clearMessages();

    if (!createReady) {
      if (!scheduleReady) {
        setError('Falta colocar la fecha y la hora de entrega.');
      } else {
        setError('Completa cliente, items y entrega para continuar.');
      }
      return;
    }

    if (!isAsap && !deliveryDate.trim()) {
      setError('Falta colocar la fecha de entrega.');
      return;
    }

    if (!isAsap && (!deliveryHour12.trim() || !deliveryMinute.trim())) {
      setError('Falta colocar la hora de entrega.');
      return;
    }

    let deliveryTime24 = '';
    try {
      deliveryTime24 = from12hTo24h(
        deliveryHour12.trim() || (isAsap ? rounded.hour12 : ''),
        deliveryMinute.trim() || (isAsap ? rounded.minute : ''),
        isAsap && !deliveryHour12.trim() ? rounded.ampm : deliveryAmPm,
      );
    } catch (timeError) {
      setError(timeError instanceof Error ? timeError.message : 'Hora invalida.');
      return;
    }

    if (!isEditingOrder && !isAsap && isPastAdvisorSchedule(deliveryDate.trim(), deliveryTime24)) {
      setError('No puedes crear una orden con fecha y hora anteriores al momento actual.');
      return;
    }

    if (advisorRecalculationMode) {
      const { data: activeRateData, error: activeRateError } = await supabase
        .from('exchange_rates')
        .select('rate_bs_per_usd')
        .eq('is_active', true)
        .order('effective_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (activeRateError) {
        setError(activeRateError.message);
        return;
      }

      const latestRate = toSafeNumber(activeRateData?.rate_bs_per_usd, 0);
      if (latestRate <= 0) {
        setError('No hay una tasa activa para recalcular esta orden.');
        return;
      }

      const normalizedLatestRate = Number(latestRate.toFixed(2));
      if (Math.abs(normalizedLatestRate - fxRateNumber) > 0.000001) {
        setFxRate(String(normalizedLatestRate));
        setInfo('La tasa activa cambió. Se actualizaron los totales; revísalos y vuelve a guardar.');
        return;
      }
    }

    if (fxRateLockedForAdvisorEdit && originalEditSnapshot?.fxRate && fxRate !== originalEditSnapshot.fxRate) {
      setFxRate(originalEditSnapshot.fxRate);
      setError('La tasa snapshot de una orden creada solo puede corregirla master o admin desde el dashboard.');
      return;
    }

    if (fxRateNumber <= 0) {
      setError('Falta una tasa valida para la orden.');
      return;
    }

    if (advisorEditHasCatalogPriceDrift) {
      setError(
        'Hay items con precios distintos al catalogo vigente. Recalcula los precios antes de guardar para no conservar snapshots vencidos.'
      );
      return;
    }

    savingOrderRef.current = true;
    setSaving(true);

    try {
      const clientId = await ensureClientId();
      const nextEditSnapshot = isEditingOrder ? buildCurrentEditSnapshot(clientId) : null;
      if (selectedClient) rememberClient(selectedClient);
      if (fulfillment === 'delivery') rememberAddress(deliveryAddress, deliveryGpsUrl);
      const recentAddresses = mergeRecentAddresses(
        selectedClient?.recent_addresses,
        fulfillment === 'delivery' ? deliveryAddress : '',
        fulfillment === 'delivery' ? deliveryGpsUrl : ''
      );

      const { error: clientProfileError } = await supabase
        .from('clients')
        .update({
          billing_company_name: hasInvoice ? invoiceCompanyName.trim() || null : null,
          billing_tax_id: hasInvoice ? invoiceTaxId.trim() || null : null,
          billing_address: hasInvoice ? invoiceAddress.trim() || null : null,
          billing_phone: hasInvoice ? normalizePhone(invoicePhone) || null : null,
          delivery_note_name: hasDeliveryNote ? deliveryNoteName.trim() || null : null,
          delivery_note_document_id: hasDeliveryNote ? deliveryNoteDocumentId.trim() || null : null,
          delivery_note_address: hasDeliveryNote ? deliveryNoteAddress.trim() || null : null,
          delivery_note_phone: hasDeliveryNote ? normalizePhone(deliveryNotePhone) || null : null,
          recent_addresses: recentAddresses,
        })
        .eq('id', clientId);

      if (clientProfileError) throw new Error(clientProfileError.message);

      const payload = {
        client_id: clientId,
        attributed_advisor_id: authUserId,
        source: 'advisor',
        status: 'created',
        fulfillment,
        total_usd: finalTotalUsd,
        total_bs_snapshot: Number(finalTotalBs.toFixed(2)),
        is_price_locked: false,
        delivery_address: fulfillment === 'delivery' ? deliveryAddress.trim() || null : null,
        receiver_name: receiverName.trim() || null,
        receiver_phone: receiverPhone.trim() ? normalizePhone(receiverPhone.trim()) : null,
        notes: orderNote.trim() || null,
        extra_fields: buildExtraFields(),
      };

      let targetOrderId = Number(existingOrderId || 0);

      if (isEditingOrder) {
        const updateResult = await updateAdvisorOrderHeaderAction({
          orderId: Number(existingOrderId),
          expectedLastModifiedAt: existingOrderLastModifiedAt,
          payload,
        });
        if (!updateResult.ok) {
          throw new Error(updateResult.message);
        }
        setExistingOrderLastModifiedAt(updateResult.lastModifiedAt ?? existingOrderLastModifiedAt);
      } else {
        const orderNumber = await generateOrderNumber();
        const { data: order, error: orderError } = await supabase
          .from('orders')
          .insert({
            ...payload,
            order_number: orderNumber,
            created_by_user_id: authUserId,
          })
          .select('id')
          .single();

        if (orderError) throw new Error(orderError.message);
        targetOrderId = Number(order.id);
      }

      const itemsPayload = draftItems.map((item, idx) => {
        const snapshot = draftItemSnapshots[idx];

        return {
        order_id: targetOrderId,
        product_id: item.product_id,
        qty: item.qty,
        pricing_origin_currency: item.source_price_currency,
        pricing_origin_amount: item.source_price_amount,
        unit_price_usd_snapshot: snapshot.unitUsd,
        line_total_usd: snapshot.lineUsd,
        unit_price_bs_snapshot: snapshot.unitBs,
        line_total_bs_snapshot: snapshot.lineBs,
        sku_snapshot: item.sku_snapshot,
        product_name_snapshot: item.product_name_snapshot,
        notes: item.editable_detail_lines.length > 0 ? item.editable_detail_lines.join('\n') : null,
        };
      });

      if (isEditingOrder) {
        await replaceAdvisorOrderItemsAction({
          orderId: targetOrderId,
          items: draftItems.map((item, idx) => {
            const snapshot = draftItemSnapshots[idx];

            return {
              productId: Number(item.product_id),
              qty: Number(item.qty || 0),
              sourcePriceCurrency: item.source_price_currency,
              sourcePriceAmount: Number(item.source_price_amount || 0),
              unitPriceUsdSnapshot: snapshot.unitUsd,
              lineTotalUsd: snapshot.lineUsd,
              unitPriceBsSnapshot: snapshot.unitBs,
              lineTotalBsSnapshot: snapshot.lineBs,
              skuSnapshot: item.sku_snapshot,
              productNameSnapshot: item.product_name_snapshot,
              editableDetailLines: item.editable_detail_lines,
            };
          }),
        });
      } else {
        const { error: itemsError } = await supabase.from('order_items').insert(itemsPayload);
        if (itemsError) throw new Error(itemsError.message);

        try {
          await ensureAdvisorOrderCreatedEventAction({ orderId: targetOrderId });
        } catch (timelineError) {
          console.warn(
            'No se pudo registrar el evento de creación.',
            timelineError instanceof Error ? timelineError.message : timelineError
          );
        }
      }

      if (isEditingOrder && nextEditSnapshot && originalEditSnapshot) {
        const changeMeta = buildOrderEditChangeSummary(originalEditSnapshot, nextEditSnapshot);

        await resolveAdvisorOrderReviewNotifications({
          supabase,
          orderId: targetOrderId,
          advisorUserId: authUserId,
        });

        if (changeMeta.summary.length > 0) {
          const { error: timelineError } = await supabase.from('order_timeline_events').insert({
            order_id: targetOrderId,
            order_number: existingOrderNumber || null,
            event_type: 'order_modified',
            event_group: 'modification',
            title: existingOrderStatus === 'queued' ? 'Orden modificada para re-aprobacion' : 'Orden modificada',
            message: changeMeta.summary.join(' '),
            severity: existingOrderStatus === 'queued' ? 'warning' : 'info',
            actor_user_id: authUserId || null,
            payload: {
              changed_sections: changeMeta.sections,
              change_summary: changeMeta.summary,
              source: 'advisor_mobile',
            },
          });

          if (timelineError) {
            console.warn('No se pudo registrar el evento de modificacion.', timelineError.message);
          }
        }
      }

      if (!isEditingOrder && activeDraftId) {
        try {
          await markAdvisorOrderDraftConvertedAction({
            draftId: activeDraftId,
            orderId: targetOrderId,
          });
        } catch (draftError) {
          console.warn(
            'No se pudo marcar el borrador como convertido.',
            draftError instanceof Error ? draftError.message : draftError
          );
        }
      }

      router.push(`/app/advisor/orders/${targetOrderId}`);
    } catch (submitError) {
      const submitMessage = submitError instanceof Error ? submitError.message : '';
      const isOrderItemsRlsError =
        isEditingOrder &&
        submitMessage.toLowerCase().includes('row-level security') &&
        submitMessage.toLowerCase().includes('order_items');
      setError(
        isOrderItemsRlsError
          ? 'No se pudieron guardar los items recalculados por permisos de Supabase. Avísale a master/admin para aplicar la corrección de permisos y vuelve a guardar.'
          : submitMessage
          ? submitMessage
          : isEditingOrder
            ? 'No se pudo actualizar la orden.'
            : 'No se pudo crear la orden.'
      );
    } finally {
      savingOrderRef.current = false;
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="rounded-[24px] border border-[#232632] bg-[#12151d] px-4 py-5 text-sm text-[#AAB2C5]">
        {isEditingOrder
          ? 'Cargando pedido para corregir...'
          : isRepeatingOrder
            ? 'Cargando pedido base para repetir...'
            : 'Cargando captura del asesor...'}
      </div>
    );
  }

  return (
    <>
      <form onSubmit={handleSubmit} className="space-y-4 pb-[calc(6.5rem+env(safe-area-inset-bottom))] sm:pb-[calc(5.5rem+env(safe-area-inset-bottom))]">
        {!isEditingOrder ? (
          <div className="flex items-center justify-between gap-3 rounded-[18px] border border-[#232632] bg-[#0F131B] px-4 py-3">
            <div className="min-w-0">
              <div className="text-[11px] uppercase tracking-[0.22em] text-[#8B93A7]">
                {activeDraftId ? `${getDraftStatusLabel(activeDraftStatus)} #${activeDraftId}` : 'Nuevo pedido'}
              </div>
              <div className="mt-1 truncate text-sm font-medium text-[#F5F7FB]">
                {activeDraftStatus === 'quoted'
                  ? 'Precios y tasa guardados al copiar WhatsApp.'
                  : 'Puedes guardarlo y retomarlo luego.'}
              </div>
            </div>
            <Link
              href="/app/advisor/drafts"
              className="shrink-0 rounded-[14px] border border-[#2A3040] px-3 py-2 text-sm font-medium text-[#F5F7FB]"
            >
              Borradores
            </Link>
          </div>
        ) : null}
        {error ? <div className="rounded-[18px] border border-[#5E2229] bg-[#261114] px-4 py-3 text-sm text-[#F0A6AE]">{error}</div> : null}
        {info ? <div className="rounded-[18px] border border-[#1C5036] bg-[#0F2119] px-4 py-3 text-sm text-[#7CE0A9]">{info}</div> : null}

        <Section title="1. Cliente" subtitle="Busca primero y crea solo si no existe.">
          <Field label="Buscar cliente">
            <div className="flex gap-2">
              <input
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    (e.currentTarget as HTMLInputElement).blur();
                    void handleSearchClients();
                  }
                }}
                className={inputClass()}
                placeholder="Telefono o nombre"
              />
              <button
                type="button"
                onClick={() => void handleSearchClients()}
                disabled={searchingClient}
                className={[
                  'h-11 rounded-[16px] border px-3.5 text-sm font-medium transition active:scale-[0.98] disabled:cursor-not-allowed',
                  searchingClient
                    ? 'border-[#232632] bg-[#232632] text-[#6F7890]'
                    : 'border-[#232632] text-[#F5F7FB]',
                ].join(' ')}
              >
                {searchingClient ? 'Buscando...' : 'Buscar'}
              </button>
            </div>
          </Field>

          {selectedClient ? (
            <div className="rounded-[18px] border border-[#232632] bg-[#0F131B] px-3.5 py-3 text-sm text-[#F5F7FB]">
              <div className="font-medium">{selectedClient.full_name}</div>
              <div className="mt-1 text-xs text-[#8B93A7]">{selectedClient.phone || 'Sin telefono'}</div>
              <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                <div className="rounded-[14px] border border-[#232632] bg-[#12151d] px-3 py-2">
                  <div className="text-[#8B93A7]">Tipo</div>
                  <div className="mt-1 font-medium text-[#F5F7FB]">
                    {clientTypeLabel(selectedClient.client_type)}
                  </div>
                </div>
                <div className="rounded-[14px] border border-[#232632] bg-[#12151d] px-3 py-2">
                  <div className="text-[#8B93A7]">Fondo</div>
                  <div className="mt-1 font-medium text-[#F5F7FB]">
                    {selectedClientFundUsd > 0 ? formatUsd(selectedClientFundUsd) : 'Sin fondo'}
                  </div>
                </div>
              </div>
            </div>
          ) : null}

          {clientResults.length > 0 ? (
            <div className="space-y-2">
              {clientResults.map((client) => (
                <button
                  key={client.id}
                  type="button"
                  onClick={() => selectClient(client, `Cliente seleccionado: ${client.full_name}`)}
                  className="flex w-full items-center justify-between rounded-[18px] border border-[#232632] bg-[#0F131B] px-3.5 py-3 text-left"
                >
                  <div>
                    <div className="text-sm font-medium text-[#F5F7FB]">
                      {renderHighlightedText(client.full_name, searchTerm, `client-name-${client.id}`)}
                    </div>
                    <div className="mt-1 text-xs text-[#8B93A7]">
                      {renderHighlightedText(client.phone || 'Sin telefono', searchTerm, `client-phone-${client.id}`)}
                    </div>
                  </div>
                  <div className="text-xs text-[#AAB2C5]">Usar</div>
                </button>
              ))}
            </div>
          ) : null}

          <button
            type="button"
            onClick={() => {
              setIsNewClientMode((current) => !current);
              setSelectedClient(null);
            }}
            className="h-10 rounded-[14px] border border-[#232632] text-sm font-medium text-[#F5F7FB]"
          >
            {isNewClientMode ? 'Cancelar cliente nuevo' : 'Crear cliente nuevo'}
          </button>

          {isNewClientMode ? (
            <div className="grid gap-3 rounded-[18px] border border-[#232632] bg-[#0F131B] px-3.5 py-3">
              <Field label="Nombre">
                <input value={newClientName} onChange={(e) => setNewClientName(e.target.value)} className={inputClass()} placeholder="Nombre completo" />
              </Field>
              <Field label="Telefono">
                <input value={newClientPhone} onChange={(e) => setNewClientPhone(e.target.value)} className={inputClass()} placeholder="0412..." />
              </Field>
              <Field label="Canal">
                <select value={newClientType} onChange={(e) => setNewClientType(e.target.value as ClientType)} className={inputClass()}>
                  <option value="assigned">Asignado</option>
                  <option value="own">Propio</option>
                  <option value="legacy">Antiguo</option>
                </select>
              </Field>
              <button
                type="button"
                onClick={() => void handleCreateClientClick()}
                disabled={creatingClient}
                className={[
                  'h-10 rounded-[14px] text-sm font-semibold transition active:scale-[0.98] disabled:cursor-not-allowed',
                  creatingClient ? 'bg-[#232632] text-[#6F7890]' : 'bg-[#F0D000] text-[#17191E]',
                ].join(' ')}
              >
                {creatingClient ? 'Creando...' : 'Guardar cliente'}
              </button>
            </div>
          ) : null}
        </Section>

        <Section title="2. Pedido" subtitle="Misma logica base de master, compacta para telefono.">
          <div className="relative">
            <Field label="Producto">
              <input
                value={productSearch}
                aria-busy={productSearchIsPending}
                onChange={(e) => {
                  setProductSearch(e.target.value);
                  setProductActiveIndex(-1);
                  if (!e.target.value.trim()) setSelectedProductId('');
                }}
                onKeyDown={(e) => {
                  if (!productSearch.trim() || filteredProducts.length === 0) return;

                  if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    setProductActiveIndex((prev) => {
                      const next = prev < filteredProducts.length - 1 ? prev + 1 : 0;
                      setSelectedProductId(filteredProducts[next]?.id ?? '');
                      return next;
                    });
                    return;
                  }

                  if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    setProductActiveIndex((prev) => {
                      const next = prev > 0 ? prev - 1 : filteredProducts.length - 1;
                      setSelectedProductId(filteredProducts[next]?.id ?? '');
                      return next;
                    });
                    return;
                  }

                  if (e.key === 'Enter') {
                    e.preventDefault();
                    const selected =
                      productActiveIndex >= 0 ? filteredProducts[productActiveIndex] : filteredProducts[0];
                    if (!selected) return;
                    chooseProduct(selected);
                  }
                }}
                className={inputClass()}
                placeholder="Escribe nombre o codigo"
              />
            </Field>

            {productSearch.trim() && (!selectedProduct || productSearch !== selectedProduct.name) ? (
              <div className="absolute z-20 mt-2 max-h-[260px] w-full overflow-y-auto rounded-[18px] border border-[#232632] bg-[#0F131B]">
                {productSearchIsPending ? (
                  <div className="px-3 py-2 text-xs text-[#8B93A7]">Actualizando resultados...</div>
                ) : null}
                {filteredProducts.length === 0 && !productSearchIsPending ? (
                  <div className="px-3 py-3 text-sm text-[#8B93A7]">Sin resultados</div>
                ) : (
                  filteredProducts.map((product) => (
                    <button
                      key={product.id}
                      type="button"
                      onClick={() => chooseProduct(product)}
                      className={[
                        'w-full border-b border-[#191926] px-3 py-3 text-left last:border-b-0',
                        filteredProducts[productActiveIndex]?.id === product.id ? 'bg-[#121218]' : 'hover:bg-[#121218]',
                      ].join(' ')}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium text-[#F5F7FB]">
                            {renderHighlightedText(product.name, productSearch, `product-name-${product.id}`)}
                          </div>
                          <div className="mt-1 text-xs text-[#8B93A7]">
                            {renderHighlightedText(product.sku || 'Sin codigo', productSearch, `product-sku-${product.id}`)} | ${Number(product.base_price_usd ?? 0).toFixed(2)}
                          </div>
                        </div>
                        <div className="flex shrink-0 flex-wrap justify-end gap-1">
                          {favoriteProductIds.includes(product.id) ? (
                            <span className="rounded-full border border-[#564511] bg-[#2A2209] px-2 py-0.5 text-[10px] font-medium text-[#F7DA66]">
                              Favorito
                            </span>
                          ) : null}
                          {recentProductIds.includes(product.id) ? (
                            <span className="rounded-full border border-[#2A3040] bg-[#151925] px-2 py-0.5 text-[10px] font-medium text-[#CCD3E2]">
                              Reciente
                            </span>
                          ) : null}
                          {Number(productUsageById[String(product.id)] || 0) >= 3 ? (
                            <span className="rounded-full border border-[#1C5036] bg-[#0F2119] px-2 py-0.5 text-[10px] font-medium text-[#7CE0A9]">
                              Muy usado
                            </span>
                          ) : null}
                        </div>
                      </div>
                      <div className="mt-2 text-[10px] uppercase tracking-[0.18em] text-[#6F7890]">
                        Enter para elegir
                      </div>
                    </button>
                  ))
                )}
              </div>
            ) : null}
          </div>

          <div className="grid grid-cols-[1fr_156px] gap-2">
            <div className="rounded-[16px] border border-[#232632] bg-[#0F131B] px-3.5 py-3 text-sm text-[#F5F7FB]">
              {selectedProduct ? selectedProduct.name : 'Selecciona producto'}
            </div>
            <div className="grid grid-cols-[44px_minmax(52px,1fr)_44px] gap-2">
              <button
                type="button"
                onClick={() => {
                  const currentQty = parseQuantityValue(qty);
                  const baseQty = Number.isFinite(currentQty) && currentQty > 0 ? currentQty : 1;
                  updateQty(formatQuantityValue(Math.max(0.5, baseQty - 0.5)));
                }}
                className="h-11 rounded-[16px] border border-[#232632] bg-[#0F131B] text-base font-semibold text-[#F5F7FB]"
              >
                -
              </button>
              <input
                value={qty}
                onChange={(e) => updateQty(e.target.value)}
                onFocus={(e) => e.currentTarget.select()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addDraftItem();
                  }
                }}
                className="h-11 min-w-0 w-full rounded-[16px] border border-[#232632] bg-[#0F131B] px-0 text-center text-base font-semibold text-[#F5F7FB] placeholder:text-[#636C80]"
                inputMode="decimal"
                placeholder="0.50"
              />
              <button
                type="button"
                onClick={() => {
                  const currentQty = parseQuantityValue(qty);
                  const baseQty = Number.isFinite(currentQty) && currentQty > 0 ? currentQty : 0;
                  updateQty(formatQuantityValue(baseQty + 0.5));
                }}
                className="h-11 rounded-[16px] border border-[#232632] bg-[#0F131B] text-base font-semibold text-[#F5F7FB]"
              >
                +
              </button>
            </div>
          </div>

          {selectedProduct ? (
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => toggleFavoriteProduct(selectedProduct.id)}
                className={[
                  'inline-flex h-8 items-center rounded-full px-3 text-[11px] font-medium',
                  favoriteProductIds.includes(selectedProduct.id)
                    ? 'border border-[#564511] bg-[#2A2209] text-[#F7DA66]'
                    : 'border border-[#232632] bg-[#0F131B] text-[#AAB2C5]',
                ].join(' ')}
              >
                {favoriteProductIds.includes(selectedProduct.id) ? '★ Favorito' : '☆ Fav'}
              </button>
            </div>
          ) : null}

          <button
            type="button"
            onClick={addDraftItem}
            className={[
              'h-10 rounded-[14px] text-sm font-medium',
              itemJustAdded
                ? 'bg-[#163322] text-[#7CE0A9]'
                : selectedProduct
                  ? 'bg-[#F0D000] text-[#17191E]'
                  : 'border border-[#232632] text-[#F5F7FB]',
            ].join(' ')}
          >
            {itemJustAdded ? 'Item agregado' : 'Confirmar item'}
          </button>

          {draftItems.length === 0 ? (
            <div className="rounded-[18px] border border-dashed border-[#2A3040] bg-[#0F131B] px-4 py-4 text-sm text-[#AAB2C5]">
              Agrega al menos un producto para activar el pedido.
            </div>
          ) : (
            <div className="space-y-2">
              {advisorEditHasCatalogPriceDrift ? (
                <div className="rounded-[18px] border border-[#564511] bg-[#151208] px-3.5 py-3 text-sm text-[#F7DA66]">
                  <div className="font-semibold text-[#F5F7FB]">Recalculo requerido</div>
                  <div className="mt-1 text-xs leading-5 text-[#D8C36A]">
                    Hay precios del catalogo actualizados en este pedido. Recalcula antes de guardar para generar un snapshot nuevo.
                  </div>
                  <button
                    type="button"
                    onClick={handleRecalculateDraftPricesFromCatalog}
                    className="mt-3 h-9 rounded-[12px] bg-[#F0D000] px-3 text-xs font-semibold text-[#17191E]"
                  >
                    Recalcular precios
                  </button>
                </div>
              ) : null}

              {draftItems.map((item, idx) => {
                const snapshot = draftItemSnapshots[idx];
                const unitBs =
                  snapshot?.unitBs ??
                  (item.source_price_currency === 'VES'
                    ? Number(item.source_price_amount || 0)
                    : Number(item.unit_price_usd_snapshot || 0) * fxRateNumber);
                const lineBs =
                  snapshot?.lineBs ??
                  (item.source_price_currency === 'VES'
                    ? Number(item.source_price_amount || 0) * Number(item.qty || 0)
                    : Number(item.line_total_usd || 0) * fxRateNumber);

                return (
                <div key={item.localId} className="rounded-[18px] border border-[#232632] bg-[#0F131B] px-3.5 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-[#F5F7FB]">{item.product_name_snapshot}</div>
                      <div className="mt-1 text-xs text-[#8B93A7]">
                        {item.qty} x {formatBs(unitBs)}
                      </div>
                    </div>
                    <div className="text-sm font-medium text-[#F0D000]">{formatBs(lineBs)}</div>
                  </div>

                  {getVisibleDetailLines(item.editable_detail_lines).length > 0 ? (
                    <div className="mt-2 space-y-1 rounded-[14px] bg-[#0B0F15] px-3 py-2 text-xs text-[#AAB2C5]">
                      {getVisibleDetailLines(item.editable_detail_lines).map((line, index) => (
                        <div key={`${item.localId}-${index}`}>- {line}</div>
                      ))}
                    </div>
                  ) : null}

                  <div className="mt-3 flex gap-2">
                    {item.editable_detail_lines.length > 0 ? (
                      <button type="button" onClick={() => openEditConfig(item)} className="h-9 rounded-[12px] border border-[#232632] px-3 text-xs font-medium text-[#F5F7FB]">
                        Editar
                      </button>
                    ) : null}
                    <button type="button" onClick={() => removeDraftItem(item.localId)} className="h-9 rounded-[12px] border border-[#5E2229] px-3 text-xs font-medium text-[#F0A6AE]">
                      Quitar
                    </button>
                  </div>
                </div>
                );
              })}

              {fulfillment === 'delivery' && !hasDeliveryItem ? (
                <div className="rounded-[18px] border border-[#564511] bg-[#151208] px-3.5 py-3 text-sm text-[#F7DA66]">
                  Este pedido es delivery. Agrega tambien el item de delivery antes de copiar o crear la orden.
                </div>
              ) : null}

              <div className="grid gap-3 rounded-[18px] border border-[#232632] bg-[#0F131B] px-3.5 py-3">
                <div className="grid grid-cols-2 gap-3">
                  <Field
                    label={
                      advisorRecalculationMode
                        ? 'Tasa de recálculo (Bs/USD)'
                        : fxRateLockedForAdvisorEdit
                          ? 'Tasa snapshot (Bs/USD)'
                          : 'Tasa del dia (Bs/USD)'
                    }
                  >
                    <input
                      value={fxRate}
                      onChange={(e) => setFxRate(e.target.value)}
                      onFocus={(e) => e.currentTarget.select()}
                      disabled={fxRateLockedForAdvisorEdit}
                      className={`${inputClass()} disabled:cursor-not-allowed disabled:opacity-70`}
                      inputMode="decimal"
                      placeholder="0"
                    />
                    {fxRateLockedForAdvisorEdit ? (
                      <div className="mt-1 text-[11px] text-[#8B93A7]">
                        La correccion de esta tasa la hace master/admin.
                      </div>
                    ) : advisorRecalculationMode ? (
                      <div className="mt-1 text-[11px] text-[#8B93A7]">
                        Esta orden fue devuelta para recalcular; al guardar queda esta tasa como nuevo snapshot.
                      </div>
                    ) : null}
                  </Field>

                  <label className="flex items-end gap-3 rounded-[16px] border border-[#232632] bg-[#12151d] px-3.5 py-3 text-sm text-[#F5F7FB]">
                    <input
                      type="checkbox"
                      checked={discountEnabled}
                      onChange={(e) => {
                        setDiscountEnabled(e.target.checked);
                        if (!e.target.checked) setDiscountPct('0');
                      }}
                    />
                    <span>Aplicar descuento</span>
                  </label>
                </div>

                {discountEnabled ? (
                  <Field label="% Descuento">
                    <input
                      value={discountPct}
                      onChange={(e) => setDiscountPct(e.target.value)}
                      onFocus={(e) => e.currentTarget.select()}
                      className={inputClass()}
                      inputMode="decimal"
                      placeholder="0"
                    />
                  </Field>
                ) : null}

                <div className="grid gap-2 text-sm text-[#AAB2C5]">
                  <div className="flex items-center justify-between rounded-[14px] bg-[#12151d] px-3 py-2">
                    <span>Subtotal USD</span>
                    <span className="text-[#F5F7FB]">{formatUsd(draftTotalUsd)}</span>
                  </div>
                  <div className="flex items-center justify-between rounded-[14px] bg-[#12151d] px-3 py-2">
                    <span>Subtotal Bs</span>
                    <span className="text-[#F5F7FB]">{fxRateNumber > 0 ? formatBs(draftSubtotalBs) : 'Define la tasa'}</span>
                  </div>
                  {discountEnabled ? (
                    <>
                      <div className="flex items-center justify-between rounded-[14px] bg-[#12151d] px-3 py-2">
                        <span>Descuento USD</span>
                        <span className="text-[#F5F7FB]">-{formatUsd(discountAmountUsd)}</span>
                      </div>
                      <div className="flex items-center justify-between rounded-[14px] bg-[#12151d] px-3 py-2">
                        <span>Descuento Bs</span>
                        <span className="text-[#F5F7FB]">-{fxRateNumber > 0 ? formatBs(discountAmountBs) : 'Define la tasa'}</span>
                      </div>
                    </>
                  ) : null}
                  {hasInvoice ? (
                    <div className="flex items-center justify-between rounded-[14px] bg-[#12151d] px-3 py-2">
                      <span>IVA</span>
                      <span className="text-[#F5F7FB]">
                        {formatUsd(invoiceTaxAmountUsd)}
                        {fxRateNumber > 0 ? ` / ${formatBs(invoiceTaxAmountBs)}` : ''}
                      </span>
                    </div>
                  ) : null}
                  <div className="flex items-center justify-between rounded-[14px] bg-[#12151d] px-3 py-2">
                    <span>Total</span>
                    <span className="font-semibold text-[#F0D000]">
                      {formatUsd(finalTotalUsd)}
                      {fxRateNumber > 0 ? ` / ${formatBs(finalTotalBs)}` : ''}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          )}
        </Section>

        <Section title="3. Entrega" subtitle="Con soporte para fecha fija o lo antes posible.">
          <div className="grid grid-cols-2 gap-2">
            <button type="button" onClick={() => setFulfillment('pickup')} className={['h-10 rounded-[14px] border px-4 text-sm font-medium', fulfillment === 'pickup' ? 'border-[#F0D000] bg-[#201B08] text-[#F7DA66]' : 'border-[#232632] text-[#F5F7FB]'].join(' ')}>
              Retiro
            </button>
            <button type="button" onClick={() => setFulfillment('delivery')} className={['h-10 rounded-[14px] border px-4 text-sm font-medium', fulfillment === 'delivery' ? 'border-[#F0D000] bg-[#201B08] text-[#F7DA66]' : 'border-[#232632] text-[#F5F7FB]'].join(' ')}>
              Delivery
            </button>
          </div>

          <button
            type="button"
            onClick={() => {
              setIsAsap((current) => {
                const next = !current;
                if (next) {
                  setDeliveryDate(getTodayInputValue());
                  setDeliveryHour12(rounded.hour12);
                  setDeliveryMinute(rounded.minute);
                  setDeliveryAmPm(rounded.ampm);
                }
                return next;
              });
            }}
            className={[
              'h-10 rounded-[14px] border px-4 text-sm font-medium',
              isAsap ? 'border-[#F0D000] bg-[#201B08] text-[#F7DA66]' : 'border-[#232632] text-[#F5F7FB]',
            ].join(' ')}
          >
            Lo antes posible
          </button>

          <Field label="Fecha">
            <div className="min-w-0 overflow-hidden rounded-[16px]">
              <input
                type="date"
                value={deliveryDate}
                min={isEditingOrder ? undefined : getCaracasCurrentMinuteKey().slice(0, 10)}
                aria-invalid={advisorScheduleIsPast}
                onChange={(e) => {
                  setDeliveryDate(e.target.value);
                  setIsAsap(false);
                }}
                className={`${inputClass()} advisor-date-input min-w-0 max-w-full overflow-hidden [color-scheme:dark]`}
              />
            </div>
          </Field>

          <Field label="Hora">
            <div className="grid grid-cols-[72px_72px_minmax(92px,1fr)] gap-2">
              <input value={deliveryHour12} onChange={(e) => { setDeliveryHour12(e.target.value); setIsAsap(false); }} className={inputClass()} inputMode="numeric" />
              <input value={deliveryMinute} onChange={(e) => { setDeliveryMinute(e.target.value); setIsAsap(false); }} className={inputClass()} inputMode="numeric" />
              <select value={deliveryAmPm} onChange={(e) => { setDeliveryAmPm(e.target.value as 'AM' | 'PM'); setIsAsap(false); }} className={inputClass()}>
                <option value="AM">AM</option>
                <option value="PM">PM</option>
              </select>
            </div>
            {advisorScheduleIsPast ? (
              <p className="mt-2 text-xs text-[#FF7A45]" role="alert">
                La fecha y hora no pueden ser anteriores al momento actual.
              </p>
            ) : null}
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Recibe">
              <input value={receiverName} onChange={(e) => setReceiverName(e.target.value)} className={inputClass()} placeholder="Nombre" />
            </Field>
            <Field label="Telefono">
              <input value={receiverPhone} onChange={(e) => setReceiverPhone(e.target.value)} className={inputClass()} placeholder="Contacto" />
            </Field>
          </div>

          {fulfillment === 'delivery' ? (
            <>
              {quickAddresses.length > 0 ? (
                <div className="flex flex-wrap gap-2">
                  {quickAddresses.map((address, index) => (
                    <button
                      key={`${address.addressText}-${index}`}
                      type="button"
                      onClick={() => applyClientAddress(address)}
                      className={[
                        'max-w-full rounded-[14px] border px-3 py-2 text-left',
                        deliveryAddress.trim() === address.addressText.trim()
                          ? 'border-[#F0D000] bg-[#201B08] text-[#F7DA66]'
                          : 'border-[#232632] bg-[#0F131B] text-[#F5F7FB]',
                      ].join(' ')}
                    >
                      <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#8B93A7]">
                        {index === 0 ? 'Sugerida' : `Direccion ${index + 1}`}
                      </div>
                      <div className="mt-1 text-sm">{compactAddressLabel(address.addressText || 'Sin direccion')}</div>
                      {address.gpsUrl ? <div className="mt-1 text-[11px] text-[#8B93A7]">Con GPS</div> : null}
                    </button>
                  ))}
                </div>
              ) : null}
              <Field label="Direccion" hint="Solo este campo puede crecer mas cuando haga falta.">
                <textarea
                  value={deliveryAddress}
                  onChange={(e) => {
                    setDeliveryAddressTouched(true);
                    setDeliveryAddress(e.target.value);
                  }}
                  className={inputClass(true)}
                  placeholder="Direccion completa"
                />
              </Field>
              <Field label="GPS URL">
                <input
                  value={deliveryGpsUrl}
                  onChange={(e) => {
                    setDeliveryAddressTouched(true);
                    setDeliveryGpsUrl(e.target.value);
                  }}
                  className={inputClass()}
                  placeholder="Link de ubicacion"
                />
              </Field>
            </>
          ) : null}
        </Section>

        <Section title="4. Pago y notas" subtitle="Misma operacion base de master, sin ruido extra.">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Forma de pago">
              <select value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value as PaymentMethod)} className={inputClass()}>
                <option value="pending">Pendiente</option>
                <option value="payment_mobile">Pago móvil</option>
                <option value="transfer">Transferencia</option>
                <option value="cash_usd">Efectivo USD</option>
                <option value="cash_ves">Efectivo Bs</option>
                <option value="pos">Punto de venta</option>
                <option value="zelle">Zelle</option>
                <option value="wallet_usd">Wallet USD</option>
                <option value="mixed">Mixto</option>
              </select>
            </Field>
            <Field label="Moneda principal">
              <select value={paymentCurrency} onChange={(e) => setPaymentCurrency(e.target.value as CurrencyCode)} className={inputClass()} disabled={paymentMethod !== 'mixed'}>
                <option value="USD">USD</option>
                <option value="VES">Bs</option>
              </select>
            </Field>
          </div>

          <label className="flex items-center gap-3 rounded-[18px] border border-[#232632] bg-[#0F131B] px-3.5 py-3 text-sm text-[#F5F7FB]">
            <input type="checkbox" checked={paymentRequiresChange} onChange={(e) => setPaymentRequiresChange(e.target.checked)} />
            <span>Requiere cambio</span>
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className="flex items-center gap-3 rounded-[18px] border border-[#232632] bg-[#0F131B] px-3.5 py-3 text-sm text-[#F5F7FB]">
              <input
                type="checkbox"
                checked={hasDeliveryNote}
                onChange={(e) => {
                  setHasDeliveryNote(e.target.checked);
                  setDeliveryNotePanelOpen(e.target.checked);
                  if (!e.target.checked) {
                    setDeliveryNoteName('');
                    setDeliveryNoteDocumentId('');
                    setDeliveryNoteAddress('');
                    setDeliveryNotePhone('');
                  }
                }}
              />
              <span>Lleva nota de entrega</span>
            </label>

            <label className="flex items-center gap-3 rounded-[18px] border border-[#232632] bg-[#0F131B] px-3.5 py-3 text-sm text-[#F5F7FB]">
              <input
                type="checkbox"
                checked={hasInvoice}
                onChange={(e) => {
                  setHasInvoice(e.target.checked);
                  setInvoicePanelOpen(e.target.checked);
                  if (e.target.checked && !String(invoiceTaxPct || '').trim()) {
                    setInvoiceTaxPct('16');
                  }
                  if (!e.target.checked) {
                    setInvoiceCompanyName('');
                    setInvoiceTaxId('');
                    setInvoiceAddress('');
                    setInvoicePhone('');
                    setInvoiceTaxPct('16');
                  }
                }}
              />
              <span>Lleva factura</span>
            </label>
          </div>

          {paymentRequiresChange ? (
            <div className="grid grid-cols-2 gap-3">
              <Field label="Cambio para">
                <input value={paymentChangeFor} onChange={(e) => setPaymentChangeFor(e.target.value)} className={inputClass()} inputMode="decimal" placeholder="Monto" />
              </Field>
              <Field label="Moneda del cambio">
                <select value={paymentChangeCurrency} onChange={(e) => setPaymentChangeCurrency(e.target.value as CurrencyCode)} className={inputClass()}>
                  <option value="USD">USD</option>
                  <option value="VES">Bs</option>
                </select>
              </Field>
            </div>
          ) : null}

          {hasInvoice ? (
            <div className="grid gap-3 rounded-[18px] border border-[#232632] bg-[#0F131B] px-3.5 py-3">
              <button
                type="button"
                onClick={() => setInvoicePanelOpen((current) => !current)}
                className="flex items-center justify-between text-left"
              >
                <div>
                  <div className="text-sm font-medium text-[#F5F7FB]">Datos de factura</div>
                  <div className="mt-1 text-xs text-[#8B93A7]">
                    {invoiceCompanyName.trim() || invoiceTaxId.trim() ? 'Con datos cargados' : 'Toca para completar'}
                  </div>
                </div>
                <span className="text-xs text-[#AAB2C5]">{invoicePanelOpen ? 'Ocultar' : 'Abrir'}</span>
              </button>
              {invoicePanelOpen ? (
                <>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Nombre o razon social">
                  <input value={invoiceCompanyName} onChange={(e) => setInvoiceCompanyName(e.target.value)} className={inputClass()} />
                </Field>
                <Field label="RIF o documento">
                  <input value={invoiceTaxId} onChange={(e) => setInvoiceTaxId(e.target.value)} className={inputClass()} />
                </Field>
                <Field label="Telefono">
                  <input value={invoicePhone} onChange={(e) => setInvoicePhone(e.target.value)} className={inputClass()} />
                </Field>
                <Field label="% IVA">
                  <input
                    value={invoiceTaxPct}
                    onChange={(e) => setInvoiceTaxPct(e.target.value)}
                    onFocus={(e) => e.currentTarget.select()}
                    className={inputClass()}
                    inputMode="decimal"
                  />
                </Field>
              </div>
              <Field label="Direccion fiscal">
                <textarea value={invoiceAddress} onChange={(e) => setInvoiceAddress(e.target.value)} className={inputClass(true)} />
              </Field>
                </>
              ) : null}
            </div>
          ) : null}

          {hasDeliveryNote ? (
            <div className="grid gap-3 rounded-[18px] border border-[#232632] bg-[#0F131B] px-3.5 py-3">
              <button
                type="button"
                onClick={() => setDeliveryNotePanelOpen((current) => !current)}
                className="flex items-center justify-between text-left"
              >
                <div>
                  <div className="text-sm font-medium text-[#F5F7FB]">Datos de nota de entrega</div>
                  <div className="mt-1 text-xs text-[#8B93A7]">
                    {deliveryNoteName.trim() || deliveryNoteDocumentId.trim() ? 'Con datos cargados' : 'Toca para completar'}
                  </div>
                </div>
                <span className="text-xs text-[#AAB2C5]">{deliveryNotePanelOpen ? 'Ocultar' : 'Abrir'}</span>
              </button>
              {deliveryNotePanelOpen ? (
                <>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Nombre">
                  <input value={deliveryNoteName} onChange={(e) => setDeliveryNoteName(e.target.value)} className={inputClass()} />
                </Field>
                <Field label="Documento">
                  <input value={deliveryNoteDocumentId} onChange={(e) => setDeliveryNoteDocumentId(e.target.value)} className={inputClass()} />
                </Field>
                <Field label="Telefono">
                  <input value={deliveryNotePhone} onChange={(e) => setDeliveryNotePhone(e.target.value)} className={inputClass()} />
                </Field>
              </div>
              <Field label="Direccion">
                <textarea value={deliveryNoteAddress} onChange={(e) => setDeliveryNoteAddress(e.target.value)} className={inputClass(true)} />
              </Field>
                </>
              ) : null}
            </div>
          ) : null}

          {(hasInvoice || hasDeliveryNote) && selectedClient ? (
            <div className="rounded-[18px] border border-[#232632] bg-[#0F131B] px-3.5 py-3 text-sm text-[#AAB2C5]">
              {hasInvoice ? (
                <div>
                  <span className="text-[#F5F7FB]">Factura:</span>{' '}
                  {[invoiceCompanyName.trim(), invoiceTaxId.trim(), invoiceAddress.trim(), invoicePhone.trim()]
                    .filter(Boolean)
                    .join(' | ') || 'Sin datos'}
                </div>
              ) : null}
              {hasDeliveryNote ? (
                <div className={hasInvoice ? 'mt-2' : ''}>
                  <span className="text-[#F5F7FB]">Nota de entrega:</span>{' '}
                  {[
                    deliveryNoteName.trim(),
                    deliveryNoteDocumentId.trim(),
                    deliveryNoteAddress.trim(),
                    deliveryNotePhone.trim(),
                  ]
                    .filter(Boolean)
                    .join(' | ') || 'Sin datos'}
                </div>
              ) : null}
            </div>
          ) : null}

          <Field label="Nota de pago">
            <input value={paymentNote} onChange={(e) => setPaymentNote(e.target.value)} className={inputClass()} placeholder="Referencia o acuerdo" />
          </Field>

          <Field label="Observaciones del pedido">
            <textarea value={orderNote} onChange={(e) => setOrderNote(e.target.value)} className={inputClass(true)} placeholder="Notas operativas utiles" />
          </Field>
        </Section>

        <div className="fixed inset-x-0 bottom-0 z-20 border-t border-[#1A1D26] bg-[#090B10] px-3 pb-[calc(0.45rem+env(safe-area-inset-bottom))] pt-2 shadow-[0_-10px_24px_rgba(0,0,0,0.38)]">
          <div className="mx-auto flex max-w-screen-md items-center justify-between gap-2">
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2">
                <span className="text-[10px] uppercase tracking-[0.18em] text-[#8B93A7]">Total</span>
                <span className="text-base font-semibold leading-none text-[#F5F7FB]">{formatUsd(finalTotalUsd)}</span>
              </div>
              <div className="mt-1 truncate text-[11px] leading-tight text-[#8B93A7]">
                {fxRateNumber > 0 ? formatBs(finalTotalBs) : 'Falta tasa'} · {footerSummary}
              </div>
              <div className="truncate text-[10px] leading-tight text-[#6F7890]">{createReadyHint}</div>
            </div>
            <div className="grid shrink-0 grid-cols-2 gap-1.5 sm:flex sm:flex-wrap sm:justify-end">
              {!isEditingOrder ? (
                <button
                  type="button"
                  onClick={() => void saveCurrentDraft('draft')}
                  aria-busy={savingDraft}
                  data-busy={savingDraft ? 'true' : undefined}
                  disabled={savingDraft || copyingQuote || saving || !canSaveCurrentDraft()}
                  className={[
                    'h-9 rounded-[12px] border px-2.5 text-xs font-semibold transition active:scale-[0.98] disabled:cursor-not-allowed',
                    savingDraft || copyingQuote || saving || !canSaveCurrentDraft()
                      ? 'border-[#232632] text-[#6F7890]'
                      : 'border-[#2A3040] text-[#F5F7FB]',
                  ].join(' ')}
                >
                  {savingDraft ? 'Guardando...' : 'Guardar'}
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => void handleCopyQuote()}
                aria-busy={copyingQuote}
                data-busy={copyingQuote ? 'true' : undefined}
                disabled={copyingQuote || savingDraft || saving || draftItems.length === 0}
                className={[
                  'h-9 rounded-[12px] border px-2.5 text-xs font-semibold transition active:scale-[0.98] disabled:cursor-not-allowed',
                  copyingQuote || savingDraft || saving || draftItems.length === 0
                    ? 'border-[#232632] text-[#6F7890]'
                    : 'border-[#232632] text-[#F5F7FB]',
                ].join(' ')}
              >
                {copyingQuote ? 'Copiando...' : 'Presup. WS'}
              </button>
              <button
                type="submit"
                aria-busy={saving}
                data-busy={saving ? 'true' : undefined}
                disabled={saving || savingDraft || !createReady}
                className={[
                  'col-span-2 h-9 rounded-[12px] px-3 text-xs font-semibold transition active:scale-[0.98] disabled:cursor-not-allowed sm:col-span-1',
                  saving || savingDraft || !createReady ? 'bg-[#232632] text-[#6F7890]' : 'bg-[#F0D000] text-[#17191E]',
                ].join(' ')}
              >
                {saving ? 'Guardando...' : isEditingOrder ? 'Guardar' : 'Crear'}
              </button>
            </div>
          </div>
        </div>
      </form>

      <ConfigSheet
        open={configOpen}
        title={configProduct?.name || 'Configurar producto'}
        alias={configAlias}
        setAlias={setConfigAlias}
        totalSelected={configSelectedUnits}
        totalLimit={configTotalLimit}
        options={configOptions}
        selections={configSelections}
        onChangeQty={setConfigSelectionQty}
        onClose={resetConfig}
        onConfirm={confirmConfig}
        isEditing={!!configEditingLocalId}
      />
    </>
  );
}

