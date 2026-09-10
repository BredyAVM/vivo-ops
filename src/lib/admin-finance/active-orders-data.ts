import 'server-only';
import {
  ACTIVE_ORDERS_VERSION, ACTIVE_ORDER_STATUSES, summarizeActiveOrders,
  type ActiveOrder, type ActiveOrdersOverview, type ActiveOrdersSummary,
} from './active-orders-model';
import { getCaracasDateKey } from './period';

export type ActiveOrdersRpcClient = {
  rpc: (name: string, params: Record<string, unknown>) => Promise<{ data: unknown; error: { message?: string } | null }>;
};
type Json = Record<string, unknown>;
function object(value: unknown): Json {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid active orders object');
  return value as Json;
}
function string(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Missing active orders string');
  return value;
}
function number(value: unknown, integer = false): number {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) throw new Error('Missing active orders number');
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || (integer && !Number.isSafeInteger(parsed))) throw new Error('Invalid active orders number');
  return parsed;
}
function date(value: unknown): string {
  const key = string(value);
  const parsed = new Date(`${key}T12:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key) || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== key) {
    throw new Error('Invalid active orders date');
  }
  return key;
}
function near(left: number, right: number) {
  // Binary conversion tolerance only: never silently accept a one-cent difference.
  return Math.abs(left - right) < 0.000001;
}
function parseOrder(value: unknown): ActiveOrder {
  const row = object(value);
  const status = row.status as ActiveOrder['status'];
  if (!ACTIVE_ORDER_STATUSES.includes(status) || (row.fulfillment !== 'delivery' && row.fulfillment !== 'pickup')
    || typeof row.needsReview !== 'boolean' || (row.qualityCode !== 'Q1_exact' && row.qualityCode !== 'Q3_incomplete')) {
    throw new Error('Invalid active order contract');
  }
  const result: ActiveOrder = {
    id: number(row.id, true), orderNumber: string(row.orderNumber), clientName: string(row.clientName), advisorName: string(row.advisorName),
    status, fulfillment: row.fulfillment, needsReview: row.needsReview,
    scheduledDate: row.scheduledDate === null ? null : date(row.scheduledDate),
    scheduledTime: row.scheduledTime === null ? null : string(row.scheduledTime),
    totalUsd: number(row.totalUsd), coveredUsd: number(row.coveredUsd), pendingUsd: number(row.pendingUsd),
    pendingReportsUsd: number(row.pendingReportsUsd), pendingReportsCount: number(row.pendingReportsCount, true),
    qualityCode: row.qualityCode,
  };
  if (!result.id || (result.scheduledTime !== null && !/^([01]\d|2[0-3]):[0-5]\d$/.test(result.scheduledTime))
    || !near(result.coveredUsd, Math.max(0, Math.min(result.totalUsd, result.totalUsd - result.pendingUsd)))) {
    throw new Error('Inconsistent active order');
  }
  const incomplete = result.scheduledDate === null || result.needsReview || result.pendingUsd > result.totalUsd;
  if (result.qualityCode !== (incomplete ? 'Q3_incomplete' : 'Q1_exact')) throw new Error('Invalid active order quality');
  return result;
}

export function parseActiveOrdersOverview(value: unknown, requestedAt: Date): ActiveOrdersOverview {
  const data = object(value);
  if (data.definitionVersion !== ACTIVE_ORDERS_VERSION || data.cutoffMode !== 'current_statement'
    || data.balanceSource !== 'canonical_order_financial_state' || data.timeAxis !== 'scheduled_date' || data.currency !== 'USD') {
    throw new Error('Incompatible active orders contract');
  }
  const asOf = string(data.asOf);
  const cutoff = new Date(asOf);
  if (!Number.isFinite(cutoff.getTime()) || !Number.isFinite(requestedAt.getTime())
    || Math.abs(cutoff.getTime() - requestedAt.getTime()) > 300_000) throw new Error('Stale active orders snapshot');
  const asOfDate = date(data.asOfDate);
  if (asOfDate !== getCaracasDateKey(cutoff)) throw new Error('Wrong active orders timezone');
  if (!Array.isArray(data.orders)) throw new Error('Missing active orders');
  const orders = data.orders.map(parseOrder);
  if (new Set(orders.map(row => row.id)).size !== orders.length) throw new Error('Duplicate active orders');
  const rawSummary = object(data.summary);
  const summary = summarizeActiveOrders(orders);
  for (const key of Object.keys(summary) as Array<keyof ActiveOrdersSummary>) {
    const actual = number(rawSummary[key], !key.endsWith('Usd'));
    if (!near(actual, summary[key])) throw new Error(`Active orders do not reconcile: ${key}`);
    summary[key] = actual;
  }
  return { definitionVersion: ACTIVE_ORDERS_VERSION, asOf, asOfDate,
    cutoffMode: 'current_statement', balanceSource: 'canonical_order_financial_state',
    timeAxis: 'scheduled_date', currency: 'USD', summary, orders };
}

export async function loadActiveOrdersOverview(input: { supabase: ActiveOrdersRpcClient; asOf?: Date }): Promise<
  { status: 'ready'; data: ActiveOrdersOverview } | { status: 'error'; message: string }
> {
  const requestedAt = input.asOf ?? new Date();
  try {
    const response = await input.supabase.rpc('admin_finance_active_orders_v1', {});
    if (response.error) throw new Error(response.error.message || 'Active orders query failed');
    return { status: 'ready', data: parseActiveOrdersOverview(response.data, requestedAt) };
  } catch (error) {
    console.warn('admin active orders unavailable', error instanceof Error ? error.message : 'unknown error');
    return { status: 'error', message: 'No pudimos cargar los pedidos. Ningún dato financiero fue modificado.' };
  }
}
