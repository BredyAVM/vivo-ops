import Link from 'next/link';
import { getAuthContext } from '@/lib/auth';
import { EmptyBlock, PageIntro, SectionCard, StatusBadge } from '../advisor-ui';

type OrderRow = {
  id: number;
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
  } | null;
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

function getAgendaLabel(order: OrderRow) {
  const schedule = order.extra_fields?.schedule;
  if (schedule?.asap) return 'Lo antes posible';
  const date = String(schedule?.date || '').trim();
  const time = String(schedule?.time_12 || '').trim();
  return `${date} ${time}`.trim() || formatDate(order.created_at);
}

export default async function AdvisorPaymentsPage() {
  const ctx = await getAuthContext();
  if (!ctx) return null;

  const [{ data: paymentData }, { data: orderData }] = await Promise.all([
    ctx.supabase
      .from('payment_reports')
      .select(
        'id, order_id, status, reported_currency_code, reported_amount, reported_amount_usd_equivalent, reference_code, created_at'
      )
      .eq('created_by_user_id', ctx.user.id)
      .order('created_at', { ascending: false })
      .limit(80),
    ctx.supabase
      .from('orders')
      .select(
        'id, order_number, status, total_usd, created_at, extra_fields, client:clients!orders_client_id_fkey(full_name, phone)'
      )
      .eq('attributed_advisor_id', ctx.user.id)
      .order('created_at', { ascending: false })
      .limit(120),
  ]);

  const payments = (paymentData ?? []) as PaymentRow[];
  const orders = ((orderData ?? []) as OrderRow[]).map((order) => ({
    ...order,
    client: Array.isArray(order.client) ? order.client[0] ?? null : order.client,
  }));

  const reportsByOrderId = new Map<number, PaymentRow[]>();
  for (const payment of payments) {
    const current = reportsByOrderId.get(payment.order_id) ?? [];
    current.push(payment);
    reportsByOrderId.set(payment.order_id, current);
  }

  const ordersPendingPayment = orders
    .map((order) => {
      const reports = reportsByOrderId.get(order.id) ?? [];
      const confirmedUsd = reports
        .filter((payment) => payment.status === 'confirmed')
        .reduce((sum, payment) => sum + Number(payment.reported_amount_usd_equivalent || 0), 0);
      const pendingUsd = reports
        .filter((payment) => payment.status === 'pending')
        .reduce((sum, payment) => sum + Number(payment.reported_amount_usd_equivalent || 0), 0);
      const balanceUsd = Math.max(0, Number(order.total_usd || 0) - confirmedUsd - pendingUsd);

      return {
        ...order,
        balanceUsd,
        hasRejected: reports.some((payment) => payment.status === 'rejected'),
        hasPending: reports.some((payment) => payment.status === 'pending'),
      };
    })
    .filter((order) => order.status !== 'cancelled' && order.balanceUsd > 0.005 && !order.hasPending)
    .sort((a, b) => getAgendaLabel(a).localeCompare(getAgendaLabel(b)));

  const sections = [
    { title: 'Por validar', rows: payments.filter((payment) => payment.status === 'pending') },
    { title: 'Confirmados', rows: payments.filter((payment) => payment.status === 'confirmed') },
    { title: 'Rechazados', rows: payments.filter((payment) => payment.status === 'rejected') },
  ];

  return (
    <div className="space-y-4">
      <PageIntro
        eyebrow="Cobranza"
        title="Pagos reportados"
        description="Aquí el asesor revisa qué cobros faltan por cargar, cuáles ya pasaron y cuáles deben corregirse."
        action={
          <Link href="/app/advisor/new" className="inline-flex h-10 items-center rounded-[14px] border border-[#232632] px-3.5 text-sm font-medium text-[#F5F7FB]">
            Nuevo pedido
          </Link>
        }
      />

      <SectionCard
        title="Por cargar"
        subtitle="Órdenes con saldo pendiente para reportar pago."
      >
        {ordersPendingPayment.length === 0 ? (
          <EmptyBlock title="Sin órdenes por cobrar" detail="Cuando haya saldo pendiente, aparecerá aquí para cargar el pago." />
        ) : (
          <div className="space-y-2.5">
            {ordersPendingPayment.map((order) => (
              <article key={order.id} className="rounded-[20px] border border-[#232632] bg-[#0F131B] px-3.5 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-[#F5F7FB]">
                      {order.client?.full_name?.trim() || order.order_number}
                    </div>
                    <div className="mt-1 text-xs text-[#8B93A7]">{order.order_number}</div>
                  </div>
                  <div className="flex flex-col items-end gap-1.5">
                    <StatusBadge label={`Saldo ${formatUsd(order.balanceUsd)}`} tone="warning" />
                    {order.hasRejected ? <StatusBadge label="Rechazado antes" tone="danger" /> : null}
                    {order.hasPending ? <StatusBadge label="Ya enviado" tone="neutral" /> : null}
                  </div>
                </div>
                <div className="mt-3 grid gap-2 text-xs leading-5 text-[#AAB2C5]">
                  <div>Entrega: {getAgendaLabel(order)}</div>
                  <div>Total orden: {formatUsd(order.total_usd)}</div>
                </div>
                <div className="mt-3 flex gap-2">
                  <Link
                    href={`/app/advisor/orders/${order.id}?reportPayment=1`}
                    className="inline-flex h-10 items-center rounded-[14px] bg-[#F0D000] px-3.5 text-sm font-semibold text-[#17191E]"
                  >
                    Cargar pago
                  </Link>
                  <Link
                    href={`/app/advisor/orders/${order.id}`}
                    className="inline-flex h-10 items-center rounded-[14px] border border-[#232632] px-3.5 text-sm font-medium text-[#F5F7FB]"
                  >
                    Ver orden
                  </Link>
                </div>
              </article>
            ))}
          </div>
        )}
      </SectionCard>

      {payments.length === 0 ? (
        <EmptyBlock title="Sin reportes todavía" detail="Cuando este asesor cargue pagos, la trazabilidad aparecerá aquí." />
      ) : (
        sections.map((section) => (
          <SectionCard key={section.title} title={section.title} subtitle="Lectura compacta para teléfono.">
            {section.rows.length === 0 ? (
              <EmptyBlock title="Sin movimientos" detail="No hay registros en esta categoría." />
            ) : (
              <div className="space-y-2.5">
                {section.rows.map((payment) => (
                  <article key={payment.id} className="rounded-[20px] border border-[#232632] bg-[#0F131B] px-3.5 py-3">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="text-sm font-medium text-[#F5F7FB]">Orden #{payment.order_id}</div>
                        <div className="mt-1 text-xs text-[#8B93A7]">{formatDate(payment.created_at)}</div>
                      </div>
                      <StatusBadge label={label(payment.status)} tone={tone(payment.status)} />
                    </div>
                    <div className="mt-3 grid gap-2 text-xs leading-5 text-[#AAB2C5]">
                      <div>Referencia: {payment.reference_code?.trim() || 'Sin referencia'}</div>
                      <div>Monto: {formatMoney(payment.reported_currency_code, payment.reported_amount)}</div>
                      <div>Equivalente: ${Number(payment.reported_amount_usd_equivalent || 0).toFixed(2)}</div>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </SectionCard>
        ))
      )}
    </div>
  );
}
