import { unstable_noStore as noStore } from 'next/cache';
import { redirect } from 'next/navigation';
import { getAuthContext, isMasterOrAdminRole, resolveHomePath } from '@/lib/auth';
import { formatOrderDisplayNumber } from '@/lib/orders/order-labels';
import {
  getOrderMoneySnapshot,
  getOrderRoundingClosureSnapshot,
  roundOrderMoney,
  toOrderMoneyNumber,
} from '@/lib/orders/order-money';
import CounterClient, {
  type CounterPaymentAccountOption,
  type CounterOrder,
  type CounterOrderItem,
} from './CounterClient';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

type RawCounterOrder = {
  id: number;
  order_number: string | null;
  status: 'ready' | 'out_for_delivery';
  fulfillment: 'pickup' | 'delivery';
  delivery_address: string | null;
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
      client_fund_used_usd?: number | string | null;
      rounding_close?: {
        closed_balance_usd?: number | string | null;
      } | null;
      rounding_gain_close?: {
        closed_balance_usd?: number | string | null;
      } | null;
    } | null;
    pricing?: {
      fx_rate?: number | string | null;
      total_usd?: number | string | null;
      total_bs?: number | string | null;
      rounding_closed_usd?: number | string | null;
      rounding_gain_closed_usd?: number | string | null;
    } | null;
  } | null;
  client:
    | { full_name: string | null; phone: string | null }[]
    | { full_name: string | null; phone: string | null }
    | null;
};

type RawCounterItem = {
  id: number;
  order_id: number;
  qty: number | string | null;
  product_name_snapshot: string | null;
  line_total_usd: number | string | null;
  line_total_bs_snapshot: number | string | null;
  notes: string | null;
};

type RawMoneyMovement = {
  order_id: number | null;
  direction: 'inflow' | 'outflow' | string | null;
  status: string | null;
  amount_usd_equivalent: number | string | null;
};

type RawPaymentReport = {
  order_id: number | null;
  status: string | null;
};

type RawMoneyAccount = {
  id: number;
  name: string | null;
  currency_code: 'USD' | 'VES' | string | null;
  account_kind: string | null;
  is_active: boolean | null;
};

type RawPaymentRule = {
  money_account_id: number;
  role: string;
  payment_method_code: string | null;
  can_report_payment: boolean | null;
  can_confirm_payment: boolean | null;
  auto_confirms_report: boolean | null;
  review_required: boolean | null;
  is_active: boolean | null;
};

function normalizeClient(order: RawCounterOrder) {
  return Array.isArray(order.client) ? order.client[0] ?? null : order.client;
}

function toNumber(value: unknown, fallback = 0) {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : fallback;
}

function getScheduleTime(order: RawCounterOrder) {
  const schedule = order.extra_fields?.schedule;
  if (schedule?.asap) return 'Lo antes posible';
  return schedule?.time_12 || schedule?.time_24 || null;
}

function getConfirmedSignedUsd(movements: RawMoneyMovement[]) {
  return roundOrderMoney(
    movements.reduce((sum, movement) => {
      if (movement.status !== 'confirmed') return sum;
      const sign = movement.direction === 'outflow' ? -1 : 1;
      return sum + sign * toOrderMoneyNumber(movement.amount_usd_equivalent, 0);
    }, 0)
  );
}

