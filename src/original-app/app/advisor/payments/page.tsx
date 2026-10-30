import Link from 'next/link';
import { getAuthContext } from '@/lib/auth';
import { formatOrderDisplayNumber, getPaymentMethodLabel } from '@/lib/orders/order-labels';
import { getOrderMoneySnapshot } from '@/lib/orders/order-money';
import { withAdvisorReturnTo } from '@/lib/advisor-navigation';
import AdvisorCalendarStrip from '../AdvisorCalendarStrip';
import { EmptyBlock, MetricCard, PageIntro, SectionCard, StatusBadge } from '../advisor-ui';

type SearchParams = Promise<{
  day?: string;
  view?: string;
  client?: string;
}>;

type OrderRow = {
  id: number;
  client_id: number | string | null;
  order_number: string;
  status: string;
  total_usd: number | string;
  created_at: string;
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
      client_fund_used_usd?: number | string | null;
    } | null;
    pricing?: {
      fx_rate?: number | string | null;
      total_usd?: number | string | null;
      total_bs?: number | string | null;
    } | null;
  } | null;
  client: { full_name: string | null; phone: string | null } | null;
};

type RawOrderRow = Omit<OrderRow, 'client'> & {
  client:
    | { full_name: string | null; phone: string | null }[]
    | { full_name: string | null; phone: string | null }
    | null;
};

type PaymentRow = {
  id: number;
  order_id: number;
  status: 'pending' | 'confirmed' | 'rejected';
  reported_currency_code: string;
  reported_amount: number | string;
  reported_amount_usd_equivalent: number | string;
  reference_code: string | null;
  created_at: string | null;
};

type RawOrderFinancialStateRow = {
  order_id: number | string;
  total_bs: number | string | null;
  pending_reports_usd: number | string | null;
  pending_reports_bs_snapshot: number | string | null;
  rejected_reports_count: number | string | null;
  pending_usd: number | string | null;
  pending_bs: number | string | null;
};

function formatDate(value: string | null) {
  if (!value) return 'Sin fecha';
  return new Date(value).toLocaleString('es-VE', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: 'America/Caracas',
  });
}

function formatMoney(currencyCode: string, amount: number | string) {
  const value = Number(amount);
  if (!Number.isFinite(value)) return '0';
  return currencyCode === 'VES' ? `Bs ${Math.round(value)}` : `$${value.toFixed(2)}`;
}

function tone(status: PaymentRow['status']): 'warning' | 'success' | 'danger' {
  if (status === 'pending') return 'warning';
  if (status === 'confirmed') return 'success';
  return 'danger';
}

function label(status: PaymentRow['status']) {
  if (status === 'confirmed') return 'Confirmado';
  if (status === 'rejected') return 'Rechazado';
  return 'Por validar';
}

function formatUsd(value: number | string) {
  const amount = Number(value);
  return Number.isFinite(amount) ? `$${amount.toFixed(2)}` : '$0.00';
}

function formatBs(value: number | string) {
  const amount = Number(value);
  return Number.isFinite(amount) ? `Bs ${amount.toFixed(2)}` : 'Bs 0.00';
}

function toSafeNumber(value: unknown, fallback = 0) {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : fallback;
}

function getDateKey(date: Date) {
  return date.toLocaleDateString('en-CA', {
    timeZone: 'America/Caracas',
  });
}

function getCaracasDayRange(dayKey: string) {
  const start = new Date(`${dayKey}T00:00:00-04:00`);
  const end = new Date(start);
  end.setDate(start.getDate() + 1);
  return {
    startISO: start.toISOString(),
    endISO: end.toISOString(),
  };
}

function getIsoDayKey(value: string) {
  return new Date(value).toLocaleDateString('en-CA', {
    timeZone: 'America/Caracas',
  });
}

function isDayKey(value: string | null | undefined) {
  return Boolean(value && /^\d{4}-\d{2}-\d{2}$/.test(value));
}

function getAgendaDayKey(order: Pick<OrderRow, 'created_at' | 'extra_fields'>) {
  const scheduledDay = order.extra_fields?.schedule?.date;
  return isDayKey(scheduledDay) ? String(scheduledDay) : getIsoDayKey(order.created_at);
}

