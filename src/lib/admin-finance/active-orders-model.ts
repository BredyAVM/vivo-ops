import { addDateKeyDays } from './period';

export const ACTIVE_ORDERS_VERSION = 'admin-finance-active-orders-v1' as const;
export const ACTIVE_ORDER_STATUSES = ['queued', 'confirmed', 'in_kitchen', 'ready', 'out_for_delivery'] as const;
export const ACTIVE_ORDER_WINDOWS = ['all', 'past', 'today', 'next7', 'later', 'unscheduled'] as const;
export type ActiveOrderWindow = typeof ACTIVE_ORDER_WINDOWS[number];
export type ActiveOrder = {
  id: number; orderNumber: string; clientName: string; advisorName: string;
  status: typeof ACTIVE_ORDER_STATUSES[number]; fulfillment: 'pickup' | 'delivery';
  needsReview: boolean; scheduledDate: string | null; scheduledTime: string | null;
  totalUsd: number; coveredUsd: number; pendingUsd: number;
  pendingReportsUsd: number; pendingReportsCount: number;
  qualityCode: 'Q1_exact' | 'Q3_incomplete';
};
export type ActiveOrdersSummary = {
  orders: number; totalUsd: number; coveredUsd: number; pendingUsd: number;
  pendingReportsUsd: number; pendingReportsCount: number; reviewOrders: number; unscheduledOrders: number;
};
export type ActiveOrdersOverview = {
  definitionVersion: typeof ACTIVE_ORDERS_VERSION; asOf: string; asOfDate: string;
  cutoffMode: 'current_statement'; balanceSource: 'canonical_order_financial_state';
  timeAxis: 'scheduled_date'; currency: 'USD'; summary: ActiveOrdersSummary; orders: ActiveOrder[];
};
export type ActiveOrdersFilters = {
  window: ActiveOrderWindow; q: string;
  payment: 'all' | 'pending' | 'covered' | 'review'; page: number;
};

export function normalizeActiveOrdersFilters(values: Record<string, string | string[] | undefined>): ActiveOrdersFilters {
  const first = (key: string) => Array.isArray(values[key]) ? values[key][0] : values[key];
  const window = first('agenda') as ActiveOrderWindow;
  const payment = first('pago');
  const page = Number(first('page'));
  return {
    window: ACTIVE_ORDER_WINDOWS.includes(window) ? window : 'all',
    q: (first('q') ?? '').trim().slice(0, 80),
    payment: payment === 'pending' || payment === 'covered' || payment === 'review' ? payment : 'all',
    page: Number.isSafeInteger(page) && page > 0 ? page : 1,
  };
}

export function activeOrderWindow(date: string | null, today: string): Exclude<ActiveOrderWindow, 'all'> {
  if (date === null) return 'unscheduled';
  if (date < today) return 'past';
  if (date === today) return 'today';
  // The next seven dates exclude today; buckets never overlap.
  return date <= addDateKeyDays(today, 7) ? 'next7' : 'later';
}

export function summarizeActiveOrders(orders: ActiveOrder[]): ActiveOrdersSummary {
  return orders.reduce((sum, order) => ({
    orders: sum.orders + 1,
    totalUsd: sum.totalUsd + order.totalUsd,
    coveredUsd: sum.coveredUsd + order.coveredUsd,
    pendingUsd: sum.pendingUsd + order.pendingUsd,
    pendingReportsUsd: sum.pendingReportsUsd + order.pendingReportsUsd,
    pendingReportsCount: sum.pendingReportsCount + order.pendingReportsCount,
    reviewOrders: sum.reviewOrders + Number(order.needsReview),
    unscheduledOrders: sum.unscheduledOrders + Number(order.scheduledDate === null),
  }), { orders: 0, totalUsd: 0, coveredUsd: 0, pendingUsd: 0, pendingReportsUsd: 0,
    pendingReportsCount: 0, reviewOrders: 0, unscheduledOrders: 0 });
}

export function filterActiveOrders(overview: ActiveOrdersOverview, filters: ActiveOrdersFilters) {
  const q = filters.q.toLocaleLowerCase('es');
  const filtered = overview.orders.filter(order => {
    if (filters.window !== 'all' && activeOrderWindow(order.scheduledDate, overview.asOfDate) !== filters.window) return false;
    if (filters.payment === 'pending' && order.pendingUsd <= 0) return false;
    if (filters.payment === 'covered' && order.pendingUsd > 0) return false;
    if (filters.payment === 'review' && order.pendingReportsCount === 0) return false;
    return !q || [String(order.id), order.orderNumber, order.clientName, order.advisorName]
      .some(value => value.toLocaleLowerCase('es').includes(q));
  });
  const summary = summarizeActiveOrders(filtered);
  const pages = Math.max(1, Math.ceil(filtered.length / 30));
  const page = Math.min(filters.page, pages);
  return { summary, pages, page, orders: filtered.slice((page - 1) * 30, page * 30) };
}