export default async function CounterPage() {
  noStore();

  const ctx = await getAuthContext();

  if (!ctx) {
    redirect('/login');
  }

  const canAccessCounter = isMasterOrAdminRole(ctx.roles) || ctx.roles.includes('counter');
  if (!canAccessCounter) {
    redirect(resolveHomePath(ctx.roles));
  }

  const [
    { data: profile },
    { data: ordersData, error: ordersError },
    { data: accountsData, error: accountsError },
    { data: rulesData, error: rulesError },
  ] = await Promise.all([
    ctx.supabase.from('profiles').select('full_name').eq('id', ctx.user.id).maybeSingle(),
    ctx.supabase
      .from('orders')
      .select(
        [
          'id',
          'order_number',
          'status',
          'fulfillment',
          'delivery_address',
          'total_usd',
          'total_bs_snapshot',
          'notes',
          'created_at',
          'ready_at',
          'extra_fields',
          'client:clients(full_name, phone)',
        ].join(', ')
      )
      .in('status', ['ready', 'out_for_delivery'])
      .order('ready_at', { ascending: true, nullsFirst: false })
      .order('created_at', { ascending: true })
      .limit(120),
    ctx.supabase
      .from('money_accounts')
      .select('id, name, currency_code, account_kind, is_active')
      .eq('is_active', true)
      .order('id', { ascending: true }),
    ctx.supabase
      .from('money_account_payment_rules')
      .select(
        [
          'money_account_id',
          'role',
          'payment_method_code',
          'can_report_payment',
          'can_confirm_payment',
          'auto_confirms_report',
          'review_required',
          'is_active',
        ].join(', ')
      )
      .eq('role', 'counter')
      .eq('is_active', true)
      .or('can_report_payment.eq.true,can_confirm_payment.eq.true,auto_confirms_report.eq.true')
      .order('money_account_id', { ascending: true })
      .order('payment_method_code', { ascending: true }),
  ]);

  if (ordersError) {
    throw new Error(ordersError.message);
  }
  if (accountsError) {
    throw new Error(accountsError.message);
  }
  if (rulesError) {
    throw new Error(rulesError.message);
  }

  const rawOrders = (ordersData ?? []) as unknown as RawCounterOrder[];
  const orderIds = rawOrders.map((order) => order.id);
  const accountsById = new Map<number, RawMoneyAccount>();
  for (const account of (accountsData ?? []) as unknown as RawMoneyAccount[]) {
    if (account.is_active) accountsById.set(account.id, account);
  }

  const paymentAccounts: CounterPaymentAccountOption[] = [];
  for (const rule of (rulesData ?? []) as unknown as RawPaymentRule[]) {
    if (
      !rule.is_active ||
      rule.role !== 'counter' ||
      (!rule.can_report_payment && !rule.can_confirm_payment && !rule.auto_confirms_report)
    ) {
      continue;
    }
    const account = accountsById.get(rule.money_account_id);
    if (!account || !account.is_active || !rule.payment_method_code) continue;
    const currencyCode = String(account.currency_code || '').toUpperCase();
    if (currencyCode !== 'USD' && currencyCode !== 'VES') continue;

    paymentAccounts.push({
      accountId: account.id,
      accountName: account.name || `Cuenta ${account.id}`,
      accountKind: account.account_kind || 'other',
      currencyCode,
      paymentMethodCode: rule.payment_method_code,
      canReportPayment: Boolean(rule.can_report_payment),
      canConfirmPayment: Boolean(rule.can_confirm_payment),
      autoConfirmsReport: Boolean(rule.auto_confirms_report),
      reviewRequired: Boolean(rule.review_required),
    });
  }

  const [
    { data: itemsData, error: itemsError },
    { data: movementsData, error: movementsError },
    { data: reportsData, error: reportsError },
  ] = await Promise.all(
    orderIds.length
      ? [
          ctx.supabase
            .from('order_items')
            .select('id, order_id, qty, product_name_snapshot, line_total_usd, line_total_bs_snapshot, notes')
            .in('order_id', orderIds)
            .order('id', { ascending: true }),
          ctx.supabase
            .from('money_movements')
            .select('order_id, direction, status, amount_usd_equivalent')
            .in('order_id', orderIds),
          ctx.supabase.from('payment_reports').select('order_id, status').in('order_id', orderIds),
        ]
      : [
          Promise.resolve({ data: [], error: null }),
          Promise.resolve({ data: [], error: null }),
          Promise.resolve({ data: [], error: null }),
        ]
  );

  if (itemsError) {
    throw new Error(itemsError.message);
  }
  if (movementsError) {
    throw new Error(movementsError.message);
  }
  if (reportsError) {
    throw new Error(reportsError.message);
  }

  const itemsByOrder = new Map<number, CounterOrderItem[]>();
  for (const item of (itemsData ?? []) as RawCounterItem[]) {
    const orderItems = itemsByOrder.get(item.order_id) ?? [];
    orderItems.push({
      id: item.id,
      qty: toNumber(item.qty, 0),
      name: item.product_name_snapshot || 'Producto',
      lineTotalUsd: roundOrderMoney(item.line_total_usd),
      lineTotalBs: roundOrderMoney(item.line_total_bs_snapshot),
      notes: item.notes,
    });
    itemsByOrder.set(item.order_id, orderItems);
  }

  const movementsByOrder = new Map<number, RawMoneyMovement[]>();
  for (const movement of (movementsData ?? []) as RawMoneyMovement[]) {
    if (!movement.order_id) continue;
    const orderMovements = movementsByOrder.get(movement.order_id) ?? [];
    orderMovements.push(movement);
    movementsByOrder.set(movement.order_id, orderMovements);
  }

  const reportsByOrder = new Map<number, { pending: number; confirmed: number; rejected: number }>();
  for (const report of (reportsData ?? []) as RawPaymentReport[]) {
    if (!report.order_id) continue;
    const current = reportsByOrder.get(report.order_id) ?? { pending: 0, confirmed: 0, rejected: 0 };
    if (report.status === 'pending') current.pending += 1;
    if (report.status === 'confirmed') current.confirmed += 1;
    if (report.status === 'rejected') current.rejected += 1;
    reportsByOrder.set(report.order_id, current);
  }

  const orders: CounterOrder[] = rawOrders.map((order) => {
    const client = normalizeClient(order);
    const moneySnapshot = getOrderMoneySnapshot(order);
    const clientFundUsedUsd = roundOrderMoney(order.extra_fields?.payment?.client_fund_used_usd);
    const confirmedPaidUsd = roundOrderMoney(getConfirmedSignedUsd(movementsByOrder.get(order.id) ?? []) + clientFundUsedUsd);
    const roundingClosure = getOrderRoundingClosureSnapshot(order);
    const balanceUsd = roundingClosure.isClosed
      ? 0
      : roundOrderMoney(Math.max(0, moneySnapshot.totalUsd - confirmedPaidUsd));

    return {
      id: order.id,
      orderNumber: order.order_number || String(order.id),
      displayNumber: formatOrderDisplayNumber(order.id),
      status: order.status,
      fulfillment: order.fulfillment,
      clientName: client?.full_name || 'Cliente',
      clientPhone: client?.phone || null,
      deliveryAddress: order.delivery_address,
      notes: order.notes,
      createdAt: order.created_at,
      readyAt: order.ready_at,
      scheduledDate: order.extra_fields?.schedule?.date || null,
      scheduledTime: getScheduleTime(order),
      paymentMethod: order.extra_fields?.payment?.method || 'pending',
      paymentCurrency: order.extra_fields?.payment?.currency || null,
      paymentRequiresChange: Boolean(order.extra_fields?.payment?.requires_change),
      paymentChangeFor:
        order.extra_fields?.payment?.change_for == null ? null : String(order.extra_fields.payment.change_for),
      paymentChangeCurrency: order.extra_fields?.payment?.change_currency || null,
      paymentNote: order.extra_fields?.payment?.notes || null,
      totalUsd: moneySnapshot.totalUsd,
      totalBs: moneySnapshot.totalBs,
      fxRate: moneySnapshot.fxRate,
      confirmedPaidUsd,
      balanceUsd,
      reports: reportsByOrder.get(order.id) ?? { pending: 0, confirmed: 0, rejected: 0 },
      items: itemsByOrder.get(order.id) ?? [],
    };
  });

  return (
    <CounterClient
      fullName={
        profile?.full_name?.trim() ||
        ctx.user.user_metadata?.full_name ||
        ctx.user.user_metadata?.name ||
        'Mostrador'
      }
      orders={orders}
      paymentAccounts={paymentAccounts}
    />
  );
}