function paymentMethodLabel(method: string | null | undefined) {
  return getPaymentMethodLabel(method);
}

function getOrderTotalUsd(order: OrderRow) {
  return getOrderMoneySnapshot(order).totalUsd;
}

function getOrderTotalBs(order: OrderRow) {
  return getOrderMoneySnapshot(order).totalBs;
}

function getOrderFxRate(order: OrderRow) {
  return getOrderMoneySnapshot(order).fxRate;
}

function usdToOrderBs(order: OrderRow, amountUsd: number) {
  const fxRate = getOrderFxRate(order);
  return fxRate > 0 ? amountUsd * fxRate : 0;
}

function getPaymentEquivalentBs(payment: PaymentRow, order: OrderRow | undefined) {
  if (payment.reported_currency_code === 'VES') return toSafeNumber(payment.reported_amount, 0);
  if (!order) return 0;
  return usdToOrderBs(order, toSafeNumber(payment.reported_amount_usd_equivalent, 0));
}

function getCanonicalPaymentState(state: RawOrderFinancialStateRow) {
  const pendingUsd = toSafeNumber(state.pending_reports_usd, 0);
  const pendingBs = toSafeNumber(state.pending_reports_bs_snapshot, 0);
  const balanceUsd = toSafeNumber(state.pending_usd, 0);
  const balanceBs = toSafeNumber(state.pending_bs, 0);

  return {
    totalBs: toSafeNumber(state.total_bs, 0),
    balanceUsd,
    balanceBs,
    reportableBalanceUsd: Math.max(0, Number((balanceUsd - pendingUsd).toFixed(2))),
    reportableBalanceBs: Math.max(0, Number((balanceBs - pendingBs).toFixed(2))),
    pendingUsd,
    pendingBs,
    hasRejected: toSafeNumber(state.rejected_reports_count, 0) > 0,
  };
}

function getAgendaLabel(order: OrderRow) {
  const schedule = order.extra_fields?.schedule;
  if (schedule?.asap) return 'Lo antes posible';
  const date = String(schedule?.date || '').trim();
  const time = String(schedule?.time_12 || '').trim();
  return `${date} ${time}`.trim() || formatDate(order.created_at);
}

function sortPaymentRows(rows: PaymentRow[]) {
  return [...rows].sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
}

function getWhatsAppHref(phone: string | null | undefined) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits ? `https://wa.me/${digits}` : null;
}

function formatOrderDate(order: OrderRow) {
  const value = order.extra_fields?.schedule?.date || order.created_at;
  return new Date(String(value).includes('T') ? String(value) : `${value}T12:00:00-04:00`).toLocaleDateString('es-VE', {
    dateStyle: 'short',
    timeZone: 'America/Caracas',
  });
}

