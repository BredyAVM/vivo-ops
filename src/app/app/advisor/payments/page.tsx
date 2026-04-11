import Link from 'next/link';
import { getAuthContext } from '@/lib/auth';
import { EmptyBlock, PageIntro, SectionCard, StatusBadge } from '../advisor-ui';

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

export default async function AdvisorPaymentsPage() {
  const ctx = await getAuthContext();
  if (!ctx) return null;

  const { data } = await ctx.supabase
    .from('payment_reports')
    .select(
      'id, order_id, status, reported_currency_code, reported_amount, reported_amount_usd_equivalent, reference_code, created_at'
    )
    .eq('created_by_user_id', ctx.user.id)
    .order('created_at', { ascending: false })
    .limit(30);

  const payments = (data ?? []) as PaymentRow[];
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
        description="Aqui el asesor revisa que cobros siguen pendientes, cuales ya pasaron y cuales deben corregirse."
        action={
          <Link href="/app/advisor/new" className="inline-flex h-10 items-center rounded-[14px] border border-[#232632] px-3.5 text-sm font-medium text-[#F5F7FB]">
            Nuevo pedido
          </Link>
        }
      />

      {payments.length === 0 ? (
        <EmptyBlock title="Sin reportes todavia" detail="Cuando este asesor cargue pagos, la trazabilidad aparecera aqui." />
      ) : (
        sections.map((section) => (
          <SectionCard key={section.title} title={section.title} subtitle="Lectura compacta para telefono.">
            {section.rows.length === 0 ? (
              <EmptyBlock title="Sin movimientos" detail="No hay registros en esta categoria." />
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
