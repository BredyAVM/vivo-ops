import 'server-only';

import {
  getOrderMoneySnapshot,
  getOrderRoundingClosureSnapshot,
  roundOrderMoney,
} from '@/lib/orders/order-money';
import { formatOrderDisplayNumber } from '@/lib/orders/order-labels';
import type {
  CounterCashAccountSummary,
  CounterOrder,
  CounterOrderItem,
  CounterPaymentAccountOption,
  CounterQuickSaleProductComponent,
  CounterQuickSaleProductOption,
} from './CounterClient';

type CounterReadClient = {
  rpc: (
    functionName: string,
    parameters?: Record<string, unknown>
  ) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
};

type CounterReadOrderRow = {
  id: number | string;
  order_number: string | null;
  status: CounterOrder['status'];
  source: string | null;
  fulfillment: CounterOrder['fulfillment'];
  delivery_address: string | null;
  delivery_mode: string | null;
  external_reference: string | null;
  total_usd: number | string | null;
  total_bs_snapshot: number | string | null;
  notes: string | null;
  created_at: string;
  ready_at: string | null;
  extra_fields: {
    schedule?: {
      date?: string | null;
      time_12?: string | null;
      time_24?: string | null;
      asap?: boolean | null;
    } | null;
    payment?: {
      method?: string | null;
      currency?: string | null;
      requires_change?: boolean | null;
      change_for?: number | string | null;
      change_currency?: string | null;
      notes?: string | null;
      rounding_close?: {
        closed_balance_usd?: number | string | null;
      } | null;
      rounding_gain_close?: {
        closed_balance_usd?: number | string | null;
      } | null;
    } | null;
    counter?: {
      quick_sale?: boolean | null;
      scheduled_by_counter?: boolean | null;
    } | null;
    pricing?: {
      fx_rate?: number | string | null;
      total_usd?: number | string | null;
      total_bs?: number | string | null;
      rounding_closed_usd?: number | string | null;
      rounding_gain_closed_usd?: number | string | null;
    } | null;
  } | null;
  client_name: string | null;
  client_phone: string | null;
  advisor_name: string | null;
  delivery_assignee_kind: 'internal' | 'external' | null;
  delivery_assignee_name: string | null;
  confirmed_paid_usd: number | string | null;
  pending_usd: number | string | null;
  pending_reports_count: number | string | null;
  confirmed_reports_count: number | string | null;
  rejected_reports_count: number | string | null;
  items?: CounterOrderItem[] | null;
};

export type CounterConfigurationRead = {
  fullName: string;
  activeBsRate: number;
  paymentAccounts: CounterPaymentAccountOption[];
};

export type CounterCatalogRead = {
  products: CounterQuickSaleProductOption[];
  components: CounterQuickSaleProductComponent[];
};

export type CounterPendingSettlementRead = {
  id: number;
  orderId: number;
  displayNumber: string;
  orderNumber: string | null;
  status: 'open' | 'partial' | 'discrepancy';
  fulfillment: 'delivery';
  clientName: string;
  clientPhone: string | null;
  responsibleName: string;
  dispatchedAt: string;
  expectedCollectionUsd: number;
  customerCollectionUsd: number;
  cashChangeOutstandingUsd: number;
  cashReturnedUsd: number;
  digitalChangeOutstandingUsd: number;
  version: number;
};

export type CounterPendingSettlementCursor = {
  dispatchedAt: string;
  id: number;
};

export type CounterPendingSettlementPage = {
  results: CounterPendingSettlementRead[];
  nextCursor: CounterPendingSettlementCursor | null;
};

function toNumber(value: unknown, fallback = 0) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : fallback;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

async function readRpcJson(
  supabase: CounterReadClient,
  functionName: string,
  parameters?: Record<string, unknown>
) {
  const { data, error } = await supabase.rpc(functionName, parameters);
  if (error) throw new Error(error.message);
  return data;
}

