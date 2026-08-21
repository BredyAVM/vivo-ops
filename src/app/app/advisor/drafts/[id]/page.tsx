import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getAuthContext } from '@/lib/auth';
import {
  eventCommissionLabel,
  eventPreparationLabel,
  readEventBudgetPayload,
} from '@/lib/events/event-budget';
import { EmptyBlock, PageIntro, SectionCard, StatusBadge } from '../../advisor-ui';

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown, fallback = '') {
  const normalized = String(value ?? '').trim();
  return normalized || fallback;
}

function money(currency: 'USD' | 'VES', amount: number) {
  return currency === 'VES'
    ? `Bs ${Number(amount || 0).toLocaleString('es-VE', { maximumFractionDigits: 2 })}`
    : `$${Number(amount || 0).toFixed(2)}`;
}

export default async function AdvisorEventBudgetPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await getAuthContext();
  if (!ctx) return null;
  const draftId = Number((await params).id);
  if (!Number.isSafeInteger(draftId) || draftId <= 0) notFound();

  const { data, error } = await ctx.supabase
    .from('advisor_order_drafts')
    .select('id, status, title, client_snapshot, new_client_snapshot, payload, quote_text, total_usd, converted_order_id, updated_at')
    .eq('id', draftId)
    .eq('advisor_user_id', ctx.user.id)
    .maybeSingle();
  if (error || !data) notFound();

  const budget = readEventBudgetPayload(data.payload);
  if (!budget) notFound();
  const clientSnapshot = object(data.client_snapshot);
  const newClientSnapshot = object(data.new_client_snapshot);
  const clientName = text(clientSnapshot.full_name ?? newClientSnapshot.full_name, 'Cliente');

  return (
    <div className="space-y-4">
      <PageIntro
        eyebrow="Evento asignado"
        title={budget.title}
        description="Administración definió esta composición y sus condiciones. Puedes consultarla y compartirla, pero no modificarla."
        action={<Link href="/app/advisor/drafts" className="inline-flex h-10 items-center rounded-[14px] border border-[#2A3040] px-3.5 text-sm font-semibold">Volver</Link>}
      />

      <SectionCard
        title="Resumen de la propuesta"
        subtitle={`${clientName} · ${budget.eventDate} ${budget.eventTime}`}
      >
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="rounded-[16px] border border-[#232632] bg-[#0D1017] p-3"><div className="text-xs text-[#858DA1]">Precio acordado</div><div className="mt-1 text-lg font-bold text-[#F0D000]">{money(budget.negotiatedCurrency, budget.negotiatedAmount)}</div></div>
          <div className="rounded-[16px] border border-[#232632] bg-[#0D1017] p-3"><div className="text-xs text-[#858DA1]">Comisión</div><div className="mt-1 text-sm font-semibold">{eventCommissionLabel(budget.commissionMode, budget.commissionValue)}</div></div>
          <div className="rounded-[16px] border border-[#232632] bg-[#0D1017] p-3"><div className="text-xs text-[#858DA1]">Estado</div><div className="mt-1"><StatusBadge label={data.status === 'converted' ? 'Convertido en orden' : data.status === 'quoted' ? 'Cotizado' : 'Borrador administrativo'} tone={data.status === 'converted' ? 'success' : 'warning'} /></div></div>
        </div>
      </SectionCard>

      <SectionCard title="Composición" subtitle={`${budget.components.length} ítem${budget.components.length === 1 ? '' : 's'}`}>
        <div className="space-y-2">
          {budget.components.map((component) => (
            <div key={component.productId} className="flex items-center justify-between gap-3 rounded-[16px] border border-[#232632] bg-[#0D1017] p-3">
              <div><div className="font-semibold">{component.productName}</div><div className="mt-0.5 text-xs text-[#858DA1]">{eventPreparationLabel(component.preparationMode)}</div></div>
              <div className="text-lg font-bold">{component.qty}</div>
            </div>
          ))}
        </div>
      </SectionCard>

      {budget.notes ? <SectionCard title="Condiciones"><p className="whitespace-pre-wrap text-sm text-[#C7CCDA]">{budget.notes}</p></SectionCard> : null}

      {data.converted_order_id ? (
        <Link href={`/app/advisor/orders/${data.converted_order_id}`} className="flex h-11 items-center justify-center rounded-[14px] bg-[#F0D000] px-4 text-sm font-bold text-[#17191E]">Abrir la orden creada</Link>
      ) : (
        <EmptyBlock title="Aún no compromete inventario" detail="La propuesta comenzará a comprometer productos cuando Administración la convierta en una orden." />
      )}
    </div>
  );
}
