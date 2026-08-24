import { formatOrderDisplayNumber } from '@/lib/orders/order-labels';
import type {
  AdvisorGoalCollectionOrderDetail,
  AdvisorGoalCollectionOrderStatus,
  AdvisorGoalCollectionSummary,
} from '@/lib/commissions/goal-collection';

function money(value: number) {
  return `$${value.toFixed(2)}`;
}

function dateLabel(value: string) {
  const parsed = new Date(`${value}T12:00:00-04:00`);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat('es-VE', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(parsed);
}

function statusPresentation(status: AdvisorGoalCollectionOrderStatus) {
  if (status === 'punctual_paid') return { label: 'Puntual · 100%', classes: 'border-emerald-400/30 bg-emerald-400/10 text-emerald-200' };
  if (status === 'credit_paid') return { label: 'Pagó con crédito · 80%', classes: 'border-[#F0D000]/30 bg-[#F0D000]/10 text-[#F7DA66]' };
  if (status === 'credit_open') return { label: 'Crédito vigente · 80%', classes: 'border-[#F0D000]/30 bg-[#F0D000]/10 text-[#F7DA66]' };
  if (status === 'overdue_paid') return { label: 'Pagó fuera de plazo · 0%', classes: 'border-red-400/25 bg-red-400/10 text-red-200' };
  if (status === 'overdue_open') return { label: 'Cobro atrasado · 0%', classes: 'border-red-400/35 bg-red-400/10 text-red-200' };
  return { label: 'Revisar fecha de registro · 0%', classes: 'border-orange-400/30 bg-orange-400/10 text-orange-200' };
}

function orderNote(order: AdvisorGoalCollectionOrderDetail) {
  if (order.status === 'credit_open') {
    return `Puede completar el pago hasta el ${dateLabel(order.creditDueDate)} para conservar 80%.`;
  }
  if (order.status === 'overdue_open') {
    return `Tiene ${Math.max(0, order.elapsedDays - 5)} día(s) fuera del plazo de cinco días.`;
  }
  if (order.status === 'missing_registration') {
    return 'La cuenta aparece sin saldo, pero no existe una fecha de registro que permita clasificar el pago.';
  }
  if (order.completedPaymentRegistrationDate) {
    return `Pago completo registrado el ${dateLabel(order.completedPaymentRegistrationDate)}.`;
  }
  return '';
}

function CollectionOrderCard({ order }: { order: AdvisorGoalCollectionOrderDetail }) {
  const status = statusPresentation(order.status);
  return (
    <article className="rounded-2xl border border-[#2B303C] bg-[#0D1017] p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-[#F5F7FB]">{order.clientName}</div>
          <div className="mt-1 text-[11px] text-[#9099AC]">
            Orden {formatOrderDisplayNumber(order.orderId)} · Entregada {dateLabel(order.deliveryDate)}
          </div>
        </div>
        <span className={`shrink-0 rounded-full border px-2 py-1 text-[10px] font-semibold ${status.classes}`}>
          {status.label}
        </span>
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
        <div className="rounded-xl bg-[#141821] p-2">
          <div className="text-[9px] uppercase tracking-[0.12em] text-[#788196]">Factura</div>
          <div className="mt-1 font-semibold text-[#E7EAF1]">{money(order.totalUsd)}</div>
        </div>
        <div className="rounded-xl bg-[#141821] p-2">
          <div className="text-[9px] uppercase tracking-[0.12em] text-[#788196]">Validado</div>
          <div className="mt-1 font-semibold text-emerald-300">{money(order.confirmedPaidUsd)}</div>
        </div>
        <div className="rounded-xl bg-[#141821] p-2">
          <div className="text-[9px] uppercase tracking-[0.12em] text-[#788196]">Falta cobrar</div>
          <div className={`mt-1 font-semibold ${order.pendingUsd > 0.005 ? 'text-amber-200' : 'text-[#E7EAF1]'}`}>
            {money(order.pendingUsd)}
          </div>
        </div>
      </div>
      <p className="mt-2 text-[11px] leading-5 text-[#9EA6B8]">{orderNote(order)}</p>
    </article>
  );
}

export function AdvisorGoalCollectionBreakdown({
  summary,
  defaultOpen = false,
  points,
}: {
  summary: AdvisorGoalCollectionSummary;
  defaultOpen?: boolean;
  points?: number;
}) {
  const openOrders = summary.orders
    .filter((order) => order.status === 'credit_open' || order.status === 'overdue_open')
    .sort((left, right) => Number(right.status === 'overdue_open') - Number(left.status === 'overdue_open') || right.pendingUsd - left.pendingUsd);
  const reviewOrders = summary.orders.filter((order) => order.status === 'missing_registration');
  const completedOrders = summary.orders.filter((order) =>
    order.status === 'punctual_paid' || order.status === 'credit_paid' || order.status === 'overdue_paid'
  );
  const pendingUsd = openOrders.reduce((sum, order) => sum + order.pendingUsd, 0);

  return (
    <details className="rounded-2xl border border-[#2D3442] bg-[#10141C] px-3.5 py-3" open={defaultOpen}>
      <summary className="cursor-pointer list-none [&::-webkit-details-marker]:hidden">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-xs font-semibold text-[#E5E8EF]">Cobranza por cliente y pedido</div>
            <div className="mt-1 text-[11px] text-[#929BAD]">
              {openOrders.length > 0
                ? `${openOrders.length} por cobrar · ${money(pendingUsd)}`
                : 'No hay saldos pendientes por cobrar'}
              {reviewOrders.length > 0 ? ` · ${reviewOrders.length} por revisar` : ''}
            </div>
          </div>
          <span className="text-xs font-semibold text-[#F7DA66]">Ver relación</span>
        </div>
      </summary>

      <div className="mt-3 space-y-4 border-t border-[#29303D] pt-3">
        <div className="rounded-xl border border-[#F0D000]/25 bg-[#F0D000]/5 px-3 py-3">
          <div className="text-xs font-semibold text-[#F7DA66]">
            {summary.punctualCount} puntuales × 100% + {summary.creditCount} con crédito × 80% + {summary.overdueCount} atrasados × 0%
          </div>
          <div className="mt-1 text-[11px] leading-5 text-[#C9C3A0]">
            Entre {summary.ordersCount} pedidos, el resultado de cobranza es {(summary.ratio * 100).toFixed(1)}%
            {points == null ? '.' : ` y aporta ${points.toFixed(1)} de 20 puntos.`}
          </div>
          <div className="mt-2 border-t border-[#665C20]/35 pt-2 text-[11px] leading-5 text-[#AAA483]">
            Para llegar al 100%, los {summary.ordersCount} pedidos deben pagarse a más tardar el día de la entrega. Para alcanzar la referencia de 80%, todos pueden pagarse dentro de los cinco días de crédito. El porcentaje final de comisión depende de la suma de los cinco indicadores, no solo de cobranza.
          </div>
        </div>
        <div className="rounded-xl border border-sky-400/20 bg-sky-400/5 px-3 py-2 text-[11px] leading-5 text-sky-100">
          Pago completo registrado hasta la entrega: 100%. Del día 1 al 5: 80%. Desde el día 6 o sin fecha verificable: 0%.
        </div>

        <section>
          <div className="mb-2 flex items-center justify-between gap-3">
            <h4 className="text-xs font-semibold text-[#F2F3F6]">Requieren gestión ahora</h4>
            <span className="text-[11px] text-[#9AA3B4]">{openOrders.length} pedido(s)</span>
          </div>
          {openOrders.length > 0 ? (
            <div className="grid gap-2 lg:grid-cols-2">
              {openOrders.map((order) => <CollectionOrderCard key={order.orderId} order={order} />)}
            </div>
          ) : (
            <div className="rounded-xl border border-emerald-400/20 bg-emerald-400/5 px-3 py-3 text-xs text-emerald-200">
              Todos los pedidos de esta relación aparecen sin saldo pendiente.
            </div>
          )}
        </section>

        {reviewOrders.length > 0 ? (
          <section>
            <h4 className="mb-2 text-xs font-semibold text-orange-200">Registros que administración debe revisar</h4>
            <div className="grid gap-2 lg:grid-cols-2">
              {reviewOrders.map((order) => <CollectionOrderCard key={order.orderId} order={order} />)}
            </div>
          </section>
        ) : null}

        {completedOrders.length > 0 ? (
          <details className="rounded-xl border border-[#29303D] bg-[#0C0F15] px-3 py-2.5">
            <summary className="cursor-pointer text-xs font-semibold text-[#C8CEDA]">
              Ver {completedOrders.length} pago(s) ya clasificados
            </summary>
            <div className="mt-3 grid gap-2 border-t border-[#252B36] pt-3 lg:grid-cols-2">
              {completedOrders.map((order) => <CollectionOrderCard key={order.orderId} order={order} />)}
            </div>
          </details>
        ) : null}
      </div>
    </details>
  );
}