function mapCounterOrder(row: CounterReadOrderRow): CounterOrder {
  const moneySnapshot = getOrderMoneySnapshot(row);
  const roundingClosure = getOrderRoundingClosureSnapshot(row);
  const confirmedPaidUsd = roundOrderMoney(row.confirmed_paid_usd);
  const pendingUsd = roundOrderMoney(row.pending_usd);
  const orderId = Math.trunc(toNumber(row.id, 0));
  const schedule = row.extra_fields?.schedule;
  const payment = row.extra_fields?.payment;

  return {
    id: orderId,
    orderNumber: row.order_number || String(orderId),
    displayNumber: formatOrderDisplayNumber(orderId),
    status: row.status,
    source: row.source || null,
    isCounterSale: row.source === 'walk_in' || Boolean(row.extra_fields?.counter?.quick_sale),
    isCounterScheduled: Boolean(row.extra_fields?.counter?.scheduled_by_counter),
    fulfillment: row.fulfillment,
    clientName: row.client_name?.trim() || 'Cliente',
    clientPhone: row.client_phone || null,
    advisorName: row.advisor_name?.trim() || null,
    deliveryAddress: row.delivery_address || null,
    deliveryMode: row.delivery_mode || null,
    deliveryAssigneeKind: row.delivery_assignee_kind || null,
    deliveryAssigneeName: row.delivery_assignee_name?.trim() || null,
    externalReference: row.external_reference || null,
    notes: row.notes || null,
    createdAt: row.created_at,
    readyAt: row.ready_at || null,
    scheduledDate: schedule?.date || null,
    scheduledTime: schedule?.asap
      ? 'Lo antes posible'
      : schedule?.time_12 || schedule?.time_24 || null,
    paymentMethod: payment?.method || 'pending',
    paymentCurrency: payment?.currency || null,
    paymentRequiresChange: Boolean(payment?.requires_change),
    paymentChangeFor: payment?.change_for == null ? null : String(payment.change_for),
    paymentChangeCurrency: payment?.change_currency || null,
    paymentNote: payment?.notes || null,
    totalUsd: moneySnapshot.totalUsd,
    totalBs: moneySnapshot.totalBs,
    fxRate: moneySnapshot.fxRate,
    confirmedPaidUsd,
    balanceUsd: roundingClosure.isClosed ? 0 : pendingUsd,
    reports: {
      pending: Math.max(0, Math.trunc(toNumber(row.pending_reports_count, 0))),
      confirmed: Math.max(0, Math.trunc(toNumber(row.confirmed_reports_count, 0))),
      rejected: Math.max(0, Math.trunc(toNumber(row.rejected_reports_count, 0))),
    },
    items: asArray(row.items).map((itemValue) => {
      const item = asRecord(itemValue);
      return {
        id: Math.trunc(toNumber(item.id, 0)),
        qty: toNumber(item.qty, 0),
        name: String(item.name || 'Producto'),
        lineTotalUsd: roundOrderMoney(item.lineTotalUsd),
        lineTotalBs: roundOrderMoney(item.lineTotalBs),
        notes: item.notes == null ? null : String(item.notes),
      };
    }),
    detailLoaded: Array.isArray(row.items),
  };
}

export async function loadCounterConfigurationRead(
  supabase: CounterReadClient
): Promise<CounterConfigurationRead> {
  const data = asRecord(await readRpcJson(supabase, 'counter_read_configuration'));
  const paymentAccounts = asArray(data.paymentAccounts).map((accountValue) => {
    const account = asRecord(accountValue);
    return {
      accountId: Math.trunc(toNumber(account.accountId, 0)),
      accountName: String(account.accountName || 'Cuenta'),
      accountKind: String(account.accountKind || 'other'),
      currencyCode: account.currencyCode === 'VES' ? 'VES' as const : 'USD' as const,
      paymentMethodCode: String(account.paymentMethodCode || 'pending'),
      canReportPayment: Boolean(account.canReportPayment),
      canConfirmPayment: Boolean(account.canConfirmPayment),
      autoConfirmsReport: Boolean(account.autoConfirmsReport),
      reviewRequired: Boolean(account.reviewRequired),
    };
  }).filter((account) => account.accountId > 0);

  return {
    fullName: String(data.fullName || 'Mostrador'),
    activeBsRate: toNumber(data.activeBsRate, 0),
    paymentAccounts,
  };
}