export default async function AdvisorPaymentsPage({ searchParams }: { searchParams?: SearchParams }) {
  const params = (await searchParams) ?? {};
  const ctx = await getAuthContext();
  if (!ctx) return null;

  const selectedDayKey =
    params.day && /^\d{4}-\d{2}-\d{2}$/.test(params.day) ? params.day : getDateKey(new Date());
  const selectedView = params.view === 'orders' ? 'orders' : 'clients';
  const selectedClientKey = String(params.client || '').trim();
  const dayRange = getCaracasDayRange(selectedDayKey);
  const orderSelect =
    'id, client_id, order_number, status, total_usd, created_at, extra_fields, client:clients!orders_client_id_fkey(full_name, phone)';

  const [scheduledOrdersResult, createdOrdersResult, deliveredOrdersResult] = await Promise.all([
    ctx.supabase
      .from('orders')
      .select(orderSelect)
      .eq('attributed_advisor_id', ctx.user.id)
      .neq('status', 'cancelled')
      .eq('extra_fields->schedule->>date', selectedDayKey)
      .order('created_at', { ascending: false })
      .limit(180),
    ctx.supabase
      .from('orders')
      .select(orderSelect)
      .eq('attributed_advisor_id', ctx.user.id)
      .neq('status', 'cancelled')
      .gte('created_at', dayRange.startISO)
      .lt('created_at', dayRange.endISO)
      .order('created_at', { ascending: false })
      .limit(180),
    ctx.supabase
      .from('orders')
      .select(orderSelect)
      .eq('attributed_advisor_id', ctx.user.id)
      .eq('status', 'delivered')
      .order('created_at', { ascending: false })
      .limit(500),
  ]);

  const orderById = new Map<number, OrderRow>();
  for (const order of ([
    ...(scheduledOrdersResult.data ?? []),
    ...(createdOrdersResult.data ?? []),
    ...(deliveredOrdersResult.data ?? []),
  ] as RawOrderRow[])) {
    orderById.set(Number(order.id), {
      ...order,
      client: Array.isArray(order.client) ? order.client[0] ?? null : order.client,
    });
  }
  const orders = Array.from(orderById.values());
  const agendaOrderIds = new Set(
    orders.filter((order) => getAgendaDayKey(order) === selectedDayKey).map((order) => order.id)
  );
  const ordersById = new Map(orders.map((order) => [order.id, order]));

  const orderIds = orders.map((order) => order.id);
  const [paymentResult, activeRateResult] = orderIds.length
    ? await Promise.all([
        ctx.supabase
          .from('payment_reports')
          .select(
            'id, order_id, status, reported_currency_code, reported_amount, reported_amount_usd_equivalent, reference_code, created_at'
          )
          .in('order_id', orderIds)
          .order('created_at', { ascending: false })
          .limit(200),
        ctx.supabase
          .from('exchange_rates')
          .select('rate_bs_per_usd')
          .eq('is_active', true)
          .order('effective_at', { ascending: false })
          .limit(1)
          .maybeSingle(),
      ])
    : [{ data: [] }, { data: null }];
  const paymentData = paymentResult.data ?? [];
  const activeRateBsPerUsd = toSafeNumber(
    (activeRateResult.data as { rate_bs_per_usd?: number | string } | null)?.rate_bs_per_usd,
    0
  );
  const payments = (paymentData ?? []) as PaymentRow[];
  const { data: financialStateData, error: financialStateError } = orderIds.length
    ? await (ctx.supabase as any).rpc('get_orders_financial_state', {
        p_order_ids: orderIds,
        p_operation_date: null,
        p_active_bs_rate: activeRateBsPerUsd > 0 ? activeRateBsPerUsd : null,
      })
    : { data: [], error: null };
  if (financialStateError) {
    console.warn('get_orders_financial_state skipped in advisor payments', financialStateError.message);
  }
  const financialStateByOrderId = new Map<number, RawOrderFinancialStateRow>();
  for (const state of (financialStateData ?? []) as RawOrderFinancialStateRow[]) {
    const orderId = Number(state.order_id);
    if (Number.isFinite(orderId)) financialStateByOrderId.set(orderId, state);
  }

  const reportsByOrderId = new Map<number, PaymentRow[]>();
  for (const payment of payments) {
    const current = reportsByOrderId.get(payment.order_id) ?? [];
    current.push(payment);
    reportsByOrderId.set(payment.order_id, current);
  }

  const ordersPendingPayment = orders
    .map((order) => {
      const reports = reportsByOrderId.get(order.id) ?? [];
      const canonicalState = financialStateByOrderId.get(order.id);
      if (canonicalState) {
        const paymentState = getCanonicalPaymentState(canonicalState);
        return {
          ...order,
          ...paymentState,
          hasPending: paymentState.pendingUsd > 0.005 || reports.some((payment) => payment.status === 'pending'),
          paymentMethod: paymentMethodLabel(order.extra_fields?.payment?.method),
        };
      }

      const confirmedUsd =
        reports
          .filter((payment) => payment.status === 'confirmed')
          .reduce((sum, payment) => sum + toSafeNumber(payment.reported_amount_usd_equivalent, 0), 0) +
        toSafeNumber(order.extra_fields?.payment?.client_fund_used_usd, 0);
      const confirmedBs =
        reports
          .filter((payment) => payment.status === 'confirmed')
          .reduce((sum, payment) => sum + getPaymentEquivalentBs(payment, order), 0) +
        usdToOrderBs(order, toSafeNumber(order.extra_fields?.payment?.client_fund_used_usd, 0));
      const pendingUsd = reports
        .filter((payment) => payment.status === 'pending')
        .reduce((sum, payment) => sum + toSafeNumber(payment.reported_amount_usd_equivalent, 0), 0);
      const pendingBs = reports
        .filter((payment) => payment.status === 'pending')
        .reduce((sum, payment) => sum + getPaymentEquivalentBs(payment, order), 0);
      const balanceUsd = Math.max(0, Number((getOrderTotalUsd(order) - confirmedUsd).toFixed(2)));
      const reportableBalanceUsd = Math.max(
        0,
        Number((getOrderTotalUsd(order) - confirmedUsd - pendingUsd).toFixed(2))
      );
      const totalBs = getOrderTotalBs(order);
      const balanceBs =
        totalBs > 0 ? Math.max(0, Number((totalBs - confirmedBs).toFixed(2))) : usdToOrderBs(order, balanceUsd);
      const reportableBalanceBs = Math.max(0, Number((balanceBs - pendingBs).toFixed(2)));

      return {
        ...order,
        totalBs,
        balanceUsd,
        balanceBs,
        reportableBalanceUsd,
        reportableBalanceBs,
        pendingUsd,
        pendingBs,
        hasRejected: reports.some((payment) => payment.status === 'rejected'),
        hasPending: reports.some((payment) => payment.status === 'pending'),
        paymentMethod: paymentMethodLabel(order.extra_fields?.payment?.method),
      };
    })
    .filter((order) => order.status === 'delivered' && order.reportableBalanceUsd > 0.005)
    .sort((a, b) => getAgendaLabel(a).localeCompare(getAgendaLabel(b)));

  const dayPayments = payments.filter((payment) => agendaOrderIds.has(payment.order_id));
  const pendingReviewRows = sortPaymentRows(dayPayments.filter((payment) => payment.status === 'pending'));
  const confirmedRows = sortPaymentRows(dayPayments.filter((payment) => payment.status === 'confirmed'));
  const rejectedRows = sortPaymentRows(dayPayments.filter((payment) => payment.status === 'rejected'));
  const collectBsFromPayments = (rows: PaymentRow[]) =>
    rows.reduce((sum, payment) => {
      const order = ordersById.get(payment.order_id);
      return sum + getPaymentEquivalentBs(payment, order);
    }, 0);
  const reportableTotalBs = ordersPendingPayment.reduce((sum, order) => sum + order.reportableBalanceBs, 0);
  const pendingReviewTotalBs = collectBsFromPayments(pendingReviewRows);

  const collectionGroupsByClient = new Map<
    string,
    {
      key: string;
      name: string;
      phone: string | null;
      totalUsd: number;
      totalBs: number;
      orders: typeof ordersPendingPayment;
    }
  >();
  for (const order of ordersPendingPayment) {
    const clientId = toSafeNumber(order.client_id, 0);
    const phone = order.client?.phone?.trim() || null;
    const key = clientId > 0 ? `client-${clientId}` : `order-${order.id}`;
    const current = collectionGroupsByClient.get(key) ?? {
      key,
      name: order.client?.full_name?.trim() || `Cliente de orden ${formatOrderDisplayNumber(order.id)}`,
      phone,
      totalUsd: 0,
      totalBs: 0,
      orders: [],
    };
    current.totalUsd += order.reportableBalanceUsd;
    current.totalBs += order.reportableBalanceBs;
    current.orders.push(order);
    collectionGroupsByClient.set(key, current);
  }
  const collectionGroups = Array.from(collectionGroupsByClient.values()).sort(
    (a, b) => b.totalBs - a.totalBs || a.name.localeCompare(b.name)
  );
  const visibleCollectionGroups = selectedClientKey
    ? collectionGroups.filter((group) => group.key === selectedClientKey)
    : collectionGroups;
  const paymentsReturnTo = `/app/advisor/payments?day=${selectedDayKey}&view=${selectedView}${
    selectedClientKey ? `&client=${encodeURIComponent(selectedClientKey)}` : ''
  }`;

  const sections = [
    { title: 'Por validar', subtitle: 'Reportes enviados y pendientes por confirmacion.', rows: pendingReviewRows },
    { title: 'Rechazados', subtitle: 'Reportes que necesitan correccion o reenvio.', rows: rejectedRows },
    { title: 'Confirmados', subtitle: 'Cobros ya aceptados.', rows: confirmedRows },
  ];

  return (
    <div className="space-y-4">
      <AdvisorCalendarStrip
        selectedDayKey={selectedDayKey}
        todayKey={getDateKey(new Date())}
      />

      <PageIntro
        eyebrow="Cobranza"
        title="Pagos reportados"
        description="Aqui se separa lo que falta cobrar, lo que ya fue enviado a revision y lo que requiere correccion."
        action={
          <Link href="/app/advisor/new" className="inline-flex h-10 items-center rounded-[14px] border border-[#232632] px-3.5 text-sm font-medium text-[#F5F7FB]">
            Nuevo pedido
          </Link>
        }
      />

      <section className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <MetricCard
          label="Por cobrar"
          value={formatBs(reportableTotalBs)}
          detail={`${ordersPendingPayment.length} orden${ordersPendingPayment.length === 1 ? '' : 'es'} con saldo reportable.`}
        />
        <MetricCard
          label="Por validar"
          value={formatBs(pendingReviewTotalBs)}
          detail={`${pendingReviewRows.length} reporte${pendingReviewRows.length === 1 ? '' : 's'} esperando revision.`}
        />
        <MetricCard
          label="Rechazados"
          value={String(rejectedRows.length)}
          detail="Cobros que necesitan correccion."
        />
      </section>

      <nav className="grid grid-cols-2 gap-2 rounded-[18px] border border-[#232632] bg-[#10131B] p-1.5">
        <Link
          href={`/app/advisor/payments?day=${selectedDayKey}&view=clients`}
          className={[
            'inline-flex h-9 items-center justify-center rounded-[13px] text-xs font-semibold',
            selectedView === 'clients' ? 'bg-[#F0D000] text-[#17191E]' : 'text-[#AAB2C5]',
          ].join(' ')}
        >
          Por cliente
        </Link>
        <Link
          href={`/app/advisor/payments?day=${selectedDayKey}&view=orders`}
          className={[
            'inline-flex h-9 items-center justify-center rounded-[13px] text-xs font-semibold',
            selectedView === 'orders' ? 'bg-[#F0D000] text-[#17191E]' : 'text-[#AAB2C5]',
          ].join(' ')}
        >
          Por orden
        </Link>
      </nav>

      {selectedView === 'clients' ? (
        <SectionCard
          title="Cobranza por cliente"
          subtitle="Agrupa todas las ordenes entregadas con deuda para cobrar el total de cada cliente."
        >
          {selectedClientKey ? (
            <div className="mb-3 flex justify-end">
              <Link
                href={`/app/advisor/payments?day=${selectedDayKey}&view=clients`}
                className="inline-flex h-9 items-center rounded-[12px] border border-[#232632] px-3 text-xs font-medium text-[#F5F7FB]"
              >
                Ver todos los clientes
              </Link>
            </div>
          ) : null}
          {visibleCollectionGroups.length === 0 ? (
            <EmptyBlock
              title="Sin clientes por cobrar"
              detail="Cuando una orden entregada conserve saldo, aparecera en esta relacion."
              href="/app/advisor/orders"
              cta="Ver pedidos"
            />
          ) : (
            <div className="space-y-3">
              {visibleCollectionGroups.map((group) => {
                const whatsappHref = getWhatsAppHref(group.phone);
                return (
                  <article key={group.key} className="advisor-fade-in rounded-[20px] border border-[#564511] bg-[#151208] px-3.5 py-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-semibold text-[#F5F7FB]">{group.name}</div>
                        <div className="mt-1 text-xs text-[#8B93A7]">
                          {group.orders.length} orden{group.orders.length === 1 ? '' : 'es'} pendiente{group.orders.length === 1 ? '' : 's'}
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="text-sm font-semibold text-[#F0D000]">{formatBs(group.totalBs)}</div>
                        <div className="mt-1 text-xs text-[#8B93A7]">{formatUsd(group.totalUsd)}</div>
                      </div>
                    </div>
                    <div className="mt-3 divide-y divide-[#232632] rounded-[14px] bg-[#0B1017] px-3">
                      {group.orders.map((order) => (
                        <div key={order.id} className="grid grid-cols-[1fr_auto] items-center gap-3 py-2.5">
                          <div className="min-w-0">
                            <div className="text-xs font-medium text-[#F5F7FB]">
                              Orden {formatOrderDisplayNumber(order.id)} · {formatOrderDate(order)}
                            </div>
                            <div className="mt-1 text-xs text-[#8B93A7]">
                              Saldo {formatBs(order.reportableBalanceBs)} / {formatUsd(order.reportableBalanceUsd)}
                            </div>
                          </div>
                          <Link
                            href={withAdvisorReturnTo(`/app/advisor/orders/${order.id}?reportPayment=1`, paymentsReturnTo)}
                            className="inline-flex h-8 items-center rounded-[11px] bg-[#F0D000] px-3 text-[11px] font-semibold text-[#17191E]"
                          >
                            Cobrar
                          </Link>
                        </div>
                      ))}
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {!selectedClientKey ? (
                        <Link
                          href={`/app/advisor/payments?day=${selectedDayKey}&view=clients&client=${encodeURIComponent(group.key)}`}
                          className="inline-flex h-9 items-center rounded-[12px] border border-[#232632] px-3 text-xs font-medium text-[#F5F7FB]"
                        >
                          Ver relacion
                        </Link>
                      ) : null}
                      {whatsappHref ? (
                        <a
                          href={whatsappHref}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex h-9 items-center rounded-[12px] border border-[#1C5036] px-3 text-xs font-semibold text-[#72D99C]"
                        >
                          Conversar por WhatsApp
                        </a>
                      ) : null}
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </SectionCard>
      ) : (
        <SectionCard title="Por cobrar" subtitle="Ordenes entregadas con saldo real disponible para reportar.">
          {ordersPendingPayment.length === 0 ? (
            <EmptyBlock
              title="Sin ordenes por cobrar"
              detail="Cuando haya saldo pendiente, aparecera aqui para cargar el pago."
              href="/app/advisor/orders"
              cta="Ver pedidos"
            />
          ) : (
            <div className="space-y-2.5">
              {ordersPendingPayment.map((order) => (
                <article
                  key={order.id}
                  className={[
                    'advisor-fade-in rounded-[20px] border px-3.5 py-3',
                    order.hasRejected ? 'border-[#5E2229] bg-[#171118]' : 'border-[#564511] bg-[#151208]',
                  ].join(' ')}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-[#F5F7FB]">
                        {order.client?.full_name?.trim() || formatOrderDisplayNumber(order.id)}
                      </div>
                      <div className="mt-1 text-xs text-[#8B93A7]">Orden {formatOrderDisplayNumber(order.id)} · {formatOrderDate(order)}</div>
                    </div>
                    <div className="flex flex-col items-end gap-1.5">
                      <StatusBadge label={`Saldo ${formatBs(order.reportableBalanceBs)}`} tone="warning" />
                      {order.hasRejected ? <StatusBadge label="Rechazado antes" tone="danger" /> : null}
                      {order.hasPending ? <StatusBadge label={`${formatBs(order.pendingBs)} por validar`} tone="neutral" /> : null}
                    </div>
                  </div>
                  <div className="mt-3 grid gap-2 rounded-[14px] bg-[#0B1017] px-3 py-2">
                    <div className="flex items-center justify-between gap-3 text-xs text-[#8B93A7]">
                      <span>Metodo esperado</span>
                      <span className="text-[#F5F7FB]">{order.paymentMethod}</span>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-xs text-[#8B93A7]">Total orden</span>
                      <span className="text-sm font-semibold text-[#F5F7FB]">{formatBs(order.totalBs)}</span>
                    </div>
                    <div className="flex items-center justify-between gap-3 text-xs text-[#8B93A7]">
                      <span>Referencia $</span>
                      <span>{formatUsd(getOrderTotalUsd(order))}</span>
                    </div>
                  </div>
                  <div className="mt-3 flex gap-2">
                    <Link
                      href={withAdvisorReturnTo(`/app/advisor/orders/${order.id}?reportPayment=1`, paymentsReturnTo)}
                      className="inline-flex h-9 items-center rounded-[14px] bg-[#F0D000] px-3.5 text-xs font-semibold text-[#17191E]"
                    >
                      Cargar pago
                    </Link>
                    <Link
                      href={withAdvisorReturnTo(`/app/advisor/orders/${order.id}`, paymentsReturnTo)}
                      className="inline-flex h-9 items-center rounded-[14px] border border-[#232632] px-3.5 text-xs font-medium text-[#F5F7FB]"
                    >
                      Ver orden
                    </Link>
                  </div>
                </article>
              ))}
            </div>
          )}
        </SectionCard>
      )}

      {dayPayments.length === 0 ? (
        <EmptyBlock
          title="Sin reportes este dia"
          detail="Los pagos enviados para la fecha seleccionada apareceran aqui."
          href="/app/advisor/orders"
          cta="Abrir pedidos"
        />
      ) : (
        sections.map((section) => (
          <SectionCard key={section.title} title={section.title} subtitle={section.subtitle}>
            {section.rows.length === 0 ? (
              <EmptyBlock title="Sin movimientos" detail="No hay registros en esta categoria todavia." />
            ) : (
              <div className="space-y-2.5">
                {section.rows.map((payment) => {
                  const order = ordersById.get(payment.order_id);
                  const equivalentUsd = toSafeNumber(payment.reported_amount_usd_equivalent, 0);
                  const equivalentBs = getPaymentEquivalentBs(payment, order);
                  const orderLabel = order?.client?.full_name?.trim() || formatOrderDisplayNumber(payment.order_id);

                  return (
                    <article
                      key={payment.id}
                      className={[
                        'advisor-fade-in rounded-[20px] border px-3.5 py-3',
                        payment.status === 'rejected'
                          ? 'border-[#5E2229] bg-[#171118]'
                          : payment.status === 'pending'
                            ? 'border-[#564511] bg-[#151208]'
                            : 'border-[#1C5036] bg-[#0F2119]',
                      ].join(' ')}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium text-[#F5F7FB]">{orderLabel}</div>
                          <div className="mt-1 text-xs text-[#8B93A7]">
                            Orden {formatOrderDisplayNumber(payment.order_id)} · {formatDate(payment.created_at)}
                          </div>
                        </div>
                        <StatusBadge label={label(payment.status)} tone={tone(payment.status)} />
                      </div>
                      <div className="mt-3 grid gap-2 rounded-[14px] bg-[#0B1017] px-3 py-2">
                        <div className="flex items-center justify-between gap-3 text-xs text-[#8B93A7]">
                          <span>Monto reportado</span>
                          <span className="text-sm font-semibold text-[#F5F7FB]">
                            {formatMoney(payment.reported_currency_code, payment.reported_amount)}
                          </span>
                        </div>
                        <div className="flex items-center justify-between gap-3 text-xs text-[#8B93A7]">
                          <span>Equivalente Bs</span>
                          <span className="text-[#F5F7FB]">{formatBs(equivalentBs)}</span>
                        </div>
                        <div className="flex items-center justify-between gap-3 text-xs text-[#8B93A7]">
                          <span>Referencia $</span>
                          <span>{formatUsd(equivalentUsd)}</span>
                        </div>
                        <div className="text-xs text-[#AAB2C5]">
                          Referencia: {payment.reference_code?.trim() || 'Sin referencia'}
                        </div>
                      </div>
                      <div className="mt-3 flex gap-2">
                        <Link
                          href={withAdvisorReturnTo(`/app/advisor/orders/${payment.order_id}`, paymentsReturnTo)}
                          className="inline-flex h-9 items-center rounded-[12px] border border-[#232632] px-3 text-xs font-medium text-[#F5F7FB]"
                        >
                          Ver orden
                        </Link>
                        {payment.status === 'rejected' ? (
                          <Link
                            href={withAdvisorReturnTo(
                              `/app/advisor/orders/${payment.order_id}?reportPayment=1`,
                              paymentsReturnTo
                            )}
                            className="inline-flex h-9 items-center rounded-[12px] bg-[#F0D000] px-3 text-xs font-semibold text-[#17191E]"
                          >
                            Reenviar
                          </Link>
                        ) : null}
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </SectionCard>
        ))
      )}
    </div>
  );
}
