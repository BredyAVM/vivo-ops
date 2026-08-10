import Link from 'next/link';
import { getAuthContext } from '@/lib/auth';
import { withAdvisorReturnTo } from '@/lib/advisor-navigation';
import { formatOrderDisplayNumber } from '@/lib/orders/order-labels';
import { EmptyBlock, MetricCard, PageIntro, SectionCard, StatusBadge } from '../advisor-ui';

type SearchParams = Promise<{ period?: string }>;

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
  productName?: string | null;
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
  const returnTo = selectedPeriod ? `/app/advisor/commissions?period=${selectedPeriod.id}` : '/app/advisor/commissions';

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
            <MetricCard label="Facturación" value={money(closure.billed_usd)} detail={`${closure.delivered_orders_count} órdenes entregadas.`} />
            <MetricCard label="Comisión bruta" value={money(closure.gross_commission_usd)} detail={`Base general ${numberValue(closure.base_commission_pct).toFixed(2)}%.`} />
            <MetricCard label="Deducciones" value={money(numberValue(closure.gift_deductions_usd) + numberValue(closure.manual_deductions_usd))} detail="Obsequios y deducibles aplicados." />
            <MetricCard label="A pagar" value={money(closure.payable_usd)} detail={closure.status === 'paid' ? 'Pago registrado.' : 'Monto del cierre actual.'} />
          </section>

          <SectionCard title="Pagos de clientes" subtitle="Lectura usada para calcular el período.">
            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="rounded-[14px] bg-[#0D1017] px-2 py-3"><div className="text-lg font-semibold text-emerald-300">{paidOrders.length}</div><div className="text-[11px] text-[#8B93A7]">Puntuales</div></div>
              <div className="rounded-[14px] bg-[#0D1017] px-2 py-3"><div className="text-lg font-semibold text-[#F7DA66]">{pendingOrders.length}</div><div className="text-[11px] text-[#8B93A7]">Pendientes</div></div>
              <div className="rounded-[14px] bg-[#0D1017] px-2 py-3"><div className="text-lg font-semibold text-[#F5F7FB]">{newClients.length}</div><div className="text-[11px] text-[#8B93A7]">Nuevos</div></div>
            </div>
            {numberValue(closure.pending_collection_usd) > 0 ? (
              <div className="mt-2 rounded-[14px] border border-[#564511] bg-[#151208] px-3 py-2 text-sm text-[#F7DA66]">
                Pendiente por cobrar: {money(closure.pending_collection_usd)}
              </div>
            ) : null}
          </SectionCard>

          <SectionCard title="Órdenes del período" subtitle={`${orders.length} orden${orders.length === 1 ? '' : 'es'} incluidas.`}>
            <div className="space-y-2">
              {orders.map((order, index) => {
                const orderId = numberValue(order.orderId);
                return (
                  <article key={`${orderId}-${index}`} className="rounded-[16px] border border-[#232632] bg-[#0D1017] px-3 py-2.5">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0"><div className="truncate text-sm font-medium text-[#F5F7FB]">{order.clientName || 'Cliente'}</div><div className="mt-1 text-xs text-[#8B93A7]">Orden {orderLabel(order)} · {dateLabel(order.deliveryDate)}</div></div>
                      <div className="text-right"><div className="text-sm font-semibold text-[#F7DA66]">{money(order.commissionUsd)}</div><div className="text-[10px] text-[#8B93A7]">{commissionModeLabel(order.commissionMode)}</div></div>
                    </div>
                    <div className="mt-2 flex items-center justify-between text-xs text-[#AAB2C5]"><span>Total {money(order.totalUsd)}</span><span>Pendiente {money(order.pendingUsd)}</span></div>
                    {orderId > 0 ? <Link href={withAdvisorReturnTo(`/app/advisor/orders/${orderId}`, returnTo)} className="mt-2 inline-flex h-8 items-center rounded-[11px] border border-[#2A3040] px-3 text-xs font-medium text-[#F5F7FB]">Abrir orden</Link> : null}
                  </article>
                );
              })}
            </div>
          </SectionCard>

          <SectionCard title="Productos" subtitle="Agrupados para facilitar la revisión.">
            <div className="space-y-2">
              {Array.from(productsByName.entries()).map(([name, product]) => (
                <div key={name} className="flex items-center justify-between gap-3 rounded-[14px] bg-[#0D1017] px-3 py-2.5 text-sm">
                  <div className="min-w-0"><div className="truncate text-[#F5F7FB]">{name}</div><div className="text-xs text-[#8B93A7]">{product.rows} línea{product.rows === 1 ? '' : 's'}</div></div>
                  <div className="text-right"><div className="font-semibold text-[#F5F7FB]">{product.qty}</div><div className="text-xs text-[#8B93A7]">Base {money(product.baseUsd)}</div></div>
                </div>
              ))}
            </div>
          </SectionCard>

          <SectionCard title="Obsequios y deducibles" subtitle="Información de solo lectura definida en el cierre.">
            <div className="space-y-2">
              {giftsByName.size === 0 && deductions.length === 0 ? <EmptyBlock title="Sin deducciones" detail="Este cierre no contiene obsequios ni deducibles manuales." /> : null}
              {Array.from(giftsByName.entries()).map(([name, gift]) => (
                <details key={name} className="rounded-[14px] border border-[#232632] bg-[#0D1017] px-3 py-2.5">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-sm"><span className="font-medium text-[#F5F7FB]">{name} · {gift.qty}</span><span className="text-orange-300">-{money(gift.deductionUsd)}</span></summary>
                  <div className="mt-2 space-y-1.5 border-t border-[#232632] pt-2">
                    {gift.rows.map((row, index) => <div key={`${row.orderId}-${index}`} className="flex justify-between gap-3 text-xs text-[#AAB2C5]"><span>{row.clientName || 'Cliente'} · Orden {formatOrderDisplayNumber(numberValue(row.orderId))}</span><span>{row.qty}</span></div>)}
                  </div>
                </details>
              ))}
              {deductions.map((deduction) => (
                <div key={deduction.id} className="rounded-[14px] border border-[#5A341F] bg-[#17110D] px-3 py-2.5">
                  <div className="flex justify-between gap-3 text-sm"><span className="font-medium text-[#F5F7FB]">{deduction.description || 'Deducible'}</span><span className="font-semibold text-orange-300">-{money(deduction.amount_usd)}</span></div>
                  {deduction.notes ? <div className="mt-1 text-xs leading-5 text-[#AAB2C5]">{deduction.notes}</div> : null}
                </div>
              ))}
            </div>
          </SectionCard>
        </>
      ) : null}
    </div>
  );
}