export async function loadCounterActiveQueueRead(
  supabase: CounterReadClient
): Promise<CounterOrder[]> {
  const data = await readRpcJson(supabase, 'counter_read_active_queue', {
    p_limit: 120,
  });
  return asArray(data)
    .map((row) => mapCounterOrder(asRecord(row) as unknown as CounterReadOrderRow))
    .filter((order) => order.id > 0);
}

export async function loadCounterOrderDetailRead(
  supabase: CounterReadClient,
  orderId: number
): Promise<CounterOrder> {
  const data = await readRpcJson(supabase, 'counter_read_order_detail', {
    p_order_id: orderId,
  });
  return mapCounterOrder(asRecord(data) as unknown as CounterReadOrderRow);
}

export async function loadCounterCatalogRead(
  supabase: CounterReadClient
): Promise<CounterCatalogRead> {
  const data = asRecord(await readRpcJson(supabase, 'counter_read_catalog'));

  const products: CounterQuickSaleProductOption[] = asArray(data.products)
    .map((productValue) => {
      const product = asRecord(productValue);
      return {
        id: Math.trunc(toNumber(product.id, 0)),
        sku: product.sku == null ? null : String(product.sku),
        name: String(product.name || 'Producto'),
        type: product.type == null ? null : String(product.type),
        sourcePriceCurrency: product.sourcePriceCurrency === 'VES' ? 'VES' as const : 'USD' as const,
        sourcePriceAmount: toNumber(product.sourcePriceAmount, 0),
        basePriceUsd: toNumber(product.basePriceUsd, 0),
        basePriceBs: toNumber(product.basePriceBs, 0),
        unitsPerService: toNumber(product.unitsPerService, 0),
        isDetailEditable: Boolean(product.isDetailEditable),
        detailUnitsLimit: toNumber(product.detailUnitsLimit, 0),
        isComboComponentSelectable: Boolean(product.isComboComponentSelectable),
      };
    })
    .filter((product) => product.id > 0);

  const components: CounterQuickSaleProductComponent[] = asArray(data.components)
    .map((componentValue) => {
      const component = asRecord(componentValue);
      return {
        id: Math.trunc(toNumber(component.id, 0)),
        parentProductId: Math.trunc(toNumber(component.parentProductId, 0)),
        componentProductId: Math.trunc(toNumber(component.componentProductId, 0)),
        componentMode: component.componentMode === 'selectable' ? 'selectable' as const : 'fixed' as const,
        quantity: toNumber(component.quantity, 0),
        countsTowardDetailLimit: Boolean(component.countsTowardDetailLimit),
        isRequired: Boolean(component.isRequired),
        sortOrder: toNumber(component.sortOrder, 0),
        notes: component.notes == null ? null : String(component.notes),
        parentSku: component.parentSku == null ? null : String(component.parentSku),
        parentName: component.parentName == null ? null : String(component.parentName),
        componentSku: component.componentSku == null ? null : String(component.componentSku),
        componentName: String(component.componentName || 'Componente'),
        componentType: component.componentType == null ? null : String(component.componentType),
      };
    })
    .filter((component) => component.id > 0 && component.parentProductId > 0);

  return { products, components };
}

