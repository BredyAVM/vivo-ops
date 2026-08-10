import Link from 'next/link';
import { getAuthContext } from '@/lib/auth';
import { withAdvisorReturnTo } from '@/lib/advisor-navigation';
import { formatOrderDisplayNumber } from '@/lib/orders/order-labels';
import { EmptyBlock, MetricCard, PageIntro, SectionCard, StatusBadge } from '../advisor-ui';

type CommissionDetail =
  | 'orders'
  | 'payments'
  | 'paid'
  | 'pending'
  | 'clients'
  | 'clients-own'
  | 'clients-assigned'
  | 'products'
  | 'gifts'
  | 'deductions';

type SearchParams = Promise<{ period?: string; detail?: string }>;

type PeriodRow = {
  id: number | string;
  name: string;
  date_from: string;
  date_to: string;
  status: string;
};

type SnapshotOrder = {
  orderId?: number | string | null;
  orderNumber?: string | null;
  clientName?: string | null;
  deliveryDate?: string | null;
  totalUsd?: number | string | null;
  confirmedPaidUsd?: number | string | null;
  pendingUsd?: number | string | null;
  regularBaseUsd?: number | string | null;
  specialItemBaseUsd?: number | string | null;
  specialOrderBaseUsd?: number | string | null;
  commissionUsd?: number | string | null;
  commissionMode?: string | null;
};

type SnapshotProduct = {
  orderId?: number | string | null;
  orderNumber?: string | null;
  clientName?: string | null;
  productName?: string | null;
  productType?: string | null;
  qty?: number | string | null;
  lineBaseUsd?: number | string | null;
  commissionMode?: string | null;
};

type SnapshotGift = SnapshotProduct & {
  clientName?: string | null;
  deductionUsd?: number | string | null;
};

type SnapshotClient = {
  clientId?: number | string | null;
  clientName?: string | null;
  clientType?: string | null;
  orderId?: number | string | null;
  orderNumber?: string | null;
  billedUsd?: number | string | null;
  totalUsd?: number | string | null;
  createdAt?: string | null;
};

type DeductionRow = {
  id: number | string;
  deduction_type: string | null;
  description: string | null;
  amount_usd: number | string | null;
  order_id: number | string | null;
  notes: string | null;
};

type ClosureRow = {
  id: number | string;
  status: string;
  base_commission_pct: number | string;
  delivered_orders_count: number | string;
  billed_usd: number | string;
  gross_commission_usd: number | string;
  pending_collection_usd: number | string;
  punctual_paid_count: number | string;
  late_paid_count: number | string;
  pending_payment_count: number | string;
  new_own_clients_count: number | string;
  new_assigned_clients_count: number | string;
  gift_deductions_usd: number | string;
  manual_deductions_usd: number | string;
  payable_usd: number | string;
  generated_at: string | null;
  closed_at: string | null;
  paid_at: string | null;
  snapshot: {
    orders?: SnapshotOrder[];
    paid_orders?: SnapshotOrder[];
    pending_orders?: SnapshotOrder[];
    new_clients?: SnapshotClient[];
    products?: SnapshotProduct[];
    gifts?: SnapshotGift[];
  } | null;
  deductions: DeductionRow[] | null;
};

