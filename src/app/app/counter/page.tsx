import { unstable_noStore as noStore } from 'next/cache';
import { redirect } from 'next/navigation';
import { getAuthContext, isMasterOrAdminRole, resolveHomePath } from '@/lib/auth';
import { loadMoneyAccountBalanceSnapshots } from '@/lib/finance/account-balances';
import { formatOrderDisplayNumber } from '@/lib/orders/order-labels';
import { getPublicVapidKey } from '@/lib/push';
import {
  getOrderMoneySnapshot,
  getOrderRoundingClosureSnapshot,
  roundOrderMoney,
} from '@/lib/orders/order-money';
import CounterClient, {
  type CounterCashAccountSummary,
  type CounterPaymentAccountOption,
  type CounterOrder,
  type CounterOrderItem,
  type CounterQuickSaleProductComponent,
  type CounterQuickSaleProductOption,
} from './CounterClient';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

type RawCounterOrder = {
  id: number;
  order_number: string | null;
  status: 'created' | 'confirmed' | 'in_kitchen' | 'ready' | 'out_for_delivery';
  source: string | null;
  fulfillment: 'pickup' | 'delivery';
  attributed_advisor_id: string | null;
  delivery_address: string | null;
  delivery_mode: string | null;
  internal_driver_user_id: string | null;
  external_partner_id: number | string | null;
  external_driver_name: string | null;
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
      client_fund_used_usd?: number | string | null;
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

type RawOrderFinancialState = {
  order_id: number | null;
  confirmed_paid_usd: number | string | null;
  pending_usd: number | string | null;
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

type RawCounterMoneyMovement = {
  id: number;
  money_account_id: number | null;
  movement_date: string | null;
  created_at: string | null;
  created_by_user_id: string | null;
  direction: 'inflow' | 'outflow' | string | null;
  movement_type: string | null;
  currency_code: string | null;
  amount: number | string | null;
  amount_usd_equivalent: number | string | null;
  reference_code: string | null;
  counterparty_name: string | null;
  description: string | null;
  order_id: number | null;
};

type RawDriverProfile = {
  id: string;
  full_name: string | null;
};

type RawDeliveryPartner = {
  id: number;
  name: string | null;
};

type RawCounterProduct = {
  id: number;
  sku: string | null;
  name: string | null;
  type: string | null;
  source_price_currency: string | null;
  source_price_amount: number | string | null;
  base_price_usd: number | string | null;
  base_price_bs: number | string | null;
  units_per_service: number | string | null;
  is_detail_editable: boolean | null;
  detail_units_limit: number | string | null;
  is_combo_component_selectable: boolean | null;
};

type RawCounterProductComponent = {
  id: number;
  parent_product_id: number | null;
  component_product_id: number | null;
  component_mode: 'fixed' | 'selectable' | string | null;
  quantity: number | string | null;
  counts_toward_detail_limit: boolean | null;
  is_required: boolean | null;
  sort_order: number | string | null;
  notes: string | null;
  parent_product:
    | { sku: string | null; name: string | null }[]
    | { sku: string | null; name: string | null }
    | null;
  component_product:
    | { sku: string | null; name: string | null; type: string | null }[]
    | { sku: string | null; name: string | null; type: string | null }
    | null;
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

function getCaracasTodayKey() {
  return new Date().toLocaleDateString('en-CA', {
    timeZone: 'America/Caracas',
  });
}

function isCounterDirectAccount(account: RawMoneyAccount | undefined) {
  if (!account) return false;
  const kind = String(account.account_kind || '');
  if (kind === 'pos') return true;
  if (kind !== 'cash') return false;

  const name = String(account.name || '').toLocaleLowerCase('es-VE');
  return name.includes('dark') || name.includes('dar');
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
    { data: productsData, error: productsError },
    { data: activeRateData, error: activeRateError },
  ] = await Promise.all([
    ctx.supabase.from('profiles').select('full_name').eq('id', ctx.user.id).maybeSingle(),
    ctx.supabase
      .from('orders')
      .select(
        [
          'id',
          'order_number',
          'status',
          'source',
          'fulfillment',
          'attributed_advisor_id',
          'delivery_address',
          'delivery_mode',
          'internal_driver_user_id',
          'external_partner_id',
          'external_driver_name',
          'external_reference',
          'total_usd',
          'total_bs_snapshot',
          'notes',
          'created_at',
          'ready_at',
          'extra_fields',
          'client:clients(full_name, phone)',
        ].join(', ')
      )
      .or('status.in.(confirmed,in_kitchen,ready,out_for_delivery),and(status.eq.created,source.eq.walk_in)')
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
    ctx.supabase
      .from('products')
      .select(
        [
          'id',
          'sku',
          'name',
          'type',
          'source_price_currency',
          'source_price_amount',
          'base_price_usd',
          'base_price_bs',
          'units_per_service',
          'is_detail_editable',
          'detail_units_limit',
          'is_combo_component_selectable',
        ].join(', ')
      )
      .eq('is_active', true)
      .order('name', { ascending: true })
      .limit(500),
    ctx.supabase
      .from('exchange_rates')
      .select('rate_bs_per_usd')
      .eq('is_active', true)
      .order('effective_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
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
  if (productsError) {
    throw new Error(productsError.message);
  }
  if (activeRateError) {
    throw new Error(activeRateError.message);
  }

  const rawOrders = (ordersData ?? []) as unknown as RawCounterOrder[];
  const orderIds = rawOrders.map((order) => order.id);
  const quickSaleProductIds = ((productsData ?? []) as unknown as RawCounterProduct[])
    .map((product) => Number(product.id || 0))
    .filter((id) => Number.isFinite(id) && id > 0);
  const activeBsRate = toNumber(activeRateData?.rate_bs_per_usd, 0);
  const internalDriverIds = Array.from(
    new Set(
      rawOrders
        .map((order) => order.internal_driver_user_id)
        .filter((id): id is string => Boolean(id && String(id).trim()))
    )
  );
  const advisorIds = Array.from(
    new Set(
      rawOrders
        .map((order) => order.attributed_advisor_id)
        .filter((id): id is string => Boolean(id && String(id).trim()))
    )
  );
  const externalPartnerIds = Array.from(
    new Set(
      rawOrders
        .map((order) => Number(order.external_partner_id || 0))
        .filter((id) => Number.isFinite(id) && id > 0)
    )
  );
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
  const counterDirectPaymentAccounts = paymentAccounts.filter((account) => {
    const sourceAccount = accountsById.get(account.accountId);
    return (
      isCounterDirectAccount(sourceAccount) &&
      (account.canConfirmPayment || account.autoConfirmsReport)
    );
  });
  const counterAccountIds = Array.from(new Set(counterDirectPaymentAccounts.map((account) => account.accountId)));
  const todayKey = getCaracasTodayKey();

  const [
    { data: itemsData, error: itemsError },
    { data: financialStateData, error: financialStateError },
    { data: reportsData, error: reportsError },
    { data: driversData, error: driversError },
    { data: advisorsData, error: advisorsError },
    { data: partnersData, error: partnersError },
    { data: counterMovementsData, error: counterMovementsError },
    balanceSnapshots,
    { data: productComponentsData, error: productComponentsError },
  ] = await Promise.all(
    orderIds.length
      ? [
          ctx.supabase
            .from('order_items')
            .select('id, order_id, qty, product_name_snapshot, line_total_usd, line_total_bs_snapshot, notes')
            .in('order_id', orderIds)
            .order('id', { ascending: true }),
          (ctx.supabase as any).rpc('get_orders_financial_state', {
            p_order_ids: orderIds,
            p_operation_date: null,
            p_active_bs_rate: activeBsRate > 0 ? activeBsRate : null,
          }),
          ctx.supabase.from('payment_reports').select('order_id, status').in('order_id', orderIds),
          internalDriverIds.length
            ? ctx.supabase.from('profiles').select('id, full_name').in('id', internalDriverIds)
            : Promise.resolve({ data: [], error: null }),
          advisorIds.length
            ? ctx.supabase.from('profiles').select('id, full_name').in('id', advisorIds)
            : Promise.resolve({ data: [], error: null }),
          externalPartnerIds.length
            ? ctx.supabase.from('delivery_partners').select('id, name').in('id', externalPartnerIds)
            : Promise.resolve({ data: [], error: null }),
          counterAccountIds.length
            ? ctx.supabase
                .from('money_movements')
                .select(
                  [
                    'id',
                    'money_account_id',
                    'movement_date',
                    'created_at',
                    'created_by_user_id',
                    'direction',
                    'movement_type',
                    'currency_code',
                    'amount',
                    'amount_usd_equivalent',
                    'reference_code',
                    'counterparty_name',
                    'description',
                    'order_id',
                  ].join(', ')
                )
                .in('money_account_id', counterAccountIds)
                .eq('movement_date', todayKey)
                .eq('status', 'confirmed')
                .order('created_at', { ascending: false })
            : Promise.resolve({ data: [], error: null }),
          counterAccountIds.length
            ? loadMoneyAccountBalanceSnapshots(ctx.supabase, { moneyAccountIds: counterAccountIds })
            : Promise.resolve([]),
          quickSaleProductIds.length
            ? ctx.supabase
                .from('product_components')
                .select(
                  [
                    'id',
                    'parent_product_id',
                    'component_product_id',
                    'component_mode',
                    'quantity',
                    'counts_toward_detail_limit',
                    'is_required',
                    'sort_order',
                    'notes',
                    'parent_product:products!product_components_parent_product_id_fkey(sku, name)',
                    'component_product:products!product_components_component_product_id_fkey(sku, name, type)',
                  ].join(', ')
                )
                .in('parent_product_id', quickSaleProductIds)
                .order('parent_product_id', { ascending: true })
                .order('sort_order', { ascending: true })
            : Promise.resolve({ data: [], error: null }),
        ]
      : [
          Promise.resolve({ data: [], error: null }),
          Promise.resolve({ data: [], error: null }),
          Promise.resolve({ data: [], error: null }),
          Promise.resolve({ data: [], error: null }),
          Promise.resolve({ data: [], error: null }),
          Promise.resolve({ data: [], error: null }),
          counterAccountIds.length
            ? ctx.supabase
                .from('money_movements')
                .select(
                  [
                    'id',
                    'money_account_id',
                    'movement_date',
                    'created_at',
                    'created_by_user_id',
                    'direction',
                    'movement_type',
                    'currency_code',
                    'amount',
                    'amount_usd_equivalent',
                    'reference_code',
                    'counterparty_name',
                    'description',
                    'order_id',
                  ].join(', ')
                )
                .in('money_account_id', counterAccountIds)
                .eq('movement_date', todayKey)
                .eq('status', 'confirmed')
                .order('created_at', { ascending: false })
            : Promise.resolve({ data: [], error: null }),
          counterAccountIds.length
            ? loadMoneyAccountBalanceSnapshots(ctx.supabase, { moneyAccountIds: counterAccountIds })
            : Promise.resolve([]),
          quickSaleProductIds.length
            ? ctx.supabase
                .from('product_components')
                .select(
                  [
                    'id',
                    'parent_product_id',
                    'component_product_id',
                    'component_mode',
                    'quantity',
                    'counts_toward_detail_limit',
                    'is_required',
                    'sort_order',
                    'notes',
                    'parent_product:products!product_components_parent_product_id_fkey(sku, name)',
                    'component_product:products!product_components_component_product_id_fkey(sku, name, type)',
                  ].join(', ')
                )
                .in('parent_product_id', quickSaleProductIds)
                .order('parent_product_id', { ascending: true })
                .order('sort_order', { ascending: true })
            : Promise.resolve({ data: [], error: null }),
        ]
  );

  if (itemsError) {
    throw new Error(itemsError.message);
  }
  if (financialStateError) {
    throw new Error(financialStateError.message);
  }
  if (reportsError) {
    throw new Error(reportsError.message);
  }
  if (driversError) {
    throw new Error(driversError.message);
  }
  if (advisorsError) {
    throw new Error(advisorsError.message);
  }
  if (partnersError) {
    throw new Error(partnersError.message);
  }
  if (counterMovementsError) {
    throw new Error(counterMovementsError.message);
  }
  if (productComponentsError) {
    throw new Error(productComponentsError.message);
  }

  const movementCreatorIds = Array.from(
    new Set(
      ((counterMovementsData ?? []) as unknown as RawCounterMoneyMovement[])
        .map((movement) => movement.created_by_user_id)
        .filter((id): id is string => Boolean(id && String(id).trim()))
    )
  );

  const { data: movementCreatorsData, error: movementCreatorsError } =
    movementCreatorIds.length
      ? await ctx.supabase
          .from('profiles')
          .select('id, full_name')
          .in('id', movementCreatorIds)
      : { data: [], error: null };

  if (movementCreatorsError) {
    throw new Error(movementCreatorsError.message);
  }

  const movementCreatorNameById = new Map<string, string>();
  for (const profile of (movementCreatorsData ?? []) as RawDriverProfile[]) {
    movementCreatorNameById.set(profile.id, profile.full_name?.trim() || 'Usuario');
  }

  const balanceSnapshotByAccountId = new Map(
    balanceSnapshots.map((snapshot) => [snapshot.moneyAccountId, snapshot.balanceNative])
  );

  const counterMovementsByAccount = new Map<number, RawCounterMoneyMovement[]>();
  for (const movement of (counterMovementsData ?? []) as unknown as RawCounterMoneyMovement[]) {
    const accountId = Number(movement.money_account_id || 0);
    if (!accountId) continue;
    const current = counterMovementsByAccount.get(accountId) ?? [];
    current.push(movement);
    counterMovementsByAccount.set(accountId, current);
  }

  const counterMethodsByAccount = new Map<number, Set<string>>();
  for (const account of counterDirectPaymentAccounts) {
    const current = counterMethodsByAccount.get(account.accountId) ?? new Set<string>();
    current.add(account.paymentMethodCode);
    counterMethodsByAccount.set(account.accountId, current);
  }

  const cashAccounts: CounterCashAccountSummary[] = counterAccountIds
    .map((accountId) => {
      const account = accountsById.get(accountId);
      const currencyCode = String(account?.currency_code || '').toUpperCase();
      if (!account || (currencyCode !== 'USD' && currencyCode !== 'VES')) return null;
      const movements = (counterMovementsByAccount.get(accountId) ?? [])
        .map((movement) => {
          const movementCurrency = String(movement.currency_code || currencyCode).toUpperCase();
          return {
            id: Number(movement.id),
            movementDate: movement.movement_date || todayKey,
            createdAt: movement.created_at,
            direction: movement.direction === 'outflow' ? 'outflow' as const : 'inflow' as const,
            movementType: movement.movement_type || 'other',
            amount: roundOrderMoney(movement.amount),
            amountUsdEquivalent: roundOrderMoney(movement.amount_usd_equivalent),
            currencyCode: movementCurrency === 'VES' ? 'VES' as const : 'USD' as const,
            referenceCode: movement.reference_code,
            counterpartyName: movement.counterparty_name,
            description: movement.description,
            orderId: movement.order_id,
            createdByName: movement.created_by_user_id
              ? movementCreatorNameById.get(movement.created_by_user_id) ?? 'Usuario'
              : null,
          };
        });
      const inflow = movements
        .filter((movement) => movement.direction === 'inflow')
        .reduce((sum, movement) => sum + movement.amount, 0);
      const outflow = movements
        .filter((movement) => movement.direction === 'outflow')
        .reduce((sum, movement) => sum + movement.amount, 0);

      return {
        accountId,
        accountName: account.name || `Cuenta ${accountId}`,
        accountKind: account.account_kind || 'other',
        currencyCode,
        methods: Array.from(counterMethodsByAccount.get(accountId) ?? []),
        inflow: roundOrderMoney(inflow),
        outflow: roundOrderMoney(outflow),
        net: roundOrderMoney(inflow - outflow),
        balance: roundOrderMoney(balanceSnapshotByAccountId.get(accountId) ?? 0),
        movements,
      };
    })
    .filter((account): account is CounterCashAccountSummary => Boolean(account))
    .sort((a, b) => {
      const kindPriority = (kind: string) => (kind === 'cash' ? 1 : kind === 'pos' ? 2 : kind === 'bank' ? 3 : 4);
      const priorityDiff = kindPriority(a.accountKind) - kindPriority(b.accountKind);
      if (priorityDiff !== 0) return priorityDiff;
      return a.accountName.localeCompare(b.accountName, 'es');
    });

  const internalDriverNameById = new Map(
    ((driversData ?? []) as RawDriverProfile[]).map((driver) => [
      driver.id,
      driver.full_name?.trim() || 'Motorizado interno',
    ])
  );
  const advisorNameById = new Map(
    ((advisorsData ?? []) as RawDriverProfile[]).map((advisor) => [
      advisor.id,
      advisor.full_name?.trim() || 'Asesor',
    ])
  );
  const deliveryPartnerNameById = new Map(
    ((partnersData ?? []) as RawDeliveryPartner[]).map((partner) => [
      Number(partner.id),
      partner.name?.trim() || `Partner #${partner.id}`,
    ])
  );

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

  const financialStateByOrder = new Map<number, RawOrderFinancialState>();
  for (const state of (financialStateData ?? []) as RawOrderFinancialState[]) {
    const orderId = Number(state.order_id || 0);
    if (orderId > 0) financialStateByOrder.set(orderId, state);
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
    const financialState = financialStateByOrder.get(order.id);
    const confirmedPaidUsd = financialState ? roundOrderMoney(financialState.confirmed_paid_usd) : 0;
    const roundingClosure = getOrderRoundingClosureSnapshot(order);
    const balanceUsd = roundingClosure.isClosed
      ? 0
      : financialState
        ? roundOrderMoney(financialState.pending_usd)
        : roundOrderMoney(Math.max(0, moneySnapshot.totalUsd - confirmedPaidUsd));
    const internalDriverName = order.internal_driver_user_id
      ? internalDriverNameById.get(order.internal_driver_user_id) ?? null
      : null;
    const externalPartnerName = order.external_partner_id
      ? deliveryPartnerNameById.get(Number(order.external_partner_id)) ?? null
      : null;
    const deliveryAssigneeKind = internalDriverName
      ? 'internal'
      : externalPartnerName || order.external_driver_name
        ? 'external'
        : null;

    return {
      id: order.id,
      orderNumber: order.order_number || String(order.id),
      displayNumber: formatOrderDisplayNumber(order.id),
      status: order.status,
      source: order.source || null,
      isCounterSale: order.source === 'walk_in' || Boolean(order.extra_fields?.counter?.quick_sale),
      isCounterScheduled: Boolean(order.extra_fields?.counter?.scheduled_by_counter),
      fulfillment: order.fulfillment,
      clientName: client?.full_name || 'Cliente',
      clientPhone: client?.phone || null,
      advisorName: order.attributed_advisor_id
        ? advisorNameById.get(order.attributed_advisor_id) ?? null
        : null,
      deliveryAddress: order.delivery_address,
      deliveryMode: order.delivery_mode || null,
      deliveryAssigneeKind,
      deliveryAssigneeName: internalDriverName || externalPartnerName || order.external_driver_name || null,
      externalReference: order.external_reference || null,
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

  const quickSaleProducts: CounterQuickSaleProductOption[] = ((productsData ?? []) as unknown as RawCounterProduct[])
    .map((product) => {
      const sourcePriceCurrency: 'USD' | 'VES' = product.source_price_currency === 'VES' ? 'VES' : 'USD';

      return {
        id: Number(product.id),
        sku: product.sku,
        name: product.name || 'Producto',
        type: product.type || null,
        sourcePriceCurrency,
        sourcePriceAmount: toNumber(product.source_price_amount, 0),
        basePriceUsd: toNumber(product.base_price_usd, 0),
        basePriceBs: toNumber(product.base_price_bs, 0),
        unitsPerService: toNumber(product.units_per_service, 0),
        isDetailEditable: Boolean(product.is_detail_editable),
        detailUnitsLimit: toNumber(product.detail_units_limit, 0),
        isComboComponentSelectable: Boolean(product.is_combo_component_selectable),
      };
    })
    .filter((product) => product.id > 0);

  const quickSaleProductComponents: CounterQuickSaleProductComponent[] = (
    (productComponentsData ?? []) as unknown as RawCounterProductComponent[]
  )
    .map((component) => {
      const parent = Array.isArray(component.parent_product)
        ? component.parent_product[0] ?? null
        : component.parent_product;
      const componentProduct = Array.isArray(component.component_product)
        ? component.component_product[0] ?? null
        : component.component_product;

      return {
        id: Number(component.id),
        parentProductId: Number(component.parent_product_id || 0),
        componentProductId: Number(component.component_product_id || 0),
        componentMode: component.component_mode === 'selectable' ? ('selectable' as const) : ('fixed' as const),
        quantity: toNumber(component.quantity, 0),
        countsTowardDetailLimit: Boolean(component.counts_toward_detail_limit),
        isRequired: Boolean(component.is_required),
        sortOrder: toNumber(component.sort_order, 0),
        notes: component.notes,
        parentSku: parent?.sku ?? null,
        parentName: parent?.name ?? null,
        componentSku: componentProduct?.sku ?? null,
        componentName: componentProduct?.name || 'Componente',
        componentType: componentProduct?.type ?? null,
      };
    })
    .filter((component) => component.parentProductId > 0 && component.componentProductId > 0);

  return (
    <CounterClient
      publicVapidKey={getPublicVapidKey()}
      fullName={
        profile?.full_name?.trim() ||
        ctx.user.user_metadata?.full_name ||
        ctx.user.user_metadata?.name ||
        'Mostrador'
      }
      orders={orders}
      paymentAccounts={paymentAccounts}
      cashAccounts={cashAccounts}
      quickSaleProducts={quickSaleProducts}
      quickSaleProductComponents={quickSaleProductComponents}
      activeBsRate={activeBsRate}
    />
  );
}