export async function loadCounterCashSnapshotRead(
  supabase: CounterReadClient
): Promise<CounterCashAccountSummary[]> {
  const data = await readRpcJson(supabase, 'counter_read_cash_snapshot', {
    p_movement_limit: 12,
  });

  return asArray(data)
    .map((accountValue) => {
      const account = asRecord(accountValue);
      const movements = asArray(account.movements).map((movementValue) => {
        const movement = asRecord(movementValue);
        return {
          id: Math.trunc(toNumber(movement.id, 0)),
          movementDate: String(movement.movementDate || ''),
          createdAt: movement.createdAt == null ? null : String(movement.createdAt),
          direction: movement.direction === 'outflow' ? 'outflow' as const : 'inflow' as const,
          movementType: String(movement.movementType || 'other'),
          amount: roundOrderMoney(movement.amount),
          amountUsdEquivalent: roundOrderMoney(movement.amountUsdEquivalent),
          currencyCode: movement.currencyCode === 'VES' ? 'VES' as const : 'USD' as const,
          referenceCode: movement.referenceCode == null ? null : String(movement.referenceCode),
          counterpartyName: movement.counterpartyName == null ? null : String(movement.counterpartyName),
          description: movement.description == null ? null : String(movement.description),
          orderId: movement.orderId == null ? null : Math.trunc(toNumber(movement.orderId, 0)),
          createdByName: movement.createdByName == null ? null : String(movement.createdByName),
        };
      });

      return {
        accountId: Math.trunc(toNumber(account.accountId, 0)),
        accountName: String(account.accountName || 'Cuenta'),
        accountKind: String(account.accountKind || 'other'),
        currencyCode: account.currencyCode === 'VES' ? 'VES' as const : 'USD' as const,
        methods: asArray(account.methods).map((method) => String(method)),
        inflow: roundOrderMoney(account.inflow),
        outflow: roundOrderMoney(account.outflow),
        net: roundOrderMoney(account.net),
        balance: roundOrderMoney(account.balance),
        movements,
      };
    })
    .filter((account) => account.accountId > 0);
}

export async function loadCounterPendingSettlementsRead(
  supabase: CounterReadClient,
  cursor: CounterPendingSettlementCursor | null = null
): Promise<CounterPendingSettlementPage> {
  const data = asRecord(await readRpcJson(supabase, 'counter_read_pending_settlements', {
    p_cursor_dispatched_at: cursor?.dispatchedAt || null,
    p_cursor_id: cursor?.id || null,
    p_limit: 25,
  }));

  const results: CounterPendingSettlementRead[] = asArray(data.results).map((value) => {
    const settlement = asRecord(value);
    const status = settlement.status === 'partial'
      ? 'partial' as const
      : settlement.status === 'discrepancy'
        ? 'discrepancy' as const
        : 'open' as const;

    return {
      id: Math.trunc(toNumber(settlement.id, 0)),
      orderId: Math.trunc(toNumber(settlement.orderId, 0)),
      displayNumber: String(settlement.displayNumber || ''),
      orderNumber: settlement.orderNumber == null ? null : String(settlement.orderNumber),
      status,
      fulfillment: 'delivery' as const,
      clientName: String(settlement.clientName || 'Cliente'),
      clientPhone: settlement.clientPhone == null ? null : String(settlement.clientPhone),
      responsibleName: String(settlement.responsibleName || 'Motorizado'),
      dispatchedAt: String(settlement.dispatchedAt || ''),
      expectedCollectionUsd: roundOrderMoney(settlement.expectedCollectionUsd),
      customerCollectionUsd: roundOrderMoney(settlement.customerCollectionUsd),
      cashChangeOutstandingUsd: roundOrderMoney(settlement.cashChangeOutstandingUsd),
      cashReturnedUsd: roundOrderMoney(settlement.cashReturnedUsd),
      digitalChangeOutstandingUsd: roundOrderMoney(settlement.digitalChangeOutstandingUsd),
      version: Math.max(1, Math.trunc(toNumber(settlement.version, 1))),
    };
  }).filter((settlement) => settlement.id > 0 && settlement.orderId > 0);

  const rawCursor = asRecord(data.nextCursor);
  const nextCursor =
    typeof rawCursor.dispatchedAt === 'string' &&
    Number.isFinite(Number(rawCursor.id)) &&
    Number(rawCursor.id) > 0
      ? {
          dispatchedAt: rawCursor.dispatchedAt,
          id: Number(rawCursor.id),
        }
      : null;

  return { results, nextCursor };
}