function numberValue(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function money(value: unknown) {
  return `$${numberValue(value).toFixed(2)}`;
}

function dateLabel(value: string | null | undefined) {
  if (!value) return 'Sin fecha';
  const parsed = new Date(`${value.slice(0, 10)}T12:00:00-04:00`);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat('es-VE', { day: '2-digit', month: 'short', year: 'numeric' }).format(parsed);
}

function closureStatus(status: string) {
  if (status === 'paid') return { label: 'Pagada', tone: 'success' as const };
  if (status === 'closed') return { label: 'Cerrada', tone: 'warning' as const };
  return { label: 'Preliminar', tone: 'neutral' as const };
}

function orderLabel(order: SnapshotOrder) {
  const explicit = String(order.orderNumber || '').trim();
  const id = numberValue(order.orderId);
  return explicit || (id > 0 ? formatOrderDisplayNumber(id) : 'Sin número');
}

function commissionModeLabel(value: string | null | undefined) {
  if (value === 'fixed_order') return 'Orden especial';
  if (value === 'mixed_items') return 'Ítems especiales';
  if (value === 'fixed_item') return 'Ítem especial';
  return 'Normal';
}

function getCommissionDetail(value: string | null | undefined): CommissionDetail | null {
  const details: CommissionDetail[] = [
    'orders',
    'payments',
    'paid',
    'pending',
    'clients',
    'clients-own',
    'clients-assigned',
    'products',
    'gifts',
    'deductions',
  ];
  return details.includes(value as CommissionDetail) ? (value as CommissionDetail) : null;
}

function commissionHref(periodId: number | string, detail?: CommissionDetail) {
  return `/app/advisor/commissions?period=${periodId}${detail ? `&detail=${detail}#commission-detail` : ''}`;
}

export default async function AdvisorCommissionsPage({ searchParams }: { searchParams?: SearchParams }) {
  const ctx = await getAuthContext();
  if (!ctx) return null;

  const params = (await searchParams) ?? {};
  const { data: periodData, error: periodError } = await ctx.supabase
    .from('advisor_commission_periods')
    .select('id, name, date_from, date_to, status')
    .order('date_from', { ascending: false })
    .limit(40);

  const periods = (periodData ?? []) as PeriodRow[];
  const requestedPeriodId = Number(params.period || 0);
  const selectedPeriod = periods.find((period) => Number(period.id) === requestedPeriodId) ?? periods[0] ?? null;
  const activeDetail = getCommissionDetail(params.detail);
  const returnTo = selectedPeriod
    ? commissionHref(selectedPeriod.id, activeDetail || undefined)
    : '/app/advisor/commissions';

  let closure: ClosureRow | null = null;
  let closureError: string | null = null;
  if (selectedPeriod) {
    const result = await ctx.supabase
      .from('advisor_commission_closures')
      .select(`
        id, status, base_commission_pct, delivered_orders_count, billed_usd,
        gross_commission_usd, pending_collection_usd, punctual_paid_count,
        late_paid_count, pending_payment_count, new_own_clients_count,
        new_assigned_clients_count, gift_deductions_usd, manual_deductions_usd,
        payable_usd, generated_at, closed_at, paid_at, snapshot,
        deductions:advisor_commission_deductions (
          id, deduction_type, description, amount_usd, order_id, notes
        )
      `)
      .eq('period_id', Number(selectedPeriod.id))
      .eq('advisor_user_id', ctx.user.id)
      .maybeSingle();

    closure = (result.data as ClosureRow | null) ?? null;
    closureError = result.error?.message ?? null;
  }

  const snapshot = closure?.snapshot ?? {};
  const orders = Array.isArray(snapshot.orders) ? snapshot.orders : [];
  const pendingOrders = Array.isArray(snapshot.pending_orders) ? snapshot.pending_orders : [];
  const paidOrders = Array.isArray(snapshot.paid_orders) ? snapshot.paid_orders : [];
  const newClients = Array.isArray(snapshot.new_clients) ? snapshot.new_clients : [];
  const products = Array.isArray(snapshot.products) ? snapshot.products : [];
  const gifts = Array.isArray(snapshot.gifts) ? snapshot.gifts : [];
  const deductions = Array.isArray(closure?.deductions) ? closure.deductions : [];
  const ownClients = newClients.filter((client) => String(client.clientType || '').toLowerCase() === 'own');
  const assignedClients = newClients.filter((client) => String(client.clientType || '').toLowerCase() === 'assigned');
  const status = closure ? closureStatus(closure.status) : null;

  const productsByName = new Map<string, { qty: number; baseUsd: number; rows: number }>();
  for (const product of products) {
    const name = String(product.productName || 'Producto').trim();
    const current = productsByName.get(name) ?? { qty: 0, baseUsd: 0, rows: 0 };
    current.qty += numberValue(product.qty);
    current.baseUsd += numberValue(product.lineBaseUsd);
    current.rows += 1;
    productsByName.set(name, current);
  }

  const giftsByName = new Map<string, { qty: number; deductionUsd: number; rows: SnapshotGift[] }>();
  for (const gift of gifts) {
    const name = String(gift.productName || 'Obsequio').trim();
    const current = giftsByName.get(name) ?? { qty: 0, deductionUsd: 0, rows: [] };
    current.qty += numberValue(gift.qty);
    current.deductionUsd += numberValue(gift.deductionUsd);
    current.rows.push(gift);
    giftsByName.set(name, current);
  }
  const productQty = products.reduce((sum, product) => sum + numberValue(product.qty), 0);
  const productBaseUsd = products.reduce((sum, product) => sum + numberValue(product.lineBaseUsd), 0);
  const giftQty = gifts.reduce((sum, gift) => sum + numberValue(gift.qty), 0);
  const paidTotalUsd = paidOrders.reduce((sum, order) => sum + numberValue(order.totalUsd), 0);
  const orderById = new Map(orders.map((order) => [numberValue(order.orderId), order]));
  const getClientFirstOrderTotal = (client: SnapshotClient) =>
    numberValue(orderById.get(numberValue(client.orderId))?.totalUsd ?? client.totalUsd ?? client.billedUsd);
  const ownClientsTotalUsd = ownClients.reduce((sum, client) => sum + getClientFirstOrderTotal(client), 0);
  const assignedClientsTotalUsd = assignedClients.reduce((sum, client) => sum + getClientFirstOrderTotal(client), 0);
  const detailOrders = activeDetail === 'paid' ? paidOrders : activeDetail === 'pending' ? pendingOrders : orders;
  const detailClients = activeDetail === 'clients-own' ? ownClients : assignedClients;
  const parentDetail: CommissionDetail | null =
    activeDetail === 'paid' || activeDetail === 'pending'
      ? 'payments'
      : activeDetail === 'clients-own' || activeDetail === 'clients-assigned'
        ? 'clients'
        : null;
  const detailTitle =
    activeDetail === 'orders'
      ? 'Órdenes facturadas'
      : activeDetail === 'payments'
        ? 'Pagos de clientes'
        : activeDetail === 'paid'
          ? 'Pagos puntuales'
          : activeDetail === 'pending'
            ? 'Pendientes por cobrar'
            : activeDetail === 'clients'
              ? 'Clientes nuevos'
              : activeDetail === 'clients-own'
                ? 'Clientes nuevos propios'
                : activeDetail === 'clients-assigned'
                  ? 'Clientes nuevos asignados'
                  : activeDetail === 'products'
                    ? 'Productos del período'
                    : activeDetail === 'gifts'
                      ? 'Obsequios entregados'
                      : activeDetail === 'deductions'
                        ? 'Deducibles aplicados'
                        : '';

  return (
    <div className="space-y-4">
      <PageIntro
        eyebrow="Resultados"
        title="Mis comisiones"
        description="Consulta el cierre generado por administración. Esta vista no modifica porcentajes, órdenes ni deducciones."
      />

      <SectionCard title="Período" subtitle="Selecciona el cierre que quieres revisar.">
        {periodError ? (
          <EmptyBlock title="No se pudieron cargar los períodos" detail={periodError.message} />
        ) : periods.length === 0 ? (
          <EmptyBlock title="Sin períodos" detail="Administración todavía no ha creado períodos de comisión." />
        ) : (
          <form className="grid grid-cols-[1fr_auto] gap-2" action="/app/advisor/commissions" method="get">
            <select
              name="period"
              defaultValue={String(selectedPeriod?.id || '')}
              className="h-11 min-w-0 rounded-[14px] border border-[#2A3040] bg-[#0D1017] px-3 text-sm text-[#F5F7FB]"
            >
              {periods.map((period) => (
                <option key={period.id} value={period.id}>
                  {period.name} · {dateLabel(period.date_from)} al {dateLabel(period.date_to)}
                </option>
              ))}
            </select>
            <button className="h-11 rounded-[14px] bg-[#F0D000] px-4 text-sm font-semibold text-[#17191E]" type="submit">
              Ver
            </button>
          </form>
        )}
      </SectionCard>

      {closureError ? (
        <EmptyBlock title="No se pudo cargar el cierre" detail={closureError} />
      ) : selectedPeriod && !closure ? (
        <EmptyBlock
          title="Cierre todavía no generado"
          detail={`El período ${selectedPeriod.name} existe, pero administración aún no ha generado tu resultado.`}
        />
      ) : closure && selectedPeriod ? (
        <>
          <div className="flex items-center justify-between gap-3 rounded-[18px] border border-[#232632] bg-[#0D1017] px-3.5 py-3">
            <div>
              <div className="text-sm font-semibold text-[#F5F7FB]">{selectedPeriod.name}</div>
              <div className="mt-1 text-xs text-[#8B93A7]">{dateLabel(selectedPeriod.date_from)} al {dateLabel(selectedPeriod.date_to)}</div>
            </div>
            {status ? <StatusBadge label={status.label} tone={status.tone} /> : null}
          </div>

          <section className="grid grid-cols-2 gap-3">
            <Link
              href={commissionHref(selectedPeriod.id, 'orders')}
              className={activeDetail === 'orders' ? 'rounded-[22px] ring-2 ring-[#F0D000]' : 'rounded-[22px]'}
            >
              <MetricCard
                label="Facturación"
                value={money(closure.billed_usd)}
                detail={`${closure.delivered_orders_count} órdenes · Toca para ver`}
              />
            </Link>
            <MetricCard
              label="Comisión bruta"
              value={money(closure.gross_commission_usd)}
              detail={`Base general ${numberValue(closure.base_commission_pct).toFixed(2)}%.`}
            />
            <Link
              href={commissionHref(selectedPeriod.id, 'deductions')}
              className={activeDetail === 'deductions' ? 'rounded-[22px] ring-2 ring-[#F0D000]' : 'rounded-[22px]'}
            >
              <MetricCard
                label="Deducibles"
                value={money(closure.manual_deductions_usd)}
                detail={`${deductions.length} registro${deductions.length === 1 ? '' : 's'} · Toca para ver`}
              />
            </Link>
            <MetricCard
              label="A pagar"
              value={money(closure.payable_usd)}
              detail={closure.status === 'paid' ? 'Pago registrado.' : 'Monto del cierre actual.'}
            />
          </section>

          <SectionCard title="Explorar el cierre" subtitle="Toca una tarjeta para mostrar solo ese detalle.">
            <div className="grid grid-cols-2 gap-2.5">
              <Link
                href={commissionHref(selectedPeriod.id, 'payments')}
                className={[
                  'rounded-[16px] border px-3 py-3',
                  activeDetail === 'payments' || activeDetail === 'paid' || activeDetail === 'pending'
                    ? 'border-emerald-400 bg-[#102219]'
                    : 'border-[#232632] bg-[#0D1017]',
                ].join(' ')}
              >
                <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#8B93A7]">Pagos de clientes</div>
                <div className="mt-1.5 text-xl font-semibold text-[#F5F7FB]">{paidOrders.length + pendingOrders.length}</div>
                <div className="mt-1 text-xs text-[#AAB2C5]">{paidOrders.length} puntuales · {pendingOrders.length} pendientes</div>
              </Link>
              <Link
                href={commissionHref(selectedPeriod.id, 'clients')}
                className={[
                  'rounded-[16px] border px-3 py-3',
                  activeDetail === 'clients' || activeDetail === 'clients-own' || activeDetail === 'clients-assigned'
                    ? 'border-[#7EA6FF] bg-[#101827]'
                    : 'border-[#232632] bg-[#0D1017]',
                ].join(' ')}
              >
                <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#8B93A7]">Clientes nuevos</div>
                <div className="mt-1.5 text-xl font-semibold text-[#F5F7FB]">{newClients.length}</div>
                <div className="mt-1 text-xs text-[#AAB2C5]">{ownClients.length} propios · {assignedClients.length} asignados</div>
              </Link>
              <Link
                href={commissionHref(selectedPeriod.id, 'products')}
                className={[
                  'rounded-[16px] border px-3 py-3',
                  activeDetail === 'products' ? 'border-[#7EA6FF] bg-[#101827]' : 'border-[#232632] bg-[#0D1017]',
                ].join(' ')}
              >
                <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#8B93A7]">Productos</div>
                <div className="mt-1.5 text-xl font-semibold text-[#F5F7FB]">{productQty}</div>
                <div className="mt-1 text-xs text-[#AAB2C5]">Base {money(productBaseUsd)}</div>
              </Link>
              <Link
                href={commissionHref(selectedPeriod.id, 'gifts')}
                className={[
                  'rounded-[16px] border px-3 py-3',
                  activeDetail === 'gifts' ? 'border-orange-400 bg-[#21150D]' : 'border-[#232632] bg-[#0D1017]',
                ].join(' ')}
              >
                <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#8B93A7]">Obsequios</div>
                <div className="mt-1.5 text-xl font-semibold text-orange-300">{giftQty}</div>
                <div className="mt-1 text-xs text-[#AAB2C5]">-{money(closure.gift_deductions_usd)}</div>
              </Link>
            </div>
          </SectionCard>

          {activeDetail ? (
            <div id="commission-detail" className="scroll-mt-20">
              <SectionCard
                title={detailTitle}
                subtitle="Detalle de solo lectura del cierre seleccionado."
                action={
                  <Link
                    href={commissionHref(selectedPeriod.id, parentDetail || undefined)}
                    className="inline-flex h-9 items-center rounded-[12px] border border-[#2A3040] px-3 text-xs font-medium text-[#F5F7FB]"
                  >
                    {parentDetail ? 'Volver' : 'Cerrar'}
                  </Link>
                }
              >
              {activeDetail === 'payments' ? (
                <div className="grid grid-cols-2 gap-2.5">
                  <Link
                    href={commissionHref(selectedPeriod.id, 'paid')}
                    className="rounded-[16px] border border-emerald-500/40 bg-[#102219] px-3 py-3"
                  >
                    <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#8B93A7]">Puntuales</div>
                    <div className="mt-1.5 text-2xl font-semibold text-emerald-300">{paidOrders.length}</div>
                    <div className="mt-1 text-xs text-[#AAB2C5]">{money(paidTotalUsd)} · Ver órdenes</div>
                  </Link>
                  <Link
                    href={commissionHref(selectedPeriod.id, 'pending')}
                    className="rounded-[16px] border border-[#564511] bg-[#201B08] px-3 py-3"
                  >
                    <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#8B93A7]">Pendientes</div>
                    <div className="mt-1.5 text-2xl font-semibold text-[#F7DA66]">{pendingOrders.length}</div>
                    <div className="mt-1 text-xs text-[#AAB2C5]">{money(closure.pending_collection_usd)} · Ver órdenes</div>
                  </Link>
                </div>
              ) : null}

              {activeDetail === 'clients' ? (
                <div className="grid grid-cols-2 gap-2.5">
                  <Link
                    href={commissionHref(selectedPeriod.id, 'clients-own')}
                    className="rounded-[16px] border border-[#314A74] bg-[#101827] px-3 py-3"
                  >
                    <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#8B93A7]">Propios</div>
                    <div className="mt-1.5 text-2xl font-semibold text-[#F5F7FB]">{ownClients.length}</div>
                    <div className="mt-1 text-xs text-[#AAB2C5]">{money(ownClientsTotalUsd)} · Ver clientes</div>
                  </Link>
                  <Link
                    href={commissionHref(selectedPeriod.id, 'clients-assigned')}
                    className="rounded-[16px] border border-[#314A74] bg-[#101827] px-3 py-3"
                  >
                    <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#8B93A7]">Asignados</div>
                    <div className="mt-1.5 text-2xl font-semibold text-[#F5F7FB]">{assignedClients.length}</div>
                    <div className="mt-1 text-xs text-[#AAB2C5]">{money(assignedClientsTotalUsd)} · Ver clientes</div>
                  </Link>
                </div>
              ) : null}

              {activeDetail === 'orders' || activeDetail === 'paid' || activeDetail === 'pending' ? (
                detailOrders.length === 0 ? (
                  <EmptyBlock title="Sin órdenes" detail="No hay órdenes en esta categoría para el período." />
                ) : (
                  <div className="space-y-2">
                    {detailOrders.map((order, index) => {
                      const orderId = numberValue(order.orderId);
                      return (
                        <article key={`${orderId}-${index}`} className="rounded-[16px] border border-[#232632] bg-[#0D1017] px-3 py-2.5">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="truncate text-sm font-medium text-[#F5F7FB]">{order.clientName || 'Cliente'}</div>
                              <div className="mt-1 text-xs text-[#8B93A7]">Orden {orderLabel(order)} · {dateLabel(order.deliveryDate)}</div>
                            </div>
                            <div className="shrink-0 text-right">
                              <div className="text-sm font-semibold text-[#F5F7FB]">{money(order.totalUsd)}</div>
                              <div className="mt-0.5 text-[10px] text-[#8B93A7]">Comisión {money(order.commissionUsd)}</div>
                            </div>
                          </div>
                          <div className="mt-2 flex items-center justify-between gap-3 text-xs text-[#AAB2C5]">
                            <span>{commissionModeLabel(order.commissionMode)}</span>
                            <span className={numberValue(order.pendingUsd) > 0 ? 'text-[#F7DA66]' : 'text-emerald-300'}>
                              {numberValue(order.pendingUsd) > 0 ? `Pendiente ${money(order.pendingUsd)}` : 'Pagada'}
                            </span>
                          </div>
                          {orderId > 0 ? (
                            <Link
                              href={withAdvisorReturnTo(`/app/advisor/orders/${orderId}`, returnTo)}
                              className="mt-2 inline-flex h-8 items-center rounded-[11px] border border-[#2A3040] px-3 text-xs font-medium text-[#F5F7FB]"
                            >
                              Abrir orden
                            </Link>
                          ) : null}
                        </article>
                      );
                    })}
                  </div>
                )
              ) : null}

              {activeDetail === 'clients-own' || activeDetail === 'clients-assigned' ? (
                detailClients.length === 0 ? (
                  <EmptyBlock title="Sin clientes" detail="No hay clientes nuevos de este tipo en el período." />
                ) : (
                  <div className="space-y-2">
                    {detailClients.map((client, index) => {
                      const orderId = numberValue(client.orderId);
                      const firstOrderTotal = getClientFirstOrderTotal(client);
                      return (
                        <article key={`${client.clientId}-${index}`} className="rounded-[16px] border border-[#232632] bg-[#0D1017] px-3 py-2.5">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="truncate text-sm font-medium text-[#F5F7FB]">{client.clientName || 'Cliente'}</div>
                              <div className="mt-1 text-xs text-[#8B93A7]">
                                {activeDetail === 'clients-own' ? 'Cliente propio' : 'Cliente asignado'} · Alta {dateLabel(client.createdAt)}
                              </div>
                            </div>
                            <div className="shrink-0 text-sm font-semibold text-[#F5F7FB]">{money(firstOrderTotal)}</div>
                          </div>
                          <div className="mt-2 flex items-center justify-between gap-3 text-xs text-[#AAB2C5]">
                            <span>Primera orden {client.orderNumber || (orderId > 0 ? formatOrderDisplayNumber(orderId) : 'sin número')}</span>
                            {orderId > 0 ? (
                              <Link
                                href={withAdvisorReturnTo(`/app/advisor/orders/${orderId}`, returnTo)}
                                className="font-semibold text-[#F7DA66]"
                              >
                                Abrir
                              </Link>
                            ) : null}
                          </div>
                        </article>
                      );
                    })}
                  </div>
                )
              ) : null}

              {activeDetail === 'products' ? (
                productsByName.size === 0 ? (
                  <EmptyBlock title="Sin productos" detail="El cierre no contiene líneas de producto." />
                ) : (
                  <div className="space-y-2">
                    {Array.from(productsByName.entries()).map(([name, product]) => (
                      <div key={name} className="flex items-center justify-between gap-3 rounded-[14px] bg-[#0D1017] px-3 py-2.5 text-sm">
                        <div className="min-w-0">
                          <div className="truncate font-medium text-[#F5F7FB]">{name}</div>
                          <div className="text-xs text-[#8B93A7]">{product.rows} orden{product.rows === 1 ? '' : 'es'}</div>
                        </div>
                        <div className="shrink-0 text-right">
                          <div className="font-semibold text-[#F5F7FB]">{product.qty} ítems</div>
                          <div className="text-xs text-[#8B93A7]">Base {money(product.baseUsd)}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                )
              ) : null}

              {activeDetail === 'gifts' ? (
                giftsByName.size === 0 ? (
                  <EmptyBlock title="Sin obsequios" detail="No se registraron obsequios en este período." />
                ) : (
                  <div className="space-y-2">
                    {Array.from(giftsByName.entries()).map(([name, gift]) => (
                      <details key={name} className="rounded-[14px] border border-[#232632] bg-[#0D1017] px-3 py-2.5">
                        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-sm">
                          <span className="font-medium text-[#F5F7FB]">{name} · {gift.qty} ítems</span>
                          <span className="text-orange-300">-{money(gift.deductionUsd)}</span>
                        </summary>
                        <div className="mt-2 space-y-2 border-t border-[#232632] pt-2">
                          {gift.rows.map((row, index) => {
                            const orderId = numberValue(row.orderId);
                            return (
                              <div key={`${row.orderId}-${index}`} className="flex items-center justify-between gap-3 text-xs text-[#AAB2C5]">
                                <span className="min-w-0 truncate">{row.clientName || 'Cliente'} · Orden {formatOrderDisplayNumber(orderId)}</span>
                                <span className="shrink-0">{row.qty}</span>
                              </div>
                            );
                          })}
                        </div>
                      </details>
                    ))}
                  </div>
                )
              ) : null}

              {activeDetail === 'deductions' ? (
                deductions.length === 0 ? (
                  <EmptyBlock title="Sin deducibles" detail="No se aplicaron deducibles manuales en este cierre." />
                ) : (
                  <div className="space-y-2">
                    {deductions.map((deduction) => (
                      <div key={deduction.id} className="rounded-[14px] border border-[#5A341F] bg-[#17110D] px-3 py-2.5">
                        <div className="flex justify-between gap-3 text-sm">
                          <span className="font-medium text-[#F5F7FB]">{deduction.description || 'Deducible'}</span>
                          <span className="font-semibold text-orange-300">-{money(deduction.amount_usd)}</span>
                        </div>
                        {deduction.notes ? <div className="mt-1 text-xs leading-5 text-[#AAB2C5]">{deduction.notes}</div> : null}
                      </div>
                    ))}
                  </div>
                )
              ) : null}
              </SectionCard>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
